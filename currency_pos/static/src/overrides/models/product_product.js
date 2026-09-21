import { ProductProduct } from "@point_of_sale/app/models/product_product";
import { convertCurrency } from "@currency_pos/app/utils/payment_currency_utils";
import { patch } from "@web/core/utils/patch";

function resolveCurrencyId(currencyLike) {
    if (!currencyLike) {
        return null;
    }
    if (Array.isArray(currencyLike)) {
        return currencyLike[0];
    }
    if (currencyLike.id) {
        return currencyLike.id;
    }
    return currencyLike;
}

// Odoo 19 removed product.product's own get_price()/getPricelistRule()
// entirely: pricing now lives on ProductTemplateAccounting.getPrice()
// (product.template), auto-delegated onto product.product records by
// point_of_sale's enhanceProductTemplate() helper, and that getPrice()
// ALREADY converts a rule's price using pricelist.currency_id vs the POS
// currency (see needsCurrencyConversion in product_template_accounting.js)
// -- exactly the behavior this override used to backport onto Odoo 18's
// get_price() via rule.currency_id (a plain related-to-pricelist field, the
// same value pricelist.currency_id already has). So the old get_price /
// getPricelistRule override is fully redundant now and has been removed;
// what remains here only keeps the base list/standard price fields
// themselves correctly converted (currencyPosApplyProductPrices() in
// pos_store.js writes the converted lst_price/standard_price straight onto
// the record before core's getPrice() ever reads them) and exposes
// convertCurrency()/the cost-price resolver other overrides still call.
patch(ProductProduct.prototype, {
    convertCurrency(amount, fromCurrency, toCurrency) {
        if (amount === null || amount === undefined || isNaN(amount)) {
            return amount || 0;
        }
        if (!fromCurrency || !toCurrency) {
            return amount;
        }
        return convertCurrency(amount, fromCurrency, toCurrency, this.models);
    },

    _currencyPosGetCurrency(currencyLike) {
        const currencyId = resolveCurrencyId(currencyLike);
        if (!currencyId) {
            return null;
        }
        return (
            this.models["res.currency"]?.get?.(currencyId) ||
            this.models["res.currency"]?.find?.((currency) => currency.id === currencyId) ||
            null
        );
    },

    _currencyPosGetPosCurrency() {
        const posConfig = this.models["pos.config"]?.getFirst?.();
        return this._currencyPosGetCurrency(posConfig?.currency_id);
    },

    _currencyPosGetPriceCurrencyId() {
        return (
            this._currencyPosPriceCurrencyId ||
            this.raw?._currency_pos_price_currency_id ||
            null
        );
    },

    _currencyPosGetRawStandardPrice() {
        const raw =
            this.currency_pos_standard_price ?? this.raw?.currency_pos_standard_price;
        return raw === undefined ? null : raw;
    },

    _currencyPosResolveStandardPrice() {
        const posCurrency = this._currencyPosGetPosCurrency();
        const costCurrency =
            this._currencyPosGetCurrency(this.cost_currency_id) ||
            this._currencyPosGetCurrency(this.currency_id);
        if (!posCurrency || !costCurrency || costCurrency.id === posCurrency.id) {
            return this.standard_price;
        }
        const raw = this._currencyPosGetRawStandardPrice();
        if (raw !== null) {
            return this.convertCurrency(raw, costCurrency, posCurrency);
        }
        if (this._currencyPosGetPriceCurrencyId() === posCurrency.id) {
            return this.standard_price;
        }
        return this.convertCurrency(this.standard_price || 0, costCurrency, posCurrency);
    },
});
