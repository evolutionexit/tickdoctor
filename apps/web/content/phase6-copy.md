# Phase 6 copy: incidents, findings, alerts

Conventions (same as `landing.md`): `## ` = page, `key: text` = one string. `{braces}` = variable filled by the app. Plain words: "lag", "slow ticks" first, jargon only with a one-line explanation. No exclamation marks, no hype. TODO = needs a decision.

Glossary (use these exact explanations in tooltips, `?` popovers and the docs):
- Tick: the server's heartbeat. It does its work 20 times a second, so each tick has 50 ms.
- TPS: ticks per second. 20 is perfect; lower means the server is falling behind.
- MSPT: milliseconds per tick. Under 50 ms is fine; above 50 ms the server can't keep up.
- Chunk: a 16 × 16 block column of the world, the unit the server loads and updates.

---

## Server tabs (shared by all pages under /app/servers/[id])

- tab.dashboard: Dashboard
- tab.incidents: Incidents
- tab.findings: Findings
- tab.alerts: Alerts
- tab.statusPage: Status page
- tab.settings: Settings
- tab.incidents.badge (open count): {n} open
- tab.findings.badge (open, non-tip count): {n}
- aria.tabs: Server sections

---

## Incidents list (/app/servers/[id]/incidents)

- page.title: Incidents
- page.intro: An incident is a stretch of time when your server lagged. TickDoctor opens one when the server falls behind, saves a snapshot of that moment, and closes it when things are back to normal.
- filter.label: Show
- filter.all: All
- filter.open: Still happening
- filter.closed: Over
- col.severity: Severity
- col.started: Started
- col.duration: Lasted
- col.trigger: What triggered it
- col.worst: Worst moment
- col.cause: Most likely cause
- col.findings: Findings
- cell.worst: Slowest ticks {peakMspt} ms · lowest TPS {minTps}
- cell.worst.noTps: Slowest ticks {peakMspt} ms
- cell.duration.open: {duration} so far
- cell.cause.none: No clear cause found
- cell.findings: {n} finding | {n} findings
- row.open.chip: Happening now
- severity.medium: Medium
- severity.high: High
- severity.critical: Critical
- severity.medium.hint: Players noticed lag spikes.
- severity.high.hint: Serious lag. Ticks took over 100 ms or TPS fell under 15.
- severity.critical.hint: The server was close to unusable. Ticks took over 250 ms or TPS fell under 10.
- banner.open.title: Lag is happening right now
- banner.open.body: Started {ago}. Slowest ticks so far: {peakMspt} ms. We'll update this page as it goes.
- banner.open.link: Open the incident
- empty.title: No incidents yet. That's good news.
- empty.body: Your server hasn't lagged since TickDoctor started watching. If it does, you'll find it here, with what changed and what to try.
- empty.filtered.title: No incidents match this filter
- empty.filtered.body: Try "All" to see everything.
- empty.filtered.action: Show all incidents
- loading: Loading incidents…
- error.title: Couldn't load incidents
- error.body: Something went wrong on our side. Please try again in a moment.
- error.retry: Try again

---

## Incident page (/app/servers/[id]/incidents/[incidentId])

### Header and summary
- back: All incidents
- title: Lag on {date}, {time}
- title.open: Lag in progress since {time}
- status.open: Still happening
- status.closed.recovered: Over. The server recovered at {time}.
- status.closed.offline: Over. The server went offline at {time}.
- summary.duration: Lasted
- summary.peak: Slowest ticks
- summary.peak.hint: The slowest 5 % of ticks took up to {peakMspt} ms. A healthy server stays under 50 ms.
- summary.tps: Lowest TPS
- summary.tps.hint: 20 is perfect. Below 18 players start to notice.
- summary.players: Players online
- summary.source.rollup: Detailed data from this time has already been summarised, so some numbers are rougher than usual.

