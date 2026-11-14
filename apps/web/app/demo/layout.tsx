import type { Metadata } from "next";
import { brand } from "@tickdoctor/shared";
import { DemoShell } from "@/components/demo/demo-shell";
import { pageSocial } from "@/lib/og";

const title = `Live demo | ${brand.name}`;
const description = "Look around a read-only example server: live TPS and MSPT graphs, a lag incident with its findings, and fixes. No sign-up needed.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/demo" },
  ...pageSocial(title, description, "/demo"),
};

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return <DemoShell>{children}</DemoShell>;
}
