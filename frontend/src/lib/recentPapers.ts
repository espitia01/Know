/**
 * Tracks recently *opened* paper ids in localStorage so the dashboard can
 * prefer them over purely created_at ordering from the API.
 */
const STORAGE_KEY = "know-recent-paper-opens";
const MAX_IDS = 30;

/** Dispatched after localStorage updates so the dashboard can re-sort without a full remount. */
export const KNOW_RECENT_PAPERS_CHANGED = "know-recent-papers-changed";

function sanitizeIdList(xs: unknown): string[] {
  if (!Array.isArray(xs)) return [];
  return xs.filter((x): x is string => {
    if (typeof x !== "string") return false;
    const t = x.trim();
    if (!t || t.length > 200) return false;
    // Allow canonical ids from the backend (UUID, hex blobs, trial_*, etc.);
    // only reject obviously broken control characters.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(t)) return false;
    return true;
  });
}

export function recordPaperOpened(paperId: string): void {
  if (!paperId || typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    let ids: string[] = [];
    if (raw) ids = sanitizeIdList(JSON.parse(raw));
    ids = [paperId, ...ids.filter((id) => id !== paperId)].slice(0, MAX_IDS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    window.dispatchEvent(new CustomEvent(KNOW_RECENT_PAPERS_CHANGED));
  } catch {
    /* quota / privacy mode */
  }
}

/** Most-recent-first ids (subset of user's library entries). */
export function getRecentPaperOpenOrder(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return sanitizeIdList(parsed);
  } catch {
    return [];
  }
}