### Trigger in plain words
- trigger.label: What triggered it
- trigger.mspt: Ticks were too slow. The slowest 5 % of ticks took longer than 50 ms for a while. The server only has 50 ms per tick, so anything above that means it can't keep up.
- trigger.tps: The server fell behind. TPS stayed under 18 for 90 seconds, even though individual ticks may not have looked slow. This usually means short, heavy freezes, for example while the world is being generated.

### Findings (causes)
- findings.heading: What we found
- findings.intro: Most likely cause first. Each finding says what's wrong, the evidence, and what to do.
- findings.empty.title: We didn't find a clear cause
- findings.empty.body: The server lagged, but nothing in the data points at one thing we can name with confidence. We'd rather say that than guess.
- findings.empty.next.heading: What you can try
- findings.empty.next.1: Look at "What changed?" below. A plugin that was updated or a number that jumped is often the lead.
- findings.empty.next.2: Check the timeline for a restart or a config change just before the lag.
- findings.empty.next.3: If it keeps coming back, run a spark profile during the next lag. spark shows exactly which code is slow.
- findings.empty.next.4: Come back after the next incident. With more history, TickDoctor's comparison gets better.
- findings.empty.nosnapshot: We didn't get a snapshot of this moment (the plugin may have been busy or offline), so there was less to go on.

### What changed?
- changed.heading: What changed?
- changed.intro: We compare the lag with how your server looks when it's healthy. Numbers marked "notable" are at least 1.5 times higher than usual, or are a plugin or setting change.
- changed.baseline: Compared with {healthyMinutes} minutes of healthy time, {from} to {to}.
- changed.baseline.long: Compared with {healthyHours} hours of healthy time, {from} to {to}.
- changed.none.title: No healthy baseline yet
- changed.none.body: TickDoctor needs some time with your server running well before it can say what's different. Until then we can only show the numbers during the lag, without a "usual" to compare to. The more normal hours it sees, the more useful this gets.
- changed.col.what: What
- changed.col.during: During the lag
- changed.col.usual: Usually
- changed.col.change: Change
- changed.usual.none: not enough data
- changed.toggle.notable: Only notable changes
- changed.toggle.all: Show everything
- changed.empty.notable: Nothing stood out. Show everything to see all numbers.
- changed.badge.notable: Notable
- changed.group.metric: Server numbers
- changed.group.entityType: Mobs and items
- changed.group.tileEntityType: Machines and blocks (hoppers, furnaces, chests…)
- changed.group.world: Worlds
- changed.group.plugin: Plugins
- changed.group.config: Settings
- changed.group.jvm: Java memory
- changed.plugin.added: Installed
- changed.plugin.removed: Removed
- changed.plugin.updated: Updated {from} → {to}
- changed.config.changed: Changed from {from} to {to}
- changed.jvm.changed: Changed from {from} to {to}
- changed.plugin.window: Changes between the end of the healthy period and the start of the lag.

How ratios read (`ratio` = during ÷ usual). Rules for the web dev, first match wins:
- ratio.up.many (ratio ≥ 10): {n}× usual   (round to whole number, e.g. "14× usual")
- ratio.up (1.5 ≤ ratio < 10): {n}× usual   (one decimal, e.g. "3.2× usual")
- ratio.double (1.9 ≤ ratio ≤ 2.1): twice usual
- ratio.up.slight (1.1 ≤ ratio < 1.5): a bit above usual
- ratio.same (0.9 < ratio < 1.1): about usual
- ratio.down.slight (0.6 < ratio ≤ 0.9): a bit below usual
- ratio.half (0.4 ≤ ratio ≤ 0.6): half of usual
- ratio.down (0.1 < ratio < 0.4): {percent} % of usual
- ratio.down.most (ratio ≤ 0.1): almost none
- ratio.fromZero (usual = 0, during > 0): new. Usually none.
- ratio.noUsual (usual null): no usual to compare
- ratio.tps: {during} TPS (usually {usual})   (TPS and similar "lower is worse" numbers show the values, not a ratio)
- ratio.aria: {label}: {during} during the lag, {ratioText}.

