import fs from "node:fs";
import path from "node:path";
import { dayKey } from "./usage-analytics";
import {
  money,
  peakPricing,
  validatePricing,
  type Pricing,
  type UsageContext,
  type UsageLedger,
} from "./usage-ledger";
import type { ChatMessage, Config } from "./config";

const PICO_PER_YUAN = 1_000_000_000_000n;
const MIN_RISK_PICO = 50_000_000_000n; // ¥0.05 is held until an exact usage report is available.
const MAX_DAYS = 8;
const MAX_TARGETS = 4000;
const MAX_FILE = 1024 * 1024;
const decimal = /^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/;
const count = /^\d{1,30}$/;
const targetId = /^[pg]:\d{5,16}$|^unassigned$/;

export interface BudgetSettings {
  enabled: boolean;
  daily: string;
  perTarget: string;
}
export const DEFAULT_BUDGET: BudgetSettings = {
  enabled: true,
  daily: "2.00",
  perTarget: "0.50",
};
interface DayRecord {
  day: string;
  total: string;
  targets: Record<string, string>;
  uncertain: boolean;
}
export interface BudgetTicket {
  day: string;
  target: string;
  reserved: string;
  done: boolean;
}

export class BudgetError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "BudgetError";
  }
}

function amountPico(raw: unknown) {
  if (typeof raw !== "string" || !decimal.test(raw))
    throw new BudgetError(
      "BUDGET_INVALID",
      "预算须为 0.01–1000 元，最多两位小数",
    );
  const [whole, decimals = ""] = raw.split(".");
  const value =
    BigInt(whole) * PICO_PER_YUAN +
    BigInt(decimals.padEnd(2, "0")) * (PICO_PER_YUAN / 100n);
  if (value < PICO_PER_YUAN / 100n || value > 1000n * PICO_PER_YUAN)
    throw new BudgetError("BUDGET_INVALID", "预算须为 0.01–1000 元");
  return value;
}
export function validateBudget(raw: unknown): BudgetSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new BudgetError("BUDGET_INVALID", "预算设置格式无效");
  const value = raw as Partial<BudgetSettings>;
  if (typeof value.enabled !== "boolean")
    throw new BudgetError("BUDGET_INVALID", "请选择是否启用预算");
  const daily = amountPico(value.daily),
    perTarget = amountPico(value.perTarget);
  if (perTarget > daily)
    throw new BudgetError("BUDGET_INVALID", "每对象预算不得超过每日总预算");
  const cents = (pico: bigint) =>
    `${pico / PICO_PER_YUAN}.${String((pico % PICO_PER_YUAN) / (PICO_PER_YUAN / 100n)).padStart(2, "0")}`;
  return {
    enabled: value.enabled,
    daily: cents(daily),
    perTarget: cents(perTarget),
  };
}

function priceMicro(raw: string) {
  const [whole, part = ""] = raw.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(part.padEnd(6, "0"));
}
/**
 * Tokens held per attached image. DeepSeek bills an image as at most 384 input tokens; the
 * base64 payload itself must not be counted as text, or one photo (hundreds of KB) would look
 * like a ¥1 request and trip the ¥0.50 per-target limit before anything was spent.
 */
export const IMAGE_TOKEN_HOLD = 1024;
/** Text-only shape of the request for size estimation: image data is replaced by a short marker. */
function textShape(messages: ChatMessage[]): {
  messages: ChatMessage[];
  images: number;
} {
  let images = 0;
  const shaped = messages.map((m) =>
    typeof m.content === "string"
      ? m
      : {
          ...m,
          content: m.content.map((part) => {
            if (part.type !== "image_url") return part;
            images++;
            return { type: "text" as const, text: "[image]" };
          }),
        },
  );
  return { messages: shaped, images };
}
function reservation(
  config: Pick<Config, "maxTokens">,
  messages: ChatMessage[],
  pricing: Pricing,
) {
  const shape = textShape(messages);
  const checked = validatePricing(pricing),
    input = BigInt(
      Buffer.byteLength(JSON.stringify(shape.messages), "utf8") +
        1024 +
        messages.length * 256 +
        shape.images * IMAGE_TOKEN_HOLD,
    );
  const miss =
    priceMicro(checked.cacheMiss) > priceMicro(peakPricing.cacheMiss)
      ? priceMicro(checked.cacheMiss)
      : priceMicro(peakPricing.cacheMiss);
  const output =
    priceMicro(checked.output) > priceMicro(peakPricing.output)
      ? priceMicro(checked.output)
      : priceMicro(peakPricing.output);
  // JSON byte length conservatively overestimates text token count; images are held at a fixed allowance each.
  const bound = input * miss + BigInt(config.maxTokens + 128) * output;
  return bound > MIN_RISK_PICO ? bound : MIN_RISK_PICO;
}
function parseDay(raw: unknown): DayRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("day");
  const d = raw as Partial<DayRecord>;
  if (
    typeof d.day !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(d.day) ||
    typeof d.total !== "string" ||
    !count.test(d.total) ||
    typeof d.uncertain !== "boolean" ||
    !d.targets ||
    typeof d.targets !== "object" ||
    Array.isArray(d.targets) ||
    Object.keys(d.targets).length > MAX_TARGETS
  )
    throw new Error("day");
  const targets: Record<string, string> = Object.create(null);
  for (const [id, spent] of Object.entries(d.targets)) {
    if (!targetId.test(id) || typeof spent !== "string" || !count.test(spent))
      throw new Error("target");
    targets[id] = spent;
  }
  return { day: d.day, total: d.total, targets, uncertain: d.uncertain };
}

