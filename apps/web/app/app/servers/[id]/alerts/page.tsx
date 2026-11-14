import type { Metadata } from "next";
import { AlertsPage } from "@/components/app/alerts-page";

export const metadata: Metadata = { title: "Alerts" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AlertsPage id={id} />;
}
