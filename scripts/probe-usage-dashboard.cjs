'use strict';
// Read-only end-to-end probe: boots the real MobileWebServer against stub services,
// then fetches the dashboard assets and the analytics API over real HTTP.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MobileWebServer } = require('../dist/web-server.js');
const { UsageLedger } = require('../dist/usage-ledger.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-probe-'));
const ledger = new UsageLedger(dir, () => {});
const usage = (p, c, h) => ({ promptTokens: p, completionTokens: c, totalTokens: p + c, cacheHitTokens: h, cacheMissTokens: p - h });
ledger.record(ledger.begin({ kind: 'chat', target: 'p:10001' }, 'deepseek-flash'), usage(1200, 340, 900));
ledger.record(ledger.begin({ kind: 'chat', target: 'g:20002' }, 'deepseek-flash'), usage(3000, 120, 0));
ledger.record(ledger.begin({ kind: 'preview', target: 'p:10001' }, 'deepseek-flash'), usage(400, 90, 100));
ledger.record(ledger.begin({ kind: 'persona' }, 'deepseek-flash'), null);

const control = {
  usageAnalytics: () => ({ apiVersion: 1, model: 'deepseek-flash', usage: ledger.view }),
  remoteState: () => ({ apiVersion: 1 })
};
let authed = false;
const access = {
  authenticate: () => (authed ? { id: 'probe-device' } : null),
  audit: () => {},
  exchange: () => { throw new Error('not used'); },
  revokeDevice: () => true
};

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); };

(async () => {
  const server = new MobileWebServer({ control, access, getPublicUrl: () => '', log: () => {} }, { port: 0, host: '127.0.0.1' });
  const port = await server.start();
  const base = `http://127.0.0.1:${port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });

  const unauth = await get('/api/v1/usage/analytics');
  check('analytics API rejects an unpaired device', unauth.status === 401, `status=${unauth.status}`);

  for (const asset of ['/dashboard', '/dashboard.css', '/dashboard.js']) {
    const res = await get(asset);
    const body = await res.text();
    check(`${asset} is served without a device token`, res.status === 200 && body.length > 200, `status=${res.status} bytes=${body.length}`);
    check(`${asset} carries a strict CSP`, /script-src 'self'/.test(res.headers.get('content-security-policy') || ''), res.headers.get('content-security-policy'));
  }

  authed = true;
  const res = await get('/api/v1/usage/analytics');
  const payload = await res.json();
  check('analytics API answers a paired device', res.status === 200 && payload.ok === true, `status=${res.status}`);

  const a = payload.data.usage.analytics;
  check('per-model rows are present', a.models.length === 1 && a.models[0].model === 'deepseek-flash', JSON.stringify(a.models.map(m => m.model)));
  check('model total equals the aggregate total', a.models[0].pico === payload.data.usage.total.pico, `${a.models[0].pico} vs ${payload.data.usage.total.pico}`);
  check('daily series is present', a.daily.length === 1, JSON.stringify(a.daily.map(d => d.date)));
  check('hourly series is present', a.hourly.length === 1, JSON.stringify(a.hourly.map(h => h.hour)));
  check('call detail lists every call', a.events.length === 4, `events=${a.events.length}`);
  check('the usage-less call is flagged unknown', a.events.some(e => e.status === 'unknown'), JSON.stringify(a.events.map(e => e.status)));
  check('detail carries no chat text or key fields', !/prompt|messages|apiKey|"key"/.test(JSON.stringify(a.events)), 'shape checked');
  check('amounts are formatted for display', typeof a.models[0].amount === 'string' && /^\d+\.\d{8}$|^<0/.test(a.models[0].amount), a.models[0].amount);

  const query = await get('/api/v1/usage/analytics?range=7d');
  check('query strings stay rejected on the API', query.status === 400, `status=${query.status}`);

  // fetch() refuses to override Host, so drive a raw request for this check.
  const badHost = await new Promise((resolve, reject) => {
    const req = require('node:http').request({ host: '127.0.0.1', port, path: '/dashboard', method: 'GET', headers: { Host: 'evil.example.com' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  check('a foreign Host header is refused', badHost === 421, `status=${badHost}`);

  const post = await fetch(base + '/api/v1/usage/analytics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check('the analytics endpoint is read-only', post.status === 404 || post.status === 400, `status=${post.status}`);

  await server.stop();

  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.detail}`); }
  console.log(failed === 0 ? `DASHBOARD_PROBE_PASS ${results.length}` : `DASHBOARD_PROBE_FAIL ${failed}/${results.length}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('PROBE_ERROR', e); process.exit(1); });
