import { IncidentsList } from "@/components/app/incidents-list";
import { DEMO_SERVER_ID } from "@/lib/demo";

export default function Page() {
  return <IncidentsList id={DEMO_SERVER_ID} />;
}
