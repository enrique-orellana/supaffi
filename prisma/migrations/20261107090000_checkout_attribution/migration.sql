CREATE TABLE "CheckoutAttribution" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerCheckoutRef" VARCHAR(255) NOT NULL,
    "clickId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckoutAttribution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CheckoutAttribution_merchant_provider_ref_key"
    ON "CheckoutAttribution"("merchantId", "provider", "providerCheckoutRef");

CREATE INDEX "CheckoutAttribution_clickId_idx"
    ON "CheckoutAttribution"("clickId");

ALTER TABLE "CheckoutAttribution"
    ADD CONSTRAINT "CheckoutAttribution_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CheckoutAttribution"
    ADD CONSTRAINT "CheckoutAttribution_clickId_merchantId_fkey"
    FOREIGN KEY ("clickId", "merchantId") REFERENCES "Click"("id", "merchantId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
