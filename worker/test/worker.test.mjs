import worker from '../src/index.js';

let pass = 0, fail = 0;
const check = (name, cond, extra='') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
};

function makeEnv(over = {}) {
  const store = new Map();
  const sent = [];
  return {
    sent, store,
    SELECTORS_KV: {
      get: async k => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => void store.set(k, v),
    },
    EMAIL: { send: async msg => { sent.push(msg); return { messageId: 'x' }; } },
    ALERT_TO: 'alerts@example.com',
    ALERT_FROM: 'cc@example.com',
    ADMIN_SECRET: 'super-secret-value',
    ...over,
  };
}
const req = (path, init = {}) =>
  new Request('https://w.example.com' + path, init);

console.log('\n== routing & public reads ==');
{
  const env = makeEnv();
  let r = await worker.fetch(req('/'), env);
  check('GET / health 200', r.status === 200);

  r = await worker.fetch(req('/selectors'), env);
  check('GET /selectors defaults to {}', r.status === 200 && (await r.text()) === '{}');

  r = await worker.fetch(req('/nope'), env);
  check('unknown route 404', r.status === 404);

  r = await worker.fetch(req('/admin'), env);
  const html = await r.text();
  check('GET /admin serves console', r.status === 200 && html.includes('Selectors Admin'));
  check('admin HTML embeds no secret', !html.includes('super-secret-value'));
}

console.log('\n== admin auth ==');
{
  const env = makeEnv();
  let r = await worker.fetch(req('/admin/schema'), env);
  check('no token -> 401', r.status === 401);

  r = await worker.fetch(req('/admin/schema', { headers: { Authorization: 'Bearer wrong' } }), env);
  check('wrong token -> 401', r.status === 401);

  r = await worker.fetch(req('/admin/schema?secret=super-secret-value'), env);
  check('secret in URL query is NOT accepted', r.status === 401);

  r = await worker.fetch(req('/admin/schema', { headers: { Authorization: 'Bearer super-secret-value' } }), env);
  check('correct token -> 200', r.status === 200);

  // Fail closed when unset
  const noSecret = makeEnv({ ADMIN_SECRET: undefined });
  r = await worker.fetch(req('/admin/schema', { headers: { Authorization: 'Bearer ' } }), noSecret);
  check('unset ADMIN_SECRET -> 503 not 200', r.status === 503, `got ${r.status}`);
  r = await worker.fetch(req('/admin/schema', { method:'POST', headers: { Authorization: 'Bearer any-hardcoded-fallback', 'Content-Type':'application/json' }, body:'{}' }), noSecret);
  check('hardcoded fallback secret rejected', r.status === 503, `got ${r.status}`);
}

console.log('\n== schema write + validation ==');
{
  const env = makeEnv();
  const auth = { Authorization: 'Bearer super-secret-value', 'Content-Type': 'application/json' };
  let r = await worker.fetch(req('/admin/schema', { method: 'POST', headers: auth,
    body: JSON.stringify({ dialog_open: 'dialog[open]' }) }), env);
  check('valid write -> 200', r.status === 200);

  r = await worker.fetch(req('/selectors'), env);
  check('write is readable publicly', (await r.text()).includes('dialog[open]'));

  r = await worker.fetch(req('/admin/schema', { method: 'POST', headers: auth, body: '["a"]' }), env);
  check('array schema rejected', r.status === 400);

  r = await worker.fetch(req('/admin/schema', { method: 'POST', headers: auth,
    body: JSON.stringify({ 'bad key!': 'x' }) }), env);
  check('invalid key rejected', r.status === 400);

  r = await worker.fetch(req('/admin/schema', { method: 'POST', headers: auth, body: 'not json' }), env);
  check('malformed JSON rejected', r.status === 400);
}

console.log('\n== report -> email ==');
{
  const env = makeEnv();
  const r = await worker.fetch(req('/report', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'detection_failure', version: '2.5.0',
      data: { path: '/mynetwork/invitation-manager/sent/', cards: 0, buttons: 42 } }),
  }), env);
  const body = await r.json();
  check('valid report -> 200 delivered', r.status === 200 && body.delivered === true, JSON.stringify(body));
  check('exactly one email sent', env.sent.length === 1);
  const m = env.sent[0];
  check('email addressed from vars', m.to === 'alerts@example.com' && m.from === 'cc@example.com');
  check('subject names the event', m.subject.includes('Detection failure'));
  check('body carries the fields', m.text.includes('buttons: 42'));
  check('html + text alternatives present', !!m.html && !!m.text);
}

