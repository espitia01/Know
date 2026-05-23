import type { PdfRegionHighlight } from "@/lib/store";

export type CapturedHighlightRegion = Omit<
  PdfRegionHighlight,
  "id" | "color" | "highlightId"
>;

export type CaptureHighlightOptions = {
  numPages?: number;
  /** Page height + gap in px (matches PdfViewer virtualized layout). */
  pageStride?: number;
  pageGap?: number;
};

function pageBoxFromScroll(
  container: HTMLElement,
  clientY: number,
  opts: CaptureHighlightOptions,
): { pageNum: number; x: number; y: number; w: number; h: number; pw: number; ph: number } | null {
  const numPages = opts.numPages ?? 0;
  const pageGap = opts.pageGap ?? 16;
  const stride = opts.pageStride ?? 0;
  if (numPages <= 0 || stride <= pageGap) return null;

  const pageH = stride - pageGap;
  const containerRect = container.getBoundingClientRect();
  const yInDoc = container.scrollTop + (clientY - containerRect.top);
  const pageNum = Math.max(1, Math.min(numPages, Math.floor(yInDoc / stride) + 1));
  const pageTop = (pageNum - 1) * stride;
  const yOnPage = yInDoc - pageTop;

  const pages = container.querySelectorAll<HTMLElement>(".react-pdf__Page[data-page-number]");
  let pw = 0;
  for (const el of pages) {
    if (parseInt(el.getAttribute("data-page-number") || "0", 10) === pageNum) {
      pw = el.offsetWidth;
      break;
    }
  }
  if (pw <= 0) {
    const first = pages[0] as HTMLElement | undefined;
    pw = first?.offsetWidth ?? container.clientWidth;
  }
  const ph = pageH;
  return { pageNum, x: 0, y: yOnPage, w: pw, h: 0, pw, ph };
}

/** Map each line rect in the current DOM selection to normalized page-local boxes. */
export function captureTextSelectionRegions(
  container: HTMLElement | null,
  opts: CaptureHighlightOptions = {},
): CapturedHighlightRegion[] {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];

  const range = sel.getRangeAt(0);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
  if (rects.length === 0) return [];

  const pages =
    container?.querySelectorAll<HTMLElement>(".react-pdf__Page[data-page-number]") ?? [];

  const out: CapturedHighlightRegion[] = [];
  for (const r of rects) {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    let pageEl: HTMLElement | null = null;
    let pageNum = 1;
    for (const el of pages) {
      const pr = el.getBoundingClientRect();
      if (cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom) {
        pageEl = el;
        pageNum = parseInt(el.getAttribute("data-page-number") || "1", 10);
        break;
      }
    }

    let pw = 0;
    let ph = 0;
    let x = 0;
    let y = 0;

    if (pageEl) {
      pw = pageEl.offsetWidth;
      ph = pageEl.offsetHeight;
      if (pw <= 0 || ph <= 0) continue;
      const pageRect = pageEl.getBoundingClientRect();
      const scaleX = pw / (pageRect.width || pw);
      const scaleY = ph / (pageRect.height || ph);
      x = (r.left - pageRect.left) * scaleX;
      y = (r.top - pageRect.top) * scaleY;
      out.push({
        pageNum,
        xPct: x / pw,
        yPct: y / ph,
        wPct: (r.width * scaleX) / pw,
        hPct: (r.height * scaleY) / ph,
      });
      continue;
    }

    // Virtualized pages: estimate page-local box from scroll + stride.
    if (!container) continue;
    const est = pageBoxFromScroll(container, cy, opts);
    if (!est) continue;
    pw = est.pw;
    ph = est.ph;
    const containerRect = container.getBoundingClientRect();
    const xDoc = container.scrollLeft + (r.left - containerRect.left);
    x = Math.max(0, Math.min(pw, xDoc));
    const yOnPage = est.y;
    out.push({
      pageNum: est.pageNum,
      xPct: x / pw,
      yPct: Math.max(0, yOnPage) / ph,
      wPct: Math.min(r.width, pw - x) / pw,
      hPct: r.height / ph,
    });
  }
  return out;
}

export function pageRangeForSelectionRect(
  container: HTMLElement,
  rect: DOMRect,
  opts: CaptureHighlightOptions,
): { start: number; end: number } | null {
  const numPages = opts.numPages ?? 0;
  const pageGap = opts.pageGap ?? 16;
  const stride = opts.pageStride ?? 0;
  if (numPages <= 0 || stride <= pageGap) return null;

  const containerRect = container.getBoundingClientRect();
  const topDoc = container.scrollTop + (rect.top - containerRect.top);
  const bottomDoc = container.scrollTop + (rect.bottom - containerRect.top);
  const start = Math.max(1, Math.floor(topDoc / stride) + 1);
  const end = Math.min(numPages, Math.floor(bottomDoc / stride) + 1);
  return { start, end };
}
