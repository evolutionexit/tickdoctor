"use client";

import type { AgentSetup } from "@/lib/types";
import { Alert, CodeBlock } from "../ui";

/** The plaintext key, download button, config snippet and the three install steps. Shown once after creating or rotating a key. */
export function AgentSetupPanel({ setup }: { setup: AgentSetup }) {
  return (
    <div className="space-y-6">
      <Alert tone="warn" title="Copy your API key now">
        This is the only time we show it. If you lose it, you can make a new one in the server&apos;s settings (the old one stops working straight away).
      </Alert>

      <CodeBlock label="Your API key" text={setup.apiKey} copyLabel="Copy key" />

      <ol className="space-y-5">
        <li className="flex gap-3">
          <Step n={1} />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Download the plugin and drop it into your server&apos;s <code className="inline">plugins/</code> folder.</p>
            <a href={setup.downloadUrl} download className="btn btn-primary mt-3">
              Download plugin (v{setup.agentVersion})
            </a>
          </div>
        </li>
        <li className="flex gap-3">
          <Step n={2} />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Start the server once so the plugin makes its config, then paste these lines into <code className="inline">plugins/TickDoctor/config.yml</code>.
            </p>
            <div className="mt-3">
              <CodeBlock label="config.yml" text={setup.configSnippet} copyLabel="Copy snippet" />
            </div>
          </div>
        </li>
        <li className="flex gap-3">
          <Step n={3} />
          <div className="min-w-0 flex-1">
            <p className="font-medium">Restart the server.</p>
            <p className="mt-1 text-sm text-muted">Restart the server with your host&apos;s panel, or stop it and start it again. Not <code className="inline">/reload</code>: a reload isn&apos;t enough.</p>
          </div>
        </li>
      </ol>
    </div>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-sm border border-[var(--accent)] font-mono text-sm font-semibold text-accent-text">
      {n}
    </span>
  );
}
