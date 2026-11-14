import { brand } from "@tickdoctor/shared";

export const siteUrl = process.env.WEB_PUBLIC_URL ?? "http://localhost:3000";

type NavItem = { href: string; label: string; available?: boolean };

/**
 * Links with `available: false` point at pages that don't exist yet and are hidden.
 * Flip them to true (or delete the flag) when the page ships.
 */
const allNavLinks: NavItem[] = [
  { href: "/#features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/demo", label: "Demo" },
];

const allFooterColumns: { title: string; links: NavItem[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/#features", label: "Features" },
      { href: "/pricing", label: "Pricing" },
      { href: "/demo", label: "Demo" },
      { href: "/changelog", label: "Changelog" },
    ],
  },
  {
    title: "Docs",
    links: [
      { href: "/docs", label: "Getting started" },
      { href: "/docs/findings", label: "Findings reference" },
      { href: "/docs/data-and-privacy", label: "Privacy and data" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/legal/privacy", label: "Privacy policy" },
      { href: "/legal/terms", label: "Terms of service" },
      { href: "/legal/mentions-legales", label: "Mentions légales" },
    ],
  },
];

const isAvailable = (l: NavItem) => l.available !== false;
export const navLinks = allNavLinks.filter(isAvailable);
export const footerColumns = allFooterColumns
  .map((c) => ({ ...c, links: c.links.filter(isAvailable) }))
  .filter((c) => c.links.length > 0);

export const meta = {
  home: {
    title: `${brand.name}: find out why your Minecraft server lags`,
    description:
      `${brand.name} explains Minecraft server lag in plain English: what changed, the worst chunks with coordinates, and what to fix. Free during the beta.`,
  },
  pricing: {
    title: `Pricing | ${brand.name}`,
    description:
      "Pro is free for everyone during the beta. Free, Pro and Network plans differ in servers, history and findings. Founding discount when paid plans launch.",
  },
} as const;

export const draftBanner =
  "Draft: this page is a placeholder and not legal advice. It has not been reviewed by a lawyer and may change before launch.";
