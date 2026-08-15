import { Image } from "expo-image";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiJson, APP_USER_ID } from "../config/api";

type AlbumAsset = {
  id: number;
  image: string | null;
  imageAspectRatio: number | null;
  description: string;
  category: string | null;
  categories: string[];
  timePeriods: string[];
  weather: string | null;
  relations: string[];
  accessScope: "shared" | "private";
  enabled: boolean;
  usageCount: number;
  createdAt: string;
};

type PickedImage = {
  uri: string;
  width: number;
  height: number;
};

const CATEGORIES = ["生活", "城市", "旅行", "自然", "美食", "咖啡", "动物", "家", "纪念"];
const LEGACY_CATEGORY_MAP: Record<string, string> = {
  日常: "生活",
  风景: "自然",
  室内: "家",
};
const TIME_PERIODS = [
  { label: "清晨", value: "earlyMorning" },
  { label: "上午", value: "morning" },
  { label: "午后", value: "afternoon" },
  { label: "傍晚", value: "evening" },
  { label: "夜晚", value: "night" },
  { label: "深夜", value: "lateNight" },
];
const WEATHER_OPTIONS = [
  { label: "晴天", value: "sunny" },
  { label: "阴天", value: "cloudy" },
  { label: "雨天", value: "rain" },
  { label: "雪天", value: "snow" },
];
const LEGACY_WEATHER_MAP: Record<string, string> = {
  晴天: "sunny",
  阴天: "cloudy",
  雨天: "rain",
  雪天: "snow",
};
const RELATIONS = ["自己", "和小天使", "一起出门", "共同回忆"];

