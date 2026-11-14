import type { Metadata } from "next";
import { FindingsPage } from "@/components/app/findings-page";

export const metadata: Metadata = { title: "Findings" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FindingsPage id={id} />;
}
