"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { me } from "@/lib/api";

export function AuthGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function checkSession() {
      const token = localStorage.getItem("apexcare_token");

      if (!token) {
        router.replace("/clinic/login");
        return;
      }

      try {
        const user = await me();

        if (cancelled) return;

        if (user.mustChangePassword) {
          router.replace("/account/password");
          return;
        }

        setReady(true);
      } catch {
        localStorage.removeItem("apexcare_token");
        localStorage.removeItem("apexcare_user");
        router.replace("/clinic/login");
      }
    }

    checkSession();

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!ready) {
    return (
      <div
        className="glass"
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: 24,
        }}
      >
        <span className="muted">Checking your clinic session…</span>
      </div>
    );
  }

  return <>{children}</>;
}