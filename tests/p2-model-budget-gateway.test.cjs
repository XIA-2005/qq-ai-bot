const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { defaults, validate } = require("../dist/config.js");
const { UsageLedger } = require("../dist/usage-ledger.js");
const { BudgetManager } = require("../dist/budget.js");
const { ApiAccount } = require("../dist/api-account.js");
const { trackedModel } = require("../dist/tracked-model.js");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-ai-budget-gateway-"));
  const config = validate({ ...defaults, maxTokens: 128 });
  const usage = new UsageLedger(dir, () => {}),
    budget = new BudgetManager(dir, usage);
  const account = new ApiAccount(dir, () => {});
  account.configure(config, "fake-api-key");
  const signal = new AbortController().signal;
  const messages = [{ role: "user", content: "private chat message" }];
  const context = { kind: "chat", target: "g:12345678" };
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return {
    dir,
    config,
    usage,
    budget,
    account,
    signal,
    messages,
    context,
    cleanup,
  };
}

test("gateway blocks an eleventh request before fake transport, including after process restart", async () => {
  const f = fixture();
  let calls = 0;
  try {
    const transport = async () => {
      calls++;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await trackedModel(
            f.config,
            "fake-api-key",
            f.messages,
            f.signal,
            f.context,
            { ...f, transport },
          )
        ).text,
        "ok",
      );
    assert.equal(calls, 10);
    assert.equal(f.budget.view.targets["g:12345678"], "0.50000000");
    await assert.rejects(
      trackedModel(f.config, "fake-api-key", f.messages, f.signal, f.context, {
        ...f,
        transport,
      }),
      (e) => e.code === "BUDGET_TARGET_LIMIT",
    );
    assert.equal(calls, 10, "no paid HTTP request after hitting budget");
    const restarted = { usage: new UsageLedger(f.dir, () => {}) };
    restarted.budget = new BudgetManager(f.dir, restarted.usage);
    await assert.rejects(
      trackedModel(f.config, "fake-api-key", f.messages, f.signal, f.context, {
        ...f,
        ...restarted,
        transport,
      }),
      (e) => e.code === "BUDGET_TARGET_LIMIT",
    );
    assert.equal(calls, 10);
    const onDisk = fs.readFileSync(
      path.join(f.dir, "model-budget.json"),
      "utf8",
    );
    assert.doesNotMatch(onDisk, /fake-api-key|private chat message|Bearer/);
  } finally {
    f.cleanup();
  }
});

test("known model usage releases excess hold; unknown usage or transport errors do not", async () => {
  const f = fixture();
  let calls = 0;
  try {
    const known = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            total_tokens: 1100,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 1000,
          },
        }),
        { status: 200 },
      );
    };
    await trackedModel(
      f.config,
      "fake-api-key",
      f.messages,
      f.signal,
      f.context,
      { ...f, transport: known },
    );
    assert.equal(
      f.budget.view.spent,
      "0.00280000",
      "1000 miss * ¥2/M + 100 output * ¥8/M",
    );
    const failed = async () => {
      calls++;
      throw new Error("network broke after sending");
    };
    await assert.rejects(
      trackedModel(f.config, "fake-api-key", f.messages, f.signal, f.context, {
        ...f,
        transport: failed,
      }),
      /模型连接失败/,
    );
    assert.equal(f.budget.view.spent, "0.05280000");
    assert.equal(calls, 2);
  } finally {
    f.cleanup();
  }
});

test("verification, persona and preview also pass the same global and per-target guard", async () => {
  const f = fixture();
  let calls = 0;
  try {
    const transport = async () => {
      calls++;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200 },
      );
    };
    f.budget.configure({ enabled: true, daily: "0.10", perTarget: "0.05" });
    await trackedModel(
      f.config,
      "fake-api-key",
      f.messages,
      f.signal,
      { kind: "verification" },
      { ...f, transport },
    );
    await trackedModel(
      f.config,
      "fake-api-key",
      f.messages,
      f.signal,
      { kind: "preview", target: "p:12345678" },
      { ...f, transport },
    );
    await assert.rejects(
      trackedModel(
        f.config,
        "fake-api-key",
        f.messages,
        f.signal,
        { kind: "persona" },
        { ...f, transport },
      ),
      (e) => e.code === "BUDGET_DAILY_LIMIT",
    );
    assert.equal(calls, 2);
  } finally {
    f.cleanup();
  }
});
