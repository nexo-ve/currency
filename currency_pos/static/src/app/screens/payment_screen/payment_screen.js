import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import {
    convertCurrency,
    getConfiguredPaymentCurrencyRateLabels,
} from "../../utils/payment_currency_utils";
import { convertCurrency as convertDisplayCurrency } from "../../../utils/currency_utils";

patch(PaymentScreen.prototype, {
    getPaymentMethodRecord(methodOrId) {
        if (!methodOrId) {
            return null;
        }
        if (typeof methodOrId === "object") {
            return methodOrId;
        }
        return this.pos.models["pos.payment.method"].find((pm) => pm.id === methodOrId) || null;
    },

    getPaymentMethodId(methodOrId) {
        const method = this.getPaymentMethodRecord(methodOrId);
        return method?.id || null;
    },

    get exchangeCurrency() {
        return this.pos.getExchangeCurrencyForDisplay();
    },

    onMounted() {
        const order = this.pos.getOrder();
        if (!order) {
            return;
        }
        this.normalizeInvalidPaymentLines(order);

        if (this.payment_methods_from_config.length === 1 && this.paymentLines.length === 0) {
            this.addNewPaymentLine(this.payment_methods_from_config[0]);
        }
    },

    normalizeInvalidPaymentLines(order = this.currentOrder) {
        if (!order) {
            return;
        }
        const allowedMethods = (this.pos.config.payment_method_ids || []).filter((pm) => pm?.id);
        const allowedMethodIds = new Set(allowedMethods.map((pm) => pm.id));
        const fallbackMethod = allowedMethods[0] || null;

        for (const payment of [...order.payment_ids]) {
            const currentMethodId = this.getPaymentMethodId(payment?.payment_method_id);
            if (currentMethodId && allowedMethodIds.has(currentMethodId)) {
                continue;
            }
            if (fallbackMethod) {
                payment.update?.({
                    payment_method_id: fallbackMethod,
                    amount: 0,
                    payment_status: "reversed",
                });
            }
        }
    },

    async validateOrder(isForceValidate) {
        this.normalizeInvalidPaymentLines(this.currentOrder);
        return super.validateOrder(...arguments);
    },

    get paymentLines() {
        return (this.currentOrder?.payment_ids || []).filter((line) =>
            Boolean(line?.payment_method_id)
        );
    },

    getPaymentCurrencyRateLabels() {
        return getConfiguredPaymentCurrencyRateLabels(
            this.payment_methods_from_config || [],
            this.currentOrder?.currency,
            this.pos.models,
            this.pos.config
        );
    },

    _isForeignPaymentMethod(paymentMethod) {
        if (!this.pos.config.allow_multi_currency_payment || !paymentMethod) {
            return false;
        }
        const orderCurrency = this.currentOrder?.currency;
        const paymentCurrency =
            typeof paymentMethod.payment_currency_id === "object"
                ? paymentMethod.payment_currency_id
                : this.pos.models["res.currency"].find(
                      (currency) => currency.id === paymentMethod.payment_currency_id
                  );
        return Boolean(
            paymentCurrency && orderCurrency && paymentCurrency.id !== orderCurrency.id
        );
    },

    getActivePaymentCurrency() {
        const selectedLine = this.selectedPaymentLine;
        const paymentMethod = this.getPaymentMethodRecord(selectedLine?.payment_method_id);
        if (this._isForeignPaymentMethod(paymentMethod)) {
            return (
                selectedLine?.getPaymentCurrency?.() ||
                paymentMethod.payment_currency_id ||
                this.pos.currency
            );
        }
        return this.pos.currency;
    },

    updateSelectedPaymentline(amount = false) {
        const selectedLine = this.selectedPaymentLine;
        const paymentMethod = this.getPaymentMethodRecord(selectedLine?.payment_method_id);
        if (!selectedLine || !paymentMethod || !this._isForeignPaymentMethod(paymentMethod)) {
            return super.updateSelectedPaymentline(...arguments);
        }

        if (amount === false) {
            if (this.numberBuffer.get() === null) {
                amount = null;
            } else if (this.numberBuffer.get() === "") {
                amount = 0;
            } else {
                amount = this.numberBuffer.getFloat();
            }
        }

        const paymentTerminal = paymentMethod.payment_terminal;
        if (
            paymentTerminal &&
            !["pending", "retry"].includes(selectedLine.getPaymentStatus())
        ) {
            return;
        }

        if (amount === null) {
            this.deletePaymentLine(selectedLine.uuid);
            return;
        }

        const paymentCurrency = selectedLine.getPaymentCurrency();
        const orderCurrency = this.currentOrder.currency;
        const foreignAmount = Number(amount ?? 0) || 0;
        const baseAmount = convertCurrency(
            foreignAmount,
            paymentCurrency,
            orderCurrency,
            this.pos.models
        );
        const hasCashPaymentMethod = this.payment_methods_from_config.some(
            (method) => method.type === "cash"
        );
        if (
            !hasCashPaymentMethod &&
            baseAmount > this.currentOrder.remainingDue + selectedLine.amount
        ) {
            const maxForeign = convertCurrency(
                this.currentOrder.remainingDue + selectedLine.amount,
                orderCurrency,
                paymentCurrency,
                this.pos.models
            );
            selectedLine.setAmountCurrencyForeign(maxForeign || 0);
            this.numberBuffer.reset();
            this.showMaxValueError();
            return;
        }

        selectedLine.setAmountCurrencyForeign(foreignAmount);
    },

    getConvertedTotalDue() {
        const exchangeCurrency = this.exchangeCurrency;
        if (!exchangeCurrency) {
            return null;
        }
        // Odoo 19 replaced getTotalDue() with the totalDue getter.
        const totalDue = this.currentOrder.totalDue;
        const companyCurrency = this.pos.company.currency_id;
        if (!companyCurrency || exchangeCurrency.id === companyCurrency.id) {
            return null;
        }
        const convertedTotal = convertDisplayCurrency(
            totalDue,
            companyCurrency,
            exchangeCurrency,
            this.pos.models
        );
        const formattedTotal = convertedTotal.toFixed(2);
        const currencySymbol = exchangeCurrency.symbol || exchangeCurrency.name || "";
        return `${currencySymbol}${formattedTotal}`;
    },

    shouldShowTotalDueConversion() {
        const exchangeCurrency = this.exchangeCurrency;
        const companyCurrency = this.pos.company.currency_id;
        const totalDue = this.currentOrder.totalDue;
        return (
            exchangeCurrency &&
            companyCurrency &&
            exchangeCurrency.id !== companyCurrency.id &&
            totalDue > 0
        );
    },
});
