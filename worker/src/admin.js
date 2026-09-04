/**
 * Admin console for the LinkedIn selector schema.
 *
 * The page itself contains no secrets and is safe to serve unauthenticated: the
 * operator pastes the admin secret into the page, it is held in sessionStorage,
 * and every read/write is authenticated with an Authorization header.
 *
 * The secret is deliberately never accepted as a URL query parameter, which
 * would leak it into browser history, referrers, and edge logs.
 */

export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ClearConnect — Selectors Admin</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         background: #0f172a; color: #f8fafc; padding: 2rem 1.25rem; max-width: 900px; margin: 0 auto; }
  h1 { color: #f63409; margin-bottom: .25rem; font-size: 1.5rem; }
  h2 { color: #7dd3fc; font-size: 1rem; margin: 1.5rem 0 .5rem; border-bottom: 1px solid #1e293b; padding-bottom: .4rem; }
  h3 { color: #94a3b8; font-size: .8rem; margin: 1rem 0 .25rem; text-transform: uppercase; letter-spacing: .05em; }
  p, li, td, th { color: #cbd5e1; font-size: 13.5px; line-height: 1.6; }
  code { background: #1e293b; color: #7dd3fc; padding: .1em .4em; border-radius: 4px; font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; }
  pre { background: #1e293b; padding: 1rem; border-radius: 8px; font-size: 12.5px; overflow-x: auto; white-space: pre-wrap; border: 1px solid #334155; }
  textarea, input[type=password] { width: 100%; background: #1e293b; color: #f8fafc; border: 1px solid #334155;
            border-radius: 8px; padding: .75rem; font-family: ui-monospace, Menlo, monospace; font-size: 13px; box-sizing: border-box; }
  textarea { height: 320px; margin-bottom: 1rem; }
  button { background: #f63409; color: #fff; border: 0; padding: .7rem 1.4rem; border-radius: 6px; font-weight: 700; cursor: pointer; }
  button:hover { background: #d72f09; }
  button:disabled { background: #475569; cursor: not-allowed; }
  .row { display: flex; gap: .5rem; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; }
  .msg { margin-top: .75rem; font-size: 13px; display: none; }
  .msg.ok { color: #4ade80; } .msg.err { color: #f87171; }
  details { background: #1e293b; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; border: 1px solid #334155; }
  summary { cursor: pointer; color: #94a3b8; font-size: 13px; font-weight: 600; }
  summary:hover { color: #f8fafc; }
  table { width: 100%; border-collapse: collapse; margin: .5rem 0; }
  th { text-align: left; color: #64748b; font-weight: 600; padding: .4rem .6rem; border-bottom: 1px solid #334155; font-size: 12px; }
  td { padding: .4rem .6rem; border-bottom: 1px solid #0f172a; vertical-align: top; }
  td:first-child { color: #7dd3fc; font-family: ui-monospace, Menlo, monospace; white-space: nowrap; }
  .pill { display: inline-block; padding: .15em .6em; border-radius: 999px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; }
  .pill-green { background: #14532d; color: #4ade80; } .pill-yellow { background: #422006; color: #fbbf24; }
  .pill-blue { background: #0c2a4a; color: #7dd3fc; }
</style>
</head>
<body>
<h1>ClearConnect — Selectors Admin</h1>
<p>Remote control panel for the extension's LinkedIn selectors. Changes here apply to
   installed clients on their next sync.</p>

<details>
  <summary>How to tell something broke</summary>
  <h3>Signals to watch for</h3>
  <ul>
    <li><strong>An alert email arrives</strong> — a user hit a detection failure, or completed
        <em>Repair Layout</em>. Check the before/after diff in the message: if several users
        report the same key changing, that key needs a server-side update too.</li>
    <li><strong>"No withdraw buttons found"</strong> — <code>withdraw_button</code> or
        <code>withdraw_button_link</code> is stale.</li>
    <li><strong>Keeps retrying, never confirms</strong> — <code>dialog_open</code>,
        <code>modal_legacy</code>, or <code>confirm_button_aria</code> is stale.</li>
    <li><strong>Pending count is 0 or wrong</strong> — <code>pending_count</code> needs setting
        (it currently falls back to a text-pattern search).</li>
  </ul>
  <p><strong>Repair Layout fixes one user locally.</strong> A server update here fixes everyone at
     once, including users who have not noticed yet.</p>
</details>

<details>
  <summary>Finding a selector with Chrome DevTools</summary>
  <h3>Setup</h3>
  <ol>
    <li>Open <a href="https://www.linkedin.com/mynetwork/invitation-manager/sent/" target="_blank"
        rel="noopener noreferrer" style="color:#7dd3fc">the sent invitations page</a></li>
    <li>Open DevTools (<code>F12</code> or <code>Cmd+Option+I</code>) and pick the <strong>Elements</strong> tab</li>
    <li>Use the inspector cursor (<code>Cmd+Shift+C</code>), hover the element, then right-click it
        in the panel → <strong>Copy → Copy selector</strong></li>
  </ol>
  <h3>What to look for per key</h3>
  <table>
    <tr><th>Key</th><th>Inspect</th><th>Look for</th></tr>
    <tr><td>withdraw_button</td><td>A "Withdraw" button on a card</td>
        <td>A <code>&lt;button&gt;</code> with <code>data-view-name</code>. Format as
            <code>button[data-view-name="VALUE"]</code>.</td></tr>
    <tr><td>dialog_open</td><td>The confirmation modal</td>
        <td>Usually just <code>dialog[open]</code>, unless LinkedIn moved to a div-based modal.</td></tr>
    <tr><td>modal_legacy</td><td>Same modal</td>
        <td>If there is no <code>&lt;dialog&gt;</code>, find the wrapper class (e.g. <code>artdeco-modal</code>).</td></tr>
    <tr><td>confirm_button_aria</td><td>The button inside the modal</td>
        <td>Use its <code>aria-label</code> with a prefix match so it matches every name:
            <code>button[aria-label^="Withdraw invitation sent to"]</code>.</td></tr>
    <tr><td>pending_count</td><td>The total count, e.g. "People (905)"</td>
        <td>Target the element holding the count by its unique class or attribute.</td></tr>
  </table>
  <h3>Verify before saving</h3>
  <pre>document.querySelectorAll('button[data-view-name="sent-invitations-withdraw-single"]')
document.querySelector('dialog[open]')
document.querySelector('dialog[open] button[aria-label^="Withdraw invitation sent to"]')</pre>
  <p>An empty NodeList or <code>null</code> means the selector is wrong. Keep adjusting until it
     returns the elements you expect.</p>
</details>

<details>
  <summary>Key reference &amp; defaults</summary>
  <p><span class="pill pill-blue">CSS</span> keys are plain selector strings you edit here.
     <span class="pill pill-green">Object</span> keys are written by the Repair Layout tool from
     user sessions — you do not normally hand-edit those.</p>
  <table>
    <tr><th>Key</th><th>Format</th><th>Stability</th><th>Default</th></tr>
    <tr><td>withdraw_button</td><td><span class="pill pill-blue">CSS</span></td><td><span class="pill pill-green">Stable</span></td><td><code>button[data-view-name="sent-invitations-withdraw-single"]</code></td></tr>
    <tr><td>withdraw_button_link</td><td><span class="pill pill-blue">CSS</span></td><td><span class="pill pill-green">Stable</span></td><td><code>a[data-view-name="sent-invitations-withdraw-single"]</code></td></tr>
    <tr><td>dialog_open</td><td><span class="pill pill-blue">CSS</span></td><td><span class="pill pill-green">Very stable</span></td><td><code>dialog[open]</code></td></tr>
    <tr><td>modal_legacy</td><td><span class="pill pill-blue">CSS</span></td><td><span class="pill pill-yellow">Moderate</span></td><td><code>.artdeco-modal</code></td></tr>
    <tr><td>confirm_button_aria</td><td><span class="pill pill-blue">CSS</span></td><td><span class="pill pill-green">Stable</span></td><td><code>button[aria-label^="Withdraw invitation sent to"]</code></td></tr>
    <tr><td>pending_count</td><td><span class="pill pill-blue">CSS</span></td><td><span class="pill pill-yellow">Moderate</span></td><td><em>unset — falls back to text search</em></td></tr>
    <tr><td>withdraw / confirm_withdraw / name / age / message</td><td><span class="pill pill-green">Object</span></td><td>—</td><td><em>written by Repair Layout</em></td></tr>
  </table>
  <h3>Starting schema</h3>
  <pre>{
  "withdraw_button": "button[data-view-name=\\"sent-invitations-withdraw-single\\"]",
  "withdraw_button_link": "a[data-view-name=\\"sent-invitations-withdraw-single\\"]",
  "dialog_open": "dialog[open]",
  "modal_legacy": ".artdeco-modal",
  "confirm_button_aria": "button[aria-label^=\\"Withdraw invitation sent to\\"]"
}</pre>
</details>

<h2>Live schema editor</h2>
<div class="row">
  <input type="password" id="secret" placeholder="Admin secret" autocomplete="current-password"
         style="flex:1;min-width:220px">
  <button id="loadBtn" type="button">Unlock &amp; load</button>
</div>
<textarea id="schema" spellcheck="false" placeholder="Unlock to load the current schema."></textarea>
<button id="saveBtn" type="button" disabled>Save schema</button>
<div id="ok" class="msg ok"></div>
<div id="err" class="msg err"></div>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var ok = $('ok'), err = $('err');

  // sessionStorage, not the URL: keeps the secret out of history and referrers.
  var stored = sessionStorage.getItem('cc_admin_secret');
  if (stored) $('secret').value = stored;

  function show(el, text) {
    ok.style.display = 'none'; err.style.display = 'none';
    el.textContent = text; el.style.display = 'block';
  }
  function auth() { return { Authorization: 'Bearer ' + $('secret').value }; }

  $('loadBtn').addEventListener('click', function () {
    var secret = $('secret').value;
    if (!secret) { show(err, 'Enter the admin secret first.'); return; }
    fetch('admin/schema', { headers: auth() })
      .then(function (r) {
        if (r.status === 401) throw new Error('Incorrect secret.');
        if (!r.ok) throw new Error('Load failed (' + r.status + ').');
        return r.json();
      })
      .then(function (data) {
        sessionStorage.setItem('cc_admin_secret', secret);
        $('schema').value = JSON.stringify(data, null, 2);
        $('saveBtn').disabled = false;
        show(ok, 'Loaded. You can edit and save.');
      })
      .catch(function (e) { $('saveBtn').disabled = true; show(err, e.message); });
  });

  $('saveBtn').addEventListener('click', function () {
    var parsed;
    try { parsed = JSON.parse($('schema').value); }
    catch (e) { show(err, 'Invalid JSON: ' + e.message); return; }

    fetch('admin/schema', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth()),
      body: JSON.stringify(parsed)
    })
      .then(function (r) {
        if (r.status === 401) throw new Error('Incorrect secret.');
        if (!r.ok) throw new Error('Save failed (' + r.status + ').');
        return r.json();
      })
      .then(function () { show(ok, 'Schema saved. Clients pick it up on their next sync.'); })
      .catch(function (e) { show(err, e.message); });
  });
})();
</script>
</body>
</html>`;
