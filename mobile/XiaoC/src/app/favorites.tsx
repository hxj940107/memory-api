import { router } from "expo-router";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useEffect, useRef, useState } from "react";

import {
  deleteFavorite,
  FavoriteItem,
  getFavorites,
} from "../lib/favoritesState";
import { MessageMarkdown } from "../components/MessageMarkdown";

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
  const [selectedFavorite, setSelectedFavorite] =
    useState<FavoriteItem | null>(null);
  const longPressHandledRef = useRef(false);

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
          try {
            await deleteFavorite(favorite.id);
            loadFavorites();
          } catch (error) {
            console.log("Favorite delete failed:", error);
            Alert.alert("暂时没有移除", "网络恢复后再试一次。收藏仍然保留着。");
          }
        },
      },
    ]);
  };

  const renderFavorite = ({ item: favorite }: { item: FavoriteItem }) => (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        pressed && styles.cardPressed,
      ]}
      onPress={() => {
        if (longPressHandledRef.current) {
          longPressHandledRef.current = false;
          return;
        }
        setSelectedFavorite(favorite);
      }}
      onLongPress={() => {
        longPressHandledRef.current = true;
        setTimeout(() => {
          longPressHandledRef.current = false;
        }, 800);
        confirmDeleteFavorite(favorite);
      }}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.role}>
          {favorite.role === "assistant" ? "小C" : "我"}
        </Text>
        <View style={styles.cardMeta}>
          <Text style={styles.date}>
            {formatFavoriteDate(favorite.createdAt)}
          </Text>
          <Text style={styles.chevron}>›</Text>
        </View>
      </View>

      <Text style={styles.text} numberOfLines={2} ellipsizeMode="tail">
        {favorite.text}
      </Text>
    </Pressable>
  );

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>收藏</Text>
        <View style={styles.headerSpacer} />
      </View>

      <FlatList
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          favorites.length === 0 && styles.emptyContent,
        ]}
        showsVerticalScrollIndicator={false}
        data={favorites}
        keyExtractor={(favorite) => favorite.id}
        renderItem={renderFavorite}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>还没有收藏。</Text>
            <Text style={styles.emptySubtext}>长按一条消息，放进这里。</Text>
          </View>
        }
      />

      <Modal
        visible={Boolean(selectedFavorite)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSelectedFavorite(null)}
      >
        <View style={styles.detailScreen}>
          <View style={styles.detailHeader}>
            <View>
              <Text style={styles.detailRole}>
                {selectedFavorite?.role === "assistant" ? "小C" : "我"}
              </Text>
              <Text style={styles.detailDate}>
                {selectedFavorite
                  ? formatFavoriteDate(selectedFavorite.createdAt)
                  : ""}
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.detailClose,
                pressed && styles.detailClosePressed,
              ]}
              onPress={() => setSelectedFavorite(null)}
            >
              <Text style={styles.detailCloseText}>完成</Text>
            </Pressable>
          </View>

          <ScrollView
            style={styles.detailScroll}
            contentContainerStyle={styles.detailContent}
            showsVerticalScrollIndicator={false}
          >
            {selectedFavorite?.role === "assistant" ? (
              <MessageMarkdown text={selectedFavorite.text} variant="detail" />
            ) : (
              <Text style={styles.detailText}>{selectedFavorite?.text || ""}</Text>
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#FBF8F3",
  },

  header: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(120,120,128,0.08)",
  },

  backText: {
    fontSize: 32,
    lineHeight: 34,
    color: "#555",
  },

  title: {
    fontSize: 18,
    fontWeight: "600",
    color: "#4B4643",
  },

  headerSpacer: {
    width: 36,
    height: 36,
  },

  scroll: {
    flex: 1,
  },

  content: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 52,
  },

  emptyContent: {
    flexGrow: 1,
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
    paddingHorizontal: 17,
    paddingVertical: 14,
    borderRadius: 19,
    marginBottom: 10,
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
    marginBottom: 8,
  },

  cardMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  role: {
    fontSize: 13,
    color: "#A69D98",
  },

  date: {
    fontSize: 13,
    color: "#B8B0AA",
  },

  chevron: {
    marginTop: -1,
    fontSize: 19,
    lineHeight: 20,
    color: "#C6BEB8",
  },

  text: {
    fontSize: 17,
    lineHeight: 25,
    color: "#3F3A37",
  },

  detailScreen: {
    flex: 1,
    backgroundColor: "#FBF8F3",
  },

  detailHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingTop: 26,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(120,110,104,0.12)",
  },

  detailRole: {
    fontSize: 15,
    color: "#817873",
  },

  detailDate: {
    marginTop: 4,
    fontSize: 13,
    color: "#B8B0AA",
  },

  detailClose: {
    minWidth: 52,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    backgroundColor: "rgba(120,120,128,0.08)",
  },

  detailClosePressed: {
    backgroundColor: "rgba(120,120,128,0.14)",
  },

  detailCloseText: {
    fontSize: 15,
    color: "#625B57",
  },

  detailScroll: {
    flex: 1,
  },

  detailContent: {
    paddingHorizontal: 24,
    paddingTop: 28,
    paddingBottom: 52,
  },

  detailText: {
    fontSize: 19,
    lineHeight: 31,
    color: "#3F3A37",
  },
});
