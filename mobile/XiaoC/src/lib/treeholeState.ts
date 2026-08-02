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

export function getTreeholeDraftKey(draft: TreeholeDraft) {
  return [
    draft.date || "",
    draft.tag || "",
    ...(draft.content || []),
    ...(draft.highlights || []),
    draft.reaction || "",
  ]
    .join("｜")
    .replace(/\s+/g, " ")
    .trim();
}

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
  const draftKey = getTreeholeDraftKey(draft);
  const alreadySaved = currentPosts.some(
    (post) =>
      getTreeholeDraftKey({
        tag: post.tag,
        date: post.date,
        content: post.content,
        highlights: post.highlights || [],
        reaction: post.reaction,
      }) === draftKey,
  );

  if (alreadySaved) {
    return currentPosts[0];
  }

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

export async function isTreeholeDraftSaved(draft: TreeholeDraft) {
  const currentPosts = await getSavedTreeholePosts();
  const draftKey = getTreeholeDraftKey(draft);

  return currentPosts.some(
    (post) =>
      getTreeholeDraftKey({
        tag: post.tag,
        date: post.date,
        content: post.content,
        highlights: post.highlights || [],
        reaction: post.reaction,
      }) === draftKey,
  );
}
