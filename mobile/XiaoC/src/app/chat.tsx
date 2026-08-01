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
} from "react-native";

import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  ReduceMotion,
} from "react-native-reanimated";

import { useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";

import { useState, useRef, useEffect } from "react";

import ConversationList from "../components/ConversationList";
import { APP_USER_ID, apiJson, postJson } from "../config/api";
import {
  clearLastConversation,
  getBestLastConversation,
  saveLastConversation,
} from "../lib/conversationState";
import { isDiaryText, parseDiaryText } from "../data/observationDiary";

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  imageUri?: string;
  imageUris?: string[];
  imageAsset?: ImagePicker.ImagePickerAsset;
  imageAssets?: ImagePicker.ImagePickerAsset[];
  status?: "sending" | "sent" | "failed";
  diarySaveStatus?: "idle" | "saving" | "saved" | "failed";
};

type HistoryItem = {
  role: "user" | "assistant";
  content: string;
  metadata?: {
    imageUrl?: string;
    imageUrls?: string[];
  };
};

type ChatResponse = {
  reply?: string;
  conversation_id?: string;
};

const MAX_IMAGES_PER_MESSAGE = 4;

const createLocalMessageId = () =>
  `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const IMAGE_PLACEHOLDER_TEXTS = new Set([
  "（图片）",
  "请看这张图片。",
  "请看这张照片。",
]);

const shouldHideImagePlaceholderText = (content: string, imageUrl?: string) =>
  !!imageUrl && IMAGE_PLACEHOLDER_TEXTS.has(content.trim());

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
export default function ChatScreen() {
  const params = useLocalSearchParams();

  const drawerWidth = Dimensions.get("window").width * 0.76;

  const incomingConversationId = params.conversationId as string | undefined;
  const shouldStartNewChat = params.newChat === "1";

  useEffect(() => {
    restoreConversation();
  }, [incomingConversationId, shouldStartNewChat]);

  const [message, setMessage] = useState("");

  const [selectedImages, setSelectedImages] = useState<
    ImagePicker.ImagePickerAsset[]
  >([]);

  const [previewImageUri, setPreviewImageUri] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);

  const [isTyping, setIsTyping] = useState(false);

  const [loadingHistory, setLoadingHistory] = useState(true);

  const scrollRef = useRef<ScrollView>(null);

  const [conversationId, setConversationId] = useState<string | null>(null);

  const [drawerVisible, setDrawerVisible] = useState(false);

  const canSendMessage = message.trim().length > 0 || selectedImages.length > 0;
  const isSendDisabled = !canSendMessage || isTyping;

  const scrollToLatestMessage = (animated = true) => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({
        animated,
      });
    });
  };

  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";

    const keyboardShowSubscription = Keyboard.addListener(showEvent, () => {
      setTimeout(() => {
        scrollToLatestMessage(true);
      }, 80);
    });

    return () => {
      keyboardShowSubscription.remove();
    };
  }, []);

  const drawerProgress = useSharedValue(0);

  const openDrawer = () => {
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

  const restoreConversation = async () => {
    try {
      setLoadingHistory(true);

      if (shouldStartNewChat) {
        setConversationId(null);
        setMessages([]);
        setLoadingHistory(false);
        return;
      }

      const isRestoringLastConversation = !incomingConversationId;
      const id = incomingConversationId || (await getBestLastConversation());

      if (!id) {
        setLoadingHistory(false);
        return;
      }

      setConversationId(id);

      const data = await apiJson<HistoryItem[]>("/api/history", {
        query: {
          user_id: APP_USER_ID,
          conversation_id: id,
        },
      });

      if (isRestoringLastConversation && data.length === 0) {
        await clearLastConversation();
        setConversationId(null);
        setMessages([]);
        return;
      }

      setMessages(
        data.map((item) => ({
          id: createLocalMessageId(),
          role: item.role,
          imageUris: item.metadata?.imageUrls || (
            item.metadata?.imageUrl ? [item.metadata.imageUrl] : undefined
          ),
          text: shouldHideImagePlaceholderText(
            item.content,
            item.metadata?.imageUrl || item.metadata?.imageUrls?.[0],
          )
            ? ""
            : item.content,
          imageUri: item.metadata?.imageUrl,
          status: "sent",
        })),
      );
    } catch (error) {
      console.log(error);
    } finally {
      setLoadingHistory(false);
    }
  };

  const submitMessage = async (messageToSend: Message) => {
    const userText = messageToSend.text || "请看这张图片。";
    const imagesToSend = messageToSend.imageAssets || [];
    const imageUrls = [];

    for (const imageToSend of imagesToSend) {
      const maxImageSide = imagesToSend.length > 1 ? 768 : 1024;
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
          compress: imagesToSend.length > 1 ? 0.58 : 0.65,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        },
      );

      if (compressedImage.base64) {
        imageUrls.push(`data:image/jpeg;base64,${compressedImage.base64}`);
      }
    }

    setIsTyping(true);

    setTimeout(() => {
      scrollToLatestMessage(true);
    }, 100);

    try {
      const data = await postJson<ChatResponse>("/api/chat", {
        user_id: APP_USER_ID,
        message: userText,
        conversation_id: conversationId,
        imageUrl: imageUrls[0],
        imageUrls,
      }, {
        timeoutMs: 45000,
      });

      if (data.conversation_id) {
        setConversationId(data.conversation_id);

        await saveLastConversation(data.conversation_id);

        if (!conversationId) {
          await postJson("/api/conversation-title", {
            user_id: APP_USER_ID,
            conversation_id: data.conversation_id,
            message: userText,
          });
        }
      }

      setMessages((prev) =>
        prev.map((item) =>
          item.id === messageToSend.id
            ? {
                ...item,
                status: "sent",
              }
            : item,
        ),
      );

      setIsTyping(false);

      setMessages((prev) => [
        ...prev,

        {
          id: createLocalMessageId(),
          role: "assistant",
          text: data.reply || "小C暂时没有回复。",
          status: "sent",
        },
      ]);
    } catch (error) {
      console.log("CHAT ERROR:", error);

      setIsTyping(false);

      setMessages((prev) =>
        prev.map((item) =>
          item.id === messageToSend.id
            ? {
                ...item,
                status: "failed",
              }
            : item,
        ),
      );
    }
  };

  const sendMessage = async () => {
    if (isSendDisabled) return;

    const newMessage: Message = {
      id: createLocalMessageId(),
      role: "user",
      text: message.trim(),
      imageUri: selectedImages[0]?.uri,
      imageUris: selectedImages.map((image) => image.uri),
      imageAsset: selectedImages[0],
      imageAssets: selectedImages,
      status: "sending",
    };

    setMessages((prev) => [...prev, newMessage]);

    setTimeout(() => {
      scrollToLatestMessage(true);
    }, 100);

    setMessage("");
    setSelectedImages([]);

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

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={0}
    >
      <View style={styles.container}>
        {drawerVisible && (
          <Animated.View
            style={[styles.drawerOverlay, drawerOverlayStyle]}
          >
            <Pressable
              style={styles.drawerCloseArea}
              onPress={closeDrawer}
            />

            <Animated.View style={[styles.drawer, drawerStyle]}>
              <ConversationList
                currentConversationId={conversationId}
                onNavigate={closeDrawer}
              />
            </Animated.View>
          </Animated.View>
        )}

        <View style={styles.header}>
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
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.chat}
          contentContainerStyle={[
            styles.chatContent,
            messages.length === 0 && styles.empty,
          ]}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() =>
            scrollRef.current?.scrollToEnd({
              animated: true,
            })
          }
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

          {messages.map((item) =>
            item.role === "user" ? (
              <AnimatedMessage key={item.id}>
                <View style={styles.userRow}>
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
                                key={`${item.id}_${imageIndex}`}
                                onPress={() =>
                                  item.status !== "sending" &&
                                  setPreviewImageUri(imageUri)
                                }
                              >
                                <Image
                                  source={{ uri: imageUri }}
                                  style={[
                                    styles.messageImage,
                                    (item.imageUris || [item.imageUri]).length >
                                      1 && styles.messageImageGridItem,
                                    (item.status === "sending" ||
                                      item.status === "failed") &&
                                      styles.messageImageSending,
                                  ]}
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

                  {!!item.text && (
                    <View style={styles.userBubble}>
                      <TextInput
                        style={[styles.userText, styles.selectableText]}
                        value={item.text}
                        editable={false}
                        multiline
                        scrollEnabled={false}
                      />
                    </View>
                  )}

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
              <AnimatedMessage key={item.id}>
                <View style={styles.aiWrap}>
                  <View style={styles.aiBox}>
                    <TextInput
                      style={[styles.aiText, styles.selectableText]}
                      value={item.text.replace(/\s*\n\s*/g, "\n")}
                      editable={false}
                      multiline
                      scrollEnabled={false}
                    />
                  </View>

                  {isDiaryText(item.text) && (
                    <Pressable
                      style={({ pressed }) => [
                        styles.diarySaveButton,
                        pressed && styles.diarySaveButtonPressed,
                        item.diarySaveStatus === "saved" &&
                          styles.diarySaveButtonSaved,
                      ]}
                      onPress={() => saveDiaryFromMessage(item)}
                      disabled={
                        item.diarySaveStatus === "saving" ||
                        item.diarySaveStatus === "saved"
                      }
                    >
                      <Text style={styles.diarySaveText}>
                        {item.diarySaveStatus === "saving"
                          ? "正在存入..."
                          : item.diarySaveStatus === "saved"
                            ? "已存入 Diary"
                            : item.diarySaveStatus === "failed"
                              ? "存入失败，重试"
                              : "存入 Diary"}
                      </Text>
                    </Pressable>
                  )}
                </View>
              </AnimatedMessage>
            ),
          )}

          {isTyping && <TypingDots />}
        </ScrollView>

        <View style={styles.inputArea}>
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

          <View style={styles.inputBox}>
            <Pressable style={styles.attachButton} onPress={pickImage}>
              <Text style={styles.attachText}>＋</Text>
            </Pressable>

            <TextInput
              style={styles.input}
              placeholder="和小C说点什么..."
              placeholderTextColor="#999"
              value={message}
              onChangeText={setMessage}
              onFocus={() => {
                setTimeout(() => {
                  scrollToLatestMessage(true);
                }, 120);
              }}
              multiline
            />

            <Pressable
              style={[
                styles.sendButton,
                canSendMessage && !isTyping && styles.sendActive,
                isTyping && styles.sendDisabled,
              ]}
              onPress={sendMessage}
              disabled={isSendDisabled}
            >
              <Text style={styles.sendText}>↑</Text>
            </Pressable>
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

    width: "24%",
  },
  drawerOverlay: {
    position: "absolute",

    top: 0,
    left: 0,
    right: 0,
    bottom: 0,

    backgroundColor: "rgba(0,0,0,0.06)",

    zIndex: 100,
  },

  drawer: {
    width: "76%",

    height: "100%",

    backgroundColor: "#F7F7F8",

    paddingTop: 0,

    paddingHorizontal: 0,

    borderTopRightRadius: 18,
    borderBottomRightRadius: 18,

    overflow: "hidden",

    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 24,

    shadowOffset: {
      width: 8,
      height: 0,
    },

    elevation: 8,
  },

  container: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },

  header: {
    height: 105,

    paddingTop: 35,

    paddingLeft: 28,

    justifyContent: "center",
  },

  menuText: {
    fontSize: 26,
    color: "#555",
    marginTop: 8,
  },

  chat: {
    flex: 1,
  },

  chatContent: {
    paddingHorizontal: 20,

    paddingTop: 0,

    paddingBottom: 130,
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

  userRow: {
    alignItems: "flex-end",

    marginTop: 12,

    marginBottom: 18,
  },

  userBubble: {
    maxWidth: "80%",
    backgroundColor: "rgba(220,240,255,0.75)",
    borderColor: "#D5E9FF",
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },

  userText: {
    fontSize: 17,
    color: "#4B5563",
    lineHeight: 24,
  },
  aiBox: {
    minWidth: 120,
    maxWidth: "100%",
    alignSelf: "flex-start",
    backgroundColor: "#F4F4F4",
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 9,
  },

  aiWrap: {
    alignSelf: "flex-start",
    maxWidth: "82%",
  },

  aiText: {
    fontSize: 17,
    color: "#444",
    lineHeight: 25,
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

  selectableText: {
    margin: 0,
    padding: 0,
    minHeight: 0,
    backgroundColor: "transparent",
    textAlignVertical: "top",
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

  inputArea: {
    paddingHorizontal: 20,
    paddingBottom: 20,
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

  inputBox: {
    minHeight: 55,
    borderRadius: 28,
    backgroundColor: "#F5F5F5",
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 8,
    paddingRight: 8,
  },

  attachButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 4,
  },

  attachText: {
    color: "#777777",
    fontSize: 28,
    lineHeight: 30,
    marginTop: -2,
  },

  input: {
    flex: 1,
    fontSize: 17,
    color: "#333",
    maxHeight: 100,
  },

  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#D8D8D8",
    alignItems: "center",
    justifyContent: "center",
  },

  sendActive: {
    backgroundColor: "#555555",
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
    width: 180,
    height: 180,
    borderRadius: 16,
    marginBottom: 8,
    backgroundColor: "#E9EEF5",
  },

  messageImageGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    maxWidth: 190,
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
