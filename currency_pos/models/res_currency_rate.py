from odoo import api, fields, models


class ResCurrencyRate(models.Model):
    _name = "res.currency.rate"
    _inherit = ["res.currency.rate", "pos.load.mixin"]

    @api.model
    def _load_pos_data_domain(self, data, config):
        # Odoo 19 passes `config` directly; no more need to re-browse the
        # company from the already-loaded `data["pos.config"]` payload.
        currencies_data = data.get("res.currency", {}).get("data", [])
        if not currencies_data:
            return [("id", "=", False)]

        currency_ids = [c["id"] for c in currencies_data]
        company_currency_id = config.company_id.currency_id.id
        if company_currency_id:
            currency_ids = [cid for cid in currency_ids if cid != company_currency_id]

        today = fields.Date.today()
        return [
            ("currency_id", "in", currency_ids),
            ("name", "<=", today),
        ]

    @api.model
    def _load_pos_data_fields(self, config):
        return ["id", "currency_id", "name", "rate", "company_id"]

    @api.model
    def _load_pos_data_read(self, records, config):
        """ Keep only the most recent rate per currency.

        Odoo 19 removed the `_load_pos_data(self, data)` entry point this
        used to override (pos.session no longer calls it at all; the mixin's
        `_load_pos_data_search_read` now drives `_load_pos_data_domain` +
        `_load_pos_data_read` instead). The domain/search/read part is fully
        handled by the mixin default, so this only needs to post-process the
        read result the same way the old override did after its own
        `search_read` call.
        """
        read_records = super()._load_pos_data_read(records, config)
        currency_rates = {}
        for rate in read_records:
            currency_id = rate["currency_id"][0] if isinstance(rate["currency_id"], list) else rate["currency_id"]

            if currency_id not in currency_rates:
                currency_rates[currency_id] = rate
            else:
                existing_date = fields.Date.from_string(currency_rates[currency_id]["name"])
                current_date = fields.Date.from_string(rate["name"])
                if current_date > existing_date:
                    currency_rates[currency_id] = rate

        return list(currency_rates.values())
