"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen flex items-center justify-center bg-card">
        <div className="text-center space-y-4 max-w-md px-6">
          <h2 className="text-[20px] font-bold text-foreground">Something went wrong</h2>
          <p className="text-[14px] text-muted-foreground">
            {error.message || "An unexpected error occurred. Please try again."}
          </p>
          {error.digest && (
            <p className="text-[11px] text-muted-foreground/80 font-mono">
              Reference: {error.digest}
            </p>
          )}
          <button
            onClick={reset}
            className="text-[13px] font-medium btn-primary-glass px-4 py-2 rounded-lg hover:opacity-90 transition-colors"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
