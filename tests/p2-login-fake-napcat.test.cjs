const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { WebSocketServer } = require("ws");
const { LoginManager, webHash } = require("../dist/login.js");
const { OneBot } = require("../dist/onebot.js");

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}
const file = (dir, name) =>
  JSON.parse(
    fs.readFileSync(path.join(dir, "napcat-work", "config", name), "utf8"),
  );
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-ai-fake-napcat-"));
  const runtime = path.join(root, "fake-runtime"),
    profile = path.join(root, "profile");
  for (const name of [
    "node.exe",
    "index.js",
    "wrapper.node",
    "crypto.dll",
    "ssl.dll",
    "napcat/napcat.mjs",
  ]) {
    const entry = path.join(runtime, name);
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "fake (never executed)");
  }
  const configs = path.join(profile, "napcat-work", "config");
  fs.mkdirSync(configs, { recursive: true });
  fs.writeFileSync(
    path.join(configs, "onebot11_12345678.json"),
    JSON.stringify({
      network: { websocketServers: [{ host: "0.0.0.0", token: "old-token" }] },
    }),
  );
  const services = [];
  let active;
  let disconnects = 0,
    readyCount = 0,
    events = [];
  const bot = new OneBot(
    (event) => events.push(event),
    () => {},
    () => disconnects++,
    () => {},
    () => readyCount++,
  );
  function launch(exe, args, options) {
    assert.equal(exe, path.join(runtime, "node.exe"));
    assert.deepEqual(args, [path.join(runtime, "index.js")]);
    assert.equal(options.env.NAPCAT_WORKDIR, path.join(profile, "napcat-work"));
    assert.equal(options.env.NAPCAT_QUICK_PASSWORD, undefined);
    const web = file(profile, "webui.json"),
      config = file(profile, "onebot11.json");
    assert.equal(web.host, "127.0.0.1");
    assert.equal(config.network.websocketServers[0].host, "127.0.0.1");
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    const fake = {
      web,
      config,
      child,
      account: "12345678",
      phase: "scan",
      qrVersion: 1,
      failWeb: false,
      online: false,
      checkCount: 0,
      refreshCount: 0,
      invalidAuth: 0,
    };
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      let params = {};
      try {
        params = JSON.parse(body);
      } catch {}
      const send = (code, data) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ code, data }));
      };
      if (fake.failWeb) {
        res.writeHead(503);
        res.end();
        return;
      }
      if (req.url === "/api/auth/login") {
        if (params.hash !== webHash(web.token)) {
          fake.invalidAuth++;
          return send(1, null);
        }
        return send(0, { Credential: "fake-webui-credential" });
      }
      if (req.headers.authorization !== "Bearer fake-webui-credential") {
        fake.invalidAuth++;
        return send(1, null);
      }
      if (req.url === "/api/QQLogin/CheckLoginStatus") {
        fake.checkCount++;
        return send(0, {
          isLogin: fake.online,
          loginPhase: fake.phase,
          qrcodeurl: fake.online
            ? ""
            : `https://fake.invalid/qq/${fake.qrVersion}`,
        });
      }
      if (req.url === "/api/QQLogin/RefreshQRcode") {
        fake.refreshCount++;
        fake.qrVersion++;
        fake.phase = "scan";
        return send(0, {});
      }
      send(1, null);
    });
    server.listen(web.port, "127.0.0.1");
    const socketConfig = config.network.websocketServers[0];
    const ws = new WebSocketServer({
      host: "127.0.0.1",
      port: socketConfig.port,
      verifyClient: (info) =>
        info.req.headers.authorization === `Bearer ${socketConfig.token}`,
    });
    ws.on("connection", (client) =>
      client.on("message", (raw) => {
        let request;
        try {
          request = JSON.parse(String(raw));
        } catch {
          return;
        }
        const data =
          request.action === "get_login_info"
            ? { user_id: fake.account, nickname: "假账号" }
            : request.action === "get_status"
              ? { online: fake.online }
              : {};
        client.send(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            echo: request.echo,
            data,
          }),
        );
      }),
    );
    fake.server = server;
    fake.ws = ws;
    child.kill = () => {
      if (child.exitCode !== null) return false;
      child.exitCode = 0;
      queueMicrotask(() => child.emit("exit", 0));
      for (const client of ws.clients) client.terminate();
      ws.close();
      server.close();
      return true;
    };
    services.push(fake);
    active = fake;
    return child;
  }
  const login = new LoginManager(
    runtime,
    profile,
    () => {},
    (url, token) => bot.connect(url, token),
    () => bot.close(),
    { platform: "win32", launch, firstPollMs: 20, pollMs: 45 },
  );
  return {
    root,
    profile,
    login,
    bot,
    services,
    get active() {
      return active;
    },
    get disconnects() {
      return disconnects;
    },
    get readyCount() {
      return readyCount;
    },
    events,
    async dispose() {
      await login.stop();
      bot.close();
      for (const s of services) s.child.kill();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("fake NapCat WebUI and OneBot WS: QR -> scanned -> initializing -> confirmed login -> disconnect -> recover -> change account", async () => {
  const f = fixture();
  try {
    assert.equal(f.login.state.available, true);
    await f.login.start("12345678");
    const first = f.active;
    assert.equal(first.web.autoLoginAccount, "12345678");
    assert.equal(
      file(f.profile, "onebot11_12345678.json").network.websocketServers[0]
        .host,
      "127.0.0.1",
      "legacy per-account config overwritten",
    );
    await waitFor(
      () =>
        f.login.state.phase === "scan" &&
        f.login.state.qr.startsWith("data:image/png;base64,"),
      "QR from fake service",
    );
    const oldQr = f.login.state.qr;
    first.phase = "qrcode_scanned";
    await waitFor(() => f.login.state.phase === "scanned", "scanned phase");
    first.phase = "initializing";
    await waitFor(
      () => f.login.state.phase === "initializing" && f.login.state.qr === "",
      "initializing clears QR",
    );
    first.online = true;
    await waitFor(
      () =>
        f.login.state.phase === "online" &&
        f.bot.connected &&
        f.bot.self === "12345678",
      "OneBot login confirmation",
    );
    assert.equal(f.readyCount, 1);
    first.failWeb = true;
    await waitFor(
      () => !f.bot.connected && f.login.state.phase === "starting",
      "WebUI disconnect pauses bot",
    );
    first.failWeb = false;
    await waitFor(
      () => f.bot.connected && f.readyCount >= 2,
      "WebUI recovery reauthenticates WS",
    );
    first.online = false;
    first.phase = "scan";
    await waitFor(
      () => f.login.state.phase === "scan" && !f.bot.connected,
      "logout returns to QR state",
    );
    await f.login.refresh();
    await waitFor(
      () => f.login.state.phase === "scan" && f.login.state.qr !== oldQr,
      "QR refresh generates new image",
    );
    assert.equal(first.refreshCount, 1);
    assert.equal(first.invalidAuth, 0);
    await f.login.start("87654321");
    const next = f.active;
    assert.notEqual(next, first);
    assert.notEqual(next.web.token, first.web.token);
    assert.notEqual(
      next.config.network.websocketServers[0].token,
      first.config.network.websocketServers[0].token,
    );
    assert.equal(next.web.autoLoginAccount, "87654321");
    next.account = "87654321";
    next.online = true;
    await waitFor(
      () => f.bot.connected && f.bot.self === "87654321",
      "new account accepted over new socket",
    );
    assert.ok(
      f.disconnects >= 2,
      "disconnect and account switch report paused status",
    );
    await f.login.stop();
    assert.equal(f.login.state.phase, "idle");
    assert.equal(f.bot.connected, false);
  } finally {
    await f.dispose();
  }
});

test("stale poll after stop never reconnects a cancelled login; invalid remembered account is rejected", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.login.start("abc"), /账号无效/);
    await f.login.start("12345678");
    const stale = f.active;
    stale.online = true;
    await f.login.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(f.login.state.phase, "idle");
    assert.equal(f.bot.connected, false);
    assert.equal(f.readyCount, 0);
  } finally {
    await f.dispose();
  }
});
