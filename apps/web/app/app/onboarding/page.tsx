import type { Metadata } from "next";
import { Onboarding } from "@/components/app/onboarding";

export const metadata: Metadata = { title: "Add a server" };

export default function Page() {
  return <Onboarding />;
}
