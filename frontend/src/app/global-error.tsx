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
      <body className="min-h-screen flex items-center justify-center bg-white">
        <div className="text-center space-y-4 max-w-md px-6">
          <h2 className="text-[20px] font-bold text-gray-900">Something went wrong</h2>
          <p className="text-[14px] text-gray-500">
            An unexpected error occurred. Please try again.
          </p>
          <button
            onClick={reset}
            className="text-[13px] font-medium bg-gray-900 text-white px-4 py-2 rounded-lg hover:bg-gray-800 transition-colors"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
