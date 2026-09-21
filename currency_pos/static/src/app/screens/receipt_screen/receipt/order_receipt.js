import { OrderReceipt } from "@point_of_sale/app/screens/receipt_screen/receipt/order_receipt";
import { patch } from "@web/core/utils/patch";
import { formatFloat } from "@web/core/utils/numbers";

patch(OrderReceipt.prototype, {
    // Odoo 19 dropped the pos.payment `export_for_printing()` snapshot
    // entirely (it no longer exists on PosPayment at all; the receipt now
    // reads live records via the `paymentLines` getter, e.g.
    // `line.payment_method_id.name`), so the payment_currency_* fields this
    // used to read off a pre-baked plain object no longer exist. Read the
    // same data from the live getters this module's own pos_payment.js patch
    // already provides.
    formatReceiptPaymentForeignAmount(line) {
        if (!line?.isForeignCurrencyPayment?.()) {
            return "";
        }
        const paymentCurrency = line.getPaymentCurrency();
        const decimalPlaces = paymentCurrency?.decimal_places ?? 2;
        const formattedAmount = formatFloat(line.getPaymentAmountCurrency(), {
            digits: [true, decimalPlaces],
        });
        const symbol = paymentCurrency?.symbol || paymentCurrency?.name || "";
        return `${formattedAmount} ${symbol}`.trim();
    },
});
