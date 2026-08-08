import { Image } from "expo-image";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { useEffect, useState } from "react";

import { apiJson, APP_USER_ID } from "../config/api";
import {
  DEFAULT_ACCOUNT_NAME,
  DEFAULT_XIAOC_MOMENT_AVATAR,
  MOMENT_AVATAR_PRESETS,
  MomentAvatarId,
  getAccountSettings,
} from "../lib/accountSettings";

type Moment = {
  id: string;
  createdAt: string;
  author: string;
  avatar: MomentAvatarId;
  avatarUri: string | null;
  likes: number;
  commentsCount: number;
  image?: "sunset" | "notebook" | "night" | null;
  text: string;
};

type MomentComment = {
  id: string;
  momentId: string;
  authorType: "user" | "xiaoc";
  authorName: string;
  content: string;
  parentId: string | null;
  createdAt: string;
};

type MomentsResponse = Array<{
  id: string;
  author?: string;
  text?: string;
  image?: Moment["image"];
  likes?: number;
  commentsCount?: number;
  createdAt?: string;
}>;

type MomentCommentsResponse = Array<{
  id: string;
  momentId: string;
  authorType?: "user" | "xiaoc";
  authorName?: string;
  content?: string;
  parentId?: string | null;
  createdAt?: string;
}>;

const momentImages = {
  sunset: require("../../assets/moments-sunset.svg"),
  notebook: require("../../assets/moments-notebook.svg"),
  night: require("../../assets/moments-night.svg"),
};

