import type { Metadata } from "next";
import { VerifyEmail } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Verify your email", robots: { index: false, follow: false }, referrer: "no-referrer" };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return <VerifyEmail token={one(sp.token)} kind={one(sp.kind)} />;
}
