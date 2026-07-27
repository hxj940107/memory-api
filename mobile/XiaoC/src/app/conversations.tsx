import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  Alert,
  Animated,
  Easing,
} from "react-native";

import { useEffect, useState } from "react";
import { router } from "expo-router";

type Conversation = {
  id: string;
  title: string;
  created_at: string;
  latest: boolean;
  is_pinned: boolean;
};

export default function Conversations() {
  const [list, setList] = useState<Conversation[]>([]);

  const [selected, setSelected] = useState<Conversation | null>(null);

  const [menuVisible, setMenuVisible] = useState(false);
  const menuAnim = useState(new Animated.Value(0))[0];

  useEffect(() => {
    loadConversations();
  }, []);

  const loadConversations = async () => {
    try {
      const res = await fetch(
        "https://memory-api-beta.vercel.app/api/conversations?user_id=user",
      );

      const data = await res.json();

      setList(data);
    } catch (error) {
      console.log(error);
    }
  };

  const editTitle = (item: Conversation) => {
    Alert.prompt(
      "修改标题",
      "",
      async (text) => {
        if (!text || !text.trim()) return;

        await fetch(
          "https://memory-api-beta.vercel.app/api/conversation-title",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json",
            },

            body: JSON.stringify({
              user_id: "user",

              conversation_id: item.id,

              title: text.trim(),
            }),
          },
        );

        loadConversations();
      },

      "plain-text",

      item.title,
    );
  };

  const showMenu = (item: Conversation) => {
    setSelected(item);

    setMenuVisible(true);

    Animated.spring(menuAnim, {
      toValue: 1,

      useNativeDriver: true,

      damping: 22,

      stiffness: 100,

      mass: 0.9,
    }).start();
  };
  const togglePin = async (item: Conversation | null) => {
    if (!item) return;

    await fetch("https://memory-api-beta.vercel.app/api/conversation-title", {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        user_id: "user",

        conversation_id: item.id,

        action: "pin",

        is_pinned: !item.is_pinned,
      }),
    });

    hideMenu();

    loadConversations();
  };
  const deleteConversation = (item: Conversation | null) => {
    if (!item) return;

    // 先关闭长按菜单
    hideMenu();

    // 等菜单收回后再弹确认框
    setTimeout(() => {
      Alert.alert(
        "删除聊天？",

        "删除后无法恢复",

        [
          {
            text: "取消",

            style: "cancel",
          },

          {
            text: "删除",

            style: "destructive",

            onPress: async () => {
              try {
                await fetch(
                  "https://memory-api-beta.vercel.app/api/conversation-title",

                  {
                    method: "POST",

                    headers: {
                      "Content-Type": "application/json",
                    },

                    body: JSON.stringify({
                      user_id: "user",

                      conversation_id: item.id,

                      action: "delete",
                    }),
                  },
                );

                loadConversations();
              } catch (error) {
                console.log(error);
              }
            },
          },
        ],
      );
    }, 300);
  };
  const hideMenu = () => {
    Animated.timing(menuAnim, {
      toValue: 0,

      duration: 260,

      easing: Easing.out(Easing.ease),

      useNativeDriver: true,
    }).start(() => {
      setMenuVisible(false);
    });
  };

  const createNewChat = () => {
    const id = "chat_" + Date.now();

    router.push({
      pathname: "/chat",

      params: {
        conversationId: id,
      },
    });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>聊天记录</Text>

      <FlatList
        data={list}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable
            style={styles.item}
            onPress={() => {
              router.push({
                pathname: "/chat",

                params: {
                  conversationId: item.id,
                },
              });
            }}
            onLongPress={() => {
              showMenu(item);
            }}
          >
            <Text style={styles.itemTitle}>
              {item.is_pinned ? "⭐ " : ""}

              {item.title}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>暂无聊天记录</Text>}
      />

      {menuVisible && selected && (
        <Pressable
          style={styles.overlay}
          onPress={() => {
            hideMenu();
          }}
        >
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
            }}
          >
            <Animated.View
              style={[
                styles.menu,

                {
                  opacity: menuAnim,

                  transform: [
                    {
                      translateY: menuAnim.interpolate({
                        inputRange: [0, 1],

                        outputRange: [40, 0],
                      }),
                    },

                    {
                      scale: menuAnim.interpolate({
                        inputRange: [0, 1],

                        outputRange: [0.95, 1],
                      }),
                    },
                  ],
                },
              ]}
            >
              <Text style={styles.menuTitle}>{selected.title}</Text>

              <Pressable
                onPress={() => {
                  editTitle(selected);

                  hideMenu();
                }}
              >
                <Text style={styles.menuText}>重命名</Text>
              </Pressable>

              <Pressable
                onPress={() => {
                  togglePin(selected);
                }}
              >
                <Text style={styles.menuText}>
                  {selected.is_pinned ? "取消置顶" : "置顶"}
                </Text>
              </Pressable>

              <Pressable
                onPress={() => {
                  deleteConversation(selected);
                }}
              >
                <Text style={styles.deleteText}>删除</Text>
              </Pressable>
            </Animated.View>
          </Pressable>

          <Animated.View
            style={[
              styles.cancelButton,

              {
                opacity: menuAnim,

                transform: [
                  {
                    translateY: menuAnim.interpolate({
                      inputRange: [0, 1],

                      outputRange: [40, 0],
                    }),
                  },

                  {
                    scale: menuAnim.interpolate({
                      inputRange: [0, 1],

                      outputRange: [0.96, 1],
                    }),
                  },
                ],
              },
            ]}
          >
            <Pressable
              onPress={() => {
                hideMenu();
              }}
            >
              <Text style={styles.menuText}>取消</Text>
            </Pressable>
          </Animated.View>
        </Pressable>
      )}

      <Pressable style={styles.newButton} onPress={createNewChat}>
        <Text style={styles.newButtonText}>＋ 新聊天</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,

    backgroundColor: "rgba(0,0,0,0.25)",

    justifyContent: "flex-end",

    paddingBottom: 35,

    zIndex: 50,
  },

  menu: {
    width: "78%",
    alignSelf: "center",

    backgroundColor: "#F2F2F7",

    borderRadius: 22,

    paddingVertical: 8,

    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: {
      width: 0,
      height: 8,
    },

    elevation: 10,
  },

  menuTitle: {
    fontSize: 13,
    color: "#8E8E93",
    textAlign: "center",
    paddingVertical: 10,
  },

  menuText: {
    fontSize: 17,
    textAlign: "center",
    paddingVertical: 13,
  },

  deleteText: {
    fontSize: 17,

    textAlign: "center",

    paddingVertical: 16,

    color: "#FF3B30",
  },

  cancelButton: {
    width: "78%",

    alignSelf: "center",

    marginTop: 12,

    backgroundColor: "#F2F2F7",

    borderRadius: 18,

    overflow: "hidden",
  },
  container: {
    flex: 1,

    backgroundColor: "#FFFFFF",

    paddingHorizontal: 20,

    paddingTop: 70,
  },

  title: {
    fontSize: 28,

    fontWeight: "500",

    color: "#333",

    marginBottom: 25,
  },

  item: {
    paddingVertical: 18,

    borderBottomWidth: 1,

    borderColor: "#EEEEEE",
  },

  itemTitle: {
    fontSize: 17,

    color: "#444",
  },

  empty: {
    marginTop: 50,

    textAlign: "center",

    color: "#999",

    fontSize: 16,
  },

  newButton: {
    height: 55,

    borderRadius: 28,

    backgroundColor: "#F2F2F2",

    justifyContent: "center",

    alignItems: "center",

    marginBottom: 20,
  },

  newButtonText: {
    fontSize: 18,

    color: "#444",
  },
});
