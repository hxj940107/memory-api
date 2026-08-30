import { router, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import { Dimensions, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { apiJson, APP_USER_ID } from "../../config/api";
import {
  DEFAULT_ACCOUNT_NAME,
  DEFAULT_XIAOC_MOMENT_AVATAR,
  MomentAvatarId,
  getAccountSettings,
} from "../../lib/accountSettings";
import { ImagePreviewModal } from "../../components/ImagePreviewModal";
import type { PreviewImage } from "../../components/ImagePreviewModal";
import { MomentImageThumbnail } from "../../components/MomentImageThumbnail";
import { MomentAvatar } from "../../components/MomentAvatar";
import { getMomentAuthorType } from "../../lib/momentProfile";

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
  xiaocReply?: MomentComment | null;
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
  const commentInputRef = useRef<TextInput>(null);
  const { id } = useLocalSearchParams<{ id: string }>();
  const [moment, setMoment] = useState<Moment | null>(null);
  const [comments, setComments] = useState<MomentComment[]>([]);
  const [accountName, setAccountName] = useState(DEFAULT_ACCOUNT_NAME);
  const [avatar, setAvatar] = useState<{
    avatar: MomentAvatarId;
    uri: string | null;
  }>({ avatar: DEFAULT_XIAOC_MOMENT_AVATAR, uri: null });
  const [previewImages, setPreviewImages] = useState<PreviewImage[]>([]);
  const [replyTarget, setReplyTarget] = useState<MomentComment | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [postingComment, setPostingComment] = useState(false);

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

  const renderImage = () => {
    if (!moment?.image) return null;

    return (
      <MomentImageThumbnail
        uri={moment.image}
        aspectRatio={moment.imageAspectRatio}
        availableWidth={Dimensions.get("window").width - 98}
        style={styles.imageFrame}
        onPress={(previewImage) => setPreviewImages([previewImage])}
      />
    );
  };

  const startReply = (comment: MomentComment) => {
    if (comment.authorType !== "xiaoc") return;
    setReplyTarget(comment);
    setTimeout(() => commentInputRef.current?.focus(), 80);
  };

  const postReply = async () => {
    const content = commentDraft.trim();
    if (!id || !replyTarget || !content || postingComment) return;

    setPostingComment(true);
    try {
      const comment = await apiJson<MomentComment>("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "moment_comments",
          user_id: APP_USER_ID,
          moment_id: id,
          author_type: "user",
          author_name: accountName,
          content,
          parent_id: replyTarget.id,
        }),
      });
      setComments((items) => [
        ...items,
        comment,
        ...(comment.xiaocReply ? [comment.xiaocReply] : []),
      ]);
      setCommentDraft("");
      setReplyTarget(null);
      Keyboard.dismiss();
    } catch (error) {
      console.log("Moment reply failed:", error);
    } finally {
      setPostingComment(false);
    }
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

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => {
          setReplyTarget(null);
          Keyboard.dismiss();
        }}
      >
        {!moment ? (
          <Text style={styles.empty}>这条朋友圈暂时无法查看</Text>
        ) : (
          <Pressable
            style={styles.moment}
            onPress={() => {
              if (replyTarget) {
                setReplyTarget(null);
                Keyboard.dismiss();
              }
            }}
          >
            <Pressable
              style={styles.avatarPressable}
              onPress={(event) => {
                event.stopPropagation();
                router.navigate(
                  `/moments/profile/${getMomentAuthorType(moment.author)}`,
                );
              }}
              accessibilityRole="button"
              accessibilityLabel={`打开${moment.author || "小C"}的朋友圈主页`}
            >
              <MomentAvatar
                profile={getMomentAuthorType(moment.author)}
                name={moment.author || "小C"}
                avatar={avatar.avatar}
                uri={avatar.uri}
              />
            </Pressable>
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
                  {comments.map((comment) => {
                    const parent = comment.parentId
                      ? comments.find((item) => item.id === comment.parentId)
                      : null;
                    const authorName =
                      comment.authorName ||
                      (comment.authorType === "xiaoc" ? "小C" : accountName);
                    const replyToName = parent
                      ? parent.authorName ||
                        (parent.authorType === "xiaoc" ? "小C" : accountName)
                      : "";

                    return (
                      <Pressable
                        key={comment.id}
                        onPress={(event) => {
                          event.stopPropagation();
                          startReply(comment);
                        }}
                      >
                        <Text style={styles.commentLine}>
                          <Text style={styles.commentAuthor}>{authorName}</Text>
                          {!!replyToName && (
                            <Text>
                              <Text style={styles.commentReplyHint}> 回复 </Text>
                              <Text style={styles.commentAuthor}>{replyToName}</Text>
                            </Text>
                          )}
                          <Text>：{comment.content || ""}</Text>
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}

              {!!replyTarget && (
                <View
                  style={styles.commentInputRow}
                  onTouchStart={(event) => event.stopPropagation()}
                >
                  <TextInput
                    ref={commentInputRef}
                    style={styles.commentInput}
                    value={commentDraft}
                    onChangeText={setCommentDraft}
                    placeholder={`回复 ${replyTarget.authorName || "小C"}`}
                    placeholderTextColor="#B1ACA7"
                    multiline
                  />
                  {!!commentDraft.trim() && (
                    <Pressable
                      style={styles.sendCommentButton}
                      disabled={postingComment}
                      onPress={postReply}
                    >
                      <Text style={styles.sendCommentText}>
                        {postingComment ? "发送中" : "发送"}
                      </Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          </Pressable>
        )}
      </ScrollView>
      <ImagePreviewModal
        visible={previewImages.length > 0}
        images={previewImages}
        onClose={() => setPreviewImages([])}
      />
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
  avatarPressable: {
    marginRight: 12,
  },
  body: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  author: { fontSize: 17, lineHeight: 22, fontWeight: "500", color: "#47658F" },
  date: { marginLeft: 10, fontSize: 12, color: "#A6A6AA" },
  text: { marginTop: 8, fontSize: 17, lineHeight: 26, color: "#1C1C1E" },
  imageFrame: { marginTop: 10, borderRadius: 4 },
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
  commentReplyHint: { color: "#5F6570" },
  commentInputRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  commentInput: {
    flex: 1,
    minHeight: 36,
    maxHeight: 90,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#F2F2F4",
    color: "#1C1C1E",
    fontSize: 15,
  },
  sendCommentButton: {
    minHeight: 36,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: "#47658F",
  },
  sendCommentText: { color: "#FFFFFF", fontSize: 14, fontWeight: "500" },
});
