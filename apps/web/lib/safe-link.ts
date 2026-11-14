/** Links the Markdown renderer may emit. Everything else is rendered as plain text. */
export const LINK_HOSTS: readonly string[] = ["discord.com", "docs.papermc.io", "spark.lucko.me"]; // hosts our own findings/docs text links to

export type SafeLink = { kind: "internal" | "external"; href: string };

export function safeLink(url: string): SafeLink | null {
  if (/[\\\s\u0000-\u001f\u007f]/.test(url)) return null;
  if (url.startsWith("/")) return url.startsWith("//") ? null : { kind: "internal", href: url };
  if (!url.startsWith("https://")) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    if (!LINK_HOSTS.includes(u.hostname)) return null;
    return { kind: "external", href: url };
  } catch {
    return null;
  }
}
