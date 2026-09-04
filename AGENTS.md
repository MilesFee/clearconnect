# AGENTS.md

Guidance for AI coding agents working in this repository. This is the single
source of truth — Cursor, Claude Code, Codex, and Copilot all discover this file
at the repo root. Do not create `CLAUDE.md`, `.cursorrules`, `.cursor/rules`, or
`.claude/` alongside it; deeper reference material lives in [`.agents/`](.agents/).

## What this is

ClearConnect is a **Manifest V3 Chrome extension** that bulk-withdraws stale
LinkedIn connection invitations, plus a **Cloudflare Worker** that serves DOM
selectors and emails diagnostic alerts.

There is no build step, no bundler, and no framework. The files you edit are the
files that ship. Vanilla ES2020, loaded directly by Chrome.

## Layout

```
manifest.json        MV3 manifest. Content script is scoped to one LinkedIn URL.
background.js        Service worker: side-panel lifecycle + diagnostic reporting.
content.js           Injected into LinkedIn. Scanning, withdrawing, selector healing.
popup.js/.html       Toolbar popup UI (idle state, settings, history, stats).
sidepanel.js/.html   Side panel UI (active runs, scan results, completion).
utils.js             Shared Logger. Loaded first by every context.
main.css             All styles for both popup and side panel.
icons/               logo.svg is canonical; the PNGs are generated from it.
worker/              Cloudflare Worker. See worker/README.md.
.agents/             Architecture and security reference for agents.
```

## Ground rules

**Escape before `innerHTML`.** Both UI files define `escapeHTML()`. Every value
originating from LinkedIn — names, ages, message bodies, and *topics derived from
message bodies* — must pass through it. Escape at assignment, not at the
interpolation site, so fallback branches are not double-escaped. This has already
caused one real XSS; see [`.agents/security.md`](.agents/security.md).

**The reporting endpoint lives in `background.js` and nowhere else.** Content
scripts send `{action: 'REPORT_EVENT', event}`; they never supply a URL. The
service worker must not fetch a destination chosen by a message — that is an open
relay out of a page context. Email rendering and delivery belong to the Worker.

**Never send personal data.** Diagnostic reports carry counts, selector keys, the
page *path*, and the extension version. Never names, message bodies, profile
URLs, query strings, or free text. The extension redacts `text` fields and the
Worker allow-lists event types; keep both.

**No secrets in the repo.** No webhook URLs, API keys, account IDs, or tokens —
this repository is public. Worker secrets go through `wrangler secret put`.

**`chrome.storage.local` is the source of truth**, under two keys:
`extension_state` and `learned_selectors`. `content.js` merges deeply into
`extension_state` rather than overwriting it, because settings are written
concurrently from the popup. Preserve that merge.

**Selectors are data, not code.** LinkedIn's DOM changes often. Route every DOM
query through `getSelector(role, fallback)` so it can be overridden by learned or
server-supplied values. Learned selectors are sanitised against a tag allow-list
before being applied — keep that check.

## Working style

- Match the surrounding style: 4-space indent, `camelCase`, single quotes, and
  comments that explain *why*, not *what*.
- Use the `Logger` from `utils.js` rather than bare `console.log`. `Logger.log`
  is silenced unless `Logger.DEBUG` is on; `Logger.error` always prints.
- Keep UI work inside the existing CSS custom properties in `main.css`
  (`--brand-primary`, `--bg-*`, `--text-*`). Both light and dark themes are
  defined there — do not hard-code colors.
- The logo is the Feather-style *user-minus* mark. `icons/logo.svg` is canonical;
  the inline SVGs in the two HTML headers must match it. See
  [`.agents/architecture.md`](.agents/architecture.md#branding) before changing it.

## Verifying a change

There is no test runner for the extension — load it unpacked and exercise it:

1. `chrome://extensions` → Developer Mode → **Load unpacked** → this folder.
2. Open `https://www.linkedin.com/mynetwork/invitation-manager/sent/`.
3. Turn on **Debug Mode** in settings to run the filters without withdrawing
   anything. Use it for any change to scanning or selection logic.
4. Check the service worker console (via the extension card) as well as the page
   console — they are separate contexts.

The Worker does have tests:

```bash
cd worker && npm test
```

Run them after touching anything in `worker/src/`.

## Care required

- **Rate limiting is a safety feature, not a nicety.** The randomized delays in
  `content.js` exist so users do not trip LinkedIn's automation defenses. Do not
  reduce or remove them for speed.
- **Withdrawing is irreversible.** A withdrawn invitation cannot be restored.
  Preserve the Safe Threshold guard and the debug-mode dry run.
- `content.js` and `popup.js` are ~2,400 lines each. Read the surrounding
  function before editing; several code paths look similar but handle different
  modes (`count`, `age`, `message`).
