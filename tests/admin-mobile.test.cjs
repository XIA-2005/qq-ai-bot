const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaults, validate, FOLLOWUP_DISCLOSURE_VERSION } = require('../dist/config.js');
const { ControlService } = require('../dist/control.js');
const { RemoteAccess } = require('../dist/remote-access.js');
const { AdminCommandHandler } = require('../dist/admin.js');
const { MobileWebServer } = require('../dist/web-server.js');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ai-remote-')); }
function createMock(initialConfig = {}) {
  const dir = tempDir();
  const config = validate({
    ...defaults,
    friends: ['10000001'],
    groups: ['20000001', '20000002'],
    adminIds: ['10000001'],
    remotePublicUrl: 'https://bot.example.com',
    autoReplyConsent: true,
    autoReplyConsentVersion: FOLLOWUP_DISCLOSURE_VERSION,
    visionEnabled: true,
    ...initialConfig
  });
  const store = { config, key: 'test-key', token: '', save(c) { store.config = c; } };
  let running = true;
  const engine = {
    active: false, pending: 0, activeCount: 0, merging: 0,
    get running() { return running; },
    start() { running = true; }, pause() { running = false; },
    updateConfig(c) { store.config = c; }
  };
  const account = {
    async queryBalance() {},
    view: { balance: { data: { balances: [{ currency: 'CNY', total: '18.52', granted: '5.00', toppedUp: '13.52' }] } } }
  };
  const usage = { view: { total: { amount: '0.38', calls: 26 } } };
  const sentMessages = [];
  const bot = {
    self: '10000002', selfName: '测试机器人', connected: true,
    async call(action, params) { sentMessages.push({ action, params }); return { message_id: 1 }; }
  };
  const access = new RemoteAccess(dir);
  const audit = [];
  const control = new ControlService({ store, engine, account, usage, bot }, {
    isBusy: () => engine.active,
    arm() {},
    pauseSideEffects() { engine.pause(); },
    applyConfig(c) { store.save(c); engine.updateConfig(c); },
    snapshot: () => ({ running: engine.running }),
    audit(entry) { audit.push(entry); access.audit(entry); }
  });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, store, engine, account, usage, bot, sentMessages, access, control, audit, cleanup };
}

