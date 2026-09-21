import { PosPayment } from "@point_of_sale/app/models/pos_payment";
import { patch } from "@web/core/utils/patch";
import { roundDecimals } from "@web/core/utils/numbers";
import { convertCurrency, getExchangeRate } from "../utils/payment_currency_utils";

Object.assign(PosPayment, {
    extraFields: {
        ...(PosPayment.extraFields || {}),
        payment_currency_id: {
            name: "payment_currency_id",
            type: "many2one",
            relation: "res.currency",
            model: "pos.payment",
        },
        payment_currency_amount: {
            name: "payment_currency_amount",
            type: "float",
            model: "pos.payment",
        },
        payment_currency_rate: {
            name: "payment_currency_rate",
            type: "float",
            model: "pos.payment",
        },
    },
});

patch(PosPayment.prototype, {
    _getCurrencyRecord(currencyLike) {
        if (!currencyLike) {
            return null;
        }
        if (typeof currencyLike === "object") {
            return currencyLike;
        }
        return this.models["res.currency"].find((currency) => currency.id === currencyLike) || null;
    },

    _getPaymentMethodRecord(paymentMethodLike) {
        if (!paymentMethodLike) {
            return null;
        }
        if (typeof paymentMethodLike === "object") {
            return paymentMethodLike;
        }
        return (
            this.models["pos.payment.method"].find((method) => method.id === paymentMethodLike) ||
            null
        );
    },

    setup(vals) {
        super.setup(...arguments);
        const orderCurrency = this.pos_order_id?.currency;
        const paymentMethod = this._getPaymentMethodRecord(
            vals.payment_method_id || this.payment_method_id
        );
        const methodCurrency = this._getCurrencyRecord(paymentMethod?.payment_currency_id);
        const paymentCurrency = this._getCurrencyRecord(vals.payment_currency_id);
        const resolvedCurrency = paymentCurrency || methodCurrency || orderCurrency;
        this.payment_currency_id = resolvedCurrency || null;
        this.payment_currency_amount = vals.payment_currency_amount ?? this.amount;
        this.payment_currency_rate = vals.payment_currency_rate || 1;
    },

    isForeignCurrencyPayment() {
        const config = this.pos_order_id?.config_id || this.pos_order_id?.config;
        if (!config?.allow_multi_currency_payment) {
            return false;
        }
        const orderCurrency = this.pos_order_id?.currency;
        const paymentCurrency = this.getPaymentCurrency();
        return Boolean(
            paymentCurrency && orderCurrency && paymentCurrency.id !== orderCurrency.id
        );
    },

    getPaymentCurrency() {
        const explicitCurrency = this._getCurrencyRecord(this.payment_currency_id);
        if (explicitCurrency) {
            return explicitCurrency;
        }
        const paymentMethod = this._getPaymentMethodRecord(this.payment_method_id);
        return (
            this._getCurrencyRecord(paymentMethod?.payment_currency_id) ||
            this.pos_order_id?.currency
        );
    },

    getPaymentAmountCurrency() {
        return this.payment_currency_amount ?? this.getAmount();
    },

    getPaymentRate() {
        return this.payment_currency_rate || 1;
    },

    convertAmountToOrderCurrency(amountCurrency) {
        const orderCurrency = this.pos_order_id?.currency;
        const paymentCurrency = this.getPaymentCurrency();
        if (!orderCurrency || !paymentCurrency || amountCurrency === null) {
            return amountCurrency;
        }
        if (paymentCurrency.id === orderCurrency.id) {
            return amountCurrency;
        }
        return convertCurrency(amountCurrency, paymentCurrency, orderCurrency, this.models);
    },

    setAmountCurrencyForeign(amountCurrency) {
        this.pos_order_id.assertEditable();
        const paymentCurrency = this.getPaymentCurrency();
        const orderCurrency = this.pos_order_id?.currency;
        if (!paymentCurrency || !orderCurrency) {
            this.setAmount(amountCurrency);
            return;
        }
        const baseAmount = this.convertAmountToOrderCurrency(parseFloat(amountCurrency) || 0);
        this.update({
            amount: baseAmount || 0,
            payment_currency_amount: roundDecimals(
                parseFloat(amountCurrency) || 0,
                paymentCurrency.decimal_places ?? 2
            ),
            payment_currency_rate:
                getExchangeRate(paymentCurrency, orderCurrency, this.models) || 1,
        });
    },

    setAmount(value) {
        if (!this.pos_order_id?.assertEditable || !this.pos_order_id?.currency) {
            this.update({
                amount: parseFloat(value) || 0,
            });
            return;
        }
        if (this.isForeignCurrencyPayment()) {
            this.setAmountCurrencyForeign(value);
            return;
        }
        super.setAmount(...arguments);
    },

    // Odoo 19 removed `serialize()`/`export_for_printing()` from PosPayment
    // entirely (no override point left to patch: syncing to the backend is
    // now fully generic/field-schema-driven, and the receipt reads live
    // records directly - see order_receipt.js's
    // formatReceiptPaymentForeignAmount). `payment_currency_id`,
    // `payment_currency_amount` and `payment_currency_rate` are already
    // registered as `extraFields` above, so the generic sync already
    // includes them without a custom serialize() override.
});
