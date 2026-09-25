const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("desktop usage UI shows default budget, confirms changes, and displays fail-closed status", async () => {
  const nodes = new Map(),
    get = (id) => {
      if (!nodes.has(id))
        nodes.set(id, {
          id,
          textContent: "",
          value: "",
          checked: false,
          disabled: false,
          hidden: false,
          classList: { toggle() {} },
        });
      return nodes.get(id);
    };
  const context = { window: {}, document: { getElementById: get } };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../ui/usage-ui.js"), "utf8"),
    context,
  );
  let calls = 0,
    notice = "";
  const ui = context.window.UsageUI.mount({
    call: async (name, payload) => {
      calls++;
      assert.equal(name, "save-budget");
      assert.equal(payload.confirm, true);
      assert.equal(payload.settings.daily, "1.00");
      assert.equal(payload.settings.perTarget, "0.25");
      return {
        budget: {
          ...budget,
          settings: payload.settings,
          spent: "0.00000000",
          remaining: "1.00000000",
        },
      };
    },
    notice: (message) => (notice = message),
    confirm: async () => true,
    getEditors: () => ({}),
  });
  const budget = {
    available: true,
    warning: "",
    uncertain: false,
    settings: { enabled: true, daily: "2.00", perTarget: "0.50" },
    spent: "0.05000000",
    remaining: "1.95000000",
    targets: {},
  };
  ui.render({ budget });
  assert.equal(get("budget-enabled").checked, true);
  assert.equal(get("budget-daily").value, "2.00");
  assert.match(get("budget-home").textContent, /¥2.00/);
  assert.match(get("budget-model-status").textContent, /用量统计/);
  get("budget-daily").value = "1.00";
  get("budget-target").value = "0.25";
  await get("budget-save").onclick();
  assert.equal(calls, 1);
  assert.match(notice, /预算已保存/);
  assert.equal(get("budget-daily").value, "1.00");
  ui.render({
    budget: { ...budget, available: false, warning: "模拟预算磁盘故障" },
  });
  assert.match(get("budget-warning").textContent, /磁盘故障/);
  assert.equal(get("budget-warning").hidden, false);
  assert.equal(get("budget-save").disabled, true);
  assert.match(get("budget-home").textContent, /已阻断/);
});
