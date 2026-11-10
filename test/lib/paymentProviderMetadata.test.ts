import { describe, expect, it } from "vitest";
import { PaymentProvider } from "@/lib/payments/types";
import {
  extractNowPaymentsMetadata,
  providerMetadataRows,
} from "@/lib/paymentProviderMetadata";

describe("NOWPayments provider metadata", () => {
  it("keeps selected payment tracing fields and omits callback noise", () => {
    const metadata = extractNowPaymentsMetadata({
      payment_id: "5634396091",
      invoice_id: "5100474464",
      order_id: "ord_-ziATqSArs_4Do7m",
      purchase_id: "5528364594",
      parent_payment_id: null,
      payment_status: "finished",
      order_description: "Editing Room Monochrome - Lukin",
      price_amount: "2",
      price_currency: "eur",
      pay_amount: "25.68649486",
      pay_currency: "maticmainnet",
      actually_paid: "25.68649486",
      pay_address: "0x693a23a9465b7EeFF68EC123B0c4A0529CA9Dd0a",
      payin_extra_id: null,
      payment_extra_ids: null,
      outcome_amount: "2.197182",
      outcome_currency: "usdcsol",
      fee: {
        currency: "usdcsol",
        depositFee: "0.00126",
        serviceFee: "0.022194",
        withdrawalFee: "0",
      },
      created_at: "2026-11-09T08:59:00Z",
      updated_at: "2026-11-09T09:02:00Z",
      actually_paid_at_fiat: "0",
    });

    expect(metadata).toEqual({
      nowpayments: {
        paymentId: "5634396091",
        invoiceId: "5100474464",
        orderId: "ord_-ziATqSArs_4Do7m",
        purchaseId: "5528364594",
        status: "finished",
        orderDescription: "Editing Room Monochrome - Lukin",
        priceAmount: "2",
        priceCurrency: "eur",
        payAmount: "25.68649486",
        payCurrency: "maticmainnet",
        actuallyPaid: "25.68649486",
        payAddress: "0x693a23a9465b7EeFF68EC123B0c4A0529CA9Dd0a",
        outcomeAmount: "2.197182",
        outcomeCurrency: "usdcsol",
        fee: {
          currency: "usdcsol",
          depositFee: "0.00126",
          serviceFee: "0.022194",
          withdrawalFee: "0",
        },
      },
    });
  });

  it("omits payment extra IDs that exceed the migration size limit", () => {
    const metadata = extractNowPaymentsMetadata({
      payment_id: "payment-extra-ids-size-limit",
      payment_extra_ids: ["€".repeat(400)],
    });

    expect(metadata?.nowpayments).toEqual({
      paymentId: "payment-extra-ids-size-limit",
    });
  });

  it("shows saved fields as flat, provider-agnostic rows", () => {
    const metadata = extractNowPaymentsMetadata({
      payment_id: "5634396091",
      invoice_id: "5100474464",
      order_id: "order-42",
      purchase_id: "purchase-42",
      payment_status: "finished",
      order_description: "Preview payment",
      price_amount: "2",
      price_currency: "eur",
      pay_amount: "25.68649486",
      pay_currency: "maticmainnet",
      actually_paid: "25.68649486",
      outcome_amount: "2.197182",
      outcome_currency: "usdcsol",
      pay_address: "0x693a23a9465b7EeFF68EC123B0c4A0529CA9Dd0a",
      fee: {
        currency: "usdcsol",
        depositFee: "0.00126",
        serviceFee: "0.022194",
        withdrawalFee: "0",
      },
    });

    const rows = providerMetadataRows(
      PaymentProvider.NOWPAYMENTS.database,
      metadata,
    );

    expect(rows?.map((row) => row.label)).toEqual([
      "Payment ID",
      "Invoice ID",
      "Order ID",
      "Purchase ID",
      "Status",
      "Order description",
      "Price amount",
      "Price currency",
      "Pay amount",
      "Pay currency",
      "Actually paid",
      "Pay address",
      "Outcome amount",
      "Outcome currency",
      "Fee currency",
      "Fee deposit fee",
      "Fee service fee",
      "Fee withdrawal fee",
    ]);
    expect(rows?.[0]).toEqual({
      path: "paymentId",
      label: "Payment ID",
      value: "5634396091",
      copyable: true,
    });
    expect(rows?.find((row) => row.label === "Pay address")).toEqual({
      path: "payAddress",
      label: "Pay address",
      value: "0x693a23a9465b7EeFF68EC123B0c4A0529CA9Dd0a",
      copyable: true,
    });

    expect(
      providerMetadataRows(PaymentProvider.STRIPE.database, {
        stripe: { paymentIntentId: "pi_demo_42", status: "succeeded" },
      }),
    ).toEqual([
      {
        path: "paymentIntentId",
        label: "Payment intent ID",
        value: "pi_demo_42",
        copyable: true,
      },
      {
        path: "status",
        label: "Status",
        value: "succeeded",
      },
    ]);
  });
});
