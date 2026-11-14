---
title: Plugin exceptions
description: What it means when the same error keeps repeating in the log, how TickDoctor links errors to a plugin, when it fires, and how to report or fix it.
---

# Plugin exceptions

**Typical titles:** "Errors that point to ShopPlugin keep repeating", "The same error keeps repeating in the server log".

## What it means

A plugin (or the server) is throwing the same error again and again. Whatever the plugin was trying to do probably isn't working, and writing every error to the log costs the server a little time. During a lag, thousands of error reports cost real time on the main thread.

## What we look at

Errors with a stack trace in the server log: the error type, the first lines of the stack trace, the plugin they most likely belong to, and how often they happen. We never show the error message itself, because it can contain player names.

The plugin is a best guess, made from log patterns and the first stack frame inside a plugin's code. A plugin that crashes inside another plugin's code can point at the wrong one. That's why the text says "point to" and not "threw", and asks you to check the log.

## When it fires

On a server pass (over the last 30 minutes) and during incidents.

- **On a server pass:** at least 100 errors from the same plugin (more than 3 a minute), in at least 5 different minutes. A burst at startup or a single failed command doesn't count.
- **During an incident:** at least 50 errors in at least 3 different minutes (the period is shorter).

Errors that can't be tied to a plugin are grouped by their stack trace instead. The severity is low for a steady stream with no lag, medium for a flood (about 30 a minute or more) or when the server lags, and high for a flood during lag. We show at most five at once.

## How to fix it

1. Open `logs/latest.log` and search for the error type shown (for example `NullPointerException`) to see the full error and what happened just before it. Check that the lines name the plugin, by its name or its package.
2. Update the plugin to its newest version, and check that it supports your Paper version.
3. If the plugin changed recently and the errors started with that change, put the previous version back to test.
4. Check its config (`plugins/<name>/config.yml`) for a setting that points at something missing: a world, a database, another plugin.
5. If you can't fix it, report it to the plugin's author, or remove the plugin from `plugins/` and restart to confirm the errors stop. Send the author the error lines copied from the log as text, not a screenshot.

When errors can't be tied to a plugin, the first lines of the error usually name a package (for example `com.example.someplugin`) that tells you which plugin it is.

## After you fix it

This is a server-state finding. Mark it as fixed and we watch for **15 minutes**. If the errors are gone, it is confirmed. If the same flood returns, it reopens. A finding that was raised during a specific incident is treated as an incident finding and watched for **72 hours**.
