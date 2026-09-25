const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const {
  IdempotencyJournal,
  IDEMPOTENCY_TTL_MS,
} = require("../dist/idempotency.js");
const {
  defaults,
  validate,
  FOLLOWUP_DISCLOSURE_VERSION,
} = require("../dist/config.js");
const { RemoteAccess } = require("../dist/remote-access.js");
const { ControlService } = require("../dist/control.js");
const { MobileWebServer } = require("../dist/web-server.js");

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qq-ai-p2-idem-"));
const auth = (token, key) => ({
  Authorization: `Bearer ${token}`,
  "Idempotency-Key": key,
});
function request(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: route,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (part) => (raw += part));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            json: JSON.parse(raw),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
function fixture(dir, previous) {
  const config = validate(
    previous || {
      ...defaults,
      friends: ["12345678"],
      autoReplyConsent: true,
      autoReplyConsentVersion: FOLLOWUP_DISCLOSURE_VERSION,
      remotePublicUrl: "https://bot.example.com",
    },
  );
  const store = {
    config,
    key: "fake-only",
    token: "",
    save(c) {
      store.config = c;
      store.writes++;
    },
    writes: 0,
  };
  let running = false;
  const engine = {
    active: false,
    pending: 0,
    activeCount: 0,
    merging: 0,
    get running() {
      return running;
    },
    start() {
      running = true;
    },
    pause() {
      running = false;
    },
    updateConfig(c) {
      store.config = c;
    },
  };
  const account = { view: { balance: null }, async queryBalance() {} };
  const usage = { view: { total: { pico: "0", calls: 0 } } };
  const bot = { connected: true, self: "12345678", selfName: "fake" };
  const access = new RemoteAccess(dir);
  const control = new ControlService(
    { store, engine, account, usage, bot },
    {
      isBusy: () => false,
      arm() {},
      pauseSideEffects() {
        engine.pause();
      },
      applyConfig(c) {
        store.save(c);
        engine.updateConfig(c);
      },
      snapshot: () => ({ running: engine.running }),
      audit() {},
    },
  );
  const server = new MobileWebServer(
    {
      control,
      access,
      getPublicUrl: () => store.config.remotePublicUrl,
      log() {},
    },
    { port: 0, host: "127.0.0.1" },
  );
  return { store, engine, account, access, control, server };
}

