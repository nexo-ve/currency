import { ProductCard } from "@point_of_sale/app/components/product_card/product_card";
import { patch } from "@web/core/utils/patch";

// Odoo 19 removed PosStore.getProductPrice() entirely and, along with it,
// dropped the base-price display from ProductCard's own template (the
// default grid card no longer shows a price at all: see
// point_of_sale.ProductCard's XML, which has no price node). The formatted
// tax-in/tax-excluded price ProductCard used to fetch via
// pos.getProductPrice(product) is now the displayPriceUnit getter directly
// on the product record (product.template, delegated onto product.product);
// the raw numeric equivalent (for currency conversion) is getTaxDetails().
patch(ProductCard.prototype, {
    get productPrice() {
        if (!this.props.product) {
            return "";
        }

        try {
            return this.props.product.displayPriceUnit;
        } catch (error) {
            console.warn("Error calculating product price:", error);
            return "";
        }
    },

    get productPricesInOtherCurrencies() {
        if (!this.props.product) {
            return [];
        }

        try {
            const prices = [];
            const pos = this.env.services.pos;
            const posCurrency = pos.currency;
            const config = pos.config;
            const taxDetails = this.props.product.getTaxDetails();
            const price =
                config.iface_tax_included === "total"
                    ? taxDetails.total_included
                    : taxDetails.total_excluded;
            const currencies = pos.models["res.currency"]
                .readAll()
                .filter((currency) => currency.id !== posCurrency.id);

            for (const currency of currencies) {
                try {
                    const convertedPrice = this.props.product.convertCurrency(
                        price,
                        posCurrency,
                        currency
                    );
                    const formattedPrice = `${currency.symbol || currency.name} ${convertedPrice.toLocaleString(
                        "es-ES",
                        { minimumFractionDigits: 2, maximumFractionDigits: 2 }
                    )}`;
                    prices.push({
                        currency: currency,
                        price: formattedPrice,
                    });
                } catch (error) {
                    console.warn(
                        "Error calculating price for currency " + currency.name + ":",
                        error
                    );
                }
            }

            return prices;
        } catch (error) {
            console.warn("Error calculating prices in other currencies:", error);
            return [];
        }
    },
});
