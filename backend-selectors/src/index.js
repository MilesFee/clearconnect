const ADMIN_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ClearConnect Selectors Admin</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; max-width: 800px; margin: 0 auto; }
        h1 { color: #38bdf8; }
        textarea { width: 100%; height: 300px; background: #1e293b; color: #f8fafc; border: 1px solid #334155; border-radius: 8px; padding: 1rem; font-family: monospace; font-size: 14px; margin-bottom: 1rem; box-sizing: border-box; }
        button { background: #0ea5e9; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 6px; font-weight: bold; cursor: pointer; transition: background 0.2s; }
        button:hover { background: #0284c7; }
        .success { color: #4ade80; display: none; margin-top: 1rem; }
        .error { color: #f87171; display: none; margin-top: 1rem; }
    </style>
</head>
<body>
    <h1>ClearConnect Selectors Admin</h1>
    <p>Paste the JSON schema generated from the Discord webhook below:</p>
    <textarea id="schemaInput" placeholder='{ "withdraw": { ... } }'></textarea>
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
            const secret = env.ADMIN_SECRET || 'REDACTED_DEFAULT_SECRET';
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
            const secret = env.ADMIN_SECRET || 'REDACTED_DEFAULT_SECRET'; // Default for dev if not set

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
