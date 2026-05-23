import { api, type CrossPaperQA } from "@/lib/api";
import { MAX_SESSION_PAPERS } from "@/lib/workspaceFeatureFlags";
import { getRememberedWorkspaceSelection } from "@/lib/workspaceTruncationPrefs";

export type WorkspaceRecord = {
  id: string;
  name: string;
  paper_ids: string[];
  cross_paper_results?: CrossPaperQA[];
  updated_at: string;
};

export type LoadedWorkspacePaper = {
  id: string;
  title: string;
  /** 1-based index in the saved workspace's paper_ids order. */
  workspaceIndex: number;
};

export async function resolveWorkspacePapers(
  paperIds: string[],
): Promise<{ loaded: LoadedWorkspacePaper[]; missingCount: number }> {
  const loaded: LoadedWorkspacePaper[] = [];
  let missingCount = 0;
  for (let i = 0; i < paperIds.length; i++) {
    const pid = paperIds[i];
    try {
      const p = await api.getPaper(pid);
      loaded.push({ id: p.id, title: p.title, workspaceIndex: i + 1 });
    } catch {
      missingCount++;
    }
  }
  return { loaded, missingCount };
}

export function workspaceNeedsTruncationPicker(loadedCount: number): boolean {
  return loadedCount > MAX_SESSION_PAPERS;
}

export function papersFromRememberedSelection(
  loaded: LoadedWorkspacePaper[],
  rememberedIds: string[],
): LoadedWorkspacePaper[] {
  const byId = new Map(loaded.map((p) => [p.id, p]));
  const picked: LoadedWorkspacePaper[] = [];
  for (const id of rememberedIds) {
    const p = byId.get(id);
    if (p) picked.push(p);
    if (picked.length >= MAX_SESSION_PAPERS) break;
  }
  return picked;
}

export function getRememberedWorkspacePapers(
  ws: WorkspaceRecord,
  loaded: LoadedWorkspacePaper[],
): LoadedWorkspacePaper[] | null {
  const remembered = getRememberedWorkspaceSelection(ws.id, ws.updated_at);
  if (!remembered) return null;
  const picked = papersFromRememberedSelection(loaded, remembered);
  return picked.length > 0 ? picked : null;
}

export type SessionLoadActions = {
  clearWorkspaceSession: () => void;
  clearCrossPaperResults: () => void;
  addCrossPaperResults: (items: CrossPaperQA[]) => void;
  addSessionPaper: (p: { id: string; title: string }) => boolean;
};

/** Pin papers into the workspace session (clears session first). */
export function applyWorkspaceSession(
  papers: { id: string; title: string }[],
  crossPaperResults: CrossPaperQA[] | undefined,
  actions: SessionLoadActions,
): void {
  actions.clearWorkspaceSession();
  actions.clearCrossPaperResults();
  if (crossPaperResults && crossPaperResults.length > 0) {
    actions.addCrossPaperResults(crossPaperResults);
  }
  for (const p of papers) {
    actions.addSessionPaper(p);
  }
}
