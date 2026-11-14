import type { Metadata } from "next";
import { AccountPage } from "@/components/app/account-page";

export const metadata: Metadata = { title: "Account" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function Page({ searchParams }: { searchParams: SP }) {
  const { error } = await searchParams;
  return <AccountPage error={typeof error === "string" ? error : undefined} />;
}
