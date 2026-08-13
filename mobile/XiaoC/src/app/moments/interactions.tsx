import { Image } from "expo-image";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { apiJson, APP_USER_ID } from "../../config/api";
import {
  DEFAULT_XIAOC_MOMENT_AVATAR,
  MOMENT_AVATAR_PRESETS,
  MomentAvatarId,
  getAccountSettings,
} from "../../lib/accountSettings";
import {
  MomentInteraction,
  loadMomentInteractionSnapshot,
} from "../../lib/momentInteractions";

type MomentPreview = {
  id: string;
  text?: string;
  image?: string | null;
};

type MomentInteractionsResponse = {
  interactions: MomentInteraction[];
};

function formatInteractionTime(value: string) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) return "";

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  if (sameDay) {
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  return date.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  });
}

export default function MomentInteractionsScreen() {
  const [interactions, setInteractions] = useState<MomentInteraction[]>([]);
  const [moments, setMoments] = useState<MomentPreview[]>([]);
  const [showingAll, setShowingAll] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [avatar, setAvatar] = useState<{
    avatar: MomentAvatarId;
    uri: string | null;
  }>({ avatar: DEFAULT_XIAOC_MOMENT_AVATAR, uri: null });

  useEffect(() => {
    Promise.all([
      loadMomentInteractionSnapshot(),
      getAccountSettings(),
      apiJson<MomentPreview[]>("/api/memory", {
        query: { type: "moments", user_id: APP_USER_ID },
      }),
    ])
      .then(([items, account, loadedMoments]) => {
        setInteractions(items);
        setMoments(loadedMoments);
        setAvatar({
          avatar: account.xiaocMomentAvatar,
          uri: account.xiaocMomentAvatarUri,
        });
      })
      .catch((error) => {
        console.log("Moment interaction snapshot load failed:", error);
      });
  }, []);

  const loadAllInteractions = async () => {
    if (loadingAll || showingAll) return;

    setLoadingAll(true);
    try {
      const data = await apiJson<MomentInteractionsResponse>("/api/memory", {
        query: {
          type: "moment_interactions",
          user_id: APP_USER_ID,
          scope: "all",
        },
      });
      const merged = [...interactions, ...(data.interactions || [])];
      setInteractions(
        Array.from(new Map(merged.map((item) => [item.id, item])).values()).sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        ),
      );
      setShowingAll(true);
    } catch (error) {
      console.log("All moment interactions load failed:", error);
    } finally {
      setLoadingAll(false);
    }
  };

  const renderAvatar = () => {
    if (avatar.uri) {
      return <Image source={{ uri: avatar.uri }} style={styles.avatar} contentFit="cover" />;
    }

    const preset =
      MOMENT_AVATAR_PRESETS.find((item) => item.id === avatar.avatar) ||
      MOMENT_AVATAR_PRESETS.find((item) => item.id === DEFAULT_XIAOC_MOMENT_AVATAR) ||
      MOMENT_AVATAR_PRESETS[0];

    return (
      <View style={[styles.avatar, { backgroundColor: preset.backgroundColor }]}> 
        <Text style={[styles.avatarText, { color: preset.color }]}> 
          {preset.useInitial ? "C" : preset.symbol}
        </Text>
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <View style={styles.nav}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <SymbolView name="chevron.left" size={20} tintColor="#1C1C1E" weight="regular" />
        </Pressable>
        <Text style={styles.title}>朋友圈互动</Text>
        <View style={styles.navSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {interactions.map((item, index) => {
          const moment = moments.find((candidate) => candidate.id === item.momentId);

          return (
          <Pressable
            key={item.id}
            style={({ pressed }) => [
              styles.interactionRow,
              index > 0 && styles.interactionRowBorder,
              pressed && styles.rowPressed,
            ]}
            onPress={() =>
              router.push({
                pathname: "/moments/[id]",
                params: { id: item.momentId },
              })
            }
          >
            {renderAvatar()}
            <View style={styles.rowBody}>
              <Text style={styles.name}>小C</Text>
              <Text style={styles.interactionText}>{item.text.replace(/^小C/, "")}</Text>
              <Text style={styles.summary} numberOfLines={2}>
                {moment?.text || (moment?.image ? "图片朋友圈" : "这条朋友圈")}
              </Text>
              <Text style={styles.time}>{formatInteractionTime(item.createdAt)}</Text>
            </View>
            <View style={styles.preview}>
              {moment?.image ? (
                <Image source={{ uri: moment.image }} style={styles.previewImage} contentFit="cover" />
              ) : (
                <Text style={styles.previewText} numberOfLines={3}>
                  {moment?.text || "这条朋友圈"}
                </Text>
              )}
            </View>
          </Pressable>
          );
        })}

        {interactions.length > 0 && !showingAll && (
          <Pressable
            style={({ pressed }) => [styles.allInteractionsButton, pressed && styles.rowPressed]}
            onPress={loadAllInteractions}
            disabled={loadingAll}
          >
            <Text style={styles.allInteractionsText}>
              {loadingAll ? "正在加载…" : "查看全部互动消息"}
            </Text>
          </Pressable>
        )}

        {interactions.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>暂时没有新的互动</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#F2F2F3" },
  nav: {
    height: 100,
    paddingTop: 50,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(120,120,128,0.18)",
    backgroundColor: "#F7F7F8",
  },
  backButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 17, fontWeight: "600", color: "#1C1C1E" },
  navSpacer: { width: 40, height: 40 },
  content: { paddingBottom: 34 },
  interactionRow: {
    minHeight: 116,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "#FFFFFF",
  },
  interactionRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(120,120,128,0.16)",
  },
  rowPressed: { backgroundColor: "rgba(120,120,128,0.06)" },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  avatarText: { fontSize: 16, fontWeight: "600" },
  rowBody: { flex: 1 },
  name: { fontSize: 16, lineHeight: 21, fontWeight: "500", color: "#47658F" },
  interactionText: {
    marginTop: 2,
    fontFamily: Platform.OS === "ios" ? "PingFangSC-Regular" : undefined,
    fontSize: 15,
    lineHeight: 20,
    color: "#2C2C2E",
  },
  summary: { marginTop: 6, fontSize: 13, lineHeight: 18, color: "#77777C" },
  time: { marginTop: 7, fontSize: 13, color: "#A6A6AA" },
  preview: {
    width: 68,
    height: 68,
    marginLeft: 14,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    backgroundColor: "#F2F2F3",
  },
  previewImage: { width: "100%", height: "100%" },
  previewText: { paddingHorizontal: 7, fontSize: 12, lineHeight: 17, color: "#5A5A5F" },
  allInteractionsButton: {
    height: 76,
    alignItems: "center",
    justifyContent: "center",
  },
  allInteractionsText: { fontSize: 16, color: "#47658F" },
  empty: { paddingTop: 90, alignItems: "center" },
  emptyText: { fontSize: 15, color: "#A6A6AA" },
});
