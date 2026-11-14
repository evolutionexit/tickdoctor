import { IncidentPage } from "@/components/app/incident-page";
import { DEMO_SERVER_ID } from "@/lib/demo";

export default async function Page({ params }: { params: Promise<{ incidentId: string }> }) {
  const { incidentId } = await params;
  return <IncidentPage serverId={DEMO_SERVER_ID} incidentId={incidentId} />;
}
