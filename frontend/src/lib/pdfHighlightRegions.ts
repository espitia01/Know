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

/** Paint/capture coordinate frame for one mounted pdf.js page. */
export type PageHighlightMetrics = {
  pageNum: number;
  /** Offset of the text layer within `.react-pdf__Page` (overlay parent). */
  originX: number;
  originY: number;
  /** Text-layer width/height used for pct → px conversion. */
  pw: number;
  ph: number;
};

let activeCaptureContext: {
  container: HTMLElement;
  opts: CaptureHighlightOptions;
} | null = null;

/** PdfViewer registers its scroll container + layout opts for action-time re-capture. */
export function registerPdfHighlightCaptureContext(
  ctx: { container: HTMLElement; opts: CaptureHighlightOptions } | null,
): void {
  activeCaptureContext = ctx;
}

/** Re-capture pct regions from the live selection (toolbar action click). */
export function captureCurrentTextSelectionRegions(): CapturedHighlightRegion[] {
  if (!activeCaptureContext) return [];
  return captureTextSelectionRegions(activeCaptureContext.container, activeCaptureContext.opts);
}

/**
 * Last-resort: convert a single viewport rect (e.g. the toolbar's anchor rect)
 * into pct regions on whichever page intersects it. Used when text-layer
 * capture comes back empty so explain/derive/highlight always carry geometry.
 */
export function rectToRegions(
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number },
): CapturedHighlightRegion[] {
  if (!activeCaptureContext) return [];
  const container = activeCaptureContext.container;
  const pages = container.querySelectorAll<HTMLElement>(
    ".react-pdf__Page[data-page-number]",
  );
  if (pages.length === 0) return [];

  const out: CapturedHighlightRegion[] = [];
  const synthetic = new DOMRect(rect.left, rect.top, rect.width, rect.height);
  for (const pageEl of pages) {
    const pageRect = pageEl.getBoundingClientRect();
    if (rectIntersectionArea(synthetic, pageRect) <= 0) continue;
    const frame = getPageHighlightMetrics(pageEl);
    if (frame.pw <= 0 || frame.ph <= 0) continue;
    const left = Math.max(rect.left, frame.refRect.left);
    const top = Math.max(rect.top, frame.refRect.top);
    const right = Math.min(rect.right, frame.refRect.right);
    const bottom = Math.min(rect.bottom, frame.refRect.bottom);
    if (right <= left || bottom <= top) continue;
    out.push({
      pageNum: frame.pageNum,
      xPct: Math.max(0, (left - frame.refRect.left) / frame.pw),
      yPct: Math.max(0, (top - frame.refRect.top) / frame.ph),
      wPct: Math.max(0, (right - left) / frame.pw),
      hPct: Math.max(0, (bottom - top) / frame.ph),
    });
  }
  return out;
}

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

function rectIntersectionArea(a: DOMRectReadOnly, b: DOMRectReadOnly): number {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  const w = right - left;
  const h = bottom - top;
  return w > 0 && h > 0 ? w * h : 0;
}

type PageCaptureFrame = PageHighlightMetrics & {
  refRect: DOMRect;
  scaleX: number;
  scaleY: number;
};

/** Coordinate frame anchored on the pdf.js canvas (falls back to page box). */
export function getPageHighlightMetrics(pageEl: HTMLElement): PageCaptureFrame {
  const pageRect = pageEl.getBoundingClientRect();
  const canvas = pageEl.querySelector(
    "canvas.react-pdf__Page__canvas",
  ) as HTMLElement | null;
  const textLayer = pageEl.querySelector(
    ".react-pdf__Page__textContent, .textLayer",
  ) as HTMLElement | null;
  const ref = canvas ?? textLayer ?? pageEl;
  const refRect = ref.getBoundingClientRect();
  const pw = refRect.width || pageEl.offsetWidth || 1;
  const ph = refRect.height || pageEl.offsetHeight || 1;
  return {
    pageNum: parseInt(pageEl.getAttribute("data-page-number") || "1", 10),
    originX: refRect.left - pageRect.left,
    originY: refRect.top - pageRect.top,
    pw,
    ph,
    refRect,
    scaleX: 1,
    scaleY: 1,
  };
}

