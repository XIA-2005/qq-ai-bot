const test = require("node:test");
const assert = require("node:assert/strict");
const { ipcRecord } = require("../dist/ipc-input.js");

test("IPC boundary accepts plain objects and missing optional payload, not array/primitive/prototype instances", () => {
  assert.deepEqual(ipcRecord(undefined), {});
  assert.equal(ipcRecord({ confirm: true }).confirm, true);
  assert.equal(ipcRecord(Object.create(null)).confirm, undefined);
  for (const value of [
    42,
    "yes",
    [],
    new Date(),
    new Map(),
    Object.create({ isAdmin: true }),
  ]) {
    assert.throws(() => ipcRecord(value), /普通对象/);
  }
});
