---
title: Install the plugin
description: Create an account and a server, download the plugin, set api-url and api-key, restart, and check that TickDoctor is connected.
---

# Install the plugin

This takes about five minutes. You need access to your server's files and console (or your host's panel).

## Requirements

| | |
|---|---|
| Server software | **Paper 26.2 or newer** in the 26.x line. The plugin is built and tested on Paper 26.2 (build 83). |
| Java | **Java 25.** Paper 26.2 needs it anyway, so if your server already starts, you have it. |
| Operating system | Linux, Windows or macOS. Host numbers (CPU load and temperature, memory, swap, disk, network) are read from Linux. On other systems the plugin still works but leaves those graphs empty. |
| Network | The server must be able to reach the TickDoctor app over **HTTPS**. Nothing needs to reach your server: no open ports. |
| Account | A TickDoctor account with a confirmed email address. |

**Not supported**

- Spigot, CraftBukkit and other servers that are not Paper. The plugin uses Paper-only features.
- Folia.
- Proxies such as Velocity or BungeeCord. Install the plugin on each Paper server behind the proxy instead.
- Servers older than Paper 26.2 (for example 1.21.x). The plugin declares API version 26.2 and Paper will refuse to load it on older versions.
- Paper forks (Purpur, Pufferfish and others) are untested. They may work, but we can't promise it.

## Step 1: create an account and add your server

1. Go to [Sign up](/signup) (or press **Log in** at the top, then **Create an account**). Enter your email address and press **Create account**. We send you a link; the account only exists once you open it.
2. Open the link, press **Continue**, and choose a password. A name is optional. Ticking the consent box records that you accept the [Terms](/legal/terms) and the [privacy policy](/legal/privacy).
3. You land on **Add a server**. Give the server a name (only you see it; you can change it later) and press **Create server**.
4. The next screen shows your **API key** and your **config snippet**. The key starts with `td_live_` and is shown **only once**. Copy it now. If you lose it, you can make a new one in the server's settings; the old one stops working right away.

Keep this page open. The "Waiting for first data…" panel at the bottom turns green by itself when your server connects. (You can leave the page too: the server stays in your list and its dashboard shows the same waiting state.)

## Step 2: download the plugin

On the same screen, press **Download plugin**. You get a file named `tickdoctor-agent-<version>.jar`.

Put the jar in your server's `plugins/` folder, next to your other plugins.

## Step 3: start the server once

Start (or restart) the server so the plugin can create its config file. (A brand-new Paper server stops on its very first start until you set `eula=true` in `eula.txt`; Paper's console tells you. Then start it again.) On a fresh install the console shows a warning like this. That's expected, because there is no key yet:

```
[TickDoctor] no api-key — set api-key in plugins/TickDoctor/config.yml — get one from ... Staying idle; run /tickdoctor reload after setting it.
```

## Step 4: paste your key

Open `plugins/TickDoctor/config.yml` in your server folder and set these two values, exactly as the app's snippet shows them:

```yaml
api-url: "https://<address shown in your snippet>"
api-key: "td_live_<your key>"
```

Use the snippet from the app (it has your real address and key; press **Copy snippet**). The file already contains an `api-key` line and an `api-url` line (in that order; the default `api-url` points at `http://localhost:4000`), so **replace** both instead of adding second copies. Keep the quotation marks and don't put spaces around the key.

You don't need to touch anything else. All other options have sensible defaults ([see configuration](/docs/configuration)).

Two details:

- `api-url` must start with `https://` for any address on the public internet. Plain `http://` is only accepted for your own machine, your home network and Tailscale addresses, because your key travels with every request.
- The plugin creates this file readable only by the user that runs the server. If you copy or edit it in a way that makes it readable for every user on the machine, the console warns you; fix it with `chmod 600 plugins/TickDoctor/config.yml` on Linux.

## Step 5: restart the server

**Restart** the server with your host's panel, your service manager, or by stopping it and starting it again.

Don't use `/reload`. Paper doesn't support it and it can break plugins.

Can't restart right now? Running `/tickdoctor reload` in the console also picks up the new key without a restart. It only reloads TickDoctor, so it's safe, unlike `/reload`.

## Step 6: check that it works

**In the console**, a few seconds after startup, you should see this line:

```
[TickDoctor] collecting every 10 s, sending to https://... (privacy: hashed).
```

That line means the plugin read your config and started. To confirm it is actually connected, run this in the console or in-game as an operator:

```
/tickdoctor status
```

The first line should say `connected`. Right after startup it may say `connecting` for a few seconds. The command needs the permission `tickdoctor.admin`, which operators have by default. `/td` works as a short alias.

**In the app**, the "Waiting for first data…" panel turns green and says "Your server is talking to TickDoctor." It also shows your server software and the plugin version. This usually happens within a minute. Press **Open the dashboard** to see your server.

The graphs fill in as data arrives. For the first few minutes they may say that they are filling in. Findings need more time: TickDoctor learns what "healthy" looks like for your server, so its comparisons get better over the first hours and days.

## If it doesn't work

Go to [Troubleshooting](/docs/troubleshooting). The most common causes are a mistyped key (the console prints a block of lines with `API rejected the api-key`), an `api-url` the server can't reach, and a server that wasn't restarted after the config change.

## Updating the plugin

Download the new jar from the same button, replace the old jar in `plugins/`, and restart. Your config and your key are kept.

## Removing the plugin

Stop the server, delete the jar and the `plugins/TickDoctor/` folder, and start the server again. Then delete the server in the app (server settings) if you also want its data removed. See [data and privacy](/docs/data-and-privacy).
