import { DocPage } from "@/components/docs/doc-page";
import { docMetadata } from "@/lib/docs-meta";

const file = "content/docs/findings/index.md";
export const generateMetadata = () => docMetadata(file, "Findings reference", "/docs/findings");

export default function Page() {
  return <DocPage href="/docs/findings" file={file} fallbackTitle="Findings reference" />;
}
