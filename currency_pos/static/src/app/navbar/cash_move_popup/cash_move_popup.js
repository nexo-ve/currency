import { CashMovePopup } from "@point_of_sale/app/components/popups/cash_move_popup/cash_move_popup";
import { CashMoveReceipt } from "@point_of_sale/app/components/popups/cash_move_popup/cash_move_receipt/cash_move_receipt";
import { patch } from "@web/core/utils/patch";
import { formatFloat } from "@web/core/utils/numbers";
import { parseFloat } from "@web/views/fields/parsers";
import { _t } from "@web/core/l10n/translation";
import { formatDateTime } from "@web/core/l10n/dates";
import { getPaymentMethodCurrency } from "@currency_pos/app/utils/payment_currency_utils";

const { DateTime } = luxon;

patch(CashMovePopup.prototype, {
    setup() {
        super.setup();
        const cashMethods = this.getCashPaymentMethods();
        this.state.paymentMethodId = cashMethods[0]?.id || false;
    },

    getCashPaymentMethods() {
        return this.pos.config.payment_method_ids.filter(
            (pm) => pm.is_cash_count || pm.type === "cash"
        );
    },

    getSelectedCashPaymentMethod() {
        const cashMethods = this.getCashPaymentMethods();
        return (
            cashMethods.find((pm) => pm.id === this.state.paymentMethodId) ||
            cashMethods[0] ||
            null
        );
    },

    _getCashMethodCurrency(paymentMethod) {
        return getPaymentMethodCurrency(paymentMethod, this.pos.models, this.pos.currency);
    },

    get selectedCashCurrency() {
        return this._getCashMethodCurrency(this.getSelectedCashPaymentMethod());
    },

    get showCashMethodSelector() {
        return this.getCashPaymentMethods().length > 1;
    },

    format(value) {
        if (!this.env.utils.isValidFloat(value)) {
            return "";
        }
        const amount = parseFloat(value);
        const currency = this.selectedCashCurrency;
        if (currency && currency.id !== this.pos.currency.id) {
            const formatted = formatFloat(amount, {
                digits: [true, currency.decimal_places ?? 2],
            });
            return `${formatted} ${currency.symbol || currency.name || ""}`.trim();
        }
        return this.env.utils.formatCurrency(amount);
    },

    // Odoo 19 renamed _prepare_try_cash_in_out_payload() to
    // _prepareTryCashInOutPayload() and added a partnerId parameter to it;
    // this override called the old (now nonexistent) name with the old
    // (now wrong) arity, which would throw "is not a function" on every
    // confirm. It also built CashMoveReceipt's props the Odoo 18 way
    // (headerData: this.pos.getReceiptHeaderData()) -- both that method and
    // that prop are gone in 19: CashMoveReceipt now requires a transient
    // `order` record instead (see core's own confirm()), which this
    // override must build and clean up the same way core does.
    async confirm() {
        const amount = parseFloat(this.state.amount);
        const formattedAmount = this.format(this.state.amount);
        if (!amount) {
            this.notification.add(_t("Cash in/out of %s is ignored.", formattedAmount));
            return this.props.close();
        }

        const type = this.state.type;
        const translatedType = _t(type);
        const paymentMethod = this.getSelectedCashPaymentMethod();
        const extras = {
            formattedAmount,
            translatedType,
            payment_method_id: paymentMethod?.id,
        };
        const reason = this.state.reason.trim();

        await this.pos.data.call(
            "pos.session",
            "try_cash_in_out",
            this._prepareTryCashInOutPayload(type, amount, reason, this.partnerId, extras),
            {},
            true
        );
        await this.pos.logEmployeeMessage(
            `${_t("Cash")} ${translatedType} - ${_t("Amount")}: ${formattedAmount}`,
            "CASH_DRAWER_ACTION"
        );
        const order = this.pos.models["pos.order"].create({
            session_id: this.pos.session,
            company_id: this.pos.company,
            config_id: this.pos.config,
            user_id: this.pos.user,
            ticket_code: "",
            tracking_number: "",
            sequence_number: 0,
            pos_reference: "",
            state: "cancel", // transient receipt-only order, must never reach IndexedDB
        });
        await this.printer.print(CashMoveReceipt, {
            reason,
            translatedType,
            order,
            formattedAmount,
            date: formatDateTime(DateTime.now()),
        });
        this.pos.models["pos.order"].delete(order);

        this.props.close();
        this.notification.add(
            _t("Successfully made a cash %s of %s.", type, formattedAmount),
            3000
        );
    },
});
