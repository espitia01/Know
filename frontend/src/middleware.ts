import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/try(.*)",
  "/terms(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (req.nextUrl.pathname === "/" && (await auth()).userId) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }
  // API routes self-authenticate via requireUser() / their own bearer
  // checks (e.g. CRON_SECRET, internal HMAC). Middleware-level
  // auth.protect() would 302 every unauthenticated curl/cron/health
  // probe to /sign-in, which breaks /api/health/llm, the upcoming
  // /api/papers/* streaming routes, and /api/cron/* — all of which
  // have no business living inside a sign-in redirect chain.
  if (req.nextUrl.pathname.startsWith("/api/")) return;
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
