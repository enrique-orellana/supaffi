export const TRACKING_ENDPOINTS = {
  referralResolution: "/api/resolve",
  checkoutAttribution: "/api/checkout/attribution",
} as const;

/** Public script URL; avoid generic tracking path names filtered by browsers. */
export const TRACKING_SCRIPT_PATH = "/supaffi.js";
