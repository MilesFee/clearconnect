/**
 * Diagnostic report intake -> email alert.
 *
 * The extension POSTs a small, structured event here; this module validates it,
 * rate limits it, renders it, and sends it via the Cloudflare Email binding.
 * All rendering happens server-side so the extension never holds a delivery
 * address or credential.
 */

import { escapeHTML, jsonResponse, sha256Hex } from './lib.js';

/** Hard caps. Anything larger is rejected rather than truncated. */
const MAX_BODY_BYTES = 16 * 1024;
const MAX_FIELDS = 16;
const MAX_VALUE_CHARS = 800;
/** The learned schema is meant to be pasted into the admin console, so it gets more room. */
const MAX_SCHEMA_CHARS = 4000;

/** Flood control. KV is eventually consistent, which is fine for alerting. */
const MAX_PER_IP_PER_HOUR = 3;
const MAX_GLOBAL_PER_HOUR = 25;

const KNOWN_EVENT_TYPES = new Set([
    'detection_failure',
    'selectors_learned',
    'fatal_error',
]);

const SEVERITY = {
    detection_failure: { label: 'Detection failure', color: '#dc2828' },
    fatal_error: { label: 'Fatal error', color: '#dc2828' },
    selectors_learned: { label: 'Selectors learned', color: '#10b77f' },
};

/**
 * Read the request body with a hard byte ceiling.
 * Content-Length can be absent or lie, so the decoded text is checked too.
 */
async function readCappedBody(request) {
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > MAX_BODY_BYTES) return null;
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
    return text;
}

/** Bump an hourly counter in KV. Returns the count after this request. */
async function bumpHourlyCounter(kv, key, ttlSeconds) {
    const current = Number((await kv.get(key)) || 0);
    const next = current + 1;
    // expirationTtl lets the key clean itself up; no sweeper needed.
    await kv.put(key, String(next), { expirationTtl: ttlSeconds });
    return next;
}

/**
 * Per-IP and global hourly limits. The client IP is hashed with a server-side
 * salt before use as a key, so no raw address is ever written to storage.
 */
async function isRateLimited(env, request) {
    const kv = env.SELECTORS_KV;
    if (!kv) return false; // No KV bound -> skip limiting rather than drop alerts.

    const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const salt = env.ADMIN_SECRET || 'clearconnect';
    const ipKey = (await sha256Hex(`${salt}:${ip}`)).slice(0, 16);

    const perIp = await bumpHourlyCounter(kv, `rl:ip:${ipKey}:${hour}`, 3600);
    if (perIp > MAX_PER_IP_PER_HOUR) return true;

    const global = await bumpHourlyCounter(kv, `rl:global:${hour}`, 3600);
    return global > MAX_GLOBAL_PER_HOUR;
}

/**
 * Coerce an arbitrary parsed body into a known-safe shape.
 * Returns null when the payload does not look like a diagnostic event.
 */
function normaliseEvent(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

    const type = typeof body.type === 'string' ? body.type.slice(0, 64) : '';
    if (!KNOWN_EVENT_TYPES.has(type)) return null;

    const version = typeof body.version === 'string'
        ? body.version.slice(0, 32).replace(/[^\w.\-]/g, '')
        : 'unknown';

    const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data))
        ? body.data
        : {};

    // For a Repair Layout result, the post-repair schema is the thing an operator
    // actually acts on: it gets pasted straight into the admin console. Lift it out
    // of the field list and give it its own block rather than truncating it to 800.
    let pasteSchema = null;
    if (type === 'selectors_learned' && data.after && typeof data.after === 'object') {
        pasteSchema = JSON.stringify(data.after, null, 2).slice(0, MAX_SCHEMA_CHARS);
    }

    const fields = Object.entries(data)
        .filter(([key]) => !(pasteSchema && key === 'after'))
        .slice(0, MAX_FIELDS)
        .map(([key, value]) => ({
            key: String(key).slice(0, 64),
            value: typeof value === 'object' && value !== null
                ? JSON.stringify(value, null, 1).slice(0, MAX_VALUE_CHARS)
                : String(value).slice(0, MAX_VALUE_CHARS),
        }));

    return { type, version, fields, pasteSchema };
}

