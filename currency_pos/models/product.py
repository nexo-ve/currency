from odoo import _, api, exceptions, fields, models


class ProductProduct(models.Model):
    _inherit = "product.product"

    @api.model
    def _load_pos_data_fields(self, config_id):
        fields_list = super()._load_pos_data_fields(config_id)
        if "currency_id" not in fields_list:
            fields_list.append("currency_id")
        return fields_list

    @api.model
    def currency_pos_get_product_prices(self, product_ids, config_id):
        """Return lst_price/standard_price for ``product_ids`` in the POS currency.

        Odoo 19 removed product.product's own get_product_info_pos()/
        _process_pos_ui_product_product()/_load_product_with_domain() entirely
        (those moved to product.template with different signatures/shapes;
        see ProductTemplate.get_product_info_pos below). product.product's
        own _load_pos_data_read() already converts lst_price/standard_price
        to the POS currency natively (via pos.load.mixin's
        _convert_pos_data_currency, one call per price field/its own source
        currency field), so this is now a thin wrapper around that: search
        for the requested ids the same way the POS itself would load them,
        capture their original (pre-conversion) prices, then reuse
        _load_pos_data_read to get the POS-currency-converted values.
        """
        if not self.env.user.has_group("point_of_sale.group_pos_user"):
            raise exceptions.AccessError(
                _("You are not allowed to load POS product prices.")
            )
        config = self.env["pos.config"].browse(config_id).exists()
        if not config:
            raise exceptions.UserError(_("POS configuration not found."))
        config.check_access("read")
        product_ids = list(dict.fromkeys(product_ids or []))[:50]
        if not product_ids:
            return {}
        products = self.search(
            [
                ("id", "in", product_ids),
                ("available_in_pos", "=", True),
                ("sale_ok", "=", True),
            ]
        )
        if not products:
            return {}

        # Capture the original (own-currency) prices before
        # _load_pos_data_read converts lst_price/standard_price to the POS
        # currency in place; the frontend keeps these as
        # currency_pos_lst_price/currency_pos_standard_price for later
        # re-derivation (e.g. margin computation against the original cost).
        original_prices = {
            product.id: (product.lst_price, product.standard_price)
            for product in products
        }
        read_records = self._load_pos_data_read(products, config)
        return {
            record["id"]: {
                "lst_price": record["lst_price"],
                "standard_price": record["standard_price"],
                "currency_pos_lst_price": original_prices.get(record["id"], (None, None))[0],
                "currency_pos_standard_price": original_prices.get(
                    record["id"], (None, None)
                )[1],
                "_currency_pos_price_currency_id": config.currency_id.id,
            }
            for record in read_records
        }


class ProductTemplate(models.Model):
    _inherit = "product.template"

    def get_product_info_pos(self, price, quantity, pos_config_id, product_variant_id=False):
        """Recompute price/pricelist/supplier amounts in the POS currency.

        Odoo 19 moved get_product_info_pos() from product.product to
        product.template and changed its last parameter from pricelist_id to
        product_variant_id, and it also dropped the "id" key from each
        pricelist row (now just {"name": ..., "price": ...}) and stopped
        filtering optional products through a _optional_product_pos_domain()
        hook (pos_optional_product_ids is read directly instead). This
        override was fully rewritten against that new shape.
        """
        self.ensure_one()
        config = self.env["pos.config"].browse(pos_config_id)
        pos_currency = config.currency_id
        company = config.company_id
        date = fields.Date.context_today(self)
        product_variant = (
            self.env["product.product"].browse(product_variant_id)
            if product_variant_id
            else False
        )
        product_for_pricing = product_variant or self

        # Odoo 19 dropped the explicit pricelist_id parameter this override
        # used to recompute `price` against; the client now always sends a
        # price already computed via productTemplate.getPrice(), which in
        # 19 already converts through the pricelist's own currency natively
        # (see ProductTemplateAccounting.getPrice()), so `price` no longer
        # needs correcting here. Only the pricelist-list/supplier/optional-
        # product rows below still need POS-currency conversion, since core
        # does not convert those.
        if config.use_pricelist:
            available_pricelists = config.available_pricelist_ids
        else:
            available_pricelists = config.pricelist_id

        result = super().get_product_info_pos(price, quantity, pos_config_id, product_variant_id)

        # Pricelists: core builds `pricelist_list` by iterating the same
        # `available_pricelists` recordset in the same order and no longer
        # keeps each row's pricelist id, so zip() (not a lookup by id) is
        # the only way left to know which row is which pricelist.
        for pricelist_rec, pricelist_data in zip(available_pricelists, result.get("pricelists", [])):
            price_pos = pricelist_rec._get_product_price(
                product_for_pricing,
                quantity,
                currency=pos_currency,
            )
            price_pl = pricelist_rec._get_product_price(
                product_for_pricing,
                quantity,
                currency=pricelist_rec.currency_id,
            )
            pricelist_data["price"] = price_pos
            pricelist_data["price_pos_currency"] = price_pos
            pricelist_data["price_pricelist_currency"] = price_pl
            pricelist_data["currency_id"] = pos_currency.id
            pricelist_data["pricelist_currency_id"] = pricelist_rec.currency_id.id
            pricelist_data["pricelist_currency_name"] = pricelist_rec.currency_id.name
            pricelist_data["pricelist_currency_symbol"] = (
                pricelist_rec.currency_id.symbol or pricelist_rec.currency_id.name
            )

        supplier_ids = [row["id"] for row in result.get("suppliers", [])]
        suppliers = {
            supplier.id: supplier
            for supplier in self.env["product.supplierinfo"].browse(supplier_ids)
        }
        for supplier_data in result.get("suppliers", []):
            supplier = suppliers.get(supplier_data["id"])
            if not supplier or not supplier.currency_id:
                continue
            if supplier.currency_id == pos_currency:
                continue
            supplier_data["price"] = supplier.currency_id._convert(
                supplier_data["price"],
                pos_currency,
                company,
                date,
            )

        # Optional products: Odoo 19 returns {id, name, list_price} read
        # directly off pos_optional_product_ids, each still in that
        # template's own currency.
        optional_rows = result.get("optional_products") or []
        if optional_rows:
            optional_templates = self.env["product.template"].browse(
                [row["id"] for row in optional_rows]
            )
            templates_by_id = {tmpl.id: tmpl for tmpl in optional_templates}
            for optional_data in optional_rows:
                optional_tmpl = templates_by_id.get(optional_data["id"])
                if (
                    not optional_tmpl
                    or not optional_tmpl.currency_id
                    or optional_tmpl.currency_id == pos_currency
                ):
                    continue
                optional_data["list_price"] = optional_tmpl.currency_id._convert(
                    optional_data["list_price"],
                    pos_currency,
                    company,
                    date,
                )

        return result
