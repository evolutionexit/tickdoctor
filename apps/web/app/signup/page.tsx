import type { Metadata } from "next";
import { SignupForm } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Sign up", robots: { index: false, follow: false } };

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function Page({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return <SignupForm next={one(sp.next)} />;
}
