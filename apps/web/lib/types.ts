import type { z } from "zod";
import type { serverListResponse, agentSetup, firstDataResponse } from "@tickdoctor/shared";

export type ServerListResponse = z.infer<typeof serverListResponse>;
export type AgentSetup = z.infer<typeof agentSetup>;
export type FirstData = z.infer<typeof firstDataResponse>;
