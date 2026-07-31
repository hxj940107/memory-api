import AsyncStorage from "@react-native-async-storage/async-storage";

import { APP_USER_ID, apiJson, postJson } from "../config/api";

const LAST_CONVERSATION_KEY = "conversation_id";

type UserStateResponse = {
  last_conversation: string | null;
};

type ConversationListItem = {
  id: string;
};

export async function getLocalLastConversation() {
  return AsyncStorage.getItem(LAST_CONVERSATION_KEY);
}

export async function saveLocalLastConversation(conversationId: string) {
  await AsyncStorage.setItem(LAST_CONVERSATION_KEY, conversationId);
}

export async function clearLocalLastConversation() {
  await AsyncStorage.removeItem(LAST_CONVERSATION_KEY);
}

export async function saveLastConversation(conversationId: string) {
  await saveLocalLastConversation(conversationId);

  try {
    await postJson(
      `/api/user-state?user_id=${encodeURIComponent(APP_USER_ID)}`,
      {
        user_id: APP_USER_ID,
        last_conversation: conversationId,
      },
    );
  } catch (error) {
    console.log("Cloud conversation save failed:", error);
  }
}

export async function clearLastConversation() {
  await clearLocalLastConversation();

  try {
    await postJson(
      `/api/user-state?user_id=${encodeURIComponent(APP_USER_ID)}`,
      {
        user_id: APP_USER_ID,
        last_conversation: null,
      },
    );
  } catch (error) {
    console.log("Cloud conversation clear failed:", error);
  }
}

export async function getCloudLastConversation() {
  const state = await apiJson<UserStateResponse>("/api/user-state", {
    query: {
      user_id: APP_USER_ID,
    },
  });

  return state.last_conversation;
}

async function getConversationList() {
  return apiJson<ConversationListItem[]>("/api/conversations", {
    query: {
      user_id: APP_USER_ID,
    },
  });
}

export async function getBestLastConversation() {
  const localId = await getLocalLastConversation();

  try {
    const cloudId = await getCloudLastConversation();
    const conversations = await getConversationList();
    const ids = new Set(conversations.map((item) => item.id));

    if (cloudId && ids.has(cloudId)) {
      await saveLocalLastConversation(cloudId);
      return cloudId;
    }

    if (localId && ids.has(localId)) {
      await saveLastConversation(localId);
      return localId;
    }

    const latestConversation = conversations[0];

    if (latestConversation) {
      await saveLastConversation(latestConversation.id);
      return latestConversation.id;
    }

    await clearLastConversation();
    return null;
  } catch (error) {
    console.log("Cloud conversation restore failed:", error);
  }

  return localId;
}
