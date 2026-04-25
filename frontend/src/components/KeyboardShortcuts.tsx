"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";

const TAB_KEYS: Record<string, string> = {
  "1": "summary",
  "2": "preread",
  "3": "assume",
  "4": "qa",
  "5": "figures",
  "6": "notes",
  "7": "compare",
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

export function KeyboardShortcuts() {
  const setActiveTab = useStore((s) => s.setActiveTab);
  const togglePanel = useStore((s) => s.togglePanel);
  const toggleFocusMode = useStore((s) => s.toggleFocusMode);
  const setPanelVisible = useStore((s) => s.setPanelVisible);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;

      const mod = e.metaKey || e.ctrlKey;

      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }

      if (mod && e.key === "\\") {
        e.preventDefault();
        togglePanel();
        return;
      }

      if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        toggleFocusMode();
        return;
      }

      const tab = TAB_KEYS[e.key];
      if (!mod && !e.altKey && !e.shiftKey && tab) {
        e.preventDefault();
        setPanelVisible(true);
        setActiveTab(tab);
        return;
      }

      if (!mod && !e.altKey && !e.shiftKey && (e.key === "j" || e.key === "k")) {
        const scroller = document.querySelector<HTMLElement>("[data-know-pdf-scroll]");
        if (!scroller) return;
        e.preventDefault();
        scroller.scrollBy({
          top: e.key === "j" ? scroller.clientHeight * 0.82 : -scroller.clientHeight * 0.82,
          behavior: "smooth",
        });
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [setActiveTab, setPanelVisible, toggleFocusMode, togglePanel]);

  if (!helpOpen) return null;

  return (
    <div className="fixed bottom-4 left-4 z-[70] w-64 rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl p-3 animate-fade-in">
      <div className="flex items-center justify-between gap-3 pb-2 border-b border-border/70">
        <p className="text-[var(--text-xs)] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Keyboard shortcuts
        </p>
        <button
          onClick={() => setHelpOpen(false)}
          className="text-muted-foreground/60 hover:text-foreground transition-colors"
          aria-label="Close shortcuts"
        >
          ×
        </button>
      </div>
      <div className="pt-2 space-y-1.5 text-[var(--text-xs)]">
        <Shortcut keys="⌘/Ctrl + \\" label="Toggle analysis pane" />
        <Shortcut keys="⌘/Ctrl + ⇧ + F" label="Focus mode" />
        <Shortcut keys="1–7" label="Switch analysis tabs" />
        <Shortcut keys="J / K" label="Scroll the PDF" />
        <Shortcut keys="?" label="Show / hide this help" />
      </div>
    </div>
  );
}

function Shortcut({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <kbd className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
        {keys}
      </kbd>
    </div>
  );
}
