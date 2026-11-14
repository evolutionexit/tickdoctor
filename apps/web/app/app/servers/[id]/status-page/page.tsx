import type { Metadata } from "next";
import { StatusPageSettings } from "@/components/app/status-page-settings";

export const metadata: Metadata = { title: "Status page" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StatusPageSettings id={id} />;
}
