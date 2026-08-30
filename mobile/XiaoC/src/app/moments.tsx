import { Image } from "expo-image";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Alert, Dimensions, Keyboard, LayoutChangeEvent, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { useEffect, useRef, useState } from "react";

import { apiJson, APP_USER_ID, postJson } from "../config/api";
import {
  DEFAULT_ACCOUNT_NAME,
  DEFAULT_USER_MOMENT_AVATAR,
  DEFAULT_XIAOC_MOMENT_AVATAR,
  MOMENT_AVATAR_PRESETS,
  MomentAvatarId,
  getAccountSettings,
} from "../lib/accountSettings";
import {
  MomentInteraction,
  saveMomentInteractionSnapshot,
} from "../lib/momentInteractions";
import { ImagePreviewModal } from "../components/ImagePreviewModal";
import type { PreviewImage } from "../components/ImagePreviewModal";
import { MomentImageThumbnail } from "../components/MomentImageThumbnail";
import { MomentAvatar } from "../components/MomentAvatar";
import {
  getMomentAuthorType,
  getMomentsCoverUri,
  saveMomentsCoverUri,
  type MomentProfileKind,
} from "../lib/momentProfile";

type Moment = {
  id: string;
  createdAt: string;
  author: string;
  avatar: MomentAvatarId;
  avatarUri: string | null;
  likes: number;
  xiaocLiked: boolean;
  xiaocSeen: boolean;
  commentsCount: number;
  image?: string | null;
  imageAspectRatio?: number | null;
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
  xiaocReply?: MomentComment | null;
};

