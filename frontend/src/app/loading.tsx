export default function Loading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center bg-background px-4">
      <div className="flex flex-col items-center gap-3 text-center animate-fade-in">
        <div
          className="h-6 w-6 rounded-full border-2 border-border border-t-foreground motion-safe:animate-spin"
          aria-hidden
        />
        <p className="text-[13px] text-muted-foreground/85">Loading…</p>
      </div>
    </div>
  );
}