### Worst chunks
- chunks.heading: Worst chunks
- chunks.intro: The busiest spots in the world when the snapshot was taken, ranked by how many entities and block entities (hoppers, furnaces, chests…) they hold. Lag often hides in one of these. Walk there and look.
- chunks.col.where: Where
- chunks.col.entities: Entities
- chunks.col.blockEntities: Block entities
- chunks.col.top: Mostly
- chunks.where: {world}, around X {x}, Z {z}
- chunks.where.chunk: Chunk {cx}, {cz}
- chunks.copy: Copy /tp
- chunks.copy.tooltip: Copies a teleport command. Paste it into the game chat or the server console. It puts you at the middle of this chunk, at your current height. You need operator rights, and in another world you have to be in that world first.
- chunks.copied: Copied
- chunks.copy.failed: Couldn't copy. Select the command and copy it yourself.
- chunks.empty: No chunk details for this incident. They come from the snapshot, and this incident doesn't have one.
- chunks.world.summary: {world}: {chunks} chunks loaded · {entities} entities · {blockEntities} block entities
- chunks.estimated.hint: Counts for the busiest chunks are estimates.

### Snapshot
- snapshot.heading: Snapshot
- snapshot.intro: A picture of the server taken at {time}, just after it started to lag.
- snapshot.trigger.threshold: Taken automatically when the lag started
- snapshot.trigger.manual: Taken by you with a command in-game
- snapshot.trigger.requested: Requested from this website

### Timeline
- timeline.heading: Timeline
- timeline.intro: What happened from 30 minutes before the lag until it ended, oldest first.
- timeline.empty: Nothing else was recorded around this time.
- timeline.kind.incident_opened: Lag started
- timeline.kind.incident_closed: Back to normal
- timeline.kind.snapshot: Snapshot taken
- timeline.kind.severity_raised: Got worse
- timeline.kind.plugin_added: Plugin installed
- timeline.kind.plugin_removed: Plugin removed
- timeline.kind.plugin_updated: Plugin updated
- timeline.kind.server_start: Server started
- timeline.kind.crash: Server crashed
- timeline.kind.config_changed: Settings changed
- timeline.label.examples (the API writes the label; these are the shapes we expect, keep them in this style):
  - incident_opened: Lag started. Slowest ticks passed 50 ms.
  - incident_closed: Back to normal after {duration}.
  - snapshot: Snapshot saved ({players} players online).
  - severity_raised: Got worse: now {severity}.
  - plugin_added: Plugin {name} {version} installed.
  - plugin_removed: Plugin {name} removed.
  - plugin_updated: Plugin {name} updated {from} → {to}.
  - server_start: Server started.
  - crash: Server crashed or stopped without saving.
  - config_changed: View distance changed from {from} to {to}.
- timeline.before: Before the lag
- timeline.during: During the lag

### States
- incident.loading: Loading incident…
- incident.notFound.title: Incident not found
- incident.notFound.body: It may have been deleted, or the link may be wrong.
- incident.notFound.action: Back to incidents
- incident.error.body: Couldn't load this incident. Please try again in a moment.

---

## Findings page (/app/servers/[id]/findings)

- page.title: Findings
- page.intro: Things TickDoctor found that are slowing your server down, most serious first. Each one says what's wrong, the evidence, and what to do.
- filter.status.label: Status
- filter.status.active: Needs attention
- filter.status.open: Open
- filter.status.marked_fixed: Marked fixed (watching)
- filter.status.confirmed_fixed: Confirmed fixed
- filter.status.all: All
- filter.severity.label: Severity
- filter.severity.any: Any severity
- filter.severity.medium: Medium or higher
- filter.severity.high: High or higher
- filter.severity.critical: Critical only
- filter.rule.label: Type
- filter.rule.any: All types
- filter.reset: Clear filters
- count: {n} finding | {n} findings
- seen: Seen {n} time | Seen {n} times
- seen.first: First seen {date}
- seen.last: Last seen {date}
- seen.incidents: In {n} incident | In {n} incidents
- seen.server: Found by checking the server's setup, not tied to one incident.

