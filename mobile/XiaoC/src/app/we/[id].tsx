import { router, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useEffect, useRef, useState } from "react";

import { APP_USER_ID, apiJson } from "../../config/api";

const CATEGORIES = ["关于你", "我们之间", "一起经历过", "相处方式"] as const;
type MemoryCategory = typeof CATEGORIES[number];

const normalizeText = (value?: string | string[]) =>
  String(Array.isArray(value) ? value[0] : value || "").trim();

export default function WeMemoryDetailScreen() {
  const params = useLocalSearchParams();
  const [memoryId, setMemoryId] = useState(normalizeText(params.id));
  const initialContent = normalizeText(params.content);
  const initialCategory = normalizeText(params.category) as MemoryCategory;
  const [content, setContent] = useState(initialContent);
  const [category, setCategory] = useState<MemoryCategory>(
    CATEGORIES.includes(initialCategory) ? initialCategory : "关于你",
  );
  const [revision, setRevision] = useState(Math.max(1, Number(normalizeText(params.revision)) || 1));
  const [editing, setEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(initialContent);
  const [draftCategory, setDraftCategory] = useState<MemoryCategory>(category);
  const [pinned, setPinned] = useState(normalizeText(params.pinned) === "1");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinAvailable = normalizeText(params.pinAvailable) === "1";
  const editAvailable = normalizeText(params.editAvailable) === "1";

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  const showNotice = (text: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(""), 2200);
  };

  const startEditing = () => {
    if (saving) return;
    setDraftContent(content);
    setDraftCategory(category);
    setEditing(true);
  };

  const cancelEditing = () => {
    if (saving) return;
    setDraftContent(content);
    setDraftCategory(category);
    setEditing(false);
  };

  const saveEditing = async () => {
    if (!memoryId || saving) return;
    const nextContent = draftContent.trim();
    if (!nextContent) {
      Alert.alert("还没有内容", "记忆正文不能为空。");
      return;
    }

    setSaving(true);
    try {
      const result = await apiJson<{
        memory_id: string;
        canonical_content: string;
        revision: number;
        pinned: boolean;
      }>("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "we",
          user_id: APP_USER_ID,
          action: "update",
          bucket_id: memoryId,
          content: nextContent,
          category: draftCategory,
          expected_revision: revision,
          idempotency_key: `memory-library:edit:${memoryId}:${Date.now()}`,
        }),
      });

      setMemoryId(result.memory_id);
      setContent(result.canonical_content);
      setDraftContent(result.canonical_content);
      setCategory(draftCategory);
      setRevision(result.revision);
      setPinned(Boolean(result.pinned));
      setEditing(false);
      showNotice("已保存");
    } catch (error) {
      console.log("Update memory failed:", error);
      Alert.alert("保存失败", "这条记忆暂时没有改好，编辑内容还为你保留着。");
    } finally {
      setSaving(false);
    }
  };

  const togglePin = async () => {
    if (!memoryId || saving) return;
    const nextPinned = !pinned;
    setSaving(true);
    try {
      await apiJson("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "we",
          user_id: APP_USER_ID,
          action: "pin",
          bucket_id: memoryId,
          pinned: nextPinned,
          idempotency_key: `memory-library:${nextPinned ? "pin" : "unpin"}:${memoryId}:${Date.now()}`,
        }),
      });
      setPinned(nextPinned);
      showNotice(nextPinned ? "已钉选，新对话开始生效" : "已取消钉选，新对话开始生效");
    } catch (error) {
      console.log("Pin memory failed:", error);
      Alert.alert("操作失败", "这条记忆暂时没有改好，等一下再试。");
    } finally {
      setSaving(false);
    }
  };

  const deleteMemory = async () => {
    setSaving(true);
    try {
      await apiJson("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "we",
          user_id: APP_USER_ID,
          action: "delete",
          bucket_id: memoryId,
          idempotency_key: `memory-library:delete:${memoryId}`,
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

  const confirmDelete = () => {
    if (!memoryId || saving) return;
    Alert.alert("删除这条记忆？", "删除后，小C将不再使用这条记忆。", [
      { text: "取消", style: "cancel" },
      { text: "删除", style: "destructive", onPress: deleteMemory },
    ]);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.card}>
          <View style={styles.metaRow}>
            <Text style={styles.metaText}>{pinned ? "📌 已钉选" : category}</Text>
            {pinned && <Text style={styles.metaText}>{category}</Text>}
          </View>

          {editing ? (
            <>
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
              <Text style={styles.fieldLabel}>分类</Text>
              <View style={styles.categoryRow}>
                {CATEGORIES.map(item => (
                  <Pressable
                    key={item}
                    style={[styles.categoryChip, draftCategory === item && styles.categoryChipSelected]}
                    onPress={() => setDraftCategory(item)}
                    disabled={saving}
                  >
                    <Text style={[styles.categoryText, draftCategory === item && styles.categoryTextSelected]}>{item}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : (
            <Text style={styles.contentText}>{content}</Text>
          )}

          <View style={styles.actionRow}>
            {editing ? (
              <>
                <Pressable style={styles.actionButton} onPress={cancelEditing} disabled={saving}>
                  <Text style={styles.actionText}>取消</Text>
                </Pressable>
                <Pressable style={[styles.actionButton, styles.saveButton]} onPress={saveEditing} disabled={saving}>
                  <Text style={styles.saveText}>{saving ? "保存中" : "完成"}</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Pressable style={styles.actionButton} onPress={() => Clipboard.setStringAsync(content)}>
                  <Text style={styles.actionText}>复制</Text>
                </Pressable>
                {editAvailable && (
                  <Pressable style={styles.actionButton} onPress={startEditing}>
                    <Text style={styles.actionText}>编辑</Text>
                  </Pressable>
                )}
                {pinAvailable && (
                  <Pressable style={styles.actionButton} onPress={togglePin} disabled={saving}>
                    <Text style={styles.actionText}>{pinned ? "取消钉选" : "钉选"}</Text>
                  </Pressable>
                )}
                <Pressable style={[styles.actionButton, styles.deleteButton]} onPress={confirmDelete} disabled={saving}>
                  <Text style={styles.deleteText}>删除</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </ScrollView>

      {!!notice && <View style={styles.toast}><Text style={styles.toastText}>{notice}</Text></View>}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#FBF8F3" },
  header: { paddingTop: 58, paddingHorizontal: 24, paddingBottom: 10 },
  backButton: {
    width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(120,120,128,0.08)",
  },
  backText: { fontSize: 32, lineHeight: 34, color: "#555" },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 46 },
  card: {
    borderRadius: 28, paddingHorizontal: 24, paddingVertical: 24,
    backgroundColor: "rgba(255,255,255,0.86)", shadowColor: "#B8AFA7",
    shadowOpacity: 0.08, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
  },
  metaRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 18 },
  metaText: { fontSize: 13, color: "#A69D98" },
  contentText: { fontSize: 17, lineHeight: 28, color: "#403B38" },
  contentInput: {
    minHeight: 180, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 14,
    backgroundColor: "rgba(251,248,243,0.9)", fontSize: 16, lineHeight: 25, color: "#403B38",
  },
  fieldLabel: { marginTop: 20, marginBottom: 10, fontSize: 13, color: "#A69D98" },
  categoryRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  categoryChip: {
    borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7,
    backgroundColor: "rgba(120,120,128,0.07)",
  },
  categoryChipSelected: { backgroundColor: "rgba(151,128,110,0.16)" },
  categoryText: { fontSize: 13, color: "#8A817C" },
  categoryTextSelected: { color: "#5B514B", fontWeight: "600" },
  actionRow: { marginTop: 26, flexDirection: "row", flexWrap: "wrap", gap: 10 },
  actionButton: {
    borderRadius: 17, paddingHorizontal: 15, paddingVertical: 9,
    backgroundColor: "rgba(120,120,128,0.07)",
  },
  actionText: { fontSize: 14, color: "#6F6762" },
  saveButton: { backgroundColor: "rgba(151,128,110,0.18)" },
  saveText: { fontSize: 14, color: "#554A44", fontWeight: "600" },
  deleteButton: { backgroundColor: "rgba(196,82,82,0.08)" },
  deleteText: { fontSize: 14, color: "#B05A5A" },
  toast: {
    position: "absolute", left: 40, right: 40, bottom: 54, alignItems: "center",
  },
  toastText: {
    overflow: "hidden", borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: "rgba(63,58,55,0.88)", color: "#FFF", fontSize: 13,
  },
});
