import { NextResponse } from "next/server";

import { AuthError, requireUser } from "@/lib/server/auth";
import { fetchOcrImageStream, InternalApiError } from "@/lib/server/internalApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAPER_ID_RE = /^[a-zA-Z0-9_-]+$/;
const IMAGE_ID_RE = /^(?:p\d+-img-\d+|fig-\d+)\.png$/;

function jsonError(status: number, message: string): Response {
  return NextResponse.json({ detail: message }, { status });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; imageId: string }> },
): Promise<Response> {
  const { id: paperId, imageId } = await params;
  if (!paperId || !PAPER_ID_RE.test(paperId)) return jsonError(400, "Invalid paper id");
  if (!imageId || !IMAGE_ID_RE.test(imageId)) return jsonError(400, "Invalid image id");

  let user: { userId: string };
  try {
    user = await requireUser();
  } catch (e) {
    if (e instanceof AuthError) return jsonError(e.status, e.message);
    return jsonError(401, "Unauthorized");
  }

  try {
    const upstream = await fetchOcrImageStream(paperId, imageId, user.userId);
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "image/png",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (e) {
    if (e instanceof InternalApiError) {
      if (e.status === 404) return jsonError(404, "OCR image not found");
      return jsonError(e.status >= 500 ? 502 : e.status, e.message);
    }
    return jsonError(502, "Could not load OCR image");
  }
}
