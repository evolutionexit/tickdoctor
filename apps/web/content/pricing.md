# Pricing page copy (/pricing)

Source of truth for limits: `packages/shared/src/plans.ts`. Prices are display-only. Render numbers from plans.ts; the text below must be kept in sync.

## Intro

- Title: Pricing
- Intro line: Pro is free for everyone during the beta. When paid plans launch, early-access members get a founding discount.
- Banner: Early access, no payments yet. Pro is free for everyone during the beta, and nothing here can be bought today. Join the waitlist and early-access members get a founding discount when paid plans launch.
  <!-- TODO: exact founding-discount terms (amount, duration, who qualifies). No percentage, no lifetime promise until decided. -->

## Plans

### Free

- Price: €0 / month
- Pitch: See that something is wrong and how serious it is, on one server.
- Button: Join early access
- Bullets:
  - 1 server
  - Findings: what is wrong, how serious, and when. Why, evidence and fixes are in Pro
  - Tuning tips
  - Discord alerts
  - Public status page with {brand.name} branding
  - Incident history for 7 days
  - Detailed graphs for 1 day, hourly trends for 7 days

### Pro

- Price: €7 / month
- Badge (optional): Most popular
- Pitch: For a server you care about: why it lags, the evidence and the fixes, plus more history. Free for everyone during the beta.
- Beta note: Free during the beta. Early-access members get a founding discount when paid plans launch.
  <!-- TODO: exact founding-discount terms. -->
- Button: Join early access
- Bullets:
  - 2 servers
  - Full findings: why, evidence, fixes, what changed and chunk coordinates
  - Tuning tips
  - Discord alerts
  - Customisable public status page
  - Incident history for 90 days
  - Detailed graphs for 3 days, hourly trends for 90 days

### Network

- Price: €19 / month
- Pitch: For small networks and communities running several servers.
- Button: Join early access
- Bullets:
  - 10 servers
  - Full findings: why, evidence, fixes, what changed and chunk coordinates
  - Tuning tips
  - Discord alerts
  - Customisable public status page
  - Incident history for 1 year
  - Detailed graphs for 7 days, hourly trends for 1 year

Note on wording: "detailed graphs" = raw samples (1/3/7 days), "hourly trends" = 1-hour rollups (7/90/365 days). Per-minute rollups (3/14/30 days) are not listed to keep the page simple.

## "Coming soon" dialog (shown when a paid plan button is used)

- Title: Paid plans aren't open yet
- Body: We're still building TickDoctor and nothing can be bought today. Leave your email and we'll let you know when {plan} opens. Pro is free for everyone during the beta, and early-access members get a founding discount when paid plans launch.
  <!-- TODO: exact founding-discount terms. -->
- Email placeholder: you@example.com
- Consent checkbox: Email me about early access to {brand.name}. You can ask us to remove your email at any time.
- Button: Join early access
- Success: Thanks! You're on the list. We'll email you when early access opens.
- Close button: Close
- Errors: same as the landing page form.

(Free plan button uses the same dialog, but with the body: "Early access isn't open yet. Leave your email and we'll let you know when you can create your free server.")

## Pricing FAQ

- Q: Can I pay today?
  A: Not yet. This is early access and there are no payments at all. Pro is free for everyone during the beta. Prices shown are our plan and may change before launch.
- Q: What happens when I hit a limit?
  A: You can't add more servers than your plan includes (the Add server button explains why), and history older than your plan keeps is deleted automatically: detailed graphs, hourly trends and incident history each have their own period, listed on this page. Nothing else is cut off.
- Q: What happens to my data if my plan ends or I downgrade?
  A: Nothing is deleted straight away. Your data stays for 14 days. After that, anything older than the Free plan's history (1 day of detailed graphs, 7 days of hourly trends and incidents) is trimmed. We email you before it happens, so you have time to export what you want or upgrade again. If you have more servers than Free allows, you choose which one stays active (by default the oldest). The others are paused: they stop collecting, show as paused in the app, and the plugin's `/tickdoctor status` says the server is paused because of the plan limit. Their history follows the Free plan's, and a paused server is deleted after 30 days. We email you when a server is paused and again 3 days before it is deleted. If you upgrade again, paused servers are switched back on immediately.
  <!-- TODO (not built yet, see docs/go-public.md): the 14-day grace period and the warning email do not exist in the code. Today retention trims by the server's plan immediately. Build both before the beta ends or any paid plan exists. Server pausing (owner picks the active server, others paused, deleted after 30 days, emails at pause and 3 days before deletion) is decided but not built either. Both are blockers for ending the beta or paid plans, not for going public with the beta. -->
- Q: Can I change or cancel my plan?
  A: Yes, once paid plans exist you'll be able to switch or cancel any time. TODO: confirm billing terms and refunds before launch.
- Q: Is there a discount for early supporters?
  A: Yes. Pro is free for everyone during the beta, and early-access members get a founding discount when paid plans launch. We'll share the details before anything is charged.
  <!-- TODO: exact founding-discount terms (amount, duration, who qualifies). No percentage, no lifetime promise until decided. -->
