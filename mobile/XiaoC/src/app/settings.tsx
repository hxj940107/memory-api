import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import * as LocalAuthentication from "expo-local-authentication";
import { router, useFocusEffect } from "expo-router";
import {
  Alert,
  Modal,
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
  DEFAULT_USER_MOMENT_AVATAR,
  DEFAULT_XIAOC_MOMENT_AVATAR,
  clearAccountPassword,
  getAccountPassword,
  getAccountSettings,
  saveAccountDisplayName,
  saveAccountPassword,
  saveAccountFaceIdEnabled,
  saveUserMomentAvatarUri,
  saveXiaoCMomentAvatarUri,
} from "../lib/accountSettings";
import { CostSummary, getCostSummary } from "../lib/costState";
import {
  syncClientPreferences,
  updateClientPreferences,
  uploadClientPreferenceImage,
} from "../lib/cloudPreferences";
import {
  AVAILABLE_CHAT_MODELS,
  ChatModelOption,
  DEFAULT_CHAT_MODEL,
  findChatModel,
  getSelectedChatModel,
  saveSelectedChatModel,
} from "../lib/modelSettings";
import {
  DEFAULT_INACTIVITY_REACH_OUT_MODE,
  INACTIVITY_REACH_OUT_OPTIONS,
  InactivityReachOutMode,
  getInactivityReachOutMode,
  getInactivityReachOutModeLabel,
  saveInactivityReachOutMode,
} from "../lib/proactiveSettings";
import {
  getLocalPushSettings,
  savePushSettings,
  type PushSettings,
} from "../lib/pushNotifications";