test("24-hour journal survives restart without persisting keys, tokens, bodies or responses", () => {
  const dir = temp();
  let now = 1_800_000_000_000;
  try {
    const first = new IdempotencyJournal(dir, () => now),
      fingerprint = "a".repeat(64);
    const claim = first.claim("device-1", "private-retry-key", fingerprint);
    assert.equal(claim.phase, "new");
    const uncertain = new IdempotencyJournal(dir, () => now);
    assert.equal(
      uncertain.claim("device-1", "private-retry-key", fingerprint).phase,
      "pending",
      "uncompleted operations never execute again",
    );
    assert.equal(first.complete(claim.keyHash), true);
    const recovered = new IdempotencyJournal(dir, () => now);
    assert.equal(
      recovered.claim("device-1", "private-retry-key", fingerprint).phase,
      "done",
    );
    assert.throws(
      () => recovered.claim("device-1", "private-retry-key", "b".repeat(64)),
      (error) => error.code === "IDEMPOTENCY_CONFLICT",
    );
    const disk = fs.readFileSync(
      path.join(dir, "mobile-idempotency.json"),
      "utf8",
    );
    assert.doesNotMatch(
      disk,
      /private-retry-key|device-1|Bearer|prompt|body|token/,
    );
    now += IDEMPOTENCY_TTL_MS + 1;
    assert.equal(
      recovered.claim("device-1", "private-retry-key", fingerprint).phase,
      "new",
      "expired keys can be reused",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt journal fails closed and never overwrites the original file", () => {
  const dir = temp(),
    file = path.join(dir, "mobile-idempotency.json");
  try {
    fs.writeFileSync(file, "{corrupt");
    const journal = new IdempotencyJournal(dir);
    assert.equal(journal.available, false);
    assert.throws(
      () => journal.claim("device", "key-0001", "c".repeat(64)),
      (error) =>
        error.code === "IDEMPOTENCY_STORAGE_UNAVAILABLE" &&
        error.status === 503,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "{corrupt");
    fs.rmSync(file);
    const failed = new IdempotencyJournal(dir);
    failed.save = () => false;
    assert.throws(
      () => failed.claim("device", "key-0001", "c".repeat(64)),
      (error) => error.code === "IDEMPOTENCY_STORAGE_UNAVAILABLE",
    );
    assert.equal(
      fs.existsSync(file),
      false,
      "no side effects may start when the pending receipt cannot be saved",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lost response then server restart replays a safe receipt without repeating persona mutation", async () => {
  const dir = temp();
  let first, second;
  try {
    first = fixture(dir);
    const pair = first.access.createPairing("https://bot.example.com");
    const token = first.access.exchange(
      pair.pairingId,
      pair.secret,
      "test phone",
    ).token;
    await first.server.start();
    const route = "/api/v1/persona/global",
      body = { prompt: "私密的人设不要写入幂等日志" },
      key = "lost-response-001";
    const original = await request(
      first.server.getPort(),
      "PUT",
      route,
      body,
      auth(token, key),
    );
    assert.equal(original.status, 200);
    assert.equal(first.store.config.prompt, body.prompt);
    const configAfter = first.store.config;
    await first.server.stop();
    first = null;

    second = fixture(dir, configAfter);
    await second.server.start();
    const replay = await request(
      second.server.getPort(),
      "PUT",
      route,
      body,
      auth(token, key),
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.headers["idempotency-replayed"], "true");
    assert.deepEqual(replay.json.data.replayed, true);
    assert.equal(
      second.store.writes,
      0,
      "no second persona mutation after restart",
    );
    assert.equal(
      second.store.config.previousPrompt,
      configAfter.previousPrompt,
    );
    const conflict = await request(
      second.server.getPort(),
      "PUT",
      route,
      { prompt: "changed" },
      auth(token, key),
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, "IDEMPOTENCY_CONFLICT");
    const journal = fs.readFileSync(
      path.join(dir, "mobile-idempotency.json"),
      "utf8",
    );
    assert.doesNotMatch(
      journal,
      /私密的人设|lost-response-001|fake-only|Bearer/,
    );
    second.control.setPersona(
      { source: "ios", id: "same-device" },
      body.prompt,
    );
    assert.equal(
      second.store.writes,
      0,
      "same persona is a strict no-op even with a different key",
    );
  } finally {
    await first?.server.stop();
    await second?.server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent duplicate remains pending; a failed durable completion does not report a failed operation", async () => {
  const dir = temp();
  let instance;
  try {
    instance = fixture(dir);
    const pair = instance.access.createPairing("https://bot.example.com");
    const token = instance.access.exchange(
      pair.pairingId,
      pair.secret,
      "test phone",
    ).token;
    let notify,
      release,
      count = 0;
    const started = new Promise((resolve) => (notify = resolve)),
      gate = new Promise((resolve) => (release = resolve));
    instance.account.queryBalance = async () => {
      count++;
      notify();
      await gate;
    };
    await instance.server.start();
    const port = instance.server.getPort();
    const route = "/api/v1/balance/refresh",
      key = "balance-inflight-01";
    const first = request(port, "POST", route, {}, auth(token, key));
    await started;
    const second = await request(port, "POST", route, {}, auth(token, key));
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, "IDEMPOTENCY_IN_PROGRESS");
    release();
    assert.equal((await first).status, 200);
    assert.equal(count, 1);
    const cached = await request(port, "POST", route, {}, auth(token, key));
    assert.equal(cached.status, 200);
    assert.equal(count, 1);
    // Simulate an atomic journal rename failing after a real, successful operation.
    instance.server.journal.complete = () => false;
    const paused = await request(
      port,
      "POST",
      "/api/v1/reply/pause",
      {},
      auth(token, "disk-failed-001"),
    );
    assert.equal(paused.status, 200);
    assert.equal(paused.headers["x-idempotency-durable"], "false");
    assert.equal(instance.engine.running, false);
    await instance.server.stop();
    instance = null;
    const restarted = fixture(dir);
    await restarted.server.start();
    try {
      const unknown = await request(
        restarted.server.getPort(),
        "POST",
        "/api/v1/reply/pause",
        {},
        auth(token, "disk-failed-001"),
      );
      assert.equal(unknown.status, 409);
      assert.equal(unknown.json.error.code, "IDEMPOTENCY_UNCERTAIN");
    } finally {
      await restarted.server.stop();
    }
  } finally {
    await instance?.server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
