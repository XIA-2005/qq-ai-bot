const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");
const {
  defaults,
  validate,
  FOLLOWUP_DISCLOSURE_VERSION,
} = require("../dist/config.js");
const { ControlService } = require("../dist/control.js");
const { RemoteAccess } = require("../dist/remote-access.js");
const { MobileWebServer } = require("../dist/web-server.js");

function chrome() {
  const paths = [
    process.env.PWA_BROWSER_BIN,
    chromium.executablePath(),
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ];
  const found = paths.find((value) => value && fs.existsSync(value));
  if (!found)
    throw new Error(
      "找不到 Chromium；先运行 node node_modules/playwright-core/cli.js install chromium",
    );
  return found;
}
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-ai-pwa-browser-"));
  const store = {
    config: validate({
      ...defaults,
      friends: [],
      groups: [],
      remotePublicUrl: "https://bot.example.com",
      autoReplyConsent: true,
      autoReplyConsentVersion: FOLLOWUP_DISCLOSURE_VERSION,
    }),
    key: "fake-key-not-sent",
    token: "",
    writes: 0,
    save(c) {
      this.config = c;
      this.writes++;
    },
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
  await server.start();
  let browser, context;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: chrome(),
      args: ["--no-sandbox"],
    });
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
  } catch (error) {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const page = await context.newPage(),
    base = `http://localhost:${server.getPort()}`;
  return {
    dir,
    store,
    access,
    control,
    server,
    browser,
    context,
    page,
    base,
    async close() {
      await context.close();
      await browser.close();
      await server.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function pair(f, source) {
  const code = source || f.access.createPairing("https://bot.example.com");
  const url = new URL(code.pairingUrl);
  await f.page.goto(f.base + url.pathname + url.hash);
  await f.page
    .locator("#app:not(.hidden)")
    .waitFor({ state: "visible", timeout: 9000 });
  return code;
}

test("real Chromium PWA exchanges one-time QR fragment for HttpOnly device cookie, then revokes it", async () => {
  const f = await fixture();
  try {
    const code = await pair(f);
    assert.equal(
      new URL(f.page.url()).hash,
      "",
      "secret fragment removed from address bar",
    );
    assert.equal(f.access.listDevices().length, 1);
    const cookies = await f.context.cookies(f.base);
    const device = cookies.find((item) => item.name === "__Host-qqai_device");
    assert.ok(device, "pairing must set a browser cookie");
    assert.equal(device.httpOnly, true);
    assert.equal(device.secure, true);
    assert.equal(
      await f.page.evaluate(() => localStorage.length),
      0,
      "token never in localStorage",
    );
    const offline = await f.page.evaluate(() =>
      Promise.race([
        navigator.serviceWorker?.ready.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
      ]),
    );
    assert.equal(
      offline,
      true,
      "PWA service worker registers in a real browser",
    );
    f.page.once("dialog", (dialog) => dialog.accept());
    await f.page.locator('[data-tab="settings"]').click();
    await f.page.locator("#revoke-device").click();
    await f.page
      .locator("#unpaired:not(.hidden)")
      .waitFor({ state: "visible", timeout: 7000 });
    assert.equal(f.access.listDevices().length, 0);
    await f.page.reload();
    await f.page
      .locator("#unpaired:not(.hidden)")
      .waitFor({ state: "visible" });
    assert.equal(new URL(code.pairingUrl).search, "");
  } finally {
    await f.close();
  }
});

test("lost pairing JSON response still completes when Secure HttpOnly cookie was set; expired QR fails", async () => {
  const f = await fixture();
  try {
    const expired = f.access.createPairing("https://bot.example.com");
    expired.pairingUrl = expired.pairingUrl.replace(
      /expiresAt=\d+/,
      `expiresAt=${Date.now() - 1}`,
    );
    await f.page.goto(
      f.base +
        new URL(expired.pairingUrl).pathname +
        new URL(expired.pairingUrl).hash,
    );
    await f.page
      .locator("#unpaired:not(.hidden)")
      .waitFor({ state: "visible", timeout: 7000 });
    assert.equal(f.access.listDevices().length, 0);
    let mutated = 0;
    await f.page.route("**/api/v1/pair/exchange", async (route) => {
      mutated++;
      const response = await route.fetch();
      await route.fulfill({ response, body: "response-lost-not-json" });
    });
    await pair(f);
    assert.equal(mutated, 1, "pairing secrets exchanged only once");
    assert.equal(f.access.listDevices().length, 1);
    assert.equal(new URL(f.page.url()).hash, "");
  } finally {
    await f.close();
  }
});

test("lost write response retries with same key without double write; temporary failure retains workbench; desktop revocation forces unpair", async () => {
  const f = await fixture();
  try {
    await pair(f);
    const keys = [];
    let dropped = false;
    await f.page.route("**/api/v1/targets", async (route) => {
      if (route.request().method() === "POST") {
        keys.push(route.request().headers()["idempotency-key"]);
        if (!dropped) {
          dropped = true;
          await route.fetch();
          await route.abort("failed");
          return;
        }
      }
      await route.continue();
    });
    await f.page.locator('[data-tab="targets"]').click();
    await f.page.locator("#target-id").fill("123456789");
    await f.page.locator('#target-form button[type="submit"]').click();
    await f.page.waitForFunction(
      () => document.querySelector("#friend-count")?.textContent === "1",
      { timeout: 8000 },
    );
    assert.equal(keys.length, 2, "same write retried exactly once");
    assert.equal(keys[0], keys[1]);
    assert.ok(keys[0].startsWith("pwa-"));
    assert.equal(f.store.writes, 1, "server side effect runs once");
    await f.page.unroute("**/api/v1/targets");
    let failed = false;
    await f.page.route("**/api/v1/state", async (route) => {
      if (!failed) {
        failed = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "TEMP", message: "暂时不可用" },
          }),
        });
      } else await route.continue();
    });
    await f.page.locator("#header-refresh").click();
    await f.page
      .locator("#toast.show.error")
      .waitFor({ state: "visible", timeout: 5000 });
    assert.equal(
      await f.page.locator("#app").isVisible(),
      true,
      "transient read error must not hide loaded workspace",
    );
    await f.page.locator("#header-refresh").click();
    await f.page.waitForFunction(
      () => document.querySelector("#friend-count")?.textContent === "1",
      { timeout: 5000 },
    );
    f.access.revokeAll();
    await f.page.locator("#header-refresh").click();
    await f.page
      .locator("#unpaired:not(.hidden)")
      .waitFor({ state: "visible", timeout: 6000 });
  } finally {
    await f.close();
  }
});
