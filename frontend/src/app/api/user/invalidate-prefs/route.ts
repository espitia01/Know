import { NextResponse } from "next/server";

import { AuthError, requireUser } from "@/lib/server/auth";
import { invalidateUserPrefs } from "@/lib/server/userPrefs";

/** Bust the 60s server-side prefs cache after Settings saves on Python. */
export async function POST() {
  try {
    const user = await requireUser();
    invalidateUserPrefs(user.userId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to invalidate prefs" }, { status: 500 });
  }
}
