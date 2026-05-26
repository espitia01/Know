import { api, type FigureInfo, type OcrImage, type ParsedPaper } from "@/lib/api";

/** Figures for the analysis pane — composite OCR figures when available. */
export function analysisFiguresFromPaper(paper: ParsedPaper | null | undefined): FigureInfo[] {
  if (!paper || paper.ocr_status !== "ready") return [];
  const images = (paper.ocr_images ?? []) as OcrImage[];
  const composites = images.filter((img) => img.kind === "figure");
  let source = composites.length > 0 ? composites : images.filter((img) => img.kind !== "panel");
  if (!source.length && paper.figures?.length) {
    return paper.figures;
  }
  if (!source.length) source = images;
  return source.map((img, idx) => ({
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
