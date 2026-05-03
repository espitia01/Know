"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useUserTier, canAccess } from "@/lib/UserTierContext";
import { selectionLooksLikeEquationSnippet } from "@/lib/selectionMathHeuristic";

// `question` is intentionally absent: it used to surface as a separate
// "Ask" button but produced near-identical results to "Explain" because
// the underlying prompt was the same shape. It's now folded into
// Explain — users who want a question-first framing just type it
// directly into the follow-up box on the resulting card.
export type SelectionAction = "explain" | "derive" | "note";

interface SelectionToolbarProps {
  text: string;
  rect: DOMRect;
  onAction: (action: SelectionAction, text: string) => void;
  onDismiss: () => void;
  /** Demo / quota: when `used &gt;= limit`, actions are disabled. */
  selectionQuota?: { used: number; limit: number };
}

function ExplainIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
    </svg>
  );
}

function DeriveIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 15.75V18m-7.5-6.75h.008v.008H8.25v-.008zm0 2.25h.008v.008H8.25V13.5zm0 2.25h.008v.008H8.25v-.008zm0 2.25h.008v.008H8.25V18zm2.498-6.75h.007v.008h-.007v-.008zm0 2.25h.007v.008h-.007V13.5zm0 2.25h.007v.008h-.007v-.008zm0 2.25h.007v.008h-.007V18zm2.504-6.75h.008v.008h-.008v-.008zm0 2.25h.008v.008h-.008V13.5zm3.75-2.25h.008v.008h-.008v-.008zm0 2.25h.008v.008h-.008V13.5zM21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
    </svg>
  );
}

// Concise, action-oriented tooltips. Each one names the *outcome* (what
// the analysis pane will show) rather than a verb, which is what users
// were repeatedly asking for: "what does this button actually do?".
const actions: {
  id: SelectionAction;
  label: string;
  hint: string;
  Icon: () => React.JSX.Element;
}[] = [
  {
    id: "explain",
    label: "Explain",
    hint: "Plain-English breakdown of this passage — jargon, logic, passage-local assumptions, and why it matters. Ask follow-ups inline.",
    Icon: ExplainIcon,
  },
  {
    id: "derive",
    label: "Derive",
    hint: "Step-by-step reconstruction of the math (or argument, for non-technical papers).",
    Icon: DeriveIcon,
  },
  {
    id: "note",
    label: "Save Note",
    hint: "Bookmark this passage to your Notes tab — no LLM call.",
    Icon: NoteIcon,
  },
];

export function SelectionToolbar({ text, rect, onAction, onDismiss, selectionQuota }: SelectionToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [portalReady, setPortalReady] = useState(false);
  const mountedAt = useRef(Date.now());
  const { user } = useUserTier();
  const tier = user?.tier || "free";

  const showDerive = selectionLooksLikeEquationSnippet(text);

  const visibleActions = actions.filter((a) => {
    if (a.id === "derive" && !showDerive) return false;
    if (a.id === "note") return canAccess(tier, "notes");
    if (a.id === "explain" || a.id === "derive") return canAccess(tier, "selection");
    return true;
  });

  const updatePosition = useCallback(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;

    const tw = toolbar.offsetWidth;
    const th = toolbar.offsetHeight;
    const GAP = 12;
    const EDGE = 8;

    // Prefer above the selection. Flip below when it would clip the top,
    // and finally pin to the bottom edge if neither fits (very rare, e.g.
    // selection spans the full viewport).
    let top = rect.top - th - GAP;
    if (top < EDGE) {
      top = rect.bottom + GAP;
      if (top + th > window.innerHeight - EDGE) {
        top = Math.max(EDGE, window.innerHeight - th - EDGE);
      }
    }

    let left = rect.left + rect.width / 2 - tw / 2;
    if (left < EDGE) left = EDGE;
    if (left + tw > window.innerWidth - EDGE) left = window.innerWidth - tw - EDGE;

    setPos({ top, left });
  }, [rect]);

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    updatePosition();
  }, [updatePosition]);

  // Keep the toolbar anchored to the selection as the user scrolls, resizes,
  // or zooms the PDF. Without this, the pill visibly drifts (or ends up
  // floating over unrelated text) which was the root cause of the
  // "overlaid words" complaint.
  useEffect(() => {
    const handler = () => updatePosition();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [updatePosition]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        if (Date.now() - mountedAt.current > 200) {
          onDismiss();
        }
      }
    };
    // Escape closes the toolbar for keyboard users who can't easily reach
    // outside the floating UI to dismiss via click.
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("mousedown", handleClick, true);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick, true);
      window.removeEventListener("keydown", handleKey);
    };
  }, [onDismiss]);

  const quotaBlocked = selectionQuota !== undefined && selectionQuota.used >= selectionQuota.limit;

  const cleanText = text.replace(/\s+/g, " ").trim();

  // Pointer-events must be suppressed on the wrapper so the initial
  // "selection completed" event that spawned us doesn't also fire
  // through the toolbar into the page, which could blur the selection
  // immediately. The inner pill re-enables interactions for buttons.
  const toolbar = (
    <div
      ref={toolbarRef}
      className="fixed z-[260] pointer-events-none animate-fade-in"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        role="toolbar"
        aria-label="Selection actions"
        className="pointer-events-auto flex items-center gap-0.5 rounded-2xl border border-border/70 bg-popover/97 backdrop-blur-xl px-1 py-1 shadow-2xl shadow-black/12 ring-1 ring-black/[0.06] motion-safe:transition-[box-shadow,transform] dark:shadow-black/50 dark:ring-white/[0.08]"
      >
        {visibleActions.map((a, i) => (
          <button
            key={a.id}
            type="button"
            disabled={quotaBlocked}
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (quotaBlocked) return;
              onAction(a.id, cleanText);
            }}
            // `data-tooltip` powers the rich CSS tooltip declared in
            // globals.css; the native `title` is kept as a fallback for
            // assistive tech and long-press on touch devices.
            data-tooltip={quotaBlocked ? "Demo selection limit reached — create a free account for more." : a.hint}
            title={quotaBlocked ? "Demo selection limit reached — create a free account for more." : a.hint}
            aria-label={quotaBlocked ? "Demo selection limit reached" : `${a.label} — ${a.hint}`}
            className={`know-toolbar-btn group flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[12px] font-medium text-muted-foreground whitespace-nowrap hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent active:scale-[0.97] motion-safe:transition-[color,background-color,transform] motion-safe:duration-150 ${
              i === 0 ? "" : "ml-px"
            } ${quotaBlocked ? "opacity-40 cursor-not-allowed hover:bg-transparent hover:text-muted-foreground" : ""}`}
          >
            <a.Icon />
            <span className="leading-none">{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  if (!portalReady || typeof document === "undefined") return null;
  return createPortal(toolbar, document.body);
}
