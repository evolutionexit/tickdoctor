import type { Metadata } from "next";
import { IncidentsList } from "@/components/app/incidents-list";

export const metadata: Metadata = { title: "Incidents" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <IncidentsList id={id} />;
}
