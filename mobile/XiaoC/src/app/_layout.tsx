import "react-native-gesture-handler";

import { router, Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Image } from "expo-image";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as Notifications from "expo-notifications";
import { useEffect, useRef, useState } from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import {
  openNotificationResponse,
  getXiaoCNotificationTarget,
  refreshPushRegistrationIfEnabled,
} from "../lib/pushNotifications";
import { getAccountSettings } from "../lib/accountSettings";
import { syncClientPreferences } from "../lib/cloudPreferences";

const BACKGROUND_AUTO_LOCK_DELAY_MS = 60 * 60 * 1000;
const IN_APP_BANNER_DURATION_MS = 4500;

type InAppMessageBanner = {
  title: string;
  body: string;
  target:
    | { kind: "message"; conversationId: string }
    | { kind: "moments" }
    | { kind: "treehole" };
};

export default function RootLayout() {
  const pathname = usePathname();
  const [inAppBanner, setInAppBanner] = useState<InAppMessageBanner | null>(null);
  const backgroundedAtRef = useRef<number | null>(null);
  const pathnameRef = useRef(pathname);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    pathnameRef.current = pathname;
    if (
      pathname === "/chat" || pathname === "/" ||
      (pathname.startsWith("/moments") && inAppBanner?.target.kind === "moments") ||
      (pathname.startsWith("/treehole") && inAppBanner?.target.kind === "treehole")
    ) {
      setInAppBanner(null);
    }
  }, [pathname]);

  useEffect(() => {
    syncClientPreferences().catch((error) => {
      console.log("Client preferences startup sync failed:", error);
    });

    refreshPushRegistrationIfEnabled().catch((error) => {
      console.log("Push registration refresh failed:", error);
    });

    Notifications.getLastNotificationResponseAsync()
      .then(async (response) => {
        if (response) {
          await openNotificationResponse(response);
        }
      })
      .catch(() => {});

    const subscription = Notifications.addNotificationResponseReceivedListener(
      openNotificationResponse,
    );
    const receivedSubscription = Notifications.addNotificationReceivedListener(
      (notification) => {
        const target = getXiaoCNotificationTarget(
          notification.request.content.data,
        );
        const currentPath = pathnameRef.current;

        if (!target) return;
        if (target.kind === "message" && (currentPath === "/chat" || currentPath === "/")) return;
        if (target.kind === "moments" && currentPath.startsWith("/moments")) return;
        if (target.kind === "treehole" && currentPath.startsWith("/treehole")) return;

        if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
        setInAppBanner({
          title: notification.request.content.title || "小C",
          body: notification.request.content.body || "有一条新动态",
          target: target.kind === "message"
            ? { kind: "message", conversationId: target.conversationId }
            : target,
        });
        bannerTimerRef.current = setTimeout(() => {
          setInAppBanner(null);
          bannerTimerRef.current = null;
        }, IN_APP_BANNER_DURATION_MS);
      },
    );
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "inactive" || state === "background") {
        if (!backgroundedAtRef.current) backgroundedAtRef.current = Date.now();
        return;
      }

      if (state === "active") {
        const elapsed = backgroundedAtRef.current
          ? Date.now() - backgroundedAtRef.current
          : 0;
        backgroundedAtRef.current = null;
        getAccountSettings()
          .then((account) => {
            if (
              account.hasPassword &&
              elapsed >= BACKGROUND_AUTO_LOCK_DELAY_MS
            ) {
              router.replace("/");
            }
          })
          .catch((error) => {
            console.log("Background lock check failed:", error);
          });
      }
    });
    return () => {
      subscription.remove();
      receivedSubscription.remove();
      appStateSubscription.remove();
      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    };
  }, []);

  const openInAppBanner = () => {
    if (!inAppBanner) return;
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = null;
    const target = inAppBanner.target;
    setInAppBanner(null);
    if (target.kind === "message") {
      router.push({ pathname: "/chat", params: { conversation_id: target.conversationId } });
    } else if (target.kind === "moments") {
      router.push("/moments");
    } else {
      router.push("/treehole");
    }
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="auto" />

      <Stack
        screenOptions={{
          headerShown: false,
        }}
      />
      {inAppBanner && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${inAppBanner.title}：${inAppBanner.body}`}
          onPress={openInAppBanner}
          style={styles.inAppBanner}
        >
          <View style={styles.inAppAvatar}>
            <Image
              source={require("../../assets/xiaoc-crescent.svg")}
              style={styles.inAppAvatarMark}
              contentFit="contain"
            />
          </View>
          <View style={styles.inAppBannerCopy}>
            <Text style={styles.inAppBannerTitle} numberOfLines={1}>
              {inAppBanner.title}
            </Text>
            <Text style={styles.inAppBannerBody} numberOfLines={2}>
              {inAppBanner.body}
            </Text>
          </View>
        </Pressable>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  inAppBanner: {
    position: "absolute",
    top: Platform.OS === "ios" ? 54 : 18,
    left: 12,
    right: 12,
    zIndex: 100,
    elevation: 10,
    minHeight: 66,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderRadius: 17,
    backgroundColor: "rgba(250, 250, 248, 0.97)",
    shadowColor: "#574F4B",
    shadowOpacity: 0.14,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
  },
  inAppAvatar: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#EEEAE5",
  },
  inAppAvatarMark: {
    width: 21,
    height: 21,
  },
  inAppBannerCopy: {
    flex: 1,
    marginLeft: 11,
  },
  inAppBannerTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#3D3937",
  },
  inAppBannerBody: {
    marginTop: 2,
    fontSize: 14,
    lineHeight: 19,
    color: "#625C58",
  },
});
