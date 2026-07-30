import AsyncStorage from "@react-native-async-storage/async-storage";

import { APP_USER_ID, apiJson, postJson } from "../config/api";

const LAST_CONVERSATION_KEY = "conversation_id";

type UserStateResponse = {
  last_conversation: string | null;
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

export async function getBestLastConversation() {
  try {
    const cloudId = await getCloudLastConversation();

    if (cloudId) {
      await saveLocalLastConversation(cloudId);
      return cloudId;
    }
  } catch (error) {
    console.log("Cloud conversation restore failed:", error);
  }

  return getLocalLastConversation();
}
