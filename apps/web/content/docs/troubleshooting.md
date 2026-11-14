---
title: Troubleshooting
description: Fix a TickDoctor plugin that won't connect, an invalid API key, missing data, wrong clocks and Discord alerts that don't arrive.
---

# Troubleshooting

Start with this command, in the console or in-game as an operator:

```
/tickdoctor status
```

Its first line tells you what is going on. The rest of this page is organised by what that line (or the app) says.

## The app stays on "Waiting for first data…"

Work down this list.

1. **Did you restart the server?** The plugin only starts reading `config.yml` on startup (or after `/tickdoctor reload`). `/reload` doesn't count and isn't supported.
2. **Is the jar in the right place?** It must be in `plugins/` and the console must show `[TickDoctor]` lines at startup. If you see none, see "The plugin doesn't load" below.
3. **Is the key set?** Look at `plugins/TickDoctor/config.yml`. If `/tickdoctor status` says `idle`, the key is empty or still an example value.
4. **Is the console line there?** After a correct setup you see `[TickDoctor] collecting every 10 s, sending to <your api-url> (privacy: hashed).` If the line is missing, read the warning above it.
5. **Is `/tickdoctor status` saying `connected`?** If it says `API unreachable, retrying`, the server can't reach the app. See "The API address can't be reached".
6. **Is the key for this server?** Each server has its own key. A key from another server in your account works, but its data shows up on that other server.

## `stopped: invalid/revoked key`

The console prints a block like this and sending stops:

```
[TickDoctor] the API rejected the api-key (invalid_key: Missing or invalid API key).
[TickDoctor] sending is STOPPED. Data keeps buffering on disk (bounded).
[TickDoctor] fix api-key in plugins/TickDoctor/config.yml, then run /tickdoctor reload.
```

- **`invalid_key`** ("Missing or invalid API key"): the key is mistyped, cut off, or from somewhere else. Copy it again from the app. Make sure there are no spaces, the quotation marks are straight, and the key starts with `td_live_`.
- **`revoked_key`** ("API key has been revoked"): someone rotated the key in the server's settings. Rotating shows a new key once. Paste the new one.

After fixing the file, run `/tickdoctor reload`. Nothing is lost while sending is stopped: data is held in the on-disk buffer (up to `buffer-max-mb`) and delivered afterwards.

If you've lost the key, open the server's **Settings** in the app and rotate it. The old key stops working immediately.

## The key looks wrong

- **`no api-key` or `api-key is still the placeholder`:** the plugin is idle on purpose. Set a real key and run `/tickdoctor reload`.
- **`api-key … doesn't start with td_live_`:** a warning only. The plugin still tries it. Keys look like `td_live_` followed by letters and digits.

## The API address can't be reached

`/tickdoctor status` shows `API unreachable, retrying in … s`, and the console says `API unreachable (…); buffering and retrying with backoff.`

- **Check `api-url`.** Use exactly the address from the app's snippet. A typo, a trailing space or a missing `https://` all look like "unreachable".
- **`localhost` means the server itself.** If you run the server in a container or on a host, `http://localhost:4000` points at the server, not at TickDoctor. Use the real address.
- **Firewall or hosting restrictions.** The server only needs *outgoing* HTTPS (port 443). Some hosts and panels block outgoing connections. Ask your host or try from the machine: `curl -I https://<your api-url>`.
- **DNS.** The server must be able to look up the name. A server with a broken DNS setup can't reach anything by name. If the name of an `http://` address can't be looked up right now, the plugin shows `API unreachable, retrying` and keeps trying, so it recovers by itself once DNS works.
- **`http://` refused.** If an `http://` address resolves to a public address, the console says `api-url '…' uses plain http:// to a public host; refusing to send the API key unencrypted`, and `/tickdoctor status` says `STOPPED: http:// api-url resolves to a public address`. Use `https://`, then `/tickdoctor reload`. Plain `http://` is only accepted for localhost, your home network and Tailscale.
- **`api-url must start with http:// or https://`.** The scheme is missing or mistyped.

While the app is unreachable, nothing is lost. The plugin keeps what it collects, first in memory and then in `plugins/TickDoctor/buffer/` (up to `buffer-max-mb`, oldest dropped first), and retries with a growing delay from 5 seconds up to 5 minutes. When the connection is back, it sends the backlog oldest first. Your graphs fill the gap. The `Buffer:` line of `/tickdoctor status` shows how much is waiting. If the outage is longer than the buffer holds, the oldest part is lost and the graphs keep a gap.

## Other messages in `/tickdoctor status`

