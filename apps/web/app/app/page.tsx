import type { Metadata } from "next";
import { ServersOverview } from "@/components/app/servers-overview";

export const metadata: Metadata = { title: "Your servers" };

export default function Page() {
  return <ServersOverview />;
}
