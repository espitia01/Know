"use client";

import { useState, useRef } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Textarea } from "@/components/ui/textarea";

interface NotesPanelProps {
  paperId: string;
}

export function NotesPanel({ paperId }: NotesPanelProps) {
  const { notes, addNote, updateNote, removeNote } = useStore();
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);
  const currentPaperRef = useRef(paperId);
  currentPaperRef.current = paperId;

  const handleAdd = async () => {
    const text = input.trim();
    if (!text || saving) return;
    const targetId = paperId;
    setSaving(true);
    try {
      const note = await api.addNote(targetId, text);
      if (currentPaperRef.current === targetId) {
        addNote(note);
        setInput("");
      }
    } catch (e) {
      console.error("Failed to save note:", e);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdate = async (noteId: string) => {
    const text = editText.trim();
    if (!text) return;
    try {
      await api.updateNote(paperId, noteId, text);
      updateNote(noteId, text);
      setEditing(null);
    } catch (e) {
      console.error("Failed to update note:", e);
    }
  };

  const handleDelete = async (noteId: string) => {
    try {
      await api.deleteNote(paperId, noteId);
      removeNote(noteId);
    } catch (e) {
      console.error("Failed to delete note:", e);
    }
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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
          className="text-[13px] resize-none"
        />
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground/40">Ctrl+Enter to save</p>
          <button
            onClick={handleAdd}
            disabled={!input.trim() || saving}
            className="text-[12px] font-medium btn-primary-glass text-background px-4 py-1 rounded-xl transition-opacity disabled:opacity-40"
          >
            {saving ? "Saving..." : "Save Note"}
          </button>
        </div>
      </div>

      {notes.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[12px] font-semibold text-muted-foreground/70 uppercase tracking-widest">
            Notes <span className="text-muted-foreground/40">{notes.length}</span>
          </p>
          {[...notes].reverse().map((note) => (
            <div key={note.id} className="group rounded-xl glass-subtle px-3.5 py-2.5">
              {editing === note.id ? (
                <div className="space-y-1.5">
                  <Textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={2}
                    className="text-[13px] resize-none"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button onClick={() => handleUpdate(note.id)} className="text-[11px] font-medium text-foreground">Save</button>
                    <button onClick={() => setEditing(null)} className="text-[11px] text-muted-foreground">Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{note.text}</p>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[10px] text-muted-foreground/40">{formatTime(note.created_at)}</span>
                    <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => { setEditing(note.id); setEditText(note.text); }}
                        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(note.id)}
                        className="text-[10px] text-muted-foreground hover:text-destructive transition-colors"
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
      )}

      {notes.length === 0 && (
        <p className="text-center text-[13px] text-muted-foreground/50 py-4">
          No notes yet. Jot down thoughts as you read.
        </p>
      )}
    </div>
  );
}
