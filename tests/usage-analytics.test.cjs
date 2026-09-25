'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { UsageLedger } = require('../dist/usage-ledger.js');
const { UsageAnalytics, dayKey, hourKey, MAX_EVENTS } = require('../dist/usage-analytics.js');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'usage-analytics-'));
const usage = (prompt, completion, hit) => {
  const value = { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
  if (hit !== undefined) { value.cacheHitTokens = hit; value.cacheMissTokens = prompt - hit; }
  return value;
};
const ledgerFile = dir => JSON.parse(fs.readFileSync(path.join(dir, 'usage-ledger.json'), 'utf8'));

test('per-model split accumulates separately and matches the aggregate total', () => {
  const dir = tempDir();
  const ledger = new UsageLedger(dir, () => {});
  ledger.record(ledger.begin({ kind: 'chat', target: 'p:10001' }, 'deepseek-flash'), usage(1000, 500, 400));
  ledger.record(ledger.begin({ kind: 'chat', target: 'g:20002' }, 'deepseek-flash'), usage(2000, 100, 0));
  const view = ledger.view;
  const models = view.analytics.models;
  assert.equal(models.length, 1, 'only the configured model produced billable calls');
  assert.equal(models[0].model, 'deepseek-flash');
  assert.equal(models[0].calls, 2);
  assert.equal(models[0].pico, view.total.pico, 'model split must not invent or lose money');
  assert.equal(models[0].amount, view.total.amount);
});

test('an unsupported model is counted as a call but never priced with another model rate', () => {
  const dir = tempDir();
  const ledger = new UsageLedger(dir, () => {});
  ledger.record(ledger.begin({ kind: 'chat', target: 'p:10001' }, 'some-other-model'), usage(1000, 500, 400));
  const view = ledger.view;
  const row = view.analytics.models.find(m => m.model === 'some-other-model');
  assert.ok(row, 'the model still appears so the call is not hidden');
  assert.equal(row.calls, 1);
  assert.equal(row.pico, '0', 'no price exists for this model, so no amount is fabricated');
  assert.equal(row.unknown, 1, 'it stays flagged as usage-incomplete instead of a free call');
  assert.equal(view.total.pico, '0');
});

test('daily and hourly buckets agree with the total and use local-time keys', () => {
  const dir = tempDir();
  const ledger = new UsageLedger(dir, () => {});
  ledger.record(ledger.begin({ kind: 'chat', target: 'p:10001' }, 'deepseek-flash'), usage(800, 200, 300));
  const view = ledger.view;
  assert.equal(view.analytics.daily.length, 1);
  assert.equal(view.analytics.daily[0].date, dayKey(Date.now()));
  assert.equal(view.analytics.daily[0].pico, view.total.pico);
  assert.equal(view.analytics.hourly[0].hour, hourKey(Date.now()));
  assert.equal(view.analytics.hourly[0].pico, view.total.pico);
});

test('call detail records dimensions without secrets or chat text', () => {
  const dir = tempDir();
  const ledger = new UsageLedger(dir, () => {});
  ledger.record(ledger.begin({ kind: 'preview', target: 'p:10001' }, 'deepseek-flash'), usage(500, 250, 200));
  const [event] = ledger.view.analytics.events;
  assert.equal(event.kind, 'preview');
  assert.equal(event.target, 'p:10001');
  assert.equal(event.model, 'deepseek-flash');
  assert.equal(event.input, 500);
  assert.equal(event.output, 250);
  assert.equal(event.hit, 200);
  assert.equal(event.status, 'complete');
  const raw = fs.readFileSync(path.join(dir, 'usage-ledger.json'), 'utf8');
  assert.ok(!/sk-/.test(raw), 'no API key material is written');
  assert.equal(Object.keys(event).sort().join(','), 'amount,at,hit,input,kind,model,output,pico,status,target');
});

test('a call that never reports usage stays unknown in every new dimension', () => {
  const dir = tempDir();
  const ledger = new UsageLedger(dir, () => {});
  ledger.record(ledger.begin({ kind: 'chat', target: 'p:10001' }, 'deepseek-flash'), null);
  const view = ledger.view;
  assert.equal(view.analytics.models[0].unknown, 1);
  assert.equal(view.analytics.daily[0].unknown, 1);
  assert.equal(view.analytics.events[0].status, 'unknown');
  assert.equal(view.analytics.events[0].pico, '0');
});

test('a missing cache split is marked assumed rather than reported as real cache hits', () => {
  const dir = tempDir();
  const ledger = new UsageLedger(dir, () => {});
  ledger.record(ledger.begin({ kind: 'chat', target: 'p:10001' }, 'deepseek-flash'), usage(1000, 100));
  const view = ledger.view;
  assert.equal(view.analytics.models[0].assumed, 1);
  assert.equal(view.analytics.models[0].hit, '0');
  assert.equal(view.analytics.events[0].status, 'assumed');
});

test('duplicate settlement cannot double count the new dimensions', () => {
  const dir = tempDir();
  const ledger = new UsageLedger(dir, () => {});
  const ticket = ledger.begin({ kind: 'chat', target: 'p:10001' }, 'deepseek-flash');
  ledger.record(ticket, usage(1000, 500, 400));
  ledger.record(ticket, usage(1000, 500, 400));
  const view = ledger.view;
  assert.equal(view.analytics.models[0].calls, 1);
  assert.equal(view.analytics.events.length, 1);
  assert.equal(view.analytics.models[0].pico, view.total.pico);
});

test('a v1 ledger upgrades in place: totals survive and new dimensions start empty', () => {
  const dir = tempDir();
  const first = new UsageLedger(dir, () => {});
  first.record(first.begin({ kind: 'chat', target: 'p:10001' }, 'deepseek-flash'), usage(1000, 500, 400));
  const before = first.view.total;

  // Rewrite the file in the historical v1 shape, exactly as an older install would have left it.
  const stored = ledgerFile(dir);
  delete stored.analytics;
  stored.version = 1;
  fs.writeFileSync(path.join(dir, 'usage-ledger.json'), JSON.stringify(stored));

  const upgraded = new UsageLedger(dir, () => {});
  const view = upgraded.view;
  assert.equal(view.available, true);
  assert.equal(view.total.pico, before.pico, 'historical money is preserved, not reset');
  assert.equal(view.total.calls, before.calls);
  assert.deepEqual(view.analytics.models, [], 'old calls carry no model name, so none is invented');
  assert.deepEqual(view.analytics.events, []);

  upgraded.record(upgraded.begin({ kind: 'chat', target: 'p:10001' }, 'deepseek-flash'), usage(100, 100, 0));
  assert.equal(ledgerFile(dir).version, 2);
  assert.equal(upgraded.view.total.calls, before.calls + 1);
});

test('v2 detail survives a restart together with the totals', () => {
  const dir = tempDir();
  const first = new UsageLedger(dir, () => {});
  first.record(first.begin({ kind: 'chat', target: 'g:20002' }, 'deepseek-flash'), usage(1200, 300, 200));
  const before = first.view;

  const second = new UsageLedger(dir, () => {});
  const after = second.view;
  assert.equal(after.total.pico, before.total.pico);
  assert.equal(after.analytics.models[0].pico, before.analytics.models[0].pico);
  assert.equal(after.analytics.events.length, 1);
  assert.equal(after.analytics.events[0].target, 'g:20002');
  assert.equal(after.analytics.daily[0].date, before.analytics.daily[0].date);
});

test('a corrupt analytics section freezes detail writes but keeps totals usable', () => {
  const dir = tempDir();
  const first = new UsageLedger(dir, () => {});
  first.record(first.begin({ kind: 'chat', target: 'p:10001' }, 'deepseek-flash'), usage(1000, 500, 400));
  const before = first.view.total;

  const stored = ledgerFile(dir);
  stored.analytics.models = { 'deepseek-flash': { calls: -5 } };
  fs.writeFileSync(path.join(dir, 'usage-ledger.json'), JSON.stringify(stored));

  const reopened = new UsageLedger(dir, () => {});
  const view = reopened.view;
  assert.equal(view.available, true, 'aggregate totals remain readable');
  assert.equal(view.total.pico, before.pico);
  assert.equal(view.analytics.available, false);
  assert.ok(view.analytics.warning.length > 0);

  reopened.record(reopened.begin({ kind: 'chat', target: 'p:10001' }, 'deepseek-flash'), usage(10, 10, 0));
  assert.deepEqual(ledgerFile(dir).analytics.models, { 'deepseek-flash': { calls: -5 } }, 'the original bytes are not overwritten');
});

test('the call log is bounded and reports that older entries rolled off', () => {
  const analytics = new UsageAnalytics();
  for (let i = 0; i < MAX_EVENTS + 5; i++) {
    analytics.settle(analytics.begin('deepseek-flash', 'chat', 'p:10001'), { input: 1, output: 1, hit: 0, pico: '1', assumed: false });
  }
  const view = analytics.view;
  assert.equal(view.events.length, MAX_EVENTS);
  assert.equal(view.eventsTruncated, true);
  assert.equal(view.models[0].calls, MAX_EVENTS + 5, 'aggregates keep counting past the detail window');
});

test('newest events are listed first for the dashboard', () => {
  const analytics = new UsageAnalytics();
  analytics.settle(analytics.begin('deepseek-flash', 'chat', 'p:10001', 1000), { input: 1, output: 1, hit: 0, pico: '1', assumed: false });
  analytics.settle(analytics.begin('deepseek-flash', 'chat', 'p:10002', 2000), { input: 1, output: 1, hit: 0, pico: '1', assumed: false });
  const view = analytics.view;
  assert.equal(view.events[0].target, 'p:10002');
  assert.equal(view.events[1].target, 'p:10001');
});
