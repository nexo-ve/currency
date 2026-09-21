import { ProductProduct } from "@point_of_sale/app/models/product_product";
import { ProductTemplate } from "@point_of_sale/app/models/product_template";
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
// convertCurrency() for the other currency_pos overrides.
//
// Odoo 19 also changed which model the product grid displays: PosStore's
// productsToDisplay/productToDisplayByCateg now iterate
// this.models["product.template"] (not product.product), so ProductCard's
// `props.product` -- and therefore anything reading convertCurrency() off
// it, like productPricesInOtherCurrencies() -- is a product.template
// instance there. Patching only ProductProduct.prototype left
// product.template records without convertCurrency() at all ("is not a
// function"), so the same helpers are patched onto both prototypes here.
const currencyPosProductHelpers = {
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

};

patch(ProductProduct.prototype, currencyPosProductHelpers);
patch(ProductTemplate.prototype, currencyPosProductHelpers);
