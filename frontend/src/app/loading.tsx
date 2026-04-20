export default function Loading() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-6 h-6 border-2 border-border border-t-foreground rounded-full animate-spin mx-auto" />
        <p className="text-[13px] text-muted-foreground/80">Loading...</p>
      </div>
    </div>
  );
}
