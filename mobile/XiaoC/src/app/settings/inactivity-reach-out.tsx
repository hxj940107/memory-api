import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  DEFAULT_INACTIVITY_REACH_OUT_MODE,
  INACTIVITY_REACH_OUT_OPTIONS,
  InactivityReachOutMode,
  getInactivityReachOutMode,
  saveInactivityReachOutMode,
} from "../../lib/proactiveSettings";

export default function InactivityReachOutSettingsScreen() {
  const [mode, setMode] = useState<InactivityReachOutMode>(
    DEFAULT_INACTIVITY_REACH_OUT_MODE,
  );
  const [loading, setLoading] = useState(true);
  const [savingMode, setSavingMode] = useState<InactivityReachOutMode | null>(
    null,
  );

  useEffect(() => {
    let active = true;

    getInactivityReachOutMode()
      .then((nextMode) => {
        if (active) setMode(nextMode);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const selectMode = async (nextMode: InactivityReachOutMode) => {
    if (savingMode || nextMode === mode) return;

    setSavingMode(nextMode);

    try {
      const savedMode = await saveInactivityReachOutMode(nextMode);
      setMode(savedMode);
    } catch {
      Alert.alert("保存失败", "请稍后再试。");
    } finally {
      setSavingMode(null);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>主动联系频率</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.list}>
          {INACTIVITY_REACH_OUT_OPTIONS.map((option, index) => {
            const selected = option.mode === mode;
            const saving = option.mode === savingMode;

            return (
              <Pressable
                key={option.mode}
                style={({ pressed }) => [
                  styles.row,
                  index > 0 && styles.rowBorder,
                  pressed && styles.rowPressed,
                ]}
                disabled={Boolean(savingMode)}
                onPress={() => selectMode(option.mode)}
              >
                <View style={styles.labelBox}>
                  <Text style={styles.label}>{option.label}</Text>
                  <Text style={styles.detail}>（{option.detail}）</Text>
                </View>

                {saving ? (
                  <ActivityIndicator size="small" color="#3578F6" />
                ) : selected ? (
                  <Text style={styles.checkmark}>✓</Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>

        {loading && (
          <ActivityIndicator style={styles.loading} color="#8E8E93" />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#F2F2F7",
  },
  header: {
    paddingTop: 54,
    paddingHorizontal: 18,
    paddingBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(251,248,243,0.96)",
  },
  backButton: {
    width: 42,
    height: 38,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  backText: {
    fontSize: 34,
    lineHeight: 36,
    color: "#3578F6",
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
    color: "#1C1C1E",
  },
  headerSpacer: {
    width: 42,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingTop: 28,
    paddingHorizontal: 18,
    paddingBottom: 40,
  },
  list: {
    overflow: "hidden",
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
  },
  row: {
    minHeight: 64,
    marginLeft: 16,
    paddingRight: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  rowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#C6C6C8",
  },
  rowPressed: {
    opacity: 0.55,
  },
  labelBox: {
    flexDirection: "row",
    alignItems: "baseline",
  },
  label: {
    fontSize: 17,
    color: "#1C1C1E",
  },
  detail: {
    marginLeft: 8,
    fontSize: 14,
    color: "#8E8E93",
  },
  checkmark: {
    fontSize: 20,
    fontWeight: "600",
    color: "#3578F6",
  },
  loading: {
    marginTop: 20,
  },
});
