# License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).

import os
from unittest import mock

from odoo import fields
from odoo.exceptions import UserError
from odoo.tests import TransactionCase, tagged

_module_ns = "odoo.addons.res_currency_rate_provider_BCV"
_provider_class = (
    _module_ns + ".models.res_currency_rate_provider.ResCurrencyRateProvider"
)

# Raw values published by the BCV in the fixture: VES per 1 unit of X.
VES_PER = {
    "USD": 777.41610000,
    "EUR": 906.83255816,
    "CNY": 115.54420878,
    "TRY": 16.42292139,
    "RUB": 9.15253237,
}


def _load_fixture():
    path = os.path.join(os.path.dirname(__file__), "bcv_sample.html")
    with open(path, "rb") as fh:
        return fh.read()


class _FakeResponse:
    """Minimal stand-in for requests.Response used by the scraper."""

    def __init__(self, content, status_code=200):
        self.content = content
        self.status_code = status_code


@tagged("post_install", "-at_install")
class TestBCVProvider(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()

        cls.Company = cls.env["res.company"]
        cls.Currency = cls.env["res.currency"]
        cls.CurrencyRate = cls.env["res.currency.rate"]
        cls.CurrencyRateProvider = cls.env["res.currency.rate.provider"]

        cls.today = fields.Date.today()

        cls.usd = cls.env.ref("base.USD")
        cls.eur = cls.env.ref("base.EUR")
        cls.cny = cls.env.ref("base.CNY")
        cls.ves = cls.env.ref("base.VES")
        # These currencies ship inactive on a fresh Odoo DB; the provider only
        # works with active currencies.
        (cls.usd + cls.eur + cls.cny + cls.ves).write({"active": True})

        cls.fixture = _load_fixture()

    def _make_provider(self, base_currency, currency_records):
        """Create a dedicated company in the requested base + a BCV provider."""
        company = self.Company.create(
            {"name": f"BCV test {base_currency.name}", "currency_id": base_currency.id}
        )
        provider = self.CurrencyRateProvider.create(
            {
                "company_id": company.id,
                "service": "bcv",
                "currency_ids": [(6, 0, currency_records.ids)],
            }
        )
        return company, provider

    def _patch_scrap_http(self, status_code=200, content=None):
        """Patch requests.get inside the provider module to return the fixture."""
        response = _FakeResponse(
            self.fixture if content is None else content, status_code
        )
        target = _module_ns + ".models.res_currency_rate_provider.requests.get"
        return mock.patch(target, return_value=response)

    def _rate_for(self, company, currency):
        # The BCV scraper stamps rows with the current date in America/Caracas
        # (UTC-4), which may differ from fields.Date.today() (UTC) around
        # midnight. We therefore look up the latest row for the pair instead of
        # pinning an exact date, so the test is timezone-robust.
        return self.CurrencyRate.search(
            [
                ("company_id", "=", company.id),
                ("currency_id", "=", currency.id),
            ],
            order="name desc",
            limit=1,
        )

    # ------------------------------------------------------------------ #
    # Base = VES (the anchor). Foreign currencies must be < 1 VES.
    # ------------------------------------------------------------------ #
    def test_base_ves_updates_foreign_currencies(self):
        company, provider = self._make_provider(
            self.ves, self.ves + self.usd + self.eur
        )
        with self._patch_scrap_http():
            provider._update(self.today, self.today)

        # VES is the base -> its row is skipped by core (implicit 1.0).
        self.assertFalse(self._rate_for(company, self.ves))

        usd_rate = self._rate_for(company, self.usd)
        eur_rate = self._rate_for(company, self.eur)
        self.assertTrue(usd_rate)
        self.assertTrue(eur_rate)
        # rate[USD] = 1 / 777.4161  (how many USD equal 1 VES)
        self.assertAlmostEqual(usd_rate.rate, 1.0 / VES_PER["USD"], places=8)
        self.assertAlmostEqual(eur_rate.rate, 1.0 / VES_PER["EUR"], places=8)

    # ------------------------------------------------------------------ #
    # Base = USD (the real question): VES must still update with 777.42.
    # ------------------------------------------------------------------ #
    def test_base_usd_updates_ves_with_correct_rate(self):
        company, provider = self._make_provider(
            self.usd, self.usd + self.ves + self.eur
        )
        with self._patch_scrap_http():
            provider._update(self.today, self.today)

        # USD is the base -> skipped.
        self.assertFalse(self._rate_for(company, self.usd))

        ves_rate = self._rate_for(company, self.ves)
        self.assertTrue(ves_rate, "VES must be updated when base is USD")
        # rate[VES] = 777.4161 / 1.0  (how many VES equal 1 USD)
        self.assertAlmostEqual(ves_rate.rate, VES_PER["USD"], places=6)

        eur_rate = self._rate_for(company, self.eur)
        self.assertTrue(eur_rate)
        # rate[EUR] = 777.4161 / 906.83  (how many EUR equal 1 USD)
        self.assertAlmostEqual(
            eur_rate.rate, VES_PER["USD"] / VES_PER["EUR"], places=8
        )

    def test_base_usd_without_ves_in_currency_ids_skips_ves(self):
        """If VES is not configured on the provider it must NOT be updated."""
        company, provider = self._make_provider(self.usd, self.usd + self.eur)
        with self._patch_scrap_http():
            provider._update(self.today, self.today)

        self.assertFalse(
            self._rate_for(company, self.ves),
            "VES must stay untouched when not in currency_ids",
        )
        self.assertTrue(self._rate_for(company, self.eur))

    # ------------------------------------------------------------------ #
    # Cross-consistency: a round trip must be loss-free regardless of base.
    # ------------------------------------------------------------------ #
    def test_cross_rate_consistency_between_bases(self):
        ves_company, ves_provider = self._make_provider(
            self.ves, self.ves + self.usd + self.eur
        )
        usd_company, usd_provider = self._make_provider(
            self.usd, self.usd + self.ves + self.eur
        )
        with self._patch_scrap_http():
            ves_provider._update(self.today, self.today)
            usd_provider._update(self.today, self.today)

        # EUR per USD derived from the VES-based company must match the
        # EUR rate stored directly by the USD-based company.
        usd_in_ves = self._rate_for(ves_company, self.usd).rate  # USD per 1 VES
        eur_in_ves = self._rate_for(ves_company, self.eur).rate  # EUR per 1 VES
        eur_per_usd_derived = eur_in_ves / usd_in_ves

        eur_per_usd_direct = self._rate_for(usd_company, self.eur).rate
        self.assertAlmostEqual(eur_per_usd_derived, eur_per_usd_direct, places=8)

    # ------------------------------------------------------------------ #
    # Defensive: base currency missing from the scrape must fail loudly.
    # ------------------------------------------------------------------ #
    def test_missing_base_currency_raises(self):
        # CNY is present in the fixture, but simulate its row disappearing by
        # scraping only what the provider asks and dropping the base.
        company, provider = self._make_provider(self.usd, self.eur)
        # Base USD is added automatically by _obtain_rates, but if the HTML has
        # no dolar node the base cannot be resolved. Feed HTML without dolar.
        broken_html = self.fixture.replace(b'id="dolar"', b'id="dolar-broken"')
        with self._patch_scrap_http(content=broken_html):
            with self.assertRaises(UserError):
                provider._obtain_rates("USD", ["EUR"], self.today, self.today)

    # ------------------------------------------------------------------ #
    # Defensive: a non-positive quote (BCV maintenance "0,00") is dropped.
    # ------------------------------------------------------------------ #
    def test_zero_quote_is_dropped(self):
        zero_html = self.fixture.replace(b"906,83255816", b"0,00")
        with self._patch_scrap_http(content=zero_html):
            result = self.env["res.currency.rate.provider"]
            provider = self.CurrencyRateProvider.create(
                {"service": "bcv", "currency_ids": [(6, 0, (self.ves + self.usd + self.eur).ids)]}
            )
            content = provider._obtain_rates(
                "VES", ["VES", "USD", "EUR"], self.today, self.today
            )
        # EUR had the zeroed quote -> must be absent; USD/VES still present.
        day = list(content.keys())[0]
        self.assertIn("USD", content[day])
        self.assertNotIn("EUR", content[day])

    # ------------------------------------------------------------------ #
    # HTTP failure must degrade gracefully (no rows, no crash).
    # ------------------------------------------------------------------ #
    def test_http_error_produces_no_rates(self):
        company, provider = self._make_provider(self.usd, self.usd + self.ves)
        with self._patch_scrap_http(status_code=500):
            provider._update(self.today, self.today)
        self.assertFalse(self._rate_for(company, self.ves))

    def test_supported_currencies(self):
        provider = self.CurrencyRateProvider.create({"service": "bcv"})
        supported = provider._get_supported_currencies()
        for name in ("VES", "USD", "EUR", "CNY", "TRY", "RUB"):
            self.assertIn(name, supported)