function renderEmail(event) {
    const meta = SEVERITY[event.type] || { label: event.type, color: '#3c83f6' };
    const when = new Date().toISOString();

    const textBody = [
        `ClearConnect — ${meta.label}`,
        `Extension version: ${event.version}`,
        `Time (UTC): ${when}`,
        '',
        ...event.fields.map(f => `${f.key}: ${f.value}`),
        ...(event.pasteSchema
            ? ['', 'Paste this into the admin console (Live schema editor):', '', event.pasteSchema]
            : []),
    ].join('\n');

    // Every interpolated value below is attacker-controllable: escape all of it.
    const rows = event.fields.map(f => `
        <tr>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e4e9;color:#666b7a;
                     font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace;
                     white-space:nowrap;vertical-align:top">${escapeHTML(f.key)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e4e9;color:#202127;
                     font:12px ui-monospace,SFMono-Regular,Menlo,monospace;
                     white-space:pre-wrap;word-break:break-word">${escapeHTML(f.value)}</td>
        </tr>`).join('');

    const htmlBody = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f9fafb;
                   font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e2e4e9;border-radius:12px;overflow:hidden">
    <div style="background:${meta.color};color:#fff;padding:16px 20px">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">ClearConnect</div>
      <div style="font-size:18px;font-weight:700;margin-top:2px">${escapeHTML(meta.label)}</div>
    </div>
    <div style="padding:16px 20px;color:#666b7a;font-size:13px;border-bottom:1px solid #e2e4e9">
      Extension <strong style="color:#202127">v${escapeHTML(event.version)}</strong>
      &middot; ${escapeHTML(when)}
    </div>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    ${event.pasteSchema ? `
    <div style="padding:16px 20px;border-top:1px solid #e2e4e9">
      <div style="font-size:12px;font-weight:700;color:#202127;margin-bottom:6px">
        Paste into the admin console &rarr; Live schema editor
      </div>
      <pre style="margin:0;background:#f3f4f6;border:1px solid #e2e4e9;border-radius:6px;
                  padding:12px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;
                  white-space:pre-wrap;word-break:break-word;color:#202127"
      >${escapeHTML(event.pasteSchema)}</pre>
    </div>` : ''}
    <div style="padding:14px 20px;color:#8e94a4;font-size:11px;line-height:1.5">
      Automated report from the ClearConnect extension. Diagnostics only — no names,
      message bodies, or profile URLs are collected.
    </div>
  </div>
</body></html>`;

    return {
        subject: `[ClearConnect] ${meta.label} (v${event.version})`,
        text: textBody,
        html: htmlBody,
    };
}

export async function handleReport(request, env, corsHeaders) {
    const raw = await readCappedBody(request);
    if (raw === null) {
        return jsonResponse({ error: 'Payload too large' }, 413, corsHeaders);
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders);
    }

    const event = normaliseEvent(parsed);
    if (!event) {
        return jsonResponse({ error: 'Unrecognised event' }, 400, corsHeaders);
    }

    if (await isRateLimited(env, request)) {
        // 202: the client should not retry, and should not treat this as an error.
        return jsonResponse({ ok: true, throttled: true }, 202, corsHeaders);
    }

    if (!env.EMAIL || !env.ALERT_TO || !env.ALERT_FROM) {
        // Misconfiguration is an operator problem, not a client problem.
        console.error('Report received but email is not configured (EMAIL/ALERT_TO/ALERT_FROM).');
        return jsonResponse({ ok: true, delivered: false }, 202, corsHeaders);
    }

    const { subject, text, html } = renderEmail(event);

    try {
        await env.EMAIL.send({
            from: env.ALERT_FROM,
            to: env.ALERT_TO,
            subject,
            text,
            html,
        });
    } catch (err) {
        console.error('Email send failed:', err && err.message);
        return jsonResponse({ ok: false, error: 'Delivery failed' }, 502, corsHeaders);
    }

    return jsonResponse({ ok: true, delivered: true }, 200, corsHeaders);
}
