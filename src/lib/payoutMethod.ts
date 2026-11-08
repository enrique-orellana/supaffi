/**
 * Payout details are one line of text on the affiliate ("PayPal: a@b.com"),
 * because Supaffi moves no money and the owner only needs something to copy.
 * The affiliate picks the method from a short list and types the details it
 * needs; this is the only place that turns the pair into that line and back.
 *
 * Pure, so the client form can use it without reaching the database.
 */

export const PAYOUT_METHODS = {
  paypal: { label: "PayPal", placeholder: "you@example.com" },
  wise: { label: "Wise", placeholder: "you@example.com" },
  bank: { label: "Bank transfer", placeholder: "IBAN or account number" },
  crypto: {
    label: "Crypto",
    placeholder: "Wallet address and network (e.g. USDC on Base)",
  },
  other: { label: "Other", placeholder: "How to pay you" },
} as const;

export type PayoutMethod = keyof typeof PAYOUT_METHODS;

export type CryptoPayoutDestination = {
  coinAndNetwork: string;
  walletAddress: string;
};

/** The stored line for a method and its value. Empty value, empty line. */
export function composePayoutDetails(
  method: PayoutMethod,
  value: string,
): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return method === "other"
    ? trimmed
    : `${PAYOUT_METHODS[method].label}: ${trimmed}`;
}

/** Keep crypto payout instructions readable wherever the merchant sees them. */
export function composeCryptoPayoutDetails({
  coinAndNetwork,
  walletAddress,
}: CryptoPayoutDestination): string {
  const details = [
    coinAndNetwork.trim() && `Coin and network: ${coinAndNetwork.trim()}`,
    walletAddress.trim() && `Wallet address: ${walletAddress.trim()}`,
  ].filter(Boolean);

  return details.length ? `Crypto: ${details.join(" | ")}` : "";
}

/**
 * The method and value a stored line was made from. A line written before the
 * list existed, or one that names no method on it, reads as "other" with the
 * whole line as its value, so nothing an affiliate typed is lost.
 */
export function parsePayoutDetails(stored: string | null | undefined): {
  method: PayoutMethod;
  value: string;
} {
  const line = (stored ?? "").trim();
  for (const [method, { label }] of Object.entries(PAYOUT_METHODS) as [
    PayoutMethod,
    { label: string },
  ][]) {
    if (method === "other") continue;
    const prefix = `${label}:`;
    if (line.toLowerCase().startsWith(prefix.toLowerCase())) {
      return { method, value: line.slice(prefix.length).trim() };
    }
  }
  return { method: line ? "other" : "paypal", value: line };
}

/** Read labeled crypto details and keep older one-field crypto entries usable. */
export function parseCryptoPayoutDetails(
  value: string,
): CryptoPayoutDestination {
  const destination: CryptoPayoutDestination = {
    coinAndNetwork: "",
    walletAddress: "",
  };
  let foundLabeledDetails = false;

  for (const detail of value.split(" | ")) {
    if (detail.startsWith("Coin and network: ")) {
      destination.coinAndNetwork = detail.slice("Coin and network: ".length);
      foundLabeledDetails = true;
    } else if (detail.startsWith("Wallet address: ")) {
      destination.walletAddress = detail.slice("Wallet address: ".length);
      foundLabeledDetails = true;
    }
  }

  if (!foundLabeledDetails && value) destination.walletAddress = value;
  return destination;
}
