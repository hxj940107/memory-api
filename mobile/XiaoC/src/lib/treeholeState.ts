import AsyncStorage from "@react-native-async-storage/async-storage";

import { TreeholePost } from "../data/treeholePosts";
import { APP_USER_ID, apiJson, postJson } from "../config/api";

const SAVED_TREEHOLE_POSTS_KEY = "saved_treehole_posts";
const SAVED_TREEHOLE_DRAFT_KEYS_KEY = "saved_treehole_draft_keys";

export type TreeholeDraft = {
  type?: "treehole_draft";
  tag?: string;
  date?: string;
  content: string[];
  highlights?: string[];
  reaction?: string;
};

type TreeholeResponse = {
  entries?: TreeholePost[];
  unreadCount?: number;
};

type TreeholeCreateResponse = {
  entry?: TreeholePost;
};

type TreeholeNudgeResponse = {
  success?: boolean;
  written?: number;
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

async function rememberSavedTreeholeDraft(draft: TreeholeDraft) {
  const raw = await AsyncStorage.getItem(SAVED_TREEHOLE_DRAFT_KEYS_KEY);
  let currentKeys: unknown = [];

  if (raw) {
    try {
      currentKeys = JSON.parse(raw);
    } catch {
      currentKeys = [];
    }
  }
  const draftKey = getTreeholeDraftKey(draft);
  const nextKeys = Array.isArray(currentKeys)
    ? Array.from(new Set([draftKey, ...currentKeys])).slice(0, 100)
    : [draftKey];

  await AsyncStorage.setItem(
    SAVED_TREEHOLE_DRAFT_KEYS_KEY,
    JSON.stringify(nextKeys),
  );
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

    return posts.map((post) => ({
      ...post,
      storage: "local" as const,
    })) as TreeholePost[];
  } catch {
    return [];
  }
}

export async function getRemoteTreeholePosts() {
  const response = await apiJson<TreeholeResponse>("/api/memory", {
    query: {
      type: "treehole",
      user_id: APP_USER_ID,
    },
  });

  return {
    entries: (response.entries || []).map((entry) => ({
      ...entry,
      storage: "remote" as const,
    })),
    unreadCount: Number(response.unreadCount || 0),
  };
}

export async function markTreeholePostsRead() {
  return postJson("/api/memory", {
    type: "treehole",
    action: "mark_read",
    user_id: APP_USER_ID,
  });
}

export async function nudgeTreeholeUpdate() {
  const response = await postJson<TreeholeNudgeResponse>("/api/memory", {
    type: "treehole",
    action: "nudge",
    user_id: APP_USER_ID,
  });

  return Number(response.written || 0);
}

export async function migrateLocalTreeholePosts(posts: TreeholePost[]) {
  const migrated: Array<TreeholePost | null> = await Promise.all(
    posts.map(async (post) => {
      const response = await postJson<TreeholeCreateResponse>("/api/memory", {
        type: "treehole",
        user_id: APP_USER_ID,
        tag: post.tag,
        date: post.date,
        content: post.content,
        highlights: post.highlights || [],
        reaction: post.reaction,
        pinned: Boolean(post.pinned),
        source: "legacy",
        legacyKey: `local:${post.id}`,
        seen: true,
      });

      return response.entry
        ? {
            ...response.entry,
            storage: "remote" as const,
          } satisfies TreeholePost
        : null;
    }),
  );

  await AsyncStorage.removeItem(SAVED_TREEHOLE_POSTS_KEY);

  return migrated.filter((post): post is TreeholePost => post !== null);
}

export async function deleteTreeholePost(post: TreeholePost) {
  if (post.storage === "remote") {
    return apiJson("/api/memory", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "treehole",
        user_id: APP_USER_ID,
        id: post.id,
      }),
    });
  }

  if (post.storage === "local") {
    const currentPosts = await getSavedTreeholePosts();
    const nextPosts = currentPosts.filter((item) => item.id !== post.id);

    await AsyncStorage.setItem(
      SAVED_TREEHOLE_POSTS_KEY,
      JSON.stringify(nextPosts.map(({ storage, ...item }) => item)),
    );
  }
}

export async function setTreeholePostPinned(
  post: TreeholePost,
  pinned: boolean,
) {
  if (post.storage === "remote") {
    return postJson("/api/memory", {
      type: "treehole",
      action: "set_pinned",
      user_id: APP_USER_ID,
      id: post.id,
      pinned,
    });
  }

  if (post.storage === "local") {
    const currentPosts = await getSavedTreeholePosts();
    const nextPosts = currentPosts.map((item) => ({
      ...item,
      pinned: item.id === post.id ? pinned : pinned ? false : item.pinned,
    }));

    await AsyncStorage.setItem(
      SAVED_TREEHOLE_POSTS_KEY,
      JSON.stringify(nextPosts.map(({ storage, ...item }) => item)),
    );
  }
}

export async function saveTreeholeDraft(draft: TreeholeDraft) {
  try {
    const response = await postJson<TreeholeCreateResponse>("/api/memory", {
      type: "treehole",
      user_id: APP_USER_ID,
      tag: draft.tag,
      date: draft.date,
      content: draft.content,
      highlights: draft.highlights || [],
      reaction: draft.reaction,
      source: "manual",
    });

    if (response.entry) {
      await rememberSavedTreeholeDraft(draft);

      return {
        ...response.entry,
        storage: "remote" as const,
      };
    }
  } catch (error) {
    console.log("Remote treehole save failed, using local fallback:", error);
  }

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
    reaction: draft.reaction || "🌙 偷偷偏心 · ❤️ 1",
    storage: "local",
  };

  await AsyncStorage.setItem(
    SAVED_TREEHOLE_POSTS_KEY,
    JSON.stringify(
      [post, ...currentPosts].map(({ storage, ...item }) => item),
    ),
  );

  return post;
}

export async function isTreeholeDraftSaved(draft: TreeholeDraft) {
  const [currentPosts, savedKeysRaw] = await Promise.all([
    getSavedTreeholePosts(),
    AsyncStorage.getItem(SAVED_TREEHOLE_DRAFT_KEYS_KEY),
  ]);
  const draftKey = getTreeholeDraftKey(draft);

  if (savedKeysRaw) {
    try {
      const savedKeys = JSON.parse(savedKeysRaw);

      if (Array.isArray(savedKeys) && savedKeys.includes(draftKey)) {
        return true;
      }
    } catch {}
  }

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
