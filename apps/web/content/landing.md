# Landing page copy (/)

Conventions: `## ` = section, `- Field: value` = one component prop. Text in `{braces}` is a variable. "TODO" = needs a decision or a check.

## 1. Hero

- Headline: Find out why your Minecraft server lags — in plain English.
- Headline (tighter variant, optional A/B): Your server lagged. Here's why, and what to fix.
- Subheadline: TickDoctor watches your server around the clock. When lag hits, it captures what changed and tells you what to fix, with coordinates.
- Eyebrow (above headline, optional): Early access, join the waitlist
- Form:
  - Email label (visually hidden): Email address
  - Email placeholder: you@example.com
  - Button label: Join the waitlist
  - Button label (submitting): Joining…
  - Consent checkbox: Email me about early access to {brand.name}. You can ask us to remove your email at any time.
  - Small print: Free during the beta. No credit card. We only use your email to tell you about early access, and you can ask us to remove your email at any time.
  - Success title: You're on the list.
  - Success message: Thanks! We'll email you when early access opens. No spam, and you can ask us to remove your email at any time.
  - Error, invalid email: That doesn't look like an email address. Could you check it?
  - Error, consent missing: Please tick the box so we know it's OK to email you.
  - Error, already on list (show as success, avoids leaking who signed up): use the success message.
  - Error, rate limited: Too many tries from your connection. Please wait a minute and try again.
  - Error, generic: Something went wrong on our side. Please try again in a moment.
- Proof bullets:
  - Built for Paper servers, including small ones on a Raspberry Pi or a cheap VPS.
  - Runs off the main thread and measures its own cost. TODO: verify in Phase 2 before stating any ms/tick figure (the mockup says "< 0.5 ms/tick", not measured yet).
  - No player IDs and no IP addresses are ever sent.
- Hero side card: the real finding component with the example from section 4.

## 2. The problem

- Title: Lag is easy to feel and hard to explain
- Body:
  Your TPS dropped. Players are complaining. By the time you open the console, everything looks fine again.

  A profiler like spark can tell you exactly where the time went, but only for the moment you ran it, and the report is written for people who read Java stack traces.
- Three short points:
  - Title: The TPS dropped. Body: You know something is wrong, not what.
  - Title: The profile is hard to read. Body: Method names and percentages, but no "do this".
  - Title: The lag is gone when you look. Body: Spikes are short, and nobody was running a profile.

## 3. How it works

- Title: Three steps, about five minutes
- Step 1:
  - Title: Install the plugin
  - Body: Drop one jar into your plugins folder and paste your server key. That's the whole setup.
- Step 2:
  - Title: It watches, quietly
  - Body: TickDoctor tracks tick time, entities, chunks and your host's health. When the server starts to lag, it captures a snapshot of that moment and compares it to how your server looks when it's healthy.
- Step 3:
  - Title: Read what's wrong
  - Body: You get findings in plain language: what's wrong, the evidence, and what to do about it. Optionally, a Discord message tells you as it happens.

## 4. Example finding

- Section title: What a finding looks like
- Section intro: Written like a doctor's note, not a stack trace. This is an example.
- Card:
  - Severity: High
  - Title: Item entities are piling up in one chunk
  - Explanation: Something is dropping items faster than they are picked up or removed, and they all sit in one place. Every one of those items is checked every tick, so the server spends much of its time on them. This is a common cause of sudden lag on survival servers, often from an item farm or a broken collection system.
  - Location: world, 1204, -388
  - Evidence (3 rows: label, value, your usual):
    - Item entities in chunk (75, -25): 2,340 (usually 12)
    - Tick time, 95th percentile: 87 ms (usually 18 ms; above 50 ms means lag)
    - Time spent on entities: 61% of the tick (usually 14%)
  - Suggested fix (steps):
    1. Go and look: `/tp @s 1204 70 -388`
    2. Find what is producing the items (a farm with a full or missing collection chest is the usual suspect) and fix or switch it off.
    3. Clear the pile with `/kill @e[type=item,x=1204,y=70,z=-388,distance=..32]`.
    4. To prevent a repeat, add a timed item cleanup or lower the item despawn rate in your Paper config.
  - Buttons: Copy /tp command · Mark as fixed
  - Footnote: Example data. TickDoctor checks again later and tells you if the problem is really gone.

## 5. Features

