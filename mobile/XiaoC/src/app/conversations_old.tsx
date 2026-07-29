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
  is_pinned?: boolean;
};

export default function Conversations() {
  const [list, setList] = useState<Conversation[]>([]);

  const [selected, setSelected] = useState<Conversation | null>(null);
  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(null);
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

      setList(
        data
          .map((item: Conversation) => ({
            ...item,
            is_pinned: item.is_pinned ?? false,
          }))
          .sort((a: Conversation, b: Conversation) => {
            if (a.is_pinned === b.is_pinned) return 0;

            return a.is_pinned ? -1 : 1;
          }),
      );
    } catch (error) {
      console.log(error);
    }
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

  const editTitle = (item: Conversation | null) => {
    if (!item) return;

    Alert.prompt("重命名", "请输入新的标题", [
      {
        text: "取消",
        style: "cancel",
      },

      {
        text: "确定",

        onPress: async (title?: string) => {
          if (!title) return;

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

                action: "rename",

                title,
              }),
            },
          );

          loadConversations();
        },
      },
    ]);
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
            style={[
              styles.item,

              item.id === currentConversationId && styles.activeItem,
            ]}
            onPress={() => {
              setCurrentConversationId(item.id);

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
            <Text style={styles.itemTitle}>{item.title}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>暂无聊天记录</Text>}
      />

      <Pressable style={styles.newButton} onPress={createNewChat}>
        <Text style={styles.newButtonText}>＋ 新聊天</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  pressedItem: {
    backgroundColor: "#E5E5EA",
  },

  overlay: {
    position: "absolute",

    width: 0,

    height: 0,
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

    backgroundColor: "transparent",

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
  },

  activeItem: {
    backgroundColor: "#F2F2F7",
    borderRadius: 12,
  },

  pinnedItem: {
    backgroundColor: "rgba(120,120,128,0.08)",
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
