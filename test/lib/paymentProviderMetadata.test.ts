import { describe, expect, it } from "vitest";
import { PaymentProvider } from "@/lib/payments/types";
import {
  extractNowPaymentsMetadata,
  providerMetadataDisplay,
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

  it("builds concise admin detail groups with copyable provider references", () => {
    const metadata = extractNowPaymentsMetadata({
      payment_id: "5634396091",
      invoice_id: "5100474464",
      order_id: "order-42",
      price_amount: "2",
      price_currency: "eur",
      pay_amount: "25.68649486",
      pay_currency: "maticmainnet",
      actually_paid: "25.68649486",
      outcome_amount: "2.197182",
      outcome_currency: "usdcsol",
      pay_address: "0x693a23a9465b7EeFF68EC123B0c4A0529CA9Dd0a",
    });

    const display = providerMetadataDisplay(
      PaymentProvider.NOWPAYMENTS.database,
      metadata,
    );

    expect(display?.title).toBe("NOWPayments metadata");
    expect(display?.groups.map((group) => group.title)).toEqual([
      "References",
      "Sale and settlement",
      "Payment details",
    ]);
    expect(display?.groups[0]?.rows[0]).toEqual({
      label: "Payment ID",
      value: "5634396091",
      copyable: true,
    });
    expect(display?.groups[2]?.rows.at(-1)).toEqual({
      label: "Payment address",
      value: "0x693a23a9465b7EeFF68EC123B0c4A0529CA9Dd0a",
      copyable: true,
    });
    expect(
      providerMetadataDisplay(PaymentProvider.STRIPE.database, metadata),
    ).toBeNull();
  });
});
