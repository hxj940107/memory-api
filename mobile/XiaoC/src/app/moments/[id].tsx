import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useState } from "react";
import { Dimensions, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { apiJson, APP_USER_ID } from "../../config/api";
import {
  DEFAULT_ACCOUNT_NAME,
  DEFAULT_USER_MOMENT_AVATAR,
  DEFAULT_XIAOC_MOMENT_AVATAR,
  MOMENT_AVATAR_PRESETS,
  MomentAvatarId,
  getAccountSettings,
} from "../../lib/accountSettings";

type Moment = {
  id: string;
  author?: string;
  text?: string;
  image?: string | null;
  imageAspectRatio?: number | null;
  likes?: number;
  xiaocLiked?: boolean;
  createdAt?: string;
};

type MomentComment = {
  id: string;
  authorType?: "user" | "xiaoc";
  authorName?: string;
  content?: string;
  parentId?: string | null;
  createdAt?: string;
};

function formatMomentTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";

  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function MomentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [moment, setMoment] = useState<Moment | null>(null);
  const [comments, setComments] = useState<MomentComment[]>([]);
  const [accountName, setAccountName] = useState(DEFAULT_ACCOUNT_NAME);
  const [avatar, setAvatar] = useState<{
    avatar: MomentAvatarId;
    uri: string | null;
  }>({ avatar: DEFAULT_XIAOC_MOMENT_AVATAR, uri: null });

  useEffect(() => {
    if (!id) return;

    Promise.all([
      apiJson<Moment[]>("/api/memory", {
        query: { type: "moments", user_id: APP_USER_ID },
      }),
      apiJson<MomentComment[]>("/api/memory", {
        query: { type: "moment_comments", user_id: APP_USER_ID, moment_id: id },
      }),
      getAccountSettings(),
    ])
      .then(([moments, loadedComments, account]) => {
        const item = moments.find((candidate) => candidate.id === id) || null;
        setMoment(item);
        setComments(loadedComments);
        setAccountName(account.displayName);
        const isXiaoC = !item?.author || item.author === "小C";
        setAvatar({
          avatar: isXiaoC ? account.xiaocMomentAvatar : account.userMomentAvatar,
          uri: isXiaoC ? account.xiaocMomentAvatarUri : account.userMomentAvatarUri,
        });
      })
      .catch((error) => console.log("Moment detail load failed:", error));
  }, [id]);

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
          {preset.useInitial ? (moment?.author || accountName).slice(0, 1) : preset.symbol}
        </Text>
      </View>
    );
  };

  const renderImage = () => {
    if (!moment?.image) return null;

    const ratio = moment.imageAspectRatio || 4 / 3;
    const availableWidth = Dimensions.get("window").width - 98;
    const isPortrait = ratio < 0.8;
    const isLandscape = ratio > 1.2;
    const maxWidth = Math.min(availableWidth, isPortrait ? 220 : isLandscape ? 320 : 250);
    const maxHeight = isPortrait ? 360 : isLandscape ? 240 : 280;
    const width = Math.min(maxWidth, maxHeight * ratio);
    const height = width / ratio;

    return (
      <View style={[styles.imageFrame, { width, height }]}>
        <Image source={{ uri: moment.image }} style={styles.image} contentFit="contain" />
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <View style={styles.nav}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <SymbolView name="chevron.left" size={20} tintColor="#1C1C1E" weight="regular" />
        </Pressable>
        <Text style={styles.title}>朋友圈详情</Text>
        <View style={styles.navSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {!moment ? (
          <Text style={styles.empty}>这条朋友圈暂时无法查看</Text>
        ) : (
          <View style={styles.moment}>
            {renderAvatar()}
            <View style={styles.body}>
              <View style={styles.header}>
                <Text style={styles.author}>{moment.author || "小C"}</Text>
                <Text style={styles.date}>{formatMomentTime(moment.createdAt)}</Text>
              </View>
              {!!moment.text && <Text style={styles.text}>{moment.text}</Text>}
              {renderImage()}

              <View style={styles.reactions}>
                <SymbolView
                  name={moment.xiaocLiked ? "heart.fill" : "heart"}
                  size={18}
                  tintColor={moment.xiaocLiked ? "#E85D5D" : "#8C8C91"}
                  weight={moment.xiaocLiked ? "regular" : "thin"}
                />
                <Text style={styles.reactionCount}>{Number(moment.likes || 0)}</Text>
                <SymbolView name="message" size={17} tintColor="#8C8C91" weight="thin" />
                <Text style={styles.reactionCount}>{comments.length}</Text>
              </View>

              {moment.xiaocLiked && (
                <View style={styles.likedSection}>
                  <SymbolView name="heart.fill" size={13} tintColor="#E85D5D" weight="regular" />
                  <Text style={styles.likedByText}>小C</Text>
                </View>
              )}

              {comments.length > 0 && (
                <View style={styles.interactionPanel}>
                  {comments.map((comment) => (
                    <Text key={comment.id} style={styles.commentLine}>
                      <Text style={styles.commentAuthor}>
                        {comment.authorName || (comment.authorType === "xiaoc" ? "小C" : accountName)}
                      </Text>
                      <Text>：{comment.content || ""}</Text>
                    </Text>
                  ))}
                </View>
              )}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#FFFFFF" },
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
  content: { paddingVertical: 22 },
  empty: { paddingTop: 80, textAlign: "center", color: "#A6A6AA", fontSize: 15 },
  moment: { flexDirection: "row", paddingHorizontal: 20 },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  avatarText: { fontSize: 18, fontWeight: "600" },
  body: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  author: { fontSize: 17, lineHeight: 22, fontWeight: "500", color: "#47658F" },
  date: { marginLeft: 10, fontSize: 12, color: "#A6A6AA" },
  text: { marginTop: 8, fontSize: 17, lineHeight: 26, color: "#1C1C1E" },
  imageFrame: { marginTop: 10, overflow: "hidden", borderRadius: 4 },
  image: { width: "100%", height: "100%" },
  reactions: { marginTop: 14, flexDirection: "row", alignItems: "center", gap: 6 },
  reactionCount: { marginRight: 14, fontSize: 14, color: "#8C8C91" },
  likedSection: {
    marginTop: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 4,
    backgroundColor: "#F5F5F7",
  },
  likedByText: { fontSize: 15, color: "#47658F", fontWeight: "500" },
  interactionPanel: { marginTop: 12, borderRadius: 4, padding: 10, backgroundColor: "#F5F5F7" },
  commentLine: { fontSize: 15, lineHeight: 22, color: "#2C2C2E" },
  commentAuthor: { color: "#47658F", fontWeight: "500" },
});
