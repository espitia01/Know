"use client";

import { useState, useRef } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Textarea } from "@/components/ui/textarea";
import { SectionHeader } from "@/components/panel/SectionHeader";

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

export function NotesPanel({ paperId }: NotesPanelProps) {
  const { notes, addNote, updateNote, removeNote, setNotes } = useStore();
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
      const note = await api.addNote(targetId, text);
      if (currentPaperRef.current === targetId) {
        addNote(note);
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
    // Optimistic update: reflect the edit immediately and roll back if the
    // request fails. Previously the UI waited on the network round-trip
    // before closing the editor, which felt laggy on slow connections.
    const prev = useStore.getState().notes;
    updateNote(noteId, text);
    setEditing(null);
    try {
      await api.updateNote(paperId, noteId, text);
    } catch (e) {
      setNotes(prev);
      setError(e instanceof Error ? e.message : "Failed to update note.");
    }
  };

  const handleDelete = async (noteId: string) => {
    const prev = useStore.getState().notes;
    removeNote(noteId);
    try {
      await api.deleteNote(paperId, noteId);
    } catch (e) {
      setNotes(prev);
      setError(e instanceof Error ? e.message : "Failed to delete note.");
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Textarea
          placeholder="Write a thought, annotation, or note..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleAdd(); }
          }}
          rows={2}
          className="text-[var(--text-md)] resize-none"
        />
        <div className="flex items-center justify-between">
          <p className="text-[var(--text-xs)] text-muted-foreground/80">Ctrl+Enter to save</p>
          <button
            type="button"
            onClick={handleAdd}
            disabled={!input.trim() || saving}
            className="btn-primary-glass h-9 rounded-lg px-4 text-[var(--text-sm)] font-medium text-background transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
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
            {[...notes].reverse().map((note) => (
              <div
                key={note.id}
                className="analysis-note-row group/note border-b border-border/60 px-4 py-3 last:border-b-0 motion-safe:transition-colors motion-safe:duration-150 hover:bg-accent/40"
              >
                {editing === note.id ? (
                  <div className="space-y-2">
                    <Textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={2}
                      className="text-[var(--text-md)] resize-none"
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
                    <p className="whitespace-pre-wrap text-[var(--text-md)] leading-relaxed">
                      {note.text}
                    </p>
                    <div className="mt-1.5 flex items-center justify-between">
                      <span className="font-mono text-[0.7rem] font-light tabular-nums text-muted-foreground/70">
                        {formatNoteDate(note.created_at)}
                      </span>
                      <div className="analysis-note-actions flex gap-2 opacity-100 motion-safe:transition-opacity">
                        <button
                          type="button"
                          onClick={() => { setEditing(note.id); setEditText(note.text); }}
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
              </div>
            ))}
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
