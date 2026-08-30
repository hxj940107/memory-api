import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { MomentAvatar } from "../../../components/MomentAvatar";
import { apiJson, APP_USER_ID } from "../../../config/api";
import {
  DEFAULT_ACCOUNT_NAME,
  DEFAULT_USER_MOMENT_AVATAR,
  DEFAULT_XIAOC_MOMENT_AVATAR,
  getAccountSettings,
  type AccountSettings,
} from "../../../lib/accountSettings";
import {
  filterMomentsForProfile,
  formatMomentProfileDate,
  getMomentProfileBio,
  getMomentProfileCoverUri,
  getMomentProfileDayKey,
  MOMENT_PROFILE_BIO_MAX_LENGTH,
  saveMomentProfileBio,
  saveMomentProfileCoverUri,
  type MomentProfileKind,
} from "../../../lib/momentProfile";
import {
  syncClientPreferences,
  updateClientPreferences,
  uploadClientPreferenceImage,
} from "../../../lib/cloudPreferences";

type Moment = {
  id: string;
  author?: string;
  text?: string;
  image?: string | null;
  imageAspectRatio?: number | null;
  createdAt?: string;
};

const defaultCover = require("../../../../assets/moments-cover.svg");

export default function MomentProfileScreen() {
  const insets = useSafeAreaInsets();
  const { author } = useLocalSearchParams<{ author?: string }>();
  const profile: MomentProfileKind = author === "user" ? "user" : "xiaoc";
  const [moments, setMoments] = useState<Moment[]>([]);
  const [account, setAccount] = useState<AccountSettings | null>(null);
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [bio, setBio] = useState("");
  const [bioDraft, setBioDraft] = useState("");
  const [editingBio, setEditingBio] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    syncClientPreferences().catch(() => null).then(() => Promise.all([
      apiJson<Moment[]>("/api/memory", {
        query: { type: "moments", user_id: APP_USER_ID },
      }),
      getAccountSettings(),
      getMomentProfileCoverUri(profile),
      getMomentProfileBio(profile),
    ]))
      .then(([loadedMoments, loadedAccount, loadedCover, loadedBio]) => {
        if (!active) return;
        setMoments(filterMomentsForProfile(loadedMoments, profile));
        setAccount(loadedAccount);
        setCoverUri(loadedCover);
        setBio(loadedBio);
        setBioDraft(loadedBio);
      })
      .catch((error) => console.log("Moment profile load failed:", error))
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [profile]);

  const profileData = useMemo(() => {
    if (profile === "xiaoc") {
      return {
        name: "小C",
        avatar: account?.xiaocMomentAvatar || DEFAULT_XIAOC_MOMENT_AVATAR,
        avatarUri: account?.xiaocMomentAvatarUri || null,
      };
    }

    return {
      name: account?.displayName || DEFAULT_ACCOUNT_NAME,
      avatar: account?.userMomentAvatar || DEFAULT_USER_MOMENT_AVATAR,
      avatarUri: account?.userMomentAvatarUri || null,
    };
  }, [account, profile]);

  const pickCover = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("需要相册权限", "允许访问相册后，才能更换朋友圈封面。");
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [16, 9],
        quality: 0.9,
      });
      const uri = result.canceled ? null : result.assets[0]?.uri;
      if (!uri) return;

      const uploaded = await uploadClientPreferenceImage(
        profile === "user" ? "user_moment_cover" : "xiaoc_moment_cover",
        uri,
      );
      const savedUri = uploaded.uri || uri;
      setCoverUri(savedUri);
      await saveMomentProfileCoverUri(profile, savedUri);
    } catch (error) {
      Alert.alert(
        "更换失败",
        error instanceof Error ? error.message : "请稍后再试。",
      );
    }
  };

  const finishBioEditing = async () => {
    const savedBio = await saveMomentProfileBio(profile, bioDraft);
    await updateClientPreferences({
      [profile === "user" ? "user_moment_bio" : "xiaoc_moment_bio"]: savedBio,
    }).catch((error) => console.log("Moment bio sync failed:", error));
    setBio(savedBio);
    setBioDraft(savedBio);
    setEditingBio(false);
  };

  return (
    <View style={styles.screen}>
      <FlatList
        data={moments}
        keyExtractor={(moment) => moment.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View>
            <View style={styles.coverWrap}>
              <Pressable
                style={styles.coverButton}
                onPress={pickCover}
                accessibilityRole="button"
                accessibilityLabel="更换朋友圈封面"
              >
                <Image
                  source={coverUri ? { uri: coverUri } : defaultCover}
                  style={styles.cover}
                  contentFit="cover"
                />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="返回朋友圈"
                style={[styles.backButton, { top: Math.max(insets.top, 14) }]}
                onPress={() => router.back()}
              >
                <SymbolView
                  name="chevron.left"
                  size={19}
                  tintColor="#FFFFFF"
                  weight="regular"
                />
              </Pressable>
              <View style={styles.profileInfoRow} pointerEvents="none">
                <Text style={styles.name}>{profileData.name}</Text>
                <View style={styles.avatarFrame}>
                  <MomentAvatar
                    profile={profile}
                    name={profileData.name}
                    avatar={profileData.avatar}
                    uri={profileData.avatarUri}
                    size={68}
                  />
                </View>
              </View>
            </View>

            <View style={styles.identity}>
              {editingBio ? (
                <View style={styles.bioEditor}>
                  <TextInput
                    autoFocus
                    multiline
                    maxLength={MOMENT_PROFILE_BIO_MAX_LENGTH}
                    value={bioDraft}
                    onChangeText={setBioDraft}
                    style={styles.bioInput}
                    placeholder="写一句个性签名"
                    placeholderTextColor="#B0AAA5"
                    textAlign="right"
                  />
                  <View style={styles.bioActions}>
                    <Pressable
                      onPress={() => {
                        setBioDraft(bio);
                        setEditingBio(false);
                      }}
                    >
                      <Text style={styles.bioActionSecondary}>取消</Text>
                    </Pressable>
                    <Pressable onPress={finishBioEditing}>
                      <Text style={styles.bioActionPrimary}>保存</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View style={styles.bioRow}>
                  <Text style={styles.bio}>{bio}</Text>
                  <Pressable
                    style={styles.bioEditButton}
                    onPress={() => setEditingBio(true)}
                    accessibilityRole="button"
                    accessibilityLabel="编辑个性签名"
                  >
                    <SymbolView
                      name="pencil"
                      size={12}
                      tintColor="#B4AFAB"
                      weight="light"
                    />
                  </Pressable>
                </View>
              )}
            </View>
          </View>
        }
        ListEmptyComponent={
          loading ? null : <Text style={styles.empty}>还没有动态</Text>
        }
        renderItem={({ item, index }) => {
          const date = formatMomentProfileDate(item.createdAt || "");
          const previous = index > 0 ? moments[index - 1] : null;
          const showDate =
            !previous ||
            getMomentProfileDayKey(previous.createdAt || "") !==
              getMomentProfileDayKey(item.createdAt || "");

          return (
            <Pressable
              style={({ pressed }) => [
                styles.timelineItem,
                pressed && styles.timelineItemPressed,
              ]}
              onPress={() => router.push(`/moments/${item.id}`)}
            >
              <View style={styles.dateColumn}>
                {showDate && (
                  <>
                    <Text
                      style={[
                        styles.datePrimary,
                        date.primary === "今天" && styles.dateToday,
                      ]}
                    >
                      {date.primary}
                    </Text>
                    {!!date.secondary && (
                      <Text style={styles.dateSecondary}>{date.secondary}</Text>
                    )}
                  </>
                )}
              </View>

              {!!item.image && (
                <Image
                  source={{ uri: item.image }}
                  style={styles.thumbnail}
                  contentFit="cover"
                  transition={120}
                />
              )}

              <View style={styles.summaryWrap}>
                <Text style={styles.summary} numberOfLines={1} ellipsizeMode="tail">
                  {item.text || "分享了一张照片"}
                </Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  content: {
    paddingBottom: 44,
    flexGrow: 1,
  },
  coverWrap: {
    width: "100%",
    height: 360,
    marginBottom: 28,
    backgroundColor: "#E9E7E4",
  },
  coverButton: {
    ...StyleSheet.absoluteFillObject,
  },
  cover: {
    ...StyleSheet.absoluteFillObject,
  },
  backButton: {
    position: "absolute",
    left: 14,
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(28,28,30,0.32)",
  },
  profileInfoRow: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: -28,
    height: 96,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "flex-end",
  },
  identity: {
    minHeight: 58,
    paddingHorizontal: 22,
    paddingTop: 7,
    paddingBottom: 18,
  },
  name: {
    maxWidth: "62%",
    marginRight: 14,
    marginBottom: 44,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "600",
    color: "#FFFFFF",
    textAlign: "right",
    textShadowColor: "rgba(0,0,0,0.35)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  bio: {
    flexShrink: 1,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "right",
    color: "#8B8580",
  },
  bioRow: {
    alignSelf: "flex-end",
    maxWidth: 310,
    marginTop: 0,
    flexDirection: "row",
    alignItems: "flex-end",
  },
  bioEditButton: {
    width: 25,
    height: 20,
    marginLeft: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  bioEditor: {
    alignSelf: "stretch",
    alignItems: "flex-end",
    marginTop: 2,
  },
  bioInput: {
    width: "100%",
    minHeight: 42,
    maxHeight: 86,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 9,
    backgroundColor: "#F7F6F4",
    fontSize: 14,
    lineHeight: 21,
    color: "#655F5B",
  },
  bioActions: {
    marginTop: 7,
    flexDirection: "row",
    gap: 16,
  },
  bioActionSecondary: {
    fontSize: 12,
    color: "#A39D98",
  },
  bioActionPrimary: {
    fontSize: 12,
    color: "#6F6965",
    fontWeight: "500",
  },
  avatarFrame: {
    width: 68,
    height: 68,
  },
  timelineItem: {
    minHeight: 76,
    marginHorizontal: 20,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "flex-start",
  },
  timelineItemPressed: {
    opacity: 0.62,
  },
  dateColumn: {
    width: 57,
    paddingTop: 1,
  },
  datePrimary: {
    fontSize: 23,
    lineHeight: 27,
    fontWeight: "600",
    color: "#2C2A28",
  },
  dateToday: {
    fontSize: 16,
    lineHeight: 23,
  },
  dateSecondary: {
    marginTop: 1,
    fontSize: 12,
    lineHeight: 16,
    color: "#77716D",
  },
  thumbnail: {
    width: 64,
    height: 64,
    marginRight: 12,
    borderRadius: 5,
    backgroundColor: "#F1F0EE",
  },
  summaryWrap: {
    flex: 1,
    minHeight: 28,
    justifyContent: "flex-start",
  },
  summary: {
    fontSize: 16,
    lineHeight: 23,
    color: "#34312F",
  },
  empty: {
    paddingTop: 52,
    textAlign: "center",
    fontSize: 14,
    color: "#AAA5A1",
  },
});
