"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useUserTier, canAccess } from "@/lib/UserTierContext";

export type SelectionAction = "explain" | "derive" | "assumptions" | "question" | "note";

interface SelectionToolbarProps {
  text: string;
  rect: DOMRect;
  onAction: (action: SelectionAction, text: string) => void;
  onDismiss: () => void;
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

function AssumptionsIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
  );
}

function AskIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
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

const actions: { id: SelectionAction; label: string; Icon: () => React.JSX.Element }[] = [
  { id: "explain", label: "Explain", Icon: ExplainIcon },
  { id: "derive", label: "Derive", Icon: DeriveIcon },
  { id: "assumptions", label: "Assumptions", Icon: AssumptionsIcon },
  { id: "question", label: "Ask", Icon: AskIcon },
  { id: "note", label: "Save Note", Icon: NoteIcon },
];

export function SelectionToolbar({ text, rect, onAction, onDismiss }: SelectionToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const mountedAt = useRef(Date.now());
  const { user } = useUserTier();
  const tier = user?.tier || "free";

  const visibleActions = actions.filter((a) => {
    if (a.id === "note") return canAccess(tier, "notes");
    if (a.id === "explain" || a.id === "derive") return canAccess(tier, "selection");
    if (a.id === "assumptions") return canAccess(tier, "assumptions");
    if (a.id === "question") return canAccess(tier, "qa");
    return true;
  });

  const updatePosition = useCallback(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;

    const tw = toolbar.offsetWidth;
    const th = toolbar.offsetHeight;

    let top = rect.top - th - 10;
    let left = rect.left + rect.width / 2 - tw / 2;

    if (top < 4) top = rect.bottom + 10;
    if (left < 4) left = 4;
    if (left + tw > window.innerWidth - 4) left = window.innerWidth - tw - 4;

    setPos({ top, left });
  }, [rect]);

  useEffect(() => {
    updatePosition();
  }, [updatePosition]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        if (Date.now() - mountedAt.current > 200) {
          onDismiss();
        }
      }
    };
    window.addEventListener("mousedown", handleClick, true);
    return () => {
      window.removeEventListener("mousedown", handleClick, true);
    };
  }, [onDismiss]);

  const cleanText = text.replace(/\s+/g, " ").trim();

  return (
    <div
      ref={toolbarRef}
      className="fixed z-50 animate-fade-in"
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="glass-strong shadow-2xl rounded-2xl px-1.5 py-1.5 flex items-center gap-0.5">
        {visibleActions.map((a) => (
          <button
            key={a.id}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onAction(a.id, cleanText);
            }}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-medium text-gray-500 hover:text-gray-900 hover:bg-white/60 transition-colors whitespace-nowrap"
          >
            <a.Icon />
            {a.label}
          </button>
        ))}
      </div>
      {cleanText.length > 40 && (
        <div className="mt-1.5 mx-1 px-2.5 py-1.5 text-[10px] text-gray-400 glass-subtle rounded-xl max-w-sm leading-relaxed line-clamp-2">
          {cleanText.slice(0, 120)}{cleanText.length > 120 ? "..." : ""}
        </div>
      )}
    </div>
  );
}
