"use client";

import { createContext, useContext } from "react";
import { api } from "./api";

/** The subset of the app API the server pages use. /demo swaps in a read-only implementation fed by the static dataset. */
export type ServerApi = Pick<
  typeof api,
  "server" | "findings" | "finding" | "incidents" | "incidentList" | "incidentDetail" | "metricsBatch" | "setFindingStatus"
>;

export interface ServerEnv {
  demo: boolean;
  api: ServerApi;
  /** Base path of the server's pages: /app/servers/:id, or /demo. */
  base: (serverId: string) => string;
  /** Longest time range the data can fill (the demo dataset holds 7 days). */
  maxRangeMs: number;
  /** Demo only: the made-up server name, shown in page headers. */
  serverName?: string;
}

const real: ServerEnv = { demo: false, api, base: (id) => `/app/servers/${id}`, maxRangeMs: Infinity };

const Ctx = createContext<ServerEnv>(real);
export const ServerEnvProvider = Ctx.Provider;
export const useServerEnv = () => useContext(Ctx);

export const DEMO_TOOLTIP = "This is a demo";
