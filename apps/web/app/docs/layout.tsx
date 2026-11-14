import { DocsNav } from "@/components/docs/docs-nav";
import { docNav } from "@/lib/docs";

export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  const nav = await docNav();
  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 sm:px-6 sm:py-12 md:grid-cols-[14rem_minmax(0,1fr)] lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside>
        <DocsNav items={nav.map((n) => ({ href: n.href, title: n.title, group: n.group }))} />
      </aside>
      <div className="min-w-0 max-w-3xl">{children}</div>
    </div>
  );
}