function findPageFrameForRect(
  rect: DOMRectReadOnly,
  pages: HTMLElement[],
): PageCaptureFrame | null {
  let best: { frame: PageCaptureFrame; area: number } | null = null;
  for (const pageEl of pages) {
    const pr = pageEl.getBoundingClientRect();
    const area = rectIntersectionArea(rect, pr);
    if (area > (best?.area ?? 0)) {
      best = { frame: getPageHighlightMetrics(pageEl), area };
    }
  }
  return best && best.area > 0 ? best.frame : null;
}

function pageFrameFromScroll(
  container: HTMLElement,
  clientY: number,
  clientX: number,
  opts: CaptureHighlightOptions,
): PageCaptureFrame | null {
  const numPages = opts.numPages ?? 0;
  const pageGap = opts.pageGap ?? 16;
  const stride = opts.pageStride ?? 0;
  if (numPages <= 0 || stride <= pageGap) return null;

  const containerRect = container.getBoundingClientRect();
  const yInDoc = container.scrollTop + (clientY - containerRect.top);
  const pageNum = Math.max(1, Math.min(numPages, Math.floor(yInDoc / stride) + 1));

  const mounted = container.querySelector<HTMLElement>(
    `.react-pdf__Page[data-page-number="${pageNum}"]`,
  );
  if (mounted) return getPageHighlightMetrics(mounted);

  const pageH = stride - pageGap;
  const pageTop = (pageNum - 1) * stride;
  const yOnPage = yInDoc - pageTop;
  const pages = container.querySelectorAll<HTMLElement>(".react-pdf__Page[data-page-number]");
  const sample = pages[0];
  const pw = sample?.offsetWidth ?? container.clientWidth;
  const ph = pageH;
  const xInContainer = clientX - containerRect.left;
  return {
    pageNum,
    originX: Math.max(0, xInContainer - (container.clientWidth - pw) / 2),
    originY: yOnPage,
    pw,
    ph,
    refRect: new DOMRect(
      containerRect.left + Math.max(0, (container.clientWidth - pw) / 2),
      containerRect.top + (clientY - yOnPage),
      pw,
      ph,
    ),
    scaleX: 1,
    scaleY: 1,
  };
}

function clientRectToLocal(
  r: DOMRectReadOnly,
  frame: PageCaptureFrame,
): RectLike {
  return {
    left: r.left - frame.refRect.left,
    top: r.top - frame.refRect.top,
    width: r.width,
    height: r.height,
  };
}

/** Convert stored pct regions to overlay-local px boxes for one page. */
export function pctRegionsToLocalBoxes(
  regions: Array<{ xPct: number; yPct: number; wPct: number; hPct: number }>,
  metrics: PageHighlightMetrics,
): Array<{ x: number; y: number; w: number; h: number }> {
  return regions.map((r) => ({
    x: metrics.originX + r.xPct * metrics.pw,
    y: metrics.originY + r.yPct * metrics.ph,
    w: r.wPct * metrics.pw,
    h: r.hPct * metrics.ph,
  }));
}

/** Parent element + metrics for highlight overlays (page shell; coords from canvas). */
export function getHighlightOverlayAnchor(pageEl: HTMLElement): {
  parent: HTMLElement;
  metrics: PageHighlightMetrics;
} {
  const frame = getPageHighlightMetrics(pageEl);
  return {
    parent: pageEl,
    metrics: {
      pageNum: frame.pageNum,
      originX: frame.originX,
      originY: frame.originY,
      pw: frame.pw,
      ph: frame.ph,
    },
  };
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

  type PendingRect = RectLike & { pageNum: number; pw: number; ph: number };
  const pending: PendingRect[] = [];

  for (const r of rawRects) {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    let frame = findPageFrameForRect(r, [...pages]);
    if (!frame && container) {
      frame = pageFrameFromScroll(container, cy, cx, opts);
    }
    if (!frame || frame.pw <= 0 || frame.ph <= 0) continue;

    const local = clientRectToLocal(r, frame);
    pending.push({
      ...local,
      pageNum: frame.pageNum,
      pw: frame.pw,
      ph: frame.ph,
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
        xPct: Math.max(0, rect.left / sample.pw),
        yPct: Math.max(0, rect.top / sample.ph),
        wPct: Math.max(0, rect.width / sample.pw),
        hPct: Math.max(0, rect.height / sample.ph),
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
