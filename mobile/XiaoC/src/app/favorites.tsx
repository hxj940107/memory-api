import { router } from "expo-router";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useEffect, useState } from "react";

import {
  deleteFavorite,
  FavoriteItem,
  getFavorites,
} from "../lib/favoritesState";

const formatFavoriteDate = (value: string) => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(date)
    .replaceAll("/", ".");
};

export default function FavoritesScreen() {
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);

  useEffect(() => {
    loadFavorites();
  }, []);

  const loadFavorites = async () => {
    setFavorites(await getFavorites());
  };

  const confirmDeleteFavorite = (favorite: FavoriteItem) => {
    Alert.alert("取消收藏？", "这条收藏会从这里移除。", [
      {
        text: "取消",
        style: "cancel",
      },
      {
        text: "移除",
        style: "destructive",
        onPress: async () => {
          await deleteFavorite(favorite.id);
          loadFavorites();
        },
      },
    ]);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>

        <Text style={styles.gentleLine}>有些话，我想替你留着</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {favorites.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>还没有收藏。</Text>
            <Text style={styles.emptySubtext}>长按一条消息，放进这里。</Text>
          </View>
        ) : (
          favorites.map((favorite) => (
            <Pressable
              key={favorite.id}
              style={({ pressed }) => [
                styles.card,
                pressed && styles.cardPressed,
              ]}
              onLongPress={() => confirmDeleteFavorite(favorite)}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.role}>
                  {favorite.role === "assistant" ? "小C" : "我"}
                </Text>
                <Text style={styles.date}>
                  {formatFavoriteDate(favorite.createdAt)}
                </Text>
              </View>

              <Text style={styles.text}>{favorite.text}</Text>
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#FBF8F3",
  },

  header: {
    paddingTop: 58,
    paddingHorizontal: 24,
    paddingBottom: 10,
  },

  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(120,120,128,0.08)",
    marginBottom: 34,
  },

  backText: {
    fontSize: 32,
    lineHeight: 34,
    color: "#555",
  },

  gentleLine: {
    fontSize: 17,
    color: "#A9A2A0",
    letterSpacing: 0.4,
  },

  scroll: {
    flex: 1,
  },

  content: {
    paddingHorizontal: 24,
    paddingTop: 18,
    paddingBottom: 52,
  },

  emptyState: {
    paddingTop: 120,
    alignItems: "center",
  },

  emptyText: {
    fontSize: 18,
    color: "#777",
  },

  emptySubtext: {
    marginTop: 10,
    fontSize: 15,
    color: "#B0AAA6",
  },

  card: {
    paddingHorizontal: 20,
    paddingVertical: 18,
    borderRadius: 24,
    marginBottom: 14,
    backgroundColor: "rgba(255,255,255,0.82)",
    shadowColor: "#B8AFA7",
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: {
      width: 0,
      height: 8,
    },
  },

  cardPressed: {
    backgroundColor: "rgba(245,242,238,0.92)",
  },

  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },

  role: {
    fontSize: 13,
    color: "#A69D98",
  },

  date: {
    fontSize: 13,
    color: "#B8B0AA",
  },

  text: {
    fontSize: 18,
    lineHeight: 29,
    color: "#3F3A37",
  },
});
