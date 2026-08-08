import { Image } from "expo-image";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";

import { useEffect, useState } from "react";

import { apiJson, APP_USER_ID } from "../config/api";

type Moment = {
  id: string;
  createdAt: string;
  author: string;
  avatar: "moon" | "sparkle";
  likes: number;
  image?: "sunset" | "notebook" | "night" | null;
  text: string;
};

type MomentsResponse = Array<{
  id: string;
  author?: string;
  text?: string;
  image?: Moment["image"];
  likes?: number;
  createdAt?: string;
}>;

const momentImages = {
  sunset: require("../../assets/moments-sunset.svg"),
  notebook: require("../../assets/moments-notebook.svg"),
  night: require("../../assets/moments-night.svg"),
};

export default function MomentsScreen() {
  const [moments, setMoments] = useState<Moment[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadMoments = async () => {
    const data = await apiJson<MomentsResponse>("/api/memory", {
      query: {
        type: "moments",
        user_id: APP_USER_ID,
      },
    });

    setMoments(
      data
        .filter((item) => item.id && item.text)
        .map((item) => ({
          id: item.id,
          author: item.author || "小C",
          text: item.text || "",
          image: item.image || null,
          likes: Number(item.likes || 0),
          createdAt: item.createdAt || new Date().toISOString(),
          avatar: item.author === "小天使" ? "sparkle" : "moon",
        })),
    );
  };

  useEffect(() => {
    loadMoments().catch((error) => {
      console.log("Moments load failed:", error);
    });
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadMoments();
    } catch (error) {
      console.log("Moments refresh failed:", error);
    } finally {
      setRefreshing(false);
    }
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
            await apiJson("/api/memory", {
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
          } catch (error) {
            setMoments(previous);
            Alert.alert("删除失败", error instanceof Error ? error.message : "请稍后再试。");
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

  const renderAvatar = (moment: Moment) => (
    <View
      style={[
        styles.avatar,
        moment.avatar === "sparkle" ? styles.sparkleAvatar : styles.moonAvatar,
      ]}
    >
      <Text style={styles.avatarText}>
        {moment.avatar === "sparkle" ? "✦" : "☾"}
      </Text>
    </View>
  );

  const renderImage = (image?: Moment["image"]) => {
    if (!image) {
      return null;
    }

    return (
      <Image
        source={momentImages[image]}
        style={styles.photo}
        contentFit="cover"
      />
    );
  };

  return (
    <View style={styles.screen}>
      <View style={styles.nav}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <SymbolView
            name="chevron.left"
            size={20}
            tintColor="#7A7A7E"
            weight="light"
          />
        </Pressable>

        <Text style={styles.title}>朋友圈</Text>

        <Pressable style={({ pressed }) => [styles.camera, pressed && styles.pressed]}>
          <SymbolView
            name="camera"
            size={24}
            tintColor="#3C3C43"
            weight="light"
          />
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor="#A6A6AA" />
        }
      >
        {moments.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>小C还没有偷偷发动态。</Text>
          </View>
        )}

        {moments.map((moment) => (
          <Pressable
            key={moment.id}
            style={({ pressed }) => [
              styles.moment,
              pressed && styles.momentPressed,
            ]}
            onLongPress={() => confirmDelete(moment)}
          >
            {renderAvatar(moment)}

            <View style={styles.momentBody}>
              <View style={styles.momentHeader}>
                <Text style={styles.author}>{moment.author}</Text>
                <Text style={styles.date}>{formatMomentTime(moment.createdAt)}</Text>
              </View>

              <Text style={styles.text}>{moment.text}</Text>

              {renderImage(moment.image)}

              <View style={styles.footer}>
                <View style={styles.reactions}>
                  <SymbolView
                    name="heart"
                    size={18}
                    tintColor="#8C8C91"
                    weight="thin"
                    style={styles.actionIcon}
                  />
                  <Text style={styles.likeCount}>{moment.likes}</Text>
                  <SymbolView
                    name="message"
                    size={17}
                    tintColor="#8C8C91"
                    weight="thin"
                  />
                </View>

                <SymbolView
                  name="ellipsis"
                  size={15}
                  tintColor="#A6A6AA"
                  weight="light"
                />
              </View>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },

  nav: {
    height: 104,
    paddingTop: 54,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(120,120,128,0.1)",
    backgroundColor: "rgba(247,247,247,0.92)",
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
    color: "#111111",
  },

  camera: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
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

  empty: {
    paddingTop: 120,
    paddingHorizontal: 40,
    alignItems: "center",
  },

  emptyText: {
    fontSize: 15,
    lineHeight: 22,
    color: "#B1ACA7",
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

  avatar: {
    width: 44,
    height: 44,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },

  moonAvatar: {
    backgroundColor: "#2B2E35",
  },

  sparkleAvatar: {
    backgroundColor: "#B7A8EB",
  },

  avatarText: {
    fontSize: 24,
    color: "#FFFFFF",
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
    fontSize: 16,
    lineHeight: 25,
    color: "#161616",
    marginBottom: 12,
  },

  photo: {
    height: 132,
    borderRadius: 7,
    overflow: "hidden",
    marginBottom: 13,
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
});
