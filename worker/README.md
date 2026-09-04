# ClearConnect Worker

Cloudflare Worker backing the ClearConnect extension. It does two things:

1. **Serves the LinkedIn selector schema** so a LinkedIn DOM change can be fixed
   server-side, without shipping a new extension version.
2. **Receives diagnostic reports** from the extension and emails them to the team
   via Cloudflare Email Service.

There is no Discord dependency and no third-party email provider — delivery is
Cloudflare-native.

## Routes

| Method | Path             | Auth        | Purpose                                       |
| ------ | ---------------- | ----------- | --------------------------------------------- |
| `GET`  | `/`              | public      | Health probe.                                 |
| `GET`  | `/selectors`     | public      | Current selector schema (JSON). Cached 5 min. |
| `POST` | `/report`        | public\*    | Diagnostic event → alert email. Rate limited. |
| `GET`  | `/admin`         | public      | Admin console. Contains no secrets.           |
| `GET`  | `/admin/schema`  | bearer      | Read the stored schema.                       |
| `POST` | `/admin/schema`  | bearer      | Replace the stored schema.                    |

\* `/report` is unauthenticated by necessity — the extension cannot hold a
credential — so it is defended by strict payload validation, a 16 KB body cap,
an event-type allow-list, and per-IP + global hourly rate limits.

## Setup

Everything below is one-time. Expect ~15 minutes, most of it DNS propagation.

### 1. Install and authenticate

```bash
cd worker && npm install && npx wrangler login
```

### 2. Create the KV namespace

```bash
npx wrangler kv namespace create SELECTORS_KV
```

Copy the returned `id` into `wrangler.jsonc`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

### 3. Onboard a domain to Cloudflare Email Service

In the Cloudflare dashboard: **Compute > Email Service > Email Sending >
Onboard Domain**. Pick a domain already using Cloudflare DNS and accept the SPF,
DKIM, and DMARC records it offers. Propagation is usually 5–15 minutes.

> **Cost:** Email Sending is a Workers Paid feature *except* when sending to a
> **verified destination address** on your own account, which is free on all
> plans. For internal alerting, add the recipient under **Email Routing >
> Destination addresses**, confirm the verification email, and it costs nothing.

### 4. Set the addresses

Edit `vars` in `wrangler.jsonc`:

```jsonc
"vars": {
  "ALERT_TO": "eng-alerts@yourcompany.com",   // verified destination address
  "ALERT_FROM": "clearconnect@yourdomain.com", // on the onboarded domain
  "ALLOWED_ORIGINS": ""                        // see step 6
}
```

### 5. Set the admin secret

```bash
openssl rand -base64 32 | npx wrangler secret put ADMIN_SECRET
```

The admin API **fails closed**: if `ADMIN_SECRET` is unset, `/admin/schema`
returns `503` rather than allowing unauthenticated writes. There is no default
or development secret.

### 6. Deploy

```bash
npx wrangler deploy
```

Then wire the extension to it — in `background.js`, set:

```js
const REPORT_ENDPOINT = 'https://clearconnect-worker.<your-subdomain>.workers.dev/report';
```

Leaving `REPORT_ENDPOINT` empty disables reporting entirely; nothing is sent.

Once the extension is published and has a stable ID, tighten CORS by setting
`ALLOWED_ORIGINS` to `chrome-extension://<extension-id>` and redeploying.

## Using the admin console

Open `https://<worker-url>/admin`, paste the admin secret, and click
**Unlock & load**.

The secret is held in `sessionStorage` and sent as an `Authorization: Bearer`
header. It is **never** accepted as a URL query parameter — that would leak it
into browser history, referrer headers, and edge logs.

The console embeds the full operational runbook: how to recognise a breakage,
how to find each selector in DevTools, and what every schema key means.

## What the alert emails contain

Diagnostics only:

- event type, extension version, UTC timestamp
- element counts on the page (cards, buttons, profile links)
- which selector keys are overridden
- the page **path** — never the query string
- for `selectors_learned`, the before/after selector diff

Never included: names, invitation message bodies, profile URLs, or any free text
(the extension redacts `text` fields before sending, and the Worker only renders
an allow-list of event types).

## Local development

```bash
cp .dev.vars.example .dev.vars   # then edit; .dev.vars is gitignored
npx wrangler dev
```

Email sending is simulated locally unless the binding is marked `"remote": true`.

Tail production logs with `npx wrangler tail`.

## Threat model notes

- **Report flooding.** `/report` is open, so it is capped at 3 reports per IP per
  hour and 25 globally per hour. IPs are SHA-256 hashed with a server-side salt
  before being used as rate-limit keys — no raw address is stored. The extension
  also self-limits to one report per event type per 5 minutes.
- **Email HTML injection.** Every value from a report is HTML-escaped before
  rendering. Field counts and value lengths are capped.
- **Schema poisoning.** Writes require the bearer secret, keys are pattern
  checked, and the document is size limited. The extension additionally
  sanitises learned selectors against a tag allow-list before applying them.
- **Secret comparison.** `ADMIN_SECRET` is compared by hashing both sides and
  diffing in constant time, so neither length nor content leaks via timing.
