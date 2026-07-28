import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Animated as RNAnimated,
} from "react-native";

import { Gesture, GestureDetector } from "react-native-gesture-handler";

import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from "react-native-reanimated";

import { router, useLocalSearchParams } from "expo-router";

import { useState, useRef, useEffect } from "react";

import AsyncStorage from "@react-native-async-storage/async-storage";

import ConversationList from "../components/ConversationList";

type Message = {
  role: "user" | "assistant";
  text: string;
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

  const incomingConversationId = params.conversationId as string | undefined;
  useEffect(() => {
    restoreConversation();
  }, [incomingConversationId]);
  const [message, setMessage] = useState("");

  const [messages, setMessages] = useState<Message[]>([]);

  const [isTyping, setIsTyping] = useState(false);

  const [loadingHistory, setLoadingHistory] = useState(true);

  const scrollRef = useRef<ScrollView>(null);

  const [conversationId, setConversationId] = useState<string | null>(null);

  const [drawerVisible, setDrawerVisible] = useState(false);

  const drawerProgress = useSharedValue(0);

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
          translateX:
            drawerProgress.value * 0 - (1 - drawerProgress.value) * 350,
        },
      ],
    };
  });

  // 正在输入动画

  const restoreConversation = async () => {
    try {
      setLoadingHistory(true);

      const savedId = await AsyncStorage.getItem("conversation_id");

      const id = incomingConversationId || savedId;

      console.log("恢复ID:", id);

      if (!id) {
        setLoadingHistory(false);
        return;
      }

      setConversationId(id);

      const res = await fetch(
        `https://memory-api-beta.vercel.app/api/history?user_id=user&conversation_id=${id}`,
      );

      const data = await res.json();

      setMessages(
        data.map((item: any) => ({
          role: item.role,
          text: item.content,
        })),
      );
    } catch (error) {
      console.log(error);
    } finally {
      setLoadingHistory(false);
    }
  };

  const sendMessage = async () => {
    if (!message.trim()) return;

    const userText = message;

    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        text: userText,
      },
    ]);

    setTimeout(() => {
      scrollRef.current?.scrollToEnd({
        animated: true,
      });
    }, 100);

    setMessage("");

    setIsTyping(true);

    setTimeout(() => {
      scrollRef.current?.scrollToEnd({
        animated: true,
      });
    }, 100);

    try {
      console.log("请求地址:", "https://memory-api-beta.vercel.app/api/chat");
      const res = await fetch("https://memory-api-beta.vercel.app/api/chat", {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          user_id: "user",

          message: userText,

          conversation_id: conversationId,
        }),
      });

      const data = await res.json();

      if (data.conversation_id) {
        setConversationId(data.conversation_id);

        await AsyncStorage.setItem("conversation_id", data.conversation_id);

        // 第一次创建会话时生成标题
        if (!conversationId) {
          await fetch(
            "https://memory-api-beta.vercel.app/api/conversation-title",
            {
              method: "POST",

              headers: {
                "Content-Type": "application/json",
              },

              body: JSON.stringify({
                user_id: "user",
                conversation_id: data.conversation_id,
                message: userText,
              }),
            },
          );
        }
      }
      if (!conversationId) {
        await fetch(
          "https://memory-api-beta.vercel.app/api/conversation-title",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
            },

            body: JSON.stringify({
              user_id: "user",
              conversation_id: data.conversation_id,
              message: userText,
            }),
          },
        );
      }

      setIsTyping(false);

      setMessages((prev) => [
        ...prev,

        {
          role: "assistant",
          text: data.reply,
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
              onPress={() => {
                drawerProgress.value = withSpring(0);

                setTimeout(() => {
                  setDrawerVisible(false);
                }, 250);
              }}
            />

            <Animated.View style={[styles.drawer, drawerStyle]}>
              <ConversationList />
            </Animated.View>
          </View>
        )}

        <View style={styles.header}>
          <Pressable
            onPress={() => {
              setDrawerVisible(true);

              drawerProgress.value = withSpring(1);
            }}
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
          <View style={styles.inputBox}>
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
                message.length > 0 && styles.sendActive,
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
    paddingTop: 45,
    paddingHorizontal: 20,
    justifyContent: "center",
  },

  menuText: {
    fontSize: 26,
    color: "#555",
  },

  chat: {
    flex: 1,
  },

  chatContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
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
    marginTop: 20,
    marginBottom: 25,
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
    lineHeight: 22,
  },

  aiBox: {
    maxWidth: "72%",
    backgroundColor: "#F4F4F4",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },

  aiText: {
    fontSize: 16,
    color: "#444",
    lineHeight: 21,
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

  inputBox: {
    minHeight: 55,
    borderRadius: 28,
    backgroundColor: "#F5F5F5",
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 20,
    paddingRight: 8,
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
});