- Section title: What you get
- Items:
  1. Title: Incident snapshots. Line: When lag starts, we save what the server looked like right then, so you can look later.
  2. Title: "What changed?" Line: Compares a lag incident with your normal, healthy baseline and highlights what's different.
  3. Title: Worst chunks, with coordinates. Line: See which chunks hold the most entities and block updates, and teleport straight there.
  4. Title: Findings in plain language. Line: Each problem comes with the evidence and clear steps to fix it, no Java knowledge needed.
  5. Title: Host health. Line: Temperature, CPU throttling, swap and disk, which matters on a Raspberry Pi or a small VPS.
  6. Title: Discord alerts. Line: Get a message when your server starts lagging or goes down, with quiet hours so it doesn't wake you.
  7. Title: Public status page. Line: Share a simple page so your players can see if the server is up.

## 6. Comparison

- Section title: How it compares
- Intro: These tools solve different problems, and several are free (ServerAnalytics too). We think TickDoctor works best next to spark, not instead of it.
- Table (columns: Tool | Best at | What it doesn't try to do):
  - spark | An excellent, free profiler (bundled with Paper). Shows exactly which code is slow right now. | Watch your server over time, or explain results in plain language.
  - Plan | Deep player analytics (joins, playtime, activity) in a self-hosted web panel. | Diagnose lag causes. Performance graphs are there, but it's player-focused.
  - ServerAnalytics (Hangar, by clanme) | Free, hosted analytics with a dashboard: TPS, MSPT, memory, entity and chunk counts, a health score, player stats, alerts (email, webhook, browser push, in-game chat) and a public status page. | Its focus is monitoring and alerting. TickDoctor's focus is explaining causes: incident snapshots, "what changed?", plain-language fixes and host health (temperature, throttling, swap, disk).
  - TickDoctor | Diagnosis over time: lag incident snapshots, "what changed?", worst chunks, plain-language findings, host health. | Replace a profiler. For deep code-level digging, use spark.
- Closing: Use spark when you want to dig into the code. Use Plan to understand your players. Use TickDoctor when you want to know why the server lagged last night, and what to do first.
- Footnote: Tool descriptions are based on their public pages and may be out of date. Tell us if we got something wrong. TODO: re-check before launch (ServerAnalytics row checked against its Hangar page on 2026-11-09).

## 7. Pricing teaser

- Line: Pro is free for everyone during the beta. Early-access members get a founding discount when paid plans launch.
  <!-- TODO: exact founding-discount terms (amount, duration, who qualifies). Do not state a percentage or a lifetime promise until decided. -->
- Link label: See pricing
- Link: /pricing

## 8. FAQ

- Section title: Questions
- Q: Will it slow my server down?
  A: It is built not to. Heavy work runs off the main thread, and the plugin measures its own cost and reports it to you, so you can check. TODO: add measured overhead after Phase 2, do not state a number before.
- Q: What data does it collect?
  A: Server performance numbers (tick time, TPS, memory, entity and chunk counts), your plugin list and versions, server settings, and host health such as CPU, temperature and disk if available. We don't read your world files, chat or console. TODO: confirm the final list against the plugin once Phase 2 is done.
- Q: What about my players' privacy?
  A: The plugin sends no player IDs and no IP addresses, only how many players are online and ping values. We can't tell who your players are. You can delete your account and all its data at any time.
- Q: Which server software does it support?
  A: Paper 26.x for now. TODO: decide on Spigot, Purpur, Folia and others, and say so here.
- Q: Is it free?
  A: Yes, during the beta Pro is free for everyone, and nothing is charged. When paid plans launch, early-access members get a founding discount. There will also be a free plan for one server: it shows that something is wrong and how serious it is, and Pro adds why, the evidence and the fix.
  <!-- TODO: exact founding-discount terms (amount, duration, who qualifies). No percentage, no lifetime promise until decided. -->
- Q: When does it launch?
  A: We're building it now. Join the waitlist and we'll email you when early access opens. TODO: add a date only when we have one.
- Q: Do I need spark?
  A: No, but they work well together. spark is great for deep profiling and ships with Paper. TickDoctor tells you when and why to look.
- Q: Can I self-host it?
  A: Not at the moment. TickDoctor is a hosted service.

## 9. Final CTA

- Headline: Stop guessing why your server lags.
- Subline: Join the waitlist for early access. Free during the beta, no credit card.
- Form label (above the email field): Your email
- Button label: Join the waitlist
- Reuses the hero form copy for consent, small print, success and errors.
