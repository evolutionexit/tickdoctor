import { Markdown } from "./markdown";
import { readDoc } from "@/lib/docs";
import { draftBanner } from "@/lib/site";

/** Legal drafts are Markdown by the copywriter (content/legal/*.md). The big DRAFT banner stays until a lawyer has reviewed them. */
export async function LegalPage({ file, fallbackTitle }: { file: string; fallbackTitle: string }) {
  const doc = await readDoc(file, fallbackTitle);
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
      <div role="note" className="mb-8 rounded-md border-2 border-[var(--health-degraded)] bg-surface p-4 text-base font-semibold">
        <span style={{ color: "var(--health-degraded-text)" }}>{draftBanner}</span>
      </div>
      <h1 className="text-4xl font-bold tracking-tight">{doc.title}</h1>
      <div className="mt-8">
        {doc.missing ? <p className="text-muted">Coming soon.</p> : <Markdown md={doc.body} variant="doc" />}
      </div>
    </div>
  );
}
