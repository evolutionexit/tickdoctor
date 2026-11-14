"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError, friendlyError } from "@/lib/api";
import { usePolled } from "@/lib/hooks";
import { useServers } from "@/lib/servers-context";
import type { AgentSetup } from "@/lib/types";
import { Alert, Card, Dialog, EmptyState, ErrorState, Field, Skeleton } from "../ui";
import { AgentSetupPanel } from "./agent-setup";

export function ServerSettings({ id }: { id: string }) {
  const router = useRouter();
  const servers = useServers();
  const detail = usePolled(() => api.server(id), `settings-${id}`);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [nameErr, setNameErr] = useState("");
  const [saved, setSaved] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateErr, setRotateErr] = useState("");
  const [newSetup, setNewSetup] = useState<AgentSetup | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState("");

  const current = detail.data?.name;
  useEffect(() => {
    if (current !== undefined) setName(current);
  }, [current]);

  if (!detail.data && detail.loading)
    return (
      <div role="status" aria-label="Loading settings" className="mx-auto max-w-2xl space-y-4">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    );
  if (!detail.data) {
    if (detail.error instanceof ApiError && detail.error.code === "not_found")
      return (
        <EmptyState title="We can't find that server" action={<Link href="/app" className="btn btn-primary">Back to your servers</Link>}>
          <p>It may have been deleted, or the link is wrong.</p>
        </EmptyState>
      );
    return <ErrorState title="Couldn't load the settings" message={friendlyError(detail.error)} onRetry={detail.reload} />;
  }
  const s = detail.data;

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaved(false);
    const t = name.trim();
    if (!t) return setNameErr("The name can't be empty.");
    if (t.length > 60) return setNameErr("Keep it under 60 characters.");
    setNameErr("");
    setSaving(true);
    try {
      await api.renameServer(id, t);
      setSaved(true);
      detail.reload();
      servers.reload();
    } catch (err) {
      setNameErr(err instanceof ApiError && err.fields?.name ? err.fields.name : friendlyError(err));
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    setRotating(true);
    setRotateErr("");
    try {
      setNewSetup(await api.rotateKey(id));
      setRotateOpen(false);
      detail.reload();
    } catch (err) {
      setRotateErr(friendlyError(err));
    } finally {
      setRotating(false);
    }
  }

  async function remove(e: React.FormEvent) {
    e.preventDefault();
    if (deleting || confirmName !== s.name) return;
    setDeleting(true);
    setDeleteErr("");
    try {
      await api.deleteServer(id, confirmName);
      servers.reload();
      router.replace("/app");
    } catch (err) {
      setDeleting(false);
      setDeleteErr(err instanceof ApiError && err.code === "invalid_request" ? "That doesn't match the server's name." : friendlyError(err));
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link href={`/app/servers/${id}`} className="text-sm text-muted hover:text-fg">
          ← Back to {s.name}
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Server settings</h1>
      </div>

      <Card>
        <h2 className="text-lg font-semibold">Name</h2>
        <form method="post" onSubmit={rename} noValidate className="mt-3 space-y-3">
          <Field label="Server name" error={nameErr}>
            {(p) => <input {...p} className="input" maxLength={60} autoComplete="off" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} />}
          </Field>
          <div className="flex items-center gap-3">
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving || name.trim() === s.name}>
              {saving ? "Saving…" : "Save name"}
            </button>
            <span role="status" className="text-sm text-muted">{saved ? "Saved." : ""}</span>
          </div>
        </form>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">API key</h2>
        <p className="mt-1 text-sm text-muted">
          {s.keyPrefix ? <>The plugin uses the key starting with <code className="inline">{s.keyPrefix}</code>. </> : "This server has no active key. "}
          We can&apos;t show the full key again. If you lost it, or it leaked, make a new one. The old key stops working immediately, so the plugin won&apos;t send data until you paste the new one.
        </p>
        {newSetup ? (
          <div className="mt-4 space-y-3">
            <Alert tone="success" title="New key created. The old one no longer works." />
            <AgentSetupPanel setup={newSetup} />
          </div>
        ) : (
          <button type="button" className="btn btn-ghost mt-4" onClick={() => setRotateOpen(true)}>
            Make a new key…
          </button>
        )}
        <Dialog open={rotateOpen} onClose={() => setRotateOpen(false)} title="Make a new API key?">
          <p className="text-sm">The current key stops working right away. Your server won&apos;t send data until you paste the new key into its config and restart it.</p>
          {rotateErr ? <Alert className="mt-3">{rotateErr}</Alert> : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRotateOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={rotate} disabled={rotating}>
              {rotating ? "Working…" : "Make a new key"}
            </button>
          </div>
        </Dialog>
      </Card>

      <Card className="!border-[color-mix(in_srgb,var(--health-lagging)_55%,transparent)]">
        <h2 className="text-lg font-semibold">Delete this server</h2>
        <p className="mt-1 text-sm text-muted">This removes the server and all its history, incidents and findings. It can&apos;t be undone.</p>
        <form method="post" onSubmit={remove} noValidate className="mt-4 space-y-3">
          <Field label={`Type “${s.name}” to confirm`} error={deleteErr}>
            {(p) => <input {...p} className="input" autoComplete="off" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />}
          </Field>
          <button type="submit" className="btn btn-ghost btn-sm" disabled={deleting || confirmName !== s.name} style={{ borderColor: "var(--health-lagging-text)", color: "var(--health-lagging-text)" }}>
            {deleting ? "Deleting…" : "Delete server"}
          </button>
        </form>
      </Card>
    </div>
  );
}
