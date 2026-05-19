/** localStorage key for remembered workspace truncation choices (PROMPT_8 B3). */
const STORAGE_KEY = "know-workspace-truncation-prefs";

type TruncationPrefEntry = {
  paper_ids: string[];
  updated_at: string;
};

type TruncationPrefs = Record<string, TruncationPrefEntry>;

function readPrefs(): TruncationPrefs {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as TruncationPrefs;
  } catch {
    return {};
  }
}

/** Returns remembered paper ids when the workspace has not changed since the choice. */
export function getRememberedWorkspaceSelection(
  workspaceId: string,
  updatedAt: string,
): string[] | null {
  const entry = readPrefs()[workspaceId];
  if (!entry || entry.updated_at !== updatedAt) return null;
  return entry.paper_ids.length > 0 ? [...entry.paper_ids] : null;
}

export function setRememberedWorkspaceSelection(
  workspaceId: string,
  updatedAt: string,
  paperIds: string[],
): void {
  if (typeof window === "undefined") return;
  try {
    const prefs = readPrefs();
    prefs[workspaceId] = { paper_ids: paperIds, updated_at: updatedAt };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // quota — best-effort
  }
}
