from odoo import fields
from odoo.tests import tagged
from odoo.tests.common import TransactionCase


@tagged("post_install", "-at_install")
class TestPosProductCurrencyPrices(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.company = cls.env.company
        cls.company_currency = cls.company.currency_id
        cls.eur_currency = cls.env.ref("base.EUR")
        cls.eur_currency.active = True
        cls.env["res.currency.rate"].search(
            [
                ("currency_id", "=", cls.eur_currency.id),
                ("company_id", "in", [False, cls.company.id]),
            ]
        ).unlink()
        cls.env["res.currency.rate"].create(
            {
                "name": fields.Date.today(),
                "rate": 2.0,
                "currency_id": cls.eur_currency.id,
                "company_id": cls.company.id,
            }
        )
        cls.pos_config = cls.env["pos.config"].create(
            {
                "name": "POS Currency Prices",
                "company_id": cls.company.id,
            }
        )
        cls.product = cls.env["product.product"].create(
            {
                "name": "EUR Forced Product",
                "available_in_pos": True,
                "list_price": 10.0,
                "standard_price": 8.0,
                "force_currency_id": cls.eur_currency.id,
            }
        )

    def test_currency_pos_get_product_prices(self):
        # Odoo 19 removed product.product's own get_product_info_pos()/
        # _process_pos_ui_product_product()/_load_product_with_domain()
        # entirely (moved to product.template with different signatures);
        # currency_pos_get_product_prices() now relies on
        # product.product._load_pos_data_read(), which already converts
        # lst_price/standard_price to the POS currency natively via
        # pos.load.mixin's _convert_pos_data_currency, so there is no more
        # standalone internal method to unit-test in isolation -- this
        # exercises the same conversion + original-price-preservation
        # behavior through the addon's own public RPC surface instead.
        prices = self.env["product.product"].currency_pos_get_product_prices(
            [self.product.id],
            self.pos_config.id,
        )
        self.assertIn(self.product.id, prices)
        # Company/POS currency rate: 1 company = 2 EUR => 10 EUR -> 5 company
        self.assertAlmostEqual(prices[self.product.id]["lst_price"], 5.0)
        self.assertAlmostEqual(prices[self.product.id]["standard_price"], 4.0)
        self.assertAlmostEqual(prices[self.product.id]["currency_pos_lst_price"], 10.0)
        self.assertAlmostEqual(
            prices[self.product.id]["currency_pos_standard_price"], 8.0
        )
        self.assertEqual(
            prices[self.product.id]["_currency_pos_price_currency_id"],
            self.pos_config.currency_id.id,
        )

        # Calling it again must not double-convert the (unchanged, still
        # EUR-denominated) source record.
        prices_again = self.env["product.product"].currency_pos_get_product_prices(
            [self.product.id],
            self.pos_config.id,
        )
        self.assertAlmostEqual(
            prices_again[self.product.id]["lst_price"],
            prices[self.product.id]["lst_price"],
        )
        self.assertAlmostEqual(
            prices_again[self.product.id]["standard_price"],
            prices[self.product.id]["standard_price"],
        )

    def test_get_product_info_pos_pricelists_in_pos_currency(self):
        eur_pricelist = self.env["product.pricelist"].create(
            {
                "name": "EUR Test PL",
                "currency_id": self.eur_currency.id,
                "item_ids": [
                    (
                        0,
                        0,
                        {
                            "applied_on": "3_global",
                            "compute_price": "formula",
                            "base": "list_price",
                        },
                    )
                ],
            }
        )
        self.pos_config.write(
            {
                "use_pricelist": True,
                "pricelist_id": eur_pricelist.id,
                "available_pricelist_ids": [(6, 0, [eur_pricelist.id])],
            }
        )
        # Odoo 19 moved get_product_info_pos() to product.template, replaced
        # its pricelist_id parameter with product_variant_id, and dropped
        # the "id" key from each pricelist row (matched by position against
        # config.available_pricelist_ids instead -- see the override).
        # It also removed the explicit pricelist_id input this override used
        # to recompute `price` against before computing all_prices: the
        # client now always sends a price already computed via
        # ProductTemplateAccounting.getPrice(), which already converts
        # through the pricelist's own currency in 19, so `price` is used
        # as-sent (no double conversion) -- only the auxiliary
        # pricelists/suppliers/optional_products rows still need the
        # POS-currency conversion this override adds.
        info = self.product.product_tmpl_id.get_product_info_pos(
            10.0,
            1,
            self.pos_config.id,
            self.product.id,
        )
        self.assertEqual(len(info["pricelists"]), 1)
        self.assertAlmostEqual(info["all_prices"]["price_without_tax"], 10.0)
        self.assertAlmostEqual(info["pricelists"][0]["price"], 5.0)
        self.assertAlmostEqual(info["pricelists"][0]["price_pricelist_currency"], 10.0)
        self.assertEqual(
            info["pricelists"][0]["currency_id"],
            self.pos_config.currency_id.id,
        )
