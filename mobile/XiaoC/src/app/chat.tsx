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
  Animated as RNAnimated,
  Dimensions,
} from "react-native";

import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
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

type Message = {
  role: "user" | "assistant";
  text: string;
  imageUri?: string;
};

type HistoryItem = {
  role: "user" | "assistant";
  content: string;
  metadata?: {
    imageUrl?: string;
  };
};

type ChatResponse = {
  reply?: string;
  conversation_id?: string;
};

function TypingDots() {
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
    <View style={styles.typingDots}>
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

  const [selectedImage, setSelectedImage] =
    useState<ImagePicker.ImagePickerAsset | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);

  const [isTyping, setIsTyping] = useState(false);

  const [loadingHistory, setLoadingHistory] = useState(true);

  const scrollRef = useRef<ScrollView>(null);

  const [conversationId, setConversationId] = useState<string | null>(null);

  const [drawerVisible, setDrawerVisible] = useState(false);

  const drawerProgress = useSharedValue(0);

  const openDrawer = () => {
    drawerProgress.value = 0;

    setDrawerVisible(true);

    requestAnimationFrame(() => {
      drawerProgress.value = withTiming(1, {
        duration: 350,
      });
    });
  };

  const closeDrawer = () => {
    drawerProgress.value = withTiming(
      0,
      {
        duration: 300,
      },
      (finished) => {
        if (finished) {
          runOnJS(setDrawerVisible)(false);
        }
      },
    );
  };

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
          translateX: (1 - drawerProgress.value) * -300,
        },
      ],
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
          role: "assistant",
          text: "需要先允许访问相册，才能发图片给小C看。",
        },
      ]);
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 0.8,
      base64: false,
    });

    if (!result.canceled) {
      setSelectedImage(result.assets[0]);
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
          role: item.role,
          text: item.content,
          imageUri: item.metadata?.imageUrl,
        })),
      );
    } catch (error) {
      console.log(error);
    } finally {
      setLoadingHistory(false);
    }
  };

  const sendMessage = async () => {
    if (!message.trim() && !selectedImage) return;

    const userText = message.trim() || "（图片）";
    const imageToSend = selectedImage;
    let imageUrl;

    if (imageToSend) {
      const maxImageSide = 1024;
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
          compress: 0.65,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        },
      );

      imageUrl = compressedImage.base64
        ? `data:image/jpeg;base64,${compressedImage.base64}`
        : undefined;
    }

    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        text: userText,
        imageUri: imageToSend?.uri,
      },
    ]);

    setTimeout(() => {
      scrollRef.current?.scrollToEnd({
        animated: true,
      });
    }, 100);

    setMessage("");
    setSelectedImage(null);

    setIsTyping(true);

    setTimeout(() => {
      scrollRef.current?.scrollToEnd({
        animated: true,
      });
    }, 100);

    try {
      const data = await postJson<ChatResponse>("/api/chat", {
        user_id: APP_USER_ID,
        message: userText,
        conversation_id: conversationId,
        imageUrl,
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

      setIsTyping(false);

      setMessages((prev) => [
        ...prev,

        {
          role: "assistant",
          text: data.reply || "小C暂时没有回复。",
        },
      ]);
    } catch (error) {
      console.log("CHAT ERROR:", error);

      setIsTyping(false);

      setMessages((prev) => [
        ...prev,

        {
          role: "assistant",
          text: "小C暂时连接不上啦。",
        },
      ]);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.container}>
        {drawerVisible && (
          <View style={styles.drawerOverlay}>
            <Pressable
              style={styles.drawerCloseArea}
              onPress={closeDrawer}
            />

            <Animated.View style={[styles.drawer, drawerStyle]}>
              <ConversationList onNavigate={closeDrawer} />
            </Animated.View>
          </View>
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
              <Text style={styles.greeting}>今天过得怎么样？</Text>
            )
          )}

          {messages.map((item, index) =>
            item.role === "user" ? (
              <AnimatedMessage key={index}>
                <View style={styles.userRow}>
                  <View style={styles.userBubble}>
                    {item.imageUri && (
                      <Image
                        source={{ uri: item.imageUri }}
                        style={styles.messageImage}
                      />
                    )}

                    <Text style={styles.userText}>{item.text}</Text>
                  </View>
                </View>
              </AnimatedMessage>
            ) : (
              <AnimatedMessage key={index}>
                <View style={styles.aiBox}>
                  <Text style={styles.aiText}>
                    {item.text.replace(/\s*\n\s*/g, "\n")}
                  </Text>
                </View>
              </AnimatedMessage>
            ),
          )}

          {isTyping && <TypingDots />}
        </ScrollView>

        <View style={styles.inputArea}>
          {selectedImage && (
            <View style={styles.attachmentPreview}>
              <Image
                source={{ uri: selectedImage.uri }}
                style={styles.attachmentImage}
              />

              <Pressable
                style={styles.removeAttachment}
                onPress={() => setSelectedImage(null)}
              >
                <Text style={styles.removeAttachmentText}>×</Text>
              </Pressable>
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
              multiline
            />

            <Pressable
              style={[
                styles.sendButton,
                (message.length > 0 || selectedImage) && styles.sendActive,
              ]}
              onPress={sendMessage}
            >
              <Text style={styles.sendText}>↑</Text>
            </Pressable>
          </View>
        </View>
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

    paddingBottom: 20,
  },

  empty: {
    flexGrow: 1,
    justifyContent: "center",
  },

  greeting: {
    textAlign: "center",
    fontSize: 26,
    color: "#6B6B6B",
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
    paddingVertical: 12,
  },

  userText: {
    fontSize: 17,
    color: "#4B5563",
    lineHeight: 24,
  },
  aiBox: {
    maxWidth: "75%",
    alignSelf: "flex-start",
    backgroundColor: "#F4F4F4",
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },

  aiText: {
    fontSize: 17,
    color: "#444",
    lineHeight: 24,
  },

  typingDots: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 25,
    height: 20,
  },

  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#D0D0D0",
    marginRight: 6,
  },

  activeDot: {
    backgroundColor: "#888888",
  },

  midDot: {
    backgroundColor: "#B5B5B5",
  },

  inputArea: {
    paddingHorizontal: 20,
    paddingBottom: 20,
  },

  attachmentPreview: {
    alignSelf: "flex-start",
    marginBottom: 10,
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
});
