/**
 * ClearConnect Worker
 *
 * Two jobs:
 *   1. Serve the LinkedIn selector schema to installed extensions (public read).
 *   2. Accept diagnostic reports from the extension and email them to the team.
 *
 * Routes
 *   GET  /                 Health/version probe.
 *   GET  /selectors        Public. Current selector schema as JSON.
 *   POST /report           Diagnostic event -> alert email. Rate limited.
 *   GET  /admin            Admin console (contains no secrets).
 *   GET  /admin/schema     Authenticated read of the stored schema.
 *   POST /admin/schema     Authenticated write of the stored schema.
 *
 * Setup, bindings, and secrets are documented in worker/README.md.
 */

import { ADMIN_HTML } from './admin.js';
import { handleReport } from './report.js';
import { bearerToken, corsHeadersFor, jsonResponse, secretsMatch } from './lib.js';

const SCHEMA_KEY = 'latest_schema';

/** Reject schemas that are not a flat-ish JSON object of selector entries. */
function validateSchema(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return 'Schema must be a JSON object.';
    }
    const keys = Object.keys(value);
    if (keys.length > 64) return 'Schema has too many keys (max 64).';
    for (const key of keys) {
        if (!/^[\w.-]{1,64}$/.test(key)) return `Invalid key: ${key}`;
    }
    if (JSON.stringify(value).length > 64 * 1024) return 'Schema is too large (max 64KB).';
    return null;
}

async function requireAdmin(request, env, corsHeaders) {
    // Fail closed: with no secret configured, the admin API is unreachable
    // rather than open. There is deliberately no default/development secret.
    if (!env.ADMIN_SECRET) {
        console.error('ADMIN_SECRET is not set; admin API disabled.');
        return jsonResponse({ error: 'Admin API is not configured.' }, 503, corsHeaders);
    }
    if (!(await secretsMatch(bearerToken(request), env.ADMIN_SECRET))) {
        return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
    }
    return null; // Authorised.
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const cors = corsHeadersFor(request, env);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }

        // --- Public: selector schema -------------------------------------
        if (path === '/selectors' && request.method === 'GET') {
            const stored = env.SELECTORS_KV ? await env.SELECTORS_KV.get(SCHEMA_KEY) : null;
            return new Response(stored || '{}', {
                headers: {
                    'Content-Type': 'application/json',
                    // Clients sync infrequently; let the edge absorb the load.
                    'Cache-Control': 'public, max-age=300',
                    ...cors,
                },
            });
        }

        // --- Diagnostic reports ------------------------------------------
        if (path === '/report' && request.method === 'POST') {
            return handleReport(request, env, cors);
        }

        // --- Admin console -------------------------------------------------
        if (path === '/admin' && request.method === 'GET') {
            return new Response(ADMIN_HTML, {
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    'X-Content-Type-Options': 'nosniff',
                    'Referrer-Policy': 'no-referrer',
                    'Content-Security-Policy':
                        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
                },
            });
        }

        if (path === '/admin/schema') {
            const denied = await requireAdmin(request, env, cors);
            if (denied) return denied;

            if (!env.SELECTORS_KV) {
                return jsonResponse({ error: 'SELECTORS_KV is not bound.' }, 503, cors);
            }

            if (request.method === 'GET') {
                const stored = await env.SELECTORS_KV.get(SCHEMA_KEY);
                return new Response(stored || '{}', {
                    headers: { 'Content-Type': 'application/json', ...cors },
                });
            }

            if (request.method === 'POST') {
                let body;
                try {
                    body = await request.json();
                } catch {
                    return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
                }
                const problem = validateSchema(body);
                if (problem) return jsonResponse({ error: problem }, 400, cors);

                await env.SELECTORS_KV.put(SCHEMA_KEY, JSON.stringify(body));
                return jsonResponse({ ok: true }, 200, cors);
            }
        }

        // --- Health --------------------------------------------------------
        if (path === '/' && request.method === 'GET') {
            return jsonResponse({ service: 'clearconnect-worker', ok: true }, 200, cors);
        }

        return jsonResponse({ error: 'Not found' }, 404, cors);
    },
};
