import { notFound } from "next/navigation";
import { DOCS_PAGES } from "@tickdoctor/shared";
import { DocPage } from "@/components/docs/doc-page";
import { DOC_ENTRIES } from "@/lib/docs";
import { docMetadata } from "@/lib/docs-meta";

export const dynamicParams = false;
export const generateStaticParams = () => DOCS_PAGES.filter((p) => p !== "index").map((page) => ({ page }));

const entry = (page: string) => DOC_ENTRIES.find((e) => e.href === `/docs/${page}` && e.group === "Guides");

export async function generateMetadata({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  const e = entry(page);
  return e ? docMetadata(e.file, e.label, e.href) : {};
}

export default async function Page({ params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  const e = entry(page);
  if (!e) notFound();
  return <DocPage href={e.href} file={e.file} fallbackTitle={e.label} />;
}
