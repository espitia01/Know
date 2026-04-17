"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError("");
    try {
      await api.login(password);
      router.push("/");
    } catch {
      setError("Wrong password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex-1 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-xs space-y-6">
        <div className="text-center space-y-1.5">
          <h1 className="text-3xl font-bold tracking-tight">Know</h1>
          <p className="text-[14px] text-muted-foreground">Enter password to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            className="w-full h-10 px-3 text-[14px] rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-shadow"
          />
          <button
            type="submit"
            disabled={loading || !password.trim()}
            className="w-full h-10 text-[14px] font-medium rounded-lg bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        {error && (
          <p className="text-[13px] text-destructive text-center animate-fade-in">{error}</p>
        )}
      </div>
    </main>
  );
}