console.log('\n== report hardening ==');
{
  let env = makeEnv();
  let r = await worker.fetch(req('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'arbitrary_spam', data: {} }) }), env);
  check('unknown event type rejected', r.status === 400 && env.sent.length === 0);

  env = makeEnv();
  r = await worker.fetch(req('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'fatal_error', version: '1.0',
      data: { note: '<img src=x onerror=alert(1)>' } }) }), env);
  const html = env.sent[0].html;
  check('report HTML is escaped', html.includes('&lt;img') && !html.includes('<img src=x'), 'injection leaked');

  env = makeEnv();
  const huge = 'A'.repeat(40 * 1024);
  r = await worker.fetch(req('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'fatal_error', data: { blob: huge } }) }), env);
  check('oversized body rejected 413', r.status === 413 && env.sent.length === 0, `got ${r.status}`);

  env = makeEnv();
  const bad = makeEnv({ EMAIL: undefined });
  r = await worker.fetch(req('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'fatal_error', data: {} }) }), bad);
  check('missing EMAIL binding degrades to 202', r.status === 202, `got ${r.status}`);
}

console.log('\n== rate limiting ==');
{
  const env = makeEnv();
  const send = () => worker.fetch(req('/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify({ type: 'fatal_error', version: '2.5.0', data: { n: 1 } }),
  }), env);
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await send()).status);
  check('first 3 delivered then throttled', env.sent.length === 3, `sent=${env.sent.length} codes=${codes}`);
  check('throttled responses are 202 not 429-error', codes.slice(3).every(c => c === 202), `${codes}`);
}

console.log('\n== CORS ==');
{
  const open = makeEnv();
  let r = await worker.fetch(req('/selectors'), open);
  check('no allow-list -> *', r.headers.get('Access-Control-Allow-Origin') === '*');

  const locked = makeEnv({ ALLOWED_ORIGINS: 'chrome-extension://abcdef' });
  r = await worker.fetch(req('/selectors', { headers: { Origin: 'https://evil.example' } }), locked);
  check('disallowed origin gets no ACAO', r.headers.get('Access-Control-Allow-Origin') === null);

  r = await worker.fetch(req('/selectors', { headers: { Origin: 'chrome-extension://abcdef' } }), locked);
  check('allowed origin echoed', r.headers.get('Access-Control-Allow-Origin') === 'chrome-extension://abcdef');

  r = await worker.fetch(req('/report', { method: 'OPTIONS' }), open);
  check('preflight -> 204', r.status === 204);
}

console.log('\n== selectors_learned paste block ==');
{
  const env = makeEnv();
  const after = { withdraw_button: 'button[data-view-name="x"]', dialog_open: 'dialog[open]' };
  await worker.fetch(req('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'selectors_learned', version: '2.6.1',
      data: { reason: 'User completed Repair Layout', before: {}, after } }) }), env);
  const m = env.sent[0];
  check('email sent for selectors_learned', !!m);
  check('paste block present in html', m.html.includes('Live schema editor'), 'missing');
  check('schema is pretty-printed and complete', m.html.includes('dialog[open]') && m.html.includes('withdraw_button'));
  check('paste block present in text alternative', m.text.includes('Paste this into the admin console'));
  check('after is not duplicated as a field row', (m.html.match(/&gt;after&lt;|>after</g) || []).length === 0);

  // The schema is remote-supplied: it must still be escaped inside the <pre>.
  const env2 = makeEnv();
  await worker.fetch(req('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'selectors_learned', version: '2.6.1',
      data: { after: { evil: '</pre><img src=x onerror=alert(1)>' } } }) }), env2);
  const h = env2.sent[0].html;
  check('paste block escapes injected markup', h.includes('&lt;/pre&gt;') && !h.includes('</pre><img'), 'injection leaked');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
