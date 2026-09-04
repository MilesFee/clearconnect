/** Small shared helpers for the ClearConnect Worker. */

/** Escape a string for interpolation into HTML. */
export function escapeHTML(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function jsonResponse(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
    });
}

export async function sha256Hex(input) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compare two secrets without leaking length or content through timing.
 * Both sides are hashed first so differing lengths compare in constant time.
 */
export async function secretsMatch(provided, expected) {
    if (typeof provided !== 'string' || typeof expected !== 'string') return false;
    if (!expected) return false; // Never authenticate against an unset secret.

    const [a, b] = await Promise.all([sha256Hex(provided), sha256Hex(expected)]);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/** Extract a bearer token from the Authorization header. */
export function bearerToken(request) {
    const header = request.headers.get('Authorization') || '';
    return header.startsWith('Bearer ') ? header.slice(7) : '';
}

/**
 * CORS headers for a request.
 *
 * ALLOWED_ORIGINS is a comma-separated allow-list (for example
 * "chrome-extension://abcdef..."). When it is unset the endpoint is treated as
 * public and echoes "*", which is correct for the public selector schema but
 * should be set once the extension ID is known.
 */
export function corsHeadersFor(request, env) {
    const configured = (env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    const origin = request.headers.get('Origin') || '';
    const base = {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
    };

    if (configured.length === 0) return { ...base, 'Access-Control-Allow-Origin': '*' };
    if (origin && configured.includes(origin)) {
        return { ...base, 'Access-Control-Allow-Origin': origin };
    }
    return base; // No ACAO header -> the browser blocks the cross-origin read.
}
