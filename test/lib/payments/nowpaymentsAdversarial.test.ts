import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NOWPAYMENTS_PAYMENT_STATUS,
  nowpaymentsAdapter,
} from "@/lib/payments/providers/nowpayments";

const SECRET = "adversarial-test-ipn-secret";

function sortForSignature(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForSignature);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortForSignature(child)]),
    );
  }
  return value;
}

function signedHeaders(rawBody: string, secret = SECRET): Headers {
  const canonical = JSON.stringify(sortForSignature(JSON.parse(rawBody)));
  const signature = createHmac("sha512", secret)
    .update(canonical, "utf8")
    .digest("hex");
  return new Headers({ "x-nowpayments-sig": signature });
}

function verify(
  rawBody: string,
  signature: string,
): ReturnType<typeof nowpaymentsAdapter.verifyAndParseWebhook> {
  return nowpaymentsAdapter.verifyAndParseWebhook({
    rawBody,
    headers: new Headers({ "x-nowpayments-sig": signature }),
    connection: { webhookSecret: SECRET },
  });
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffleObjectKeys(value: unknown, random: () => number): unknown {
  if (Array.isArray(value))
    return value.map((item) => shuffleObjectKeys(item, random));
  if (!value || typeof value !== "object") return value;

  const entries = Object.entries(value).map(
    ([key, child]) => [key, shuffleObjectKeys(child, random)] as const,
  );
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [entries[index], entries[swapIndex]] = [entries[swapIndex], entries[index]];
  }
  return Object.fromEntries(entries);
}

function randomPayload(index: number, random: () => number) {
  const statuses = Object.values(NOWPAYMENTS_PAYMENT_STATUS);
  const currencies = ["EUR", "USD", "GBP"];
  const cryptoCurrencies = ["BTC", "USDC", "USDT", "MATIC"];
  const integer = Math.floor(random() * 900_000) + 1;
  const fraction = Math.floor(random() * 100)
    .toString()
    .padStart(2, "0");
  const cryptoInteger = Math.floor(random() * 999) + 1;
  const cryptoFraction = Array.from({ length: 18 }, () =>
    Math.floor(random() * 10),
  ).join("");

  return {
    payment_status: statuses[Math.floor(random() * statuses.length)],
    payment_id: 100_000 + index,
    invoice_id: `invoice-${index}`,
    order_id: `merchant-order-${index}`,
    price_amount: `__price_${integer}_${fraction}__`,
    price_currency: currencies[Math.floor(random() * currencies.length)],
    actually_paid: `__paid_${cryptoInteger}_${cryptoFraction}__`,
    pay_currency:
      cryptoCurrencies[Math.floor(random() * cryptoCurrencies.length)],
    metadata: {
      nested: { z: index, a: `value-${index}` },
      tags: ["provider", index, null],
    },
    updated_at: "2026-11-09T12:34:56.000Z",
  };
}

function bodyWithNumericTokens(payload: ReturnType<typeof randomPayload>): {
  body: string;
  saleAmount: string;
  cryptoAmount: string;
  rawSaleAmount: string;
  rawCryptoAmount: string;
} {
  const rawSaleAmount = payload.price_amount
    .slice("__price_".length, -2)
    .replace("_", ".");
  const rawCryptoAmount = payload.actually_paid
    .slice("__paid_".length, -2)
    .replace("_", ".");
  const [saleInteger, saleFraction = ""] = rawSaleAmount.split(".");
  const [cryptoInteger, cryptoFraction = ""] = rawCryptoAmount.split(".");
  const normalizedSaleFraction = saleFraction.replace(/0+$/, "");
  const normalizedCryptoFraction = cryptoFraction.replace(/0+$/, "");
  const saleAmount = normalizedSaleFraction
    ? `${saleInteger}.${normalizedSaleFraction}`
    : saleInteger;
  const cryptoAmount = normalizedCryptoFraction
    ? `${cryptoInteger}.${normalizedCryptoFraction}`
    : cryptoInteger;
  let body = JSON.stringify(payload);
  body = body.replace(JSON.stringify(payload.price_amount), rawSaleAmount);
  body = body.replace(JSON.stringify(payload.actually_paid), rawCryptoAmount);
  return { body, saleAmount, cryptoAmount, rawSaleAmount, rawCryptoAmount };
}

