import { router } from "expo-router";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

import { API_BASE_URL, APP_USER_ID, apiJson } from "../config/api";
import {
  AccountSettings,
  DEFAULT_ACCOUNT_NAME,
  clearAccountPassword,
  getAccountSettings,
  saveAccountDisplayName,
  saveAccountPassword,
} from "../lib/accountSettings";
import { CostSummary, getCostSummary } from "../lib/costState";
import {
  AVAILABLE_CHAT_MODELS,
  ChatModelOption,
  DEFAULT_CHAT_MODEL,
  findChatModel,
  getSelectedChatModel,
  saveSelectedChatModel,
} from "../lib/modelSettings";

type CreditsResponse = {
  balance?: number | null;
  total_credits?: number | null;
  total_usage?: number | null;
  error?: string;
};

const emptySummary: CostSummary = {
  last24hCost: null,
  monthCost: null,
  latest: null,
};

const formatUsd = (value?: number | null) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "暂无";
  }

  if (value === 0) {
    return "$0.00";
  }

  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
};

const formatCostSource = (source?: string) => {
  if (source === "actual") {
    return "真实";
  }

  if (source === "estimated") {
    return "估算";
  }

  return "未知";
};

const getApiHost = () => {
  try {
    return new URL(API_BASE_URL).host;
  } catch {
    return API_BASE_URL.replace(/^https?:\/\//, "");
  }
};

const getShortModelName = (modelId: string) => findChatModel(modelId).name;

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.sectionCard}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function InfoRow({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string;
  onPress?: () => void;
}) {
  const content = (
    <>
      <Text style={styles.infoLabel}>{label}</Text>
      <View style={styles.infoValueBox}>
        <Text style={styles.infoValue}>{value}</Text>
        {onPress && <Text style={styles.chevron}>›</Text>}
      </View>
    </>
  );

  if (onPress) {
    return (
      <Pressable
        style={({ pressed }) => [
          styles.infoRow,
          styles.pressableInfoRow,
          pressed && styles.rowPressed,
        ]}
        onPress={onPress}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View style={styles.infoRow}>
      {content}
    </View>
  );
}

export default function SettingsScreen() {
  const [selectedModel, setSelectedModel] =
    useState<ChatModelOption>(DEFAULT_CHAT_MODEL);
  const [summary, setSummary] = useState<CostSummary>(emptySummary);
  const [credits, setCredits] = useState<CreditsResponse | null>(null);
  const [account, setAccount] = useState<AccountSettings>({
    displayName: DEFAULT_ACCOUNT_NAME,
    hasPassword: false,
    faceIdEnabled: false,
  });
  const [refreshing, setRefreshing] = useState(false);

  const loadSettings = useCallback(async () => {
    setRefreshing(true);

    try {
      const [model, costSummary, creditsData, accountSettings] = await Promise.all([
        getSelectedChatModel(),
        getCostSummary(),
        apiJson<CreditsResponse>("/api/user-state", {
          query: {
            user_id: APP_USER_ID,
            action: "openrouter-credits",
          },
          timeoutMs: 12000,
        }).catch((error) => ({
          balance: null,
          error: error.message,
        })),
        getAccountSettings(),
      ]);

      setSelectedModel(model);
      setSummary(costSummary);
      setCredits(creditsData);
      setAccount(accountSettings);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const selectModel = async (modelId: string) => {
    const model = await saveSelectedChatModel(modelId);
    setSelectedModel(model);
  };

  const editDisplayName = () => {
    Alert.prompt("用户名", "给这个入口起一个你喜欢的名字", [
      {
        text: "取消",
        style: "cancel",
      },
      {
        text: "保存",
        onPress: async (value?: string) => {
          const displayName = await saveAccountDisplayName(value || "");

          setAccount((prev) => ({
            ...prev,
            displayName,
          }));
        },
      },
    ], "plain-text", account.displayName);
  };

  const editPassword = () => {
    const actions = [
      {
        text: "取消",
        style: "cancel" as const,
      },
      ...(account.hasPassword
        ? [
            {
              text: "清除密码",
              style: "destructive" as const,
              onPress: async () => {
                await clearAccountPassword();
                setAccount((prev) => ({
                  ...prev,
                  hasPassword: false,
                  faceIdEnabled: false,
                }));
              },
            },
          ]
        : []),
      {
        text: account.hasPassword ? "修改" : "设置",
        onPress: () => {
          Alert.prompt(
            account.hasPassword ? "修改密码" : "设置密码",
            "请输入 6 位数字密码。",
            [
              {
                text: "取消",
                style: "cancel",
              },
              {
                text: "保存",
                onPress: async (value?: string) => {
                  const normalizedPassword = (value || "")
                    .replace(/[^0-9]/g, "")
                    .slice(0, 6);

                  if (normalizedPassword.length !== 6) {
                    Alert.alert("密码需要 6 位数字");
                    return;
                  }

                  const hasPassword = await saveAccountPassword(value || "");

                  setAccount((prev) => ({
                    ...prev,
                    hasPassword,
                    faceIdEnabled: hasPassword ? prev.faceIdEnabled : false,
                  }));
                },
              },
            ],
            "secure-text",
          );
        },
      },
    ];

    Alert.alert("密码", account.hasPassword ? "已设置本机密码。" : "还没有设置密码。", actions);
  };

  const showFaceIdInfo = () => {
    Alert.alert(
      "Face ID",
      "这里先留好入口。要真正开启 Face ID，需要下一步接入 Expo Local Authentication，然后再把它和 App 锁连起来。",
    );
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>

        <SectionCard title="🤖 模型">
          {AVAILABLE_CHAT_MODELS.map((model) => {
            const isSelected = model.id === selectedModel.id;

            return (
              <Pressable
                key={model.id}
                style={({ pressed }) => [
                  styles.modelRow,
                  isSelected && styles.modelRowSelected,
                  pressed && styles.rowPressed,
                ]}
                onPress={() => selectModel(model.id)}
              >
                <Text style={styles.modelName}>{model.name}</Text>
                {isSelected && <Text style={styles.checkmark}>✓</Text>}
              </Pressable>
            );
          })}
        </SectionCard>

        <SectionCard title="💲 花费">
          <InfoRow label="24h 消耗" value={formatUsd(summary.last24hCost)} />
          <InfoRow label="账户余额" value={formatUsd(credits?.balance)} />
          <InfoRow label="本月花费" value={formatUsd(summary.monthCost)} />
          <InfoRow
            label="累计已用"
            value={formatUsd(credits?.total_usage)}
          />

          <View style={styles.tokenBox}>
            <Text style={styles.tokenTitle}>最近 Token</Text>
            {summary.latest ? (
              <>
                <Text style={styles.tokenLine}>
                  模型 {getShortModelName(summary.latest.model)}
                </Text>
                <Text style={styles.tokenLine}>
                  输入 {summary.latest.promptTokens} · 输出{" "}
                  {summary.latest.completionTokens} · 合计{" "}
                  {summary.latest.totalTokens}
                </Text>
                <Text style={styles.tokenLine}>
                  花费 {formatUsd(summary.latest.costUsd)} ·{" "}
                  {formatCostSource(summary.latest.costSource)}
                </Text>
              </>
            ) : (
              <Text style={styles.tokenLine}>还没有记录。</Text>
            )}
          </View>

          <Pressable
            style={({ pressed }) => [
              styles.refreshButton,
              pressed && styles.rowPressed,
            ]}
            onPress={loadSettings}
          >
            <Text style={styles.refreshText}>
              {refreshing ? "刷新中…" : "刷新"}
            </Text>
          </Pressable>
        </SectionCard>

        <SectionCard title="🔧 设置">
          <InfoRow
            label="用户名"
            value={account.displayName}
            onPress={editDisplayName}
          />
          <InfoRow
            label="密码"
            value={account.hasPassword ? "已设置" : "未设置"}
            onPress={editPassword}
          />
          <InfoRow
            label="Face ID"
            value={account.faceIdEnabled ? "已开启" : "未接入"}
            onPress={showFaceIdInfo}
          />
          <InfoRow label="当前 API" value={getApiHost()} />
        </SectionCard>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#FBF8F3",
  },

  scroll: {
    flex: 1,
  },

  content: {
    paddingTop: 58,
    paddingHorizontal: 22,
    paddingBottom: 46,
  },

  backButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(120,120,128,0.08)",
    marginBottom: 34,
  },

  backText: {
    fontSize: 32,
    lineHeight: 34,
    color: "#555",
  },

  sectionCard: {
    backgroundColor: "rgba(255,255,255,0.82)",
    borderRadius: 26,
    paddingHorizontal: 16,
    paddingVertical: 16,
    marginBottom: 16,
    shadowColor: "#B8AFA7",
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: {
      width: 0,
      height: 8,
    },
  },

  sectionTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: "#333",
    marginBottom: 12,
  },

  modelRow: {
    minHeight: 46,
    borderRadius: 16,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  modelRowSelected: {
    backgroundColor: "rgba(120,120,128,0.08)",
  },

  rowPressed: {
    backgroundColor: "rgba(120,120,128,0.12)",
  },

  modelName: {
    fontSize: 16,
    color: "#444",
  },

  checkmark: {
    fontSize: 18,
    color: "#8D8793",
  },

  infoRow: {
    minHeight: 42,
    borderRadius: 14,
    paddingHorizontal: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  pressableInfoRow: {
    paddingHorizontal: 10,
    marginHorizontal: -6,
  },

  infoLabel: {
    fontSize: 15,
    color: "#8E8E93",
  },

  infoValueBox: {
    flex: 1,
    marginLeft: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
  },

  infoValue: {
    flexShrink: 1,
    textAlign: "right",
    fontSize: 15,
    color: "#444",
  },

  chevron: {
    marginLeft: 6,
    fontSize: 22,
    lineHeight: 22,
    color: "#B0AAA6",
  },

  tokenBox: {
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 18,
    backgroundColor: "rgba(120,120,128,0.06)",
  },

  tokenTitle: {
    fontSize: 14,
    color: "#8E8E93",
    marginBottom: 7,
  },

  tokenLine: {
    fontSize: 14,
    lineHeight: 21,
    color: "#555",
  },

  refreshButton: {
    alignSelf: "flex-end",
    marginTop: 12,
    paddingHorizontal: 16,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(120,120,128,0.08)",
  },

  refreshText: {
    fontSize: 14,
    color: "#555",
  },
});