export default function AlbumScreen() {
  const [assets, setAssets] = useState<AlbumAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorVisible, setEditorVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingAsset, setEditingAsset] = useState<AlbumAsset | null>(null);
  const [pickedImage, setPickedImage] = useState<PickedImage | null>(null);
  const [description, setDescription] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [timePeriods, setTimePeriods] = useState<string[]>([]);
  const [weather, setWeather] = useState<string | null>(null);
  const [relations, setRelations] = useState<string[]>([]);
  const [accessScope, setAccessScope] = useState<"shared" | "private">("shared");

  const loadAssets = async () => {
    const data = await apiJson<AlbumAsset[]>("/api/memory", {
      query: { type: "album_assets", user_id: APP_USER_ID },
    });

    setAssets(data);
  };

  useEffect(() => {
    loadAssets()
      .catch((error) => Alert.alert("加载失败", error instanceof Error ? error.message : "请稍后再试"))
      .finally(() => setLoading(false));
  }, []);

  const resetEditor = () => {
    setEditingAsset(null);
    setPickedImage(null);
    setDescription("");
    setCategories([]);
    setTimePeriods([]);
    setWeather(null);
    setRelations([]);
    setAccessScope("shared");
  };

  const openNewAsset = () => {
    resetEditor();
    setEditorVisible(true);
  };

  const openAsset = (asset: AlbumAsset) => {
    setEditingAsset(asset);
    setPickedImage(null);
    setDescription(asset.description);
    setCategories([...new Set([
      ...(asset.categories || []),
      ...(asset.category ? [asset.category] : []),
    ].map(item => LEGACY_CATEGORY_MAP[item] || item).filter(item => CATEGORIES.includes(item)))]);
    setTimePeriods([...new Set(asset.timePeriods.flatMap(period =>
      period === "daytime" ? ["morning", "afternoon"] : [period]
    ))]);
    setWeather(LEGACY_WEATHER_MAP[asset.weather || ""] || asset.weather);
    setRelations(asset.relations || []);
    setAccessScope(asset.accessScope);
    setEditorVisible(true);
  };

  const pickImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      Alert.alert("需要相册权限", "只会读取你主动选择的这一张照片。请允许访问后再试。");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      allowsMultipleSelection: false,
      quality: 1,
    });
    const asset = result.canceled ? null : result.assets[0];

    if (asset?.uri) {
      setPickedImage({
        uri: asset.uri,
        width: asset.width || 1,
        height: asset.height || 1,
      });
    }
  };

  const toggleValue = (value: string, values: string[], setter: (next: string[]) => void) => {
    setter(values.includes(value) ? values.filter(item => item !== value) : [...values, value]);
  };

  const saveAsset = async () => {
    if (!editingAsset && !pickedImage) {
      Alert.alert("先选一张照片", "共享相册一次上传一张，方便你认真分类。");
      return;
    }

    if (!categories.length) {
      Alert.alert("请选择分类", "可以选择一个或多个分类，帮助小C更准确地选图。");
      return;
    }

    setSaving(true);

    try {
      if (editingAsset) {
        const response = await apiJson<{ asset: AlbumAsset }>("/api/memory", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "album_assets",
            user_id: APP_USER_ID,
            id: editingAsset.id,
            description,
            category: categories[0],
            categories,
            timePeriods,
            weather,
            relations,
            accessScope,
          }),
        });

        setAssets(current => current.map(item => item.id === response.asset.id ? response.asset : item));
      } else if (pickedImage) {
        const longestSide = Math.max(pickedImage.width, pickedImage.height);
        const resizeAction = longestSide > 1440
          ? [{ resize: pickedImage.width >= pickedImage.height ? { width: 1440 } : { height: 1440 } }]
          : [];
        const compressed = await ImageManipulator.manipulateAsync(
          pickedImage.uri,
          resizeAction,
          {
            compress: 0.72,
            format: ImageManipulator.SaveFormat.JPEG,
            base64: true,
          },
        );

        if (!compressed.base64) throw new Error("图片处理失败，请重新选择后再试");

        const response = await apiJson<{ asset: AlbumAsset }>("/api/memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "album_assets",
            user_id: APP_USER_ID,
            imageBase64: compressed.base64,
            imageMimeType: "image/jpeg",
            imageAspectRatio: compressed.width / compressed.height,
            description,
            category: categories[0],
            categories,
            timePeriods,
            weather,
            relations,
            accessScope,
          }),
          timeoutMs: 40000,
        });

        setAssets(current => [response.asset, ...current]);
      }

      setEditorVisible(false);
      resetEditor();
    } catch (error) {
      Alert.alert("保存失败", error instanceof Error ? error.message : "请稍后再试");
    } finally {
      setSaving(false);
    }
  };

  const removeAsset = (asset: AlbumAsset) => {
    Alert.alert(
      "从共享相册移除？",
      "小C以后不会再选这张照片；已经发布的朋友圈仍会保留原图。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "移除",
          style: "destructive",
          onPress: async () => {
            try {
              await apiJson("/api/memory", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "album_assets", user_id: APP_USER_ID, id: asset.id }),
              });
              setAssets(current => current.filter(item => item.id !== asset.id));
              setEditorVisible(false);
              resetEditor();
            } catch (error) {
              Alert.alert("移除失败", error instanceof Error ? error.message : "请稍后再试");
            }
          },
        },
      ],
    );
  };

  const previewImage = pickedImage?.uri || editingAsset?.image || null;

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.headerButton} hitSlop={10} onPress={() => router.back()}>
          <SymbolView name="chevron.left" size={21} tintColor="#111111" />
        </Pressable>
        <Text style={styles.title}>共享相册</Text>
        <Pressable style={styles.headerButton} hitSlop={10} onPress={openNewAsset}>
          <SymbolView name="plus" size={22} tintColor="#111111" />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.intro}>只有你主动放进来的照片。分类由你决定，小C只会从允许使用的照片里挑选朋友圈配图。</Text>
        {loading ? (
          <Text style={styles.emptyText}>正在整理相册…</Text>
        ) : assets.length === 0 ? (
          <Pressable style={styles.emptyCard} onPress={openNewAsset}>
            <SymbolView name="photo.on.rectangle" size={28} tintColor="#8E8E93" />
            <Text style={styles.emptyTitle}>放进第一张生活照片</Text>
            <Text style={styles.emptyText}>不会读取整本手机相册</Text>
          </Pressable>
        ) : (
          <View style={styles.grid}>
            {assets.map(asset => (
              <Pressable key={asset.id} style={styles.gridItem} onPress={() => openAsset(asset)}>
                <Image source={asset.image} style={styles.gridImage} contentFit="cover" />
                <Text style={styles.assetLabel} numberOfLines={1}>
                  {asset.categories.length
                    ? asset.categories.join(" · ")
                    : asset.category || "未分类"}
                </Text>
                <Text style={styles.assetScope}>
                  {asset.accessScope === "shared" ? "小C可用于朋友圈" : "仅自己查看"}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>

      <Modal visible={editorVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setEditorVisible(false)}>
        <SafeAreaView style={styles.editor}>
          <View style={styles.editorHeader}>
            <Pressable onPress={() => setEditorVisible(false)}><Text style={styles.cancel}>取消</Text></Pressable>
            <Text style={styles.editorTitle}>{editingAsset ? "照片设置" : "添加照片"}</Text>
            <Pressable disabled={saving} onPress={saveAsset}><Text style={styles.save}>{saving ? "保存中" : "保存"}</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.editorContent}>
            <Pressable style={styles.preview} onPress={editingAsset ? undefined : pickImage}>
              {previewImage ? (
                <Image source={previewImage} style={styles.previewImage} contentFit="contain" />
              ) : (
                <>
                  <SymbolView name="photo.badge.plus" size={32} tintColor="#8E8E93" />
                  <Text style={styles.emptyText}>选择一张照片</Text>
                </>
              )}
            </Pressable>

            <Text style={styles.sectionTitle}>一句描述（可选）</Text>
            <TextInput
              style={styles.input}
              value={description}
              onChangeText={setDescription}
              placeholder="例如：雨天下班路上的车窗"
              placeholderTextColor="#A1A1A6"
              maxLength={120}
            />

            <Text style={styles.sectionTitle}>分类</Text>
            <View style={styles.chips}>
              {CATEGORIES.map(item => (
                <Pressable
                  key={item}
                  style={[styles.chip, categories.includes(item) && styles.chipSelected]}
                  onPress={() => toggleValue(item, categories, setCategories)}
                >
                  <Text style={[styles.chipText, categories.includes(item) && styles.chipTextSelected]}>{item}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.sectionTitle}>适合的时间</Text>
            <View style={styles.chips}>
              {TIME_PERIODS.map(period => (
                <Pressable
                  key={period.value}
                  style={[styles.chip, timePeriods.includes(period.value) && styles.chipSelected]}
                  onPress={() => toggleValue(period.value, timePeriods, setTimePeriods)}
                >
                  <Text style={[styles.chipText, timePeriods.includes(period.value) && styles.chipTextSelected]}>{period.label}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.sectionTitle}>天气</Text>
            <View style={styles.chips}>
              <Pressable
                style={[styles.chip, weather === null && styles.chipSelected]}
                onPress={() => setWeather(null)}
              >
                <Text style={[styles.chipText, weather === null && styles.chipTextSelected]}>不限</Text>
              </Pressable>
              {WEATHER_OPTIONS.map(item => (
                <Pressable
                  key={item.value}
                  style={[styles.chip, weather === item.value && styles.chipSelected]}
                  onPress={() => setWeather(weather === item.value ? null : item.value)}
                >
                  <Text style={[styles.chipText, weather === item.value && styles.chipTextSelected]}>{item.label}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.sectionTitle}>关系</Text>
            <View style={styles.chips}>
              {RELATIONS.map(relation => (
                <Pressable
                  key={relation}
                  style={[styles.chip, relations.includes(relation) && styles.chipSelected]}
                  onPress={() => toggleValue(relation, relations, setRelations)}
                >
                  <Text style={[styles.chipText, relations.includes(relation) && styles.chipTextSelected]}>{relation}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.sectionTitle}>使用权限</Text>
            <View style={styles.scopeRow}>
              <Pressable style={[styles.scopeOption, accessScope === "shared" && styles.scopeSelected]} onPress={() => setAccessScope("shared")}>
                <Text style={styles.scopeTitle}>小C可用于朋友圈</Text>
                <Text style={styles.scopeDescription}>只读取你填写的标签和描述</Text>
              </Pressable>
              <Pressable style={[styles.scopeOption, accessScope === "private" && styles.scopeSelected]} onPress={() => setAccessScope("private")}>
                <Text style={styles.scopeTitle}>仅自己查看</Text>
                <Text style={styles.scopeDescription}>保存在共享相册，但不参与选图</Text>
              </Pressable>
            </View>

            {editingAsset ? (
              <Pressable style={styles.removeButton} onPress={() => removeAsset(editingAsset)}>
                <Text style={styles.removeText}>从共享相册移除</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#F7F7F8" },
  header: { height: 48, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 17, fontWeight: "600", color: "#111111" },
  content: { padding: 20, paddingBottom: 40 },
  intro: { color: "#6E6E73", fontSize: 14, lineHeight: 21, marginBottom: 24 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  gridItem: { width: "47%", marginBottom: 8 },
  gridImage: { width: "100%", aspectRatio: 1, borderRadius: 14, backgroundColor: "#E9E9ED" },
  assetLabel: { fontSize: 14, color: "#222222", marginTop: 8 },
  assetScope: { fontSize: 12, color: "#8E8E93", marginTop: 3 },
  emptyCard: { minHeight: 220, borderRadius: 18, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", gap: 10 },
  emptyTitle: { color: "#222222", fontSize: 16, fontWeight: "500" },
  emptyText: { color: "#8E8E93", fontSize: 14 },
  editor: { flex: 1, backgroundColor: "#F7F7F8" },
  editorHeader: { height: 52, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  editorTitle: { fontSize: 17, fontWeight: "600", color: "#111111" },
  cancel: { fontSize: 16, color: "#666666" },
  save: { fontSize: 16, fontWeight: "600", color: "#3478F6" },
  editorContent: { padding: 20, paddingBottom: 48 },
  preview: { height: 260, borderRadius: 18, backgroundColor: "#ECECEF", alignItems: "center", justifyContent: "center", gap: 10, overflow: "hidden" },
  previewImage: { width: "100%", height: "100%" },
  sectionTitle: { marginTop: 24, marginBottom: 10, fontSize: 14, fontWeight: "600", color: "#55555A" },
  input: { minHeight: 48, borderRadius: 14, backgroundColor: "#FFFFFF", paddingHorizontal: 15, fontSize: 16, color: "#111111" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 9 },
  chip: { paddingHorizontal: 14, height: 36, borderRadius: 18, backgroundColor: "#EAEAEE", alignItems: "center", justifyContent: "center" },
  chipSelected: { backgroundColor: "#DCE9FF" },
  chipText: { fontSize: 14, color: "#55555A" },
  chipTextSelected: { color: "#2F6FCF", fontWeight: "500" },
  scopeRow: { gap: 10 },
  scopeOption: { padding: 15, borderRadius: 15, backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "transparent" },
  scopeSelected: { borderColor: "#7DA8EA", backgroundColor: "#F5F8FF" },
  scopeTitle: { color: "#222222", fontSize: 15, fontWeight: "500" },
  scopeDescription: { color: "#8E8E93", fontSize: 13, marginTop: 4 },
  removeButton: { height: 48, marginTop: 34, alignItems: "center", justifyContent: "center" },
  removeText: { color: "#FF3B30", fontSize: 16 },
});