type MomentsResponse = Array<{
  id: string;
  author?: string;
  text?: string;
  image?: Moment["image"];
  imageAspectRatio?: number | null;
  likes?: number;
  xiaocLiked?: boolean;
  xiaocSeen?: boolean;
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

type MomentInteractionsResponse = {
  unreadCount: number;
  latestInteractionAt?: string | null;
  interactions: MomentInteraction[];
};

type CreateMomentResponse = {
  success: boolean;
  id: string;
  image?: string | null;
  imageAspectRatio?: number | null;
};

const profileCoverImage = require("../../assets/moments-cover.svg");
const legacyMomentImageKeys = new Set(["sunset", "notebook", "night"]);

const LIKED_MOMENTS_KEY = "xiaoc_liked_moments_v1";
const MOMENTS_LAST_READ_AT_KEY = "xiaoc_moments_last_read_at_v1";
export default function MomentsScreen() {
  const scrollRef = useRef<ScrollView>(null);
  const commentInputRefs = useRef<Record<string, TextInput | null>>({});
  const [moments, setMoments] = useState<Moment[]>([]);
  const [accountName, setAccountName] = useState(DEFAULT_ACCOUNT_NAME);
  const [profileAvatar, setProfileAvatar] = useState<{
    avatar: MomentAvatarId;
    uri: string | null;
  }>({ avatar: DEFAULT_USER_MOMENT_AVATAR, uri: null });
  const [xiaocAvatar, setXiaocAvatar] = useState<{
    avatar: MomentAvatarId;
    uri: string | null;
  }>({ avatar: DEFAULT_XIAOC_MOMENT_AVATAR, uri: null });
  const [profileCoverUri, setProfileCoverUri] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [commentsByMomentId, setCommentsByMomentId] = useState<Record<string, MomentComment[]>>({});
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [postingCommentId, setPostingCommentId] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<{
    momentId: string;
    commentId: string;
    authorName: string;
  } | null>(null);
  const [likedMomentIds, setLikedMomentIds] = useState<Record<string, boolean>>({});
  const [actionMenuMomentId, setActionMenuMomentId] = useState<string | null>(null);
  const [postComposerVisible, setPostComposerVisible] = useState(false);
  const [postDraft, setPostDraft] = useState("");
  const [postImage, setPostImage] = useState<{
    uri: string;
    width: number;
    height: number;
  } | null>(null);
  const [postingMoment, setPostingMoment] = useState(false);
  const [momentInteractions, setMomentInteractions] = useState<MomentInteraction[]>([]);
  const [previewImages, setPreviewImages] = useState<PreviewImage[]>([]);

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

  const markMomentsAsRead = async (items: Moment[]) => {
    const latestCreatedAt = items.find((item) => item.createdAt)?.createdAt;

    if (!latestCreatedAt) return;

    try {
      await AsyncStorage.setItem(MOMENTS_LAST_READ_AT_KEY, latestCreatedAt);
    } catch (error) {
      console.log("Moment read marker save failed:", error);
    }
  };

  const loadMomentInteractions = async () => {
    const data = await apiJson<MomentInteractionsResponse>("/api/memory", {
      query: {
        type: "moment_interactions",
        user_id: APP_USER_ID,
      },
    });

    setMomentInteractions(data.interactions || []);
  };

  const markMomentInteractionsAsRead = async () => {
    try {
      await postJson("/api/memory", {
        type: "moment_interactions",
        user_id: APP_USER_ID,
      });
    } catch (error) {
      console.log("Moment interaction read marker save failed:", error);
    }
  };

  const openMomentInteractions = async () => {
    const interactions = [...momentInteractions];

    try {
      await saveMomentInteractionSnapshot(interactions);
      await markMomentInteractionsAsRead();
      setMomentInteractions([]);
      router.push("/moments/interactions");
    } catch (error) {
      console.log("Moment interactions open failed:", error);
    }
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
    setProfileAvatar({
      avatar: account.userMomentAvatar,
      uri: account.userMomentAvatarUri,
    });
    setXiaocAvatar({
      avatar: account.xiaocMomentAvatar,
      uri: account.xiaocMomentAvatarUri,
    });

    const mappedMoments = data
      .filter((item) => item.id && (item.text || item.image))
      .map((item) => {
        const isXiaoC = !item.author || item.author === "小C";

        return {
          id: item.id,
          author: isXiaoC ? "小C" : account.displayName,
          text: item.text || "",
          image: item.image || null,
          imageAspectRatio: item.imageAspectRatio || null,
          likes: Number(item.likes || 0),
          xiaocLiked: Boolean(item.xiaocLiked),
          xiaocSeen: Boolean(item.xiaocSeen),
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
    await markMomentsAsRead(mappedMoments);

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

    loadMomentInteractions().catch((error) => {
      console.log("Moment interactions load failed:", error);
    });

    AsyncStorage.getItem(LIKED_MOMENTS_KEY)
      .then((raw) => {
        const ids = raw ? JSON.parse(raw) : [];

        if (Array.isArray(ids)) {
          setLikedMomentIds(
            Object.fromEntries(ids.filter((id) => typeof id === "string").map((id) => [id, true])),
          );
        }
      })
      .catch((error) => {
        console.log("Liked moments load failed:", error);
      });

    getMomentsCoverUri()
      .then((uri) => {
        if (uri) {
          setProfileCoverUri(uri);
        }
      })
      .catch((error) => {
        console.log("Moment cover load failed:", error);
      });
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadMoments(), loadMomentInteractions()]);
    } catch (error) {
      console.log("Moments refresh failed:", error);
    } finally {
      setRefreshing(false);
    }
  };

  const pickProfileCover = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        Alert.alert("需要相册权限", "允许访问相册后，才能更换朋友圈封面。");
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [16, 9],
        quality: 0.9,
        base64: false,
      });

      if (result.canceled || !result.assets[0]?.uri) {
        return;
      }

      const uri = result.assets[0].uri;

      setProfileCoverUri(uri);
      await saveMomentsCoverUri(uri);
    } catch (error) {
      Alert.alert("更换失败", error instanceof Error ? error.message : "请稍后再试。");
    }
  };

  const pickPostImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      Alert.alert("需要相册权限", "允许访问相册后，才能在朋友圈发布照片。");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      allowsMultipleSelection: false,
      quality: 1,
    });

    const asset = result.canceled ? null : result.assets[0];

    if (asset?.uri) {
      setPostImage({
        uri: asset.uri,
        width: asset.width || 1,
        height: asset.height || 1,
      });
    }
  };

  const closePostComposer = () => {
    if (postingMoment) return;

    setPostComposerVisible(false);
    setPostDraft("");
    setPostImage(null);
  };

  const publishMoment = async () => {
    const text = postDraft.trim();

    if (!text && !postImage) return;

    setPostingMoment(true);

    try {
      let imageBase64: string | null = null;
      let imageAspectRatio: number | null = null;

      if (postImage) {
        const longestSide = Math.max(postImage.width, postImage.height);
        const resizeAction = longestSide > 1440
          ? [{ resize: postImage.width >= postImage.height ? { width: 1440 } : { height: 1440 } }]
          : [];
        const compressed = await ImageManipulator.manipulateAsync(
          postImage.uri,
          resizeAction,
          {
            compress: 0.72,
            format: ImageManipulator.SaveFormat.JPEG,
            base64: true,
          },
        );

        if (!compressed.base64) {
          throw new Error("图片处理失败，请重新选择后再试。");
        }

        imageBase64 = compressed.base64;
        imageAspectRatio = compressed.width / compressed.height;
      }

      const createdMoment = await apiJson<CreateMomentResponse>("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "moments",
          user_id: APP_USER_ID,
          author: accountName,
          text,
          imageBase64,
          imageMimeType: "image/jpeg",
          imageAspectRatio,
        }),
        timeoutMs: 40000,
      });

      if (postImage && !createdMoment.image) {
        throw new Error("图片没有保存成功，请重新发布。");
      }

      setPostComposerVisible(false);
      setPostDraft("");
      setPostImage(null);
      await loadMoments();
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    } catch (error) {
      Alert.alert("发布失败", error instanceof Error ? error.message : "请稍后再试。");
    } finally {
      setPostingMoment(false);
    }
  };

  const loadComments = async (momentId: string) => {
    const comments = await fetchComments(momentId);

    setCommentsByMomentId((items) => ({
      ...items,
      [momentId]: comments,
    }));
  };

  const persistLikedMoments = async (items: Record<string, boolean>) => {
    await AsyncStorage.setItem(
      LIKED_MOMENTS_KEY,
      JSON.stringify(Object.keys(items).filter((id) => items[id])),
    );
  };

  const syncMomentLikes = async (momentId: string, likes: number) => {
    await apiJson("/api/memory", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "moments",
        user_id: APP_USER_ID,
        id: momentId,
        likes,
      }),
    });
  };

  const toggleLike = async (moment: Moment) => {
    const wasLiked = Boolean(likedMomentIds[moment.id]);
    const nextLikes = Math.max(0, moment.likes + (wasLiked ? -1 : 1));
    const previousLikedMomentIds = likedMomentIds;
    const previousMoments = moments;
    const nextLikedMomentIds = { ...likedMomentIds };

    if (wasLiked) {
      delete nextLikedMomentIds[moment.id];
    } else {
      nextLikedMomentIds[moment.id] = true;
    }

    setActionMenuMomentId(null);
    setLikedMomentIds(nextLikedMomentIds);
    setMoments((items) =>
      items.map((item) =>
        item.id === moment.id
          ? { ...item, likes: nextLikes }
          : item,
      ),
    );

    try {
      await persistLikedMoments(nextLikedMomentIds);
      await syncMomentLikes(moment.id, nextLikes);
    } catch (error) {
      setLikedMomentIds(previousLikedMomentIds);
      setMoments(previousMoments);
      Alert.alert("点赞失败", error instanceof Error ? error.message : "请稍后再试。");
    }
  };

  const openCommentComposer = async (moment: Moment) => {
    setActionMenuMomentId(null);
    setReplyTarget(null);
    setExpandedComments((items) => ({
      ...items,
      [moment.id]: true,
    }));

    if (!commentsByMomentId[moment.id]) {
      try {
        await loadComments(moment.id);
      } catch (error) {
        console.log("Moment comments load failed:", error);
        Alert.alert("评论加载失败", error instanceof Error ? error.message : "请稍后再试。");
      }
    }

    focusCommentInput(moment.id);
  };

  const replyToComment = async (moment: Moment, comment: MomentComment) => {
    if (comment.authorType !== "xiaoc") {
      cancelCommentReply();
      return;
    }

    setActionMenuMomentId(null);
    setReplyTarget({
      momentId: moment.id,
      commentId: comment.id,
      authorName: comment.authorName,
    });
    setExpandedComments((items) => ({
      ...items,
      [moment.id]: true,
    }));

    if (!commentsByMomentId[moment.id]) {
      try {
        await loadComments(moment.id);
      } catch (error) {
        console.log("Moment comments load failed:", error);
      }
    }

    focusCommentInput(moment.id);
  };

  const cancelCommentReply = () => {
    setReplyTarget(null);
    Keyboard.dismiss();
  };

  const toggleCommentComposer = async (moment: Moment) => {
    if (expandedComments[moment.id]) {
      if (replyTarget?.momentId === moment.id) {
        setReplyTarget(null);
      }
      setExpandedComments((items) => ({
        ...items,
        [moment.id]: false,
      }));
      return;
    }

    await openCommentComposer(moment);
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
          parent_id:
            replyTarget?.momentId === moment.id
              ? replyTarget.commentId
              : null,
        }),
      });
      const nextComments = comment.xiaocReply
        ? [comment, comment.xiaocReply]
        : [comment];

      setCommentsByMomentId((items) => ({
        ...items,
        [moment.id]: [...(items[moment.id] || []), ...nextComments],
      }));
      setCommentDrafts((items) => ({ ...items, [moment.id]: "" }));
      setReplyTarget(null);
      updateCommentCount(moment.id, nextComments.length);
    } catch (error) {
      Alert.alert("发送失败", error instanceof Error ? error.message : "请稍后再试。");
    } finally {
      setPostingCommentId(null);
    }
  };

  const focusCommentInput = (momentId: string) => {
    setTimeout(() => {
      commentInputRefs.current[momentId]?.focus();
      scrollCommentInputIntoView();
    }, 80);
  };

  const scrollCommentInputIntoView = () => {};

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
            const result = await apiJson<{ success: boolean; id: string }>("/api/memory", {
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
            const result = await apiJson<{ success: boolean; id: string }>("/api/memory", {
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

            if (!result.success || result.id !== moment.id) {
              throw new Error("动态没有从数据库删除。");
            }
          } catch (error) {
            setMoments(previous);
            Alert.alert("删除失败", error instanceof Error ? error.message : "请稍后再试。");
            return;
          }

          try {
            await loadMoments();
          } catch (error) {
            Alert.alert("刷新失败", "动态已删除，下次刷新时会同步最新列表。");
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

  const openMomentProfile = (profile: MomentProfileKind) => {
    router.navigate(`/moments/profile/${profile}`);
  };

  const renderInteractionAvatar = (inList = false) => {
    if (xiaocAvatar.uri) {
      return (
        <Image
          source={{ uri: xiaocAvatar.uri }}
          style={
            inList
              ? styles.interactionNoticeRowAvatarImage
              : styles.interactionNoticeAvatarImage
          }
          contentFit="cover"
        />
      );
    }

    const preset =
      MOMENT_AVATAR_PRESETS.find((item) => item.id === xiaocAvatar.avatar) ||
      MOMENT_AVATAR_PRESETS.find((item) => item.id === DEFAULT_XIAOC_MOMENT_AVATAR) ||
      MOMENT_AVATAR_PRESETS[0];

    return (
      <View
        style={[
          inList
            ? styles.interactionNoticeRowAvatar
            : styles.interactionNoticeAvatar,
          { backgroundColor: preset.backgroundColor },
        ]}
      >
        <Text style={[styles.interactionNoticeAvatarText, { color: preset.color }]}>
          {preset.useInitial ? "C" : preset.symbol}
        </Text>
      </View>
    );
  };

  const getMomentImages = (
    image?: Moment["image"],
    imageAspectRatio?: number | null,
  ) => {
    if (!image) {
      return [];
    }

    if (legacyMomentImageKeys.has(image)) {
      return [];
    }

    return [
      {
        id: image,
        source: { uri: image },
        aspectRatio: imageAspectRatio || 4 / 3,
      },
    ];
  };

  const renderImages = (
    image?: Moment["image"],
    imageAspectRatio?: number | null,
  ) => {
    const images = getMomentImages(image, imageAspectRatio);

    if (images.length === 0) {
      return null;
    }

    if (images.length > 1) {
      return (
        <View style={styles.photoGrid}>
          {images.slice(0, 9).map((item) => (
            <Image
              key={item.id}
              source={item.source}
              style={styles.photoGridItem}
              contentFit="cover"
            />
          ))}
        </View>
      );
    }

    const item = images[0];

    if (!item) {
      return null;
    }

    return (
      <MomentImageThumbnail
        uri={item.id}
        aspectRatio={item.aspectRatio}
        availableWidth={Dimensions.get("window").width - 98}
        style={styles.singlePhotoFrame}
        onPress={(previewImage) => setPreviewImages([previewImage])}
      />
    );
  };

  return (
    <View style={styles.screen}>
      <View style={styles.nav} pointerEvents="box-none">
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <SymbolView
            name="chevron.left"
            size={20}
            tintColor="#FFFFFF"
            weight="light"
          />
        </Pressable>

        <Text style={styles.title} pointerEvents="none">朋友圈</Text>

        <View style={styles.navSpacer} />
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        onTouchStart={() => {
          if (actionMenuMomentId) setActionMenuMomentId(null);
        }}
        onScrollBeginDrag={() => {
          Keyboard.dismiss();
          setActionMenuMomentId(null);
        }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="#A6A6AA" />
        }
      >
        <View style={styles.profileHeader}>
          <Pressable onPress={pickProfileCover} style={styles.profileCoverButton}>
            <Image
              source={profileCoverUri ? { uri: profileCoverUri } : profileCoverImage}
              style={styles.profileCover}
              contentFit="cover"
            />
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.cameraButton, pressed && styles.pressed]}
            onPressIn={() => console.log("MOMENTS CAMERA PRESS IN")}
            onPress={() => {
              console.log("MOMENTS CAMERA ON PRESS");
              setPostComposerVisible(true);
            }}
            hitSlop={16}
            pressRetentionOffset={16}
          >
            <View pointerEvents="none">
              <SymbolView
                name="camera"
                size={28}
                tintColor="#FFFFFF"
                weight="regular"
                style={styles.cameraIcon}
              />
            </View>
          </Pressable>
          <View style={styles.profileInfoRow}>
            <Text style={styles.profileName}>{accountName}</Text>
            <Pressable
              style={styles.profileAvatarWrap}
              onPress={() => openMomentProfile("user")}
              accessibilityRole="button"
              accessibilityLabel="打开我的朋友圈主页"
            >
              <MomentAvatar
                profile="user"
                name={accountName}
                avatar={profileAvatar.avatar}
                uri={profileAvatar.uri}
                size={68}
              />
            </Pressable>
          </View>
        </View>

        {momentInteractions.length > 0 && (
          <View style={styles.interactionNoticeWrap}>
            <Pressable
              style={({ pressed }) => [
                styles.interactionNotice,
                pressed && styles.pressed,
              ]}
              onPress={openMomentInteractions}
            >
              {renderInteractionAvatar()}
              <Text style={styles.interactionNoticeText}>
                {momentInteractions.length}条新消息
              </Text>
            </Pressable>
          </View>
        )}

        {moments.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>小C还没有偷偷发动态。</Text>
          </View>
        )}

        {moments.map((moment) => {
          const isXiaoC = moment.author === "小C";
          const comments = commentsByMomentId[moment.id] || [];
          const commentAuthorById = comments.reduce<Record<string, string>>((items, comment) => {
            items[comment.id] = comment.authorName;
            return items;
          }, {});
          const commentsCount = commentsByMomentId[moment.id]?.length ?? moment.commentsCount;
          const composerVisible = Boolean(expandedComments[moment.id]);
          const likedByMe = Boolean(likedMomentIds[moment.id]);
          const likedByXiaoC = moment.xiaocLiked;
          const likedNames = [
            ...(likedByMe ? [accountName] : []),
            ...(likedByXiaoC ? ["小C"] : []),
          ];
          const shouldShowInteractionPanel = likedNames.length > 0 || comments.length > 0;
          const actionMenuVisible = actionMenuMomentId === moment.id;

          return (
            <Pressable
              key={moment.id}
              style={({ pressed }) => [
                styles.moment,
                pressed && styles.momentPressed,
              ]}
              onPress={() => {
                if (replyTarget) cancelCommentReply();
              }}
              onLongPress={() => confirmDelete(moment)}
            >
              <Pressable
                style={styles.avatarPressable}
                onPress={(event) => {
                  event.stopPropagation();
                  openMomentProfile(getMomentAuthorType(moment.author));
                }}
                accessibilityRole="button"
                accessibilityLabel={`打开${moment.author}的朋友圈主页`}
              >
                <MomentAvatar
                  profile={getMomentAuthorType(moment.author)}
                  name={moment.author}
                  avatar={moment.avatar}
                  uri={moment.avatarUri}
                />
              </Pressable>

              <View style={styles.momentBody}>
                <View style={styles.momentHeader}>
                  <Text style={styles.author}>{moment.author}</Text>
                  <Text style={styles.date}>{formatMomentTime(moment.createdAt)}</Text>
                </View>

                {Boolean(moment.text) && <Text style={styles.text}>{moment.text}</Text>}

                {renderImages(moment.image, moment.imageAspectRatio)}

                <View style={styles.footer}>
                  <View style={styles.reactions}>
                    <SymbolView
                      name="heart"
                      size={18}
                      tintColor={likedNames.length > 0 ? "#E85D5D" : "#8C8C91"}
                      weight={likedNames.length > 0 ? "regular" : "thin"}
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
                    onTouchStart={(event) => event.stopPropagation()}
                    onPress={() =>
                      setActionMenuMomentId((id) => (id === moment.id ? null : moment.id))
                    }
                  >
                    <SymbolView
                      name="ellipsis"
                      size={15}
                      tintColor="#9B9BA0"
                      weight="light"
                    />
                  </Pressable>
                </View>

                {!isXiaoC && moment.xiaocSeen && !moment.xiaocLiked &&
                  !comments.some((comment) => comment.authorType === "xiaoc") && (
                    <Text style={styles.xiaocSeenText}>小C看过了</Text>
                  )}

                {actionMenuVisible && (
                  <View
                    style={styles.actionMenu}
                    onTouchStart={(event) => event.stopPropagation()}
                  >
                    <Pressable
                      style={({ pressed }) => [
                        styles.actionMenuItem,
                        pressed && styles.actionMenuPressed,
                      ]}
                      onPress={() => toggleLike(moment)}
                    >
                      <SymbolView
                        name="heart"
                        size={15}
                        tintColor="#F4F4F6"
                        weight="regular"
                      />
                      <Text style={styles.actionMenuText}>{likedByMe ? "取消" : "赞"}</Text>
                    </Pressable>

                    <View style={styles.actionMenuDivider} />

                    <Pressable
                      style={({ pressed }) => [
                        styles.actionMenuItem,
                        pressed && styles.actionMenuPressed,
                      ]}
                      onPress={() => openCommentComposer(moment)}
                    >
                      <SymbolView
                        name="message"
                        size={15}
                        tintColor="#F4F4F6"
                        weight="regular"
                      />
                      <Text style={styles.actionMenuText}>评论</Text>
                    </Pressable>
                  </View>
                )}

                {shouldShowInteractionPanel && (
                  <View style={styles.interactionPanel}>
                    {likedNames.length > 0 && (
                      <View style={styles.likedSection}>
                        <SymbolView
                          name="heart.fill"
                          size={13}
                          tintColor="#E85D5D"
                          weight="regular"
                          style={styles.likedByIcon}
                        />
                        <Text style={styles.likedByText}>{likedNames.join("，")}</Text>
                      </View>
                    )}

                    {comments.length > 0 && (
                      <View
                        style={[
                          styles.commentSection,
                          likedNames.length > 0 && styles.commentSectionWithLikes,
                        ]}
                      >
                        {comments.map((comment) => {
                          const replyToName = comment.parentId
                            ? commentAuthorById[comment.parentId]
                            : "";

                          return (
                            <Pressable
                              key={comment.id}
                              style={({ pressed }) => [
                                styles.commentRow,
                                pressed && comment.authorType === "user" && styles.commentPressed,
                              ]}
                              onPress={(event) => {
                                event.stopPropagation();
                                replyToComment(moment, comment);
                              }}
                              onLongPress={() => confirmDeleteComment(moment, comment)}
                            >
                              <Text style={styles.commentLine}>
                                <Text style={styles.commentAuthor}>{comment.authorName}</Text>
                                {replyToName ? (
                                  <Text>
                                    <Text style={styles.commentReplyHint}> 回复 </Text>
                                    <Text style={styles.commentAuthor}>{replyToName}</Text>
                                  </Text>
                                ) : null}
                                <Text style={styles.commentColon}>：</Text>
                                <Text style={styles.commentContent}>{comment.content}</Text>
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    )}

                  </View>
                )}

                {composerVisible && (
                  <View
                    style={styles.commentInputRow}
                    onTouchStart={(event) => event.stopPropagation()}
                  >
                    <TextInput
                      ref={(input) => {
                        commentInputRefs.current[moment.id] = input;
                      }}
                      style={styles.commentInput}
                      value={commentDrafts[moment.id] || ""}
                      onChangeText={(text) =>
                        setCommentDrafts((items) => ({
                          ...items,
                          [moment.id]: text,
                        }))
                      }
                      placeholder={
                        replyTarget?.momentId === moment.id
                          ? `回复 ${replyTarget.authorName}`
                          : "写评论…"
                      }
                      placeholderTextColor="#B1ACA7"
                      multiline
                    />
                    {String(commentDrafts[moment.id] || "").trim() && (
                      <Pressable
                        style={({ pressed }) => [
                          styles.sendCommentButton,
                          pressed && styles.pressed,
                          postingCommentId === moment.id && styles.sendCommentDisabled,
                        ]}
                        disabled={postingCommentId === moment.id}
                        onPress={() => postComment(moment)}
                      >
                        <Text style={styles.sendCommentText}>
                          {postingCommentId === moment.id ? "发送中" : "发送"}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            </Pressable>
          );
        })}

        <Pressable style={styles.keyboardDismissArea} onPress={cancelCommentReply} />
      </ScrollView>

      <ImagePreviewModal
        visible={previewImages.length > 0}
        images={previewImages}
        onClose={() => setPreviewImages([])}
      />

      <Modal
        visible={postComposerVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closePostComposer}
      >
        <View style={styles.postComposerScreen}>
          <View style={styles.postComposerHeader}>
            <Pressable onPress={closePostComposer} disabled={postingMoment}>
              <Text style={styles.postComposerCancel}>取消</Text>
            </Pressable>
            <Text style={styles.postComposerTitle}>发布朋友圈</Text>
            <Pressable
              onPress={publishMoment}
              disabled={postingMoment || (!postDraft.trim() && !postImage)}
            >
              <Text
                style={[
                  styles.postComposerPublish,
                  (postingMoment || (!postDraft.trim() && !postImage)) &&
                    styles.postComposerPublishDisabled,
                ]}
              >
                {postingMoment ? "发布中" : "发布"}
              </Text>
            </Pressable>
          </View>

          <TextInput
            value={postDraft}
            onChangeText={setPostDraft}
            style={styles.postComposerInput}
            placeholder="这一刻的想法…"
            placeholderTextColor="#A5A5AA"
            multiline
            autoFocus
            textAlignVertical="top"
          />

          {postImage && (
            <View style={styles.postImagePreviewWrap}>
              <Image
                source={{ uri: postImage.uri }}
                style={styles.postImagePreview}
                contentFit="cover"
              />
              <Pressable
                style={styles.removePostImageButton}
                onPress={() => setPostImage(null)}
              >
                <SymbolView name="xmark" size={13} tintColor="#FFFFFF" weight="bold" />
              </Pressable>
            </View>
          )}

          {!postImage && (
            <Pressable
              style={({ pressed }) => [styles.addPostImageButton, pressed && styles.pressed]}
              onPress={pickPostImage}
            >
              <SymbolView name="photo" size={22} tintColor="#47658F" weight="regular" />
              <Text style={styles.addPostImageText}>添加照片</Text>
            </Pressable>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },

  nav: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    height: 104,
    paddingTop: 54,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "transparent",
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
    color: "transparent",
  },

  navSpacer: {
    width: 36,
    height: 36,
  },

  cameraButton: {
    position: "absolute",
    top: 54,
    right: 20,
    zIndex: 100,
    elevation: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },

  cameraIcon: {
    shadowColor: "#000000",
    shadowOpacity: 0.22,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
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

  profileHeader: {
    height: 430,
    marginBottom: 30,
    backgroundColor: "#FFFFFF",
  },

  profileCoverButton: {
    zIndex: 0,
    width: "100%",
    height: 360,
  },

  profileCover: {
    width: "100%",
    height: "100%",
    backgroundColor: "#E8E6E1",
  },

  profileInfoRow: {
    position: "absolute",
    top: 292,
    left: 20,
    right: 20,
    height: 96,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "flex-end",
  },

  profileName: {
    maxWidth: "62%",
    marginRight: 14,
    marginBottom: 44,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "600",
    color: "#FFFFFF",
    textAlign: "right",
    textShadowColor: "rgba(0,0,0,0.35)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },

  profileAvatarWrap: {
    width: 68,
    height: 68,
  },

  empty: {
    paddingTop: 72,
    paddingHorizontal: 40,
    alignItems: "center",
  },

  emptyText: {
    fontSize: 15,
    lineHeight: 22,
    color: "#B1ACA7",
  },

  interactionNoticeWrap: {
    marginTop: -6,
    alignItems: "center",
    marginBottom: 8,
  },

  interactionNotice: {
    width: 200,
    minHeight: 40,
    borderRadius: 7,
    paddingHorizontal: 7,
    paddingVertical: 5,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(42,42,44,0.94)",
  },

  interactionNoticeAvatar: {
    width: 34,
    height: 34,
    borderRadius: 5,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
    backgroundColor: "#7A8FA8",
  },

  interactionNoticeAvatarImage: {
    width: 34,
    height: 34,
    borderRadius: 5,
    marginRight: 8,
  },

  interactionNoticeAvatarText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#FFFFFF",
  },

  interactionNoticeText: {
    flex: 1,
    fontFamily: Platform.OS === "ios" ? "PingFangSC-Medium" : undefined,
    fontSize: 14,
    fontWeight: "500",
    color: "#F5F5F7",
    textAlign: "center",
    letterSpacing: 0.15,
    paddingRight: 6,
  },

  interactionNoticeList: {
    width: "90%",
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#F7F7F8",
  },

  interactionNoticeRow: {
    minHeight: 50,
    paddingHorizontal: 10,
    paddingVertical: 7,
    flexDirection: "row",
    alignItems: "center",
  },

  interactionNoticeRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(120,120,128,0.14)",
  },

  interactionNoticeRowAvatar: {
    width: 32,
    height: 32,
    borderRadius: 5,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },

  interactionNoticeRowAvatarImage: {
    width: 32,
    height: 32,
    borderRadius: 5,
    marginRight: 10,
  },

  interactionNoticeRowContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },

  interactionNoticeRowText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 21,
    color: "#2C2C2E",
  },

  interactionNoticeTime: {
    marginLeft: 10,
    fontSize: 12,
    color: "#A6A6AA",
  },

  interactionNoticeMore: {
    minHeight: 34,
    alignItems: "center",
    justifyContent: "center",
  },

  interactionNoticeMoreText: {
    fontSize: 13,
    color: "#7A7A80",
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

  avatarPressable: {
    marginRight: 14,
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
    fontSize: 18,
    lineHeight: 29,
    color: "#161616",
    marginBottom: 12,
  },

  singlePhotoFrame: {
    marginBottom: 13,
  },

  photoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 5,
    marginBottom: 13,
  },

  photoGridItem: {
    width: 82,
    height: 82,
    borderRadius: 4,
    backgroundColor: "#F7F7F7",
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

  xiaocSeenText: {
    marginTop: 6,
    fontSize: 12,
    color: "#A2A2A7",
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

  actionMenu: {
    alignSelf: "flex-end",
    marginTop: 4,
    marginBottom: 2,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 7,
    backgroundColor: "rgba(45,45,48,0.94)",
    overflow: "hidden",
  },

  actionMenuItem: {
    minHeight: 34,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },

  actionMenuPressed: {
    backgroundColor: "rgba(255,255,255,0.12)",
  },

  actionMenuDivider: {
    width: StyleSheet.hairlineWidth,
    height: 18,
    backgroundColor: "rgba(255,255,255,0.22)",
  },

  actionMenuText: {
    fontSize: 14,
    color: "#F4F4F6",
  },

  interactionPanel: {
    marginTop: 8,
    marginLeft: 0,
    borderRadius: 4,
    backgroundColor: "#F7F7F7",
    overflow: "hidden",
  },

  likedSection: {
    paddingHorizontal: 9,
    paddingVertical: 7,
    flexDirection: "row",
    alignItems: "center",
  },

  likedByIcon: {
    marginRight: 5,
  },

  likedByText: {
    fontSize: 16,
    lineHeight: 23,
    color: "#576B95",
  },

  commentSection: {
    paddingHorizontal: 9,
    paddingVertical: 6,
  },

  commentSectionWithLikes: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(120,120,128,0.14)",
  },

  commentRow: {
    paddingVertical: 3,
  },

  commentPressed: {
    opacity: 0.55,
  },

  commentLine: {
    fontSize: 16,
    lineHeight: 24,
    color: "#3A3A3C",
  },

  commentAuthor: {
    fontSize: 16,
    lineHeight: 24,
    color: "#576B95",
  },

  commentReplyHint: {
    fontSize: 16,
    lineHeight: 24,
    color: "#A5A5AA",
  },

  commentColon: {
    fontSize: 16,
    lineHeight: 24,
    color: "#333333",
  },

  commentContent: {
    fontSize: 16,
    lineHeight: 24,
    color: "#333333",
  },

  commentInputRow: {
    marginTop: 6,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 4,
    backgroundColor: "#F7F7F7",
    paddingHorizontal: 9,
    paddingVertical: 5,
  },

  commentInput: {
    flex: 1,
    minHeight: 28,
    maxHeight: 76,
    paddingTop: 2,
    paddingBottom: 2,
    fontSize: 16,
    lineHeight: 23,
    color: "#2F2F31",
  },

  sendCommentButton: {
    minHeight: 24,
    paddingLeft: 12,
    alignItems: "center",
    justifyContent: "center",
  },

  sendCommentDisabled: {
    opacity: 0.45,
  },

  sendCommentText: {
    fontSize: 15,
    color: "#47658F",
  },

  keyboardDismissArea: {
    minHeight: 160,
  },

  postComposerScreen: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },

  postComposerHeader: {
    height: 58,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(120,120,128,0.18)",
  },

  postComposerCancel: {
    minWidth: 52,
    fontSize: 16,
    color: "#3A3A3C",
  },

  postComposerTitle: {
    fontSize: 17,
    fontWeight: "600",
    color: "#161616",
  },

  postComposerPublish: {
    minWidth: 52,
    fontSize: 16,
    fontWeight: "600",
    color: "#3478F6",
    textAlign: "right",
  },

  postComposerPublishDisabled: {
    color: "#B8B8BD",
  },

  postComposerInput: {
    minHeight: 150,
    maxHeight: 260,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 16,
    fontSize: 18,
    lineHeight: 28,
    color: "#161616",
  },

  postImagePreviewWrap: {
    width: 132,
    height: 132,
    marginLeft: 22,
    marginTop: 4,
  },

  postImagePreview: {
    width: "100%",
    height: "100%",
    borderRadius: 8,
    backgroundColor: "#F2F2F7",
  },

  removePostImageButton: {
    position: "absolute",
    top: -8,
    right: -8,
    width: 25,
    height: 25,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(45,45,48,0.86)",
  },

  addPostImageButton: {
    marginLeft: 22,
    marginTop: 8,
    alignSelf: "flex-start",
    minHeight: 42,
    paddingHorizontal: 12,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: "#F5F5F7",
  },

  addPostImageText: {
    fontSize: 16,
    color: "#47658F",
  },
});
