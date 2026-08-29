import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { APP_USER_ID, apiJson, postJson } from "../config/api";
import { XiaoCColors } from "../constants/theme";

export type SharedContext = {
  id: string;
  title: string;
  kind: "reading" | "article" | "project" | "discussion" | "other";
  status: "active" | "archived";
};

type CurrentResponse = { shared_context: SharedContext | null };
type MutationResponse = { shared_context: SharedContext | null; bound: boolean };

const KIND_OPTIONS: Array<{ value: SharedContext["kind"]; label: string }> = [
  { value: "reading", label: "共读" },
  { value: "article", label: "文章" },
  { value: "project", label: "项目" },
  { value: "discussion", label: "讨论" },
  { value: "other", label: "其他" },
];

export function SharedContextBar({
  conversationId,
  openRequestKey = 0,
}: {
  conversationId: string | null;
  openRequestKey?: number;
}) {
  const [current, setCurrent] = useState<SharedContext | null>(null);
  const [items, setItems] = useState<SharedContext[]>([]);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<SharedContext["kind"]>("reading");
  const loadSequenceRef = useRef(0);

  const loadCurrent = async (sequence: number) => {
    if (!conversationId) {
      if (sequence === loadSequenceRef.current) setCurrent(null);
      return;
    }
    try {
      const result = await apiJson<CurrentResponse>("/api/memory", {
        query: {
          type: "shared_context",
          action: "current",
          user_id: APP_USER_ID,
          conversation_id: conversationId,
        },
      });
      if (sequence === loadSequenceRef.current) {
        setCurrent(result.shared_context);
      }
    } catch (error) {
      console.log("Shared Context current load failed:", error);
      if (sequence === loadSequenceRef.current) setCurrent(null);
    }
  };

  useEffect(() => {
    const sequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = sequence;
    setCurrent(null);
    loadCurrent(sequence);
  }, [conversationId]);

  const openPicker = async () => {
    if (!conversationId) return;
    setVisible(true);
    setLoading(true);
    try {
      const result = await apiJson<SharedContext[]>("/api/memory", {
        query: { type: "shared_context", user_id: APP_USER_ID },
      });
      setItems(result.filter((item) => item.status === "active"));
    } catch (error) {
      console.log("Shared Context list load failed:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (openRequestKey > 0) {
      void openPicker();
    }
  }, [openRequestKey]);

  const createAndBind = async () => {
    if (!conversationId || !title.trim()) return;
    setLoading(true);
    try {
      const result = await postJson<MutationResponse>("/api/memory", {
        type: "shared_context",
        action: "create",
        user_id: APP_USER_ID,
        conversation_id: conversationId,
        title: title.trim(),
        kind,
      });
      setCurrent(result.shared_context);
      setTitle("");
      setVisible(false);
    } catch (error) {
      console.log("Shared Context create failed:", error);
    } finally {
      setLoading(false);
    }
  };

  const bind = async (sharedContext: SharedContext) => {
    if (!conversationId) return;
    setLoading(true);
    try {
      const result = await postJson<MutationResponse>("/api/memory", {
        type: "shared_context",
        action: "bind",
        user_id: APP_USER_ID,
        conversation_id: conversationId,
        shared_context_id: sharedContext.id,
      });
      setCurrent(result.shared_context);
      setVisible(false);
    } catch (error) {
      console.log("Shared Context bind failed:", error);
    } finally {
      setLoading(false);
    }
  };

  const unbind = async () => {
    if (!conversationId) return;
    const previous = current;
    setCurrent(null);
    setVisible(false);
    setLoading(true);
    try {
      await postJson("/api/memory", {
        type: "shared_context",
        action: "unbind",
        user_id: APP_USER_ID,
        conversation_id: conversationId,
      });
    } catch (error) {
      console.log("Shared Context unbind failed:", error);
      setCurrent(previous);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {current && (
        <Pressable style={styles.bar} onPress={openPicker}>
          <Text style={styles.title} numberOfLines={1}>正在一起进行 · {current.title}</Text>
        </Pressable>
      )}

      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <Pressable style={styles.backdrop} onPress={() => setVisible(false)} />
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>共同空间</Text>
          {current && (
            <View style={styles.currentRow}>
              <Text style={styles.currentText} numberOfLines={1}>正在进行「{current.title}」</Text>
              <Pressable onPress={unbind}><Text style={styles.closeText}>关闭</Text></Pressable>
            </View>
          )}

          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="给新的共同空间起个名字"
            placeholderTextColor={XiaoCColors.placeholder}
            style={styles.input}
          />
          <View style={styles.kinds}>
            {KIND_OPTIONS.map((option) => (
              <Pressable key={option.value} onPress={() => setKind(option.value)} style={[styles.kind, kind === option.value && styles.kindSelected]}>
                <Text style={[styles.kindText, kind === option.value && styles.kindTextSelected]}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable style={[styles.create, !title.trim() && styles.disabled]} onPress={createAndBind} disabled={!title.trim() || loading}>
            <Text style={styles.createText}>新建并打开</Text>
          </Pressable>

          <Text style={styles.existingLabel}>之前的共同空间</Text>
          {loading ? <ActivityIndicator /> : (
            <ScrollView style={styles.list}>
              {items.map((item) => (
                <Pressable key={item.id} style={styles.item} onPress={() => bind(item)}>
                  <Text style={styles.itemTitle}>{item.title}</Text>
                  <Text style={styles.itemKind}>{KIND_OPTIONS.find((option) => option.value === item.kind)?.label || "其他"}</Text>
                </Pressable>
              ))}
              {!items.length && <Text style={styles.empty}>还没有共同空间</Text>}
            </ScrollView>
          )}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  bar: { minHeight: 30, paddingHorizontal: 20, paddingVertical: 5, backgroundColor: XiaoCColors.navigationBackground, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: XiaoCColors.separator, alignItems: "center", justifyContent: "center" },
  title: { maxWidth: "100%", fontSize: 12, lineHeight: 17, color: XiaoCColors.textSecondary, fontWeight: "500" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.24)" },
  sheet: { position: "absolute", left: 18, right: 18, top: "18%", maxHeight: "66%", padding: 20, borderRadius: 24, backgroundColor: XiaoCColors.background },
  sheetTitle: { fontSize: 20, fontWeight: "600", color: XiaoCColors.textPrimary, marginBottom: 16 },
  currentRow: { flexDirection: "row", alignItems: "center", padding: 12, borderRadius: 14, backgroundColor: XiaoCColors.composerBackground, marginBottom: 14 },
  currentText: { flex: 1, color: XiaoCColors.textPrimary },
  closeText: { color: "#B05B58", paddingLeft: 12 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: XiaoCColors.separator, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 11, color: XiaoCColors.textPrimary },
  kinds: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginVertical: 10 },
  kind: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, backgroundColor: XiaoCColors.composerBackground },
  kindSelected: { backgroundColor: XiaoCColors.textPrimary },
  kindText: { fontSize: 12, color: XiaoCColors.textSecondary },
  kindTextSelected: { color: XiaoCColors.background },
  create: { alignItems: "center", paddingVertical: 11, borderRadius: 14, backgroundColor: XiaoCColors.textPrimary },
  createText: { color: XiaoCColors.background, fontWeight: "600" },
  disabled: { opacity: 0.35 },
  existingLabel: { marginTop: 20, marginBottom: 8, color: XiaoCColors.textSecondary, fontSize: 12 },
  list: { maxHeight: 190 },
  item: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: XiaoCColors.separator },
  itemTitle: { flex: 1, color: XiaoCColors.textPrimary, paddingRight: 12 },
  itemKind: { color: XiaoCColors.textSecondary, fontSize: 12 },
  empty: { color: XiaoCColors.textSecondary, paddingVertical: 16, textAlign: "center" },
});
