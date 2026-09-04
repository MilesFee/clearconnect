# Architecture

Reference for agents and new maintainers. Entry point: [`../AGENTS.md`](../AGENTS.md).

## Contexts

A Chrome extension runs as several isolated JavaScript contexts. Knowing which
one your code is in determines what APIs it can reach and how it must talk to the
others.

| Context           | File(s)                      | Can touch the LinkedIn DOM | Can call `fetch` cross-origin |
| ----------------- | ---------------------------- | -------------------------- | ----------------------------- |
| Content script    | `content.js`, `utils.js`     | Yes                        | No (routes through background) |
| Service worker    | `background.js`, `utils.js`  | No                         | Yes                            |
| Popup page        | `popup.js`, `popup.html`     | No                         | Yes                            |
| Side panel page   | `sidepanel.js`, `sidepanel.html` | No                     | Yes                            |

They share no variables. All coordination happens through
`chrome.runtime.sendMessage` and `chrome.storage.local`.

The content script is injected only on
`https://www.linkedin.com/mynetwork/invitation-manager/sent/*`. Anywhere else,
the UI shows a "wrong page" state rather than failing.

## State

`chrome.storage.local` is the single source of truth:

- **`extension_state`** — run state (`isRunning`, `isPaused`, `subMode`), stats,
  settings, withdrawal history, and UI navigation.
- **`learned_selectors`** — per-user selector overrides produced by Repair Layout.
- **`cloud_selectors`** — the schema last fetched from the Worker.
- **`last_sync_time`** — when that fetch succeeded.

Multiple contexts write concurrently: `content.js` owns run state while a job is
active, and the popup writes settings at any time. `saveState()` in `content.js`
therefore **reads, deep-merges, and writes back** instead of overwriting. A naive
`storage.set` here silently discards settings changes.

## Message flow

A withdrawal run, end to end:

```
popup.js  --START_WITHDRAW-->  content.js
                                   |
                                   |-- UPDATE_STATUS / SCROLL_PROGRESS -->  sidepanel.js
                                   |-- POPULATE_QUEUE ------------------->  sidepanel.js
                                   |-- DETECTION_FAILURE ---------------->  popup.js + sidepanel.js
                                   |-- REPORT_EVENT --------------------->  background.js -> Worker
                                   |
                                   '-- COMPLETE ------------------------->  background.js
```

`background.js` also owns side-panel lifecycle: it flips
`openPanelOnActionClick` on while a run is active so the toolbar icon reopens the
panel, and back off when the run completes.

## The self-healing selector system

LinkedIn ships DOM changes without notice, which is the extension's main source
of breakage. Three layers absorb that:

1. **Hardcoded fallbacks** in `content.js` — the defaults that ship in the build.
2. **Learned overrides** (`learned_selectors`) — captured by *Repair Layout*,
   which walks the user through clicking each element and records a selector for
   it. Validated against the live page before being saved, and sanitised against
   a tag allow-list (`button`, `a`, `div`, `span`, `p`, `li`, `figure`, `img`) so
   a learned value cannot introduce an unexpected element type.
3. **Server-supplied schema** from the Worker's `/selectors` route — fixes every
   user at once, without an extension release.

### How the sync actually runs

`background.js` owns it, because only the service worker can make the cross-origin
request:

| Trigger | Where |
| ------- | ----- |
| `chrome.runtime.onStartup` | browser launch |
| `chrome.runtime.onInstalled` | install and update |
| `chrome.alarms` every 720 min | the 12-hour refresh — this is why the manifest needs `alarms` |
| `SYNC_SELECTORS` message | a manual refresh from the UI |

It fetches `SELECTORS_ENDPOINT` (the Worker's **`/selectors`**, *not* `/`), runs
the response through `isValidSelectorSchema()`, and only then writes
`cloud_selectors` and `last_sync_time` to storage. A response that fails the check
is discarded and the previous schema is left in place.

`content.js` merges the two sources with cloud as the base and the user's own
learned selectors on top:

```js
selectorOverrides = { ...(cloud_selectors || {}), ...(learned_selectors || {}) };
```

So a server fix reaches everyone, and a user who has run Repair Layout keeps their
own working values. That precedence is deliberate — don't flip it.

> The endpoint must stay `/selectors`. `/` is a health probe, and the validation
> exists because pointing at `/` used to store the health payload as a schema
> while reporting success. See [`security.md`](security.md#8-the-selector-sync-validates-before-it-stores).

Every DOM query goes through `getSelector(role, fallback)`. Adding a raw
`querySelector` with a literal selector bypasses all three layers — don't.

`findCard()` deliberately returns the **outermost** matching ancestor. LinkedIn
nests `[role="listitem"]` and `[componentkey]` containers, and the innermost
match is often a fragment of the card rather than the card.

## Message grouping

"Message mode" groups invitations that share an outreach template. `content.js`
normalizes each message before hashing it:

- greetings and recipient names → `[firstname]`
- currency → `[amount]`, phone numbers → `[phone]`, URLs → `[link]`
- whitespace collapsed, case folded, trailing punctuation stripped

Without this masking, one template sent to 200 people produces 200 distinct
groups. `extractTopicFromMessage()` then derives a human-readable label from the
normalized text.

**That topic is a raw slice of a stranger's message.** It is attacker-influenced
text and must be escaped before rendering. See [`security.md`](security.md).

## Branding

The mark is a Feather-style **user-minus** glyph: a person outline with a minus
sign, on a `--brand-primary` (`#f63409`) rounded plate.

`icons/logo.svg` is canonical. Three things must stay in sync:

1. `icons/logo.svg` — the source geometry.
2. `icons/icon{16,48,128}.png` — the toolbar/store icons, generated from it.
3. The inline `<svg class="logo-mark">` in `popup.html` and `sidepanel.html`,
   which use `currentColor` so they follow the theme.

The PNGs are generated, not hand-drawn. Regenerate them from the SVG geometry
rather than editing them in an image editor, and keep the padding smaller at
16px so the mark stays legible in the toolbar.

## The Worker

Degrades gracefully, but it is not decorative: it is how a LinkedIn DOM change
gets fixed without shipping a release. With `REPORT_ENDPOINT` empty nothing is
reported, and if `/selectors` is unreachable the built-in fallbacks are used.

See [`../worker/README.md`](../worker/README.md) for routes, bindings, and setup.
