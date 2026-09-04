# Security notes

Invariants that must survive future changes, and the findings that produced them.
Entry point: [`../AGENTS.md`](../AGENTS.md).

## Threat model in one line

The extension runs privileged code on a page full of **text written by
strangers** — invitation messages from people the user has never met — and
renders that text into extension pages that hold `chrome.*` API access.

Anything that crosses from LinkedIn into the popup or side panel is untrusted
input.

## Invariants

### 1. Escape everything from LinkedIn before `innerHTML`

Names, ages, message bodies, and **topics extracted from message bodies** all
originate from other users. `escapeHTML()` is defined in both `popup.js` and
`sidepanel.js`.

Escape **at assignment**, not at the interpolation site:

```js
// Correct: single escape on both branches
const topic = escapeHTML(extractTopicFromMessage(item.message)) ||
    `"${escapeHTML(item.message.substring(0, 40))}..."`;
```

`escapeHTML()` returns `''` for non-strings, so the `||` fallback still works
when extraction returns `null`.

> **Why this rule exists.** `extractTopicFromMessage()` returns a raw slice of an
> invitation message, and its regexes permit `<` and `>`. It was interpolated
> unescaped into `innerHTML` in the side panel. A crafted invitation message
> reading `Reaching out about A<img src=x onerror=...>` would have executed script
> inside an extension page with `chrome.storage` and messaging access. Fixed at
> `sidepanel.js:375` and `sidepanel.js:869`.

### 2. The service worker never fetches a caller-supplied URL

`background.js` holds `REPORT_ENDPOINT` and uses only that. Messages carry an
*event*, never a destination.

> **Why.** The previous design accepted `{action:'SEND_WEBHOOK', url, payload}`
> and fetched whatever URL arrived. Any script running in the LinkedIn page
> context could use the extension's service worker as an open relay to POST
> arbitrary data to an arbitrary host — data exfiltration laundered through the
> extension's own network identity.

### 3. No secrets in this repository

The repo is **public**. No webhook URLs, API keys, bearer tokens, account IDs, or
KV namespace IDs in tracked files. Worker secrets go through
`npx wrangler secret put`; `.dev.vars` is gitignored.

> **Why.** A live Discord webhook URL was committed in `content.js` and remained
> readable in a public repository. Anyone could post to that channel or flood it.
> Deleting the line does not revoke it — the credential itself must be rotated.

### 4. Diagnostic reports carry no personal data

Permitted: event type, extension version, element counts, selector key names,
page **path**, before/after selector diffs.

Forbidden: names, message bodies, profile URLs, query strings, raw IPs, any free
text.

Two layers enforce this and both must stay: the extension redacts `text` fields
before sending, and the Worker allow-lists event types and escapes every value it
renders. The page path is sent instead of `location.href` because LinkedIn query
strings can carry identifiers.

### 5. The admin API fails closed

With `ADMIN_SECRET` unset, `/admin/schema` returns `503` — never an open
endpoint. There is deliberately no default or development secret.

The secret is accepted **only** as an `Authorization: Bearer` header, never as a
URL query parameter, and is compared by hashing both sides and diffing in
constant time.

> **Why.** The earlier Worker fell back to a hardcoded development secret when
> `ADMIN_SECRET` was unset, so a deployment that forgot to set the secret was
> silently world-writable — and the schema it serves becomes CSS selectors run
> against every user's LinkedIn session. It also accepted the secret from
> `?secret=`, which leaks into browser history, referrers, and edge logs.

### 6. Learned selectors are sanitised before use

Repair Layout writes user-captured selectors to storage. They are checked against
a tag allow-list before being applied. Keep that check when touching the learning
flow.

### 7. `/report` is open, so it must be capped

The extension cannot hold a credential, so the endpoint is unauthenticated and
defended in depth: 16 KB body cap, event-type allow-list, field/length caps, 3
reports per IP per hour, 25 globally per hour, and a 5-minute per-type limit in
the extension itself. IPs are SHA-256 hashed with a server-side salt before use
as rate-limit keys.

## Permissions

The manifest requests `activeTab`, `scripting`, `storage`, `sidePanel`, and host
access to `https://www.linkedin.com/*` only. Extension pages are locked down with
`script-src 'self'; object-src 'self'; base-uri 'none'`.

Adding a host permission triggers a Chrome Web Store review flag and a
user-facing warning. The Worker returns permissive CORS headers instead, so
reporting needs no additional host permission.

## Checklist before publishing

- [ ] `grep -rniE "webhook|api[_-]?key|secret|token|bearer" -- . ':!worker/README.md'` finds nothing live
- [ ] No `.env`, `.dev.vars`, or `.wrangler/` in `git status`
- [ ] `cd worker && npm test` passes
- [ ] The four JS files parse: `for f in *.js; do node --check $f; done`
- [ ] Icons are real PNGs at 16/48/128: `file icons/*.png`
- [ ] README's privacy section still matches what the code actually sends
