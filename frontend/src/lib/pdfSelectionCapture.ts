/**
 * PDF figure crop: composites intersecting `.react-pdf__Page__canvas`
 * pixels for a viewport rectangle. Coordinates via pointer-drag mode
 * (SciSpace-style) or legacy text selection union.
 */

import { useStore } from "@/lib/store";

export type PdfSelectionCaptureFn = () => Promise<Blob | null>;

let captureImpl: PdfSelectionCaptureFn | null = null;

/** @deprecated Kept for API compat; interactive flow uses {@link beginFigureScreenshotFlow}. */
export function registerPdfSelectionCapture(fn: PdfSelectionCaptureFn | null): void {
  captureImpl = fn;
}

/** @deprecated */
export function capturePdfSelectionToPng(): Promise<Blob | null> {
  return captureImpl ? captureImpl() : Promise.resolve(null);
}

let rectCaptureResolve: ((blob: Blob | null) => void) | null = null;

/**
 * Highlights the PDF and waits for the user to drag a rectangle + release,
 * then returns PNG pixels for that viewport region (or null if cancelled /
 * degenerate drag).
 */
export function beginFigureScreenshotFlow(): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (rectCaptureResolve) {
      const prev = rectCaptureResolve;
      rectCaptureResolve = null;
      useStore.getState().setFigureScreenshotMode(false);
      prev(null);
    }
    rectCaptureResolve = resolve;
    useStore.getState().setFigureScreenshotMode(true);
  });
}

export function resolveFigureScreenshot(blob: Blob | null): void {
  const r = rectCaptureResolve;
  rectCaptureResolve = null;
  useStore.getState().setFigureScreenshotMode(false);
  r?.(blob);
}

export function cancelFigureScreenshot(): void {
  resolveFigureScreenshot(null);
}

/** Safe to call when leaving the reader — avoids dangling promises. */
export function abortFigureScreenshotIfPending(): void {
  if (rectCaptureResolve || useStore.getState().figureScreenshotMode) {
    cancelFigureScreenshot();
  }
}

type VideoElWithVfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: DOMHighResTimeStamp, meta: VideoFrameCallbackMetadata) => number;
};

async function awaitFirstVideoDimensions(v: HTMLVideoElement): Promise<boolean> {
  const minPx = 8;
  const deadline = Date.now() + 12000;

  while (v.videoWidth < minPx || v.videoHeight < minPx) {
    if (Date.now() > deadline) return false;
    await new Promise<void>((resolve) => {
      const vv = v as VideoElWithVfc;
      if (typeof vv.requestVideoFrameCallback === "function") {
        vv.requestVideoFrameCallback(() => resolve());
      } else {
        v.addEventListener("loadeddata", () => resolve(), { once: true });
        requestAnimationFrame(() => resolve());
      }
    });
  }
  return true;
}

/** One-frame PNG from a user-picked screen/tab (browser prompt). */
export async function captureScreenTabToPng(): Promise<Blob | null> {
  const md = navigator.mediaDevices;
  if (!md?.getDisplayMedia) return null;
  let stream: MediaStream | null = null;
  try {
    stream = await md.getDisplayMedia({ video: true, audio: false });
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    await v.play().catch(() => undefined);
    const ready = await awaitFirstVideoDimensions(v);

    const w = v.videoWidth || 0;
    const h = v.videoHeight || 0;
    if (!ready || w < 8 || h < 8) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      return null;
    }

    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      return null;
    }
    ctx.drawImage(v, 0, 0);

    stream.getTracks().forEach((t) => t.stop());
    stream = null;

    return new Promise((resolve) => {
      c.toBlob((b) => resolve(b && b.size >= 64 ? b : null), "image/png", 0.92);
    });
  } catch {
    return null;
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}

/** Clipboard image (⌘V after macOS screenshot / Win+Shift+S, etc.). */
export async function readClipboardImageBlob(): Promise<Blob | null> {
  try {
    if (!navigator.clipboard?.read) return null;
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const ty of item.types) {
        if (ty.startsWith("image/")) {
          const blob = await item.getType(ty);
          if (blob.size >= 64) return blob;
        }
      }
    }
  } catch {
    /* PermissionDenied or unsupported */
  }
  return null;
}

/** Union of sensible client rects from a Range (fallback: single bbox). */
function unionSelectionRects(range: Range): DOMRect | null {
  let rects = Array.from(range.getClientRects());
  rects = rects.filter((r) => r.width >= 3 && r.height >= 3);
  if (!rects.length) {
    const b = range.getBoundingClientRect();
    if (!b.width || !b.height) return null;
    rects = [b];
  }

  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  return new DOMRect(left, top, right - left, bottom - top);
}

