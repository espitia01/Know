import { api } from "@/lib/api";

/** Hash links through the App Router often drop `#pricing`. Use a full assign. */
export function goToPricing() {
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/") {
    window.history.replaceState(null, "", "/#pricing");
    document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  window.location.assign("/#pricing");
}

export async function startCheckout(tier: string): Promise<string> {
  const origin = window.location.origin;
  const { url } = await api.createCheckoutSession(
    tier,
    `${origin}/dashboard?upgraded=1`,
    `${origin}/#pricing`,
  );
  if (!url) throw new Error("Checkout did not return a URL.");
  return url;
}
