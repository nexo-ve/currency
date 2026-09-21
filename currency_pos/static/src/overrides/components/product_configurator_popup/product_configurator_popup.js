import { ProductConfiguratorPopup } from "@point_of_sale/app/components/popups/product_configurator_popup/product_configurator_popup";
import { patch } from "@web/core/utils/patch";

patch(ProductConfiguratorPopup.prototype, {
    // Odoo 19 removed PosStore.getProductPrice(); the tax-in/tax-excluded,
    // already-formatted price is now the displayPriceUnit getter directly
    // on the product record.
    get unitPrice() {
        const product = this.state?.product || this.props.product;
        if (!product) {
            return this.env.utils.formatCurrency(0);
        }
        return product.displayPriceUnit;
    },
});