### Status chips
- status.open: Open
- status.marked_fixed: Marked fixed – watching
- status.confirmed_fixed.owner: Confirmed fixed by you
- status.confirmed_fixed.auto: Confirmed fixed automatically
- status.open.hint: We found this and nobody has said it's fixed yet.
- status.marked_fixed.hint: You said you fixed it. We're watching to see whether it comes back.
- status.confirmed_fixed.owner.hint: You marked it fixed on {markedDate} and it hasn't come back. Confirmed {confirmedDate}.
- status.confirmed_fixed.auto.hint: The problem went away by itself, and we didn't see it again for long enough. Confirmed {confirmedDate}.
- status.reopened.note: This came back after you marked it fixed, so we reopened it.

### Mark as fixed
- fixed.button: Mark as fixed
- fixed.dialog.title: Mark this as fixed?
- fixed.dialog.body.server: We'll keep watching for 15 minutes. If the problem doesn't come back, it's confirmed fixed. If it does, we reopen it.
- fixed.dialog.body.incident: We'll keep watching for 72 hours. If this problem doesn't show up in a new incident in that time, it's confirmed fixed. If it does, we reopen it. Some causes only show up when the server is busy, so give it a few busy evenings.
- fixed.dialog.note.config: For settings like memory size, restart the server first, then mark it as fixed. We check again once the server reports its new settings.
- fixed.dialog.confirm: Mark as fixed
- fixed.dialog.cancel: Cancel
- fixed.toast: Marked as fixed. We're watching it.
- fixed.undo.button: Undo
- fixed.undo.hint: Not fixed after all? Undo puts it back to Open.
- fixed.undo.toast: Back to open.
- fixed.watching.server: Watching until {time} (15 minutes after you marked it).
- fixed.watching.incident: Watching until {time} (72 hours after you marked it).
- fixed.error.conflict: This finding changed in the meantime. Reload the page and try again.
- fixed.error.generic: Couldn't save that. Please try again in a moment.

### Empty states
- empty.none.title: No findings. Nothing slowing your server down.
- empty.none.body: TickDoctor checks your server's setup every few minutes and looks into every incident. When it finds something, it appears here.
- empty.active.title: Nothing needs attention
- empty.active.body: Every finding is either confirmed fixed or being watched. Change the status filter to see them.
- empty.filtered.title: No findings match these filters
- empty.filtered.action: Clear filters
- empty.confirmed.title: Nothing confirmed fixed yet
- empty.confirmed.body: Findings you fix show up here once they've stayed away long enough.
- loading: Loading findings…
- error.body: Couldn't load findings. Please try again in a moment.

### Tuning tips
- tips.heading: Tuning tips
- tips.intro: Small improvements we noticed in your setup. These don't cause lag, and they never trigger alerts. They're here for when you have a quiet minute.
- tips.count: {n} tip | {n} tips
- tips.empty: No tips right now. Your setup follows what Paper recommends.
- tips.collapse: Hide tips
- tips.expand: Show tips
- tips.badge: Tip, not a problem

### Finding card additions (around the rule text)
- card.evidence.heading: Evidence
- card.evidence.usual: usually {usual}
- card.fix.heading: What to do
- card.severity.info: Tip
- card.severity.low: Low
- card.severity.medium: Medium
- card.severity.high: High
- card.severity.critical: Critical
- card.chunks.heading: Where to look
- card.incidents.heading: Seen in these incidents
- card.advanced.note (shown before steps that edit a .yml file): Optional, for when the simple steps aren't enough.

---

## Alerts page (/app/servers/[id]/alerts)

- page.title: Alerts
- page.intro: Get a Discord message when your server has trouble, so you don't have to keep the dashboard open. Messages go to a channel you choose.
- master.label: Send alerts to Discord
- master.hint.off: Alerts are off. Nothing will be sent.
- master.hint.noWebhook: Add a webhook below first.