type CreditsResponse = {
  balance?: number | null;
  total_credits?: number | null;
  total_usage?: number | null;
  usage_monthly?: number | null;
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

const MOMENT_AVATAR_DIR = `${FileSystem.documentDirectory || ""}moment-avatars/`;

const copyMomentAvatarToAppStorage = async (
  sourceUri: string,
  target: "user" | "xiaoc",
) => {
  await FileSystem.makeDirectoryAsync(MOMENT_AVATAR_DIR, {
    intermediates: true,
  }).catch(() => {});

  const extension = sourceUri.split(".").pop()?.split("?")[0] || "jpg";
  const targetUri = `${MOMENT_AVATAR_DIR}${target}-${Date.now()}.${extension}`;

  await FileSystem.copyAsync({
    from: sourceUri,
    to: targetUri,
  });

  return targetUri;
};

function SectionCard({
  title,
  summary,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <View style={styles.sectionCard}>
      <Pressable
        style={({ pressed }) => [
          styles.sectionHeader,
          pressed && styles.sectionHeaderPressed,
        ]}
        onPress={onToggle}
      >
        <View style={styles.sectionTitleBox}>
          <Text style={styles.sectionTitle}>{title}</Text>
          <Text style={styles.sectionSummary}>{summary}</Text>
        </View>

        <Text style={styles.sectionChevron}>{expanded ? "⌃" : "⌄"}</Text>
      </Pressable>

      {expanded && <View style={styles.sectionBody}>{children}</View>}
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
    userMomentAvatar: DEFAULT_USER_MOMENT_AVATAR,
    xiaocMomentAvatar: DEFAULT_XIAOC_MOMENT_AVATAR,
    userMomentAvatarUri: null,
    xiaocMomentAvatarUri: null,
  });
  const [reachOutMode, setReachOutMode] =
    useState<InactivityReachOutMode>(DEFAULT_INACTIVITY_REACH_OUT_MODE);
  const [pushSettings, setPushSettings] = useState<PushSettings>({
    enabled: false,
    previewEnabled: true,
    momentsEnabled: true,
    treeholeEnabled: true,
  });
  const [expandedSections, setExpandedSections] = useState({
    model: false,
    cost: false,
    settings: false,
    preferences: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [reachOutSheetVisible, setReachOutSheetVisible] = useState(false);
  const [savingReachOutMode, setSavingReachOutMode] =
    useState<InactivityReachOutMode | null>(null);

  const loadSettings = useCallback(async () => {
    setRefreshing(true);

    try {
      await syncClientPreferences().catch((error) => {
        console.log("Client preferences sync failed:", error);
      });
      const [model, costSummary, creditsData, accountSettings, inactivityMode, localPushSettings] = await Promise.all([
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
        getInactivityReachOutMode().catch(() => DEFAULT_INACTIVITY_REACH_OUT_MODE),
        getLocalPushSettings(),
      ]);

      setSelectedModel(model);
      setSummary(costSummary);
      setCredits(creditsData);
      setAccount(accountSettings);
      setReachOutMode(inactivityMode);
      setPushSettings(localPushSettings);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useFocusEffect(
    useCallback(() => {
      let active = true;

      getInactivityReachOutMode()
        .then((mode) => {
          if (active) setReachOutMode(mode);
        })
        .catch(() => {});

      return () => {
        active = false;
      };
    }, []),
  );

  const selectModel = async (modelId: string) => {
    const model = await saveSelectedChatModel(modelId);
    setSelectedModel(model);
    await updateClientPreferences({ selected_chat_model: model.id }).catch((error) => {
      console.log("Selected model sync failed:", error);
    });
  };

  const selectReachOutMode = async (nextMode: InactivityReachOutMode) => {
    if (savingReachOutMode) return;

    if (nextMode === reachOutMode) {
      setReachOutSheetVisible(false);
      return;
    }

    setSavingReachOutMode(nextMode);

    try {
      const savedMode = await saveInactivityReachOutMode(nextMode);
      setReachOutMode(savedMode);
      setReachOutSheetVisible(false);
    } catch {
      Alert.alert("保存失败", "请稍后再试。");
    } finally {
      setSavingReachOutMode(null);
    }
  };

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
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

          await updateClientPreferences({ display_name: displayName }).catch((error) => {
            console.log("Display name sync failed:", error);
          });

          setAccount((prev) => ({
            ...prev,
            displayName,
          }));
        },
      },
    ], "plain-text", account.displayName);
  };

  const enableFaceId = async () => {
    const [hasHardware, isEnrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    if (!hasHardware || !isEnrolled) {
      Alert.alert("Face ID 不可用", "请先在 iPhone 系统设置中录入 Face ID。");
      return;
    }

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "开启 Face ID 解锁小C",
      cancelLabel: "取消",
      fallbackLabel: "使用设备密码",
    });
    if (!result.success) return;

    await saveAccountFaceIdEnabled(true);
    setAccount((prev) => ({ ...prev, hasPassword: true, faceIdEnabled: true }));
  };

  const promptForPassword = (afterSave?: () => void | Promise<void>) => {
    Alert.prompt(
      account.hasPassword ? "修改密码" : "设置密码",
      "请输入 6 位数字密码。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "保存",
          onPress: async (value?: string) => {
            const normalizedPassword = (value || "").replace(/[^0-9]/g, "").slice(0, 6);
            if (normalizedPassword.length !== 6) {
              Alert.alert("密码需要 6 位数字");
              return;
            }
            const hasPassword = await saveAccountPassword(normalizedPassword);
            setAccount((prev) => ({ ...prev, hasPassword }));
            if (hasPassword) await afterSave?.();
          },
        },
      ],
      "secure-text",
    );
  };

  const finishDisablingApplicationLock = async () => {
    await clearAccountPassword();
    setAccount((prev) => ({
      ...prev,
      hasPassword: false,
      faceIdEnabled: false,
    }));
  };

  const verifyPasswordAndDisableApplicationLock = () => {
    Alert.prompt(
      "关闭应用锁",
      "请输入当前 6 位密码。关闭后，打开小C不再需要验证。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "关闭",
          style: "destructive",
          onPress: async (value?: string) => {
            const currentPassword = await getAccountPassword();
            if (!currentPassword || value !== currentPassword) {
              Alert.alert("密码不正确");
              return;
            }
            await finishDisablingApplicationLock();
          },
        },
      ],
      "secure-text",
    );
  };

  const disableApplicationLock = async () => {
    if (!account.hasPassword) return;
    if (!account.faceIdEnabled) {
      verifyPasswordAndDisableApplicationLock();
      return;
    }
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "关闭小C应用锁",
      cancelLabel: "取消",
      disableDeviceFallback: true,
    });
    if (result.success) {
      await finishDisablingApplicationLock();
    } else {
      verifyPasswordAndDisableApplicationLock();
    }
  };

  const editApplicationLock = () => {
    const passwordAction = account.hasPassword
      ? account.faceIdEnabled ? "改用密码" : "修改密码"
      : "使用密码";
    Alert.alert(
      "应用锁",
      account.faceIdEnabled
        ? "当前使用 Face ID，密码可作为备用解锁方式。"
        : account.hasPassword
          ? "当前使用 6 位密码。"
          : "当前未开启，打开小C不需要验证。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "不使用应用锁",
          style: account.hasPassword ? "destructive" : "default",
          onPress: disableApplicationLock,
        },
        {
          text: passwordAction,
          onPress: async () => {
            if (account.hasPassword && account.faceIdEnabled) {
              await saveAccountFaceIdEnabled(false);
              setAccount((prev) => ({ ...prev, faceIdEnabled: false }));
            } else {
              promptForPassword();
            }
          },
        },
        {
          text: "使用 Face ID",
          onPress: () => {
            if (account.hasPassword) {
              enableFaceId();
            } else {
              promptForPassword(enableFaceId);
            }
          },
        },
      ],
    );
  };

  const updatePushSettings = async (next: PushSettings) => {
    try {
      const saved = await savePushSettings(next);
      setPushSettings(saved);
    } catch (error) {
      Alert.alert(
        "通知没有开启",
        error instanceof Error ? error.message : "请稍后再试。",
      );
    }
  };

  const editPushNotifications = () => {
    Alert.alert(
      "消息通知",
      pushSettings.enabled
        ? `通知已开启，锁屏${pushSettings.previewEnabled ? "会显示消息内容" : "只显示有新消息"}。`
        : "开启后，小C的主动消息可以出现在锁屏和横幅中。",
      [
        { text: "取消", style: "cancel" },
        ...(pushSettings.enabled
          ? [
              {
                text: pushSettings.previewEnabled ? "隐藏消息内容" : "显示消息内容",
                onPress: () => updatePushSettings({
                  enabled: true,
                  previewEnabled: !pushSettings.previewEnabled,
                  momentsEnabled: pushSettings.momentsEnabled,
                  treeholeEnabled: pushSettings.treeholeEnabled,
                }),
              },
              {
                text: "关闭通知",
                style: "destructive" as const,
                onPress: () => updatePushSettings({
                  enabled: false,
                  previewEnabled: pushSettings.previewEnabled,
                  momentsEnabled: pushSettings.momentsEnabled,
                  treeholeEnabled: pushSettings.treeholeEnabled,
                }),
              },
            ]
          : [
              {
                text: "开启通知",
                onPress: () => updatePushSettings({
                  enabled: true,
                  previewEnabled: true,
                  momentsEnabled: pushSettings.momentsEnabled,
                  treeholeEnabled: pushSettings.treeholeEnabled,
                }),
              },
            ]),
      ],
    );
  };

  const pickMomentAvatarPhoto = async (target: "user" | "xiaoc") => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      Alert.alert("需要相册权限", "允许访问相册后，才能选择朋友圈头像。");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
      base64: false,
    });

    if (result.canceled || !result.assets[0]?.uri) {
      return;
    }

    try {
      const avatarUri = await copyMomentAvatarToAppStorage(
        result.assets[0].uri,
        target,
      );
      const uploaded = await uploadClientPreferenceImage(
        target === "user" ? "user_moment_avatar" : "xiaoc_moment_avatar",
        avatarUri,
      );
      const savedUri = uploaded.uri || avatarUri;

      if (target === "user") {
        await saveUserMomentAvatarUri(savedUri);
        setAccount((prev) => ({
          ...prev,
          userMomentAvatarUri: savedUri,
        }));
        return;
      }

      await saveXiaoCMomentAvatarUri(savedUri);
      setAccount((prev) => ({
        ...prev,
        xiaocMomentAvatarUri: savedUri,
      }));
    } catch (error) {
      Alert.alert(
        "头像保存失败",
        error instanceof Error ? error.message : "请稍后再试。",
      );
    }
  };

  const chooseMomentAvatar = (target: "user" | "xiaoc") => {
    const title = target === "user" ? "我的朋友圈头像" : "小C朋友圈头像";

    Alert.alert(
      title,
      "从相册里选一张照片作为朋友圈头像。",
      [
        {
          text: "取消",
          style: "cancel",
        },
        {
          text: "从相册选择",
          onPress: () => pickMomentAvatarPhoto(target),
        },
      ],
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

        <SectionCard
          title="🤖 模型"
          summary={selectedModel.name}
          expanded={expandedSections.model}
          onToggle={() => toggleSection("model")}
        >
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

        <SectionCard
          title="💲 花费"
          summary={`24h ${formatUsd(summary.last24hCost)}`}
          expanded={expandedSections.cost}
          onToggle={() => toggleSection("cost")}
        >
          <InfoRow label="24h 消耗" value={formatUsd(summary.last24hCost)} />
          <InfoRow label="账户余额" value={formatUsd(credits?.balance)} />
          <InfoRow
            label="本月花费"
            value={formatUsd(credits?.usage_monthly ?? summary.monthCost)}
          />
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

        <SectionCard
          title="🔧 设置"
          summary={account.displayName}
          expanded={expandedSections.settings}
          onToggle={() => toggleSection("settings")}
        >
          <InfoRow
            label="用户名"
            value={account.displayName}
            onPress={editDisplayName}
          />
          <InfoRow
            label="应用锁"
            value={account.faceIdEnabled ? "Face ID" : account.hasPassword ? "密码" : "未开启"}
            onPress={editApplicationLock}
          />
          <InfoRow
            label="消息通知"
            value={pushSettings.enabled ? "已开启" : "未开启"}
            onPress={editPushNotifications}
          />
          <InfoRow
            label="朋友圈更新通知"
            value={pushSettings.enabled && pushSettings.momentsEnabled ? "已开启" : "未开启"}
            onPress={() => {
              if (!pushSettings.enabled) {
                Alert.alert("请先开启消息通知", "开启系统通知后，才能接收朋友圈更新通知。");
                return;
              }
              updatePushSettings({
                ...pushSettings,
                momentsEnabled: !pushSettings.momentsEnabled,
              });
            }}
          />
          <InfoRow
            label="树洞更新通知"
            value={pushSettings.enabled && pushSettings.treeholeEnabled ? "已开启" : "未开启"}
            onPress={() => {
              if (!pushSettings.enabled) {
                Alert.alert("请先开启消息通知", "开启系统通知后，才能接收树洞更新通知。");
                return;
              }
              updatePushSettings({
                ...pushSettings,
                treeholeEnabled: !pushSettings.treeholeEnabled,
              });
            }}
          />
          <InfoRow
            label="我的朋友圈头像"
            value={account.userMomentAvatarUri ? "相册照片" : "未选择"}
            onPress={() => chooseMomentAvatar("user")}
          />
          <InfoRow
            label="小C朋友圈头像"
            value={account.xiaocMomentAvatarUri ? "相册照片" : "未选择"}
            onPress={() => chooseMomentAvatar("xiaoc")}
          />
          <InfoRow label="当前 API" value={getApiHost()} />
        </SectionCard>

        <SectionCard
          title="⭐ 偏好"
          summary={getInactivityReachOutModeLabel(reachOutMode)}
          expanded={expandedSections.preferences}
          onToggle={() => toggleSection("preferences")}
        >
          <InfoRow
            label="主动联系"
            value={getInactivityReachOutModeLabel(reachOutMode)}
            onPress={() => setReachOutSheetVisible(true)}
          />
        </SectionCard>
      </ScrollView>

      <Modal
        visible={reachOutSheetVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setReachOutSheetVisible(false)}
      >
        <View style={styles.sheetOverlay}>
          <Pressable
            style={styles.sheetBackdrop}
            onPress={() => setReachOutSheetVisible(false)}
          />

          <View style={styles.sheetContainer}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>主动联系</Text>

            <View style={styles.sheetOptions}>
              {INACTIVITY_REACH_OUT_OPTIONS.map((option, index) => {
                const selected = option.mode === reachOutMode;
                const saving = option.mode === savingReachOutMode;

                return (
                  <Pressable
                    key={option.mode}
                    style={({ pressed }) => [
                      styles.sheetOption,
                      index > 0 && styles.sheetOptionBorder,
                      pressed && styles.sheetOptionPressed,
                    ]}
                    disabled={Boolean(savingReachOutMode)}
                    onPress={() => selectReachOutMode(option.mode)}
                  >
                    <View style={styles.sheetRadio}>
                      {selected && <View style={styles.sheetRadioSelected} />}
                    </View>
                    <View style={styles.sheetOptionText}>
                      <Text style={styles.sheetOptionLabel}>{option.label}</Text>
                      <Text style={styles.sheetOptionDetail}>{option.detail}</Text>
                    </View>
                    {saving && <Text style={styles.sheetSaving}>保存中…</Text>}
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              style={({ pressed }) => [
                styles.sheetCancel,
                pressed && styles.sheetOptionPressed,
              ]}
              disabled={Boolean(savingReachOutMode)}
              onPress={() => setReachOutSheetVisible(false)}
            >
              <Text style={styles.sheetCancelText}>取消</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
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
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 16,
    shadowColor: "#B8AFA7",
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: {
      width: 0,
      height: 8,
    },
  },

  sectionHeader: {
    minHeight: 58,
    borderRadius: 20,
    paddingHorizontal: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  sectionHeaderPressed: {
    backgroundColor: "rgba(120,120,128,0.08)",
  },

  sectionTitleBox: {
    flex: 1,
    marginRight: 14,
  },

  sectionTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: "#333",
  },

  sectionSummary: {
    marginTop: 6,
    fontSize: 14,
    color: "#9A9491",
  },

  sectionChevron: {
    width: 28,
    textAlign: "center",
    fontSize: 22,
    color: "#A49EA0",
  },

  sectionBody: {
    paddingTop: 8,
    paddingBottom: 4,
    paddingHorizontal: 4,
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

  sheetOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.24)",
  },

  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },

  sheetContainer: {
    paddingTop: 10,
    paddingHorizontal: 12,
    paddingBottom: 30,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: "#F2F2F7",
  },

  sheetHandle: {
    width: 36,
    height: 5,
    borderRadius: 3,
    alignSelf: "center",
    marginBottom: 14,
    backgroundColor: "#C7C7CC",
  },

  sheetTitle: {
    marginBottom: 14,
    textAlign: "center",
    fontSize: 17,
    fontWeight: "600",
    color: "#1C1C1E",
  },

  sheetOptions: {
    overflow: "hidden",
    borderRadius: 14,
    backgroundColor: "#FFFFFF",
  },

  sheetOption: {
    minHeight: 64,
    marginLeft: 16,
    paddingRight: 16,
    flexDirection: "row",
    alignItems: "center",
  },

  sheetOptionBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#D1D1D6",
  },

  sheetOptionPressed: {
    opacity: 0.55,
  },

  sheetRadio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: "#8E8E93",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 13,
  },

  sheetRadioSelected: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#3578F6",
  },

  sheetOptionText: {
    flex: 1,
  },

  sheetOptionLabel: {
    fontSize: 16,
    color: "#1C1C1E",
  },

  sheetOptionDetail: {
    marginTop: 3,
    fontSize: 13,
    color: "#8E8E93",
  },

  sheetSaving: {
    marginLeft: 10,
    fontSize: 13,
    color: "#8E8E93",
  },

  sheetCancel: {
    height: 52,
    borderRadius: 14,
    marginTop: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },

  sheetCancelText: {
    fontSize: 17,
    fontWeight: "600",
    color: "#3578F6",
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
