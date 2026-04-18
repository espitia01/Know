"use client";

import { useState, useEffect } from "react";
import Image from "next/image";

const PASSCODE_HASH = "a3f2b8c1d4e5"; // simple obfuscation, not real security
const STORAGE_KEY = "know_access_granted";

function checkPasscode(input: string): boolean {
  return input === "Ebong-1996";
}

export function PasscodeGate({ children }: { children: React.ReactNode }) {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    setGranted(stored === PASSCODE_HASH);
  }, []);

  if (granted === null) return null;

  if (granted) return <>{children}</>;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (checkPasscode(input)) {
      sessionStorage.setItem(STORAGE_KEY, PASSCODE_HASH);
      setGranted(true);
    } else {
      setError(true);
      setTimeout(() => setError(false), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-6">
      <div className="max-w-[360px] w-full space-y-8">
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            <Image src="/logo.png" alt="Know" width={48} height={48} priority className="rounded-xl" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-[22px] font-bold tracking-[-0.03em] text-gray-900">Private Beta</h1>
            <p className="text-gray-500 text-[14px]">Enter the access code to continue.</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Access code"
            autoFocus
            className={`w-full px-4 py-3 text-[14px] rounded-xl border ${
              error ? "border-red-300 bg-red-50/50" : "border-gray-200"
            } focus:outline-none focus:ring-2 focus:ring-gray-900/10 focus:border-gray-300 transition-all`}
          />
          {error && (
            <p className="text-[13px] text-red-500 text-center">Incorrect code</p>
          )}
          <button
            type="submit"
            className="w-full py-3 text-[14px] font-medium bg-gray-900 text-white rounded-xl hover:bg-gray-800 transition-colors"
          >
            Enter
          </button>
        </form>
      </div>
    </div>
  );
}
