"use client";

import Link from "next/link";
import type { FindingView } from "@tickdoctor/shared";
import { FindingCard } from "../finding-card";
import { FindingStatusChip, TipsNote } from "./bits";
import { useServerEnv } from "@/lib/server-env";
import { FindingActions } from "./finding-actions";

export function TipCards({ tips, onChange }: { tips: FindingView[]; onChange: (f: FindingView) => void }) {
  return (
    <div className="space-y-3">
      {tips.map((f) => (
        <FindingCard key={f.id} finding={f} calm className="shadow-none" badges={<FindingStatusChip f={f} />} actions={<FindingActions finding={f} onChange={onChange} />} />
      ))}
    </div>
  );
}

/** Findings page: always-visible calm section. */
export function TuningTipsSection({ tips, onChange }: { tips: FindingView[]; onChange: (f: FindingView) => void }) {
  return (
    <section aria-labelledby="tips-h" className="mt-10 border-t border-line pt-6">
      <h2 id="tips-h" className="text-lg font-semibold">Tuning tips</h2>
      <div className="mb-4 mt-1"><TipsNote /></div>
      {tips.length === 0 ? <p className="text-sm text-muted">No tips right now. Your setup follows what Paper recommends.</p> : <TipCards tips={tips} onChange={onChange} />}
    </section>
  );
}

/** Dashboard: small collapsed section, hidden when there are no tips. */
export function TuningTipsCollapsed({ serverId, tips }: { serverId: string; tips: FindingView[] }) {
  const { base } = useServerEnv();
  if (tips.length === 0) return null;
  return (
    <details className="rounded-lg border border-line bg-surface p-4 text-sm">
      <summary className="cursor-pointer font-medium">
        Tuning tips ({tips.length})
      </summary>
      <div className="mt-3 space-y-2">
        <TipsNote />
        <ul className="list-disc space-y-1 pl-5">
          {tips.map((t) => <li key={t.id}>{t.title}</li>)}
        </ul>
        <Link href={`${base(serverId)}/findings#tips-h`} className="inline-block text-accent-text underline underline-offset-2">
          See the details
        </Link>
      </div>
    </details>
  );
}
