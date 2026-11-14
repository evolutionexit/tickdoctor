"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { SessionUser } from "@tickdoctor/shared";
import { api, friendlyError, onUnauthorized } from "./api";

interface AuthCtx {
  user: SessionUser;
  setUser: (u: SessionUser) => void;
  refresh: () => Promise<void>;
  logout: (everywhere?: boolean) => Promise<void>;
}
const Ctx = createContext<AuthCtx | null>(null);

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside <AuthGate>");
  return c;
}

export function loginUrl(next: string) {
  return `/login?next=${encodeURIComponent(next)}`;
}

/** Loads GET /api/auth/session once, sends signed-out visitors to /login?next=…, and handles 401s from any call. */
export function AuthGate({ children, loading }: { children: React.ReactNode; loading: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [error, setError] = useState<string>();

  const goLogin = useCallback(() => {
    const next = window.location.pathname + window.location.search;
    router.replace(loginUrl(next));
  }, [router]);

  const load = useCallback(async () => {
    try {
      const s = await api.session();
      setError(undefined);
      setUser(s.user);
      if (!s.user) goLogin();
    } catch (e) {
      setError(friendlyError(e));
    }
  }, [goLogin]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    onUnauthorized(goLogin);
    return () => onUnauthorized(null);
  }, [goLogin]);

  const value = useMemo<AuthCtx | null>(
    () =>
      user
        ? {
            user,
            setUser,
            refresh: async () => {
              const s = await api.session();
              if (s.user) setUser(s.user);
              else goLogin();
            },
            logout: async (everywhere) => {
              await (everywhere ? api.logoutAll() : api.logout());
              router.replace("/login");
            },
          }
        : null,
    [user, goLogin, router],
  );

  if (error)
    return (
      <div className="mx-auto max-w-lg px-4 py-24" role="alert">
        <h1 className="text-2xl font-bold">We couldn&apos;t load your account</h1>
        <p className="mt-2 text-muted">{error}</p>
        <button type="button" className="btn btn-primary mt-6" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  if (!value) return <>{loading}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
