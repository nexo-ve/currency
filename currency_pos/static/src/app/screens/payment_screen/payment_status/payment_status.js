import { PaymentScreenStatus } from "@point_of_sale/app/screens/payment_screen/payment_status/payment_status";
import { patch } from "@web/core/utils/patch";
import { usePos } from "@point_of_sale/app/hooks/pos_hook";
import {
    convertCurrency,
    formatPaymentCurrencyAmount,
} from "../../../utils/payment_currency_utils";

patch(PaymentScreenStatus.prototype, {
    setup() {
        super.setup();
        this.pos = usePos();
    },

    _getSelectedForeignPaymentContext() {
        const order = this.order;
        const selectedLine = order.getSelectedPaymentline?.();
        if (!this.pos.config.allow_multi_currency_payment || !selectedLine) {
            return null;
        }
        if (!selectedLine.isForeignCurrencyPayment?.()) {
            return null;
        }
        const paymentCurrency = selectedLine.getPaymentCurrency?.();
        if (!paymentCurrency || paymentCurrency.id === order.currency?.id) {
            return null;
        }
        return { order, selectedLine, paymentCurrency };
    },

    getPaymentStatusCurrencyLabel() {
        const context = this._getSelectedForeignPaymentContext();
        if (!context) {
            return "";
        }
        const { paymentCurrency } = context;
        return paymentCurrency.name || paymentCurrency.symbol || "";
    },

    // Odoo 19 renamed/restructured the getters the PaymentScreenStatus
    // template actually reads: O18's remainingText/changeText (each
    // unconditionally rendered by two separate template branches) became a
    // single amountText getter, gated by the new isRemaining getter, with
    // `change` now already a positive "give back this much" value (O18's
    // get_change() returned a negative amount the template had to negate).
    // Patch amountText instead of the old remainingText/changeText getters
    // so the foreign-currency breakdown keeps rendering; fall back to core
    // for orders/payments that are not in a foreign payment currency.
    get amountText() {
        const context = this._getSelectedForeignPaymentContext();
        if (!context) {
            return super.amountText;
        }
        const { order, paymentCurrency } = context;
        const baseAmount = this.isRemaining ? order.remainingDue : order.change;
        const foreignAmount = this.isRemaining
            ? order.getForeignCurrencyRemaining(paymentCurrency)
            : convertCurrency(order.change, order.currency, paymentCurrency, this.pos.models);
        const formattedForeign = formatPaymentCurrencyAmount(foreignAmount, paymentCurrency);
        const symbol = paymentCurrency.symbol || paymentCurrency.name || "";
        return `${formattedForeign} ${symbol} (${this.env.utils.formatCurrency(baseAmount)})`;
    },
});
