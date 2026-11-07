import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BODY_BYTES, handleRequest } from "../src/index.js";

const env = {
  EXISTING_WEBHOOK_URL: "https://merchant.example/api/webhooks/nowpayments",
  SUPAFFI_WEBHOOK_URL: "https://affiliates.example/api/webhooks/nowpayments/route_12345678",
};

function incoming(body, overrides = {}) {
  return new Request("https://relay.example.workers.dev/", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-nowpayments-sig": "a".repeat(128),
      ...overrides.headers,
    },
    body,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "headers")),
  });
}

test("rejects non-POST requests", async () => {
  let calls = 0;
  const response = await handleRequest(new Request("https://relay.example.workers.dev/"), env, async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(calls, 0);
});

test("rejects a missing provider signature before forwarding", async () => {
  let calls = 0;
  const response = await handleRequest(incoming("{}", { headers: { "x-nowpayments-sig": "" } }), env, async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  });

  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test("rejects non-JSON payloads", async () => {
  const response = await handleRequest(
    incoming("{}", { headers: { "content-type": "text/plain" } }),
    env,
    async () => new Response(null, { status: 200 })
  );

  assert.equal(response.status, 415);
});

test("rejects destinations that are not two distinct HTTPS URLs", async () => {
  for (const invalid of [
    { ...env, EXISTING_WEBHOOK_URL: "http://merchant.example/hook" },
    { ...env, SUPAFFI_WEBHOOK_URL: "https://user:pass@affiliates.example/hook" },
    { ...env, SUPAFFI_WEBHOOK_URL: env.EXISTING_WEBHOOK_URL },
  ]) {
    const response = await handleRequest(incoming("{}"), invalid, async () => new Response(null, { status: 200 }));
    assert.equal(response.status, 503);
  }
});

test("forwards the exact body bytes and original signature to both destinations", async () => {
  const body = '{ "payment_id" : 991, "payment_status" : "finished", "note" : "caffè ☕" }\n';
  const bytes = new TextEncoder().encode(body);
  const destinations = [];
  const response = await handleRequest(incoming(body), env, async (url, init) => {
    destinations.push({ url, init, body: new Uint8Array(init.body) });
    return new Response(null, { status: 200 });
  });

  assert.equal(response.status, 200);
  assert.deepEqual(destinations.map(({ url }) => url).sort(), [env.EXISTING_WEBHOOK_URL, env.SUPAFFI_WEBHOOK_URL].sort());
  for (const destination of destinations) {
    assert.equal(destination.init.method, "POST");
    assert.equal(destination.init.redirect, "manual");
    assert.equal(destination.init.headers.get("x-nowpayments-sig"), "a".repeat(128));
    assert.equal(destination.init.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(destination.body, bytes);
  }
});

test("attempts both destinations and requests a provider retry if either fails", async () => {
  const attempted = [];
  const response = await handleRequest(incoming("{}"), env, async (url) => {
    attempted.push(url);
    return new Response(null, { status: url === env.EXISTING_WEBHOOK_URL ? 204 : 503 });
  });

  assert.equal(response.status, 502);
  assert.deepEqual(attempted.sort(), [env.EXISTING_WEBHOOK_URL, env.SUPAFFI_WEBHOOK_URL].sort());
});

test("returns a retryable response if a destination redirects or throws", async () => {
  let calls = 0;
  const response = await handleRequest(incoming("{}"), env, async (url) => {
    calls += 1;
    if (url === env.SUPAFFI_WEBHOOK_URL) return new Response(null, { status: 307 });
    throw new Error("network error");
  });

  assert.equal(response.status, 502);
  assert.equal(calls, 2);
});

test("rejects oversized streamed bodies without contacting either destination", async () => {
  let calls = 0;
  const response = await handleRequest(incoming("x".repeat(MAX_BODY_BYTES + 1)), env, async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  });

  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});
