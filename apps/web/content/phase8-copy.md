# Phase 8 copy: beta plan, export, deletion, SEO

Conventions (same as `phase6-copy.md`): `## ` = area, `key: text` = one string. `{braces}` = variable filled by the app. Plain words, no exclamation marks. TODO = needs a decision. Free numbers come from `packages/shared/src/plans.ts`: detailed samples 1 day, per-minute averages 3 days, hourly averages 7 days, incidents and findings 7 days, 1 server.

## Account page: plan

- plan.label: Plan
- plan.value.beta: Pro (beta)
- plan.value.stored: {planName}
- plan.betaNote.title: About the beta
- plan.betaNote.body: During the beta every account gets Pro for free. When the beta ends, accounts go back to Free unless you upgrade, and the founding discount applies when you do. We'll announce the date, and we'll email you well before it. Free keeps less history (detailed samples 1 day, per-minute averages 3 days, hourly averages and incidents 7 days), so history older than that will be trimmed when the beta ends.
  <!-- TODO (Michel): exact founding-discount terms, see docs/go-public.md "Decision: end of the beta". Do not name a percentage or a date until decided. -->
- plan.betaNote.servers: Free includes 1 server. If you have more than one server when the beta ends, we'll ask you which one to keep.
  <!-- TODO (Michel): decide what happens to extra servers at the end of the beta (pause? read-only? pick one?). Remove this line if undecided. -->
- plan.betaNote.link: See plans and limits

## Account page: export

- export.heading: Your data
- export.button: Export my data
- export.button.busy: Preparing your file…
- export.hint: Downloads one JSON file with everything we hold about your account and your servers: account details, servers, incidents, findings, alerts, status page settings and history, and your waitlist entry if you have one. It never includes password hashes, API key hashes or your Discord webhook address.
- export.success: Your file is downloading. Large histories can take a moment.
- export.error.rateLimited: You've asked for a few exports already. Please try again in an hour.
- export.error.generic: We couldn't prepare your file. Please try again in a moment.

## Account page: delete account (danger zone)

- delete.heading: Delete my account
- delete.zone.label: Danger zone
- delete.intro: This permanently deletes your account and everything in it. It happens immediately and can't be undone. There is no grace period and we can't bring anything back, so export your data first if you want a copy.
- delete.list.title: What gets deleted
- delete.list.items:
  - All your servers and their full history
  - Incidents and findings
  - Alert settings and the alert log
  - Status pages (their web addresses become free again)
  - API keys (the plugin stops sending data)
  - Your Discord link
  - Your waitlist entry, if you signed up with this email
  - Your account and login sessions
- delete.discordNote: Alert messages already posted in your Discord channel stay in Discord. We can't remove them from there. You can delete the webhook in Discord if you want.
- delete.button: Delete my account
- delete.dialog.title: Delete your account for good?
- delete.dialog.body: This deletes your account, all your servers and all their data right now. It can't be undone.
- delete.dialog.email.label: Type your email address to confirm
- delete.dialog.email.placeholder: {email}
- delete.dialog.password.label: Your password
- delete.dialog.password.hint: We ask for your password to make sure it's really you.
- delete.dialog.confirm: Delete everything
- delete.dialog.confirm.busy: Deleting…
- delete.dialog.cancel: Keep my account
- delete.error.email: That doesn't match your account's email address.
- delete.error.password: That password isn't right.
- delete.error.rateLimited: Too many tries. Please wait a few minutes and try again.
- delete.error.generic: Something went wrong and your account was not deleted. Please try again, or write to {brand.supportEmail}.

## Goodbye page (shown after deletion)

- goodbye.title: Your account has been deleted
- goodbye.body: Your account, your servers and all their data are gone. We've sent you a short email to confirm. If you still have the plugin installed, remove it or clear `api-key` in its config; it will stop sending data on its own because its key no longer works.
- goodbye.note: Alert messages already posted in Discord stay there.
- goodbye.cta: Back to the home page
- goodbye.feedback: Anything we could have done better? Write to {brand.supportEmail}. We read everything.

## Email: account deleted

- subject: Your {brand.name} account was deleted
- body:
  - Your {brand.name} account and all its data were deleted today, as you asked.
  - Your servers, history, alerts, status pages and API keys are gone, and this can't be undone.
  - If you didn't do this, write to {brand.supportEmail} right away.
- Note: no links, no data, no tracking.

## SEO titles and descriptions (descriptions at most 160 characters)

The brand name comes from brand.name. Titles stay under about 60 characters.

- `/`
  - Title: {brand.name}: find out why your Minecraft server lags
  - Description: {brand.name} explains Minecraft server lag in plain English: what changed, the worst chunks with coordinates, and what to fix. Free during the beta.
- `/pricing`
  - Title: Pricing | {brand.name}
  - Description: Pro is free for everyone during the beta. Free, Pro and Network plans differ in servers, history and findings. Founding discount when paid plans launch.
- `/demo`
  - Title: Live demo | {brand.name}
  - Description: Look around a read-only example server: live TPS and MSPT graphs, a lag incident with its findings, and fixes. No sign-up needed.
- `/docs`
  - Title: Documentation | {brand.name}
  - Description: Install the {brand.name} plugin, set it up, read what it sends, and fix what it finds. Guides for Paper servers, including small ones.
- `/docs/*` (pattern)
  - Title: {page.title} | {brand.name} docs
  - Description: {page.description} (use the page's own description from its front matter; if missing, take its first sentence and cut it at 160 characters)
- `/docs/findings/*` (pattern)
  - Title: {finding.title}: what it means and how to fix it | {brand.name}
  - Description: What the "{finding.title}" finding means on a Minecraft server, how to confirm it, and numbered steps to fix it.
- `/changelog`
  - Title: Changelog | {brand.name}
  - Description: What changed in {brand.name} and when, in plain words. Newest first.
- `/legal/privacy`
  - Title: Privacy policy (draft) | {brand.name}
  - Description: What personal data {brand.name} processes, why, how long we keep it, and how to export or delete it. Working draft, not yet legally reviewed.
- `/legal/terms`
  - Title: Terms of service (draft) | {brand.name}
  - Description: The rules for using {brand.name}: accounts, plans, the beta, liability and changes. Working draft, not yet legally reviewed.
- `/legal/mentions-legales`
  - Title: Mentions légales (draft) | {brand.name}
  - Description: Legal notice for {brand.name}: publisher, host and contact. Working draft, to be completed.
- `/legal/*` (pattern for any other legal page)
  - Title: {page.title} | {brand.name}
  - Description: {page.title} for {brand.name}. Working draft, not yet legally reviewed.
- noindex pages (no copy needed): /app/**, login, sign-up, status pages until go-public.
