/**
 * Snapshot viewport geometry passed through React state. `Range`/`Selection`
 * `getBoundingClientRect()` snapshots can otherwise be mutated or cleared by
 * the browser before the next paint — especially after `removeAllRanges()`.
 */
export function snapshotDomRect(rect: DOMRectReadOnly): DOMRect {
  return new DOMRect(rect.left, rect.top, rect.width, rect.height);
}
