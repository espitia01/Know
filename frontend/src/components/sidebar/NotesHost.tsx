"use client";

import { NotesPanel } from "@/components/sidebar/NotesPanel";

interface NotesHostProps {
  paperId: string;
}

/** Notes tab — highlights live in the PDF only (not duplicated here). */
export function NotesHost({ paperId }: NotesHostProps) {
  return <NotesPanel paperId={paperId} />;
}
