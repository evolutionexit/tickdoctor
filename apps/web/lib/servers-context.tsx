"use client";

import { createContext, useContext } from "react";
import type { ServerListResponse } from "./types";
import { usePolled, type AsyncState } from "./hooks";
import { api } from "./api";

const Ctx = createContext<AsyncState<ServerListResponse> | null>(null);

/** One poll of GET /api/servers every 15 s, shared by the switcher and the overview. */
export function ServersProvider({ children }: { children: React.ReactNode }) {
  const state = usePolled(() => api.servers(), "servers", 15_000);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useServers() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useServers outside <ServersProvider>");
  return c;
}
