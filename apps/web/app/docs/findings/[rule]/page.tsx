import { notFound } from "next/navigation";
import { RULE_IDS } from "@tickdoctor/shared";
import { DocPage } from "@/components/docs/doc-page";
import { DOC_ENTRIES } from "@/lib/docs";
import { docMetadata } from "@/lib/docs-meta";

export const dynamicParams = false;
export const generateStaticParams = () => RULE_IDS.map((rule) => ({ rule }));

const entry = (rule: string) => DOC_ENTRIES.find((e) => e.href === `/docs/findings/${rule}`);

export async function generateMetadata({ params }: { params: Promise<{ rule: string }> }) {
  const { rule } = await params;
  const e = entry(rule);
  return e ? docMetadata(e.file, e.label, e.href) : {};
}

export default async function Page({ params }: { params: Promise<{ rule: string }> }) {
  const { rule } = await params;
  const e = entry(rule);
  if (!e) notFound();
  return <DocPage href={e.href} file={e.file} fallbackTitle={e.label} />;
}
