import { OrderSummary } from "@point_of_sale/app/screens/product_screen/order_summary/order_summary";
import { CurrencyRatesWidget } from "@currency_pos/app/generic_components/currency_rates_widget/currency_rates_widget";

// Registering the extra component is a direct mutation of the static
// components registry, not a prototype method to override, so there is
// nothing for patch() to wrap here; the previous extra patch(OrderSummary,
// {static: {...}}) call below this was a no-op (it just set an unused
// "static" own property on the class) and has been removed.
if (!OrderSummary.components) {
    OrderSummary.components = {};
}

OrderSummary.components.CurrencyRatesWidget = CurrencyRatesWidget;
