"use client";

export function DerivationPanel({ paperId: _paperId }: { paperId: string }) {
  return (
    <div className="py-8 text-center text-[var(--text-md)] text-muted-foreground">
      Highlight text in the PDF and choose &ldquo;Derive&rdquo; to start a derivation exercise.
    </div>
  );
}
