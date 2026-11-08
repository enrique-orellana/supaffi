import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createLocalRelayServer } from "../local-dev-relay.mjs";

const servers = new Set();

async function listen(server) {
  servers.add(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) => new Promise((resolve) => server.close(resolve)),
    ),
  );
  servers.clear();
});

test("local relay forwards exact signed JSON to both loopback receivers", async () => {
  const payload = Buffer.from(
    '{"payment_status":"finished","order_id":"qa-42"}',
  );
  const signature = "original-provider-signature";
  const calls = [];
  const server = createLocalRelayServer({
    env: {
      EXISTING_WEBHOOK_URL:
        "http://127.0.0.1:18282/webhooks/billing/nowpayments",
      SUPAFFI_WEBHOOK_URL:
        "http://localhost:3000/api/webhooks/nowpayments/qa-connection",
    },
    fetchFn: async (url, options) => {
      calls.push({ url, options, body: Buffer.from(options.body) });
      return new Response(null, { status: 204 });
    },
  });
  const baseUrl = await listen(server);

  const response = await fetch(`${baseUrl}/ipn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nowpayments-sig": signature,
    },
    body: payload,
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.body, payload);
    assert.equal(call.options.headers["x-nowpayments-sig"], signature);
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.redirect, "manual");
  }
});

test("local relay refuses non-loopback destinations", async () => {
  let called = false;
  const server = createLocalRelayServer({
    env: {
      EXISTING_WEBHOOK_URL:
        "http://127.0.0.1:18282/webhooks/billing/nowpayments",
      SUPAFFI_WEBHOOK_URL:
        "https://external.example/api/webhooks/nowpayments/qa-connection",
    },
    fetchFn: async () => {
      called = true;
      return new Response(null, { status: 204 });
    },
  });
  const baseUrl = await listen(server);

  const response = await fetch(`${baseUrl}/ipn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nowpayments-sig": "signature",
    },
    body: "{}",
  });

  assert.equal(response.status, 503);
  assert.equal(called, false);
});

test("local relay exposes only its one POST route", async () => {
  const server = createLocalRelayServer({ env: {} });
  const baseUrl = await listen(server);

  assert.equal((await fetch(`${baseUrl}/`, { method: "POST" })).status, 404);
  const methodResponse = await fetch(`${baseUrl}/ipn`);
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get("allow"), "POST");
});
