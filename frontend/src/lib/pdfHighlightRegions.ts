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

export type RectLike = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type MergeRectsOptions = {
  lineTolerance?: number;
  gapTolerance?: number;
  horizontalPadding?: number;
};

function applyHorizontalPadding(rect: RectLike, pad: number): RectLike {
  if (pad <= 0) return rect;
  return {
    left: rect.left - pad,
    top: rect.top,
    width: rect.width + pad * 2,
    height: rect.height,
  };
}

/** Merge word-fragment client rects into one wide box per text line. */
export function mergeRectsToLineGroups(
  rects: RectLike[],
  opts: MergeRectsOptions = {},
): RectLike[] {
  const gapTolerance = opts.gapTolerance ?? 6;
  const horizontalPadding = opts.horizontalPadding ?? 1;
  const filtered = rects.filter((r) => r.width > 0.5 && r.height > 0.5);
  if (filtered.length === 0) return [];

  const heights = filtered.map((r) => r.height).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] ?? 12;
  const lineTolerance = opts.lineTolerance ?? Math.max(2, medianH * 0.4);

  const buckets: Array<{ midY: number; rects: RectLike[] }> = [];
  for (const rect of filtered) {
    const midY = rect.top + rect.height / 2;
    let bucket = buckets.find((b) => Math.abs(b.midY - midY) <= lineTolerance);
    if (!bucket) {
      bucket = { midY, rects: [] };
      buckets.push(bucket);
    }
    bucket.rects.push(rect);
  }

  const merged: RectLike[] = [];
  for (const bucket of buckets) {
    bucket.rects.sort((a, b) => a.left - b.left);
    let current = { ...bucket.rects[0]! };
    for (let i = 1; i < bucket.rects.length; i += 1) {
      const next = bucket.rects[i]!;
      const gap = next.left - (current.left + current.width);
      if (gap <= gapTolerance) {
        const right = Math.max(current.left + current.width, next.left + next.width);
        const top = Math.min(current.top, next.top);
        const bottom = Math.max(current.top + current.height, next.top + next.height);
        current = {
          left: current.left,
          top,
          width: right - current.left,
          height: bottom - top,
        };
      } else {
        merged.push(applyHorizontalPadding(current, horizontalPadding));
        current = { ...next };
      }
    }
    merged.push(applyHorizontalPadding(current, horizontalPadding));
  }

  return merged;
}

/** Merge pct regions that belong to the same line on a page. */
export function mergePctRegionsToLineGroups(
  regions: CapturedHighlightRegion[],
): CapturedHighlightRegion[] {
  const byPage = new Map<number, CapturedHighlightRegion[]>();
  for (const region of regions) {
    const list = byPage.get(region.pageNum) ?? [];
    list.push(region);
    byPage.set(region.pageNum, list);
  }

  const out: CapturedHighlightRegion[] = [];
  for (const [pageNum, pageRegions] of byPage) {
    const asRects: RectLike[] = pageRegions.map((r) => ({
      left: r.xPct,
      top: r.yPct,
      width: r.wPct,
      height: r.hPct,
    }));
    const merged = mergeRectsToLineGroups(asRects, { horizontalPadding: 0 });
    for (const rect of merged) {
      out.push({
        pageNum,
        xPct: Math.max(0, rect.left),
        yPct: Math.max(0, rect.top),
        wPct: Math.max(0, rect.width),
        hPct: Math.max(0, rect.height),
      });
    }
  }
  return out;
}

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
  const rawRects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
  if (rawRects.length === 0) return [];

  const pages =
    container?.querySelectorAll<HTMLElement>(".react-pdf__Page[data-page-number]") ?? [];

  type PendingRect = RectLike & { pageNum: number; pw: number; ph: number; scaleX: number; scaleY: number };
  const pending: PendingRect[] = [];

  for (const r of rawRects) {
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

    if (pageEl) {
      const pw = pageEl.offsetWidth;
      const ph = pageEl.offsetHeight;
      if (pw <= 0 || ph <= 0) continue;
      const pageRect = pageEl.getBoundingClientRect();
      const scaleX = pw / (pageRect.width || pw);
      const scaleY = ph / (pageRect.height || ph);
      pending.push({
        left: (r.left - pageRect.left) * scaleX,
        top: (r.top - pageRect.top) * scaleY,
        width: r.width * scaleX,
        height: r.height * scaleY,
        pageNum,
        pw,
        ph,
        scaleX,
        scaleY,
      });
      continue;
    }

    if (!container) continue;
    const est = pageBoxFromScroll(container, cy, opts);
    if (!est) continue;
    const containerRect = container.getBoundingClientRect();
    const xDoc = container.scrollLeft + (r.left - containerRect.left);
    const x = Math.max(0, Math.min(est.pw, xDoc));
    pending.push({
      left: x,
      top: Math.max(0, est.y),
      width: Math.min(r.width, est.pw - x),
      height: r.height,
      pageNum: est.pageNum,
      pw: est.pw,
      ph: est.ph,
      scaleX: 1,
      scaleY: 1,
    });
  }

  const byPage = new Map<number, PendingRect[]>();
  for (const item of pending) {
    const list = byPage.get(item.pageNum) ?? [];
    list.push(item);
    byPage.set(item.pageNum, list);
  }

  const out: CapturedHighlightRegion[] = [];
  for (const [pageNum, pageRects] of byPage) {
    const merged = mergeRectsToLineGroups(
      pageRects.map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height })),
    );
    const sample = pageRects[0]!;
    for (const rect of merged) {
      out.push({
        pageNum,
        xPct: rect.left / sample.pw,
        yPct: rect.top / sample.ph,
        wPct: rect.width / sample.pw,
        hPct: rect.height / sample.ph,
      });
    }
  }

  return mergePctRegionsToLineGroups(out);
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
