import { DocPage } from "@/components/docs/doc-page";
import { docMetadata } from "@/lib/docs-meta";

const file = "content/docs/index.md";
export const generateMetadata = () => docMetadata(file, "Documentation", "/docs");

export default function Page() {
  return <DocPage href="/docs" file={file} fallbackTitle="Documentation" />;
}
