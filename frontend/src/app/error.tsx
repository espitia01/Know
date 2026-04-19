"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="text-center space-y-4 max-w-md px-6">
        <h2 className="text-[20px] font-bold text-gray-900">Something went wrong</h2>
        <p className="text-[14px] text-gray-500">
          {error.message || "An unexpected error occurred."}
        </p>
        <button
          onClick={reset}
          className="text-[13px] font-medium bg-gray-900 text-white px-4 py-2 rounded-lg hover:bg-gray-800 transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
