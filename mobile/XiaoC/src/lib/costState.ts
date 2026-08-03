import AsyncStorage from "@react-native-async-storage/async-storage";

export type TokenUsageRecord = {
  id: string;
  createdAt: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costSource: "actual" | "estimated" | "unknown";
};

export type CostSummary = {
  last24hCost: number | null;
  monthCost: number | null;
  latest: TokenUsageRecord | null;
};

const COST_RECORDS_KEY = "xiaoc:openrouter_cost_records";
const MAX_COST_RECORDS = 240;
const MODEL_PRICING_PER_MILLION: Record<
  string,
  {
    input: number;
    output: number;
  }
> = {
  "anthropic/claude-sonnet-4.6": {
    input: 3,
    output: 15,
  },
  "anthropic/claude-haiku-4.5": {
    input: 1,
    output: 5,
  },
  "anthropic/claude-opus-4.1": {
    input: 15,
    output: 75,
  },
};

const toNumber = (value: unknown) => {
  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : 0;
};

const sumKnownCosts = (records: TokenUsageRecord[]) => {
  const knownRecords = records.filter((record) => record.costUsd !== null);

  if (knownRecords.length === 0) {
    return null;
  }

  return knownRecords.reduce((total, record) => total + (record.costUsd || 0), 0);
};

export async function getUsageRecords() {
  const raw = await AsyncStorage.getItem(COST_RECORDS_KEY);

  if (!raw) {
    return [];
  }

  try {
    const records = JSON.parse(raw);

    return Array.isArray(records)
      ? records
          .filter((record) => record?.createdAt)
          .map((record) => ({
            ...record,
            costSource:
              record.costSource ||
              (record.costUsd === null || record.costUsd === undefined
                ? "unknown"
                : "estimated"),
          }))
      : [];
  } catch {
    return [];
  }
}

export async function saveUsageRecord(record: TokenUsageRecord) {
  const records = await getUsageRecords();

  const nextRecords = [record, ...records]
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, MAX_COST_RECORDS);

  await AsyncStorage.setItem(COST_RECORDS_KEY, JSON.stringify(nextRecords));
}

export async function saveChatUsageFromResponse({
  model,
  usage,
}: {
  model?: string | null;
  usage?: Record<string, unknown> | null;
}) {
  if (!usage) {
    return;
  }

  const promptTokens = toNumber(usage.prompt_tokens);
  const completionTokens = toNumber(usage.completion_tokens);
  const totalTokens = toNumber(usage.total_tokens) || promptTokens + completionTokens;
  const rawCost =
    usage.cost ??
    usage.total_cost ??
    usage.totalCost ??
    usage.estimated_cost;
  const costNumber = Number(rawCost);
  const price = model ? MODEL_PRICING_PER_MILLION[model] : null;
  const estimatedCostUsd = price
    ? (promptTokens * price.input + completionTokens * price.output) / 1_000_000
    : null;
  const hasActualCost = Number.isFinite(costNumber);
  const costUsd = hasActualCost ? costNumber : estimatedCostUsd;
  const costSource = hasActualCost
    ? "actual"
    : estimatedCostUsd !== null
      ? "estimated"
      : "unknown";

  if (!promptTokens && !completionTokens && !totalTokens && costUsd === null) {
    return;
  }

  await saveUsageRecord({
    id: `usage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    model: model || "unknown",
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd,
    costSource,
  });
}

export async function getCostSummary(): Promise<CostSummary> {
  const records = await getUsageRecords();
  const now = Date.now();
  const dayStart = now - 24 * 60 * 60 * 1000;
  const currentDate = new Date();
  const monthStart = new Date(
    currentDate.getFullYear(),
    currentDate.getMonth(),
    1,
  ).getTime();

  const last24hRecords = records.filter(
    (record) => new Date(record.createdAt).getTime() >= dayStart,
  );
  const monthRecords = records.filter(
    (record) => new Date(record.createdAt).getTime() >= monthStart,
  );

  return {
    last24hCost: sumKnownCosts(last24hRecords),
    monthCost: sumKnownCosts(monthRecords),
    latest: records[0] || null,
  };
}