function intersectRects(a: DOMRectReadOnly, b: DOMRectReadOnly): DOMRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  const w = right - left;
  const h = bottom - top;
  if (w < 4 || h < 4) return null;
  return new DOMRect(left, top, w, h);
}

function pageNumberForCanvas(canvas: HTMLCanvasElement): number | null {
  let el: HTMLElement | null = canvas.parentElement;
  while (el) {
    const n = el.dataset.pageNumber ?? el.getAttribute("data-page-number");
    if (n != null) {
      const p = Number.parseInt(n, 10);
      if (!Number.isNaN(p)) return p;
    }
    el = el.parentElement;
  }
  return null;
}

const MAX_CAPTURE_W = 2400;
const MAX_CAPTURE_H = 3600;

/**
 * Crop PDF.js canvases to a **viewport-space** rectangle (client coordinates).
 */
export function capturePdfViewportUnionToBlob(
  containerEl: HTMLElement,
  union: DOMRectReadOnly,
): Promise<Blob | null> {
  if (union.width < 6 || union.height < 6) return Promise.resolve(null);

  try {
    type Strip = {
      page: number;
      destTop: number;
      canvas: HTMLCanvasElement;
      sx: number;
      sy: number;
      sw: number;
      sh: number;
    };

    const strips: Strip[] = [];
    const canvases = [...containerEl.querySelectorAll("canvas")] as HTMLCanvasElement[];

    for (const canvas of canvases) {
      if (!canvas.classList.contains("react-pdf__Page__canvas")) continue;
      const cR = canvas.getBoundingClientRect();
      const inter = intersectRects(union, cR);
      if (!inter) continue;

      const page = pageNumberForCanvas(canvas);
      const scaleX = canvas.width / cR.width;
      const scaleY = canvas.height / cR.height;
      const sx = Math.round((inter.left - cR.left) * scaleX);
      const sy = Math.round((inter.top - cR.top) * scaleY);
      const sw = Math.round(inter.width * scaleX);
      const sh = Math.round(inter.height * scaleY);

      if (sw < 4 || sh < 4) continue;

      strips.push({
        page: page ?? 1_000_000,
        destTop: inter.top,
        canvas,
        sx: Math.max(0, sx),
        sy: Math.max(0, sy),
        sw: Math.min(sw, canvas.width - Math.max(0, sx)),
        sh: Math.min(sh, canvas.height - Math.max(0, sy)),
      });
    }

    strips.sort((a, b) => (a.page === b.page ? a.destTop - b.destTop : a.page - b.page));
    const usable = strips.filter((s) => s.sw >= 4 && s.sh >= 4);
    if (!usable.length) return Promise.resolve(null);

    const maxStripW = usable.reduce((m, s) => Math.max(m, s.sw), 1);
    const gapPx = Math.max(8, Math.min(28, Math.round(maxStripW * 0.022)));
    const totalStripH =
      usable.reduce((acc, s) => acc + s.sh + gapPx, 0) - (usable.length ? gapPx : 0);

    const scaleDown = Math.min(
      1,
      MAX_CAPTURE_W / maxStripW,
      MAX_CAPTURE_H / Math.max(totalStripH, 1),
    );
    const outW = Math.max(1, Math.round(maxStripW * scaleDown));
    const outH = Math.max(24, Math.round(totalStripH * scaleDown));

    const outCanvas = document.createElement("canvas");
    outCanvas.width = outW;
    outCanvas.height = outH;
    const ctx = outCanvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outW, outH);

    let y = 0;
    const gapScaled = Math.round(gapPx * scaleDown);
    for (let i = 0; i < usable.length; i++) {
      const s = usable[i];
      const dh = Math.round(s.sh * scaleDown);
      const dw = Math.round(s.sw * scaleDown);
      const dx = Math.round((outW - dw) / 2);

      ctx.drawImage(s.canvas, s.sx, s.sy, s.sw, s.sh, dx, y, dw, dh);

      y += dh + gapScaled;
    }

    return new Promise((resolve) => {
      outCanvas.toBlob(
        (blob) => {
          // Thin crops (small figures / tight boxes) are valid; only reject empty.
          resolve(blob && blob.size >= 64 ? blob : null);
        },
        "image/png",
        0.92,
      );
    });
  } catch {
    return Promise.resolve(null);
  }
}

/** Text-selection path (viewport union from `window.getSelection()`). */
export function capturePdfSelectionFromContainer(containerEl: HTMLElement): Promise<Blob | null> {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    return Promise.resolve(null);
  }

  try {
    const range = sel.getRangeAt(0);
    const union = unionSelectionRects(range);
    if (!union) return Promise.resolve(null);
    return capturePdfViewportUnionToBlob(containerEl, union);
  } catch {
    return Promise.resolve(null);
  }
}
