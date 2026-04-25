"use client";

export function DerivationPanel({ paperId }: { paperId: string }) {
  void paperId; // Prop kept for API parity with other sidebar panels
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center space-y-2 px-2 py-8 text-center">
      <h2 className="text-[var(--text-md)] font-semibold tracking-tight text-foreground">
        Derivation
      </h2>
      <p className="max-w-[42ch] text-[var(--text-sm)] leading-relaxed text-muted-foreground">
        Highlight text in the PDF and choose &ldquo;Derive&rdquo; to start a derivation exercise.
      </p>
    </div>
  );
}
