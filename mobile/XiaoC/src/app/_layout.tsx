import "react-native-gesture-handler";

import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as Notifications from "expo-notifications";
import { useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";

import {
  openNotificationResponse,
  refreshPushRegistrationIfEnabled,
} from "../lib/pushNotifications";
import { getAccountSettings } from "../lib/accountSettings";
import { syncClientPreferences } from "../lib/cloudPreferences";

const BACKGROUND_AUTO_LOCK_DELAY_MS = 10 * 60 * 1000;

export default function RootLayout() {
  const [privacyCovered, setPrivacyCovered] = useState(false);
  const backgroundedAtRef = useRef<number | null>(null);

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
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "inactive" || state === "background") {
        if (!backgroundedAtRef.current) backgroundedAtRef.current = Date.now();
        setPrivacyCovered(true);
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
          .finally(() => setPrivacyCovered(false));
      }
    });
    return () => {
      subscription.remove();
      appStateSubscription.remove();
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="auto" />

      <Stack
        screenOptions={{
          headerShown: false,
        }}
      />
      {privacyCovered && (
        <View style={styles.privacyCover}>
          <Text style={styles.privacyMark}>小C</Text>
        </View>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  privacyCover: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FAFAF8",
  },
  privacyMark: {
    fontSize: 28,
    color: "#B2AAA5",
    letterSpacing: 2,
  },
});
