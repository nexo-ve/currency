import { PosOrder } from "@point_of_sale/app/models/pos_order";
import { patch } from "@web/core/utils/patch";
import { formatCurrency } from "@point_of_sale/app/models/utils/currency";
import { accountTaxHelpers } from "@account/helpers/account_tax";
import { roundDecimals, floatIsZero } from "@web/core/utils/numbers";
import { toRaw } from "@odoo/owl";
import {
    convertCurrency,
    convertOrderRemainingToForeign,
} from "../utils/payment_currency_utils";

// POS 19 removed the `lt` helper from "@point_of_sale/utils". Replicate the
// Odoo 18 decimals-based implementation locally to preserve identical behavior.
function lt(a, b, { decimals } = {}) {
    if (decimals === undefined) {
        throw new Error("decimals must be provided");
    }
    a = roundDecimals(a, decimals);
    b = roundDecimals(b, decimals);
    const delta = a - b;
    if (floatIsZero(delta, decimals)) {
        return false;
    }
    return delta < 0;
}

patch(PosOrder.prototype, {
    setup(vals) {
        super.setup(vals);
        this.exchange_currency_id = vals.exchange_currency_id || null;
    },

    get_exchange_currency_for_display() {
        return this.exchange_currency_id;
    },

    electronic_payment_in_progress() {
        const allowedMethodIds = (this.config_id?.payment_method_ids || []).map((pm) => pm.id);
        return this.payment_ids.some((paymentLine) => {
            if (!paymentLine?.payment_method_id) {
                return false;
            }
            if (
                allowedMethodIds.length &&
                !allowedMethodIds.includes(paymentLine.payment_method_id.id)
            ) {
                return false;
            }
            if (paymentLine.payment_status) {
                return !["done", "reversed"].includes(paymentLine.payment_status);
            }
            return false;
        });
    },

    is_paid_with_cash() {
        return !!this.payment_ids.find((paymentLine) => {
            const paymentMethod = paymentLine?.payment_method_id;
            if (!paymentMethod) {
                return false;
            }
            if (typeof paymentMethod === "object") {
                return Boolean(paymentMethod.is_cash_count);
            }
            const paymentMethodRecord = this.models["pos.payment.method"].find(
                (method) => method.id === paymentMethod
            );
            return Boolean(paymentMethodRecord?.is_cash_count);
        });
    },

    getCustomerDisplayData() {
        return {
            lines: this.getSortedOrderlines().map((line) => ({
                ...line.getDisplayData(),
                isSelected: line.isSelected(),
                imageSrc: `/web/image/product.product/${line.product_id.id}/image_128`,
            })),
            finalized: this.finalized,
            // Odoo 19 replaced get_total_with_tax()/get_change() with the
            // priceIncl/change getters.
            amount: formatCurrency(this.priceIncl || 0, this.currency),
            paymentLines: this.payment_ids
                .filter((paymentLine) => paymentLine)
                .map((paymentLine) => ({
                    name: paymentLine.payment_method_id?.name || "",
                    amount: formatCurrency(paymentLine.getAmount() || 0, this.currency),
                })),
            change: this.change && formatCurrency(this.change, this.currency),
            generalNote: this.general_note || "",
            qrPaymentData: toRaw(this.getSelectedPaymentline()?.qrPaymentData),
        };
    },

    _hasForeignCurrencyPayments() {
        const config = this.config_id || this.config;
        if (!config?.allow_multi_currency_payment) {
            return false;
        }
        return this.payment_ids.some(
            (payment) => !payment.is_change && payment.isForeignCurrencyPayment?.()
        );
    },

    getForeignCurrencyRemaining(paymentCurrency) {
        return convertOrderRemainingToForeign(this, paymentCurrency, this.models);
    },

    /**
     * Totals of the current lines as if each available pricelist (except the
     * active one) were applied. Display-only: does not change order lines.
     */
    getAlternatePricelistTotals() {
        if (!this.config?.use_pricelist || !this.lines?.length) {
            return [];
        }
        const available = this.config.available_pricelist_ids || [];
        const currentId = this.pricelist_id?.id;
        const others = available.filter((pricelist) => pricelist.id !== currentId);
        if (!others.length) {
            return [];
        }

        const currency = this.config.currency_id;
        const company = this.company;
        const documentSign =
            !this.lines.every((line) => lt(line.qty, 0, { decimals: currency.decimal_places }))
                ? 1
                : -1;

        return others.map((pricelist) => {
            const baseLines = this.lines.map((line) => {
                // Odoo 19 removed get_unit_price() with no direct
                // replacement (pricing now goes through the prices/
                // unitPrices getters); price_unit is the raw stored field it
                // fell back to for non-"original"/combo lines anyway.
                let priceUnit = line.price_unit;
                if (
                    line.price_type === "original" &&
                    line.product_id &&
                    !line.combo_line_ids?.length
                ) {
                    priceUnit = line.product_id.getPrice(
                        pricelist,
                        line.getQuantity(),
                        line.getPriceExtra()
                    );
                }
                return accountTaxHelpers.prepare_base_line_for_taxes_computation(
                    line,
                    line.prepareBaseLineForTaxesComputationExtraValues({
                        quantity: documentSign * line.qty,
                        price_unit: priceUnit,
                    })
                );
            });
            accountTaxHelpers.add_tax_details_in_base_lines(baseLines, company);
            accountTaxHelpers.round_base_lines_tax_details(baseLines, company);
            const taxTotals = accountTaxHelpers.get_tax_totals_summary(
                baseLines,
                currency,
                company,
                { cash_rounding: null }
            );
            const total = documentSign * (taxTotals.total_amount_currency || 0);
            const displayCurrency = pricelist.currency_id || currency;
            let displayTotal = total;
            if (
                displayCurrency?.id &&
                currency?.id &&
                displayCurrency.id !== currency.id &&
                this.lines[0]?.product_id?.convertCurrency
            ) {
                displayTotal = this.lines[0].product_id.convertCurrency(
                    total,
                    currency,
                    displayCurrency
                );
            }
            return {
                id: pricelist.id,
                name: pricelist.display_name || pricelist.name,
                total: displayTotal,
                currencyId: displayCurrency.id,
            };
        });
    },

    // Odoo 19 replaced the get_due()/get_change() methods with the
    // remainingDue/change getters, computed live from totalDue/amountPaid
    // instead of a cached taxTotals.order_remaining. The original override
    // deliberately returned the raw (unrounded, no cash-rounding snapping)
    // remaining/change for orders with a foreign-currency payment, since
    // cash-rounding math assumes a single order-currency amount; replicate
    // that by working straight off totalDue/amountPaid (both already in the
    // order's own currency: payment amounts are always stored converted via
    // setAmountCurrencyForeign) instead of going through the
    // asymmetricRound/cash-rounding path the full getters apply.
    get remainingDue() {
        if (this._hasForeignCurrencyPayments()) {
            return this.currency.round(this.totalDue - this.amountPaid);
        }
        return super.remainingDue;
    },

    get change() {
        if (this._hasForeignCurrencyPayments()) {
            return this.currency.round(this.amountPaid - this.totalDue);
        }
        return super.change;
    },

    _getPaymentMethodRecord(paymentMethodLike) {
        if (!paymentMethodLike) {
            return null;
        }
        if (typeof paymentMethodLike === "object") {
            return paymentMethodLike;
        }
        return this.models["pos.payment.method"].find((method) => method.id === paymentMethodLike);
    },

    _getPaymentCurrencyRecord(paymentMethod) {
        if (!paymentMethod) {
            return null;
        }
        if (typeof paymentMethod.payment_currency_id === "object") {
            return paymentMethod.payment_currency_id;
        }
        return (
            this.models["res.currency"].find(
                (currency) => currency.id === paymentMethod.payment_currency_id
            ) || null
        );
    },

    _isForeignPaymentMethod(paymentMethod) {
        const config = this.config_id || this.config;
        if (!config?.allow_multi_currency_payment || !paymentMethod) {
            return false;
        }
        const paymentCurrency = this._getPaymentCurrencyRecord(paymentMethod);
        return Boolean(
            paymentCurrency && this.currency && paymentCurrency.id !== this.currency.id
        );
    },

    addPaymentline(payment_method) {
        const paymentMethod = this._getPaymentMethodRecord(payment_method);
        if (!this._isForeignPaymentMethod(paymentMethod)) {
            return super.addPaymentline(...arguments);
        }

        this.assertEditable();
        if (this.electronic_payment_in_progress()) {
            return false;
        }

        const paymentCurrency = this._getPaymentCurrencyRecord(paymentMethod);
        const orderDue = this.getDefaultAmountDueToPayIn(payment_method);
        const foreignAmount = convertCurrency(
            orderDue,
            this.currency,
            paymentCurrency,
            this.models
        );

        const newPaymentline = this.models["pos.payment"].create({
            pos_order_id: this,
            payment_method_id: payment_method,
        });
        this.selectPaymentline(newPaymentline);
        newPaymentline.setAmountCurrencyForeign(foreignAmount);

        if (
            paymentMethod.payment_terminal ||
            paymentMethod.payment_method_type === "qr_code"
        ) {
            newPaymentline.setPaymentStatus("pending");
        }
        return newPaymentline;
    },
});
