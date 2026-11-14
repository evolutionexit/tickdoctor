import nodemailer from "nodemailer";
import { brand, EMAIL_TOKEN_TTL } from "@tickdoctor/shared";

// Auth emails: short plain text + minimal HTML, no tracking, no remote images. Product name from brand.ts.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
  secure: boolean;
  from: string;
}

export function smtpMailer(cfg: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.password ?? "" } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(msg) {
      await transport.sendMail({ from: cfg.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    },
  };
}

/** No SMTP configured: log that a mail would have been sent (no address, no link: tokens must not hit logs). */
export function logOnlyMailer(log: (line: string) => void): Mailer {
  return {
    async send(msg) {
      log(`mail not sent (SMTP_HOST unset): "${msg.subject}" to *@${msg.to.split("@")[1] ?? "?"}`);
    },
  };
}

/** Test helper: keeps every message in memory. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  fail = false;
  async send(msg: MailMessage) {
    if (this.fail) throw new Error("smtp down");
    this.sent.push(msg);
  }
  to(email: string) {
    return this.sent.filter((m) => m.to === email);
  }
  last(email: string) {
    return this.to(email).at(-1);
  }
  clear() {
    this.sent.length = 0;
  }
}

export const defaultFrom = () => `${brand.name} <noreply@${brand.domain}>`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function render(to: string, subject: string, lines: string[], link: { url: string; label: string }, footer: string): MailMessage {
  const text = [...lines, "", `${link.label}: ${link.url}`, "", footer, "", `— ${brand.name}`].join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
${lines.map((l) => `<p>${esc(l)}</p>`).join("\n")}
<p><a href="${esc(link.url)}">${esc(link.label)}</a></p>
<p style="color:#555;font-size:13px">${esc(footer)}<br>${esc(link.url)}</p>
<p style="color:#555;font-size:13px">— ${esc(brand.name)}</p>
</body></html>`;
  return { to, subject, text, html };
}

const IGNORE = "If you didn't ask for this, you can ignore this email.";

/** Phase 8: confirmation that the account is gone. No links, no data beyond the address it is sent to. */
function accountDeleted(to: string): MailMessage {
  const subject = `Your ${brand.name} account was deleted`;
  const lines = [
    `Your ${brand.name} account and everything stored for it (servers, metrics, incidents, findings, alert and status page settings) have been deleted.`,
    "This can't be undone. Messages already posted to Discord by alerts stay in Discord.",
  ];
  const text = [...lines, "", `— ${brand.name}`].join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
${lines.map((l) => `<p>${esc(l)}</p>`).join("\n")}
<p style="color:#555;font-size:13px">— ${esc(brand.name)}</p>
</body></html>`;
  return { to, subject, text, html };
}

export const mails = {
  accountDeleted,
  verify: (to: string, url: string) =>
    render(
      to,
      `Confirm your email for ${brand.name}`,
      [
        `Welcome to ${brand.name}.`,
        `Confirm your email and choose your password to finish creating your account. The link works for ${EMAIL_TOKEN_TTL.verifyHours} hours.`,
      ],
      { url, label: "Confirm your email and choose your password" },
      "If you didn't sign up, ignore this email — nothing happens until the link is used.",
    ),
  magic: (to: string, url: string) =>
    render(
      to,
      `Your ${brand.name} sign-in link`,
      [`Use this link to sign in to ${brand.name}. It works once, for ${EMAIL_TOKEN_TTL.magicLinkMinutes} minutes.`],
      { url, label: "Sign in" },
      IGNORE,
    ),
  existingAccount: (to: string, url: string) =>
    render(
      to,
      `You already have a ${brand.name} account`,
      [
        `Someone (hopefully you) tried to sign up for ${brand.name} with this email address, but an account already exists.`,
        `Nothing was changed. Use this link to sign in; it works once, for ${EMAIL_TOKEN_TTL.magicLinkMinutes} minutes. If you forgot your password, you can also reset it from the sign-in page.`,
      ],
      { url, label: "Sign in" },
      IGNORE,
    ),
  reset: (to: string, url: string) =>
    render(
      to,
      `Reset your ${brand.name} password`,
      [`Use this link to choose a new password. It works once, for ${EMAIL_TOKEN_TTL.resetMinutes} minutes. All other sessions are signed out when you change it.`],
      { url, label: "Reset password" },
      `${IGNORE} Your password stays the same.`,
    ),
};