export default function MomentsScreen() {
  const [moments, setMoments] = useState<Moment[]>([]);
  const [accountName, setAccountName] = useState(DEFAULT_ACCOUNT_NAME);
  const [refreshing, setRefreshing] = useState(false);
  const [commentsByMomentId, setCommentsByMomentId] = useState<Record<string, MomentComment[]>>({});
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [postingCommentId, setPostingCommentId] = useState<string | null>(null);

  const normalizeComments = (
    data: MomentCommentsResponse,
    momentId: string,
    fallbackAccountName: string,
  ): MomentComment[] =>
    data
      .filter((item) => item.id && item.content)
      .map((item) => ({
        id: item.id,
        momentId: item.momentId || momentId,
        authorType: item.authorType === "xiaoc" ? "xiaoc" : "user",
        authorName: item.authorName || (item.authorType === "xiaoc" ? "小C" : fallbackAccountName),
        content: item.content || "",
        parentId: item.parentId || null,
        createdAt: item.createdAt || new Date().toISOString(),
      }));

  const fetchComments = async (momentId: string, fallbackAccountName = accountName) => {
    const data = await apiJson<MomentCommentsResponse>("/api/memory", {
      query: {
        type: "moment_comments",
        user_id: APP_USER_ID,
        moment_id: momentId,
      },
    });

    return normalizeComments(data, momentId, fallbackAccountName);
  };

  const loadMoments = async () => {
    const [data, account] = await Promise.all([
      apiJson<MomentsResponse>("/api/memory", {
        query: {
          type: "moments",
          user_id: APP_USER_ID,
        },
      }),
      getAccountSettings(),
    ]);

    setAccountName(account.displayName);

    const mappedMoments = data
      .filter((item) => item.id && item.text)
      .map((item) => {
        const isXiaoC = !item.author || item.author === "小C";

        return {
          id: item.id,
          author: isXiaoC ? "小C" : item.author || account.displayName,
          text: item.text || "",
          image: item.image || null,
          likes: Number(item.likes || 0),
          commentsCount: Number(item.commentsCount || 0),
          createdAt: item.createdAt || new Date().toISOString(),
          avatar: isXiaoC
            ? account.xiaocMomentAvatar
            : account.userMomentAvatar,
          avatarUri: isXiaoC
            ? account.xiaocMomentAvatarUri
            : account.userMomentAvatarUri,
        };
      });

    setMoments(mappedMoments);

    const momentsWithComments = mappedMoments.filter((item) => item.commentsCount > 0);

    if (momentsWithComments.length > 0) {
      const loadedComments = await Promise.all(
        momentsWithComments.map(async (item) => ({
          momentId: item.id,
          comments: await fetchComments(item.id, account.displayName),
        })),
      );

      setCommentsByMomentId((items) => ({
        ...items,
        ...Object.fromEntries(
          loadedComments.map((item) => [item.momentId, item.comments]),
        ),
      }));
    }
  };

  useEffect(() => {
    loadMoments().catch((error) => {
      console.log("Moments load failed:", error);
    });
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadMoments();
    } catch (error) {
      console.log("Moments refresh failed:", error);
    } finally {
      setRefreshing(false);
    }
  };

  const loadComments = async (momentId: string) => {
    const comments = await fetchComments(momentId);

    setCommentsByMomentId((items) => ({
      ...items,
      [momentId]: comments,
    }));
  };

  const toggleCommentComposer = async (moment: Moment) => {
    setExpandedComments((items) => ({
      ...items,
      [moment.id]: !items[moment.id],
    }));

    if (!commentsByMomentId[moment.id]) {
      try {
        await loadComments(moment.id);
      } catch (error) {
        console.log("Moment comments load failed:", error);
        Alert.alert("评论加载失败", error instanceof Error ? error.message : "请稍后再试。");
      }
    }
  };

  const updateCommentCount = (momentId: string, delta: number) => {
    setMoments((items) =>
      items.map((item) =>
        item.id === momentId
          ? { ...item, commentsCount: Math.max(0, item.commentsCount + delta) }
          : item,
      ),
    );
  };

  const postComment = async (moment: Moment) => {
    const content = String(commentDrafts[moment.id] || "").trim();

    if (!content || postingCommentId) {
      return;
    }

    setPostingCommentId(moment.id);

    try {
      const comment = await apiJson<MomentComment>("/api/memory", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "moment_comments",
          user_id: APP_USER_ID,
          moment_id: moment.id,
          author_type: "user",
          author_name: accountName,
          content,
        }),
      });

      setCommentsByMomentId((items) => ({
        ...items,
        [moment.id]: [...(items[moment.id] || []), comment],
      }));
      setCommentDrafts((items) => ({ ...items, [moment.id]: "" }));
      updateCommentCount(moment.id, 1);
    } catch (error) {
      Alert.alert("发送失败", error instanceof Error ? error.message : "请稍后再试。");
    } finally {
      setPostingCommentId(null);
    }
  };

  const confirmDeleteComment = (moment: Moment, comment: MomentComment) => {
    if (comment.authorType !== "user") {
      return;
    }

    Alert.alert("删除这条评论？", "只会删除你发出的这条评论。", [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: async () => {
          const previous = commentsByMomentId[moment.id] || [];

          setCommentsByMomentId((items) => ({
            ...items,
            [moment.id]: previous.filter((item) => item.id !== comment.id),
          }));
          updateCommentCount(moment.id, -1);

          try {
            await apiJson("/api/memory", {
              method: "DELETE",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                type: "moment_comments",
                user_id: APP_USER_ID,
                id: comment.id,
              }),
            });
          } catch (error) {
            setCommentsByMomentId((items) => ({
              ...items,
              [moment.id]: previous,
            }));
            updateCommentCount(moment.id, 1);
            Alert.alert("删除失败", error instanceof Error ? error.message : "请稍后再试。");
          }
        },
      },
    ]);
  };

  const confirmDelete = (moment: Moment) => {
    Alert.alert("删除这条动态？", "这只会从当前朋友圈里移除。", [
      {
        text: "取消",
        style: "cancel",
      },
      {
        text: "删除",
        style: "destructive",
        onPress: async () => {
          const previous = moments;
          setMoments((items) => items.filter((item) => item.id !== moment.id));

          try {
            await apiJson("/api/memory", {
              method: "DELETE",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                type: "moments",
                user_id: APP_USER_ID,
                id: moment.id,
              }),
            });
          } catch (error) {
            setMoments(previous);
            Alert.alert("删除失败", error instanceof Error ? error.message : "请稍后再试。");
          }
        },
      },
    ]);
  };

  const formatMomentTime = (createdAt: string) => {
    const date = new Date(createdAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));

    if (diffMinutes < 1) return "刚刚";
    if (diffMinutes < 60) return `${diffMinutes}分钟前`;

    const sameDay = date.toDateString() === now.toDateString();
    const time = date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    if (sameDay) return time;

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);

    if (date.toDateString() === yesterday.toDateString()) {
      return `昨天 ${time}`;
    }

    return date.toLocaleDateString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
    });
  };

  const getAccountInitial = (author: string) => {
    const name = author === "小C" ? "C" : accountName;
    return name.trim().slice(0, 1) || "我";
  };

  const renderAvatar = (moment: Moment) => {
    if (moment.avatarUri) {
      return (
        <Image
          source={{ uri: moment.avatarUri }}
          style={styles.avatar}
          contentFit="cover"
        />
      );
    }

    const preset =
      MOMENT_AVATAR_PRESETS.find((item) => item.id === moment.avatar) ||
      MOMENT_AVATAR_PRESETS.find(
        (item) => item.id === DEFAULT_XIAOC_MOMENT_AVATAR,
      ) ||
      MOMENT_AVATAR_PRESETS[0];
    const symbol = preset.useInitial
      ? getAccountInitial(moment.author)
      : preset.symbol;

    return (
      <View
        style={[
          styles.avatar,
          {
            backgroundColor: preset.backgroundColor,
          },
        ]}
      >
        <Text
          style={[
            styles.avatarText,
            {
              color: preset.color,
              fontSize: preset.useInitial ? 18 : 24,
            },
          ]}
        >
          {symbol}
        </Text>
      </View>
    );
  };

  const renderImage = (image?: Moment["image"]) => {
    if (!image) {
      return null;
    }

    return (
      <Image
        source={momentImages[image]}
        style={styles.photo}
        contentFit="cover"
      />
    );
  };

  return (
    <View style={styles.screen}>
      <View style={styles.nav}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <SymbolView
            name="chevron.left"
            size={20}
            tintColor="#7A7A7E"
            weight="light"
          />
        </Pressable>

        <Text style={styles.title}>朋友圈</Text>

        <Pressable style={({ pressed }) => [styles.camera, pressed && styles.pressed]}>
          <SymbolView
            name="camera"
            size={24}
            tintColor="#3C3C43"
            weight="light"
          />
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="#A6A6AA" />
        }
      >
        {moments.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>小C还没有偷偷发动态。</Text>
          </View>
        )}

        {moments.map((moment) => {
          const comments = commentsByMomentId[moment.id] || [];
          const commentsCount = commentsByMomentId[moment.id]?.length ?? moment.commentsCount;
          const composerVisible = Boolean(expandedComments[moment.id]);
          const shouldShowComments = comments.length > 0 || composerVisible;

          return (
            <Pressable
              key={moment.id}
              style={({ pressed }) => [
                styles.moment,
                pressed && styles.momentPressed,
              ]}
              onLongPress={() => confirmDelete(moment)}
            >
              {renderAvatar(moment)}

              <View style={styles.momentBody}>
                <View style={styles.momentHeader}>
                  <Text style={styles.author}>{moment.author}</Text>
                  <Text style={styles.date}>{formatMomentTime(moment.createdAt)}</Text>
                </View>

                <Text style={styles.text}>{moment.text}</Text>

                {renderImage(moment.image)}

                <View style={styles.footer}>
                  <View style={styles.reactions}>
                    <SymbolView
                      name="heart"
                      size={18}
                      tintColor="#8C8C91"
                      weight="thin"
                      style={styles.actionIcon}
                    />
                    <Text style={styles.likeCount}>{moment.likes}</Text>

                    <Pressable
                      style={({ pressed }) => [
                        styles.commentButton,
                        pressed && styles.pressed,
                      ]}
                      onPress={() => loadComments(moment.id)}
                    >
                      <SymbolView
                        name="message"
                        size={17}
                        tintColor={comments.length > 0 ? "#47658F" : "#8C8C91"}
                        weight="thin"
                      />
                      {commentsCount > 0 && (
                        <Text style={styles.commentCount}>{commentsCount}</Text>
                      )}
                    </Pressable>
                  </View>

                  <Pressable
                    style={({ pressed }) => [
                      styles.moreButton,
                      pressed && styles.pressed,
                    ]}
                    onPress={() => toggleCommentComposer(moment)}
                  >
                    <SymbolView
                      name="ellipsis"
                      size={15}
                      tintColor={composerVisible ? "#47658F" : "#A6A6AA"}
                      weight="light"
                    />
                  </Pressable>
                </View>

                {shouldShowComments && (
                  <View style={styles.commentsBox}>
                    {comments.map((comment) => (
                      <Pressable
                        key={comment.id}
                        style={({ pressed }) => [
                          styles.commentRow,
                          pressed && comment.authorType === "user" && styles.commentPressed,
                        ]}
                        onLongPress={() => confirmDeleteComment(moment, comment)}
                      >
                        <Text
                          style={[
                            styles.commentAuthor,
                            comment.authorType === "xiaoc"
                              ? styles.xiaocCommentAuthor
                              : styles.userCommentAuthor,
                          ]}
                        >
                          {comment.authorName}
                        </Text>
                        <Text style={styles.commentContent}>{comment.content}</Text>
                      </Pressable>
                    ))}

                    {composerVisible && (
                      <View style={styles.commentInputRow}>
                        <TextInput
                          style={styles.commentInput}
                          value={commentDrafts[moment.id] || ""}
                          onChangeText={(text) =>
                            setCommentDrafts((items) => ({
                              ...items,
                              [moment.id]: text,
                            }))
                          }
                          placeholder="写评论…"
                          placeholderTextColor="#B1ACA7"
                          multiline
                        />
                        <Pressable
                          style={({ pressed }) => [
                            styles.sendCommentButton,
                            pressed && styles.pressed,
                            (!String(commentDrafts[moment.id] || "").trim() ||
                              postingCommentId === moment.id) &&
                              styles.sendCommentDisabled,
                          ]}
                          disabled={
                            !String(commentDrafts[moment.id] || "").trim() ||
                            postingCommentId === moment.id
                          }
                          onPress={() => postComment(moment)}
                        >
                          <Text style={styles.sendCommentText}>
                            {postingCommentId === moment.id ? "发送中" : "发送"}
                          </Text>
                        </Pressable>
                      </View>
                    )}
                  </View>
                )}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },

  nav: {
    height: 104,
    paddingTop: 54,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(120,120,128,0.1)",
    backgroundColor: "rgba(247,247,247,0.92)",
  },

  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },

  title: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 18,
    textAlign: "center",
    fontSize: 17,
    fontWeight: "400",
    color: "#111111",
  },

  camera: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },

  pressed: {
    opacity: 0.45,
  },

  scroll: {
    flex: 1,
  },

  content: {
    paddingBottom: 34,
  },

  empty: {
    paddingTop: 120,
    paddingHorizontal: 40,
    alignItems: "center",
  },

  emptyText: {
    fontSize: 15,
    lineHeight: 22,
    color: "#B1ACA7",
  },

  moment: {
    flexDirection: "row",
    paddingHorizontal: 20,
    paddingVertical: 22,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(120,120,128,0.1)",
  },

  momentPressed: {
    backgroundColor: "rgba(120,120,128,0.04)",
  },

  avatar: {
    width: 44,
    height: 44,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },

  avatarText: {
    fontSize: 24,
    color: "#FFFFFF",
  },

  momentBody: {
    flex: 1,
  },

  momentHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },

  author: {
    fontSize: 16,
    color: "#47658F",
    fontWeight: "400",
  },

  date: {
    fontSize: 14,
    color: "#B1ACA7",
  },

  text: {
    fontSize: 16,
    lineHeight: 25,
    color: "#161616",
    marginBottom: 12,
  },

  photo: {
    height: 132,
    borderRadius: 7,
    overflow: "hidden",
    marginBottom: 13,
  },

  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  reactions: {
    flexDirection: "row",
    alignItems: "center",
  },

  actionIcon: {
    marginRight: 4,
  },

  likeCount: {
    fontSize: 14,
    color: "#8C8C91",
    marginRight: 18,
  },

  commentButton: {
    flexDirection: "row",
    alignItems: "center",
  },

  commentCount: {
    fontSize: 14,
    color: "#8C8C91",
    marginLeft: 4,
  },

  moreButton: {
    minWidth: 32,
    minHeight: 28,
    alignItems: "flex-end",
    justifyContent: "center",
  },

  commentsBox: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(120,120,128,0.12)",
  },

  commentRow: {
    paddingVertical: 5,
  },

  commentPressed: {
    opacity: 0.55,
  },

  commentAuthor: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 1,
  },

  xiaocCommentAuthor: {
    color: "#47658F",
  },

  userCommentAuthor: {
    color: "#8E7F73",
  },

  commentContent: {
    fontSize: 14,
    lineHeight: 20,
    color: "#3A3A3C",
  },

  commentInputRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: 16,
    backgroundColor: "rgba(120,120,128,0.08)",
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
  },

  commentInput: {
    flex: 1,
    minHeight: 28,
    maxHeight: 88,
    paddingTop: 4,
    paddingBottom: 4,
    fontSize: 14,
    lineHeight: 20,
    color: "#2F2F31",
  },

  sendCommentButton: {
    minHeight: 28,
    paddingHorizontal: 10,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },

  sendCommentDisabled: {
    opacity: 0.45,
  },

  sendCommentText: {
    fontSize: 13,
    color: "#47658F",
  },
});
