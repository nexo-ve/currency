from odoo.tests import tagged
from odoo.addons.account.tests.common import AccountTestInvoicingHttpCommon
from odoo.addons.point_of_sale.tests.common import archive_products


@tagged("post_install", "-at_install", "currency_pos_tour")
class TestPosPaymentCurrencyTour(AccountTestInvoicingHttpCommon):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # AccountTestInvoicingHttpCommon's acting user has no POS access at
        # all, so every pos.* create/read below raised AccessError before a
        # browser was ever started. Grant the same group core's own POS
        # tour base class (point_of_sale.tests.test_frontend.
        # TestPointOfSaleHttpCommon) grants its acting user.
        cls.env.user.group_ids += cls.env.ref("point_of_sale.group_pos_manager")
        archive_products(cls.env)
        cls.main_pos_config = cls.env["pos.config"].create(
            {
                "name": "Tour POS MC",
                "journal_id": cls.company_data["default_journal_sale"].id,
                "invoice_journal_id": cls.company_data["default_journal_sale"].id,
                "allow_multi_currency_payment": True,
                # Odoo 19 made cash_control a computed field
                # (`cash_control = bool(payment_method_ids.filtered(
                # 'is_cash_count'))`), no longer a plain settable boolean, so
                # it cannot be turned off directly -- it depends entirely on
                # whether any attached payment method is cash. Leaving
                # payment_method_ids unset here lets its own default
                # (`_default_payment_methods()`) auto-attach an existing
                # cash-type method, which then duplicates with the "Cash"
                # payment method created below and renders the Opening
                # Control popup with two "Opening cash - Cash" fields; that
                # popup then blocks every tour step ("not allowed to do
                # action on an element that's below a modal"), since this
                # tour (unlike test_pos_opening_previous_cash_tour.py) never
                # interacts with it. Clearing payment_method_ids here
                # prevents that default from attaching anything, so the
                # write() below ends up with exactly the two methods this
                # tour actually needs.
                "payment_method_ids": [(5, 0, 0)],
            }
        )
        cls.company_data["default_journal_cash"].pos_payment_method_ids.unlink()
        cls.cash_payment_method = cls.env["pos.payment.method"].create(
            {
                "name": "Cash",
                "journal_id": cls.company_data["default_journal_cash"].id,
                "receivable_account_id": cls.company_data["default_account_receivable"].id,
            }
        )
        cls.eur_currency = cls.env.ref("base.EUR")
        cls.eur_currency.active = True
        cls.env["res.currency.rate"].search([("currency_id", "=", cls.eur_currency.id)]).unlink()
        cls.env["res.currency.rate"].create(
            {
                "name": "2026-01-01",
                "rate": 2.0,
                "currency_id": cls.eur_currency.id,
            }
        )
        cls.eur_bank_journal = cls.env["account.journal"].create(
            {
                "name": "Bank EUR Tour",
                "type": "bank",
                "code": "BEUR",
                "currency_id": cls.eur_currency.id,
            }
        )
        cls.eur_payment_method = cls.env["pos.payment.method"].create(
            {
                "name": "Bank EUR",
                "journal_id": cls.eur_bank_journal.id,
                "receivable_account_id": cls.company_data["default_account_receivable"].id,
            }
        )
        cls.main_pos_config.write(
            {
                # cls.cash_payment_method is deliberately not attached here:
                # this tour never clicks it, and attaching any is_cash_count
                # method would flip the computed cash_control back to True,
                # bringing back the Opening Control popup that blocks every
                # tour step (see the comment on payment_method_ids above).
                "payment_method_ids": [
                    (4, cls.eur_payment_method.id),
                ],
            }
        )
        cls.tour_product = cls.env["product.product"].create(
            {
                "name": "Tour MC Product",
                "is_storable": True,
                "available_in_pos": True,
                "list_price": 10.0,
                "taxes_id": [(6, 0, [])],
            }
        )
        cls.env["stock.quant"].with_context(inventory_mode=True).create(
            {
                "product_id": cls.tour_product.id,
                "inventory_quantity": 100,
                "location_id": cls.main_pos_config.picking_type_id.default_location_src_id.id,
            }
        ).action_apply_inventory()

        cls.pos_user = cls.env["res.users"].create(
            {
                "name": "POS MC User",
                "login": "pos_mc_user",
                "password": "pos_mc_user",
                # (6, 0, [...]) replaces the whole group_ids list, so
                # base.group_user must be included explicitly or this user
                # is not an internal user; point_of_sale.group_pos_user
                # does not imply it (only group_pos_manager does, plus
                # stock.group_stock_user). Without it, Odoo 19's
                # /pos/ui(/<id>) controllers 404 via
                # `if not is_internal_user: return request.not_found()`
                # before the tour's own page ever loads (matches core's own
                # POS test fixture, point_of_sale.tests.test_frontend.
                # TestPointOfSaleHttpCommon, which adds both groups too).
                "group_ids": [
                    (
                        6,
                        0,
                        (
                            cls.env.ref("base.group_user")
                            + cls.env.ref("point_of_sale.group_pos_user")
                        ).ids,
                    ),
                ],
            }
        )

    def test_pos_payment_currency_tour(self):
        self.main_pos_config.with_user(self.pos_user).open_ui()
        # A new pos.session always starts in the "opening_control" state
        # (point_of_sale/models/pos_session.py's own field default); the
        # client only leaves that state once the Opening Control popup is
        # confirmed, and Chrome.startPoS() (core's own tour helper) only
        # handles the LoginScreen cashier-login gate, not this popup -- so
        # without completing it first, it stays open and blocks every tour
        # step ("not allowed to do action on an element that's below a
        # modal"). Complete it server-side instead of adding a step to the
        # tour itself, the same way test_pos_opening_previous_cash_tour.py's
        # own first session is opened before its tour runs.
        self.main_pos_config.current_session_id.oca_set_opening_control({}, False)
        self.start_tour(
            f"/pos/ui?config_id={self.main_pos_config.id}",
            "PosPaymentCurrencyTour",
            login="pos_mc_user",
        )
