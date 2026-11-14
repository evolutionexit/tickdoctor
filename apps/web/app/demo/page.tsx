import { ServerDashboard } from "@/components/app/server-dashboard";
import { DEMO_SERVER_ID } from "@/lib/demo";

export default function Page() {
  return <ServerDashboard id={DEMO_SERVER_ID} />;
}
