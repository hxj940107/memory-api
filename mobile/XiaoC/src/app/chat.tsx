import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Animated,
} from "react-native";

import { useState, useRef, useEffect } from "react";

type Message = {
  role: "user" | "assistant";
  text: string;
};

function TypingDots() {
  const dots = [
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ];

  useEffect(() => {
    const animations = dots.map((dot, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 200),

          Animated.timing(dot, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),

          Animated.timing(dot, {
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
        <Animated.View
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
  const opacity = useState(new Animated.Value(0))[0];
  const translateY = useState(new Animated.Value(8))[0];

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true,
      }),

      Animated.timing(translateY, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  return (
    <Animated.View
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
    </Animated.View>
  );
}
export default function ChatScreen() {
  const [message, setMessage] = useState("");

  const [messages, setMessages] = useState<Message[]>([]);

  const [isTyping, setIsTyping] = useState(false);

  const scrollRef = useRef<ScrollView>(null);

  const [conversationId, setConversationId] = useState<string | null>(null);

  // 正在输入动画

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
      console.log(error);

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
          {messages.length === 0 && (
            <Text style={styles.greeting}>今天过得怎么样？</Text>
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
                  <Text style={styles.aiText}>{item.text}</Text>
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
  container: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },

  chat: {
    flex: 1,
  },

  chatContent: {
    paddingHorizontal: 20,
    paddingTop: 70,
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
    lineHeight: 24,
  },

  aiBox: {
    maxWidth: "85%",
    marginBottom: 25,
  },

  aiText: {
    fontSize: 17,
    color: "#444",
    lineHeight: 28,
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
