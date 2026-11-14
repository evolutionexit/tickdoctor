import Link from "next/link";
import { Markdown } from "@/components/markdown";
import { readDoc } from "@/lib/docs";
import { docMetadata } from "@/lib/docs-meta";

const file = "content/changelog.md";
export const generateMetadata = () => docMetadata(file, "Changelog", "/changelog");

export default async function Page() {
  const doc = await readDoc(file, "Changelog");
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{doc.title}</h1>
      {doc.description ? <p className="mt-3 text-lg text-muted">{doc.description}</p> : null}
      <div className="mt-8">
        {doc.missing ? (
          <div className="rounded-lg border border-dashed border-line bg-surface p-8 text-center" role="status">
            <p className="text-lg font-semibold">Coming soon</p>
            <p className="mt-1 text-sm text-muted">The first entries will show up here.</p>
            <Link href="/docs" className="btn btn-ghost btn-sm mt-4">Read the docs</Link>
          </div>
        ) : (
          <Markdown md={doc.body} variant="doc" />
        )}
      </div>
    </div>
  );
}
