import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Image,
  Modal,
  Animated as RNAnimated,
  Dimensions,
  Keyboard,
  AppState,
  ActionSheetIOS,
  Alert,
  RefreshControl,
} from "react-native";

import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  ReduceMotion,
} from "react-native-reanimated";

import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";

import { Fragment, useState, useRef, useEffect, useCallback } from "react";

import ConversationList from "../components/ConversationList";
import { APP_USER_ID, apiJson, postJson } from "../config/api";
import {
  clearLastConversation,
  getBestLastConversation,
  saveLastConversation,
} from "../lib/conversationState";
import {
  isDiaryText,
  ObservationDiaryEntry,
  parseDiaryText,
} from "../data/observationDiary";
import { saveFavorite } from "../lib/favoritesState";
import { getSelectedChatModel } from "../lib/modelSettings";
import { saveChatUsageFromResponse } from "../lib/costState";
import {
  getImageCompressionProfile,
  type ImageKind,
} from "../lib/imageUploadProfile";
import {
  getStableMessageId,
  mergeCloudMessages,
  reconcileLocalMessageCloudId,
  getValidCloudMessageId,
  upsertCloudMessage,
} from "../lib/messageSync";
import { getPrependAnchoredOffset } from "../lib/chatScrollAnchor";
import { XiaoCColors } from "../constants/theme";
import {
  isTreeholeDraftSaved,
  saveTreeholeDraft,
  TreeholeDraft,
} from "../lib/treeholeState";
import {
  formatAttachmentSize,
  getAttachmentTypeLabel,
  getSafeDownloadFilename,
  normalizeGeneratedAttachments,
  type GeneratedAttachment,
} from "../lib/generatedAttachments";
import { SharedContextBar } from "../components/SharedContextBar";
import {
  hasBlockMarkdown,
  InlineMarkdown,
  MessageMarkdown,
} from "../components/MessageMarkdown";
import { stageSharedAlbumImport } from "../lib/sharedAlbumImportDraft";

type Message = {
  id: string;
  cloudId?: string;
  clientId?: string;
  role: "user" | "assistant";
  text: string;
  fileName?: string;
  fileText?: string;
  fileSize?: number | null;
  fileMimeType?: string | null;
  attachments?: GeneratedAttachment[];
  imageUri?: string;
  imageUris?: string[];
  imageAsset?: ImagePicker.ImagePickerAsset;
  imageAssets?: ImagePicker.ImagePickerAsset[];
  status?: "sending" | "syncing" | "sent" | "failed";
  diarySaveStatus?: "idle" | "saving" | "saved" | "failed";
  treeholeDraft?: TreeholeDraft;
  treeholeSaveStatus?: "idle" | "saving" | "saved" | "failed";
  createdAt?: string;
  metadata?: {
    proactive?: boolean;
    proactiveType?: string;
    proactiveTaskId?: string;
    clientMessageId?: string;
    replyToUserMessageId?: string;
    replyToClientMessageId?: string;
    attachments?: GeneratedAttachment[];
  };
};

type SelectedFile = {
  name: string;
  text: string;
  size?: number | null;
  mimeType?: string | null;
  truncated: boolean;
};

type MessageMenuState = {
  text: string;
  message?: Message;
  x: number;
  y: number;
} | null;

type HistoryItem = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  metadata?: {
    imageUrl?: string;
    imageUrls?: string[];
    fileName?: string;
    fileMimeType?: string | null;
    fileSize?: number | null;
    proactive?: boolean;
    proactiveType?: string;
    proactiveTaskId?: string;
    clientMessageId?: string;
    replyToUserMessageId?: string;
    replyToClientMessageId?: string;
    attachments?: GeneratedAttachment[];
  };
};

type ChatResponse = {
  reply?: string;
  conversation_id?: string;
  user_message_id?: string | null;
  assistant_message_id?: unknown;
  model?: string;
  usage?: Record<string, unknown>;
  attachments?: GeneratedAttachment[];
  processing?: boolean;
  deduplicated?: boolean;
};

type SignedAttachmentResponse = {
  url: string;
  expires_in: number;
};

const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_FILE_CHARS = 12000;
const HISTORY_PAGE_SIZE = 60;
const TEXT_FILE_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "log",
  "xml",
  "html",
  "css",
  "js",
  "ts",
  "tsx",
  "jsx",
]);

const createLocalMessageId = () =>
  `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const MESSAGE_TIME_GAP_MS = 60 * 60 * 1000;
const WEEKDAY_LABELS = [
  "星期日",
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
];

const isSameCalendarDay = (left: Date, right: Date) =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

const getStartOfWeek = (date: Date) => {
  const start = new Date(date);
  const day = start.getDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;

  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - daysSinceMonday);

  return start;
};

const formatMessageTime = (createdAt: string) => {
  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;

  if (isSameCalendarDay(date, now)) {
    return `今天 ${time}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  if (isSameCalendarDay(date, yesterday)) {
    return `昨天 ${time}`;
  }

  if (date >= getStartOfWeek(now) && date <= now) {
    return `${WEEKDAY_LABELS[date.getDay()]} ${time}`;
  }

  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }

  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
};

const shouldShowMessageTime = (
  message: Message,
  previousMessage?: Message,
) => {
  if (!message.createdAt) return false;
  if (!previousMessage?.createdAt) return true;

  const currentDate = new Date(message.createdAt);
  const previousDate = new Date(previousMessage.createdAt);

  if (
    Number.isNaN(currentDate.getTime()) ||
    Number.isNaN(previousDate.getTime())
  ) {
    return false;
  }

  if (!isSameCalendarDay(currentDate, previousDate)) {
    return true;
  }

  if (message.metadata?.proactive) {
    const isSameProactiveTask =
      !!message.metadata.proactiveTaskId &&
      previousMessage.metadata?.proactiveTaskId ===
        message.metadata.proactiveTaskId;

    if (!isSameProactiveTask) {
      return true;
    }
  }

  return currentDate.getTime() - previousDate.getTime() >= MESSAGE_TIME_GAP_MS;
};

const IMAGE_PLACEHOLDER_TEXTS = new Set([
  "（图片）",
  "请看这张图片。",
  "请看这张照片。",
]);

const shouldHideImagePlaceholderText = (content: string, imageUrl?: string) =>
  !!imageUrl && IMAGE_PLACEHOLDER_TEXTS.has(content.trim());

const normalizeShortAiText = (text: string) =>
  text
    .replace(/[ \t]*\n+[ \t]*/g, "\n")
    .replace(/([\u4e00-\u9fff，。！？、；：])[\t \u3000]+([\u4e00-\u9fff])/g, "$1$2")
    .replace(/([\u4e00-\u9fff])[\t \u3000]+([，。！？、；：])/g, "$1$2")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

const shouldUseSimpleAiText = (text: string) =>
  normalizeShortAiText(text).length <= 32;

const getDisplayAiText = (text: string) =>
  shouldUseSimpleAiText(text)
    ? normalizeShortAiText(text)
    : text.replace(/\s*\n\s*/g, "\n");

const getChatBubbleSegments = (text: string) => {
  return getDisplayAiText(text)
    .split(/\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
};

const getUserBubbleSegments = (text: string) =>
  text
    .split(/\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

const normalizeTreeholeDraftJson = (rawJson: string) =>
  rawJson
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/"\s*\n\s*"/g, '",\n"')
    .replace(/"\s+"(?=[^"]*"\s*(?:,|\]))/g, '", "')
    .replace(/("[^"]*")\s+(?="[^"]*"\s*[\],])/g, "$1, ")
    .replace(/,\s*([}\]])/g, "$1");

const parseTreeholeDraft = (text: string): TreeholeDraft | null => {
  const trimmed = text.trim();

  if (!trimmed.includes('"type"') || !trimmed.includes("treehole_draft")) {
    return null;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start < 0 || end <= start) {
    return null;
  }

  try {
    const rawJson = trimmed.slice(start, end + 1);
    let draft;

    try {
      draft = JSON.parse(rawJson);
    } catch {
      draft = JSON.parse(normalizeTreeholeDraftJson(rawJson));
    }

    if (
      draft?.type === "treehole_draft" &&
      Array.isArray(draft.content) &&
      draft.content.length > 0
    ) {
      return {
        type: "treehole_draft",
        tag: String(draft.tag || "树洞"),
        date: String(draft.date || ""),
        content: draft.content.map((line: unknown) => String(line)),
        highlights: Array.isArray(draft.highlights)
          ? draft.highlights.map((line: unknown) => String(line))
          : [],
        reaction: String(draft.reaction || "🌙 偷偷偏心 · ❤️ 1"),
      };
    }
  } catch {
    return null;
  }

  return null;
};

const getDiaryEntryKey = (entry: ObservationDiaryEntry) =>
  [
    entry.date || "",
    entry.title || "",
    ...entry.sections.flatMap((section) => [
      section.tag,
      ...(section.paragraphs || []),
      ...(section.emphasis || []),
    ]),
  ]
    .join("｜")
    .replace(/\s+/g, " ")
    .trim();

const getFileExtension = (name: string) =>
  name.split(".").pop()?.toLowerCase() || "";

const isSupportedTextFile = (name: string, mimeType?: string | null) => {
  if (mimeType?.startsWith("text/")) {
    return true;
  }

  return TEXT_FILE_EXTENSIONS.has(getFileExtension(name));
};

function TypingDots({
  compact = false,
}: {
  compact?: boolean;
}) {
  const dots = [
    new RNAnimated.Value(0),
    new RNAnimated.Value(0),
    new RNAnimated.Value(0),
  ];

  useEffect(() => {
    const animations = dots.map((dot, index) =>
      RNAnimated.loop(
        RNAnimated.sequence([
          RNAnimated.delay(index * 200),

          RNAnimated.timing(dot, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),

          RNAnimated.timing(dot, {
            toValue: 0,
            duration: 600,
            useNativeDriver: true,
          }),
        ]),
      ),
    );

    animations.forEach((animation) => {
      animation.start();
    });

    return () => {
      animations.forEach((animation) => {
        animation.stop();
      });
    };
  }, []);

  return (
    <View style={[styles.typingDots, compact && styles.typingDotsCompact]}>
      {dots.map((dot, index) => (
        <RNAnimated.View
          key={index}
          style={[
            styles.dot,
            {
              opacity: dot.interpolate({
                inputRange: [0, 1],
                outputRange: [0.3, 1],
              }),
            },
          ]}
        />
      ))}
    </View>
  );
}

