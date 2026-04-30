const ADMIN_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ClearConnect Selectors Admin</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; max-width: 860px; margin: 0 auto; }
        h1 { color: #38bdf8; margin-bottom: 0.25rem; }
        h2 { color: #7dd3fc; font-size: 1rem; margin: 1.5rem 0 0.5rem; border-bottom: 1px solid #1e293b; padding-bottom: 0.4rem; }
        h3 { color: #94a3b8; font-size: 0.85rem; margin: 1rem 0 0.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
        p, li { color: #cbd5e1; font-size: 14px; line-height: 1.6; }
        ul { padding-left: 1.25rem; margin: 0.5rem 0; }
        code { background: #1e293b; color: #7dd3fc; padding: 0.1em 0.4em; border-radius: 4px; font-family: monospace; font-size: 13px; }
        pre { background: #1e293b; color: #f8fafc; padding: 1rem; border-radius: 8px; font-size: 13px; overflow-x: auto; white-space: pre-wrap; border: 1px solid #334155; }
        textarea { width: 100%; height: 300px; background: #1e293b; color: #f8fafc; border: 1px solid #334155; border-radius: 8px; padding: 1rem; font-family: monospace; font-size: 14px; margin-bottom: 1rem; box-sizing: border-box; }
        button { background: #0ea5e9; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 6px; font-weight: bold; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #0284c7; }
        .success { color: #4ade80; display: none; margin-top: 1rem; }
        .error { color: #f87171; display: none; margin-top: 1rem; }
        details { background: #1e293b; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; border: 1px solid #334155; }
        details summary { cursor: pointer; color: #94a3b8; font-size: 13px; font-weight: 600; user-select: none; }
        details summary:hover { color: #f8fafc; }
        .pill { display: inline-block; padding: 0.15em 0.6em; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
        .pill-green { background: #14532d; color: #4ade80; }
        .pill-yellow { background: #422006; color: #fbbf24; }
        .pill-red { background: #450a0a; color: #f87171; }
        .pill-blue { background: #0c2a4a; color: #7dd3fc; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 0.5rem 0; }
        th { text-align: left; color: #64748b; font-weight: 600; padding: 0.4rem 0.6rem; border-bottom: 1px solid #334155; }
        td { padding: 0.4rem 0.6rem; border-bottom: 1px solid #1e293b; vertical-align: top; }
        td:first-child { color: #7dd3fc; font-family: monospace; white-space: nowrap; }
    </style>
</head>
<body>
    <h1>ClearConnect — Selectors Admin</h1>
    <p>Remote control panel for the extension's LinkedIn selectors. Changes here apply to all installed users within 12 hours (the background sync interval).</p>

    <!-- ── HOW TO KNOW SOMETHING IS BROKEN ─────────────────────────── -->
    <details>
        <summary>How to know when something broke</summary>
        <h3>Signals to watch for</h3>
        <ul>
            <li><strong>Discord webhook fires</strong> — a user ran <em>Repair Layout</em>. This means they encountered a failure. Check the <code>before</code>/<code>after</code> diff in the message; if many users are reporting the same key changing, that key needs a server update too.</li>
            <li><strong>Users report "No withdraw buttons found"</strong> — <code>withdraw_button</code> or <code>withdraw_button_link</code> selector is stale.</li>
            <li><strong>Users report it keeps retrying / never confirms</strong> — <code>dialog_open</code>, <code>modal_legacy</code>, or <code>confirm_button_aria</code> is stale.</li>
            <li><strong>Pending count shows 0 or wrong</strong> — <code>pending_count</code> needs to be set (currently falls back to text-pattern search).</li>
        </ul>
        <p><strong>Repair Layout fixes users locally.</strong> A server update fixes everyone at once, even users who haven't noticed yet.</p>
    </details>

    <!-- ── FINDING SELECTORS WITH DEVTOOLS ──────────────────────────── -->
    <details>
        <summary>How to find the right selector with Chrome DevTools</summary>

        <h3>Setup</h3>
        <ol>
            <li>Go to <a href="https://www.linkedin.com/mynetwork/invitation-manager/sent/" target="_blank" style="color:#7dd3fc">linkedin.com/mynetwork/invitation-manager/sent/</a></li>
            <li>Open DevTools: <code>F12</code> or <code>Cmd+Option+I</code></li>
            <li>Click the <strong>Elements</strong> tab</li>
        </ol>

        <h3>Finding any element's selector</h3>
        <ol>
            <li>Click the <strong>inspector cursor</strong> icon (top-left of DevTools, or <code>Cmd+Shift+C</code>)</li>
            <li>Hover over the element on the page you want to target — it highlights in the Elements panel</li>
            <li>Right-click the highlighted element in the panel → <strong>Copy → Copy selector</strong></li>
            <li>Test it: in the <strong>Console</strong> tab, run <code>document.querySelectorAll('PASTE_SELECTOR_HERE')</code> — it should return the right elements</li>
        </ol>

        <h3>How to find each key specifically</h3>
        <table>
            <tr><th>Key</th><th>What to inspect on the page</th><th>What to look for in DevTools</th></tr>
            <tr>
                <td>withdraw_button</td>
                <td>A "Withdraw" button on any invitation card</td>
                <td>Look for a <code>&lt;button&gt;</code> with a <code>data-view-name</code> attribute. Copy that attribute value and format as <code>button[data-view-name="VALUE"]</code></td>
            </tr>
            <tr>
                <td>dialog_open</td>
                <td>The modal that appears after clicking Withdraw</td>
                <td>Look for <code>&lt;dialog open&gt;</code> or similar. The selector is usually just <code>dialog[open]</code> unless LinkedIn switched to a div-based modal.</td>
            </tr>
            <tr>
                <td>modal_legacy</td>
                <td>Same modal as above</td>
                <td>If there's no <code>&lt;dialog&gt;</code>, look for a div with a class like <code>artdeco-modal</code>. Update this to the new class name.</td>
            </tr>
            <tr>
                <td>confirm_button_aria</td>
                <td>The blue "Withdraw" button <em>inside</em> the modal</td>
                <td>Look for <code>aria-label</code> on the button. Format as <code>button[aria-label^="Withdraw invitation sent to"]</code> using <code>^=</code> so it matches all names.</td>
            </tr>
            <tr>
                <td>pending_count</td>
                <td>The number showing total sent invitations (e.g. "People (905)")</td>
                <td>Inspect the tab or header element containing the count. Find its unique class or attribute and target it directly.</td>
            </tr>
        </table>

        <h3>Testing a selector before saving</h3>
        <p>Always verify in the Console before saving to the server:</p>
        <pre>// Should return all withdraw buttons (one per card):
document.querySelectorAll('button[data-view-name="sent-invitations-withdraw-single"]')

// Should return the open modal (after clicking Withdraw):
document.querySelector('dialog[open]')

// Should return the confirm button inside the modal:
document.querySelector('dialog[open] button[aria-label^="Withdraw invitation sent to"]')</pre>
        <p>If a query returns an empty NodeList or <code>null</code>, the selector is wrong. Keep adjusting until it returns the right elements.</p>
    </details>

    <!-- ── KEY REFERENCE ────────────────────────────────────────────── -->
    <details>
        <summary>Selector key reference &amp; current defaults</summary>
        <p>There are two formats. <span class="pill pill-blue">CSS string</span> keys are plain selectors you update here. <span class="pill pill-green">Object</span> keys are written by the Repair Layout tool from user sessions — you usually don't edit these manually.</p>

        <table>
            <tr><th>Key</th><th>Format</th><th>Stability</th><th>Default value</th></tr>
            <tr>
                <td>withdraw_button</td>
                <td><span class="pill pill-blue">CSS string</span></td>
                <td><span class="pill pill-green">Stable</span></td>
                <td><code>button[data-view-name="sent-invitations-withdraw-single"]</code></td>
            </tr>
            <tr>
                <td>withdraw_button_link</td>
                <td><span class="pill pill-blue">CSS string</span></td>
                <td><span class="pill pill-green">Stable</span></td>
                <td><code>a[data-view-name="sent-invitations-withdraw-single"]</code></td>
            </tr>
            <tr>
                <td>dialog_open</td>
                <td><span class="pill pill-blue">CSS string</span></td>
                <td><span class="pill pill-green">Very stable</span></td>
                <td><code>dialog[open]</code></td>
            </tr>
            <tr>
                <td>modal_legacy</td>
                <td><span class="pill pill-blue">CSS string</span></td>
                <td><span class="pill pill-yellow">Moderate</span></td>
                <td><code>.artdeco-modal</code></td>
            </tr>
            <tr>
                <td>confirm_button_aria</td>
                <td><span class="pill pill-blue">CSS string</span></td>
                <td><span class="pill pill-green">Stable</span></td>
                <td><code>button[aria-label^="Withdraw invitation sent to"]</code></td>
            </tr>
            <tr>
                <td>pending_count</td>
                <td><span class="pill pill-blue">CSS string</span></td>
                <td><span class="pill pill-yellow">Moderate</span></td>
                <td><em>Not set — falls back to text-pattern search</em></td>
            </tr>
            <tr>
                <td>withdraw</td>
                <td><span class="pill pill-green">Object</span></td>
                <td>—</td>
                <td><em>Written by Repair Layout. Don't edit manually.</em></td>
            </tr>
            <tr>
                <td>confirm_withdraw</td>
                <td><span class="pill pill-green">Object</span></td>
                <td>—</td>
                <td><em>Written by Repair Layout. Don't edit manually.</em></td>
            </tr>
            <tr>
                <td>name / age / message</td>
                <td><span class="pill pill-green">Object</span></td>
                <td>—</td>
                <td><em>Written by Repair Layout. Don't edit manually.</em></td>
            </tr>
        </table>

        <h3>Initial setup JSON (paste this if the stored schema is empty)</h3>
        <pre>{
  "withdraw_button": "button[data-view-name=\\"sent-invitations-withdraw-single\\"]",
  "withdraw_button_link": "a[data-view-name=\\"sent-invitations-withdraw-single\\"]",
  "dialog_open": "dialog[open]",
  "modal_legacy": ".artdeco-modal",
  "confirm_button_aria": "button[aria-label^\\"Withdraw invitation sent to\\"]"
}</pre>
    </details>

    <!-- ── EDITOR ────────────────────────────────────────────────────── -->
    <h2>Live Schema Editor</h2>
    <p>The textarea below loads the current stored schema. Edit only the key(s) that changed, then click Save.</p>
    <textarea id="schemaInput" placeholder='{ "withdraw_button": "button[data-view-name=\\"sent-invitations-withdraw-single\\"]" }'></textarea>
    <br>
    <button id="saveBtn">Update Schema</button>
    <div id="successMsg" class="success">Schema updated successfully!</div>
    <div id="errorMsg" class="error">Failed to update schema. Check your JSON format and secret.</div>

    <script>
        // Get the secret from the URL to authorize the request
        const urlParams = new URLSearchParams(window.location.search);
        const secret = urlParams.get('secret');

        document.getElementById('saveBtn').addEventListener('click', async () => {
            const successMsg = document.getElementById('successMsg');
            const errorMsg = document.getElementById('errorMsg');
            successMsg.style.display = 'none';
            errorMsg.style.display = 'none';

            let jsonPayload;
            try {
                jsonPayload = JSON.parse(document.getElementById('schemaInput').value);
            } catch(e) {
                errorMsg.innerText = 'Invalid JSON format.';
                errorMsg.style.display = 'block';
                return;
            }

            try {
                const response = await fetch('/admin', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + secret
                    },
                    body: JSON.stringify(jsonPayload)
                });

                if (response.ok) {
                    successMsg.style.display = 'block';
                } else {
                    throw new Error('Server error');
                }
            } catch(e) {
                errorMsg.innerText = 'Failed to save. Ensure you have ?secret=YOUR_SECRET in the URL.';
                errorMsg.style.display = 'block';
            }
        });

        // Load existing
        fetch('/').then(res => res.json()).then(data => {
            if(Object.keys(data).length > 0) {
                document.getElementById('schemaInput').value = JSON.stringify(data, null, 2);
            }
        });
    </script>
</body>
</html>
`;

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // CORS headers to allow extension to fetch
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        // GET / -> Return the latest schema
        if (url.pathname === '/' && request.method === 'GET') {
            const data = await env.SELECTORS_KV.get('latest_schema');
            return new Response(data || '{}', {
                headers: {
                    'Content-Type': 'application/json',
                    ...corsHeaders
                }
            });
        }

        // GET /admin -> Return the dashboard HTML (requires ?secret= to prevent unauthenticated access)
        if (url.pathname === '/admin' && request.method === 'GET') {
            const secret = env.ADMIN_SECRET || 'dev_secret_123';
            const token = url.searchParams.get('secret');
            if (token !== secret) {
                return new Response('Unauthorized. Access this page with ?secret=YOUR_SECRET in the URL.', {
                    status: 401,
                    headers: { 'Content-Type': 'text/plain', ...corsHeaders }
                });
            }
            return new Response(ADMIN_HTML, {
                headers: { 'Content-Type': 'text/html' }
            });
        }

        // POST /admin -> Update the schema
        if (url.pathname === '/admin' && request.method === 'POST') {
            const authHeader = request.headers.get('Authorization') || '';
            const secret = env.ADMIN_SECRET || 'dev_secret_123'; // Default for dev if not set

            if (authHeader !== ('Bearer ' + secret)) {
                return new Response('Unauthorized', { status: 401, headers: corsHeaders });
            }

            try {
                const body = await request.json();
                await env.SELECTORS_KV.put('latest_schema', JSON.stringify(body));
                return new Response(JSON.stringify({ success: true }), {
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            } catch (e) {
                return new Response(JSON.stringify({ error: 'Invalid payload' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            }
        }

        return new Response('Not Found', { status: 404, headers: corsHeaders });
    }
};
