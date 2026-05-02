/**
 * Tracks recently *opened* paper ids in localStorage so the dashboard can
 * prefer them over purely created_at ordering from the API.
 */
const STORAGE_KEY = "know-recent-paper-opens";
const MAX_IDS = 30;

export function recordPaperOpened(paperId: string): void {
  if (!paperId || typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    let ids: string[] = [];
    if (raw) {
      const parsed = JSON.parse(raw);
      ids = Array.isArray(parsed)
        ? parsed.filter((x) => typeof x === "string" && /^[a-zA-Z0-9_-]+$/.test(x))
        : [];
    }
    ids = [paperId, ...ids.filter((id) => id !== paperId)].slice(0, MAX_IDS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
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
    return Array.isArray(parsed)
      ? parsed.filter((x) => typeof x === "string" && /^[a-zA-Z0-9_-]+$/.test(x))
      : [];
  } catch {
    return [];
  }
}