function AnimatedMessage({ children }: { children: React.ReactNode }) {
  const opacity = useState(new RNAnimated.Value(0))[0];
  const translateY = useState(new RNAnimated.Value(8))[0];

  useEffect(() => {
    RNAnimated.parallel([
      RNAnimated.timing(opacity, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true,
      }),

      RNAnimated.timing(translateY, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  return (
    <RNAnimated.View
      style={{
        opacity,
        transform: [
          {
            translateY,
          },
        ],
      }}
    >
      {children}
    </RNAnimated.View>
  );
}

function ChatMessageImage({
  uri,
  multiple,
  subdued,
}: {
  uri: string;
  multiple: boolean;
  subdued: boolean;
}) {
  const [aspectRatio, setAspectRatio] = useState(1);

  return (
    <Image
      source={{ uri }}
      resizeMode="cover"
      onLoad={(event) => {
        const { width, height } = event.nativeEvent.source;

        if (width && height) {
          setAspectRatio(Math.min(Math.max(width / height, 0.72), 1.5));
        }
      }}
      style={[
        styles.messageImage,
        !multiple && { aspectRatio },
        multiple && styles.messageImageGridItem,
        subdued && styles.messageImageSending,
      ]}
    />
  );
}

function TreeholeDraftCard({
  draft,
  saveStatus,
  onSave,
  onDismiss,
}: {
  draft: TreeholeDraft;
  saveStatus?: Message["treeholeSaveStatus"];
  onSave: () => void;
  onDismiss: () => void;
}) {
  const highlights = draft.highlights || [];

  return (
    <View style={styles.treeholeDraftCard}>
      <View style={styles.treeholeDraftHeader}>
        <Text style={styles.treeholeDraftLabel}>深夜树洞 · 草稿</Text>
        {!!draft.date && <Text style={styles.treeholeDraftDate}>{draft.date}</Text>}
      </View>

      {!!draft.tag && (
        <Text style={styles.treeholeDraftTag}>{draft.tag}</Text>
      )}

      <View style={styles.treeholeDraftContent}>
        {draft.content.map((line, index) => {
          const matchedHighlight = highlights.find((highlight) =>
            line.includes(highlight),
          );

          if (!matchedHighlight) {
            return (
              <Text key={`${line}-${index}`} style={styles.treeholeDraftLine}>
                {line}
              </Text>
            );
          }

          const [before, after] = line.split(matchedHighlight);

          return (
            <Text key={`${line}-${index}`} style={styles.treeholeDraftLine}>
              {before}
              <Text style={styles.treeholeDraftHighlight}>
                {matchedHighlight}
              </Text>
              {after}
            </Text>
          );
        })}
      </View>

      <Text style={styles.treeholeDraftReaction}>
        {draft.reaction || "🌙 偷偷偏心 · ❤️ 1"}
      </Text>

      <View style={styles.treeholeDraftActions}>
        <Pressable
          style={({ pressed }) => [
            styles.treeholeDraftButton,
            pressed && styles.treeholeDraftButtonPressed,
            saveStatus === "saved" && styles.treeholeDraftButtonSaved,
          ]}
          onPress={onSave}
          disabled={saveStatus === "saving" || saveStatus === "saved"}
        >
          <Text style={styles.treeholeDraftButtonText}>
            {saveStatus === "saving"
              ? "正在存入..."
              : saveStatus === "saved"
                ? "已存入树洞"
                : saveStatus === "failed"
                  ? "存入失败，重试"
                  : "存入树洞"}
          </Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.treeholeDraftGhostButton,
            pressed && styles.treeholeDraftButtonPressed,
          ]}
          onPress={onDismiss}
        >
          <Text style={styles.treeholeDraftGhostText}>不要了</Text>
        </Pressable>
      </View>
    </View>
  );
}

function DiaryPreviewCard({
  entry,
  saveStatus,
  onSave,
  onDismiss,
}: {
  entry: ObservationDiaryEntry;
  saveStatus?: Message["diarySaveStatus"];
  onSave: () => void;
  onDismiss: () => void;
}) {
  const previewSections = entry.sections.slice(0, 3);

  return (
    <View style={styles.diaryPreviewCard}>
      <Text style={styles.diaryPreviewLabel}>WIFE OBSERVATION DIARY</Text>
      <Text style={styles.diaryPreviewTitle}>{entry.title}</Text>
      <Text style={styles.diaryPreviewDate}>
        {entry.displayDate || entry.date.replaceAll(".", " · ")}
      </Text>

      <View style={styles.diaryPreviewDivider} />

      {previewSections.map((section, index) => (
        <View key={`${section.tag}-${index}`} style={styles.diaryPreviewSection}>
          <Text style={styles.diaryPreviewTag}>{section.tag}</Text>
          {section.paragraphs.slice(0, 3).map((paragraph, paragraphIndex) => (
            <Text
              key={`${section.tag}-${index}-${paragraphIndex}`}
              style={styles.diaryPreviewText}
            >
              {paragraph}
            </Text>
          ))}
        </View>
      ))}

      {entry.sections.length > previewSections.length && (
        <Text style={styles.diaryPreviewMore}>· · ·</Text>
      )}

      <View style={styles.diaryPreviewActions}>
        <Pressable
          style={({ pressed }) => [
            styles.diaryPreviewButton,
            pressed && styles.diaryPreviewButtonPressed,
            saveStatus === "saved" && styles.diaryPreviewButtonSaved,
          ]}
          onPress={onSave}
          disabled={saveStatus === "saving" || saveStatus === "saved"}
        >
          <Text style={styles.diaryPreviewButtonText}>
            {saveStatus === "saving"
              ? "正在存入..."
              : saveStatus === "saved"
                ? "已存入 Diary"
                : saveStatus === "failed"
                  ? "存入失败，重试"
                  : "存入 Diary"}
          </Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.diaryPreviewGhostButton,
            pressed && styles.diaryPreviewButtonPressed,
          ]}
          onPress={onDismiss}
        >
          <Text style={styles.diaryPreviewGhostText}>不要了</Text>
        </Pressable>
      </View>
    </View>
  );
}
export default function ChatScreen() {
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();

  const drawerWidth = Dimensions.get("window").width * 0.82;

  const incomingConversationId = params.conversationId as string | undefined;
  const shouldStartNewChat = params.newChat === "1";

  const [message, setMessage] = useState("");

  const [selectedImages, setSelectedImages] = useState<
    ImagePicker.ImagePickerAsset[]
  >([]);

  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);

  const [previewImageUri, setPreviewImageUri] = useState<string | null>(null);

  const [messageMenu, setMessageMenu] = useState<MessageMenuState>(null);

  const [messageMenuVisible, setMessageMenuVisible] = useState(false);

  const [moreMenuVisible, setMoreMenuVisible] = useState(false);

  const [selectionText, setSelectionText] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);

  const [isTyping, setIsTyping] = useState(false);
  const [deliveryNotice, setDeliveryNotice] = useState<string | null>(null);

  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const [hasOlderHistory, setHasOlderHistory] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const scrollOffsetYRef = useRef(0);
  const contentHeightRef = useRef(0);
  const prependAnchorRef = useRef<{
    contentHeight: number;
    scrollOffsetY: number;
  } | null>(null);
  const skipNextMessageAutoScrollRef = useRef(false);
  const inputRef = useRef<TextInput>(null);
  const keyboardVisibleRef = useRef(false);
  const sendButtonProgress = useRef(new RNAnimated.Value(0)).current;

  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const latestCloudMessageIdRef = useRef<string | null>(null);
  const historyRefreshInFlightRef = useRef(false);
  const pendingReplyClientIdRef = useRef<string | null>(null);
  const hasRestoredConversationRef = useRef(false);
  const conversationTitleInitializedRef = useRef(false);
  const lastRestoreRouteKeyRef = useRef<string | null>(null);

  const [drawerVisible, setDrawerVisible] = useState(false);
  const [sharedContextOpenRequestKey, setSharedContextOpenRequestKey] = useState(0);

  const canSendMessage =
    message.trim().length > 0 || selectedImages.length > 0 || !!selectedFile;
  const isSendDisabled = !canSendMessage || isTyping;

  useEffect(() => {
    RNAnimated.timing(sendButtonProgress, {
      toValue: canSendMessage ? 1 : 0,
      duration: 160,
      useNativeDriver: true,
    }).start();
  }, [canSendMessage, sendButtonProgress]);

  const scrollToLatestMessage = (animated = true) => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({
        animated,
      });
    });
  };

  useEffect(() => {
    if (skipNextMessageAutoScrollRef.current) {
      skipNextMessageAutoScrollRef.current = false;
      return;
    }

    const shortTimer = setTimeout(() => {
      scrollToLatestMessage(true);
    }, 80);

    const layoutTimer = setTimeout(() => {
      scrollToLatestMessage(true);
    }, 260);

    return () => {
      clearTimeout(shortTimer);
      clearTimeout(layoutTimer);
    };
  }, [messages.length, messages[messages.length - 1]?.text?.length, isTyping]);

  const restoreHistoryItems = async (data: HistoryItem[]) => {
    let savedDiaryKeys = new Set<string>();

    if (
      data.some(
        (item) => item.role === "assistant" && isDiaryText(item.content),
      )
    ) {
      try {
        const cloudDiaries = await apiJson<ObservationDiaryEntry[]>(
          "/api/memory",
          {
            query: {
              type: "diary",
              user_id: APP_USER_ID,
            },
          },
        );

        savedDiaryKeys = new Set(cloudDiaries.map(getDiaryEntryKey));
      } catch (error) {
        console.log("Saved diary status load failed:", error);
      }
    }

    return Promise.all(
      data.map(async (item) => {
        const treeholeDraft =
          item.role === "assistant" ? parseTreeholeDraft(item.content) : null;
        const treeholeAlreadySaved = treeholeDraft
          ? await isTreeholeDraftSaved(treeholeDraft)
          : false;
        const diaryEntry =
          item.role === "assistant" && isDiaryText(item.content)
            ? parseDiaryText(item.content)
            : null;
        const diaryAlreadySaved = diaryEntry
          ? savedDiaryKeys.has(getDiaryEntryKey(diaryEntry))
          : false;

        return {
          id: String(item.id),
          cloudId: String(item.id),
          clientId: item.metadata?.clientMessageId,
          role: item.role,
          imageUris: item.metadata?.imageUrls || (
            item.metadata?.imageUrl ? [item.metadata.imageUrl] : undefined
          ),
          fileName: item.metadata?.fileName,
          fileMimeType: item.metadata?.fileMimeType,
          fileSize: item.metadata?.fileSize,
          attachments: normalizeGeneratedAttachments(item.metadata),
          text: treeholeDraft || shouldHideImagePlaceholderText(
            item.content,
            item.metadata?.imageUrl || item.metadata?.imageUrls?.[0],
          )
            ? ""
            : item.content,
          treeholeDraft: treeholeDraft || undefined,
          treeholeSaveStatus: treeholeAlreadySaved ? "saved" : undefined,
          diarySaveStatus: diaryAlreadySaved ? "saved" : undefined,
          imageUri: item.metadata?.imageUrl,
          createdAt: item.created_at,
          metadata: item.metadata,
          status: "sent",
        } satisfies Message;
      }),
    );
  };

  const openMessageMenu = (
    text: string,
    messageItem: Message | undefined,
    x: number,
    y: number,
  ) => {
    setMoreMenuVisible(false);
    setMessageMenu({
      text,
      message: messageItem,
      x,
      y,
    });
    setMessageMenuVisible(true);
  };

  const closeMessageMenu = () => {
    setMessageMenuVisible(false);
    setMoreMenuVisible(false);

    setTimeout(() => {
      setMessageMenu(null);
    }, 180);
  };

  const saveImageToSharedAlbum = (
    messageItem: Message,
    imageUri: string,
    imageIndex: number,
  ) => {
    const imageAsset =
      messageItem.imageAssets?.[imageIndex] ||
      (imageIndex === 0 ? messageItem.imageAsset : undefined);

    stageSharedAlbumImport({
      uri: imageUri,
      width: imageAsset?.width,
      height: imageAsset?.height,
    });
    router.push("/album");
  };

  const openImageMenu = (
    messageItem: Message,
    imageUri: string,
    imageIndex: number,
  ) => {
    if (messageItem.status === "sending" || messageItem.status === "failed") {
      return;
    }

    const save = () =>
      saveImageToSharedAlbum(messageItem, imageUri, imageIndex);

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["取消", "保存至共享相册"],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) save();
        },
      );
      return;
    }

    Alert.alert("图片", undefined, [
      { text: "取消", style: "cancel" },
      { text: "保存至共享相册", onPress: save },
    ]);
  };

  const copyMenuText = async () => {
    if (!messageMenu?.text) return;

    await Clipboard.setStringAsync(messageMenu.text);
    closeMessageMenu();
  };

  const openTextSelection = () => {
    if (!messageMenu?.text) return;

    setSelectionText(messageMenu.text);
    closeMessageMenu();
  };

  const showTranslatePlaceholder = () => {
    closeMessageMenu();

    setMessages((prev) => [
      ...prev,
      {
        id: createLocalMessageId(),
        role: "assistant",
        text: "翻译功能我先放在这里，下一步可以接小C来翻译这条消息。",
        status: "sent",
      },
    ]);
  };

  const drawerProgress = useSharedValue(0);

  const dismissKeyboard = () =>
    new Promise<void>((resolve) => {
      if (!keyboardVisibleRef.current) {
        inputRef.current?.blur();
        Keyboard.dismiss();
        resolve();
        return;
      }

      const subscription = Keyboard.addListener("keyboardDidHide", () => {
        clearTimeout(timeout);
        subscription.remove();
        resolve();
      });
      const timeout = setTimeout(() => {
        subscription.remove();
        resolve();
      }, 400);

      inputRef.current?.blur();
      Keyboard.dismiss();
    });

  const openDrawer = async () => {
    await dismissKeyboard();

    drawerProgress.value = 0;

    setDrawerVisible(true);

    requestAnimationFrame(() => {
      drawerProgress.value = withTiming(1, {
        duration: 260,
        reduceMotion: ReduceMotion.Never,
      });
    });
  };

  const closeDrawer = () =>
    new Promise<void>((resolve) => {
      drawerProgress.value = withTiming(
        0,
        {
          duration: 220,
          reduceMotion: ReduceMotion.Never,
        },
        (finished) => {
          if (finished) {
            runOnJS(setDrawerVisible)(false);
            runOnJS(resolve)();
          }
        },
      );
    });

  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";

    const keyboardShowSubscription = Keyboard.addListener(showEvent, () => {
      keyboardVisibleRef.current = true;

      if (drawerVisible) {
        closeDrawer();
      }

      setTimeout(() => {
        scrollToLatestMessage(true);
      }, 80);
    });
    const keyboardHideSubscription = Keyboard.addListener(
      "keyboardDidHide",
      () => {
        keyboardVisibleRef.current = false;
      },
    );

    return () => {
      keyboardShowSubscription.remove();
      keyboardHideSubscription.remove();
    };
  }, [drawerVisible]);

  /*
  const panGesture = Gesture.Pan()
    .onUpdate((event) => {
      const progress = Math.min(
        Math.max(event.translationX / 300, 0),
        1,
      );

      drawerProgress.value = progress;
    })
    .onEnd((event) => {
      if (event.translationX > 120) {
        drawerProgress.value = withSpring(1);
      } else {
        drawerProgress.value = withSpring(0);
      }
    });
  */

  const drawerStyle = useAnimatedStyle(() => {
    return {
      transform: [
        {
          translateX: (1 - drawerProgress.value) * -drawerWidth,
        },
      ],
    };
  });

  const drawerOverlayStyle = useAnimatedStyle(() => {
    return {
      opacity: drawerProgress.value,
    };
  });
  // 正在输入动画

  const pickImage = async () => {
    const permission =
      await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      setMessages((prev) => [
        ...prev,
        {
          id: createLocalMessageId(),
          role: "assistant",
          text: "需要先允许访问相册，才能发图片给小C看。",
          status: "sent",
        },
      ]);
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: MAX_IMAGES_PER_MESSAGE,
      allowsEditing: false,
      quality: 0.8,
      base64: false,
    });

    if (!result.canceled) {
      setSelectedImages(result.assets.slice(0, MAX_IMAGES_PER_MESSAGE));
    }
  };

  const pickFile = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: [
        "text/*",
        "application/json",
        "text/markdown",
        "text/csv",
        "application/xml",
      ],
    });

    if (result.canceled) {
      return;
    }

    const asset = result.assets[0];

    if (!isSupportedTextFile(asset.name, asset.mimeType)) {
      setMessages((prev) => [
        ...prev,
        {
          id: createLocalMessageId(),
          role: "assistant",
          text: "这个文件类型我现在还不能稳定读取。先支持 txt、md、csv、json 这类文本文件；PDF 和 Word 我们下一步再做。",
          status: "sent",
        },
      ]);
      return;
    }

    try {
      const rawText = await FileSystem.readAsStringAsync(asset.uri);
      const truncated = rawText.length > MAX_FILE_CHARS;

      setSelectedFile({
        name: asset.name,
        text: rawText.slice(0, MAX_FILE_CHARS),
        size: asset.size,
        mimeType: asset.mimeType,
        truncated,
      });
    } catch (error) {
      console.log("File read failed:", error);

      setMessages((prev) => [
        ...prev,
        {
          id: createLocalMessageId(),
          role: "assistant",
          text: "这个文件暂时没读出来，可能是编码或权限问题。你可以先换成 txt / md 试试。",
          status: "sent",
        },
      ]);
    }
  };

  const openAttachmentMenu = () => {
    if (Platform.OS === "ios") {
      // Keep this menu small and native-feeling for now.
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["取消", "选择图片", "选择文件"],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) {
            pickImage();
          }

          if (buttonIndex === 2) {
            pickFile();
          }
        },
      );
      return;
    }

    pickFile();
  };

  const openConversationMenu = () => {
    const currentConversationId = conversationIdRef.current;
    if (!currentConversationId) return;

    const openSearch = () => {
      router.push({
        pathname: "/chat-search",
        params: { conversationId: currentConversationId },
      } as never);
    };

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["取消", "搜索聊天记录"],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 1) openSearch();
        },
      );
      return;
    }

    openSearch();
  };

  const restoreConversation = async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoadingHistory(true);

      if (shouldStartNewChat && !silent) {
        const draftConversationId = `chat_${Date.now()}`;
        prependAnchorRef.current = null;
        skipNextMessageAutoScrollRef.current = false;
        scrollOffsetYRef.current = 0;
        contentHeightRef.current = 0;
        setConversationId(draftConversationId);
        conversationIdRef.current = draftConversationId;
        conversationTitleInitializedRef.current = false;
        latestCloudMessageIdRef.current = null;
        setHasOlderHistory(false);
        setMessages([]);
        return;
      }

      const isRestoringLastConversation = !incomingConversationId;
      const id = incomingConversationId || (await getBestLastConversation());

      if (!id) {
        const draftConversationId = `chat_${Date.now()}`;
        setConversationId(draftConversationId);
        conversationIdRef.current = draftConversationId;
        conversationTitleInitializedRef.current = false;
        setHasOlderHistory(false);
        setLoadingHistory(false);
        return;
      }

      setConversationId(id);
      if (conversationIdRef.current !== id) {
        prependAnchorRef.current = null;
        skipNextMessageAutoScrollRef.current = false;
        scrollOffsetYRef.current = 0;
        contentHeightRef.current = 0;
      }
      conversationIdRef.current = id;
      conversationTitleInitializedRef.current = true;

      const data = await apiJson<HistoryItem[]>("/api/history", {
        query: {
          user_id: APP_USER_ID,
          conversation_id: id,
          limit: HISTORY_PAGE_SIZE,
        },
      });

      if (conversationIdRef.current !== id) return;

      if (isRestoringLastConversation && data.length === 0) {
        await clearLastConversation();
        setConversationId(null);
        conversationIdRef.current = null;
        conversationTitleInitializedRef.current = false;
        latestCloudMessageIdRef.current = null;
        setHasOlderHistory(false);
        setMessages([]);
        return;
      }

      const restoredMessages = await restoreHistoryItems(data);

      if (conversationIdRef.current !== id) return;

      const pendingReplyClientId = pendingReplyClientIdRef.current;
      if (
        pendingReplyClientId &&
        data.some(
          (item) =>
            item.role === "assistant" &&
            item.metadata?.replyToClientMessageId === pendingReplyClientId,
        )
      ) {
        pendingReplyClientIdRef.current = null;
        setIsTyping(false);
        setDeliveryNotice(null);
      }

      setMessages((current) =>
        silent
          ? mergeCloudMessages(current, restoredMessages)
          : restoredMessages,
      );
      if (!silent) setHasOlderHistory(data.length === HISTORY_PAGE_SIZE);
      latestCloudMessageIdRef.current = data.length
        ? String(data[data.length - 1].id || "") || null
        : null;
    } catch (error) {
      console.log(error);
    } finally {
      if (!silent) setLoadingHistory(false);
    }
  };

  const loadOlderHistory = async () => {
    const id = conversationIdRef.current;
    const oldestCloudMessage = messages.find(
      (item) => item.cloudId && item.createdAt,
    );

    if (
      !id ||
      !hasOlderHistory ||
      loadingOlderHistory ||
      !oldestCloudMessage?.createdAt
    ) {
      return;
    }

    setLoadingOlderHistory(true);

    try {
      const data = await apiJson<HistoryItem[]>("/api/history", {
        query: {
          user_id: APP_USER_ID,
          conversation_id: id,
          limit: HISTORY_PAGE_SIZE,
          before_created_at: oldestCloudMessage.createdAt,
          before_id: String(oldestCloudMessage.cloudId),
        },
      });

      if (conversationIdRef.current !== id) return;

      const restoredMessages = await restoreHistoryItems(data);

      if (conversationIdRef.current !== id) return;

      if (restoredMessages.length > 0) {
        prependAnchorRef.current = {
          contentHeight: contentHeightRef.current,
          scrollOffsetY: scrollOffsetYRef.current,
        };
        skipNextMessageAutoScrollRef.current = true;
        setMessages((current) => mergeCloudMessages(current, restoredMessages));
      }

      setHasOlderHistory(data.length === HISTORY_PAGE_SIZE);
    } catch (error) {
      console.log("Older chat history load failed:", error);
    } finally {
      setLoadingOlderHistory(false);
    }
  };

  const refreshIfCloudHistoryChanged = async () => {
    const id = conversationIdRef.current;

    if (!id || historyRefreshInFlightRef.current) return;

    historyRefreshInFlightRef.current = true;

    try {
      const latest = await apiJson<HistoryItem[]>("/api/history", {
        query: {
          user_id: APP_USER_ID,
          conversation_id: id,
          limit: 1,
        },
      });
      const latestCloudId = latest[0]?.id ? String(latest[0].id) : null;

      if (latestCloudId && latestCloudId !== latestCloudMessageIdRef.current) {
        await restoreConversation({ silent: true });
      }
    } catch (error) {
      console.log("Chat background refresh failed:", error);
    } finally {
      historyRefreshInFlightRef.current = false;
    }
  };

  useFocusEffect(
    useCallback(() => {
      const routeKey = `${incomingConversationId || "last"}:${shouldStartNewChat ? "new" : "restore"}`;
      const routeChanged = lastRestoreRouteKeyRef.current !== routeKey;
      const isInitialRestore = !hasRestoredConversationRef.current || routeChanged;
      hasRestoredConversationRef.current = true;
      lastRestoreRouteKeyRef.current = routeKey;
      restoreConversation({ silent: !isInitialRestore });

      const appStateSubscription = AppState.addEventListener("change", (state) => {
        if (state === "active") {
          refreshIfCloudHistoryChanged();
        }
      });
      const refreshTimer = setInterval(refreshIfCloudHistoryChanged, 30_000);

      return () => {
        appStateSubscription.remove();
        clearInterval(refreshTimer);
      };
    }, [incomingConversationId, shouldStartNewChat]),
  );

  const submitMessage = async (messageToSend: Message) => {
    const userText =
      messageToSend.text ||
      (messageToSend.fileName
        ? `请读取这个文件：${messageToSend.fileName}`
        : "请看这张图片。");
    const imagesToSend = messageToSend.imageAssets || [];
    const imageUrls = [];
    const imageKinds: ImageKind[] = [];

    for (const imageToSend of imagesToSend) {
      const profile = getImageCompressionProfile(
        imageToSend,
        imagesToSend.length,
      );
      const maxImageSide = profile.maxLongSide;
      const width = imageToSend.width || maxImageSide;
      const height = imageToSend.height || maxImageSide;
      const longestSide = Math.max(width, height);
      const resizeAction =
        longestSide > maxImageSide
          ? [
              {
                resize:
                  width >= height
                    ? { width: maxImageSide }
                    : { height: maxImageSide },
              },
            ]
          : [];

      const compressedImage = await ImageManipulator.manipulateAsync(
        imageToSend.uri,
        resizeAction,
        {
          compress: profile.quality,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        },
      );

      if (compressedImage.base64) {
        imageUrls.push(`data:image/jpeg;base64,${compressedImage.base64}`);
        imageKinds.push(profile.kind);
      }
    }

    const clientMessageId = messageToSend.clientId || messageToSend.id;
    pendingReplyClientIdRef.current = clientMessageId;
    setDeliveryNotice(null);
    setIsTyping(true);

    const slowReplyTimer = setTimeout(() => {
      if (pendingReplyClientIdRef.current === clientMessageId) {
        setDeliveryNotice("这次回复有点慢，我还在等。");
      }
    }, 10_000);

    setTimeout(() => {
      scrollToLatestMessage(true);
    }, 100);

    try {
      const selectedModel = await getSelectedChatModel();

      const data = await postJson<ChatResponse>("/api/chat", {
        user_id: APP_USER_ID,
        message: userText,
        client_message_id: clientMessageId,
        conversation_id: conversationId,
        model: selectedModel.id,
        imageUrl: imageUrls[0],
        imageUrls,
        imageKinds,
        fileName: messageToSend.fileName,
        fileText: messageToSend.fileText,
        fileMimeType: messageToSend.fileMimeType,
        fileSize: messageToSend.fileSize,
      }, {
        timeoutMs: 45000,
      });

      if (data.conversation_id) {
        setConversationId(data.conversation_id);
        conversationIdRef.current = data.conversation_id;

        await saveLastConversation(data.conversation_id);

        if (!conversationTitleInitializedRef.current) {
          await postJson("/api/conversation-title", {
            user_id: APP_USER_ID,
            conversation_id: data.conversation_id,
            message: userText,
          });
          conversationTitleInitializedRef.current = true;
        }
      }

      if (data.processing) {
        setMessages((prev) =>
          reconcileLocalMessageCloudId(
            prev,
            messageToSend.id,
            data.user_message_id,
            { status: "syncing" },
          ),
        );
        setDeliveryNotice("回复还在同步，不用重复发送。");
        [1500, 5000, 15_000].forEach((delay) => {
          setTimeout(refreshIfCloudHistoryChanged, delay);
        });
        return;
      }

      await saveChatUsageFromResponse({
        model: data.model || selectedModel.id,
        usage: data.usage,
      });

      setMessages((prev) =>
        reconcileLocalMessageCloudId(
          prev,
          messageToSend.id,
          data.user_message_id,
          { status: "sent" },
        ),
      );

      pendingReplyClientIdRef.current = null;
      setIsTyping(false);
      setDeliveryNotice(null);

      const treeholeDraft = parseTreeholeDraft(data.reply || "");

      const assistantCloudId = getValidCloudMessageId(data.assistant_message_id);
      if (data.assistant_message_id != null && !assistantCloudId) {
        console.log("CHAT RESPONSE INVALID ASSISTANT MESSAGE ID", {
          type: typeof data.assistant_message_id,
        });
        latestCloudMessageIdRef.current = null;
        return;
      }
      const assistantMessage: Message = {
        id: assistantCloudId || createLocalMessageId(),
        cloudId: assistantCloudId || undefined,
        role: "assistant",
        text: treeholeDraft ? "" : data.reply || "小C暂时没有回复。",
        attachments: data.attachments || [],
        treeholeDraft: treeholeDraft || undefined,
        createdAt: new Date().toISOString(),
        status: "sent",
      };

      setMessages((prev) =>
        assistantCloudId
          ? upsertCloudMessage(prev, assistantMessage)
          : [...prev, assistantMessage],
      );
      latestCloudMessageIdRef.current = assistantCloudId;
    } catch (error) {
      console.log("CHAT ERROR:", error);

      const isTimeout =
        error instanceof Error && error.message === "Request timeout";

      if (isTimeout) {
        setMessages((prev) =>
          prev.map((item) =>
            item.id === messageToSend.id
              ? { ...item, status: "syncing" }
              : item,
          ),
        );
        setDeliveryNotice("连接有点慢，回复可能仍在处理中，不用重复发送。");
        [1500, 5000, 15_000, 30_000].forEach((delay) => {
          setTimeout(refreshIfCloudHistoryChanged, delay);
        });
      } else {
        pendingReplyClientIdRef.current = null;
        setIsTyping(false);
        const responseStatus =
          typeof error === "object" && error && "status" in error
            ? Number(error.status)
            : null;
        setDeliveryNotice(
          responseStatus
            ? "这次回复没有完成，可以稍后重试。"
            : "网络似乎断开了，这条消息还没送达。",
        );
        setMessages((prev) =>
          prev.map((item) =>
            item.id === messageToSend.id
              ? { ...item, status: "failed" }
              : item,
          ),
        );
      }
    } finally {
      clearTimeout(slowReplyTimer);
    }
  };

  const openGeneratedAttachment = async (
    message: Message,
    attachment: GeneratedAttachment,
  ) => {
    const messageId = message.cloudId || message.id;

    try {
      const signed = await postJson<SignedAttachmentResponse>(
        "/api/memory",
        {
          type: "generated_file",
          action: "sign_download",
          user_id: APP_USER_ID,
          conversation_id: conversationIdRef.current,
          message_id: messageId,
          attachment_id: attachment.id,
        },
      );
      const cacheDirectory = `${FileSystem.cacheDirectory || ""}generated-files/`;
      await FileSystem.makeDirectoryAsync(cacheDirectory, { intermediates: true });
      const localUri = `${cacheDirectory}${getSafeDownloadFilename(attachment.name)}`;
      await FileSystem.deleteAsync(localUri, { idempotent: true });
      const downloaded = await FileSystem.downloadAsync(signed.url, localUri);

      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("文件已下载", downloaded.uri);
        return;
      }

      await Sharing.shareAsync(downloaded.uri, {
        mimeType: attachment.mime_type,
        dialogTitle: attachment.name,
      });
    } catch (error) {
      console.log("Generated attachment open failed:", error);
      Alert.alert("暂时打不开文件", "请稍后再试。");
    }
  };

  const sendMessage = async () => {
    if (isSendDisabled) return;

    const localMessageId = createLocalMessageId();
    const newMessage: Message = {
      id: localMessageId,
      clientId: localMessageId,
      role: "user",
      text: message.trim(),
      fileName: selectedFile?.name,
      fileText: selectedFile
        ? `${selectedFile.text}${selectedFile.truncated ? "\n\n[文件内容过长，已截断。]" : ""}`
        : undefined,
      fileSize: selectedFile?.size,
      fileMimeType: selectedFile?.mimeType,
      imageUri: selectedImages[0]?.uri,
      imageUris: selectedImages.map((image) => image.uri),
      imageAsset: selectedImages[0],
      imageAssets: selectedImages,
      createdAt: new Date().toISOString(),
      status: "sending",
    };

    setMessages((prev) => [...prev, newMessage]);

    setTimeout(() => {
      scrollToLatestMessage(true);
    }, 100);

    setMessage("");
    setSelectedImages([]);
    setSelectedFile(null);

    await submitMessage(newMessage);
  };

  const retryMessage = async (messageToRetry: Message) => {
    setMessages((prev) =>
      prev.map((item) =>
        item.id === messageToRetry.id
          ? {
              ...item,
              status: "sending",
            }
          : item,
      ),
    );

    await submitMessage({
      ...messageToRetry,
      status: "sending",
    });
  };

  const saveDiaryFromMessage = async (messageToSave: Message) => {
    const diaryEntry = parseDiaryText(messageToSave.text);

    setMessages((prev) =>
      prev.map((item) =>
        item.id === messageToSave.id
          ? {
              ...item,
              diarySaveStatus: "saving",
            }
          : item,
      ),
    );

    try {
      await postJson("/api/memory", {
        type: "diary",
        user_id: APP_USER_ID,
        ...diaryEntry,
      });

      setMessages((prev) =>
        prev.map((item) =>
          item.id === messageToSave.id
            ? {
                ...item,
                diarySaveStatus: "saved",
              }
            : item,
        ),
      );
    } catch (error) {
      console.log("Diary save failed:", error);

      setMessages((prev) =>
        prev.map((item) =>
          item.id === messageToSave.id
            ? {
                ...item,
                diarySaveStatus: "failed",
              }
            : item,
        ),
      );
    }
  };

  const saveTreeholeFromMessage = async (messageToSave: Message) => {
    if (!messageToSave.treeholeDraft) {
      return;
    }

    setMessages((prev) =>
      prev.map((item) =>
        item.id === messageToSave.id
          ? {
              ...item,
              treeholeSaveStatus: "saving",
            }
          : item,
      ),
    );

    try {
      await saveTreeholeDraft(messageToSave.treeholeDraft);

      setMessages((prev) =>
        prev.map((item) =>
          item.id === messageToSave.id
            ? {
                ...item,
                treeholeSaveStatus: "saved",
              }
            : item,
        ),
      );
    } catch (error) {
      console.log("Treehole save failed:", error);

      setMessages((prev) =>
        prev.map((item) =>
          item.id === messageToSave.id
            ? {
                ...item,
                treeholeSaveStatus: "failed",
              }
            : item,
        ),
      );
    }
  };

  const dismissTreeholeDraft = (messageId: string) => {
    setMessages((prev) =>
      prev.filter((item) => item.id !== messageId),
    );
  };

  const dismissMessage = (messageId: string) => {
    setMessages((prev) =>
      prev.filter((item) => item.id !== messageId),
    );
  };

  const deleteMessage = async (messageToDelete: Message) => {
    setMessages((prev) =>
      prev.filter((item) => item.id !== messageToDelete.id),
    );

    if (!messageToDelete.cloudId) {
      return;
    }

    try {
      await postJson("/api/add-message", {
        action: "delete",
        user_id: APP_USER_ID,
        message_id: messageToDelete.cloudId,
      });
    } catch (error) {
      console.log("Message delete failed:", error);

      setMessages((prev) => [
        ...prev,
        {
          id: createLocalMessageId(),
          role: "assistant",
          text: "这条消息刚刚没能从云端删除，你可以稍后再试一次。",
          status: "sent",
        },
      ]);
    }
  };

  const confirmDeleteMessage = (messageToDelete?: Message) => {
    if (!messageToDelete) {
      return;
    }

    closeMessageMenu();

    Alert.alert(
      "删除这条消息？",
      "删除后会从当前对话历史里移除。",
      [
        {
          text: "取消",
          style: "cancel",
        },
        {
          text: "删除",
          style: "destructive",
          onPress: () => {
            deleteMessage(messageToDelete);
          },
        },
      ],
    );
  };

  const saveFavoriteFromMessage = async (messageToSave?: Message) => {
    if (!messageToSave?.text.trim()) {
      return;
    }

    closeMessageMenu();

    try {
      await saveFavorite({
        text: getDisplayAiText(messageToSave.text),
        role: messageToSave.role,
        conversationId,
      });
    } catch (error) {
      console.log("Favorite save failed:", error);

      setMessages((prev) => [
        ...prev,
        {
          id: createLocalMessageId(),
          role: "assistant",
          text: "这条收藏刚刚没存好，等一下再试一次。",
          status: "sent",
        },
      ]);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={0}
    >
      <View style={styles.container}>
        {drawerVisible && (
          <Animated.View
            style={[styles.drawerOverlayFrame, drawerOverlayStyle]}
          >
            <View style={styles.drawerOverlay} />

            <Pressable
              style={styles.drawerCloseArea}
              onPress={closeDrawer}
            />

            <Animated.View style={[styles.drawerFrame, drawerStyle]}>
              <View style={styles.drawer}>
                <ConversationList
                  currentConversationId={conversationId}
                  onNavigate={closeDrawer}
                  onOpenSharedContext={() => {
                    setSharedContextOpenRequestKey((value) => value + 1);
                  }}
                />
              </View>
            </Animated.View>
          </Animated.View>
        )}

        <View
          style={[
            styles.header,
            {
              height: insets.top + 44,
              paddingTop: insets.top,
            },
          ]}
        >
          <Text style={styles.chatTitle}>小C</Text>

          <Pressable
            style={{
              width: 44,
              height: 44,
              justifyContent: "center",
              alignItems: "center",
            }}
            onPress={openDrawer}
          >
            <Text style={styles.menuText}>☰</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="更多聊天功能"
            hitSlop={8}
            style={styles.headerMoreButton}
            onPress={openConversationMenu}
          >
            <Text style={styles.headerMoreText}>···</Text>
          </Pressable>
        </View>

        <SharedContextBar
          conversationId={conversationId}
          openRequestKey={sharedContextOpenRequestKey}
        />

        <ScrollView
          ref={scrollRef}
          style={styles.chat}
          contentContainerStyle={[
            styles.chatContent,
            messages.length === 0 && styles.empty,
          ]}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            hasOlderHistory ? (
              <RefreshControl
                refreshing={loadingOlderHistory}
                onRefresh={loadOlderHistory}
                tintColor="#A6A6AA"
              />
            ) : undefined
          }
          onScroll={(event) => {
            scrollOffsetYRef.current = event.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
          onContentSizeChange={(_width, height) => {
            const anchor = prependAnchorRef.current;
            contentHeightRef.current = height;

            if (anchor) {
              prependAnchorRef.current = null;
              scrollRef.current?.scrollTo({
                y: getPrependAnchoredOffset(anchor, height),
                animated: false,
              });
            }
          }}
        >
          {loadingHistory ? (
            <TypingDots />
          ) : (
            messages.length === 0 && (
              <View style={styles.greetingBox}>
                <Text style={styles.greetingPrimary}>Be right here</Text>
                <Text style={styles.greetingSecondary}>Take your time</Text>
              </View>
            )
          )}

          {messages.map((item, index) => {
            const stableMessageId = getStableMessageId(item);

            return (
              <Fragment key={stableMessageId}>
                {shouldShowMessageTime(item, messages[index - 1]) && (
                  <Text style={styles.messageTime}>
                    {formatMessageTime(item.createdAt || "")}
                  </Text>
                )}

              {item.role === "user" ? (
              <AnimatedMessage>
                <View
                  style={[
                    styles.userRow,
                    shouldShowMessageTime(item, messages[index - 1])
                      ? styles.messageAfterTime
                      : index > 0 && messages[index - 1].role === item.role
                      ? styles.messageFromSameSender
                      : styles.messageFromNewSender,
                  ]}
                >
                  {(item.imageUris?.length || item.imageUri) && (
                    <View style={styles.messageImageWrap}>
                      <View
                        style={[
                          styles.messageImageGrid,
                          (item.imageUris || [item.imageUri]).length > 1 &&
                            styles.messageImageGridMultiple,
                        ]}
                      >
                        {(item.imageUris || [item.imageUri]).map(
                          (imageUri, imageIndex) =>
                            imageUri && (
                              <Pressable
                                key={`${stableMessageId}_${imageIndex}`}
                                onPress={() =>
                                  item.status !== "sending" &&
                                  setPreviewImageUri(imageUri)
                                }
                                onLongPress={() =>
                                  openImageMenu(item, imageUri, imageIndex)
                                }
                              >
                                <ChatMessageImage
                                  uri={imageUri}
                                  multiple={
                                    (item.imageUris || [item.imageUri]).length >
                                    1
                                  }
                                  subdued={
                                    item.status === "sending" ||
                                    item.status === "failed"
                                  }
                                />
                              </Pressable>
                            ),
                        )}
                      </View>

                      {item.status === "sending" && (
                        <View style={styles.imageSendingOverlay}>
                          <TypingDots compact />
                        </View>
                      )}

                      {item.status === "failed" && (
                        <Pressable
                          style={styles.imageRetryOverlay}
                          onPress={() => retryMessage(item)}
                        >
                          <View style={styles.retryButton}>
                            <Text style={styles.retryText}>↻</Text>
                          </View>
                        </Pressable>
                      )}
                    </View>
                  )}

                  {!!item.fileName && (
                    <View style={styles.messageFileCard}>
                      <Text style={styles.messageFileIcon}>📄</Text>
                      <View style={styles.messageFileTextBox}>
                        <Text style={styles.messageFileName} numberOfLines={1}>
                          {item.fileName}
                        </Text>
                        <Text style={styles.messageFileMeta}>
                          {item.status === "sending"
                            ? "正在发送"
                            : item.status === "failed"
                              ? "发送失败"
                              : "已发送"}
                        </Text>
                      </View>
                    </View>
                  )}

                  {!!item.text && getUserBubbleSegments(item.text).map((segment, segmentIndex) => (
                    <Pressable
                      key={`${stableMessageId}_user_segment_${segmentIndex}`}
                      style={[
                        styles.userBubble,
                        segmentIndex > 0 && styles.userBubbleSegment,
                      ]}
                      onLongPress={(event) =>
                        openMessageMenu(
                          segment,
                          item,
                          event.nativeEvent.pageX,
                          event.nativeEvent.pageY,
                        )
                      }
                    >
                      <Text style={styles.userText}>{segment}</Text>
                    </Pressable>
                  ))}

                  {!item.imageUri &&
                    !item.imageUris?.length &&
                    item.status === "failed" && (
                    <Pressable
                      style={styles.textRetryButton}
                      onPress={() => retryMessage(item)}
                    >
                      <Text style={styles.retryText}>↻</Text>
                    </Pressable>
                  )}
                </View>
              </AnimatedMessage>
	            ) : (
	              <AnimatedMessage>
	                <View
	                  style={[
	                    styles.aiWrap,
	                    hasBlockMarkdown(item.text) && styles.aiWrapStructured,
	                    shouldShowMessageTime(item, messages[index - 1])
	                      ? styles.messageAfterTime
	                      : index > 0 && messages[index - 1].role === item.role
	                      ? styles.messageFromSameSender
	                      : styles.messageFromNewSender,
	                  ]}
	                >
	                  {item.treeholeDraft ? (
	                    <TreeholeDraftCard
	                      draft={item.treeholeDraft}
	                      saveStatus={item.treeholeSaveStatus}
	                      onSave={() => saveTreeholeFromMessage(item)}
	                      onDismiss={() => dismissTreeholeDraft(item.id)}
	                    />
	                  ) : isDiaryText(item.text) ? (
	                    <DiaryPreviewCard
	                      entry={parseDiaryText(item.text)}
	                      saveStatus={item.diarySaveStatus}
	                      onSave={() => saveDiaryFromMessage(item)}
	                      onDismiss={() => dismissMessage(item.id)}
	                    />
	                  ) : (
	                    <>
	                      {!!item.attachments?.length && (
	                        <View style={styles.generatedAttachmentList}>
	                          {item.attachments.map((attachment) => (
	                            <Pressable
	                              key={attachment.id}
	                              style={({ pressed }) => [
	                                styles.generatedAttachmentCard,
	                                pressed && styles.generatedAttachmentCardPressed,
	                              ]}
	                              onPress={() => openGeneratedAttachment(item, attachment)}
	                            >
	                              <View style={styles.generatedAttachmentIcon}>
	                                <Text style={styles.generatedAttachmentIconText}>↧</Text>
	                              </View>
	                              <View style={styles.generatedAttachmentText}>
	                                <Text style={styles.generatedAttachmentName} numberOfLines={1}>
	                                  {attachment.name}
	                                </Text>
	                                <Text style={styles.generatedAttachmentMeta}>
	                                  {getAttachmentTypeLabel(attachment.mime_type)} · {formatAttachmentSize(attachment.size)}
	                                </Text>
	                              </View>
	                            </Pressable>
	                          ))}
	                        </View>
	                      )}
	                      {hasBlockMarkdown(item.text) ? (
	                    <MessageMarkdown
	                      text={item.text}
	                      onLongPress={(event) =>
	                        openMessageMenu(
	                          item.text,
	                          item,
	                          event.nativeEvent.pageX,
	                          event.nativeEvent.pageY,
	                        )
	                      }
	                    />
	                      ) : (
	                    getChatBubbleSegments(item.text).map((segment, segmentIndex) => (
	                      <Pressable
	                        key={`${stableMessageId}_segment_${segmentIndex}`}
	                        style={[
	                          styles.aiBox,
	                          segmentIndex > 0 && styles.aiBoxSegment,
	                        ]}
	                        onLongPress={(event) =>
	                          openMessageMenu(
	                            segment,
	                            item,
	                            event.nativeEvent.pageX,
	                            event.nativeEvent.pageY,
	                          )
	                        }
	                      >
	                        <Text style={styles.aiText}>
	                          <InlineMarkdown text={segment} />
	                        </Text>
	                      </Pressable>
	                    ))
	                      )}
	                    </>
	                  )}
                </View>
              </AnimatedMessage>
            )}
              </Fragment>
            );
          })}

          {isTyping && <TypingDots />}
        </ScrollView>

        {!!deliveryNotice && (
          <Text style={styles.deliveryNotice}>{deliveryNotice}</Text>
        )}

        <View
          style={[
            styles.inputArea,
            { paddingBottom: Math.max(insets.bottom, 10) },
          ]}
        >
          {selectedImages.length > 0 && (
            <View style={styles.attachmentPreviewList}>
              {selectedImages.map((selectedImage, index) => (
                <View
                  key={`${selectedImage.uri}_${index}`}
                  style={styles.attachmentPreview}
                >
                  <Pressable
                    onPress={() => setPreviewImageUri(selectedImage.uri)}
                  >
                    <Image
                      source={{ uri: selectedImage.uri }}
                      style={styles.attachmentImage}
                    />
                  </Pressable>

                  <Pressable
                    style={styles.removeAttachment}
                    onPress={() =>
                      setSelectedImages((prev) =>
                        prev.filter((_, imageIndex) => imageIndex !== index),
                      )
                    }
                  >
                    <Text style={styles.removeAttachmentText}>×</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          {selectedFile && (
            <View style={styles.selectedFileCard}>
              <Text style={styles.selectedFileIcon}>📄</Text>
              <View style={styles.selectedFileTextBox}>
                <Text style={styles.selectedFileName} numberOfLines={1}>
                  {selectedFile.name}
                </Text>
                <Text style={styles.selectedFileMeta}>
                  {selectedFile.truncated ? "文本较长，将截断发送" : "准备发送"}
                </Text>
              </View>

              <Pressable
                style={styles.removeFileButton}
                onPress={() => setSelectedFile(null)}
              >
                <Text style={styles.removeAttachmentText}>×</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.inputControls}>
            <Pressable style={styles.attachButton} onPress={openAttachmentMenu}>
              <Text style={styles.attachText}>＋</Text>
            </Pressable>

            <View style={styles.inputBox}>
              <TextInput
                ref={inputRef}
                style={styles.input}
                placeholder="和小C说点什么..."
                placeholderTextColor={XiaoCColors.placeholder}
                value={message}
                onChangeText={setMessage}
                onFocus={() => {
                  if (drawerVisible) {
                    closeDrawer();
                  }

                  setTimeout(() => {
                    scrollToLatestMessage(true);
                  }, 120);
                }}
                multiline
              />

              <RNAnimated.View
                pointerEvents={canSendMessage ? "auto" : "none"}
                style={[
                  styles.sendButtonSlot,
                  {
                    opacity: sendButtonProgress,
                    transform: [
                      {
                        scale: sendButtonProgress.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0.78, 1],
                        }),
                      },
                    ],
                  },
                ]}
              >
                <Pressable
                  style={[
                    styles.sendButton,
                    isTyping && styles.sendDisabled,
                  ]}
                  onPress={sendMessage}
                  disabled={isSendDisabled}
                >
                  <Text style={styles.sendText}>↑</Text>
                </Pressable>
              </RNAnimated.View>
            </View>
          </View>
        </View>

        <Modal
          visible={!!previewImageUri}
          transparent
          animationType="fade"
          onRequestClose={() => setPreviewImageUri(null)}
        >
          <Pressable
            style={styles.imagePreviewOverlay}
            onPress={() => setPreviewImageUri(null)}
          >
            {previewImageUri && (
              <Image
                source={{ uri: previewImageUri }}
                style={styles.imagePreview}
                resizeMode="contain"
              />
            )}

            <Pressable
              style={styles.imagePreviewClose}
              onPress={() => setPreviewImageUri(null)}
            >
              <Text style={styles.imagePreviewCloseText}>×</Text>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal
          visible={messageMenuVisible}
          transparent
          animationType="fade"
          onRequestClose={closeMessageMenu}
        >
          <View style={styles.messageMenuOverlay}>
            <Pressable
              style={styles.messageMenuBackdrop}
              onPress={closeMessageMenu}
            />

            <View
              style={[
                styles.messageMenuCard,
                messageMenu && {
                  left: Math.min(
                    Math.max(messageMenu.x - 84, 18),
                    Dimensions.get("window").width - 186,
                  ),
                  top: Math.min(
                    Math.max(messageMenu.y - 18, 70),
                    Dimensions.get("window").height - 230,
                  ),
                },
              ]}
            >
              {moreMenuVisible ? (
                <>
                  <Pressable
                    style={({ pressed }) => [
                      styles.messageMenuItem,
                      pressed && styles.messageMenuItemPressed,
                    ]}
                    onPress={() => saveFavoriteFromMessage(messageMenu?.message)}
                  >
                    <Text style={styles.messageMenuText}>收藏</Text>
                  </Pressable>

                  <Pressable
                    style={({ pressed }) => [
                      styles.messageMenuItem,
                      pressed && styles.messageMenuItemPressed,
                    ]}
                    onPress={() => confirmDeleteMessage(messageMenu?.message)}
                  >
                    <Text style={[styles.messageMenuText, styles.deleteMenuText]}>
                      删除消息
                    </Text>
                  </Pressable>

                  <Pressable
                    style={({ pressed }) => [
                      styles.messageMenuItem,
                      pressed && styles.messageMenuItemPressed,
                    ]}
                    onPress={() => setMoreMenuVisible(false)}
                  >
                    <Text style={styles.messageMenuText}>返回</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Pressable
                    style={({ pressed }) => [
                      styles.messageMenuItem,
                      pressed && styles.messageMenuItemPressed,
                    ]}
                    onPress={copyMenuText}
                  >
                    <Text style={styles.messageMenuText}>拷贝</Text>
                  </Pressable>

                  <Pressable
                    style={({ pressed }) => [
                      styles.messageMenuItem,
                      pressed && styles.messageMenuItemPressed,
                    ]}
                    onPress={openTextSelection}
                  >
                    <Text style={styles.messageMenuText}>选择</Text>
                  </Pressable>

                  <Pressable
                    style={({ pressed }) => [
                      styles.messageMenuItem,
                      pressed && styles.messageMenuItemPressed,
                    ]}
                    onPress={showTranslatePlaceholder}
                  >
                    <Text style={styles.messageMenuText}>翻译</Text>
                  </Pressable>

                  <Pressable
                    style={({ pressed }) => [
                      styles.messageMenuItem,
                      pressed && styles.messageMenuItemPressed,
                    ]}
                    onPress={() => setMoreMenuVisible(true)}
                  >
                    <Text style={styles.messageMenuText}>更多…</Text>
                  </Pressable>
                </>
              )}
            </View>
          </View>
        </Modal>

        <Modal
          visible={!!selectionText}
          transparent
          animationType="fade"
          onRequestClose={() => setSelectionText(null)}
        >
          <View style={styles.textSelectionOverlay}>
            <Pressable
              style={styles.textSelectionBackdrop}
              onPress={() => setSelectionText(null)}
            />

            <View style={styles.textSelectionSheet}>
              <View style={styles.textSelectionHandle} />
              <ScrollView style={styles.textSelectionScroll}>
                <TextInput
                  style={styles.textSelectionInput}
                  value={selectionText || ""}
                  editable={false}
                  multiline
                  scrollEnabled={false}
                />
              </ScrollView>
            </View>
          </View>
        </Modal>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  menuButton: {
    width: 44,

    height: 44,

    justifyContent: "center",

    alignItems: "center",
  },
  drawerCloseArea: {
    position: "absolute",

    top: 0,
    right: 0,
    bottom: 0,

    width: "18%",
  },
  drawerOverlayFrame: {
    position: "absolute",

    top: 0,
    left: 0,
    right: 0,
    bottom: 0,

    zIndex: 100,
  },

  drawerOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: XiaoCColors.overlay,
  },

  drawerFrame: {
    width: "82%",

    height: "100%",

    shadowColor: "#000",
    shadowOpacity: 0.24,
    shadowRadius: 28,

    shadowOffset: {
      width: 8,
      height: 0,
    },

    elevation: 8,
  },

  drawer: {
    flex: 1,
    backgroundColor: XiaoCColors.sidebarMaterial,
    borderTopRightRadius: 28,
    borderBottomRightRadius: 28,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: XiaoCColors.sidebarSeparator,
    overflow: "hidden",
  },

  container: {
    flex: 1,
    backgroundColor: XiaoCColors.background,
  },

  header: {
    paddingLeft: 28,

    justifyContent: "center",

    backgroundColor: XiaoCColors.navigationBackground,

    borderBottomWidth: StyleSheet.hairlineWidth,

    borderBottomColor: XiaoCColors.separator,
  },

  chatTitle: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 11,
    textAlign: "center",
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    color: XiaoCColors.textPrimary,
  },

  menuText: {
    fontSize: 26,
    color: XiaoCColors.icon,
  },

  headerMoreButton: {
    position: "absolute",
    right: 12,
    bottom: 0,
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },

  headerMoreText: {
    marginTop: -7,
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 1,
    color: XiaoCColors.icon,
  },

  chat: {
    flex: 1,
    backgroundColor: XiaoCColors.background,
  },

  chatContent: {
    paddingHorizontal: 20,

    paddingTop: 16,

    paddingBottom: 24,
  },

  empty: {
    flexGrow: 1,
    justifyContent: "center",
    paddingBottom: 80,
  },

  greetingBox: {
    alignItems: "center",
  },

  greetingPrimary: {
    fontSize: 26,
    color: "#6A6A6A",
    fontWeight: "400",
    letterSpacing: 0.4,
  },

  greetingSecondary: {
    marginTop: 12,
    fontSize: 16,
    color: "#A8A8A8",
    fontWeight: "400",
  },

  messageTime: {
    alignSelf: "center",
    marginTop: 13,
    marginBottom: 9,
    color: XiaoCColors.textSecondary,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "400",
  },

  userRow: {
    alignItems: "flex-end",
    marginBottom: 2,
  },

  userBubble: {
    maxWidth: "78%",
    minHeight: 42,
    flexShrink: 1,
    justifyContent: "center",
    backgroundColor: XiaoCColors.userBubble,
    borderRadius: 20,
    paddingHorizontal: 17,
    paddingVertical: 9,
    overflow: "visible",
  },

  userBubbleSegment: {
    marginTop: 4,
  },

  userText: {
    fontSize: 17,
    color: "#FFFFFF",
    lineHeight: 23,
    flexShrink: 1,
    includeFontPadding: false,
  },
  aiBox: {
    maxWidth: "100%",
    minHeight: 42,
    flexShrink: 1,
    alignSelf: "flex-start",
    justifyContent: "center",
    backgroundColor: XiaoCColors.assistantBubble,
    borderRadius: 24,
    paddingHorizontal: 17,
    paddingVertical: 9,
    overflow: "visible",
  },

  aiBoxSegment: {
    marginTop: 4,
  },

  aiWrap: {
    alignSelf: "flex-start",
    maxWidth: "80%",
    flexShrink: 1,
    marginBottom: 2,
    overflow: "visible",
  },

  aiWrapStructured: {
    width: "94%",
    maxWidth: "94%",
  },

  messageFromSameSender: {
    marginTop: 4,
  },

  messageAfterTime: {
    marginTop: 0,
  },

  messageFromNewSender: {
    marginTop: 14,
  },

  aiText: {
    fontSize: 17,
    color: XiaoCColors.textPrimary,
    lineHeight: 25,
    flexShrink: 1,
    includeFontPadding: false,
  },

  treeholeDraftCard: {
    width: 285,
    backgroundColor: "#191927",
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 14,
    shadowColor: "#10101A",
    shadowOpacity: 0.16,
    shadowRadius: 20,
    shadowOffset: {
      width: 0,
      height: 10,
    },
  },

  treeholeDraftHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },

  treeholeDraftLabel: {
    fontSize: 12,
    color: "#AAA4B8",
    letterSpacing: 1.6,
  },

  treeholeDraftDate: {
    fontSize: 12,
    color: "#817B91",
  },

  treeholeDraftTag: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.08)",
    color: "#CEC8DC",
    fontSize: 13,
    marginBottom: 14,
  },

  treeholeDraftContent: {
    gap: 8,
  },

  treeholeDraftLine: {
    fontSize: 16,
    lineHeight: 25,
    color: "#ECE9F4",
  },

  treeholeDraftHighlight: {
    color: "#AFA8FF",
  },

  treeholeDraftReaction: {
    marginTop: 16,
    fontSize: 13,
    color: "#9E98AA",
  },

  treeholeDraftActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 14,
  },

  treeholeDraftButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: "#ECE9F4",
  },

  treeholeDraftButtonSaved: {
    backgroundColor: "rgba(236,233,244,0.52)",
  },

  treeholeDraftGhostButton: {
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
  },

  treeholeDraftButtonPressed: {
    opacity: 0.72,
  },

  treeholeDraftButtonText: {
    fontSize: 13,
    color: "#201F2A",
  },

  treeholeDraftGhostText: {
    fontSize: 13,
    color: "#C8C1D7",
  },

  diaryPreviewCard: {
    width: 292,
    borderRadius: 26,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 16,
    backgroundColor: "#FBF8F3",
    shadowColor: "#B8AFA7",
    shadowOpacity: 0.13,
    shadowRadius: 22,
    shadowOffset: {
      width: 0,
      height: 12,
    },
  },

  diaryPreviewLabel: {
    textAlign: "center",
    fontSize: 11,
    color: "#AAA098",
    letterSpacing: 2.6,
    marginBottom: 12,
  },

  diaryPreviewTitle: {
    textAlign: "center",
    fontSize: 23,
    lineHeight: 31,
    color: "#33302D",
    marginBottom: 8,
  },

  diaryPreviewDate: {
    textAlign: "center",
    fontSize: 15,
    color: "#A69D96",
  },

  diaryPreviewDivider: {
    height: 1,
    backgroundColor: "rgba(166,157,150,0.20)",
    marginVertical: 18,
  },

  diaryPreviewSection: {
    marginBottom: 16,
  },

  diaryPreviewTag: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: "rgba(166,157,150,0.12)",
    color: "#9D938B",
    fontSize: 13,
    marginBottom: 10,
  },

  diaryPreviewText: {
    fontSize: 16,
    lineHeight: 27,
    color: "#3F3A37",
    marginBottom: 7,
  },

  diaryPreviewMore: {
    textAlign: "center",
    fontSize: 16,
    color: "#C5BDB5",
    marginBottom: 14,
  },

  diaryPreviewActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 2,
  },

  diaryPreviewButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "#EFEAE3",
  },

  diaryPreviewButtonSaved: {
    backgroundColor: "rgba(239,234,227,0.58)",
  },

  diaryPreviewGhostButton: {
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: "rgba(166,157,150,0.10)",
  },

  diaryPreviewButtonPressed: {
    opacity: 0.72,
  },

  diaryPreviewButtonText: {
    fontSize: 13,
    color: "#4C4641",
  },

  diaryPreviewGhostText: {
    fontSize: 13,
    color: "#8F857D",
  },

  messageMenuOverlay: {
    flex: 1,
  },

  messageMenuBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.16)",
  },

  messageMenuCard: {
    position: "absolute",
    minWidth: 168,
    borderRadius: 22,
    paddingVertical: 8,
    backgroundColor: "rgba(255,255,255,0.96)",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 24,
    shadowOffset: {
      width: 0,
      height: 12,
    },
    elevation: 12,
  },

  messageMenuItem: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 14,
    marginHorizontal: 6,
  },

  messageMenuItemPressed: {
    backgroundColor: "rgba(120,120,128,0.10)",
  },

  messageMenuText: {
    fontSize: 18,
    color: "#111",
  },

  deleteMenuText: {
    color: "#D92D20",
  },

  textSelectionOverlay: {
    flex: 1,
    justifyContent: "flex-end",
  },

  textSelectionBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.14)",
  },

  textSelectionSheet: {
    height: 250,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 10,
    paddingHorizontal: 22,
    paddingBottom: 24,
    backgroundColor: "rgba(255,255,255,0.98)",
  },

  textSelectionHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 14,
    backgroundColor: "rgba(120,120,128,0.22)",
  },

  textSelectionScroll: {
    flex: 1,
  },

  textSelectionInput: {
    fontSize: 17,
    lineHeight: 27,
    color: "#333",
    padding: 0,
    margin: 0,
    backgroundColor: "transparent",
  },

  diarySaveButton: {
    alignSelf: "flex-start",
    marginTop: 7,
    marginLeft: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: "rgba(120,120,128,0.08)",
  },

  diarySaveButtonPressed: {
    backgroundColor: "rgba(120,120,128,0.14)",
  },

  diarySaveButtonSaved: {
    backgroundColor: "rgba(180,165,140,0.16)",
  },

  diarySaveText: {
    fontSize: 13,
    color: "#7A6E63",
  },

  typingDots: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 25,
    height: 20,
  },

  typingDotsCompact: {
    marginBottom: 0,
  },

  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#D0D0D0",
    marginRight: 6,
  },

  deliveryNotice: {
    paddingHorizontal: 28,
    paddingTop: 6,
    paddingBottom: 2,
    fontSize: 12,
    lineHeight: 17,
    color: "#8F8A85",
    backgroundColor: XiaoCColors.composerBackground,
  },

  inputArea: {
    paddingHorizontal: 28,
    paddingTop: 10,
    backgroundColor: XiaoCColors.composerBackground,
  },

  attachmentPreview: {
    alignSelf: "flex-start",
    marginBottom: 10,
    marginRight: 10,
  },

  attachmentPreviewList: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    marginBottom: 2,
  },

  attachmentImage: {
    width: 92,
    height: 92,
    borderRadius: 16,
    backgroundColor: "#F0F0F0",
  },

  removeAttachment: {
    position: "absolute",
    top: -8,
    right: -8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(40,40,40,0.72)",
    alignItems: "center",
    justifyContent: "center",
  },

  removeAttachmentText: {
    color: "#FFFFFF",
    fontSize: 18,
    lineHeight: 20,
  },

  selectedFileCard: {
    alignSelf: "flex-start",
    maxWidth: "86%",
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
    backgroundColor: "rgba(245,245,247,0.96)",
  },

  selectedFileIcon: {
    fontSize: 22,
    marginRight: 9,
  },

  selectedFileTextBox: {
    flex: 1,
  },

  selectedFileName: {
    fontSize: 14,
    color: "#444",
  },

  selectedFileMeta: {
    marginTop: 2,
    fontSize: 12,
    color: "#999",
  },

  removeFileButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    marginLeft: 10,
    backgroundColor: "rgba(40,40,40,0.72)",
    alignItems: "center",
    justifyContent: "center",
  },

  inputControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },

  attachButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: XiaoCColors.inputSurface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: XiaoCColors.inputBorder,
  },

  attachText: {
    color: XiaoCColors.icon,
    fontSize: 28,
    lineHeight: 30,
    marginTop: -2,
  },

  inputBox: {
    flex: 1,
    minHeight: 44,
    borderRadius: 22,
    backgroundColor: XiaoCColors.inputSurface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: XiaoCColors.inputBorder,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 14,
    paddingRight: 3,
  },

  input: {
    flex: 1,
    fontSize: 17,
    lineHeight: 22,
    color: XiaoCColors.textPrimary,
    paddingTop: 6,
    paddingBottom: 6,
    maxHeight: 100,
  },

  sendButtonSlot: {
    width: 36,
    height: 36,
  },

  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: XiaoCColors.userBubble,
    alignItems: "center",
    justifyContent: "center",
  },

  sendDisabled: {
    opacity: 0.45,
  },

  sendText: {
    color: "#FFFFFF",
    fontSize: 24,
    marginTop: -3,
  },

  messageImage: {
    width: 240,
    borderRadius: 18,
    marginBottom: 8,
    backgroundColor: "#F2F2F4",
  },

  messageImageGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    maxWidth: 240,
  },

  messageImageGridMultiple: {
    maxWidth: 190,
  },

  messageImageGridItem: {
    width: 88,
    height: 88,
    marginLeft: 6,
    marginBottom: 6,
    borderRadius: 14,
  },

  messageImageWrap: {
    position: "relative",
  },

  messageFileCard: {
    maxWidth: "80%",
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
    backgroundColor: "rgba(220,240,255,0.75)",
    borderColor: "#D5E9FF",
    borderWidth: 1,
  },

  messageFileIcon: {
    fontSize: 22,
    marginRight: 9,
  },

  messageFileTextBox: {
    flexShrink: 1,
  },

  messageFileName: {
    fontSize: 14,
    color: "#4B5563",
  },

  messageFileMeta: {
    marginTop: 2,
    fontSize: 12,
    color: "#7A8794",
  },

  generatedAttachmentList: {
    gap: 8,
    marginBottom: 8,
  },

  generatedAttachmentCard: {
    minWidth: 238,
    maxWidth: 310,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 13,
    paddingVertical: 11,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(110,99,170,0.20)",
    backgroundColor: "rgba(246,244,255,0.94)",
  },

  generatedAttachmentCardPressed: {
    opacity: 0.72,
  },

  generatedAttachmentIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(112,94,190,0.12)",
  },

  generatedAttachmentIconText: {
    color: XiaoCColors.userBubble,
    fontSize: 20,
    fontWeight: "600",
  },

  generatedAttachmentText: {
    flex: 1,
    marginLeft: 11,
  },

  generatedAttachmentName: {
    color: XiaoCColors.textPrimary,
    fontSize: 15,
    fontWeight: "600",
  },

  generatedAttachmentMeta: {
    marginTop: 3,
    color: XiaoCColors.textSecondary,
    fontSize: 12,
  },

  messageImageSending: {
    opacity: 0.45,
  },

  imageSendingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 8,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.18)",
  },

  imageRetryOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 8,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.18)",
  },

  retryButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(40,40,40,0.72)",
    alignItems: "center",
    justifyContent: "center",
  },

  textRetryButton: {
    marginTop: -8,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(40,40,40,0.72)",
    alignItems: "center",
    justifyContent: "center",
  },

  retryText: {
    color: "#FFFFFF",
    fontSize: 22,
    lineHeight: 24,
    marginTop: -1,
  },

  imagePreviewOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center",
    justifyContent: "center",
  },

  imagePreview: {
    width: "100%",
    height: "88%",
  },

  imagePreviewClose: {
    position: "absolute",
    top: 58,
    right: 24,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },

  imagePreviewCloseText: {
    color: "#FFFFFF",
    fontSize: 28,
    lineHeight: 30,
  },
});
