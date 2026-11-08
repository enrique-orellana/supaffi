import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const IPV4_NON_PUBLIC = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
] as const;

function ipv4Bytes(value: string): number[] | null {
  const pieces = value.split(".");
  if (pieces.length !== 4) return null;
  const bytes = pieces.map((piece) =>
    /^\d{1,3}$/.test(piece) ? Number(piece) : -1,
  );
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
}

function matchesIpv4Prefix(
  address: number[],
  prefix: readonly [readonly number[], number],
): boolean {
  const [network, bits] = prefix;
  let remaining = bits;
  for (let index = 0; index < 4; index += 1) {
    const width = Math.min(8, remaining);
    if (width === 0) return true;
    const mask = (0xff << (8 - width)) & 0xff;
    if ((address[index] & mask) !== (network[index] & mask)) return false;
    remaining -= width;
  }
  return true;
}

function ipv6Bytes(value: string): number[] | null {
  let address = value.toLowerCase();
  if (address.includes("%")) return null;
  const embeddedIpv4 = address.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embeddedIpv4) {
    const bytes = ipv4Bytes(embeddedIpv4[1]);
    if (!bytes) return null;
    const first = ((bytes[0] << 8) | bytes[1]).toString(16);
    const second = ((bytes[2] << 8) | bytes[3]).toString(16);
    address =
      address.slice(0, address.length - embeddedIpv4[1].length) +
      `${first}:${second}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[\da-f]{1,4}$/.test(part)))
    return null;
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  )
    return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) =>
    Number.parseInt(part, 16),
  );
  if (groups.length !== 8) return null;
  return groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const bytes = ipv4Bytes(address);
    return Boolean(
      bytes &&
      !IPV4_NON_PUBLIC.some((prefix) => matchesIpv4Prefix(bytes, prefix)),
    );
  }
  if (version !== 6) return false;

  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  const startsWith = (prefix: number[], length: number) => {
    for (let index = 0; index < Math.ceil(length / 8); index += 1) {
      const width = Math.min(8, length - index * 8);
      const mask = (0xff << (8 - width)) & 0xff;
      if ((bytes[index] & mask) !== (prefix[index] & mask)) return false;
    }
    return true;
  };

  const loopback =
    bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const ipv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  const globallyRoutableUnicast = startsWith([0x20, 0x00], 3);
  const reservedOrTunneled =
    startsWith([0x20, 0x01, 0x0d, 0xb8], 32) || // documentation
    startsWith([0x20, 0x01, 0x00, 0x00], 23) || // protocol assignments and special use
    startsWith([0x20, 0x01, 0x00, 0x02], 48) || // benchmarking
    startsWith([0x20, 0x02], 16) || // 6to4 embeds an IPv4 route
    startsWith([0x00, 0x64, 0xff, 0x9b], 32) || // NAT64
    startsWith([0x3f, 0xff], 20); // documentation

  if (!globallyRoutableUnicast || reservedOrTunneled || ipv4Mapped || loopback)
    return false;
  // Global unicast is 2000::/3; reject its remaining special-purpose ranges.
  if (
    startsWith([0x20, 0x01, 0x00, 0x10], 28) ||
    startsWith([0x20, 0x01, 0x00, 0x20], 28)
  )
    return false;
  return true;
}

/**
 * Normalize an HTTPS URL only when its literal host and every current DNS
 * answer are public routable addresses. Callers that later make a request
 * must repeat this check at delivery time and must not follow redirects.
 */
export async function publicHttpsUrl(value: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password
  )
    return null;
  if (url.hash) return null;

  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return null;
  }
  const version = isIP(hostname);
  if (version) return isPublicAddress(hostname) ? url.toString() : null;
  if (!hostname.includes(".") || hostname.endsWith(".internal")) return null;

  let answers: { address: string; family: number }[];
  try {
    answers = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return null;
  }
  if (
    answers.length === 0 ||
    answers.some(({ address }) => !isPublicAddress(address))
  )
    return null;
  return url.toString();
}
