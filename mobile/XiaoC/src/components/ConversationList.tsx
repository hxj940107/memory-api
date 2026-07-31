import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  Alert,
  Animated,
  Easing,
  Dimensions,
} from "react-native";

import { useEffect, useState, useRef } from "react";

import { router } from "expo-router";
import { APP_USER_ID, apiJson, postJson } from "../config/api";
import {
  clearLastConversation,
  saveLastConversation,
} from "../lib/conversationState";

type Conversation = {
  id: string;
  title: string;
  created_at: string;
  latest: boolean;
  is_pinned?: boolean;
};

type ConversationListRow =
  | {
      type: "section";
      id: string;
      title: string;
    }
  | {
      type: "conversation";
      item: Conversation;
    };

function ConversationItem({
  item,
  isCurrent,
  onOpen,
  onLongPress,
}: {
  item: Conversation;
  isCurrent: boolean;
  onOpen: () => void;
  onLongPress: (ref: React.RefObject<View | null>) => void;
}) {
  const itemRef = useRef<View>(null);

  return (
    <Pressable
      ref={itemRef}
      style={[styles.item, isCurrent && styles.currentItem]}
      onPress={onOpen}
      onLongPress={() => {
        onLongPress(itemRef);
      }}
    >
      <Text style={styles.itemTitle}>{item.title}</Text>
    </Pressable>
  );
}

