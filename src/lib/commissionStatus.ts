import type { CommissionStatus as PrismaCommissionStatus } from "@prisma/client";

/**
 * Shared commission status values for application logic and UI.
 *
 * The Prisma type keeps this list aligned with the database enum at compile
 * time, while this lightweight module remains safe to import from client UI.
 */
export const COMMISSION_STATUS = {
  PENDING: "PENDING",
  FLAGGED: "FLAGGED",
  PAYABLE: "PAYABLE",
  PAID: "PAID",
  VOIDED: "VOIDED",
} as const satisfies { [Status in PrismaCommissionStatus]: Status };

export type CommissionStatus = PrismaCommissionStatus;

export const COMMISSION_STATUSES = [
  COMMISSION_STATUS.PENDING,
  COMMISSION_STATUS.PAYABLE,
  COMMISSION_STATUS.FLAGGED,
  COMMISSION_STATUS.PAID,
  COMMISSION_STATUS.VOIDED,
] as const satisfies readonly CommissionStatus[];

export const AFFILIATE_COMMISSION_STATUSES = [
  COMMISSION_STATUS.PENDING,
  COMMISSION_STATUS.PAYABLE,
  COMMISSION_STATUS.PAID,
  COMMISSION_STATUS.VOIDED,
] as const satisfies readonly Exclude<
  CommissionStatus,
  typeof COMMISSION_STATUS.FLAGGED
>[];

export type AffiliateCommissionStatus =
  (typeof AFFILIATE_COMMISSION_STATUSES)[number];

export const PENDING_OR_FLAGGED_COMMISSION_STATUSES: readonly CommissionStatus[] =
  [COMMISSION_STATUS.PENDING, COMMISSION_STATUS.FLAGGED];

export const UNPAID_COMMISSION_STATUSES: readonly CommissionStatus[] = [
  COMMISSION_STATUS.PENDING,
  COMMISSION_STATUS.PAYABLE,
  COMMISSION_STATUS.FLAGGED,
];
