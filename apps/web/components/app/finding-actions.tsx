"use client";

import { useState } from "react";
import { CONFIG_RULE_IDS, RECHECK_DEFAULTS, type FindingView } from "@tickdoctor/shared";
import { friendlyError } from "@/lib/api";
import { DEMO_TOOLTIP, useServerEnv } from "@/lib/server-env";
import { Alert, Dialog } from "../ui";

/** "Mark as fixed" with a confirm step, and "Undo" while we are still watching. */
export function FindingActions({ finding, onChange }: { finding: FindingView; onChange: (f: FindingView) => void }) {
  const { api, demo } = useServerEnv();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const watch =
    finding.scope === "server" ? `${RECHECK_DEFAULTS.serverScopeMinutes} minutes` : `${RECHECK_DEFAULTS.incidentScopeHours} hours`;

  async function set(status: "marked_fixed" | "open") {
    setBusy(true);
    setErr("");
    try {
      onChange(await api.setFindingStatus(finding.id, status));
      setConfirm(false);
    } catch (e) {
      setErr(friendlyError(e, { conflict: "This finding changed in the meantime. Reload the page and try again." }));
    } finally {
      setBusy(false);
    }
  }

  if (finding.status === "confirmed_fixed") return null;
  if (demo)
    return (
      <span title={DEMO_TOOLTIP} className="inline-flex items-center gap-2">
        <button type="button" className="btn btn-ghost btn-sm" disabled aria-label={`${finding.status === "open" ? "Mark as fixed" : "Undo"} (${DEMO_TOOLTIP})`}>
          {finding.status === "open" ? "Mark as fixed" : "Undo"}
        </button>
        <span className="text-xs text-muted">{DEMO_TOOLTIP}</span>
      </span>
    );
  return (
    <>
      {finding.status === "open" ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setErr(""); setConfirm(true); }}>
          Mark as fixed
        </button>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => set("open")} disabled={busy}>
          {busy ? "Undoing…" : "Undo"}
        </button>
      )}
      {finding.status === "marked_fixed" ? (
        <span className="text-xs text-muted">Not fixed after all? Undo puts it back to Open.</span>
      ) : null}
      {err && !confirm ? <span role="alert" className="text-xs text-health-lagging">{err}</span> : null}
      <Dialog open={confirm} onClose={() => setConfirm(false)} title="Mark this as fixed?">
        <p className="text-sm leading-relaxed">
          {finding.scope === "server" ? (
            <>We&apos;ll keep watching for <strong>{watch}</strong>. If the problem doesn&apos;t come back, it&apos;s confirmed fixed. If it does, we reopen it.</>
          ) : (
            <>We&apos;ll keep watching for <strong>{watch}</strong>. If this problem doesn&apos;t show up in a new incident in that time, it&apos;s confirmed fixed. If it does, we reopen it. Some causes only show up when the server is busy, so give it a few busy evenings.</>
          )}
        </p>
        {CONFIG_RULE_IDS.includes(finding.ruleId) ? (
          <p className="mt-2 text-sm text-muted">For settings like memory size, restart the server first, then mark it as fixed. We check again once the server reports its new settings.</p>
        ) : null}
        {err ? <Alert className="mt-3">{err}</Alert> : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => set("marked_fixed")} disabled={busy}>
            {busy ? "Saving…" : "Mark as fixed"}
          </button>
        </div>
      </Dialog>
    </>
  );
}
