import { brand } from "@tickdoctor/shared";
import { fmtDuration } from "../findings/format.js";

// Discord message texts: apps/web/content/phase6-copy.md "Discord alert messages" (copywriter). Plain embed, no
// mentions (allowed_mentions parse: []), no player names, no IPs. Lines whose value is missing are left out.

export type AlertEvent = "incident_opened" | "incident_resolved" | "server_offline" | "server_back" | "crash" | "test";

export interface MessageInput {
  event: AlertEvent;
  serverName: string;
  link: string;
  severity?: "medium" | "high" | "critical";
  /** incident_opened only: the incident rose to minSeverity after opening below it. */
  raised?: boolean;
  peakMspt?: number | null;
  minTps?: number | null;
  durationMs?: number | null;
  /** Up to two non-tip finding titles. */
  findings?: string[];
  minutes?: number;
  /** crash: when (ms). */
  atMs?: number;
}

const COLORS = { critical: 0xd946ef, high: 0xe69f00, medium: 0xf0e442, good: 0x3b82f6, offline: 0x6b7280, crash: 0xd946ef, test: 0x5eead4 };

const ms = (v: number) => `${Math.round(v)} ms`;
const tps = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

/**
 * User-controlled text (server names, finding titles) as plain text in Discord: truncated FIRST (so an escape is never
 * cut in half), markdown escaped, `<` escaped (no <@id> / <t:…> / <#channel>), `:` escaped (no emoji codes, no bare
 * autolinks like https://…), and @ broken with a zero-width space. allowed_mentions {parse: []} stays the real guard.
 */
export function plain(s: string, max = 100): string {
  return [...s]
    .slice(0, max)
    .join("")
    .replace(/([\\*_~`|>[\]()#<:-])/g, "\\$1")
    .replace(/@/g, "@\u200b");
}

/** "Slowest ticks reached 180 ms and TPS dropped to 12.4." (missing values left out) */
function openedLine(peak: number | null | undefined, low: number | null | undefined): string | null {
  const parts = [peak != null ? `slowest ticks reached ${ms(peak)}` : null, low != null ? `TPS dropped to ${tps(low)}` : null].filter(Boolean);
  if (parts.length === 0) return null;
  const s = parts.join(" and ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

/** "slowest ticks 180 ms, lowest TPS 12.4" */
function worstPart(peak: number | null | undefined, low: number | null | undefined): string | null {
  const parts = [peak != null ? `slowest ticks ${ms(peak)}` : null, low != null ? `lowest TPS ${tps(low)}` : null].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export function buildMessage(m: MessageInput): { username: string; embeds: unknown[]; allowed_mentions: { parse: never[] } } {
  const server = plain(m.serverName);
  const findings = (m.findings ?? []).slice(0, 2).map((t) => plain(t, 200));
  let title = "";
  const lines: string[] = [];
  let color = COLORS.test;
  switch (m.event) {
    case "incident_opened": {
      const sev = m.severity ?? "medium";
      color = COLORS[sev];
      if (m.raised) {
        title = `${server} got worse (${sev})`;
        const nums = [m.peakMspt != null ? `Slowest ticks: ${ms(m.peakMspt)}` : null, m.minTps != null ? `lowest TPS ${tps(m.minTps)}` : null].filter(Boolean);
        lines.push(`The lag that started earlier is now ${sev}.${nums.length ? ` ${nums.join(", ")}.` : ""}`);
      } else {
        title = `${server} is lagging (${sev})`;
        const l = openedLine(m.peakMspt, m.minTps);
        if (findings.length) {
          if (l) lines.push(l);
          lines.push(`Likely cause: ${findings.join("; ")}`);
        } else {
          lines.push(`${l ? `${l} ` : ""}We're still looking for the cause; details are in ${brand.name}.`);
        }
      }
      break;
    }
    case "incident_resolved": {
      color = COLORS.good;
      title = `${server} is back to normal`;
      const worst = worstPart(m.peakMspt, m.minTps);
      const head = [m.durationMs != null ? `The lag lasted ${fmtDuration(m.durationMs)}.` : null, worst ? `Worst moment: ${worst}.` : null]
        .filter(Boolean)
        .join(" ");
      if (findings.length) {
        if (head) lines.push(head);
        lines.push(`What we found: ${findings.join("; ")}`);
      } else {
        lines.push(`${head ? `${head} ` : ""}We didn't find a clear cause.`);
      }
      break;
    }
    case "server_offline":
      color = COLORS.offline;
      title = `${server} is offline`;
      lines.push(`We haven't heard from the server for ${m.minutes ?? 0} minutes. It may have stopped, crashed, or lost its connection.`);
      break;
    case "server_back":
      color = COLORS.good;
      title = `${server} is back online`;
      lines.push(`The server is sending data again.${m.durationMs != null ? ` It was offline for ${fmtDuration(m.durationMs)}.` : ""}`);
      break;
    case "crash":
      color = COLORS.crash;
      title = `${server} crashed`;
      lines.push(
        `The server reported a crash, or started after it wasn't shut down cleanly${m.atMs != null ? ` (at <t:${Math.floor(m.atMs / 1000)}:f>)` : ""}. Check the server log for the reason.`,
      );
      break;
    case "test":
      title = `${brand.name} test message`;
      lines.push(`This channel is connected to ${server}. You'll get a message here when the server lags, goes offline or crashes.`);
      break;
  }
  lines.push(`[Open in ${brand.name}](${m.link})`);
  return {
    username: brand.name,
    embeds: [
      {
        title: title.slice(0, 256),
        url: m.link,
        description: lines.join("\n").slice(0, 4000),
        color,
        footer: { text: `${brand.name} · alerts can be changed in the Alerts tab` },
      },
    ],
    allowed_mentions: { parse: [] },
  };
}
