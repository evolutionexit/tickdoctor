import type { Metadata } from "next";
import { ServerSettings } from "@/components/app/server-settings";

export const metadata: Metadata = { title: "Server settings" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ServerSettings id={id} />;
}
