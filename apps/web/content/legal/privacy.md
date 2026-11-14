---
title: Privacy policy
description: Draft privacy policy for TickDoctor. Not legally reviewed. What personal data we process, why, for how long, and your rights.
---

> # DRAFT — not legally reviewed
>
> **This text is a working draft written from what the software actually stores today. It is not legal advice and it is not final. Do not publish it as it stands.**
> TODO (Michel): have it checked (a lawyer, the CNIL's guides for small controllers, or a trusted template) before go-public. Every `TODO` below needs your decision or your real details.

# Privacy policy

Last updated: 13 November 2026 (draft).

## 1. Who we are

The controller of your personal data is:

- **TODO (Michel): legal name** (a private individual, or the company once one exists)
- **TODO (Michel): postal address** (or the address of the person or company that will receive mail)
- **TODO (Michel): SIRET / company number, if you are registered by then**
- **Contact for privacy questions:** hello@tickdoctor.example (TODO: real address)
- **Data protection officer:** TODO (Michel): decide whether one is required (probably not at this size) and say "None appointed" if so.

"TickDoctor" is the working name of the service. TODO: update when the final name is chosen.

TickDoctor is not an official Minecraft product. It is not approved by or associated with Mojang or Microsoft.

## 2. What data we process

### 2.1 Your account

- Email address.
- Display name (optional).
- A salted hash of your password (never the password itself). Accounts created only through Discord have no password until you set one in your account settings.
- The time you gave consent when creating your account.
- Sign-up time and last-use time.
- Your plan (during the beta, accounts get Pro limits without any change to the stored plan).

Until you confirm your email, only the email address and the confirmation link (stored as a hash) exist. Unconfirmed accounts with no servers are deleted after 7 days.

### 2.2 Sessions

When you log in we store a hash of a random session identifier, the account it belongs to, and its creation, last-use and expiry times (up to 30 days of inactivity). The same applies to one-time email links (confirmation, login, password reset), stored as hashes and valid for 15 minutes to 24 hours.

### 2.3 Discord (optional)

If you sign in with Discord or link it to your account, we store your **Discord user id** and nothing else from Discord (no username, no avatar, no email from Discord).

### 2.4 Your servers

- The server name you choose.
- API keys: only a one-way hash and the first 12 characters (to help you recognise a key). The key itself is shown to you once.
- The plan, and creation time.

### 2.5 Metrics, snapshots and events from your server

The TickDoctor plugin sends performance data from your Minecraft server: tick times, memory, entity and chunk counts, host health (CPU, temperature, memory, swap, disk, network), the server software and its settings, JVM start flags (filtered: only standard options keep their values, other `-Dname=value` settings are sent as `-Dname=***`), the list of plugins with versions, world names, the busiest chunks (world and chunk coordinates), and events such as start, stop, crash, errors with stack traces and plugin changes.

**Player data.** The plugin **never sends IP addresses**. It sends **no player identifiers at all**, not even hashed ones: join and leave events carry only the number of players online, and ping samples carry only the values. The `privacy-mode` setting (`hashed` or `none`) is still accepted and currently makes no difference. Our servers keep the number of players online and the average ping. Error messages and similar free text are scrubbed twice, in the plugin and again on our server (IP addresses, UUIDs, `scheme://user:pass@` logins, `password`/`token`/`secret`/`key` values and home folder names are removed or shortened, and long hex strings are replaced with placeholders), and the plugin removes the names of players who are online. Names of players who are offline can't be recognised reliably, so an old error message could in rare cases contain one.

The full list is in [Data and privacy](/docs/data-and-privacy).

TODO (legal check): decide whether this data counts as personal data about *players*, given the hashing. The safer position is to say that it may, and that you, as the server owner, are responsible for informing your players. Consider adding a paragraph owners can copy into their own server rules.

### 2.6 Alert webhooks and delivery log

If you set up Discord alerts, we store the webhook address **encrypted** (AES-256-GCM) and show it only masked afterwards. We keep a log of every alert sent or skipped (time, kind, result, error text without the address) for **30 days**. Alert messages contain the server name, event, severity, key numbers and a link, never player names or IP addresses.

### 2.7 Status pages

A status page is **off by default**. If you switch it on, we publish only what you enable: the server's state, the player count, uptime figures and the dates and length of recent incidents, together with the page title and address you chose. We never publish player names or ids, IP addresses, plugin lists, findings, API keys or who owns the server.

### 2.8 Waitlist

If you join the waitlist: your email address (lower-cased), where on the site you signed up, and the time. Nothing else, and no IP address.

### 2.9 Technical data

TODO (Michel): confirm before publishing. The application does not store IP addresses in its database. IP addresses are used temporarily in memory to limit abuse (rate limiting). The reverse proxy (Caddy) and the hosting provider may write IP addresses to access logs. Decide the log retention (for example 7 to 30 days) and write it here.

### 2.10 Email

We send you the emails the service needs: account confirmation, login links, password resets and, if you ask, early-access news from the waitlist. They have **no tracking pixels or tracked links**. TODO (Michel): name the email provider once chosen, and where it processes data. During development emails go to a local test mailbox (Mailpit) which isn't used in production and never sends real email.

## 3. Why we use it, and on what basis

| Purpose | Data | Legal basis (GDPR article 6) |
|---|---|---|
| Create and run your account, log you in | account, sessions, Discord id | Performing the contract (terms of service) |
| Provide the service: show graphs, detect incidents, write findings | servers, metrics, snapshots, events | Performing the contract |
| Send alerts you set up | webhook, delivery log | Performing the contract |
| Publish a status page you switch on | status page data | Performing the contract, at your request |
| Keep the service secure and stop abuse (rate limits, session checks) | technical data, sessions | Legitimate interest |
| Email you about early access | waitlist email | Consent (you tick the box; you can withdraw any time) |
| Record that you accepted the privacy policy and terms | consent time | Legal obligation / legitimate interest to prove consent |
| Legal and accounting duties (once paid plans exist) | to be decided | Legal obligation |

TODO (legal check): confirm these bases. In particular, check whether the consent checkbox at account creation is needed as consent or only as acceptance of the terms.

We do **not** sell data, use it for advertising, or build profiles. We don't use analytics or tracking tools.

## 4. Cookies

The site uses only the cookies it needs to work. They are not used for tracking and do not need a consent banner (TODO: confirm with the legal check).

| Cookie | Purpose | Lifetime |
|---|---|---|
| `td_session` | Keeps you logged in. HttpOnly. | up to 30 days (sliding) |
| `td_csrf` | Protects forms and requests against cross-site forgery. Renewed at every login. | 30 days |
| `td_oauth` | Protects the Discord sign-in flow (state check). | 10 minutes |
| `td_discord_pending` | Remembers a Discord sign-up while you finish creating the account. | 10 minutes |

(Lifetimes checked against the code on 2026-11-13.)

No analytics cookies, advertising cookies or third-party trackers are used. Status pages and badges don't set or read cookies.

## 5. Who receives your data

- **Hosting provider:** TODO (Michel): name, country, role (processor). Where the data is stored: TODO.
- **Email provider:** TODO (Michel).
- **Discord:** if you use Discord sign-in, Discord receives the sign-in request. If you set up alerts, Discord receives the alert messages at the webhook you provided. Discord is an independent controller under its own policy.
- **Public:** whatever you choose to show on a status page.
- **Authorities:** only where the law requires it.

We use no other service providers. TODO: update this list if that changes.

## 6. Transfers outside the EU

TODO (Michel): depends on the hosting and email providers. If all are in the EU, say that no transfers take place. If not, name the safeguards (adequacy decision, standard contractual clauses). Discord is a US company; its use is your choice.

## 7. How long we keep data

| Data | Kept |
|---|---|
| Detailed samples (every 10 s) | Free 1 day, Pro 3 days, Network 7 days |
| Per-minute averages | Free 3 days, Pro 14 days, Network 30 days |
| Hourly averages | Free 7 days, Pro 90 days, Network 365 days |
| Events, incidents and snapshots | Free 7 days, Pro 90 days, Network 365 days |
| Beta note | During the beta every account gets Pro retention. When the beta ends, accounts go back to Free unless upgraded and older history is trimmed to the Free periods. TODO (Michel): date, we will announce it and email in advance |
| Findings of resolved incidents | the same as incidents. Open and marked-fixed findings are kept until resolved |
| Alert delivery log | 30 days |
| Sessions | up to 30 days of inactivity |
| Email links | 15 minutes to 24 hours |
| Unconfirmed accounts without servers | 7 days after the last attempt |
| Account, servers, API key hashes, alert settings, status page settings | until you delete them or your account |
| Waitlist | until you ask us to remove it or delete your account, TODO: set a maximum (for example 2 years) |
| Server logs with IP addresses | TODO: set a period |
| Backups | TODO (Michel): backup policy and retention. TODO: state that deleted accounts remain in encrypted backups for up to 14 days (nightly backups, 14-day retention), then are gone. |

Deleting a server removes its data. Deleting your account removes your account data, all your servers' data and any waitlist entry with your email, immediately.

## 8. Your rights

You have the right to access your data, to have it corrected or deleted, to restrict or object to its use, to receive it in a portable format, and to withdraw your consent at any time (withdrawal doesn't affect what happened before). If you think we handle your data unlawfully, you can complain to your data protection authority. In France that is the **CNIL** (cnil.fr).

How to use them:

- **Export (access and portability):** in the app, Account, "Export my data" downloads one JSON file with everything we hold about you and your servers, including your waitlist entry if there is one. It never includes password hashes, API key hashes or your decrypted webhook address.
- **Deletion (erasure):** in the app, Account, "Delete my account" removes your account, all your servers and their data, your sessions, your Discord link, and any waitlist entry with your email, immediately and for good. Alert messages already posted in Discord stay in Discord (Discord is a separate controller). TODO (Michel): state how long deleted data may remain in backups.
- If you can't sign in, write to hello@tickdoctor.example (TODO: real address). We answer within one month. We may ask you to confirm you own the account.
- **Waitlist:** write to us and we remove your email address.
- **Server data:** you can delete a server in its settings at any time.

## 9. Security

Passwords are hashed with scrypt. API keys and sessions are stored only as hashes. Webhook addresses are encrypted. Connections use HTTPS. Requests that change data are protected against cross-site forgery, and sign-in and the plugin's data uploads are rate-limited. No system is perfectly secure; if a breach affects your data we will tell you and the authorities as the law requires.

TODO (Michel): add the breach-notification contact and process.

## 10. Children

The service is meant for people who run Minecraft servers. We don't knowingly collect data from children under 15 (the age of digital consent in France). TODO: decide on an age rule and say it in the terms too.

## 11. Changes

We will change this policy when the service changes, for example when paid plans or a new provider arrive, or when the beta ends. The date at the top shows the latest version. For material changes we will email account holders.
