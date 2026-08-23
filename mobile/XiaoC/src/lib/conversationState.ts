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
    console.log("Cloud conversation restore post user-state failed:", error);
  }
}

export async function clearLastConversation() {
  await clearLocalLastConversation();
}

export async function getCloudLastConversation() {
  try {
    const state = await apiJson<UserStateResponse>("/api/user-state", {
      query: {
        user_id: APP_USER_ID,
      },
    });

    return state.last_conversation;
  } catch (error) {
    console.log("Cloud conversation restore get user-state failed:", error);
    throw error;
  }
}

async function getConversationList() {
  try {
    return await apiJson<ConversationListItem[]>("/api/conversations", {
      query: {
        user_id: APP_USER_ID,
      },
    });
  } catch (error) {
    console.log("Cloud conversation restore get conversations failed:", error);
    throw error;
  }
}

export async function getBestLastConversation() {
  const localId = await getLocalLastConversation();

  try {
    const [cloudId, conversations] = await Promise.all([
      getCloudLastConversation(),
      getConversationList(),
    ]);
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
