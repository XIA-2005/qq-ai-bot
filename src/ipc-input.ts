/** The renderer is a separate process: never treat its IPC payload as trusted input. */
export function ipcRecord(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(raw))
  ) {
    throw new Error("桌面请求参数必须是普通对象");
  }
  return raw as Record<string, unknown>;
}
