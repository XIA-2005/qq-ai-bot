const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  BudgetManager,
  validateBudget,
  DEFAULT_BUDGET,
} = require("../dist/budget.js");
const { UsageLedger, peakPricing } = require("../dist/usage-ledger.js");

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qq-ai-p2-budget-"));
const c = { maxTokens: 128 },
  messages = [{ role: "user", content: "private-user-text-001" }];
const target = { kind: "chat", target: "g:12345678" };
function fixture(dir, clock = () => Date.now()) {
  const ledger = new UsageLedger(dir, () => {});
  return { ledger, budget: new BudgetManager(dir, ledger, () => {}, clock) };
}
const guarded = (b, where = target, m = messages) =>
  b.reserve(c, m, where, peakPricing);

test("fresh upgrade enables ¥2/day and ¥0.50 per friend/group, with durable pre-request holds", () => {
  const dir = temp();
  try {
    const { budget } = fixture(dir);
    assert.deepEqual(budget.view.settings, DEFAULT_BUDGET);
    assert.equal(budget.view.available, true);
    let first;
    for (let i = 0; i < 10; i++) {
      const ticket = guarded(budget);
      if (!first) first = ticket;
    }
    assert.equal(budget.view.targets["g:12345678"], "0.50000000");
    assert.throws(
      () => guarded(budget),
      (e) => e.code === "BUDGET_TARGET_LIMIT",
    );
    assert.ok(guarded(budget, { kind: "preview", target: "p:88888888" }));
    assert.ok(
      guarded(budget, { kind: "verification" }),
      "non-chat requests share global ceiling",
    );
    const disk = fs.readFileSync(path.join(dir, "model-budget.json"), "utf8");
    assert.doesNotMatch(
      disk,
      /private-user-text-001|Bearer|API Key|prompt|password/,
    );
    const again = fixture(dir).budget;
    assert.equal(again.view.spent, "0.60000000");
    assert.throws(
      () => guarded(again),
      (e) => e.code === "BUDGET_TARGET_LIMIT",
    );
    budget.settle(first, "10000000000"); // known ¥0.01 releases ¥0.04 of a ¥0.05 hold
    assert.equal(budget.view.spent, "0.56000000");
    assert.equal(fixture(dir).budget.view.spent, "0.56000000");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing response, cancellation, concurrency and crash keep conservative holds", () => {
  const dir = temp();
  try {
    const { budget } = fixture(dir),
      tickets = [];
    for (let i = 0; i < 10; i++) tickets.push(guarded(budget));
    assert.throws(
      () => guarded(budget),
      (e) => e.code === "BUDGET_TARGET_LIMIT",
    );
    budget.settle(tickets[0], null);
    budget.settle(tickets[0], "0"); // repeat settlement cannot release an unknown charge
    assert.equal(budget.view.targets["g:12345678"], "0.50000000");
    assert.equal(fixture(dir).budget.view.targets["g:12345678"], "0.50000000");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("global limit includes previews, verification and persona; high estimated risk blocks without a request", () => {
  const dir = temp();
  try {
    const { budget } = fixture(dir);
    for (let i = 0; i < 40; i++) guarded(budget, { kind: "persona" });
    assert.equal(budget.view.spent, "2.00000000");
    assert.throws(
      () => guarded(budget, { kind: "verification" }),
      (e) => e.code === "BUDGET_DAILY_LIMIT",
    );
    assert.throws(
      () => guarded(budget, { kind: "preview", target: "p:12345678" }),
      (e) => e.code === "BUDGET_DAILY_LIMIT",
    );
    assert.equal(fixture(dir).budget.view.spent, "2.00000000");
    const riskyDir = temp();
    try {
      const other = fixture(riskyDir);
      const price = { cacheHit: "10000", cacheMiss: "10000", output: "10000" };
      assert.throws(
        () => other.budget.reserve(c, messages, target, price),
        (e) => e.code === "BUDGET_DAILY_LIMIT",
      );
      assert.equal(other.budget.view.spent, "0.00000000");
    } finally {
      fs.rmSync(riskyDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failed durable write and corrupt data fail closed, without clobbering existing files", () => {
  const dir = temp(),
    file = path.join(dir, "model-budget.json");
  try {
    const { budget } = fixture(dir);
    const original = fs.readFileSync(file, "utf8");
    budget.save = () => {
      budget.problem = "磁盘写入失败";
      return false;
    };
    assert.throws(
      () => guarded(budget),
      (e) => e.code === "BUDGET_UNAVAILABLE",
    );
    assert.equal(budget.view.available, false);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    fs.writeFileSync(file, "{broken-file");
    const broken = fixture(dir).budget;
    assert.equal(broken.view.available, false);
    assert.throws(
      () => guarded(broken),
      (e) => e.code === "BUDGET_UNAVAILABLE",
    );
    assert.equal(fs.readFileSync(file, "utf8"), "{broken-file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("first-upgrade imports known and unknown usage; incomplete v1 history blocks today", () => {
  const dir = temp();
  try {
    const usage = new UsageLedger(dir, () => {});
    const known = usage.begin(target, "deepseek-flash");
    usage.record(known, {
      promptTokens: 100000,
      completionTokens: 0,
      totalTokens: 100000,
      cacheHitTokens: 0,
      cacheMissTokens: 100000,
    });
    const unknown = usage.begin(target, "deepseek-flash");
    usage.record(unknown, null);
    const budget = new BudgetManager(dir, new UsageLedger(dir, () => {}));
    assert.equal(budget.view.targets["g:12345678"], "0.25000000");
    assert.equal(budget.view.spent, "0.25000000");
    assert.equal(budget.view.uncertain, false);
    fs.rmSync(path.join(dir, "model-budget.json"));
    const old = JSON.parse(
      fs.readFileSync(path.join(dir, "usage-ledger.json"), "utf8"),
    );
    old.version = 1;
    delete old.analytics;
    fs.writeFileSync(path.join(dir, "usage-ledger.json"), JSON.stringify(old));
    const uncertain = new BudgetManager(dir, new UsageLedger(dir, () => {}));
    assert.equal(uncertain.view.uncertain, true);
    assert.throws(
      () => guarded(uncertain),
      (e) => e.code === "BUDGET_HISTORY_UNCERTAIN",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("disable/re-enable imports spending during disabled period, and settings persist safely", () => {
  const dir = temp();
  try {
    const { ledger, budget } = fixture(dir);
    assert.deepEqual(
      validateBudget({ enabled: true, daily: "1", perTarget: "0.5" }),
      { enabled: true, daily: "1.00", perTarget: "0.50" },
    );
    for (const settings of [
      { enabled: true, daily: "0", perTarget: "0.1" },
      { enabled: true, daily: "0.40", perTarget: "0.50" },
      { enabled: true, daily: "1.001", perTarget: "0.5" },
    ])
      assert.throws(
        () => budget.configure(settings),
        (e) => e.code === "BUDGET_INVALID",
      );
    budget.configure({ enabled: false, daily: "1", perTarget: "0.5" });
    assert.equal(guarded(budget), null);
    const ticket = ledger.begin(target, "deepseek-flash");
    ledger.record(ticket, {
      promptTokens: 100000,
      completionTokens: 0,
      totalTokens: 100000,
      cacheHitTokens: 0,
      cacheMissTokens: 100000,
    });
    budget.configure({ enabled: true, daily: "1.00", perTarget: "0.50" });
    assert.equal(budget.view.targets["g:12345678"], "0.20000000");
    assert.equal(budget.view.spent, "0.20000000");
    assert.equal(fixture(dir).budget.view.settings.daily, "1.00");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local-day rollover grants a new day while retaining bounded historical reservations", () => {
  const dir = temp();
  let clock = Date.now();
  try {
    const { budget } = fixture(dir, () => clock);
    guarded(budget);
    assert.equal(budget.view.spent, "0.05000000");
    clock += 48 * 3600000;
    assert.equal(budget.view.spent, "0.00000000");
    guarded(budget);
    assert.equal(budget.view.spent, "0.05000000");
    assert.equal(fixture(dir, () => clock).budget.view.spent, "0.05000000");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
