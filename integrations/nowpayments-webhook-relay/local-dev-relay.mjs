import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_BODY_BYTES = 64 * 1024;
const DOWNSTREAM_TIMEOUT_MS = 10_000;
const PORT = Number(process.env.LOCAL_RELAY_PORT ?? "8787");

function localDestination(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.hash
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

function destinations(env) {
  const merchant = localDestination(env?.EXISTING_WEBHOOK_URL);
  const supaffi = localDestination(env?.SUPAFFI_WEBHOOK_URL);
  if (!merchant || !supaffi || merchant === supaffi) return null;
  return [merchant, supaffi];
}

function reply(response, status) {
  response.writeHead(status, { "cache-control": "no-store" });
  response.end();
}

async function readBoundedBody(request) {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) return { error: 400 };
    if (Number(contentLength) > MAX_BODY_BYTES) return { error: 413 };
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) return { error: 413 };
      chunks.push(chunk);
    }
  } catch {
    return { error: 400 };
  }
  if (!size) return { error: 400 };
  return { body: Buffer.concat(chunks, size) };
}

export function createLocalRelayServer({ env = process.env, fetchFn = fetch } = {}) {
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== "/ipn") return reply(response, 404);
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return reply(response, 405);
    }

    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return reply(response, 415);
    }
    const signature = request.headers["x-nowpayments-sig"];
    if (typeof signature !== "string" || !signature || signature.length > 512) {
      return reply(response, 400);
    }

    const targets = destinations(env);
    if (!targets) return reply(response, 503);

    const { body, error } = await readBoundedBody(request);
    if (error) return reply(response, error);

    const options = {
      method: "POST",
      headers: {
        "content-type": contentType,
        "x-nowpayments-sig": signature,
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNSTREAM_TIMEOUT_MS),
    };
    const results = await Promise.allSettled(targets.map((url) => fetchFn(url, {
      ...options,
      body: Buffer.from(body),
    })));
    if (results.some((result) => result.status !== "fulfilled" || !result.value.ok)) {
      return reply(response, 502);
    }
    return reply(response, 200);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createLocalRelayServer();
  server.listen(PORT, "127.0.0.1", () => {
    process.stdout.write(`Local IPN relay listening on 127.0.0.1:${PORT}/ipn\n`);
  });
}
