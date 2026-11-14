# Status page copy (settings, public page, badge)

Conventions (same as `phase6-copy.md`): `## ` = page, `- key: text` = one string. `{braces}` = variable filled by the app. Plain words, no exclamation marks, no hype. TODO = needs a decision.

Public states map from the owner's health: healthy = operational, degraded = degraded, lagging = lagging, offline and waiting = offline. Every state is shown with an icon AND a word (never colour alone), using the health colours and icons from `brand.ts`.

---

## Settings page (/app/servers/[id]/status-page)

### Header
- tab: Status page
- page.title: Status page
- page.intro: A public page you can share with your players, so they can check whether the server is up without asking you. It is switched off until you turn it on, and it only shows what you choose below.

### Main switch
- enabled.label: Make the status page public
- enabled.hint.off: Off. Nobody can see this page, and its address shows "not found".
- enabled.hint.on: On. Anyone with the link can see the page.
- enabled.confirm.title: Make this page public?
- enabled.confirm.body: Anyone with the link will be able to see the information you have switched on below. Check the preview first. You can turn it off again at any time.
- enabled.confirm.button: Make it public
- enabled.toast.on: Your status page is public.
- enabled.toast.off: Your status page is now private.

### Address
- slug.label: Page address
- slug.prefix: {publicHost}/s/
- slug.hint: 3 to 40 characters: lowercase letters, numbers and single hyphens (for example "my-survival"). Pick something your players will recognise.
- slug.suggestion: Suggested: {slug}
- slug.warning: If you change the address, the old link stops working straight away.
- slug.error.invalid: Use 3 to 40 lowercase letters, numbers or single hyphens. It can't start or end with a hyphen.
- slug.error.reserved: This address can't be used. Please choose another.
- slug.error.taken: Someone already uses this address. Please choose another.

### Title
- title.label: Title
- title.hint: Shown at the top of the page and in link previews (Discord, social media). Up to 60 characters. It can be different from the server name you see in the app.
- title.error.empty: Please enter a title.
- title.error.long: The title can be at most 60 characters.

### What the page shows
- visibility.heading: What is public
- visibility.intro: The page always shows whether your server is operational, degraded, lagging or offline, and when we last heard from it. Everything else is optional.
- visibility.never: Never shown, whatever you pick: player names, IP addresses, your plugin list, findings, your API key, and who owns the server.

- players.label: Players online
- players.hint.on: Shows how many players are online and your max players, for example "12 of 40". No names.
- players.hint.off: The player count is hidden.

- uptime.label: Uptime
- uptime.hint.on: Shows the share of time your server was online over the last 1, 7 and 30 days. Based on how often we received data from it.
- uptime.hint.off: Uptime is hidden.

- incidents.label: Recent incidents
- incidents.hint.on: Lists periods of lag from the last 30 days (up to 10): when each started, how long it lasted and how serious it was. No causes, findings or technical details.
- incidents.hint.off: Incidents are hidden. Players only see the current state.
- incidents.note: Turning this on makes your lag history public. Some owners prefer to keep it private.

### Theme
- theme.label: Theme
- theme.hint: Which colours visitors see.
- theme.option.auto: Match the visitor's device
- theme.option.dark: Dark
- theme.option.light: Light

### Branding
- branding.label: Hide "Monitored with {brand.name}"
- branding.hint.allowed: Remove the line at the bottom of the page and on the badge.
- branding.hint.free: Free pages always show "Monitored with {brand.name}". Pro and Network plans can hide it.
- branding.upgrade: See plans

### Preview and links
- preview.heading: Preview
- preview.note: This is what visitors will see.
- preview.note.off: The page is private right now. This preview is only visible to you.
- link.label: Your public link
- link.copy: Copy link
- link.copied: Copied
- link.open: Open the page

### Embed
- embed.heading: Share it
- embed.intro: Put a small badge in your Discord server, your website or your README. It updates by itself and links to your status page.
- embed.badge.alt: Server status badge
- embed.markdown.label: Markdown (README, Discord, forums)
- embed.html.label: HTML (your website)
- embed.copy: Copy
- embed.copied: Copied
- embed.help.1: The badge shows the server's state and, if you show players, the player count, for example "online · 12 players".
- embed.help.2: It refreshes about once a minute, and it only works while the status page is public.
- embed.help.3: If the page is private or the address is wrong, the badge shows "unknown".
- embed.help.discord: In Discord, paste the page link and Discord shows a preview card with the title and state.
- embed.disabled: Turn the status page on to use the badge and link.

### Saving
- save.button: Save changes
- save.saving: Saving…
- save.toast: Status page saved.
- save.error: Couldn't save. Please try again in a moment.
- dirty.note: You have unsaved changes.
- loading: Loading status page settings…
- error.title: Couldn't load the status page settings
- error.body: Something went wrong on our side. Please try again in a moment.
- error.retry: Try again

---

## Public page (/s/[slug])

### States (title word, then one line)
- state.operational.label: Operational
- state.operational.line: {title} is up and running normally.
- state.degraded.label: Degraded
- state.degraded.line: {title} is up but running a little slower than usual.
- state.lagging.label: Lagging
- state.lagging.line: {title} is up but lagging right now. Players may notice delays.
- state.offline.label: Offline
- state.offline.line: {title} is offline right now.
- state.offline.lastSeen: Last seen {ago}.
- state.offline.neverSeen: We haven't heard from this server yet.

### Parts of the page
- lastUpdated: Updated {time}
- players.heading: Players online
- players.value: {online} of {max}
- players.value.noMax: {online}
- uptime.heading: Uptime
- uptime.d1: Last 24 hours
- uptime.d7: Last 7 days
- uptime.d30: Last 30 days
- uptime.value: {percent} %
- uptime.unknown: Not enough data yet
- uptime.note: Uptime is the share of time we received data from the server. A server that is online but lagging still counts as up.
- incidents.heading: Recent incidents
- incidents.intro: Periods of lag in the last 30 days.
- incidents.row: {date}, {time}. Lasted {duration}.
- incidents.row.ongoing: {date}, {time}. Still going.
- incidents.severity.medium: Minor
- incidents.severity.high: Serious
- incidents.severity.critical: Severe
- incidents.empty: No incidents in the last 30 days.
- footer.monitored: Monitored with {brand.name}
- footer.monitored.link: https://{brand.domain}   (TODO: real domain)
- footer.disclaimer: Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.

### Page title and sharing
- meta.title: {title} status | {brand.name}
- meta.description: Is {title} online? Live status of this Minecraft server.
- og.title: {title}
- og.line: {stateLabel} · {players} · {uptime7} % uptime this week   (omit the parts the owner hides)

### Loading and errors
- loading: Loading status…
- error.title: Couldn't load this status page
- error.body: Something went wrong on our side. Please try again in a moment.
- error.retry: Try again
- rateLimited: Too many requests. Please wait a minute and refresh.

### 404 (unknown address, or the owner switched the page off: identical text)
- notFound.title: Status page not found
- notFound.body: This address doesn't lead to a status page. It may have been switched off, or the address changed. Check the link with whoever shared it.
- notFound.link: Go to {brand.name}

---

## Badge (/badge/[slug].svg)

- badge.left: minecraft
- badge.right.operational: online
- badge.right.operational.players: online · {n} players
- badge.right.operational.one: online · 1 player
- badge.right.degraded: degraded
- badge.right.lagging: lagging
- badge.right.offline: offline
- badge.right.unknown: unknown   (unknown or disabled address, grey)
- badge.aria: Server status: {state}

The word is always in the badge, so it doesn't depend on colour.