/** Application-side estimated spend guard. It is NOT a provider billing cap. */
export class BudgetManager {
  private file: string;
  private settings: BudgetSettings = { ...DEFAULT_BUDGET };
  private days: DayRecord[] = [];
  private ok = true;
  private problem = "";
  private pending = new Set<BudgetTicket>();
  constructor(
    dir: string,
    private ledger: UsageLedger,
    private changed: () => void = () => {},
    private clock: () => number = () => Date.now(),
  ) {
    this.file = path.join(dir, "model-budget.json");
    try {
      if (fs.statSync(this.file).size > MAX_FILE) throw new Error("oversized");
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as {
        version?: unknown;
        settings?: unknown;
        days?: unknown;
      };
      if (
        raw?.version !== 1 ||
        !Array.isArray(raw.days) ||
        raw.days.length > MAX_DAYS
      )
        throw new Error("schema");
      const settings = validateBudget(raw.settings),
        days = raw.days.map(parseDay);
      if (new Set(days.map((d) => d.day)).size !== days.length)
        throw new Error("duplicate day");
      this.settings = settings;
      this.days = days;
      this.reconcile(false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          this.reconcile(true);
          if (!this.save(this.settings, this.days)) this.ok = false;
        } catch {
          this.ok = false;
          this.problem =
            "旧用量记录无法核对，默认预算已安全阻断新模型请求；请备份统计文件后处理。";
        }
      } else {
        this.ok = false;
        this.problem =
          "费用预算文件损坏或无法读取，已阻断新的模型请求；请先备份 model-budget.json 后处理。";
      }
    }
  }
  private save(settings: BudgetSettings, days: DayRecord[]) {
    const tmp = this.file + ".tmp";
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const data = JSON.stringify({ version: 1, settings, days });
      if (Buffer.byteLength(data, "utf8") > MAX_FILE)
        throw new Error("oversized");
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
        "费用预算无法保存，已阻断后续新模型请求；请检查用户数据目录权限或磁盘空间。";
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      return false;
    }
  }
  private day(date = dayKey(this.clock())) {
    return this.days.find((row) => row.day === date);
  }
  private ensureDay() {
    const date = dayKey(this.clock());
    let row = this.day(date);
    if (!row) {
      row = {
        day: date,
        total: "0",
        targets: Object.create(null),
        uncertain: false,
      };
      this.days = [...this.days, row]
        .sort((a, b) => a.day.localeCompare(b.day))
        .slice(-MAX_DAYS);
    }
    return row;
  }
  /** Re-import today's known charges, including calls made while this guard was explicitly disabled. */
  private reconcile(firstImport: boolean) {
    const view = this.ledger.view;
    if (!view.available || !view.analytics.available)
      throw new Error("usage unavailable");
    const row = this.ensureDay(),
      day = view.analytics.daily.find((value) => value.date === row.day);
    const recorded = BigInt(day?.pico || "0");
    const events = view.analytics.events.filter(
      (event) => dayKey(event.at) === row.day,
    );
    if (
      events.length !== (day?.calls || 0) ||
      (firstImport &&
        !day &&
        view.total.calls > 0 &&
        view.startedAt !== null &&
        dayKey(view.startedAt) <= row.day &&
        view.analytics.daily.length === 0)
    )
      row.uncertain = true;
    const unknown = events.reduce(
      (n, event) => n + (event.status === "unknown" ? 1n : 0n),
      0n,
    );
    const total = recorded + unknown * MIN_RISK_PICO;
    if (total > BigInt(row.total)) row.total = total.toString();
    const targets: Record<string, bigint> = Object.create(null);
    for (const event of events) {
      if (
        (event.kind === "chat" || event.kind === "preview") &&
        targetId.test(event.target)
      ) {
        const spent =
          BigInt(event.pico) +
          (event.status === "unknown" ? MIN_RISK_PICO : 0n);
        targets[event.target] = (targets[event.target] || 0n) + spent;
      }
    }
    for (const [id, spent] of Object.entries(targets))
      if (spent > BigInt(row.targets[id] || "0"))
        row.targets[id] = spent.toString();
  }
  private requireAvailable() {
    if (!this.ok) throw new BudgetError("BUDGET_UNAVAILABLE", this.problem);
  }
  get view() {
    const row = this.day(),
      spent = BigInt(row?.total || "0"),
      limit = amountPico(this.settings.daily);
    return {
      available: this.ok,
      warning: this.problem,
      settings: { ...this.settings },
      date: dayKey(this.clock()),
      spent: money(spent.toString()),
      remaining: money((spent >= limit ? 0n : limit - spent).toString()),
      uncertain: row?.uncertain || false,
      inFlight: this.pending.size,
      targets: Object.fromEntries(
        Object.entries(row?.targets || {}).map(([id, pico]) => [
          id,
          money(pico),
        ]),
      ),
    };
  }
  configure(raw: unknown) {
    this.requireAvailable();
    const next = validateBudget(raw);
    if (next.enabled && !this.settings.enabled) {
      try {
        this.reconcile(false);
      } catch {
        throw new BudgetError(
          "BUDGET_UNAVAILABLE",
          "用量记录不可用，无法安全开启费用预算",
        );
      }
    }
    if (!this.save(next, this.days))
      throw new BudgetError("BUDGET_UNAVAILABLE", this.problem);
    this.settings = next;
    this.changed();
    return this.view;
  }
  reserve(
    config: Pick<Config, "maxTokens">,
    messages: ChatMessage[],
    context: UsageContext,
    pricing: Pricing,
  ): BudgetTicket | null {
    if (!this.settings.enabled) return null;
    this.requireAvailable();
    const row = this.ensureDay();
    if (row.uncertain)
      throw new BudgetError(
        "BUDGET_HISTORY_UNCERTAIN",
        "今日旧用量记录不完整，为防止超额已暂停新模型请求；次日恢复或先核对平台账单",
      );
    const target =
      context.kind === "chat" || context.kind === "preview"
        ? targetId.test(context.target || "")
          ? context.target!
          : "unassigned"
        : "";
    const hold = reservation(config, messages, pricing);
    if (BigInt(row.total) + hold > amountPico(this.settings.daily))
      throw new BudgetError(
        "BUDGET_DAILY_LIMIT",
        "今日模型预算或风险预留已达上限，已暂停新模型请求",
      );
    if (
      target &&
      BigInt(row.targets[target] || "0") + hold >
        amountPico(this.settings.perTarget)
    )
      throw new BudgetError(
        "BUDGET_TARGET_LIMIT",
        "该好友或群今日预算或风险预留已达上限，已暂停新模型请求",
      );
    const ticket: BudgetTicket = {
      day: row.day,
      target,
      reserved: hold.toString(),
      done: false,
    };
    row.total = (BigInt(row.total) + hold).toString();
    if (target)
      row.targets[target] = (
        BigInt(row.targets[target] || "0") + hold
      ).toString();
    if (!this.save(this.settings, this.days)) {
      row.total = (BigInt(row.total) - hold).toString();
      if (target)
        row.targets[target] = (BigInt(row.targets[target]) - hold).toString();
      this.ok = false;
      throw new BudgetError("BUDGET_UNAVAILABLE", this.problem);
    }
    this.pending.add(ticket);
    this.changed();
    return ticket;
  }
  /** Unknown or interrupted model usage consumes the full reservation, including across restarts. */
  settle(ticket: BudgetTicket | null, actualPico: string | null) {
    if (!ticket || ticket.done) return;
    ticket.done = true;
    this.pending.delete(ticket);
    if (actualPico !== null && count.test(actualPico)) {
      const row = this.day(ticket.day);
      if (row) {
        const delta = BigInt(actualPico) - BigInt(ticket.reserved);
        row.total = (BigInt(row.total) + delta).toString();
        if (ticket.target)
          row.targets[ticket.target] = (
            BigInt(row.targets[ticket.target] || "0") + delta
          ).toString();
        if (!this.save(this.settings, this.days)) this.ok = false;
      }
    }
    this.changed();
  }
}
