import { PosStore } from "@point_of_sale/app/services/pos_store";
import { patch } from "@web/core/utils/patch";
import { EventBus } from "@odoo/owl";

import { getPaymentMethodCurrency } from "@currency_pos/app/utils/payment_currency_utils";

patch(PosStore.prototype, {
    async setup(...args) {
        await super.setup(...args);
        this.currencyEventBus = new EventBus();
        this.exchange_currency_id = this._getDefaultPricelistCurrency();
        await this.currencyPosRefreshForeignProductPrices();
    },

    _getCurrencyRecord(currencyLike) {
        if (!currencyLike) {
            return null;
        }
        if (typeof currencyLike === "object") {
            return currencyLike;
        }
        return this.models["res.currency"]?.find((currency) => currency.id === currencyLike) || null;
    },

    _getDefaultPricelistCurrency() {
        const pricelist = this.config?.pricelist_id;
        return this._getCurrencyRecord(pricelist?.currency_id) || this.company?.currency_id || null;
    },

    setExchangeCurrency(currency) {
        const oldCurrency = this.exchange_currency_id;
        this.exchange_currency_id = currency;
        if (oldCurrency !== currency) {
            this.currencyEventBus.trigger("change:exchange_currency_id", currency);
        }
    },

    getExchangeCurrency() {
        return (
            this.exchange_currency_id ||
            this._getDefaultPricelistCurrency() ||
            this.company?.currency_id
        );
    },

    getExchangeCurrencyForDisplay() {
        return this.exchange_currency_id || this._getDefaultPricelistCurrency();
    },

    // Odoo 19 removed getPaymentMethodDisplayText() from core entirely (the
    // payment button template now shows `paymentMethod.name` directly, and a
    // new getPaymentMethodFmtAmount() shows a separate amount hint), so
    // there is no `super` implementation left to call and no template left
    // that renders this hook's result. Kept as a standalone helper (base
    // text built from `pm.name` directly) in case another module or a
    // future template patch wants "name - currency"; nothing in this addon
    // currently renders it.
    getPaymentMethodDisplayText(pm, order) {
        const baseText = pm?.name || "";
        const currency =
            getPaymentMethodCurrency(pm, this.models, null) ||
            this.company?.currency_id ||
            this.currency;
        if (!currency?.name) {
            return baseText;
        }
        return `${baseText} - ${currency.name}`;
    },

    _currencyPosIsForeignProduct(product) {
        const posCurrencyId = this.currency?.id;
        if (!product || !posCurrencyId) {
            return false;
        }
        const productCurrencyId = product.currency_id?.id || product.currency_id;
        return Boolean(productCurrencyId && productCurrencyId !== posCurrencyId);
    },

    async currencyPosApplyProductPrices(products) {
        const productList = (products || []).filter((product) => product?.id);
        if (!productList.length || !this.config?.id) {
            return productList;
        }
        const prices = await this.data.call(
            "product.product",
            "currency_pos_get_product_prices",
            [productList.map((product) => product.id), this.config.id]
        );
        const posCurrencyId = this.currency?.id;
        for (const product of productList) {
            const converted = prices[product.id];
            if (!converted) {
                continue;
            }
            product.update({
                lst_price: converted.lst_price,
                standard_price: converted.standard_price,
            });
            product.currency_pos_lst_price = converted.currency_pos_lst_price;
            product.currency_pos_standard_price = converted.currency_pos_standard_price;
            product._currencyPosPriceCurrencyId =
                converted._currency_pos_price_currency_id || posCurrencyId;
            // Odoo 19's `.raw` getter returns a deeply immutable snapshot
            // (related_models/base.js: `deepImmutable(this[RAW_SYMBOL],
            // "Raw data cannot be modified", ...)`); writing to it, which
            // used to be tolerated, now throws. These ad-hoc cache fields
            // only need to survive for the current session, so the plain
            // property assignments above are enough -- there is no
            // supported way to also mirror them onto the immutable raw
            // snapshot anymore.
        }
        return productList;
    },

    async currencyPosRefreshForeignProductPrices() {
        const products = this.models["product.product"]
            .getAll()
            .filter((product) => this._currencyPosIsForeignProduct(product));
        for (let index = 0; index < products.length; index += 50) {
            await this.currencyPosApplyProductPrices(products.slice(index, index + 50));
        }
    },

    // Odoo 19 removed processProductAttributesByProducts() entirely; new
    // products are now fetched through loadNewProducts() (product.template's
    // load_product_from_pos), so hook the same "apply currency-converted
    // prices to whatever is newly added" logic there instead.
    async loadNewProducts(domain, offset = 0, limit = 0) {
        const idsBefore = new Set(
            this.models["product.product"].getAll().map((product) => product.id)
        );
        const result = await super.loadNewProducts(domain, offset, limit);
        const newProducts = this.models["product.product"]
            .getAll()
            .filter((product) => !idsBefore.has(product.id));
        if (newProducts.length) {
            await this.currencyPosApplyProductPrices(newProducts);
        }
        return result;
    },

    async editProduct(product) {
        const originalDoAction = this.action.doAction.bind(this.action);
        this.action.doAction = (actionRequest, options = {}) => {
            if (options?.props?.onSave) {
                const originalOnSave = options.props.onSave;
                options.props.onSave = async (record) => {
                    await originalOnSave(record);
                    const productRecord = this.models["product.product"].get(
                        record.evalContext.id
                    );
                    if (productRecord) {
                        await this.currencyPosApplyProductPrices([productRecord]);
                    }
                };
            }
            return originalDoAction(actionRequest, options);
        };
        try {
            return await super.editProduct(...arguments);
        } finally {
            this.action.doAction = originalDoAction;
        }
    },

    _currencyPosAvailablePricelists() {
        if (this.config?.use_pricelist) {
            return this.config.available_pricelist_ids || [];
        }
        return this.config?.pricelist_id ? [this.config.pricelist_id] : [];
    },

    _currencyPosFixProductInfoPricelists(product, quantity, priceExtra, productInfo) {
        if (!product || !productInfo?.pricelists?.length) {
            return;
        }
        const posCurrency = this.currency;
        const available = this._currencyPosAvailablePricelists();
        const byId = Object.fromEntries(available.map((pricelist) => [pricelist.id, pricelist]));
        for (const row of productInfo.pricelists) {
            const pricelist = byId[row.id] || this.models["product.pricelist"]?.get?.(row.id);
            if (!pricelist) {
                continue;
            }
            const pricePos = product.getPrice(pricelist, quantity, priceExtra);
            row.price = pricePos;
            row.price_pos_currency = pricePos;
            row.currency_id = posCurrency?.id;
            const pricelistCurrency = pricelist.currency_id;
            row.pricelist_currency_id = pricelistCurrency?.id;
            row.pricelist_currency_name = pricelistCurrency?.name;
            row.pricelist_currency_symbol =
                pricelistCurrency?.symbol || pricelistCurrency?.name;
            if (row.price_pricelist_currency == null) {
                if (
                    pricelistCurrency &&
                    posCurrency &&
                    pricelistCurrency.id !== posCurrency.id &&
                    typeof product.convertCurrency === "function"
                ) {
                    row.price_pricelist_currency = product.convertCurrency(
                        pricePos,
                        posCurrency,
                        pricelistCurrency
                    );
                } else {
                    row.price_pricelist_currency = pricePos;
                }
            }
        }
    },

    // Odoo 19 changed getProductInfo()'s signature to
    // (productTemplate, quantity, priceExtra, productProduct) and now builds
    // its own RPC call args internally from `productTemplate.getPrice(...)`
    // instead of accepting an externally-supplied price, so the old
    // `this.data.call` interception (which rewrote the get_product_info_pos
    // args for the removed product.product RPC) no longer applies to
    // anything core actually calls. Applying the currency conversion to the
    // product record BEFORE calling super is enough: super's own price/
    // margin computation reads the record's (now already-converted)
    // lst_price/standard_price directly.
    async getProductInfo(productTemplate, quantity, priceExtra = 0, productProduct = false) {
        const product = productProduct || productTemplate;
        if (product) {
            await this.currencyPosApplyProductPrices([product]);
        }
        const result = await super.getProductInfo(
            productTemplate,
            quantity,
            priceExtra,
            productProduct
        );
        this._currencyPosFixProductInfoPricelists(
            productTemplate,
            quantity,
            priceExtra,
            result?.productInfo
        );
        if (product && result?.productInfo?.all_prices) {
            const standardPrice =
                typeof product._currencyPosResolveStandardPrice === "function"
                    ? product._currencyPosResolveStandardPrice()
                    : product.standard_price;
            const priceWithoutTax = result.productInfo.all_prices.price_without_tax;
            const margin = priceWithoutTax - standardPrice;
            result.costCurrency = this.env.utils.formatCurrency(standardPrice);
            result.marginCurrency = this.env.utils.formatCurrency(margin);
            result.marginPercent = priceWithoutTax
                ? Math.round((margin / priceWithoutTax) * 10000) / 100
                : 0;
        }
        return result;
    },
});