export default function ConversationList({
  onNavigate,
  currentConversationId,
}: {
  onNavigate?: () => void | Promise<void>;
  currentConversationId?: string | null;
}) {
  const [list, setList] = useState<Conversation[]>([]);

  const [selected, setSelected] = useState<Conversation | null>(null);

  const [menuVisible, setMenuVisible] = useState(false);

  const [menuPosition, setMenuPosition] = useState({
    x: 40,
    y: 0,
  });

  const menuAnim = useState(new Animated.Value(0))[0];

  useEffect(() => {
    loadConversations();
  }, []);

  const normalizeConversations = (data: Conversation[]) =>
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
      });

  const fetchConversations = async () => {
    const data = await apiJson<Conversation[]>("/api/conversations", {
      query: {
        user_id: APP_USER_ID,
      },
    });

    return normalizeConversations(data);
  };

  const loadConversations = async () => {
    try {
      setList(await fetchConversations());
    } catch (error) {
      console.log(error);
    }
  };

  const pinnedConversations = list.filter((item) => item.is_pinned);
  const normalConversations = list.filter((item) => !item.is_pinned);
  const hasPinnedConversations = pinnedConversations.length > 0;

  const rows: ConversationListRow[] = hasPinnedConversations
    ? [
        {
          type: "section",
          id: "pinned",
          title: "置顶",
        },
        ...pinnedConversations.map((item) => ({
          type: "conversation" as const,
          item,
        })),
        {
          type: "section",
          id: "normal",
          title: "最近",
        },
        ...normalConversations.map((item) => ({
          type: "conversation" as const,
          item,
        })),
      ]
    : list.map((item) => ({
        type: "conversation" as const,
        item,
      }));

  const restoreAfterDelete = async () => {
    const nextList = await fetchConversations();
    const nextConversation = nextList[0];

    setList(nextList);

    if (nextConversation) {
      await saveLastConversation(nextConversation.id);

      router.replace({
        pathname: "/chat",
        params: {
          conversationId: nextConversation.id,
        },
      });
      return;
    }

    await clearLastConversation();
    router.replace({
      pathname: "/chat",
      params: {
        newChat: "1",
      },
    });
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

          await postJson("/api/conversation-title", {
            user_id: APP_USER_ID,
            conversation_id: item.id,
            action: "rename",
            title,
          });

          loadConversations();
        },
      },
    ]);
  };

  const togglePin = async (item: Conversation | null) => {
    if (!item) return;

    await postJson("/api/conversation-title", {
      user_id: APP_USER_ID,
      conversation_id: item.id,
      action: "pin",
      is_pinned: !item.is_pinned,
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
              await postJson("/api/conversation-title", {
                user_id: APP_USER_ID,
                conversation_id: item.id,
                action: "delete",
              });

              await restoreAfterDelete();
            },
          },
        ],
      );
    }, 300);
  };

  const createNewChat = async () => {
    await clearLastConversation();

    await onNavigate?.();

    router.push({
      pathname: "/chat",

      params: {
        newChat: "1",
      },
    });
  };

  return (
    <View style={styles.container}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>聊天记录</Text>

        <Pressable style={styles.newButton} onPress={createNewChat}>
          <Text style={styles.newButtonText}>＋</Text>
        </Pressable>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(row) =>
          row.type === "section" ? row.id : row.item.id
        }
        renderItem={({ item: row }) => {
          if (row.type === "section") {
            return <Text style={styles.sectionTitle}>{row.title}</Text>;
          }

          const item = row.item;

          return (
            <ConversationItem
              item={item}
              isCurrent={item.id === currentConversationId}
              onOpen={async () => {
                if (item.id === currentConversationId) {
                  await onNavigate?.();
                  return;
                }

                await saveLastConversation(item.id);
                await onNavigate?.();

                router.push({
                  pathname: "/chat",
                  params: {
                    conversationId: item.id,
                  },
                });
              }}
              onLongPress={(ref) => {
                ref.current?.measure((x, y, width, height, pageX, pageY) => {
                  const menuHeight = 150;

                  const screenHeight = Dimensions.get("window").height;

                  if (pageY + height + menuHeight + 20 > screenHeight) {
                    setMenuPosition({
                      x: 40,
                      y: pageY - menuHeight - 2,
                    });
                  } else {
                    setMenuPosition({
                      x: 40,
                      y: pageY + height + 6,
                    });
                  }

                  showMenu(item);
                });
              }}
            />
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>暂无聊天记录</Text>}
      />

      {menuVisible && selected && (
        <Pressable style={styles.menuLayer} onPress={hideMenu}>
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
            }}
          >
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
                        outputRange: [0, 0],
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
                style={({ pressed }) => [
                  styles.menuAction,
                  pressed && styles.menuActionPressed,
                ]}
                onPress={() => {
                  editTitle(selected);
                  hideMenu();
                }}
              >
                <Text style={styles.menuText}>重命名</Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [
                  styles.menuAction,
                  pressed && styles.menuActionPressed,
                ]}
                onPress={() => {
                  togglePin(selected);
                }}
              >
                <Text style={styles.menuText}>
                  {selected.is_pinned ? "取消置顶" : "置顶"}
                </Text>
              </Pressable>

              <Pressable
                style={({ pressed }) => [
                  styles.menuAction,
                  pressed && styles.menuActionPressed,
                ]}
                onPress={() => {
                  deleteConversation(selected);
                }}
              >
                <Text style={styles.deleteText}>删除</Text>
              </Pressable>
            </Animated.View>
          </Pressable>
        </Pressable>
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
  },

  titleRow: {
    flexDirection: "row",

    marginBottom: 24,

    alignItems: "center",

    justifyContent: "space-between",
  },

  item: {
    paddingVertical: 16,

    borderRadius: 12,

    paddingHorizontal: 8,
  },

  currentItem: {
    backgroundColor: "rgba(120,120,128,0.08)",
  },

  itemTitle: {
    fontSize: 17,

    color: "#444",
  },

  sectionTitle: {
    marginTop: 8,

    marginBottom: 6,

    paddingHorizontal: 8,

    fontSize: 13,

    fontWeight: "500",

    color: "#8E8E93",
  },

  empty: {
    marginTop: 40,

    textAlign: "center",

    color: "#999",
  },

  menuLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  menu: {
    position: "absolute",
    width: 200,
    left: 20,

    backgroundColor: "rgba(255,255,255,0.96)",

    borderRadius: 18,

    paddingVertical: 4,

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

    paddingVertical: 8,
  },

  menuAction: {
    borderRadius: 12,

    marginHorizontal: 4,
  },

  menuActionPressed: {
    backgroundColor: "rgba(120,120,128,0.10)",
  },

  menuText: {
    fontSize: 17,

    paddingHorizontal: 16,

    paddingVertical: 12,

    color: "#222",
  },

  deleteText: {
    fontSize: 17,

    paddingHorizontal: 18,

    paddingVertical: 12,

    color: "#FF3B30",
  },

  newButton: {
    width: 36,

    height: 36,

    borderRadius: 18,

    backgroundColor: "rgba(120,120,128,0.12)",

    justifyContent: "center",

    alignItems: "center",
  },

  newButtonText: {
    fontSize: 24,

    color: "#444",

    lineHeight: 28,
  },
});
