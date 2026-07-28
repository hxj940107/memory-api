import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
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

export default function ConversationList() {
  const [list, setList] = useState<Conversation[]>([]);

  const [selected, setSelected] = useState<Conversation | null>(null);

  const [menuVisible, setMenuVisible] = useState(false);

  const [menuPosition, setMenuPosition] = useState({
    x: 20,
    y: 0,
  });

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
            if (a.is_pinned === b.is_pinned) {
              return 0;
            }

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

    hideMenu();

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
            },
          },
        ],
      );
    }, 300);
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
            style={[styles.item, item.is_pinned && styles.pinnedItem]}
            onPress={() => {
              router.push({
                pathname: "/chat",

                params: {
                  conversationId: item.id,
                },
              });
            }}
            onLongPress={(event) => {
              const { pageY } = event.nativeEvent;

              const menuHeight = 130;

              const bottomSpace = 850 - pageY;

              if (bottomSpace < menuHeight) {
                setMenuPosition({
                  x: 40,
                  y: pageY - 120,
                });
              } else {
                setMenuPosition({
                  x: 40,
                  y: pageY + 10,
                });
              }

              showMenu(item);
            }}
          >
            <Text style={styles.itemTitle}>{item.title}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>暂无聊天记录</Text>}
      />

      {menuVisible && selected && (
        <View style={styles.menuLayer}>
          <Animated.View
            style={[
              styles.menu,

              {
                left: 40,

                top: menuPosition.y,
              },

              {
                opacity: menuAnim,

                transform: [
                  {
                    translateY: menuAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [20, 0],
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
            <Text
              style={styles.menuTitle}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {selected.title}
            </Text>

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
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,

    backgroundColor: "transparent",

    paddingHorizontal: 20,

    paddingTop: 60,
  },
  title: {
    fontSize: 22,

    fontWeight: "600",

    color: "#333",

    marginBottom: 20,
  },

  item: {
    paddingVertical: 16,

    borderRadius: 12,

    paddingHorizontal: 8,
  },

  pinnedItem: {
    backgroundColor: "rgba(120,120,128,0.12)",
  },

  pressedItem: {
    backgroundColor: "#E5E5EA",
  },

  itemTitle: {
    fontSize: 17,

    color: "#444",
  },

  empty: {
    marginTop: 40,

    textAlign: "center",

    color: "#999",
  },

  menuLayer: {
    position: "absolute",

    top: 60,

    left: 20,

    right: 20,

    bottom: 0,

    zIndex: 100,
  },
  menu: {
    width: 200,
    left: 20,

    backgroundColor: "rgba(255,255,255,0.96)",

    borderRadius: 18,

    paddingVertical: 8,

    shadowColor: "#000",

    shadowOpacity: 0.08,

    shadowRadius: 16,

    shadowOffset: {
      width: 0,
      height: 6,
    },

    elevation: 8,
  },
  menuTitle: {
    fontSize: 13,

    color: "#8E8E93",

    paddingHorizontal: 16,

    paddingVertical: 10,
  },

  menuText: {
    fontSize: 16,

    paddingHorizontal: 16,

    paddingVertical: 11,

    color: "#222",
  },

  deleteText: {
    fontSize: 16,

    paddingHorizontal: 18,

    paddingVertical: 12,

    color: "#FF3B30",
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
