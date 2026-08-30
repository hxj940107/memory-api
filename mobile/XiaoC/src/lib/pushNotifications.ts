import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";

import { APP_USER_ID, postJson } from "../config/api";

const PUSH_ENABLED_KEY = "xiaoc:push_enabled";
const PUSH_PREVIEW_KEY = "xiaoc:push_preview_enabled";
const PENDING_NOTIFICATION_CONVERSATION_KEY = "xiaoc:pending_notification_conversation";

export type PushSettings = {
  enabled: boolean;
  previewEnabled: boolean;
};

export type XiaoCNotificationData = {
  type?: unknown;
  conversationId?: unknown;
  messageId?: unknown;
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: false,
    shouldShowList: false,
  }),
});

export async function getLocalPushSettings(): Promise<PushSettings> {
  const [enabled, previewEnabled] = await Promise.all([
    AsyncStorage.getItem(PUSH_ENABLED_KEY),
    AsyncStorage.getItem(PUSH_PREVIEW_KEY),
  ]);
  return {
    enabled: enabled === "1",
    previewEnabled: previewEnabled !== "0",
  };
}

async function getExpoPushToken() {
  if (!Device.isDevice) throw new Error("需要在真实 iPhone 上开启通知。");

  const current = await Notifications.getPermissionsAsync();
  const permission = current.granted
    ? current
    : await Notifications.requestPermissionsAsync();
  if (!permission.granted) throw new Error("没有获得系统通知权限。");

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
  if (!projectId) throw new Error("缺少 EAS Project ID。");

  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

export async function savePushSettings(next: PushSettings) {
  const token = next.enabled ? await getExpoPushToken() : "";

  await postJson("/api/user-state", {
    action: "set-push-notification-settings",
    user_id: APP_USER_ID,
    enabled: next.enabled,
    preview_enabled: next.previewEnabled,
    push_token: token,
  });
  await Promise.all([
    AsyncStorage.setItem(PUSH_ENABLED_KEY, next.enabled ? "1" : "0"),
    AsyncStorage.setItem(PUSH_PREVIEW_KEY, next.previewEnabled ? "1" : "0"),
  ]);
  return next;
}

export async function refreshPushRegistrationIfEnabled() {
  const settings = await getLocalPushSettings();
  if (!settings.enabled) return settings;
  return savePushSettings(settings);
}

export async function openNotificationResponse(response: Notifications.NotificationResponse) {
  const data = response.notification.request.content.data;
  if (data?.type === "xiaoc_message" && typeof data.conversationId === "string") {
    await AsyncStorage.setItem(PENDING_NOTIFICATION_CONVERSATION_KEY, data.conversationId);
    await Notifications.clearLastNotificationResponseAsync();
    router.push("/");
  }
}

export function getXiaoCNotificationTarget(data: XiaoCNotificationData | null | undefined) {
  if (data?.type !== "xiaoc_message" || typeof data.conversationId !== "string") {
    return null;
  }

  return {
    conversationId: data.conversationId,
    messageId: typeof data.messageId === "string" ? data.messageId : null,
  };
}

export async function consumePendingNotificationConversation() {
  const conversationId = await AsyncStorage.getItem(PENDING_NOTIFICATION_CONVERSATION_KEY);
  if (conversationId) {
    await AsyncStorage.removeItem(PENDING_NOTIFICATION_CONVERSATION_KEY);
  }
  return conversationId;
}
