import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAPER_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Same-origin persist for `navigator.sendBeacon` on unload. The beacon
 * cannot attach Authorization headers; Clerk's session cookie is enough
 * for `auth()`. We forward as PUT to Railway with the user's JWT.
 */
async function persistReadingState(
  request: Request,
  paperId: string,
): Promise<Response> {
  if (!PAPER_ID_RE.test(paperId)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const session = await auth();
  if (!session.userId) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const token = await session.getToken();
  const base =
    process.env.INTERNAL_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || "";
  if (!base || !token) {
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/papers/${paperId}/reading-state`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      return NextResponse.json({ ok: false }, { status: res.status });
    }
    const json = await res.json().catch(() => ({ ok: true }));
    return NextResponse.json(json);
  } catch {
    return NextResponse.json({ ok: false }, { status: 502 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return persistReadingState(request, id);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return persistReadingState(request, id);
}
