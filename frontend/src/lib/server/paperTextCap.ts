import "server-only";

/** Max OCR chars loaded into stream routes — avoids Vercel heap OOM. */
export const MAX_PAPER_RAW_CHARS = 80_000;

export function capPaperRawText(raw: string | null | undefined): string {
  if (!raw) return "";
  if (raw.length <= MAX_PAPER_RAW_CHARS) return raw;
  return raw.slice(0, MAX_PAPER_RAW_CHARS);
}
