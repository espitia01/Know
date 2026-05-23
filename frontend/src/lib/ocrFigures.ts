import { api, type FigureInfo, type ParsedPaper } from "@/lib/api";

export interface OcrImage {
  id: string;
  page: number;
  bbox?: number[] | null;
  caption?: string;
}

/** Figures for the analysis pane — Mistral OCR crops only. */
export function analysisFiguresFromPaper(paper: ParsedPaper | null | undefined): FigureInfo[] {
  if (!paper || paper.ocr_status !== "ready") return [];
  const images = (paper.ocr_images ?? []) as OcrImage[];
  return images.map((img, idx) => ({
    id: img.id,
    url: api.getOcrImageUrl(paper.id, img.id),
    caption: img.caption?.trim() || `Figure ${idx + 1} · page ${img.page + 1}`,
    page: img.page,
  }));
}

export function figurePreviewUrl(paperId: string, figureId: string, ocrStatus?: string): string {
  if (ocrStatus === "ready") {
    return api.getOcrImageUrl(paperId, figureId);
  }
  return api.getFigureUrl(paperId, figureId);
}

export function ocrFiguresPending(paper: ParsedPaper | null | undefined): boolean {
  if (!paper) return true;
  const status = paper.ocr_status ?? "pending";
  return status !== "ready" && status !== "unsupported";
}