function request(port, method, route, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { ...(body !== null ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, json: data && res.headers['content-type']?.includes('json') ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body !== null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function authHeaders(token, key) {
  return { Authorization: `Bearer ${token}`, ...(key ? { 'Idempotency-Key': key } : {}) };
}

test('administrator permission is independent from the reply whitelist', async () => {
  const ctx = createMock({ friends: ['10000001', '77777777'], adminIds: ['10000001'] });
  try {
    const handler = new AdminCommandHandler({ ...ctx, log() {} });
    assert.equal(handler.isAdmin('10000001'), true);
    assert.equal(handler.isAdmin('77777777'), false);
    assert.equal(handler.isCommand('#状态'), true);
    await assert.rejects(() => handler.execute('#状态', '77777777'), /无管理员权限/);
    const ignored = await handler.handleEvent({ post_type: 'message', message_type: 'private', user_id: 77777777, raw_message: '#状态' }, ctx.bot.self);
    assert.equal(ignored, false);
    assert.equal(ctx.sentMessages.length, 0);
  } finally { ctx.cleanup(); }
});

test('QQ administrator commands use ControlService and never disclose a PIN or token', async () => {
  const ctx = createMock();
  try {
    const handler = new AdminCommandHandler({ ...ctx, log() {} });
    assert.match(await handler.execute('#帮助', '10000001'), /管理员指令/);
    assert.match(await handler.execute('#余额', '10000001'), /18\.52/);
    assert.match(await handler.execute('#状态', '10000001'), /10000002/);
    assert.match(await handler.execute('#加群 12345678', '10000001'), /成功添加群/);
    assert.ok(ctx.store.config.groups.includes('12345678'));
    assert.match(await handler.execute('#退群 12345678', '10000001'), /移出白名单/);
    assert.ok(!ctx.store.config.groups.includes('12345678'));
    await handler.execute('#暂停', '10000001');
    assert.equal(ctx.engine.running, false);
    await handler.execute('#启动', '10000001');
    assert.equal(ctx.engine.running, true);
    await handler.execute('#人设 新的人设', '10000001');
    assert.equal(ctx.store.config.prompt, '新的人设');
    const panel = await handler.execute('#面板', '10000001');
    assert.match(panel, /https:\/\/bot\.example\.com/);
    assert.match(panel, /不会发送密码、配对秘密或设备令牌/);
    assert.doesNotMatch(panel, /\b\d{6}\b|Bearer [A-Za-z0-9._~-]/);
    assert.ok(ctx.audit.some(entry => entry.source === 'qq' && entry.action === 'target.add'));
  } finally { ctx.cleanup(); }
});

test('legacy configuration does not promote friends and remote URL requires a fixed HTTPS hostname', () => {
  const migrated = validate({ ...defaults, friends: ['10000001'] });
  assert.deepEqual(migrated.adminIds, []);
  assert.equal(migrated.remotePublicUrl, '');
  assert.throws(() => validate({ ...defaults, remotePublicUrl: 'http://bot.example.com' }), /Named Tunnel/);
  assert.throws(() => validate({ ...defaults, remotePublicUrl: 'https://127.0.0.1' }), /Named Tunnel/);
  assert.throws(() => validate({ ...defaults, remotePublicUrl: 'https://bot.example.com/path' }), /Named Tunnel/);
  assert.equal(validate({ ...defaults, remotePublicUrl: 'https://BOT.Example.com' }).remotePublicUrl, 'https://bot.example.com');
});

test('Windows tunnel installers use a pinned binary and never accept a Token argument', () => {
  const root = path.join(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const install = fs.readFileSync(path.join(root, 'scripts', 'install-cloudflare-tunnel.cmd'), 'utf8');
  const uninstall = fs.readFileSync(path.join(root, 'scripts', 'uninstall-cloudflare-tunnel.cmd'), 'utf8');
  const domainSetup = fs.readFileSync(path.join(root, 'scripts', 'setup-remote-tunnel.ps1'), 'utf8');
  const verified = fs.readFileSync(path.join(root, 'scripts', 'cloudflare-verified.ps1'), 'utf8');
  const rootEntry = fs.readFileSync(path.join(root, '配置iPhone固定远程.cmd'), 'utf8');
  assert.match(install, /setup-remote-tunnel\.ps1/);
  assert.match(install, /if not "%~1"==""/);
  assert.doesNotMatch(install, /service install|where cloudflared|releases\/latest/);
  assert.match(uninstall, /uninstall-cloudflare-tunnel\.ps1/);
  assert.doesNotMatch(uninstall, /where cloudflared|service uninstall/);
  assert.match(domainSetup, /qqbot\.example\.com/);
  assert.match(domainSetup, /127\.0\.0\.1:5188/);
  assert.match(domainSetup, /Get-VerifiedCloudflared -DownloadIfMissing/);
  assert.match(domainSetup, /Read-Host 'Tunnel Token' -AsSecureString/);
  assert.doesNotMatch(domainSetup, /Get-Command cloudflared|releases\/latest|trycloudflare\.com/);
  assert.match(verified, /2026\.9\.1/);
  assert.match(verified, /2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712/);
  assert.match(verified, /Get-FileHash -LiteralPath \$Path -Algorithm SHA256/);
  assert.equal(fs.existsSync(path.join(root, '一键开启手机远程(免同一网络).cmd')), false);
  assert.match(rootEntry, /if not "%~1"==""/);
  assert.match(packageJson.scripts.build, /clean-dist\.cjs/);
  assert.ok(packageJson.build.files.includes('dist/**/*.js'));
  assert.ok(packageJson.build.files.includes('mobile/**/*'));
  assert.ok(!packageJson.build.files.includes('dist/**/*'));
});

test('remote pairing is one-time, stores only token hashes, expires, and can be revoked per device', () => {
  const dir = tempDir();
  let now = 1_800_000_000_000;
  try {
    const access = new RemoteAccess(dir, () => now);
    const pairing = access.createPairing('https://bot.example.com');
    assert.match(pairing.pairingUrl, new RegExp(`^https://bot\\.example\\.com/pair/${pairing.pairingId}#pairingId=`));
    assert.ok(!pairing.pairingUrl.includes('?'));
    assert.match(pairing.pairingUrl, new RegExp(pairing.secret));
    assert.throws(() => access.exchange(pairing.pairingId, 'wrong', 'iPhone'), /无效或已过期/);
    const issued = access.exchange(pairing.pairingId, pairing.secret, 'Alice iPhone');
    assert.equal(access.authenticate(issued.token).name, 'Alice iPhone');
    assert.throws(() => access.exchange(pairing.pairingId, pairing.secret, 'again'), /无效或已过期/);
    const disk = fs.readFileSync(path.join(dir, 'remote-devices.json'), 'utf8');
    assert.doesNotMatch(disk, new RegExp(issued.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(disk, /tokenHash/);
    assert.equal(access.revokeDevice(issued.device.id), true);
    assert.equal(access.authenticate(issued.token), null);

    const expiring = access.createPairing('https://bot.example.com');
    const token2 = access.exchange(expiring.pairingId, expiring.secret, 'Old iPhone').token;
    now += 91 * 24 * 60 * 60 * 1000;
    assert.equal(access.authenticate(token2), null);
    assert.equal(access.listDevices().length, 0);
    assert.throws(() => access.createPairing('https://temporary.trycloudflare.com'), /Named Tunnel/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ControlService enforces desktop-only first consent and preserves target invariants', () => {
  const ctx = createMock({ autoReplyConsent: false, profiles: { 'g:20000001': { remark: 'test', enabled: true, prompt: null, replyLength: 'inherit', historyTurns: null, groupMode: 'proactive' } }, proactiveGroups: ['20000001'] });
  try {
    assert.throws(() => ctx.control.start({ source: 'ios', id: 'phone' }), error => error.code === 'CONSENT_REQUIRED');
    ctx.control.start({ source: 'desktop', id: 'local' }, true);
    assert.equal(ctx.store.config.autoReplyConsent, true);
    const engagementState = ctx.control.setEngagement({ source: 'ios', id: 'phone' }, 75);
    assert.equal(engagementState.engagement, 75);
    assert.equal(ctx.store.config.engagement, 75);
    assert.equal(ctx.engine.running, true);
    assert.throws(() => ctx.control.setEngagement({ source: 'ios', id: 'phone' }, 101), error => error.code === 'ENGAGEMENT_INVALID');
    ctx.control.removeTarget({ source: 'ios', id: 'phone' }, 'group', '20000001');
    assert.ok(!ctx.store.config.groups.includes('20000001'));
    assert.ok(!ctx.store.config.proactiveGroups.includes('20000001'));
    assert.equal(ctx.store.config.profiles['g:20000001'], undefined);
  } finally { ctx.cleanup(); }
});

test('auditing a completed pairing can fail on disk without invalidating its token', () => {
  const dir = tempDir();
  try {
    const access = new RemoteAccess(dir);
    const save = access.saveAudit.bind(access);
    access.saveAudit = () => { throw new Error('simulated audit disk failure'); };
    const pair = access.createPairing('https://bot.example.com');
    const issued = access.exchange(pair.pairingId, pair.secret, 'test phone');
    assert.equal(access.authenticate(issued.token).id, issued.device.id);
    assert.equal(access.view().auditPending, 1);
    assert.match(access.view().auditWarning, /重启可能丢失/);
    access.saveAudit = save;
    access.audit({source:'desktop',actorId:'local',action:'audit.recovered',result:'success'});
    assert.equal(access.view().auditPending, 0);
    assert.equal(access.view().auditWarning, '');
    assert.match(fs.readFileSync(path.join(dir, 'remote-audit.json'), 'utf8'), /device.pair/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('control mutations and error codes survive a throwing audit hook; legacy consent needs Windows', async () => {
  const ctx = createMock({autoReplyConsent:true,autoReplyConsentVersion:0});
  try {
    ctx.access.audit = () => { throw new Error('audit unavailable'); };
    assert.throws(() => ctx.control.start({source:'ios',id:'phone'}), error => error.code === 'CONSENT_REQUIRED');
    assert.equal(ctx.engine.running, true, 'mock is already running, but consent has not been upgraded');
    ctx.control.start({source:'desktop',id:'local'}, true);
    assert.equal(ctx.store.config.autoReplyConsentVersion, FOLLOWUP_DISCLOSURE_VERSION);
    assert.equal(ctx.control.setEngagement({source:'ios',id:'phone'}, 55).engagement, 55);
    assert.equal(ctx.store.config.engagement, 55);
    assert.throws(() => ctx.control.setEngagement({source:'ios',id:'phone'}, 101), error => error.code === 'ENGAGEMENT_INVALID');
    await ctx.control.refreshBalance({source:'ios',id:'phone'});
  } finally { ctx.cleanup(); }
});

test('mobile auth failures and self-revocation retain their HTTP result when audit is unavailable', async () => {
  const ctx = createMock();
  const pair = ctx.access.createPairing(ctx.store.config.remotePublicUrl);
  const token = ctx.access.exchange(pair.pairingId, pair.secret, 'test phone').token;
  ctx.access.audit = () => { throw new Error('audit unavailable'); };
  const server = new MobileWebServer({control:ctx.control,access:ctx.access,getPublicUrl:()=>ctx.store.config.remotePublicUrl,log(){}}, {port:0,host:'127.0.0.1'});
  await server.start();
  try {
    const port = server.getPort();
    const unauthorized = await request(port, 'GET', '/api/v1/state');
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.json.error.code, 'UNAUTHORIZED');
    const updated = await request(port, 'PUT', '/api/v1/engagement', {level:65}, authHeaders(token,'audit-outage-engage'));
    assert.equal(updated.status, 200);assert.equal(ctx.store.config.engagement, 65);
    const bad = await request(port, 'PUT', '/api/v1/engagement', {level:101}, authHeaders(token,'audit-outage-invalid'));
    assert.equal(bad.status, 400);assert.equal(bad.json.error.code, 'ENGAGEMENT_INVALID');
    const revoked = await request(port, 'DELETE', '/api/v1/devices/current', null, authHeaders(token,'audit-outage-revoke'));
    assert.equal(revoked.status, 200);assert.equal(revoked.json.data.revoked, true);
  } finally { await server.stop(); ctx.cleanup(); }
});

test('secure v1 mobile API removes PIN auth, binds loopback, pairs devices, and enforces idempotency', async () => {
  const ctx = createMock();
  const server = new MobileWebServer({ control: ctx.control, access: ctx.access, getPublicUrl: () => ctx.store.config.remotePublicUrl, log() {} }, { port: 0, host: '127.0.0.1' });
  await server.start();
  const port = server.getPort();
  try {
    assert.equal(server.getHost(), '127.0.0.1');
    const home = await request(port, 'GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.body, /不再接受固定 PIN/);
    assert.equal(home.headers['access-control-allow-origin'], undefined);
    assert.equal(home.headers['x-frame-options'], 'DENY');
    assert.equal(home.headers['cache-control'], 'no-cache');
      assert.match(home.headers['content-security-policy'], /script-src 'self'/);
      const pairPage = await request(port, 'GET', '/pair/11111111-1111-4111-8111-111111111111');
      assert.equal(pairPage.status, 200);
      assert.match(pairPage.body, /id="pairing"/);
      const manifest = await request(port, 'GET', '/manifest.webmanifest');
      assert.equal(manifest.status, 200);
      assert.equal(manifest.json.display, 'standalone');
      const appJs = await request(port, 'GET', '/app-v3.js');
      assert.equal(appJs.status, 200);
      assert.match(appJs.body, /pairingId/);
      assert.match(appJs.body, /saveEngagement/);
      assert.match(home.body, /id="engagement"/);
      const serviceWorker = await request(port, 'GET', '/sw-v3.js');
      assert.equal(serviceWorker.status, 200);
      assert.match(serviceWorker.body, /qq-ai-pwa-v3/);

    const health = await request(port, 'GET', '/api/v1/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.data.apiVersion, 1);
    const legacy = await request(port, 'POST', '/api/auth', { pin: 'anything' });
    assert.equal(legacy.status, 410);
    assert.equal(legacy.json.error.code, 'LEGACY_API_REMOVED');

    const pairing = ctx.access.createPairing(ctx.store.config.remotePublicUrl);
    const paired = await request(port, 'POST', '/api/v1/pair/exchange', { pairingId: pairing.pairingId, secret: pairing.secret, deviceName: 'Test iPhone' });
    assert.equal(paired.status, 201);
    const token = paired.json.data.token;
    assert.ok(token);
    const setCookie = paired.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie));
    assert.match(setCookie[0], /__Host-qqai_device=.*HttpOnly.*Secure.*SameSite=Strict/);
    const cookie = setCookie[0].split(';')[0];
    const cookieState = await request(port, 'GET', '/api/v1/state', null, { Cookie: cookie });
    assert.equal(cookieState.status, 200);
    assert.equal(cookieState.json.data.botSelf, '10000002');
    const reused = await request(port, 'POST', '/api/v1/pair/exchange', { pairingId: pairing.pairingId, secret: pairing.secret, deviceName: 'Replay' });
    assert.equal(reused.status, 401);

    const state = await request(port, 'GET', '/api/v1/state', null, authHeaders(token));
    assert.equal(state.status, 200);
    assert.equal(state.json.data.botSelf, '10000002');
    assert.equal(state.json.data.engagement, 30);
    const engagement = await request(port, 'PUT', '/api/v1/engagement', { level: 72 }, authHeaders(token, 'engage-0001'));
    assert.equal(engagement.status, 200);
    assert.equal(engagement.json.data.engagement, 72);
    assert.equal(ctx.store.config.engagement, 72);
    assert.equal(ctx.engine.running, true);
    const badEngagement = await request(port, 'PUT', '/api/v1/engagement', { level: 101 }, authHeaders(token, 'engage-bad1'));
    assert.equal(badEngagement.status, 400);
    assert.equal(badEngagement.json.error.code, 'ENGAGEMENT_INVALID');
    const missingIdem = await request(port, 'POST', '/api/v1/reply/pause', {}, authHeaders(token));
    assert.equal(missingIdem.status, 400);
    assert.equal(missingIdem.json.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const paused = await request(port, 'POST', '/api/v1/reply/pause', {}, authHeaders(token, 'pause-0001'));
    const replay = await request(port, 'POST', '/api/v1/reply/pause', {}, authHeaders(token, 'pause-0001'));
    assert.equal(paused.status, 200);
    assert.deepEqual(replay.json, paused.json);
    assert.equal(ctx.engine.running, false);
    const conflict = await request(port, 'POST', '/api/v1/reply/start', {}, authHeaders(token, 'pause-0001'));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'IDEMPOTENCY_CONFLICT');

    const added = await request(port, 'POST', '/api/v1/targets', { kind: 'group', id: '55667788' }, authHeaders(token, 'target-add-1'));
    assert.equal(added.status, 200);
    assert.ok(ctx.store.config.groups.includes('55667788'));
    const removed = await request(port, 'DELETE', '/api/v1/targets/group/55667788', null, authHeaders(token, 'target-rm-01'));
    assert.equal(removed.status, 200);
    assert.ok(!ctx.store.config.groups.includes('55667788'));
    const persona = await request(port, 'PUT', '/api/v1/persona/global', { prompt: '来自 iPhone 的人设' }, authHeaders(token, 'persona-0001'));
    assert.equal(persona.status, 200);
    assert.equal(ctx.store.config.prompt, '来自 iPhone 的人设');

    const selfRevoke = await request(port, 'DELETE', '/api/v1/devices/current', null, authHeaders(token, 'self-revoke-1'));
    assert.equal(selfRevoke.status, 200);
    assert.equal(selfRevoke.json.data.revoked, true);
    const revoked = await request(port, 'GET', '/api/v1/state', null, authHeaders(token));
    assert.equal(revoked.status, 401);
  } finally {
    await server.stop();
    ctx.cleanup();
  }
});