### How to connect Discord (5 steps)
- howto.heading: Connect Discord in 5 steps
- howto.1: In Discord, open the channel where alerts should go and click the gear icon (Edit Channel).
- howto.2: Go to Integrations, then Webhooks, and click New Webhook.
- howto.3: Give it a name if you like, then click Copy Webhook URL.
- howto.4: Paste the URL into the box below and click Save.
- howto.5: Click Send test alert. A message should appear in your channel within a few seconds.
- howto.note: You need the "Manage Webhooks" permission on that channel. Anyone with this URL can post to your channel, so don't share it. We store it encrypted and only show you the start of it.

### Fields
- field.webhook.label: Discord webhook URL
- field.webhook.hint: Looks like https://discord.com/api/webhooks/… Only Discord webhook links are accepted.
- field.webhook.placeholder: https://discord.com/api/webhooks/…
- field.webhook.saved: Saved: {masked}
- field.webhook.replace: Replace URL
- field.webhook.remove: Remove webhook
- field.webhook.remove.confirm: Remove this webhook? Alerts will stop until you add a new one.
- field.events.heading: Tell me when
- field.events.incidentOpened.label: Lag starts
- field.events.incidentOpened.hint: An incident opens at or above the minimum severity below, or gets worse and reaches it. At most once per incident.
- field.events.incidentResolved.label: Lag is over
- field.events.incidentResolved.hint: Sent when an incident you were told about ends.
- field.events.serverOffline.label: Server goes offline or comes back
- field.events.serverOffline.hint: Sent when we stop hearing from the server, and again when it's back.
- field.events.crash.label: Server crashed
- field.events.crash.hint: Sent when the server reports a crash, or starts up after it wasn't shut down cleanly.
- field.minSeverity.label: Minimum severity for "lag starts"
- field.minSeverity.hint: Lower severities still show on the website, they just don't send a message.
- field.minSeverity.medium: Medium and above (every incident)
- field.minSeverity.high: High and above (serious lag)
- field.minSeverity.critical: Critical only (near-unusable)
- field.offlineAfter.label: Count the server as offline after
- field.offlineAfter.hint: Minutes without data before we send an "offline" message. A short restart shouldn't wake you up, so a few minutes works well. Between 2 and 60.
- field.offlineAfter.unit: minutes
- field.cooldown.label: Quiet period between repeats
- field.cooldown.hint: If the same kind of alert happens again within this time, we skip it, so a server that keeps flapping doesn't flood your channel. "Lag is over" and "server is back" are never skipped. Between 5 minutes and 24 hours.
- field.cooldown.unit: minutes
- save: Save changes
- saved.toast: Saved.
- unsaved: You have unsaved changes.

### Quiet hours
- quiet.heading: Quiet hours
- quiet.explain: During quiet hours we don't send messages, so you can sleep. Critical incidents still come through, because that means the server is close to unusable. Everything else that happens in quiet hours is skipped for good; we don't send it later. You can see what was skipped in the delivery log.
- quiet.enabled.label: Use quiet hours
- quiet.start.label: From
- quiet.end.label: Until
- quiet.timeZone.label: Time zone
- quiet.timeZone.hint: Times are in this time zone. It can cross midnight, for example 22:00 to 08:00.
- quiet.summary: Quiet from {start} to {end} ({timeZone}). Critical incidents still come through.
- quiet.error.sameTime: Start and end can't be the same time.

### Webhook status
- status.none: No webhook yet
- status.untested: Not tested yet. Send a test alert to check it works.
- status.ok: Working. Last test or message went through.
- status.invalid: This webhook doesn't work any more. Replace it with a new URL to get alerts again.
- status.invalid.banner.title: Alerts are paused: Discord rejected the webhook
- status.invalid.banner.body: Discord says this webhook doesn't exist any more, or we're not allowed to use it. It may have been deleted. Create a new one and paste it above. Until then we won't try to send anything.

