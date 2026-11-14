import { LegalPage } from "@/components/legal-page";
import { docMetadata } from "@/lib/docs-meta";

const file = "content/legal/privacy.md";
// Legal pages stay noindex while they are drafts (go-public task: remove noindex once a lawyer has reviewed them).
export const generateMetadata = () => docMetadata(file, "Privacy policy", "/legal/privacy", { noindex: true });

export default function Page() {
  return <LegalPage file={file} fallbackTitle="Privacy policy" />;
}
