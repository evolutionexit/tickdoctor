"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { api, ApiError, friendlyError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { userPlanLabel } from "@/lib/plan";
import { useServers } from "@/lib/servers-context";
import type { AgentSetup } from "@/lib/types";
import { Alert, Card, Field, PageTitle } from "../ui";
import { AgentSetupPanel } from "./agent-setup";
import { WaitingForData } from "./waiting-for-data";

export function ResendVerification() {
  const { user } = useAuth();
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [err, setErr] = useState("");
  return (
    <div className="mt-3">
      {state === "sent" ? (
        <p>Sent. Check your inbox (and spam), then come back and try again.</p>
      ) : (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={state === "sending"}
          onClick={async () => {
            setState("sending");
            try {
              await api.resendVerification(user.email);
              setState("sent");
            } catch (e) {
              setState("idle");
              setErr(friendlyError(e));
            }
          }}
        >
          {state === "sending" ? "Sending…" : "Resend verification email"}
        </button>
      )}
      {err ? <p className="mt-2 text-health-lagging">{err}</p> : null}
    </div>
  );
}

export function Onboarding() {
  const { user } = useAuth();
  const servers = useServers();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<null | { kind: "verify" | "limit" | "other"; message: string }>(null);
  const [fieldErr, setFieldErr] = useState("");
  const [created, setCreated] = useState<{ id: string; name: string; setup: AgentSetup } | null>(null);
  const [connected, setConnected] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setProblem(null);
    const trimmed = name.trim();
    if (!trimmed) return setFieldErr("Give your server a name, like “Survival” or “Friends SMP”.");
    if (trimmed.length > 60) return setFieldErr("Keep it under 60 characters.");
    setFieldErr("");
    setBusy(true);
    try {
      const r = await api.createServer(trimmed);
      setCreated({ id: r.server.id, name: r.server.name, setup: r.setup });
      servers.reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === "email_not_verified") setProblem({ kind: "verify", message: "" });
      else if (err instanceof ApiError && err.code === "plan_limit") setProblem({ kind: "limit", message: "" });
      else if (err instanceof ApiError && err.code === "invalid_request" && err.fields?.name) setFieldErr(err.fields.name);
      else setProblem({ kind: "other", message: friendlyError(err) });
    } finally {
      setBusy(false);
    }
  }

  const step = !created ? 1 : connected ? 3 : 2;

  return (
    <div className="mx-auto max-w-2xl">
      <PageTitle title="Add a server" sub={<span aria-live="polite">Step {step} of 3: {["Name it", "Install the plugin", "All set"][step - 1]}</span>} />
      <ol className="mb-6 flex gap-1.5" aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <li key={n} className="h-1.5 flex-1 rounded-sm" style={{ background: n <= step ? "var(--accent)" : "var(--surface-2)" }} />
        ))}
      </ol>

      {!created ? (
        <Card>
          <form method="post" onSubmit={submit} noValidate className="space-y-4">
            {problem?.kind === "verify" ? (
              <Alert title="Verify your email first">
                We need to know your email works before you can add a server. Open the link we sent to {user.email}.
                <ResendVerification />
              </Alert>
            ) : null}
            {problem?.kind === "limit" ? (
              <Alert tone="warn" title="You've reached your server limit">
                Your {userPlanLabel(user)} plan has no free server slot left. Remove a server you don&apos;t use, or{" "}
                <Link href="/pricing" className="underline underline-offset-2">see what the other plans include</Link>.
              </Alert>
            ) : null}
            {problem?.kind === "other" ? <Alert>{problem.message}</Alert> : null}
            <Field label="Server name" hint="Only you see this. You can change it later." error={fieldErr}>
              {(p) => <input {...p} name="name" className="input" autoFocus maxLength={60} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} placeholder="Survival" />}
            </Field>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Creating…" : "Create server"}
            </button>
          </form>
        </Card>
      ) : (
        <div className="space-y-6">
          <Card>
            <h2 ref={headingRef} className="mb-4 text-lg font-semibold">
              Install the plugin on &ldquo;{created.name}&rdquo;
            </h2>
            <AgentSetupPanel setup={created.setup} />
          </Card>
          <WaitingForData serverId={created.id} onConnected={() => setConnected(true)} />
          {connected ? null : (
            <p className="text-sm text-muted">
              You can leave this page. Your server stays in your list, and its dashboard shows the same waiting state.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
