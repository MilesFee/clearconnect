# Handoff

What you are inheriting, what you must change to own it, and what is still open.
Written for the team taking the project over.

## What's in the box

| Piece | Where | Notes |
| ----- | ----- | ----- |
| Chrome extension (MV3) | repo root | No build step. The files in the repo are the files that ship. |
| Cloudflare Worker | [`worker/`](worker/) | Serves the selector schema; emails diagnostic alerts. 38 tests. |
| Conventions for AI agents | [`AGENTS.md`](AGENTS.md) | Read by Cursor, Claude Code, and Codex alike. |
| Architecture reference | [`.agents/architecture.md`](.agents/architecture.md) | Contexts, state, message flow, the selector system. |
| Security invariants | [`.agents/security.md`](.agents/security.md) | Eight rules and the findings behind them. Read before touching reporting or rendering. |
| Worker setup + runbook | [`worker/README.md`](worker/README.md) | Routes, bindings, secrets, local dev. |

The extension works standalone. The Worker is what lets you fix a LinkedIn DOM
change for every user without shipping a release — see *self-healing selectors* in
the architecture doc.

## Taking ownership

Everything below currently points at the original author's Cloudflare account.
None of it is secret, but all of it should move.

### Cloudflare

1. Create your own KV namespace and put its id in `worker/wrangler.jsonc`:
   ```bash
   cd worker && npx wrangler kv namespace create SELECTORS_KV
   ```
2. Onboard a domain you control to **Email Service → Email Sending**, and add the
   alert recipient under **Email Routing → Destination addresses**. Sending to a
   verified destination on your own account is free on every plan.
3. Set the three secrets — they are secrets rather than committed vars precisely
   so no address ends up in this public repo:
   ```bash
   npx wrangler secret put ALERT_TO
   npx wrangler secret put ALERT_FROM
   openssl rand -base64 32 | npx wrangler secret put ADMIN_SECRET
   ```
4. Deploy, then point the extension at your deployment. Two constants in
   `background.js`, both currently on the original author's `workers.dev`
   subdomain:
   ```js
   const REPORT_ENDPOINT    = 'https://<your-worker>/report';
   const SELECTORS_ENDPOINT = 'https://<your-worker>/selectors';
   ```
   `REPORT_ENDPOINT` empty disables reporting entirely. `SELECTORS_ENDPOINT` must
   end in `/selectors` — `/` is a health probe, and pointing at it stores the
   health payload as your schema.

### GitHub

5. Set repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for
   your account. CI uses them to deploy the Worker on every push to `main`.
6. Re-create branch protection on `main` if you fork or transfer. The original
   repo had a ruleset blocking force-pushes and deletion; that is worth keeping.

### Chrome Web Store

7. Once published and the extension has a stable ID, tighten CORS: set the
   Worker's `ALLOWED_ORIGINS` var to `chrome-extension://<id>` and redeploy.
   It is currently empty, which allows any origin.

### Legal

8. `LICENSE` still carries the original author's copyright line. Changing it is a
   decision about who owns the work, not a cleanup task — settle it with the
   transfer terms.

## Still open

- **The old Discord webhook.** A live webhook URL was committed to this public
  repo and shipped in releases up to v2.5.2. It has been removed from the code,
  purged from all git history, and the affected releases deleted — but a
  credential that was public for months should be treated as compromised.
  Confirm with the original author that it has been revoked in Discord.
- **`workers.dev` subdomain.** Until step 4 is done, installed extensions report
  to the original author's Worker.
- **No automated tests for the extension.** The Worker has 38; the extension has
  none. Verification is manual — see *Verifying a change* in `AGENTS.md`. Debug
  Mode runs the filters without withdrawing anything and is the safe way to
  exercise scanning and selection logic.

## Operating it

**Something broke on LinkedIn.** Users report "no withdraw buttons found", or an
alert email arrives. Open `https://<worker>/admin`, paste the admin secret, and
edit the schema. The console embeds the full runbook: which key maps to which
element, how to find each one in DevTools, and how to verify a selector before
saving. Clients pick up the change within 12 hours, or immediately on restart.

**A user fixed it themselves.** *Repair Layout* walks them through clicking each
element and stores the result locally. That fires a `selectors_learned` alert
containing the resulting schema as a paste-ready block — drop it into the admin
console to fix everyone else too.

**Cutting a release.** Bump `version` in `manifest.json`, add a section at the top
of `RELEASE_NOTES.md`, and push to `main`. CI packages the extension, extracts
those notes as the release body, runs the Worker tests, and deploys the Worker.
The release job refuses to package a build if a webhook URL appears in the
extension source.

## One history note

Git history was rewritten in September 2026 to purge a leaked credential, so every
commit SHA changed. Clone fresh rather than pulling into an old checkout. GitHub
may retain unreferenced pre-rewrite objects until garbage collection; ask GitHub
Support to purge them if that matters for your compliance posture.
