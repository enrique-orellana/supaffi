const WINDOW_MS = 10 * 60 * 1000;
const MAX_REGISTRATIONS_PER_ADDRESS = 120;
const MAX_TRACKED = 10_000;

type AddressWindow = { count: number; windowStartedAt: number };

const globalForThrottle = globalThis as unknown as {
  supaffiCheckoutAttributionAddresses?: Map<string, AddressWindow>;
};

const addresses =
  globalForThrottle.supaffiCheckoutAttributionAddresses ??
  new Map<string, AddressWindow>();
if (process.env.NODE_ENV !== "production") {
  globalForThrottle.supaffiCheckoutAttributionAddresses = addresses;
}

function keyFor(merchantId: string, address: string): string {
  return `${merchantId}\0${address}`;
}

function trimOldest(): void {
  while (addresses.size > MAX_TRACKED) {
    const oldest = addresses.keys().next();
    if (oldest.done) break;
    addresses.delete(oldest.value);
  }
}

export function isCheckoutAttributionLimited(
  merchantId: string,
  address: string,
  now: number = Date.now(),
): boolean {
  const window = addresses.get(keyFor(merchantId, address));
  return Boolean(
    window &&
    now - window.windowStartedAt < WINDOW_MS &&
    window.count >= MAX_REGISTRATIONS_PER_ADDRESS,
  );
}

export function rememberCheckoutAttribution(
  merchantId: string,
  address: string,
  now: number = Date.now(),
): void {
  const key = keyFor(merchantId, address);
  const window = addresses.get(key);
  if (window && now - window.windowStartedAt < WINDOW_MS) {
    window.count += 1;
  } else {
    addresses.delete(key);
    addresses.set(key, { count: 1, windowStartedAt: now });
    trimOldest();
  }
}

/** Test seam. */
export function resetCheckoutAttributionThrottle(): void {
  addresses.clear();
}
