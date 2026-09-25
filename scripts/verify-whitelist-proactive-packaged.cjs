// Isolated profile verification for whitelist row layout alignment and proactiveGroups dynamic editor
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const WebSocket = require('ws');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ai-whitelist-test-'));
const artifacts = path.join(root, 'artifacts');
let child, ws, seq = 0;
const pending = new Map(), checks = [];
fs.mkdirSync(artifacts, { recursive: true });

const delay = ms => new Promise(r => setTimeout(r, ms));
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP timeout ' + method));
    }, 12000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const call = (name, payload = {}) => evaluate(`window.botAPI.call(${JSON.stringify(name)},${JSON.stringify(payload)})`);

(async () => {
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  child = spawn(path.join(root, 'release-v0.9.0', 'win-unpacked', 'QQ AI Bot.exe'), [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1'
  ], { env, cwd: root, windowsHide: true, stdio: 'ignore' });

  let target;
  for (let n = 0; n < 60; n++) {
    if (child.exitCode !== null) throw new Error('Test instance exited');
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })).json()).find(p => p.type === 'page' && p.url.includes('app.asar'));
      if (target) break;
    } catch {}
    await delay(400);
  }
  assert.ok(target, 'CDP target found');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString()), p = pending.get(m.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });

  for (let n = 0; n < 30; n++) {
    if (await evaluate("typeof window.botAPI==='object' && document.getElementById('modelId')?.value==='deepseek-flash'")) break;
    await delay(200);
  }

  // Navigate to rules page
  await evaluate("document.querySelector('[data-page=rules]').click()");
  await delay(300);

  // Check 1: Friends and Groups whitelist editors have identical height and width
  const dimensionsBefore = await evaluate(`(() => {
    const f = document.querySelector('fieldset:has(#friends)');
    const g = document.querySelector('fieldset:has(#groups)');
    const fb = f.getBoundingClientRect();
    const gb = g.getBoundingClientRect();
    return {
      fWidth: Math.round(fb.width),
      fHeight: Math.round(fb.height),
      gWidth: Math.round(gb.width),
      gHeight: Math.round(gb.height)
    };
  })()`);
  assert.equal(dimensionsBefore.fHeight, dimensionsBefore.gHeight, `Fieldsets must have equal initial height: f=${dimensionsBefore.fHeight}, g=${dimensionsBefore.gHeight}`);
  assert.equal(dimensionsBefore.fWidth, dimensionsBefore.gWidth, `Fieldsets must have equal initial width: f=${dimensionsBefore.fWidth}, g=${dimensionsBefore.gWidth}`);
  checks.push('1. Friends and Groups whitelist fieldset cards have identical initial height and width');

  // Check 2: Add a row to both, verify their entries and fieldsets have identical height
  const dimensionsAfterAdd = await evaluate(`(() => {
    document.querySelector('#friends .add-row').click();
    document.querySelector('#groups .add-row').click();
    const f = document.querySelector('fieldset:has(#friends)');
    const g = document.querySelector('fieldset:has(#groups)');
    const fEntries = document.querySelectorAll('#friends .whitelist-entry');
    const gEntries = document.querySelectorAll('#groups .whitelist-entry');
    const fb = f.getBoundingClientRect();
    const gb = g.getBoundingClientRect();
    const fe1 = fEntries[fEntries.length - 1].getBoundingClientRect();
    const ge1 = gEntries[gEntries.length - 1].getBoundingClientRect();
    return {
      fHeight: Math.round(fb.height),
      gHeight: Math.round(gb.height),
      entryFHeight: Math.round(fe1.height),
      entryGHeight: Math.round(ge1.height)
    };
  })()`);
  assert.equal(dimensionsAfterAdd.fHeight, dimensionsAfterAdd.gHeight, `Fieldsets after adding row must have equal height: f=${dimensionsAfterAdd.fHeight}, g=${dimensionsAfterAdd.gHeight}`);
  assert.equal(dimensionsAfterAdd.entryFHeight, dimensionsAfterAdd.entryGHeight, `Entries after adding row must have equal height: fe=${dimensionsAfterAdd.entryFHeight}, ge=${dimensionsAfterAdd.entryGHeight}`);
  checks.push('2. After adding rows, both the fieldsets and individual row entries remain identically sized in height');

  // Check 3: proactiveGroups editor is a dynamic row editor (not a textarea)
  const isDynamic = await evaluate(`(() => {
    const el = document.getElementById('proactiveGroups');
    return {
      isDiv: el.tagName === 'DIV',
      hasList: !!el.querySelector('.whitelist-list'),
      hasAddBtn: !!el.querySelector('.add-row'),
      initialRows: el.querySelectorAll('.whitelist-entry').length
    };
  })()`);
  assert.equal(isDynamic.isDiv, true);
  assert.equal(isDynamic.hasList, true);
  assert.equal(isDynamic.hasAddBtn, true);
  assert.equal(isDynamic.initialRows, 1);
  checks.push('3. proactiveGroups is a dynamic multi-row component with list, add button, and count');

  // Check 4: proactiveGroups disabled when proactiveEnabled is false
  const initiallyDisabled = await evaluate(`(() => {
    const cont = document.getElementById('proactiveGroups');
    const addBtn = cont.querySelector('.add-row');
    const input = cont.querySelector('.account-input');
    const removeBtn = cont.querySelector('.remove-row');
    return cont.disabled && addBtn.disabled && input.disabled && removeBtn.disabled;
  })()`);
  assert.equal(initiallyDisabled, true, 'proactiveGroups controls must be disabled when proactiveEnabled is unchecked');
  checks.push('4. proactiveGroups controls and container.disabled are true when unchecked');

  // Check 5: Toggle proactiveEnabled enables proactiveGroups, can add and remove rows
  await evaluate("document.getElementById('proactiveEnabled').click()");
  const enabledNow = await evaluate(`(() => {
    const cont = document.getElementById('proactiveGroups');
    const addBtn = cont.querySelector('.add-row');
    const input = cont.querySelector('.account-input');
    return !cont.disabled && !addBtn.disabled && !input.disabled;
  })()`);
  assert.equal(enabledNow, true, 'Controls become enabled after checking proactiveEnabled');

  // Add row via button
  await evaluate("document.querySelector('#proactiveGroups .add-row').click()");
  const rowCountAfterAdd = await evaluate("document.querySelectorAll('#proactiveGroups .whitelist-entry').length");
  assert.equal(rowCountAfterAdd, 2, 'Adding row creates a second entry');

  // Enter group ID into first row
  await evaluate(`(() => {
    const inputs = document.querySelectorAll('#proactiveGroups .account-input');
    inputs[0].value = '123456';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  // Group 123456 is not yet in groups whitelist, should show warning
  const warnText = await evaluate("document.querySelectorAll('#proactiveGroups .row-proactive-summary')[0].textContent");
  assert.match(warnText, /未加入上方群白名单/);
  checks.push('5. proactiveGroups dynamically adds rows and warns if group is not in group whitelist');

  // Remove row
  await evaluate("document.querySelectorAll('#proactiveGroups .remove-row')[1].click()");
  const rowCountAfterRemove = await evaluate("document.querySelectorAll('#proactiveGroups .whitelist-entry').length");
  assert.equal(rowCountAfterRemove, 1, 'Removing row decreases count');
  checks.push('6. proactiveGroups remove button correctly removes rows');

  // Capture screenshot of the verified rules page
  await evaluate("document.getElementById('proactiveEnabled').scrollIntoView({ block: 'center' })");
  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(artifacts, 'whitelist-proactive-aligned-v0.9.0.png'), Buffer.from(shot.data, 'base64'));
  checks.push('7. Captured screenshot to artifacts/whitelist-proactive-aligned-v0.9.0.png');

  console.log('WHITELIST_PROACTIVE_VERIFY_PASS ' + checks.length);
  checks.forEach(c => console.log('  ' + c));
})().catch(err => {
  console.error('VERIFY ERROR:', err);
  process.exitCode = 1;
}).finally(() => {
  try { child?.kill(); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
});
