import type { Config, ChatMessage } from "./config";
import { completeWithUsage, type ModelUsage } from "./model";
import {
  estimatePico,
  type UsageContext,
  type UsageLedger,
} from "./usage-ledger";
import type { BudgetManager } from "./budget";
import type { ApiAccount } from "./api-account";

/** The only paid-model entry point used by chat, previews, verification and persona steps. */
export function trackedModel(
  c: Config,
  key: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  context: UsageContext,
  deps: {
    account: ApiAccount;
    usage: UsageLedger;
    budget: BudgetManager;
    transport?: typeof fetch;
    complete?: typeof completeWithUsage;
  },
) {
  return deps.account.track(c, key, signal, async () => {
    if (signal.aborted) throw new Error("请求已取消");
    const pricing = deps.usage.currentPricing;
    // A durable hold MUST be saved before any paid request begins.
    const hold = deps.budget.reserve(c, messages, context, pricing);
    const ticket = deps.usage.begin(context, c.model);
    let observed = false;
    let observedUsage: ModelUsage | null = null;
    try {
      const result = await (deps.complete ?? completeWithUsage)(
        c,
        key,
        messages,
        signal,
        deps.transport,
        (usage) => {
          observed = true;
          observedUsage = usage;
          deps.usage.record(ticket, usage);
        },
      );
      if (!observed) {
        observedUsage = result.usage;
        deps.usage.record(ticket, result.usage);
      }
      return result;
    } finally {
      deps.usage.record(ticket, null);
      // Failures, cancellation and unknown/unpriced usage retain the pre-request hold.
      deps.budget.settle(
        hold,
        c.model === "deepseek-flash"
          ? (estimatePico(observedUsage, pricing)?.pico ?? null)
          : null,
      );
    }
  });
}