describe("NOWPayments adapter adversarial properties", () => {
  it("verifies signatures regardless of nested JSON key ordering and preserves money tokens", () => {
    const seed = 0x5eedc0de;
    const random = seededRandom(seed);

    for (let index = 0; index < 250; index += 1) {
      const shuffledPayload = shuffleObjectKeys(
        randomPayload(index, random),
        random,
      ) as ReturnType<typeof randomPayload>;
      const generated = bodyWithNumericTokens(shuffledPayload);
      const event = nowpaymentsAdapter.verifyAndParseWebhook({
        rawBody: generated.body,
        headers: signedHeaders(generated.body),
        connection: { webhookSecret: SECRET },
      });

      expect(event, `seed=${seed}, case=${index}`).not.toBeNull();
      expect(event?.saleAmount, `seed=${seed}, case=${index}`).toBe(
        generated.saleAmount,
      );
      const canonicalCryptoAmount = String(Number(generated.rawCryptoAmount));
      const cryptoAmountIsAuthenticated =
        canonicalCryptoAmount === generated.cryptoAmount;
      expect(event?.cryptoAmount, `seed=${seed}, case=${index}`).toBe(
        cryptoAmountIsAuthenticated ? generated.cryptoAmount : null,
      );
      expect(event?.paymentRef, `seed=${seed}, case=${index}`).toBe(
        String(shuffledPayload.payment_id),
      );
      const rawPayload = event?.rawPayload as
        Record<string, unknown> | undefined;
      expect(rawPayload?.price_amount, `seed=${seed}, case=${index}`).toBe(
        generated.rawSaleAmount,
      );
      expect(rawPayload?.actually_paid, `seed=${seed}, case=${index}`).toBe(
        cryptoAmountIsAuthenticated
          ? generated.rawCryptoAmount
          : canonicalCryptoAmount,
      );
    }
  });

  it("rejects semantic payload mutations when the original signature is replayed", () => {
    const seed = 0xdecafbad;
    const random = seededRandom(seed);

    for (let index = 0; index < 200; index += 1) {
      const generated = bodyWithNumericTokens(randomPayload(index, random));
      const originalSignature = signedHeaders(generated.body).get(
        "x-nowpayments-sig",
      )!;
      const tampered = JSON.parse(generated.body) as Record<string, unknown>;
      const field = index % 3;
      if (field === 0) tampered.payment_id = `attacker-${index}`;
      else if (field === 1)
        tampered.payment_status =
          tampered.payment_status === "finished" ? "waiting" : "finished";
      else
        tampered.price_currency =
          tampered.price_currency === "USD" ? "EUR" : "USD";

      expect(
        verify(JSON.stringify(tampered), originalSignature),
        `seed=${seed}, case=${index}`,
      ).toBeNull();
    }
  });

  it("does not credit decimal precision that the signature cannot distinguish", () => {
    const signedBody =
      '{"payment_status":"finished","payment_id":123456,"price_amount":12.34,"price_currency":"EUR","actually_paid":1.0,"pay_currency":"BTC"}';
    const signature = signedHeaders(signedBody).get("x-nowpayments-sig")!;
    const changedNumberToken = signedBody.replace(
      '"actually_paid":1.0',
      '"actually_paid":1.00000000000000001',
    );

    const event = verify(changedNumberToken, signature);

    // JS canonical JSON rounds both tokens to 1, so the signature cannot
    // authenticate the extra raw precision in the altered token. Keep the
    // payment, but omit that untrusted optional crypto amount.
    expect(event).not.toBeNull();
    expect(event?.cryptoAmount).toBeNull();
    expect(
      (event?.rawPayload as Record<string, unknown> | undefined)?.actually_paid,
    ).toBe("1");
  });

  it("rejects sale-amount and nested-number token collisions under one signature", () => {
    const signedSaleBody =
      '{"payment_status":"finished","payment_id":123456,"price_amount":90071992547409.94,"price_currency":"EUR"}';
    const saleSignature =
      signedHeaders(signedSaleBody).get("x-nowpayments-sig")!;
    const alteredSaleBody = signedSaleBody.replace(
      "90071992547409.94",
      "90071992547409.93",
    );
    expect(verify(alteredSaleBody, saleSignature)).toBeNull();

    const signedMetadataBody =
      '{"payment_status":"finished","payment_id":123456,"price_amount":12.34,"price_currency":"EUR","metadata":{"amount":9007199254740992}}';
    const metadataSignature =
      signedHeaders(signedMetadataBody).get("x-nowpayments-sig")!;
    const alteredMetadataBody = signedMetadataBody.replace(
      "9007199254740992",
      "9007199254740993",
    );
    const metadataEvent = verify(alteredMetadataBody, metadataSignature);
    const rawPayload = metadataEvent?.rawPayload as
      Record<string, unknown> | undefined;
    expect(metadataEvent).not.toBeNull();
    expect(
      (rawPayload?.metadata as Record<string, unknown> | undefined)?.amount,
    ).toBe("9007199254740992");
  });

  it("never throws on malformed JSON fuzz inputs with a syntactically valid signature", () => {
    const seed = 0xf0222026;
    const random = seededRandom(seed);
    const alphabet = '{}[],:\\"0123456789truefalsenull abcXYZ\n\t\u0000';
    const signature = "0".repeat(128);

    for (let index = 0; index < 500; index += 1) {
      const length = Math.floor(random() * 256);
      let rawBody = "";
      for (let character = 0; character < length; character += 1) {
        rawBody += alphabet[Math.floor(random() * alphabet.length)];
      }

      expect(
        () => verify(rawBody, signature),
        `seed=${seed}, case=${index}`,
      ).not.toThrow();
      expect(
        verify(rawBody, signature),
        `seed=${seed}, case=${index}`,
      ).toBeNull();
    }
  });

  it("rejects signed objects with unknown statuses or invalid money fields", () => {
    const mutations: Record<string, unknown>[] = [
      { payment_status: "success" },
      { payment_status: "FINISHED" },
      { price_amount: 0 },
      { price_amount: -1 },
      { price_amount: 1.234 },
      { price_amount: 1e17 },
      { price_amount: "NaN" },
      { price_currency: "EURO" },
      { payment_id: "   " },
      { payment_id: 9007199254740992 },
    ];

    for (const [index, mutation] of mutations.entries()) {
      const payload = {
        payment_status: "finished",
        payment_id: `valid-${index}`,
        invoice_id: `invoice-${index}`,
        price_amount: 12.34,
        price_currency: "EUR",
        ...mutation,
      };
      const body = JSON.stringify(payload);
      const signature = signedHeaders(body).get("x-nowpayments-sig")!;
      expect(
        verify(body, signature),
        `mutation=${JSON.stringify(mutation)}`,
      ).toBeNull();
    }
  });

  it("normalizes harmless trailing zeros to the ledger's two-decimal scale", () => {
    const body =
      '{"payment_status":"finished","payment_id":123456,"price_amount":19.9500,"price_currency":"EUR"}';
    const event = verify(body, signedHeaders(body).get("x-nowpayments-sig")!);

    expect(event?.saleAmount).toBe("19.95");
    expect(
      (event?.rawPayload as Record<string, unknown> | undefined)?.price_amount,
    ).toBe("19.9500");
  });

  it("accepts the crypto ledger precision limit and drops values beyond it", () => {
    const validBody =
      '{"payment_status":"finished","payment_id":123456,"price_amount":12.34,"price_currency":"EUR","actually_paid":10000000000000000000,"pay_currency":"BTC"}';
    const validEvent = verify(
      validBody,
      signedHeaders(validBody).get("x-nowpayments-sig")!,
    );
    expect(validEvent?.cryptoAmount).toBe("10000000000000000000");

    const oversizedBody = validBody.replace(
      "10000000000000000000",
      "100000000000000000000",
    );
    const oversizedEvent = verify(
      oversizedBody,
      signedHeaders(oversizedBody).get("x-nowpayments-sig")!,
    );
    expect(oversizedEvent).not.toBeNull();
    expect(oversizedEvent?.cryptoAmount).toBeNull();
  });

  it("keeps the payment identifier scoped to its status for event deduplication", () => {
    const waitingBody = JSON.stringify({
      payment_status: "waiting",
      payment_id: 123456,
      price_amount: 12.34,
      price_currency: "EUR",
    });
    const finishedBody = waitingBody.replace('"waiting"', '"finished"');
    const waitingSignature =
      signedHeaders(waitingBody).get("x-nowpayments-sig")!;
    const finishedSignature =
      signedHeaders(finishedBody).get("x-nowpayments-sig")!;
    const waiting = verify(waitingBody, waitingSignature);
    const finished = verify(finishedBody, finishedSignature);

    expect(waiting?.eventId).toBe("123456:waiting");
    expect(finished?.eventId).toBe("123456:finished");
    expect(waiting?.eventId).not.toBe(finished?.eventId);
  });

  it("uses only the invoice reference for checkout attribution, not merchant order metadata", () => {
    const body = JSON.stringify({
      payment_status: "finished",
      payment_id: 123456,
      invoice_id: "provider-invoice-abc",
      order_id: "merchant-controlled-order-id",
      price_amount: 12.34,
      price_currency: "EUR",
    });
    const event = verify(body, signedHeaders(body).get("x-nowpayments-sig")!);

    expect(event?.checkoutRef).toBe("provider-invoice-abc");
    expect(
      (event?.rawPayload as Record<string, unknown> | undefined)?.order_id,
    ).toBe("merchant-controlled-order-id");
  });
});
