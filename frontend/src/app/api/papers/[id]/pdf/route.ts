import { NextResponse } from "next/server";

import { AuthError, requireUser } from "@/lib/server/auth";
import { fetchPaperContext, fetchPaperPdfStream, InternalApiError } from "@/lib/server/internalApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAPER_ID_RE = /^[a-zA-Z0-9_-]+$/;

function jsonError(status: number, message: string): Response {
  return NextResponse.json({ detail: message }, { status });
}

function safeFilename(title: string | undefined, paperId: string): string {
  const base = (title || paperId).replace(/[^\w\s.-]+/g, "").trim() || paperId;
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: paperId } = await params;
  if (!paperId || !PAPER_ID_RE.test(paperId)) {
    return jsonError(400, "Invalid paper id");
  }

  let user: { userId: string };
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return jsonError(e.status, e.message);
    return jsonError(401, "Unauthorized");
  }

  let title = paperId;
  try {
    const ctx = await fetchPaperContext(paperId, user.userId);
    title = ctx.title || paperId;
  } catch {
    /* title is cosmetic for Content-Disposition */
  }

  try {
    const upstream = await fetchPaperPdfStream(paperId, user.userId);
    const filename = safeFilename(title, paperId);
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/pdf",
        "Content-Disposition": `inline; filename="${filename.replace(/"/g, "")}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof InternalApiError) {
      if (e.status === 404) return jsonError(404, "PDF not found");
      return jsonError(e.status >= 500 ? 502 : e.status, e.message);
    }
    return jsonError(502, "Could not load PDF");
  }
}
