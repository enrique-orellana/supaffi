export const MAX_BODY_BYTES = 64 * 1024;
const DOWNSTREAM_TIMEOUT_MS = 2500;

function configuredDestination(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function getDestinations(env) {
  if (!env || typeof env !== "object") return null;
  const merchant = configuredDestination(env.EXISTING_WEBHOOK_URL);
  const supaffi = configuredDestination(env.SUPAFFI_WEBHOOK_URL);
  if (!merchant || !supaffi || merchant === supaffi) return null;
  return [merchant, supaffi];
}

async function readBoundedBody(request) {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return { error: 400 };
    if (Number(contentLength) > MAX_BODY_BYTES) return { error: 413 };
  }

  if (!request.body) return { error: 400 };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return { error: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { error: 400 };
  } finally {
    reader.releaseLock();
  }

  if (size === 0) return { error: 400 };
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body };
}

function errorResponse(status, headers = {}) {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

/**
 * Forward an unmodified provider notification to both configured systems.
 * The receiving systems validate the original NOWPayments signature. This
 * Worker deliberately has no NOWPayments API key or IPN secret.
 */
export async function handleRequest(request, env, fetchFn = fetch) {
  if (request.method !== "POST") {
    return errorResponse(405, { allow: "POST" });
  }

  const contentType = request.headers.get("content-type");
  if (
    !contentType ||
    contentType.split(";")[0].trim().toLowerCase() !== "application/json"
  ) {
    return errorResponse(415);
  }

  const signature = request.headers.get("x-nowpayments-sig");
  if (!signature || signature.length > 512) return errorResponse(400);

  const destinations = getDestinations(env);
  if (!destinations) return errorResponse(503);

  const { body, error } = await readBoundedBody(request);
  if (error) return errorResponse(error);

  const headers = new Headers({
    "content-type": contentType,
    "x-nowpayments-sig": signature,
  });
  const signal = AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS);
  const results = await Promise.allSettled(
    destinations.map(async (destination) => {
      const response = await fetchFn(destination, {
        method: "POST",
        headers: new Headers(headers),
        body: body.slice(),
        cache: "no-store",
        redirect: "manual",
        signal,
      });
      return response.ok;
    }),
  );

  if (
    results.some((result) => result.status !== "fulfilled" || !result.value)
  ) {
    // Never include destination URLs, response bodies, or the provider
    // signature in logs or in the response sent back to NOWPayments.
    return errorResponse(502);
  }

  return errorResponse(200);
}

const worker = {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};

export default worker;
