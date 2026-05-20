"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { useStore, EMPTY_NOTES_LIST, EMPTY_SELECTION_LIST } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { SectionHeader } from "@/components/panel/SectionHeader";
import { NoteMarkdownEditor } from "@/components/notes/NoteMarkdownEditor";
import { normalizeSelectionAction } from "@/lib/selectionActions";

interface NotesPanelProps {
  paperId: string;
}

function formatNoteDate(ts: number) {
  const d = new Date(ts * 1000);
  const y = d.getFullYear();
  const nowY = new Date().getFullYear();
  if (y === nowY) {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(d);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(d);
}

function stripPdfHistoryForNote(paperId: string, noteId: string) {
  useStore.setState((s) => {
    const history = s.selectionHistoryByPaper[paperId] ?? EMPTY_SELECTION_LIST;
    const current = s.selectionResultByPaper[paperId] ?? null;
    return {
      selectionHistoryByPaper: {
        ...s.selectionHistoryByPaper,
        [paperId]: history.filter(
          (h) => !(normalizeSelectionAction(h.action) === "note" && h.clientKey === noteId),
        ),
      },
      selectionResultByPaper: {
        ...s.selectionResultByPaper,
        [paperId]:
          current &&
          normalizeSelectionAction(current.action) === "note" &&
          current.clientKey === noteId
            ? null
            : current,
      },
    };
  });
}

export function NotesPanel({ paperId }: NotesPanelProps) {
  const notes = useStore((s) => s.notesByPaper[paperId] ?? EMPTY_NOTES_LIST);
  const addNoteForPaper = useStore((s) => s.addNoteForPaper);
  const updateNoteForPaper = useStore((s) => s.updateNoteForPaper);
  const removeNoteForPaper = useStore((s) => s.removeNoteForPaper);
  const setNotesForPaper = useStore((s) => s.setNotesForPaper);
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentPaperRef = useRef(paperId);
  currentPaperRef.current = paperId;

  const handleAdd = async () => {
    const text = input.trim();
    if (!text || saving) return;
    const targetId = paperId;
    setSaving(true);
    setError(null);
    try {
      const note = await api.addNote(targetId, text, "", false);
      addNoteForPaper(targetId, note);
      if (currentPaperRef.current === targetId) {
        setInput("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save note.");
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (noteId: string) => {
    const text = editText.trim();
    if (!text) return;
    const prev = useStore.getState().notesByPaper[paperId] ?? [];
    updateNoteForPaper(paperId, noteId, text);
    setEditing(null);
    try {
      await api.updateNote(paperId, noteId, text);
      useStore.setState((s) => {
        const history = s.selectionHistoryByPaper[paperId] ?? EMPTY_SELECTION_LIST;
        const current = s.selectionResultByPaper[paperId] ?? null;
        return {
          selectionHistoryByPaper: {
            ...s.selectionHistoryByPaper,
            [paperId]: history.map((h) =>
              normalizeSelectionAction(h.action) === "note" && h.clientKey === noteId
                ? { ...h, explanation: text }
                : h,
            ),
          },
          selectionResultByPaper: {
            ...s.selectionResultByPaper,
            [paperId]:
              current &&
              normalizeSelectionAction(current.action) === "note" &&
              current.clientKey === noteId
                ? { ...current, explanation: text }
                : current,
          },
        };
      });
    } catch (e) {
      setNotesForPaper(paperId, prev);
      setError(e instanceof Error ? e.message : "Failed to update note.");
    }
  };

  const handleDelete = async (noteId: string) => {
    const prev = useStore.getState().notesByPaper[paperId] ?? [];
    removeNoteForPaper(paperId, noteId);
    stripPdfHistoryForNote(paperId, noteId);
    try {
      await api.deleteNote(paperId, noteId);
    } catch (e) {
      setNotesForPaper(paperId, prev);
      setError(e instanceof Error ? e.message : "Failed to delete note.");
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <NoteMarkdownEditor value={input} onChange={setInput} minHeight={180} />
        <div className="flex items-center justify-between gap-3">
          <p className="text-[var(--text-xs)] text-muted-foreground/80 shrink-0">
            Preview updates as you type
          </p>
          <button
            type="button"
            onClick={handleAdd}
            disabled={!input.trim() || saving}
            className="btn-primary-glass h-9 rounded-lg px-4 text-[var(--text-sm)] font-medium text-background transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40 shrink-0"
          >
            {saving ? "Saving…" : "Save Note"}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-[var(--text-xs)] text-destructive">{error}</p>
        )}
      </div>

      {notes.length > 0 && (
        <div>
          <SectionHeader title="Notes" count={notes.length} />
          <div className="overflow-hidden rounded-lg border border-border/60 bg-card/30">
            {[...notes].reverse().map((note) => {
              const isPending = note.id.startsWith("pending-note-");
              return (
              <div
                key={note.id}
                className={`analysis-note-row group/note border-b border-border/60 px-4 py-3 last:border-b-0 motion-safe:transition-colors motion-safe:duration-150 hover:bg-accent/40 relative ${
                  isPending ? "opacity-90" : ""
                }`}
              >
                {editing === note.id ? (
                  <div className="space-y-2">
                    <NoteMarkdownEditor
                      value={editText}
                      onChange={setEditText}
                      minHeight={220}
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleUpdate(note.id)}
                        className="text-[var(--text-xs)] font-medium text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="text-[var(--text-xs)] text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {isPending ? (
                      <div
                        className="flex min-h-[7rem] flex-col items-center justify-center gap-2 py-4"
                        aria-busy="true"
                        aria-label="Saving note"
                      >
                        <span className="inline-block h-8 w-8 animate-spin rounded-full border-[2.5px] border-muted-foreground/20 border-t-muted-foreground/70" />
                        <span className="sr-only">Saving note…</span>
                      </div>
                    ) : (
                      <>
                      <div className="text-[var(--text-md)] leading-relaxed [&_.analysis-content]:text-[var(--text-md)]">
                        <Md className="analysis-content note-markdown-preview" latexMode="note">
                          {note.text}
                        </Md>
                      </div>
                    <div className="mt-1.5 flex items-center justify-between">
                      <span className="font-mono text-[0.7rem] font-light tabular-nums text-muted-foreground/70">
                        {formatNoteDate(note.created_at)}
                      </span>
                      <div className="analysis-note-actions flex gap-2 opacity-100 motion-safe:transition-opacity">
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(note.id);
                            setEditText(note.text);
                          }}
                          className="text-[var(--text-xs)] font-medium text-muted-foreground hover:text-foreground focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(note.id)}
                          className="text-[var(--text-xs)] font-medium text-muted-foreground hover:text-destructive focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                      </>
                    )}
                  </>
                )}
              </div>
              );
            })}
          </div>
        </div>
      )}

      {notes.length === 0 && (
        <p className="py-4 text-center text-[var(--text-md)] text-muted-foreground/80">
          No notes yet. Jot down thoughts as you read.
        </p>
      )}
    </div>
  );
}
