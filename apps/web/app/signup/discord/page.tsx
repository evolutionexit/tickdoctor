import type { Metadata } from "next";
import { DiscordComplete } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Finish creating your account", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function Page() {
  return <DiscordComplete />;
}
