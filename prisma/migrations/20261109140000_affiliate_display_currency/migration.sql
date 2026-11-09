ALTER TABLE "Program"
ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'eur';

ALTER TABLE "Affiliate"
ADD COLUMN "displayCurrency" VARCHAR(3);
