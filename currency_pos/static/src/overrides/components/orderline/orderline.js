import { Orderline } from "@point_of_sale/app/components/orderline/orderline";
import { patch } from "@web/core/utils/patch";
import { usePos } from "@point_of_sale/app/hooks/pos_hook";
import { formatCurrency } from "@web/core/currency";

/**
 * Currency conversion functionality for order lines
 * Shows the price converted to the selected exchange currency next to the original price
 */

patch(Orderline.prototype, {
    setup() {
        super.setup();
        this.pos = usePos();
    },

    /**
     * Get the converted price in the selected exchange currency
     */
    getConvertedPrice() {
        const exchangeCurrency = this.pos.getExchangeCurrencyForDisplay();
        if (!exchangeCurrency) {
            return null;
        }

        // Odoo 19's Orderline no longer exposes a "price" display string on
        // the line prop directly (that only existed inside the component's
        // own internal lineScreenValues getter); the formatted total-price
        // string is now the line record's own currencyDisplayPrice getter.
        const priceStr = this.line.currencyDisplayPrice;
        if (priceStr === 'free' || priceStr === 'Free' || !priceStr) {
            return null;
        }

        // Get exchange rate between company currency and selected currency
        const companyCurrency = this.pos.company.currency_id;
        if (!companyCurrency || exchangeCurrency.id === companyCurrency.id) {
            return null; // No conversion needed
        }

        // Parse the price to get numeric value
        let numericPrice = 0;
        try {
            // Remove currency symbols and extra spaces, but keep decimal separators
            let cleanStr = priceStr.replace(/[^\d.,\s]/g, '').trim();

            // Handle different number formats (e.g., "2.725,60" or "2,725.60")
            // First, try to find a number with comma as decimal separator
            let match = cleanStr.match(/(\d+(?:\.\d{3})*),\d+/);
            if (match) {
                // European format: 2.725,60 -> 2725.60
                const parts = match[0].split(',');
                const integerPart = parts[0].replace(/\./g, '');
                numericPrice = parseFloat(integerPart + '.' + parts[1]);
            } else {
                // Try American format or simple number
                match = cleanStr.match(/[\d.,]+/);
                if (match) {
                    // Remove thousand separators and normalize decimal separator
                    let numStr = match[0].replace(/,/g, '');
                    numericPrice = parseFloat(numStr);
                }
            }

            if (isNaN(numericPrice) || numericPrice <= 0) {
                return null;
            }
        } catch (error) {
            console.error('Error parsing price:', error);
            return null;
        }

        // Use the convertCurrency function from any product (they all have the same method)
        const products = this.pos.models["product.product"]?.readAll() || [];
        const sampleProduct = products.length > 0 ? products[0] : null;

        if (sampleProduct && sampleProduct.convertCurrency) {
            const convertedPrice = sampleProduct.convertCurrency(numericPrice, companyCurrency, exchangeCurrency);

            // Format the converted price with currency symbol
            const formattedPrice = convertedPrice.toFixed(2);
            const currencySymbol = exchangeCurrency.symbol || exchangeCurrency.name || 'USD';
            return `${currencySymbol}${formattedPrice}`;
        }

        return null;

        // Format the converted price with currency symbol
        const formattedPrice = convertedPrice.toFixed(2);
        const currencySymbol = exchangeCurrency.symbol || exchangeCurrency.name || 'USD';
        return `${currencySymbol}${formattedPrice}`;
    },

    /**
     * Get the converted unit price in the selected exchange currency
     */
    getConvertedUnitPrice() {
        const exchangeCurrency = this.pos.getExchangeCurrencyForDisplay();
        if (!exchangeCurrency) {
            return null;
        }

        // Same story as getConvertedPrice(): the formatted unit-price string
        // is the line record's currencyDisplayPriceUnit getter in Odoo 19.
        const unitPriceStr = this.line.currencyDisplayPriceUnit;
        if (!unitPriceStr || unitPriceStr === 'free' || unitPriceStr === 'Free') {
            return null;
        }

        // Get exchange rate between company currency and selected currency
        const companyCurrency = this.pos.company.currency_id;
        if (!companyCurrency || exchangeCurrency.id === companyCurrency.id) {
            return null; // No conversion needed
        }

        // Parse the unit price to get numeric value (same logic as total price)
        let numericPrice = 0;
        try {
            // Remove currency symbols and extra spaces, but keep decimal separators
            let cleanStr = unitPriceStr.replace(/[^\d.,\s]/g, '').trim();

            // Handle different number formats (e.g., "2.725,60" or "2,725.60")
            // First, try to find a number with comma as decimal separator
            let match = cleanStr.match(/(\d+(?:\.\d{3})*),\d+/);
            if (match) {
                // European format: 2.725,60 -> 2725.60
                const parts = match[0].split(',');
                const integerPart = parts[0].replace(/\./g, '');
                numericPrice = parseFloat(integerPart + '.' + parts[1]);
            } else {
                // Try American format or simple number
                match = cleanStr.match(/[\d.,]+/);
                if (match) {
                    // Remove thousand separators and normalize decimal separator
                    let numStr = match[0].replace(/,/g, '');
                    numericPrice = parseFloat(numStr);
                }
            }

            if (isNaN(numericPrice) || numericPrice <= 0) {
                return null;
            }
        } catch (error) {
            return null;
        }

        // Use the convertCurrency function from any product
        const products = this.pos.models["product.product"]?.readAll() || [];
        const sampleProduct = products.length > 0 ? products[0] : null;

        if (sampleProduct && sampleProduct.convertCurrency) {
            const convertedPrice = sampleProduct.convertCurrency(numericPrice, companyCurrency, exchangeCurrency);

            // Format the converted price with currency symbol
            const formattedPrice = convertedPrice.toFixed(2);
            const currencySymbol = exchangeCurrency.symbol || exchangeCurrency.name || 'USD';
            return `${currencySymbol}${formattedPrice}`;
        }

        return null;
    },

    /**
     * Check if conversion should be shown
     */
    shouldShowConversion() {
        const exchangeCurrency = this.pos.getExchangeCurrencyForDisplay();
        const companyCurrency = this.pos.company.currency_id;
        return exchangeCurrency && companyCurrency && exchangeCurrency.id !== companyCurrency.id;
    }
});
