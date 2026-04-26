// ============================================================
// Volteux — Adafruit cart URL builder (U8)
// ============================================================
// Build an Adafruit wishlist URL from the project's component SKUs so the
// "Buy on Adafruit" button opens a curated list the user can add to cart.
//
// URL pattern (confirmed by Talia 2026-04-26):
//   https://www.adafruit.com/wishlists/?wl_name=<label>&q=<comma-sku-list>
//
// v0: no affiliate ID (deferred to v1.5 per docs/PLAN.md).

import type { VolteuxProjectDocument } from "../../../schemas/document.zod";

const ADAFRUIT_WISHLIST = "https://www.adafruit.com/wishlists/";

/**
 * Build an Adafruit wishlist URL from the project's component SKUs.
 * Adafruit's wishlist accepts ?wl_name=<label>&q=<comma-sku-list>;
 * the page renders the SKUs as a curated list the user can add to cart.
 *
 * v0: no affiliate ID (deferred to v1.5 per docs/PLAN.md).
 */
export function cartUrl(doc: VolteuxProjectDocument): string {
  const skus = doc.components
    .map((c) => c.sku)
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(",");
  const params = new URLSearchParams({
    wl_name: "Volteux",
    q: skus,
  });
  return `${ADAFRUIT_WISHLIST}?${params.toString()}`;
}
