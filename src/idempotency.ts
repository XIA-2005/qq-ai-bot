import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** At-most-once receipts for authenticated mobile writes. No token, request body or response is persisted. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_IDEMPOTENCY_ENTRIES = 512;
const MAX_FILE_BYTES = 256 * 1024;
const hex64 = /^[0-9a-f]{64}$/;
type Phase = "pending" | "done";
interface Receipt {
  keyHash: string;
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  phase: Phase;
  status?: 200;
}
export type Claim = {
  keyHash: string;
  phase: "new" | Phase;
  expiresAt: number;
};

export class IdempotencyError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
    this.name = "IdempotencyError";
  }
}

export class IdempotencyJournal {
  private file: string;
  private entries = new Map<string, Receipt>();
  private writable = true;
  private problem = "";
  constructor(
    dir: string,
    private now: () => number = () => Date.now(),
  ) {
    this.file = path.join(dir, "mobile-idempotency.json");
    try {
      if (fs.statSync(this.file).size > MAX_FILE_BYTES)
        throw new Error("oversized");
      const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as {
        version?: unknown;
        entries?: unknown;
      };
      if (
        data?.version !== 1 ||
        !Array.isArray(data.entries) ||
        data.entries.length > MAX_IDEMPOTENCY_ENTRIES
      )
        throw new Error("schema");
      for (const value of data.entries) {
        const e = value as Partial<Receipt>;
        if (!e || typeof e !== "object") throw new Error("receipt");
        const created = e.createdAt,
          expires = e.expiresAt;
        if (
          typeof e.keyHash !== "string" ||
          !hex64.test(e.keyHash) ||
          typeof e.fingerprint !== "string" ||
          !hex64.test(e.fingerprint) ||
          typeof created !== "number" ||
          !Number.isSafeInteger(created) ||
          typeof expires !== "number" ||
          !Number.isSafeInteger(expires) ||
          created <= 0 ||
          created > this.now() + 300000 ||
          expires - created > IDEMPOTENCY_TTL_MS ||
          expires <= created ||
          !["pending", "done"].includes(e.phase as string) ||
          (e.phase === "done" && e.status !== 200) ||
          (e.phase === "pending" && e.status !== undefined) ||
          this.entries.has(e.keyHash)
        )
          throw new Error("receipt");
        this.entries.set(e.keyHash, e as Receipt);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.writable = false;
        this.problem =
          "移动操作幂等日志损坏或无法读取，已阻断新的远程写操作；请先备份日志后处理。";
      }
    }
  }

  get available() {
    return this.writable;
  }
  get warning() {
    return this.problem;
  }
  private hash(deviceId: string, key: string) {
    return createHash("sha256").update(`${deviceId}\n${key}`).digest("hex");
  }
  private save(entries: Map<string, Receipt>) {
    const tmp = this.file + ".tmp";
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const data = JSON.stringify({
        version: 1,
        entries: [...entries.values()],
      });
      if (Buffer.byteLength(data, "utf8") > MAX_FILE_BYTES)
        throw new Error("too large");
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
      this.problem = "";
      return true;
    } catch {
      this.problem =
        "移动操作幂等日志无法写入；新操作已阻断，已执行的操作仍以实际状态为准。";
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      return false;
    }
  }
  /** Persist pending *before* executing any side effect, so a crash never silently repeats it. */
  claim(deviceId: string, key: string, fingerprint: string): Claim {
    if (!this.writable)
      throw new IdempotencyError(
        "IDEMPOTENCY_STORAGE_UNAVAILABLE",
        this.problem,
        503,
      );
    const time = this.now(),
      keyHash = this.hash(deviceId, key),
      old = this.entries.get(keyHash);
    if (old && old.expiresAt > time) {
      if (old.fingerprint !== fingerprint)
        throw new IdempotencyError(
          "IDEMPOTENCY_CONFLICT",
          "同一 Idempotency-Key 不能用于不同请求",
        );
      return { keyHash, phase: old.phase, expiresAt: old.expiresAt };
    }
    const next = new Map(
      [...this.entries].filter(([, receipt]) => receipt.expiresAt > time),
    );
    if (next.size >= MAX_IDEMPOTENCY_ENTRIES)
      throw new IdempotencyError(
        "IDEMPOTENCY_CAPACITY",
        "幂等日志已达到保留上限，暂不执行新的写操作",
        503,
      );
    const receipt: Receipt = {
      keyHash,
      fingerprint,
      createdAt: time,
      expiresAt: time + IDEMPOTENCY_TTL_MS,
      phase: "pending",
    };
    next.set(keyHash, receipt);
    if (!this.save(next))
      throw new IdempotencyError(
        "IDEMPOTENCY_STORAGE_UNAVAILABLE",
        this.problem,
        503,
      );
    this.entries = next;
    return { keyHash, phase: "new", expiresAt: receipt.expiresAt };
  }
  /** A failed completion leaves a durable pending receipt: retry is refused, not re-executed. */
  complete(keyHash: string) {
    const receipt = this.entries.get(keyHash);
    if (!receipt || receipt.phase !== "pending")
      throw new Error("Missing pending idempotency receipt");
    const next = new Map(this.entries);
    next.set(keyHash, { ...receipt, phase: "done", status: 200 });
    this.entries = next;
    return this.save(next);
  }
}
