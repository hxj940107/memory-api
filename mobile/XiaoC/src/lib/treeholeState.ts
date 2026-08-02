import AsyncStorage from "@react-native-async-storage/async-storage";

import { TreeholePost } from "../data/treeholePosts";

const SAVED_TREEHOLE_POSTS_KEY = "saved_treehole_posts";

export type TreeholeDraft = {
  type?: "treehole_draft";
  tag?: string;
  date?: string;
  content: string[];
  highlights?: string[];
  reaction?: string;
};

export async function getSavedTreeholePosts() {
  const raw = await AsyncStorage.getItem(SAVED_TREEHOLE_POSTS_KEY);

  if (!raw) {
    return [];
  }

  try {
    const posts = JSON.parse(raw);

    if (!Array.isArray(posts)) {
      return [];
    }

    return posts as TreeholePost[];
  } catch {
    return [];
  }
}

export async function saveTreeholeDraft(draft: TreeholeDraft) {
  const currentPosts = await getSavedTreeholePosts();
  const post: TreeholePost = {
    id: `local_treehole_${Date.now()}`,
    tag: draft.tag || "树洞",
    date: draft.date,
    content: draft.content,
    highlights: draft.highlights || [],
    reaction: draft.reaction || "🫡 已记录 · ❤️ 1",
  };

  await AsyncStorage.setItem(
    SAVED_TREEHOLE_POSTS_KEY,
    JSON.stringify([post, ...currentPosts]),
  );

  return post;
}
