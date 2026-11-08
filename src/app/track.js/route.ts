import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  REFERRAL_CLIENT_REFERENCE_PREFIX,
  REFERRAL_COOKIE,
  REFERRAL_QUERY_PARAM,
  REFERRAL_TOKEN_PATTERN,
  REFERRAL_VISIT_COOKIE,
  REFERRAL_VISIT_WINDOW_MS,
} from "@/lib/referral";
import { originFor } from "@/lib/url";
import { listPaymentProviderAdapters } from "@/lib/payments/registry";
import { TRACKING_ENDPOINTS } from "@/lib/trackingEndpoints";

// Served at /supaffi.js (and legacy /track.js) on the Merchant's Supaffi
// domain, embedded on the Merchant's actual site with a plain script tag — a
// third-party script like Google Analytics or Meta Pixel (see CONTEXT.md:
// cookie consent is the Merchant's responsibility, same as any other
// third-party script, not something Supaffi builds a consent API for).
//
// Baking the origin in at serve time, rather than relying on
// document.currentScript, since that only works reliably for a plain,
// synchronously-loaded <script> tag and breaks if the Merchant loads it
// any other way (async, dynamically injected, through a tag manager).
export async function GET(req: NextRequest) {
  // The Host header only selects a Merchant; the origin written into the
  // script comes from that Merchant's stored domain. Pasting request headers
  // into JavaScript let anyone who could influence them (or a cache keyed
  // without them) serve script that runs on a Merchant's site. X-Forwarded-Proto
  // is ignored for the same reason: originFor already knows the scheme.
  const host = req.headers.get("host");
  const merchant = host
    ? await db.merchant.findUnique({
        where: { domain: host },
        select: { id: true, domain: true },
      })
    : null;
  if (!merchant) {
    return new NextResponse(null, { status: 404 });
  }

  const importedLinks = await db.affiliateLink.findMany({
    where: { merchantId: merchant.id, importSourceIdentity: { not: null } },
    select: { legacyQueryParamAliases: true },
  });
  const legacyQueryParamAliases = [
    ...new Set(
      importedLinks.flatMap((link) =>
        link.legacyQueryParamAliases.map((name) => name.toLowerCase()),
      ),
    ),
  ].filter((name) => name !== REFERRAL_QUERY_PARAM.toLowerCase());
  const trackingOrigin = originFor(merchant.domain);
  const referralResolutionUrl = JSON.stringify(
    `${trackingOrigin}${TRACKING_ENDPOINTS.referralResolution}?`,
  );
  const checkoutAttributionUrl = JSON.stringify(
    `${trackingOrigin}${TRACKING_ENDPOINTS.checkoutAttribution}`,
  );
  const supaffiTrackingOrigin = JSON.stringify(trackingOrigin);
  const supaffiTrackingPaths = JSON.stringify(
    Object.values(TRACKING_ENDPOINTS),
  );
  const checkoutTrackingAdapters = JSON.stringify(
    listPaymentProviderAdapters().flatMap((adapter) =>
      adapter.clientTracking
        ? [{ provider: adapter.provider, ...adapter.clientTracking }]
        : [],
    ),
  );
  const legacyParams = JSON.stringify(legacyQueryParamAliases);

  const script = `
(function () {
  var params = new URLSearchParams(window.location.search);
  var attributionParams = new URLSearchParams();
  var code = params.get(${JSON.stringify(REFERRAL_QUERY_PARAM)});
  if (code) attributionParams.set(${JSON.stringify(REFERRAL_QUERY_PARAM)}, code);
  var legacyNames = new Set(${legacyParams});
  params.forEach(function (value, parameter) {
    var normalizedParameter = parameter.toLowerCase();
    if (normalizedParameter !== ${JSON.stringify(REFERRAL_QUERY_PARAM.toLowerCase())} && legacyNames.has(normalizedParameter) && value) {
      attributionParams.append(normalizedParameter, value);
    }
  });

  // The token this browser already holds, read by exact cookie name. Sent
  // back to the referral-resolution endpoint so a reload keeps its Click
  // rather than starting a new referral, and re-read later so a newer
  // affiliate click is picked up.
  function readHeld() {
    var held = document.cookie.split(/;\\s*/).filter(function (c) {
      return c.indexOf(${JSON.stringify(`${REFERRAL_COOKIE}=`)}) === 0;
    })[0];
    return held ? held.slice(${JSON.stringify(`${REFERRAL_COOKIE}=`)}.length) : "";
  }
  var token = readHeld();

  // Persist an idempotency token before the request leaves the browser. If a
  // reload, privacy filter, or proxy hides the response body, this browser can
  // still ask Supaffi to reuse the same Click instead of creating another.
  var visitCookieName = ${JSON.stringify(REFERRAL_VISIT_COOKIE)};
  var visitWindowMs = ${REFERRAL_VISIT_WINDOW_MS};
  var referralTokenPattern = new RegExp(${JSON.stringify(REFERRAL_TOKEN_PATTERN)}, "i");
  function readCookie(name) {
    var entry = document.cookie.split(/;\\s*/).filter(function (c) {
      return c.indexOf(name + "=") === 0;
    })[0];
    if (!entry) return "";
    try { return decodeURIComponent(entry.slice(name.length + 1)); } catch (e) { return ""; }
  }
  function writeCookie(name, value, maxAge) {
    document.cookie = name + "=" + encodeURIComponent(value) +
      "; path=/; max-age=" + maxAge + "; SameSite=Lax" +
      (window.location.protocol === "https:" ? "; Secure" : "");
  }
  function createVisitToken() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
      if (!window.crypto || typeof window.crypto.getRandomValues !== "function") return "";
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      var hex = Array.prototype.map.call(bytes, function (byte) {
        return byte.toString(16).padStart(2, "0");
      }).join("");
      return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
    } catch (e) {
      return "";
    }
  }
  var visitKey = attributionParams.toString();
  function getVisitToken(key) {
    if (!key) return "";
    var now = Date.now();
    function parseVisit(value) {
      try {
        var parsed = JSON.parse(value);
        if (parsed && parsed.key === key && typeof parsed.token === "string" &&
            referralTokenPattern.test(parsed.token) &&
            typeof parsed.createdAt === "number" && now >= parsed.createdAt && now - parsed.createdAt < visitWindowMs) {
          return parsed;
        }
      } catch (e) {}
      return null;
    }
    var saved = [parseVisit(readCookie(visitCookieName))];
    try { saved.push(parseVisit(window.localStorage.getItem(visitCookieName) || "")); } catch (e) {}
    saved = saved.filter(Boolean).sort(function (a, b) { return b.createdAt - a.createdAt; });
    if (saved.length) return saved[0].token;
    var fresh = createVisitToken();
    if (fresh) saveVisitToken(key, fresh);
    return fresh;
  }
  var candidateToken = getVisitToken(visitKey);
  function saveVisitToken(key, value) {
    if (!key || !value) return;
    var state = JSON.stringify({ key: key, token: value, createdAt: Date.now() });
    writeCookie(visitCookieName, state, Math.floor(visitWindowMs / 1000));
    try { window.localStorage.setItem(visitCookieName, state); } catch (e) {}
  }
  // The cookie value last seen or written by this script. A re-read only moves
  // the links when the cookie has changed since, so a fresh token whose cookie
  // write was blocked (or shadowed by a same-named cookie) is not undone by
  // reading back the older value.
  var seen = token;

  // Hosted checkout attribution is registered before the merchant receives
  // its checkout response and can navigate the buyer away. This only records
  // which click opened an invoice; the signed provider IPN remains the sole
  // source of payment status.
  var checkoutAttributionUrl = ${checkoutAttributionUrl};
  var supaffiTrackingOrigin = ${supaffiTrackingOrigin};
  var supaffiTrackingPaths = new Set(${supaffiTrackingPaths});
  var checkoutTrackingAdapters = ${checkoutTrackingAdapters};
  var checkoutAttributionTimeoutMs = 800;

  function isSupaffiTrackingRequest(input) {
    var href = typeof input === "string" ? input : input && input.url;
    if (!href) return false;
    try {
      var requestUrl = new URL(href, window.location.origin);
      return requestUrl.origin === supaffiTrackingOrigin && supaffiTrackingPaths.has(requestUrl.pathname);
    } catch (e) {
      return false;
    }
  }

  function isHttpRequest(input) {
    var href = typeof input === "string" ? input : input && input.url;
    if (!href) return false;
    try {
      var protocol = new URL(href, window.location.origin).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch (e) {
      return false;
    }
  }

  function referenceInUrl(value, adapter) {
    if (typeof value !== "string" || value.length > 2048) return null;
    try {
      var url = new URL(value, window.location.origin);
      if (adapter.allowedHosts.indexOf(url.hostname.toLowerCase()) === -1 || url.pathname !== adapter.path) return null;
      var reference = url.searchParams.get(adapter.referenceQueryParameter);
      return reference && /^[a-z0-9_-]{1,128}$/i.test(reference) ? reference : null;
    } catch (e) {
      return null;
    }
  }

  function findCheckoutReference(value, depth) {
    if (!value || depth > 6) return null;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        var inArray = findCheckoutReference(value[i], depth + 1);
        if (inArray) return inArray;
      }
      return null;
    }
    if (typeof value !== "object") return null;
    for (var a = 0; a < checkoutTrackingAdapters.length; a++) {
      var adapter = checkoutTrackingAdapters[a];
      for (var f = 0; f < adapter.responseUrlFields.length; f++) {
        var reference = referenceInUrl(value[adapter.responseUrlFields[f]], adapter);
        if (reference) return { provider: adapter.provider, checkoutReference: reference };
      }
    }
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      var nested = findCheckoutReference(value[keys[k]], depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  var maxCheckoutResponseBytes = 64 * 1024;

  function reportReaderCancellationError() {
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("Supaffi tracking could not cancel a cloned checkout response reader.");
    }
  }

  function cancelCheckoutReader(reader) {
    if (!reader) return;
    try {
      var cancellation = reader.cancel();
      if (cancellation && typeof cancellation.catch === "function") cancellation.catch(reportReaderCancellationError);
    } catch (e) {
      reportReaderCancellationError();
    }
  }

  function readCheckoutResponseJson(response, onReader, isFinished) {
    var clone;
    try {
      clone = response.clone();
      if (!clone.body || typeof clone.body.getReader !== "function") return Promise.resolve(null);
    } catch (e) {
      return Promise.resolve(null);
    }

    var reader;
    try {
      reader = clone.body.getReader();
      onReader(reader);
    } catch (e) {
      return Promise.resolve(null);
    }

    return new Promise(function (resolve) {
      var settled = false;
      var chunks = [];
      var totalBytes = 0;

      function finish(value) {
        if (settled) return;
        settled = true;
        onReader(null);
        resolve(value);
      }

      function readNext() {
        if (settled) return;
        if (isFinished()) {
          cancelCheckoutReader(reader);
          finish(null);
          return;
        }

        var pendingRead;
        try {
          pendingRead = reader.read();
        } catch (e) {
          finish(null);
          return;
        }

        Promise.resolve(pendingRead).then(function (result) {
          if (settled) return;
          if (isFinished()) {
            cancelCheckoutReader(reader);
            finish(null);
            return;
          }
          if (result.done) {
            try {
              var bytes = new Uint8Array(totalBytes);
              var offset = 0;
              for (var i = 0; i < chunks.length; i++) {
                bytes.set(chunks[i], offset);
                offset += chunks[i].byteLength;
              }
              var payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
              finish(payload);
            } catch (e) {
              finish(null);
            }
            return;
          }

          var chunk = result.value;
          if (!chunk || typeof chunk.byteLength !== "number") {
            cancelCheckoutReader(reader);
            finish(null);
            return;
          }
          totalBytes += chunk.byteLength;
          if (totalBytes > maxCheckoutResponseBytes) {
            cancelCheckoutReader(reader);
            finish(null);
            return;
          }
          chunks.push(chunk);
          readNext();
        }, function () {
          finish(null);
        });
      }

      readNext();
    });
  }

  function registerCheckoutAttribution(reference, referralToken, originalFetch, isFinished) {
    var body;
    try {
      body = JSON.stringify({
        provider: reference.provider,
        checkoutReference: reference.checkoutReference,
        referralToken: referralToken,
      });
    } catch (e) {
      return Promise.resolve();
    }

    return new Promise(function (resolve) {
      var attempts = 0;
      function attempt() {
        if (isFinished() || attempts >= 3) {
          resolve();
          return;
        }
        attempts++;
        var registration;
        try {
          registration = originalFetch.call(window, checkoutAttributionUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body,
            credentials: "omit",
            keepalive: true,
          });
        } catch (e) {
          resolve();
          return;
        }
        Promise.resolve(registration).then(function (response) {
          if (isFinished()) {
            resolve();
            return;
          }
          var status = response && response.status;
          if ((status === 429 || (status >= 500 && status <= 599)) && attempts < 3) {
            attempt();
            return;
          }
          resolve();
        }, resolve);
      }
      attempt();
    });
  }

  function inspectAndRegisterCheckout(response, referralToken, originalFetch) {
    return new Promise(function (resolve) {
      var finished = false;
      var reader = null;
      var timeout = setTimeout(function () {
        if (finished) return;
        finished = true;
        cancelCheckoutReader(reader);
        resolve();
      }, checkoutAttributionTimeoutMs);

      function finish() {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve();
      }

      readCheckoutResponseJson(response, function (activeReader) {
        reader = activeReader;
        if (finished) cancelCheckoutReader(reader);
      }, function () {
        return finished;
      }).then(function (payload) {
        if (finished) return;
        var reference = payload && findCheckoutReference(payload, 0);
        if (!reference) {
          finish();
          return;
        }
        registerCheckoutAttribution(reference, referralToken, originalFetch, function () {
          return finished;
        }).then(finish, finish);
      }, finish);
    });
  }

  // Wrap the ordinary fetch path. Looking only at successful JSON responses
  // and known provider URL formats keeps the script passive for other calls.
  if (typeof window.fetch === "function") {
    var originalFetch = window.fetch;
    window.fetch = function () {
      var args = arguments;
      var input = args[0];
      var init = args[1] || {};
      var method = String(init.method || (input && input.method) || "GET").toUpperCase();
      if (method !== "POST" || !isHttpRequest(input) || isSupaffiTrackingRequest(input)) {
        return originalFetch.apply(this, args);
      }
      return originalFetch.apply(this, args).then(function (response) {
        if (!response || !response.ok || typeof response.clone !== "function") return response;
        var contentType = response.headers && response.headers.get("content-type");
        var mediaType = typeof contentType === "string" ? contentType.split(";")[0].trim().toLowerCase() : "";
        if (mediaType !== "application/json" && !/^application\\/[a-z0-9!#$&^_.+-]+\\+json$/.test(mediaType)) {
          return response;
        }
        var contentLength = response.headers && response.headers.get("content-length");
        var declaredLength = typeof contentLength === "string" ? contentLength.trim() : "";
        if (/^\\d+$/.test(declaredLength) && Number(declaredLength) > 64 * 1024) return response;
        var referralToken = readHeld() || token;
        if (!referralToken) return response;
        return inspectAndRegisterCheckout(response, referralToken, originalFetch).then(function () {
          return response;
        }, function () {
          return response;
        });
      });
    };
  }

  // Checkouts Stripe builds without the Merchant's code (Payment Links, buy
  // buttons, pricing tables) have no place for metadata, so they carry the
  // token in client_reference_id. An empty value counts as absent, and one
  // carrying our prefix is ours to keep current (last click wins). Any other
  // value is the Merchant's own and is never overwritten.
  function tag(el) {
    var name = el.tagName.toLowerCase();
    var ref = ${JSON.stringify(REFERRAL_CLIENT_REFERENCE_PREFIX)} + token;
    function taken(cur) {
      return !!cur && cur.indexOf(${JSON.stringify(REFERRAL_CLIENT_REFERENCE_PREFIX)}) !== 0;
    }
    if (name === "a") {
      var url;
      try { url = new URL(el.href); } catch (e) { return; }
      var cur = url.searchParams.get("client_reference_id");
      if (url.hostname !== "buy.stripe.com" || taken(cur) || cur === ref) return;
      url.searchParams.set("client_reference_id", ref);
      el.href = url.href;
    } else if (name === "stripe-buy-button" || name === "stripe-pricing-table") {
      var attr = el.getAttribute("client-reference-id");
      if (taken(attr) || attr === ref) return;
      // Both components watch this attribute and forward a changed value to
      // their checkout, so setting it is enough even once they have rendered.
      el.setAttribute("client-reference-id", ref);
    }
  }

  function scan(root) {
    if (root.nodeType !== 1) return;
    tag(root);
    var found = root.querySelectorAll('a[href*="buy.stripe.com"], stripe-buy-button, stripe-pricing-table');
    for (var i = 0; i < found.length; i++) tag(found[i]);
  }

  // Picks up a newer click made in another tab since this page loaded.
  function refresh() {
    var t = readHeld();
    if (!t || t === seen) return;
    seen = t;
    if (t === token) return;
    token = t;
    scan(document.documentElement);
  }

  function run(t) {
    if (!t) return;
    token = t;
    scan(document.documentElement);
    // Elements added later (single-page apps, async embeds) get tagged too.
    if (window.MutationObserver) {
      new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          for (var j = 0; j < records[i].addedNodes.length; j++) scan(records[i].addedNodes[j]);
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
    // Coming back to a page left open (or restored from the back button)
    // re-reads the cookie, since a newer affiliate click may have replaced it.
    document.addEventListener("visibilitychange", refresh);
    // A link whose href changed after load still carries the reference.
    ["click", "auxclick"].forEach(function (type) {
      document.addEventListener(type, function (e) {
        refresh();
        for (var n = e.target; n; n = n.parentNode) {
          if (n.nodeType === 1 && n.tagName.toLowerCase() === "a") return tag(n);
        }
      }, true);
    });
  }

  // Without ?via= the held token is all there is. With it, a stable
  // browser token is saved before resolving so reloads reuse the same Click.
  if (!attributionParams.toString()) return run(token);

  var requestToken = candidateToken || token;
  fetch(${referralResolutionUrl} + attributionParams.toString() + (requestToken ? "&token=" + encodeURIComponent(requestToken) : ""))
    .then(function (res) {
      if (!res.ok) return null;
      if (res.status === 204) return candidateToken ? { referralToken: candidateToken } : null;
      return res.json().then(function (data) {
        return data && data.referralToken ? data : (candidateToken ? { referralToken: candidateToken } : null);
      }, function () {
        return candidateToken ? { referralToken: candidateToken } : null;
      });
    })
    .catch(function () { return null; })
    .then(function (data) {
      if (!data || !data.referralToken) return run(token);
      // Keep the original visit start time when the server returns the same
      // token. Repeated refreshes must not extend one click forever.
      if (data.referralToken !== candidateToken) {
        saveVisitToken(visitKey, data.referralToken);
      }
      window.supaffi = window.supaffi || {};
      window.supaffi.referralToken = data.referralToken;
      // A generous fixed client-side lifetime, just so the browser doesn't
      // drop the cookie too early. The Attribution Window itself is
      // enforced server-side against Click.expiresAt when a purchase comes
      // in, not by this cookie's own duration.
      //
      // SameSite=Lax, never None: this cookie is only ever read first-party,
      // by the Merchant's own checkout code on their own domain. Secure is
      // added only over HTTPS, because a Secure cookie on a plain-HTTP dev
      // site is silently dropped and tracking would fail with no error.
       writeCookie(${JSON.stringify(REFERRAL_COOKIE)}, data.referralToken, 60 * 60 * 24 * 90);
      seen = readHeld();
      run(data.referralToken);
    });
})();
`.trim();

  return new NextResponse(script, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Short enough that a changed or removed Merchant domain stops being
      // served within the hour. Vary on Host because one instance answers
      // for every Merchant, and a shared cache must not hand one Merchant's
      // script to another's site.
      "Cache-Control": "public, max-age=300",
      Vary: "Host",
    },
  });
}
