import { FindingsPage } from "@/components/app/findings-page";
import { DEMO_SERVER_ID } from "@/lib/demo";

export default function Page() {
  return <FindingsPage id={DEMO_SERVER_ID} />;
}
