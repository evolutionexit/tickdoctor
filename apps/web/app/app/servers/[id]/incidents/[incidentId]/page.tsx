import type { Metadata } from "next";
import { IncidentPage } from "@/components/app/incident-page";

export const metadata: Metadata = { title: "Incident" };

export default async function Page({ params }: { params: Promise<{ id: string; incidentId: string }> }) {
  const { id, incidentId } = await params;
  return <IncidentPage serverId={id} incidentId={incidentId} />;
}
