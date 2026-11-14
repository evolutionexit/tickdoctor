import { ServerTabs } from "@/components/app/server-tabs";

export default async function ServerLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <ServerTabs id={id} />
      {children}
    </>
  );
}
