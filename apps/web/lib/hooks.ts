"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  liveSampleEvent,
  liveStatusEvent,
  type ServerHealth,
} from "@tickdoctor/shared";
import { z } from "zod";
import { api } from "./api";
import { loginUrl } from "./auth";

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/** Fetches on mount / when `key` changes and (optionally) every `intervalMs`, pausing while the tab is hidden. */
export function usePolled<T>(fn: () => Promise<T>, key: string, intervalMs?: number): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const keyRef = useRef(key);

  const load = useCallback(async (initial: boolean) => {
    if (initial) setLoading(true);
    try {
      const d = await fnRef.current();
      setData(d);
      setError(undefined);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key;
      setData(undefined);
    }
    let cancelled = false;
    void load(true);
    if (!intervalMs) return;
    const t = setInterval(() => {
      if (!cancelled && document.visibilityState === "visible") void load(false);
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [key, intervalMs, load]);

  return { data, error, loading, reload: useCallback(() => void load(true), [load]) };
}

export type LiveConnection = "connecting" | "live" | "reconnecting" | "unavailable";
export type LiveSample = z.infer<typeof liveSampleEvent>;
export interface LiveState {
  connection: LiveConnection;
  health: ServerHealth | null;
  lastSeenAt: string | null;
  openIncidentId: string | null;
  sample: LiveSample | null;
}

/** Subscribes to GET /api/servers/:id/live (Server-Sent Events). On error it closes and reconnects with backoff (2 s up to 30 s), and sends signed-out users to /login. */
export function useLive(serverId: string | null): LiveState {
  const [state, setState] = useState<LiveState>({ connection: "connecting", health: null, lastSeenAt: null, openIncidentId: null, sample: null });
  useEffect(() => {
    if (!serverId || typeof EventSource === "undefined") return;
    setState({ connection: "connecting", health: null, lastSeenAt: null, openIncidentId: null, sample: null });
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 2000;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const source = new EventSource(`/api/servers/${serverId}/live`);
      es = source;
      source.onopen = () => {
        setState((s) => ({ ...s, connection: "live" }));
      };
      source.onerror = () => {
        source.close();
        if (disposed) return;
        setState((s) => ({ ...s, connection: "reconnecting" }));
        void (async () => {
          try {
            const sess = await api.session();
            if (!sess.user && !disposed) {
              window.location.replace(loginUrl(window.location.pathname + window.location.search));
              return;
            }
          } catch {
            /* offline or API down: just retry */
          }
          if (disposed) return;
          timer = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 30_000);
        })();
      };
      source.addEventListener("status", (ev) => {
        try {
          const p = liveStatusEvent.parse(JSON.parse((ev as MessageEvent).data));
          delay = 2000;
          setState((s) => ({ ...s, connection: "live", health: p.health, lastSeenAt: p.lastSeenAt, openIncidentId: p.openIncidentId }));
        } catch {
          /* ignore malformed event */
        }
      });
      source.addEventListener("sample", (ev) => {
        try {
          const p = liveSampleEvent.parse(JSON.parse((ev as MessageEvent).data));
          setState((s) => ({ ...s, connection: "live", sample: p }));
        } catch {
          /* ignore malformed event */
        }
      });
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      es?.close();
    };
  }, [serverId]);
  return state;
}
