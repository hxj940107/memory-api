import { router, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useState } from "react";

import { APP_USER_ID, apiJson } from "../../config/api";

const parseList = (value?: string | string[]) => {
  const raw = Array.isArray(value) ? value[0] : value;

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

const formatDate = (value?: string | string[]) => {
  const raw = Array.isArray(value) ? value[0] : value;

  if (!raw) {
    return "";
  }

  const date = new Date(raw);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(date)
    .replaceAll("/", ".");
};

const normalizeText = (value?: string | string[]) => {
  const raw = Array.isArray(value) ? value[0] : value;

  return String(raw || "").trim();
};

export default function WeMemoryDetailScreen() {
  const params = useLocalSearchParams();
  const id = normalizeText(params.id);
  const title = normalizeText(params.title) || "这条记忆";
  const initialContent = normalizeText(params.content);
  const tags = parseList(params.tags);
  const domains = parseList(params.domains);
  const [content, setContent] = useState(initialContent);
  const [editing, setEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(initialContent);
  const [pinned, setPinned] = useState(normalizeText(params.pinned) === "1");
  const [saving, setSaving] = useState(false);
  const date = formatDate(params.lastActiveAt || params.createdAt);
  const chips = [...new Set([...domains, ...tags].filter(Boolean))];

  const copyMemory = async () => {
    await Clipboard.setStringAsync(content || title);
  };

  const startEditing = () => {
    if (saving) return;
    setDraftContent(content);
    setEditing(true);
  };

  const cancelEditing = () => {
    if (saving) return;
    setDraftContent(content);
    setEditing(false);
  };

  const saveEditing = async () => {
    if (!id || saving) return;

    const nextContent = draftContent.trim();
    if (!nextContent) {
      Alert.alert("还没有内容", "记忆正文不能为空。");
      return;
    }

    setSaving(true);
    try {
      await apiJson("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "we",
          user_id: APP_USER_ID,
          action: "update",
          bucket_id: id,
          content: nextContent,
        }),
      });

      setContent(nextContent);
      setDraftContent(nextContent);
      setEditing(false);
    } catch (error) {
      console.log("Update memory failed:", error);
      Alert.alert("保存失败", "这条记忆暂时没有改好，编辑内容还为你保留着。");
    } finally {
      setSaving(false);
    }
  };

  const togglePin = async () => {
    if (!id || saving) {
      return;
    }

    const nextPinned = !pinned;

    setSaving(true);

    try {
      await apiJson("/api/memory", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "we",
          user_id: APP_USER_ID,
          action: "pin",
          bucket_id: id,
          pinned: nextPinned,
        }),
      });

      setPinned(nextPinned);
    } catch (error) {
      console.log("Pin memory failed:", error);
      Alert.alert("操作失败", "这条记忆暂时没有改好，等一下再试。");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = () => {
    if (!id || saving) {
      return;
    }

    Alert.alert(
      "删除这条记忆？",
      "删除后，小C可能不再记得这件事。",
      [
        {
          text: "取消",
          style: "cancel",
        },
        {
          text: "删除",
          style: "destructive",
          onPress: deleteMemory,
        },
      ],
    );
  };

  const deleteMemory = async () => {
    setSaving(true);

    try {
      await apiJson("/api/memory", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "we",
          user_id: APP_USER_ID,
          action: "delete",
          bucket_id: id,
        }),
      });

      router.back();
    } catch (error) {
      console.log("Delete memory failed:", error);
      Alert.alert("删除失败", "这条记忆暂时没有删掉，等一下再试。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>

        <Text style={styles.gentleLine}>这一点，我替我们收好了。</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.card}>
          <View style={styles.metaRow}>
            <Text style={styles.metaText}>{pinned ? "📌 最重要" : "记忆"}</Text>
            {!!date && <Text style={styles.metaText}>{date}</Text>}
          </View>

          <Text style={styles.title}>{title}</Text>

          {chips.length > 0 && (
            <View style={styles.chipRow}>
              {chips.map((chip) => (
                <Text key={`${id}-chip-${chip}`} style={styles.chip}>
                  {chip}
                </Text>
              ))}
            </View>
          )}

          <View style={styles.divider} />

          {editing ? (
            <TextInput
              style={styles.contentInput}
              value={draftContent}
              onChangeText={setDraftContent}
              multiline
              autoFocus
              maxLength={50000}
              textAlignVertical="top"
              editable={!saving}
            />
          ) : (
            <Text style={styles.contentText}>
              {content || "这条记忆暂时没有更多内容。"}
            </Text>
          )}

          <View style={styles.actionRow}>
            {editing ? (
              <>
                <Pressable
                  style={({ pressed }) => [
                    styles.actionButton,
                    pressed && styles.actionButtonPressed,
                    saving && styles.actionButtonDisabled,
                  ]}
                  onPress={cancelEditing}
                  disabled={saving}
                >
                  <Text style={styles.actionText}>取消</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.actionButton,
                    styles.saveButton,
                    pressed && styles.saveButtonPressed,
                    saving && styles.actionButtonDisabled,
                  ]}
                  onPress={saveEditing}
                  disabled={saving}
                >
                  <Text style={styles.saveText}>{saving ? "保存中" : "完成"}</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Pressable
                  style={({ pressed }) => [
                    styles.actionButton,
                    pressed && styles.actionButtonPressed,
                  ]}
                  onPress={copyMemory}
                >
                  <Text style={styles.actionText}>复制</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.actionButton,
                    pressed && styles.actionButtonPressed,
                  ]}
                  onPress={startEditing}
                >
                  <Text style={styles.actionText}>编辑</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.actionButton,
                    pressed && styles.actionButtonPressed,
                    saving && styles.actionButtonDisabled,
                  ]}
                  onPress={togglePin}
                  disabled={saving}
                >
                  <Text style={styles.actionText}>
                    {pinned ? "取消钉选" : "钉选"}
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.actionButton,
                    styles.deleteButton,
                    pressed && styles.deleteButtonPressed,
                    saving && styles.actionButtonDisabled,
                  ]}
                  onPress={confirmDelete}
                  disabled={saving}
                >
                  <Text style={styles.deleteText}>删除</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#FBF8F3",
  },

  header: {
    paddingTop: 58,
    paddingHorizontal: 24,
    paddingBottom: 10,
  },

  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(120,120,128,0.08)",
    marginBottom: 26,
  },

  backText: {
    fontSize: 32,
    lineHeight: 34,
    color: "#555",
  },

  gentleLine: {
    paddingHorizontal: 2,
    fontSize: 15,
    lineHeight: 22,
    color: "#8A8A8F",
  },

  scroll: {
    flex: 1,
  },

  content: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 46,
  },

  card: {
    borderRadius: 28,
    paddingHorizontal: 24,
    paddingVertical: 24,
    backgroundColor: "rgba(255,255,255,0.86)",
    shadowColor: "#B8AFA7",
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: {
      width: 0,
      height: 8,
    },
  },

  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 18,
  },

  metaText: {
    fontSize: 13,
    color: "#A69D98",
  },

  title: {
    fontSize: 22,
    lineHeight: 30,
    color: "#363230",
    fontWeight: "600",
  },

  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 16,
  },

  chip: {
    overflow: "hidden",
    borderRadius: 13,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "rgba(120,120,128,0.08)",
    fontSize: 12,
    color: "#8A817C",
  },

  divider: {
    height: 1,
    marginVertical: 22,
    backgroundColor: "rgba(120,120,128,0.12)",
  },

  contentText: {
    fontSize: 17,
    lineHeight: 30,
    color: "#4A4542",
  },

  contentInput: {
    minHeight: 180,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "rgba(120,120,128,0.06)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(120,120,128,0.18)",
    fontSize: 17,
    lineHeight: 30,
    color: "#4A4542",
  },

  actionRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 26,
  },

  actionButton: {
    flex: 1,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(120,120,128,0.08)",
  },

  actionButtonPressed: {
    backgroundColor: "rgba(120,120,128,0.14)",
  },

  actionButtonDisabled: {
    opacity: 0.45,
  },

  actionText: {
    fontSize: 15,
    color: "#5C5753",
  },

  saveButton: {
    backgroundColor: "#4F7DF3",
  },

  saveButtonPressed: {
    backgroundColor: "#416DDB",
  },

  saveText: {
    fontSize: 15,
    color: "#FFFFFF",
    fontWeight: "600",
  },

  deleteButton: {
    backgroundColor: "rgba(255,59,48,0.08)",
  },

  deleteButtonPressed: {
    backgroundColor: "rgba(255,59,48,0.14)",
  },

  deleteText: {
    fontSize: 15,
    color: "#D94A42",
  },
});
