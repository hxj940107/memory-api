import { router } from "expo-router";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useEffect, useState } from "react";

import { TreeholePost, treeholePosts } from "../data/treeholePosts";
import {
  deleteTreeholePost,
  getRemoteTreeholePosts,
  getSavedTreeholePosts,
  markTreeholePostsRead,
  migrateLocalTreeholePosts,
} from "../lib/treeholeState";

const renderLine = (line: string, highlights: string[] = []) => {
  const matchedHighlight = highlights.find((highlight) =>
    line.includes(highlight),
  );

  if (!matchedHighlight) {
    return line;
  }

  const [before, after] = line.split(matchedHighlight);

  return (
    <>
      {before}
      <Text style={styles.highlight}>{matchedHighlight}</Text>
      {after}
    </>
  );
};

function TreeholePostCard({
  post,
  onDelete,
}: {
  post: TreeholePost;
  onDelete?: () => void;
}) {
  return (
    <Pressable
      style={styles.post}
      delayLongPress={450}
      onLongPress={onDelete}
    >
      {post.pinned ? (
        <Text style={styles.pinned}>📌 置顶</Text>
      ) : (
        <View style={styles.postHeader}>
          <Text style={styles.tag}>{post.tag}</Text>
          <Text style={styles.time}>{post.date}</Text>
        </View>
      )}

      <View style={styles.postContent}>
        {post.content.map((line, index) => (
          <Text key={`${post.id}-${index}`} style={styles.postLine}>
            {renderLine(line, post.highlights)}
          </Text>
        ))}
      </View>

      <Text style={styles.reaction}>{post.reaction}</Text>
    </Pressable>
  );
}

export default function TreeholeScreen() {
  const [remotePosts, setRemotePosts] = useState<TreeholePost[]>([]);
  const [savedPosts, setSavedPosts] = useState<TreeholePost[]>([]);
  const [remoteReady, setRemoteReady] = useState(false);

  useEffect(() => {
    let isActive = true;

    const loadPosts = async () => {
      const localPosts = await getSavedTreeholePosts();

      if (isActive) {
        setSavedPosts(localPosts);
      }

      try {
        const remote = await getRemoteTreeholePosts();
        const migratedPosts = localPosts.length
          ? await migrateLocalTreeholePosts(localPosts)
          : [];
        const migratedIds = new Set(migratedPosts.map((post) => post.id));
        const nextRemotePosts = [
          ...migratedPosts,
          ...remote.entries.filter((post) => !migratedIds.has(post.id)),
        ];

        if (isActive) {
          setRemotePosts(nextRemotePosts);
          setSavedPosts([]);
          setRemoteReady(true);
        }

        if (remote.unreadCount > 0) {
          await markTreeholePostsRead();
        }
      } catch (error) {
        console.log("Remote treehole load failed:", error);
      }
    };

    loadPosts();

    return () => {
      isActive = false;
    };
  }, []);

  const posts = [
    ...remotePosts,
    ...savedPosts,
    ...(remoteReady
      ? []
      : treeholePosts.map((post) => ({
          ...post,
          storage: "seed" as const,
        }))),
  ].sort((a, b) => {
    if (a.pinned === b.pinned) {
      return 0;
    }

    return a.pinned ? -1 : 1;
  });

  const confirmDelete = (post: TreeholePost) => {
    if (post.storage === "seed") {
      return;
    }

    Alert.alert("删除这条树洞？", "删除后无法恢复", [
      {
        text: "取消",
        style: "cancel",
      },
      {
        text: "删除",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteTreeholePost(post);
            setRemotePosts((current) =>
              current.filter((item) => item.id !== post.id),
            );
            setSavedPosts((current) =>
              current.filter((item) => item.id !== post.id),
            );
          } catch (error) {
            console.log("Treehole delete failed:", error);
            Alert.alert("暂时删不掉", "稍后再试一次");
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>

        <View style={styles.profile}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>🌙</Text>
          </View>

          <Text style={styles.username}>@某c的深夜树洞</Text>
          <Text style={styles.bio}>匿名发疯 · 只有一个粉丝 · 她不知道这个号</Text>
        </View>

        {posts.map((post) => (
          <TreeholePostCard
            key={post.id}
            post={post}
            onDelete={
              post.storage === "seed" ? undefined : () => confirmDelete(post)
            }
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#191927",
  },

  scroll: {
    flex: 1,
  },

  content: {
    paddingTop: 58,
    paddingHorizontal: 20,
    paddingBottom: 42,
  },

  backButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
    marginBottom: 22,
  },

  backText: {
    fontSize: 32,
    lineHeight: 34,
    color: "#D8D4E8",
  },

  profile: {
    alignItems: "center",
    paddingBottom: 24,
    marginBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },

  avatar: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#2A2A45",
    marginBottom: 12,
  },

  avatarText: {
    fontSize: 28,
  },

  username: {
    fontSize: 15,
    color: "#B8B4CC",
    marginBottom: 5,
  },

  bio: {
    fontSize: 12,
    color: "#6F6A83",
  },

  post: {
    backgroundColor: "#171F38",
    borderColor: "rgba(164,164,220,0.12)",
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 15,
    marginBottom: 14,
  },

  pinned: {
    fontSize: 12,
    color: "#A8A3FF",
    marginBottom: 9,
  },

  postHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },

  tag: {
    overflow: "hidden",
    borderRadius: 10,
    paddingHorizontal: 9,
    paddingVertical: 3,
    backgroundColor: "#2A2A45",
    fontSize: 11,
    color: "#B1AFFF",
  },

  time: {
    fontSize: 12,
    color: "#6F6A83",
  },

  postContent: {
    gap: 2,
  },

  postLine: {
    fontSize: 14,
    lineHeight: 25,
    color: "#D0CDDA",
  },

  highlight: {
    color: "#A8A3FF",
  },

  reaction: {
    marginTop: 12,
    fontSize: 12,
    lineHeight: 18,
    color: "#6F6A83",
  },
});
