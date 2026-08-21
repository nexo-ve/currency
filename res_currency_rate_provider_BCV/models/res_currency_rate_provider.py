import logging
from collections import defaultdict
from datetime import datetime

import pytz
import requests
from lxml import etree

from odoo import _, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = (10, 60)
BCV_URL = "http://www.bcv.org.ve/"
CURRENCIES = {
    "VES": "bolivar",
    "EUR": "euro",
    "CNY": "yuan",
    "TRY": "lira",
    "RUB": "rublo",
    "USD": "dolar",
}
# Aliases that all mean "the Venezuelan bolivar", i.e. the currency the BCV
# anchors every quote in. The BCV never publishes a row for it, so its value is
# 1.0 VES per 1 VES by definition.
VES_ALIASES = ("Bs", "VES", "VEF", "VED")
CARACAS_TZ = pytz.timezone("America/Caracas")


class ResCurrencyRateProvider(models.Model):
    _inherit = "res.currency.rate.provider"

    service = fields.Selection(
        selection_add=[("bcv", "BCV scraping")],
        ondelete={"bcv": "set default"},
    )

    def _get_supported_currencies(self):
        self.ensure_one()
        if self.service != "bcv":
            return super()._get_supported_currencies()
        return list(CURRENCIES.keys())

    def _obtain_rates(self, base_currency, currencies, date_from, date_to):
        self.ensure_one()
        if self.service != "bcv":
            return super()._obtain_rates(base_currency, currencies, date_from, date_to)

        _logger.info(
            "BCV proveedor id=%s: solicitud tasas base=%s monedas=%s desde=%s hasta=%s",
            self.id,
            base_currency,
            currencies,
            date_from,
            date_to,
        )

        content = defaultdict(dict)

        # The BCV anchors every quote in VES. If the company's base currency is
        # not VES we still need VES scraped so we can re-base every rate onto
        # the actual base currency (same approach as the ECB provider with EUR).
        scrap_currencies = list(currencies)
        if base_currency not in VES_ALIASES and base_currency not in scrap_currencies:
            scrap_currencies.append(base_currency)

        bcv_data = self._scrap(scrap_currencies)

        if not bcv_data:
            _logger.warning(
                "BCV proveedor id=%s: no se obtuvo ninguna tasa (revisar red, HTML del BCV o xpath)",
                self.id,
            )
            return content

        # bcv_data holds "VES per 1 unit of X". Re-base so each rate becomes
        # "units of X per 1 unit of base_currency", which is what Odoo stores.
        if base_currency in VES_ALIASES:
            base_ves_per = 1.0
        elif base_currency in bcv_data:
            base_ves_per = bcv_data[base_currency][0]
        else:
            # The base currency is essential: without its VES anchor we cannot
            # re-base anything. Fail loudly instead of silently discarding every
            # rate (which would look like "nothing to update").
            raise UserError(
                _(
                    "BCV: no se pudo obtener la cotización de la moneda base"
                    " %(base)s. Revisa que el BCV la publique y que el proveedor"
                    " la tenga entre sus monedas."
                )
                % {"base": base_currency}
            )

        for currency_name, (ves_per, dt_value) in bcv_data.items():
            dt = dt_value.isoformat()
            # rate[X] = (VES per 1 base) / (VES per 1 X). ves_per is guaranteed
            # > 0 by _scrap, so this division is always safe.
            content[dt][currency_name] = base_ves_per / ves_per

        _logger.info(
            "BCV proveedor id=%s: respuesta con %s fecha(s) de cotización",
            self.id,
            len(content),
        )

        return content

    def _scrap(self, available_currencies):
        request_url = BCV_URL

        rslt = {}
        _logger.info(
            "BCV: GET %s timeout=%s",
            request_url,
            REQUEST_TIMEOUT,
        )
        try:
            fetched_data = requests.get(
                request_url, verify=False, timeout=REQUEST_TIMEOUT
            )
        except Exception:
            _logger.exception(
                "BCV proveedor id=%s: fallo de red o timeout al contactar %s",
                self.id,
                request_url,
            )
            return rslt

        if fetched_data.status_code != 200:
            _logger.warning(
                "BCV proveedor id=%s: HTTP %s al obtener %s",
                self.id,
                fetched_data.status_code,
                request_url,
            )
            return rslt

        available_currency_names = available_currencies

        try:
            htmlelem = etree.fromstring(fetched_data.content, etree.HTMLParser())
        except Exception:
            _logger.exception(
                "BCV proveedor id=%s: no se pudo parsear HTML (tamaño body=%s)",
                self.id,
                len(fetched_data.content or b""),
            )
            return rslt

        dt = datetime.now(CARACAS_TZ)
        for currency_name in available_currency_names:
            try:
                if currency_name in VES_ALIASES:
                    # VES is the anchor: 1 VES == 1 VES. The BCV has no row for it.
                    rslt[currency_name] = (1.0, dt)
                    continue

                sValue = htmlelem.xpath(
                    f".//div[@id='{CURRENCIES[currency_name]}']/div/div/div[2]/strong"
                )[0].text
                # BCV publishes how many VES equal 1 unit of the foreign
                # currency (e.g. 1 USD = 777.42 VES -> value == 777.42). We store
                # it raw, anchored in VES, and let _obtain_rates re-base it to
                # the company's base currency.
                value = float(sValue.replace(" ", "").replace(",", "."))

                if value <= 0.0:
                    # BCV occasionally shows 0,00 during maintenance. A zero or
                    # negative anchor is unusable and would break re-basing.
                    _logger.warning(
                        "BCV proveedor id=%s: tasa no positiva para %s (raw=%r); se omite",
                        self.id,
                        currency_name,
                        sValue,
                    )
                    continue

                rslt[currency_name] = (value, dt)
            except Exception as err:
                _logger.warning(
                    "BCV proveedor id=%s: no se pudo leer la tasa para %s: %s",
                    self.id,
                    currency_name,
                    err,
                )

        _logger.info(
            "BCV proveedor id=%s: scraping OK para monedas %s",
            self.id,
            list(rslt.keys()),
        )

        return rslt
