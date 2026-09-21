import * as Chrome from "@point_of_sale/../tests/pos/tours/utils/chrome_util";
import * as ProductScreen from "@point_of_sale/../tests/pos/tours/utils/product_screen_util";
import * as PaymentScreen from "@point_of_sale/../tests/pos/tours/utils/payment_screen_util";
import * as ReceiptScreen from "@point_of_sale/../tests/pos/tours/utils/receipt_screen_util";
import { registry } from "@web/core/registry";

registry.category("web_tour.tours").add("PosPaymentCurrencyTour", {
    steps: () =>
        [
            Chrome.startPoS(),
            ProductScreen.addOrderline("Tour MC Product", "1"),
            ProductScreen.clickPayButton(),
            PaymentScreen.clickPaymentMethod("Bank EUR"),
            PaymentScreen.clickPaymentMethod("Bank EUR"),
            PaymentScreen.validateButtonIsHighlighted(true),
            PaymentScreen.clickValidate(),
            // Validating always lands on the ReceiptScreen first (this is
            // universal core behavior, not a 19-specific change); core's own
            // tours always click "New Order" there before checking the
            // product screen is shown again (see ReceiptScreen.isDone() in
            // receipt_screen_tour.js), which this tour was missing.
            ReceiptScreen.isShown(),
            ReceiptScreen.clickNextOrder(),
            ProductScreen.isShown(),
        ].flat(),
});
