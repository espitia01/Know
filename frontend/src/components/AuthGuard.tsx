"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("know_token");
    if (!token) {
      router.replace("/login");
      return;
    }
    api.checkAuth().then((ok) => {
      if (ok) {
        setAuthed(true);
      } else {
        router.replace("/login");
      }
      setChecked(true);
    });
  }, [router]);

  if (!checked || !authed) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-muted-foreground/30 border-t-foreground rounded-full animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}
