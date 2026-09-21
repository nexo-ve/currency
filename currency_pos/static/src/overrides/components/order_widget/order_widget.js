// Odoo 19 removed the OrderWidget component/template entirely and replaced
// it with OrderDisplay (@point_of_sale/app/components/order_display), whose
// props are {order, slots, mode} -- there is no more taxTotals prop, since
// Odoo 19 removed the order-level taxTotals getter entirely. Everything this
// override used to read off props.taxTotals now comes straight off
// this.order (order.priceIncl for the order's own unrounded total, the same
// figure core's own currencyDisplayPriceIncl formats). The order-summary
// div this patch injects into still exists with the same class in
// OrderDisplay's template, so the xpath in order_widget.xml did not need to
// change, only the t-inherit target name.
import { OrderDisplay } from "@point_of_sale/app/components/order_display/order_display";
import { patch } from "@web/core/utils/patch";
import { useState, onMounted, onWillUnmount } from "@odoo/owl";
import { formatMonetary } from "@web/views/fields/formatters";

patch(OrderDisplay.prototype, {
    setup() {
        super.setup();
        this.pos = this.env.services.pos;
        this.currencyState = useState({
            exchangeCurrencyId: this.pos.getExchangeCurrencyForDisplay()?.id || null,
            updateKey: 0,
        });

        onMounted(() => {
            this.currencyState.exchangeCurrencyId =
                this.pos.getExchangeCurrencyForDisplay()?.id || null;
            this.currencyEventListener = () => {
                const currentExchangeCurrencyId = this.pos.getExchangeCurrencyForDisplay()?.id;
                if (this.currencyState.exchangeCurrencyId !== currentExchangeCurrencyId) {
                    this.currencyState.exchangeCurrencyId = currentExchangeCurrencyId;
                    this.currencyState.updateKey++;
                }
            };
            this.pos.currencyEventBus?.addEventListener(
                "change:exchange_currency_id",
                this.currencyEventListener
            );
        });

        onWillUnmount(() => {
            if (this.currencyEventListener) {
                this.pos.currencyEventBus?.removeEventListener(
                    "change:exchange_currency_id",
                    this.currencyEventListener
                );
            }
        });
    },

    // OrderDisplay has no formatMonetary prop (unlike O18's OrderWidget);
    // an alt-pricelist total can be in a currency other than the order's
    // own, so this.formatCurrency() (always the order's own currency) does
    // not fit -- format directly against the requested currencyId instead.
    formatAltTotal(amount, currencyId) {
        return formatMonetary(amount, { currencyId, noSymbol: false });
    },

    getConvertedTotal() {
        void this.currencyState.updateKey;
        const exchangeCurrency = this.pos.getExchangeCurrencyForDisplay();
        if (!exchangeCurrency) {
            return null;
        }

        const total = this.order.priceIncl;
        const companyCurrency = this.pos.company.currency_id;
        if (!companyCurrency || exchangeCurrency.id === companyCurrency.id) {
            return null;
        }

        const products = this.pos.models["product.product"]?.readAll() || [];
        const sampleProduct = products.length > 0 ? products[0] : null;
        if (!sampleProduct?.convertCurrency) {
            return null;
        }

        const convertedTotal = sampleProduct.convertCurrency(
            total,
            companyCurrency,
            exchangeCurrency
        );
        const formattedTotal = convertedTotal.toFixed(2);
        const currencySymbol = exchangeCurrency.symbol || exchangeCurrency.name || "USD";
        return `${currencySymbol}${formattedTotal}`;
    },

    shouldShowTotalConversion() {
        void this.currencyState.updateKey;
        const exchangeCurrency = this.pos.getExchangeCurrencyForDisplay();
        const companyCurrency = this.pos.company.currency_id;
        return Boolean(
            exchangeCurrency && companyCurrency && exchangeCurrency.id !== companyCurrency.id
        );
    },

    getAlternatePricelistTotals() {
        if (this.pos.router?.state?.current !== "ProductScreen") {
            return [];
        }
        const order = this.pos.getOrder();
        if (!order) {
            return [];
        }
        return order.getAlternatePricelistTotals?.() || [];
    },
});
