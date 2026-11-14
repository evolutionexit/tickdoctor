import type { Metadata } from "next";
import { ServerDashboard } from "@/components/app/server-dashboard";

export const metadata: Metadata = { title: "Server" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ServerDashboard id={id} />;
}