| Message | Meaning |
|---|---|
| `connecting` | Just started, nothing delivered yet. |
| `rate limited, retrying in … s` | You sent too much in a short time, for example after a long outage. It waits as asked and continues. Nothing to do. |
| `plan limit reached, retrying in … s` | The app refused the data because of your plan. The plugin keeps buffering and retries. Check your plan in the app. |
| `reloading…` | A `/tickdoctor reload` is in progress. |
| `NOT RUNNING — see the server log` | The plugin couldn't start. Look at the lines just above in the console. |

## The plugin doesn't load

- **Wrong Paper version.** The plugin needs **Paper 26.2 or newer**. On older servers the console says the plugin was built for a newer API version, and it isn't loaded.
- **Wrong Java.** Paper 26.2 needs **Java 25**. If you're on an older Java, the server itself won't start, so this shows up before TickDoctor does. Check with `java -version`, and fix the Java used by your start script or panel.
- **Not Paper.** Spigot, CraftBukkit, Folia and proxies are not supported. See [Install](/docs/install).
- **A broken download.** If the jar is incomplete, the server prints an error naming `TickDoctor`. Download it again.
- **Two copies.** Remove older `tickdoctor-agent-*.jar` files from `plugins/` so only one remains.

## The server is connected but nothing shows up

- **No samples yet.** A new server turns green with its first push, but graphs need a few minutes. The dashboard says they are filling in. Use the **last hour** range at first.
- **Wrong server selected.** If you have more than one server, check the switcher at the top.
- **The health shows "offline".** The app calls a server offline when it hasn't sent anything for 90 seconds. Check that the server is running and `/tickdoctor status` says `connected`.
- **Some host graphs are missing.** CPU temperature, throttling, swap and disk throughput come from Linux. On Windows and macOS they are left out. On a Raspberry Pi, throttling also needs the `video` group (see [Configuration](/docs/configuration#extra-for-raspberry-pi)).
- **No findings.** That is a good sign. Findings only appear when something is actually wrong. Incidents need the server to lag first: the slowest 5 % of ticks above 50 ms for 30 seconds.
- **"Not enough healthy time yet" in "What changed?".** TickDoctor needs about 30 minutes of normal running before it can compare. It improves with time.
- **Old data is gone.** Each plan keeps history for a limited time. See [data and privacy](/docs/data-and-privacy#how-long-we-keep-it).

## Times look wrong, or a gap appears after a restart

- **Server clock.** Samples are timestamped by your server. If its clock is wrong by more than 10 minutes *ahead*, the app drops those samples. If it's behind, the graphs show data at the wrong time and can hide recent data. Turn on automatic time (`timedatectl set-ntp true` on Linux, or your host's setting).
- **Gaps.** The server is only measured while it runs. A restart leaves a short gap, and the app marks the restart on the timeline.
- **Time zone.** Graphs use your browser's time zone. Quiet hours for alerts use the time zone you pick in the alert settings.

## Discord alerts don't arrive

Open **Alerts** for your server in the app.

1. **Send a test alert.** If it fails, the message tells you why in plain words. At most 5 tests are allowed per server in 10 minutes.
2. **"Alerts paused" or the webhook is marked invalid.** Discord told us the webhook doesn't exist any more (it was deleted, or its channel was). We stop calling it until you paste a new one. Create a new webhook in Discord (channel settings, Integrations, Webhooks) and paste its URL.
3. **The webhook is refused when you save.** Only webhook addresses that start with `https://discord.com/api/webhooks/` (or `discordapp.com`, `ptb.discord.com`, `canary.discord.com`) are accepted. Copy the whole URL.
4. **Alerts are switched off**, or the event you expect is off. Each of these has its own switch: incident opened, incident resolved, server offline or back online, crash.
5. **The incident was too mild.** Only incidents at or above your minimum severity (medium by default) are announced. An "incident over" message is sent only when the "incident opened" message was sent.
6. **Cooldown.** After an alert, the same kind of alert for the same server waits for the cooldown (30 minutes by default). Skipped alerts are logged as "cooldown".
7. **Quiet hours.** During quiet hours nothing is sent, except critical incidents. Skipped alerts are logged and **not** sent afterwards.
8. **Offline alerts take time.** "Server offline" is sent after the server has been silent for the number of minutes you set (5 by default).
9. **Tuning tips never alert.** Findings of the "tuning tip" kind never appear in alerts.
10. **Look at the delivery log.** The alerts page lists every alert that was sent, failed or skipped over the last 30 days, with the reason.

Alerts never include player names or IP addresses, and the message can't ping `@everyone`.

## Still stuck?

Write to hello@tickdoctor.example (TODO: real address) and include:

- the output of `/tickdoctor status`,
- the `[TickDoctor]` lines from your console at startup,
- your Paper version (`/version`) and Java version.

Never send your API key. If you do, rotate it in the server's settings.