### Test alert
- test.button: Send test alert
- test.sending: Sending…
- test.ok: Test sent. Check your Discord channel.
- test.needSave: Save the webhook first, then send the test.
- test.ignores: The test ignores quiet hours and the quiet period.
- test.error.rateLimited: You've sent a few tests in a row. Please wait about 10 minutes.
- test.error.invalidUrl: That doesn't look like a Discord webhook URL. It should start with https://discord.com/api/webhooks/
- test.error.notFound: Discord says this webhook doesn't exist any more. It may have been deleted. Create a new one in Discord and paste it here.
- test.error.unreachable: We couldn't reach Discord. This is usually temporary. Try again in a minute.
- test.error.discordRateLimited: Discord asked us to slow down. Try again in a minute.
- test.error.serverError: Discord had a problem on its side. Try again in a few minutes.
- test.error.generic: The test didn't go through. Check the URL and try again.

### Saving errors
- save.error.invalidUrl: That isn't a Discord webhook URL. It should look like https://discord.com/api/webhooks/123…/abc…
- save.error.enabledNoWebhook: Add a webhook before turning alerts on.
- save.error.quietTime: Times must look like 22:00.
- save.error.plan: Discord alerts aren't included in your plan.
- save.error.generic: Couldn't save. Please try again in a moment.

### Delivery log
- log.heading: Recent alerts
- log.intro: Every message we sent, or skipped on purpose, in the last 30 days.
- log.col.when: When
- log.col.event: What
- log.col.result: Result
- log.empty: Nothing yet. Alerts and tests show up here.
- log.event.incident_opened: Lag started
- log.event.incident_resolved: Lag over
- log.event.server_offline: Server offline
- log.event.server_back: Server back
- log.event.crash: Crash
- log.event.test: Test message
- log.status.sent: Sent
- log.status.failed: Couldn't send
- log.status.suppressed_cooldown: Skipped: same alert sent recently
- log.status.suppressed_quiet: Skipped: quiet hours
- log.status.suppressed_disabled: Skipped: this alert type is turned off
- log.status.failed.hint: Discord didn't accept the message. If this keeps happening, test the webhook.
- log.incident.link: View incident

---

## Discord alert messages

Rules: plain embed, no @mentions, no emoji spam, no hype. Title is the embed title, then 1–2 lines. Every message ends with the link (embed URL = {link}, also written as "Open in TickDoctor"). Placeholders: {server}, {severity}, {peakMspt} (ms), {minTps}, {duration}, {findings} (up to two finding titles, joined by "; "), {time}, {minutes}, {link}. Lines with a missing value are left out, never shown as "null".

- alert.incident_opened.title: {server} is lagging ({severity})
- alert.incident_opened.body: Slowest ticks reached {peakMspt} ms and TPS dropped to {minTps}.
  Likely cause: {findings}
- alert.incident_opened.body.noFinding: Slowest ticks reached {peakMspt} ms and TPS dropped to {minTps}. We're still looking for the cause; details are in TickDoctor.
- alert.incident_opened.raised.title: {server} got worse ({severity})
- alert.incident_opened.raised.body: The lag that started earlier is now {severity}. Slowest ticks: {peakMspt} ms, lowest TPS {minTps}.
- alert.incident_resolved.title: {server} is back to normal
- alert.incident_resolved.body: The lag lasted {duration}. Worst moment: slowest ticks {peakMspt} ms, lowest TPS {minTps}.
  What we found: {findings}
- alert.incident_resolved.body.noFinding: The lag lasted {duration}. Worst moment: slowest ticks {peakMspt} ms, lowest TPS {minTps}. We didn't find a clear cause.
- alert.server_offline.title: {server} is offline
- alert.server_offline.body: We haven't heard from the server for {minutes} minutes. It may have stopped, crashed, or lost its connection.
- alert.server_back.title: {server} is back online
- alert.server_back.body: The server is sending data again. It was offline for {duration}.
- alert.crash.title: {server} crashed
- alert.crash.body: The server reported a crash, or started after it wasn't shut down cleanly (at {time}). Check the server log for the reason.
- alert.test.title: TickDoctor test message
- alert.test.body: This channel is connected to {server}. You'll get a message here when the server lags, goes offline or crashes.
- alert.footer: TickDoctor · alerts can be changed in the Alerts tab
- alert.link.label: Open in TickDoctor
- severity words in Discord: medium, high, critical (lowercase, in brackets in the title)
