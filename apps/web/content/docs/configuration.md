---
title: Configuration
description: Every option in the TickDoctor plugin's config.yml with its default, allowed range and meaning, plus the commands and files the plugin uses.
---

# Configuration

The plugin's settings live in `plugins/TickDoctor/config.yml`. The plugin creates the file the first time the server starts with the jar installed. Only two settings are required: `api-key` and `api-url`. The [install guide](/docs/install) shows how to set them.

After editing, apply the change with `/tickdoctor reload` (no restart needed) or restart the server. This is the plugin's own command and it is safe. It is not Bukkit's `/reload`, which you should never use.

## Options

| Option | Default | Allowed values | What it does |
|---|---|---|---|
| `api-key` | `""` (empty) | `td_live_…` | Your server's own key, from the app. **Required.** While it is empty or still an example value, the plugin stays idle: it collects nothing, sends nothing and writes nothing to disk. The key is never written to the log. |
| `api-url` | `http://localhost:4000` | `https://…` or `http://…` | Where the plugin sends data. Use the address from your config snippet in the app. The plugin posts to `<api-url>/v1/ingest/…`. Plain `http://` is only accepted for localhost, your home network (RFC 1918 addresses), link-local addresses and Tailscale addresses (100.64.0.0/10). Anything else must be `https://`, otherwise the plugin refuses to start sending. |
| `metrics-interval-seconds` | `10` | 5 to 300 | How often a sample of metrics is sent. Lower means finer graphs and slightly more traffic. Values outside the range are moved to the nearest limit. The app can change this remotely. |
| `privacy-mode` | `hashed` | `hashed`, `none` | Both values are accepted and behave the same today: the plugin sends no player identifiers at all, only counts and bare ping values. IP addresses are never sent. See [data and privacy](/docs/data-and-privacy). |
| `snapshot-mspt-threshold` | `50` | 20 to 1000 (ms) | The plugin sends a lag snapshot when the 5-second MSPT p95 stays above this value for about 5 seconds. 50 ms is the point where the server can no longer hold 20 TPS. The plugin doesn't take a snapshot in the first 60 seconds after startup, and takes at most one every 5 minutes (a manual one counts too, at most one per 2 minutes). The app can change this remotely. |
| `buffer-max-mb` | `50` | 1 to 1024 | Size limit of the on-disk buffer used while the app can't be reached. When it is full, the oldest data is dropped first. |
| `debug-log-payloads` | `false` | `true`, `false` | Logs one line per request (kind, size, response, time). It never logs the data itself. For troubleshooting. |

### Hashed or none?

Today it makes no difference. With either value:

- Join and leave events carry only how many players are online.
- Ping samples carry only the ping values, with no id attached.
- The plugin creates no salt file. An old `salt.txt` from a version before 0.1.5 is harmless and you can delete it.

TickDoctor's findings only need counts, so nothing is lost.

### Settings the app can change remotely

When the app answers a request, it may tell the plugin to use a different sampling interval (5 to 300 s) or snapshot threshold (20 to 1000 ms), or to take a snapshot now. These changes last until the next restart or `/tickdoctor reload`. The plugin keeps them within the same limits as the table above, and your `config.yml` is not rewritten.

Incident detection itself (an incident opens when the slowest 5 % of ticks stay above 50 ms for 30 seconds, or when TPS stays under 18 for 90 seconds) runs in the app and isn't a plugin setting. Alerts, status pages and the other app features are set in the app, per server.

## Commands

All commands need the permission `tickdoctor.admin` (operators have it by default). `/td` is a short alias.

| Command | What it does |
|---|---|
| `/tickdoctor status` | Shows the connection state (`connected`, `connecting`, retrying, rate limited, stopped), the API address, the sampling interval, the privacy mode, the snapshot threshold, the time of the last successful push, the size of the buffer, the plugin's own overhead, and the age of its entity and chunk counts. If anything was dropped (data that couldn't be kept in memory or on disk, damaged buffer lines, events or log lines), an extra `Losses: …` line says what and how much. It is absent when nothing was lost. |
| `/tickdoctor snapshot` | Collects a snapshot now and sends it. At most one every 2 minutes. |
| `/tickdoctor reload` | Re-reads `config.yml` and restarts the plugin's collection. It sends whatever is buffered first. |

## Files the plugin keeps in `plugins/TickDoctor/`

| File | What it is |
|---|---|
| `config.yml` | The settings above. Contains your API key, so keep it private. |
| `buffer/` | Data that couldn't be sent yet (`<number>.<kind>.jsonl`). Deleted as it is delivered. |
| `plugins.json` | The last plugin list, used to notice when a plugin was added, updated or removed. |
| `running.marker` | Exists while the server runs. If it is still there at the next start, the previous run didn't stop cleanly and the plugin reports a crash. |

## Extra for Raspberry Pi

To read the throttling state (`vcgencmd get_throttled`), the user that runs the server must be in the `video` group. Then restart the server:

```sh
sudo usermod -aG video minecraft   # replace "minecraft" with your server's user
```

Without it the plugin still works. It just leaves out the throttling reading, writes one line in the console explaining why, and tries again after 10 minutes. See the [thermal throttling finding](/docs/findings/thermal-throttling).

## What the plugin needs from your host

- **CPU and memory:** the plugin measures its own cost and shows it in `/tickdoctor status`. On an idle Raspberry Pi 5 we measured about 0.024 ms per tick on average (0.05 % of the 50 ms tick budget). Your numbers will differ, so check yours.
- **Network:** one small compressed request every interval, plus short batches of events.
- **Disk:** up to `buffer-max-mb` while the app is unreachable, otherwise almost nothing.
