import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
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
  getMomentProfileDayKey,
  getMomentsCoverUri,
  type MomentProfileKind,
} from "../../../lib/momentProfile";

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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    Promise.all([
      apiJson<Moment[]>("/api/memory", {
        query: { type: "moments", user_id: APP_USER_ID },
      }),
      getAccountSettings(),
      profile === "user" ? getMomentsCoverUri() : Promise.resolve(null),
    ])
      .then(([loadedMoments, loadedAccount, loadedCover]) => {
        if (!active) return;
        setMoments(filterMomentsForProfile(loadedMoments, profile));
        setAccount(loadedAccount);
        setCoverUri(loadedCover);
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
        bio: "陪你一起生活，也记得我们走过的日子。",
        avatar: account?.xiaocMomentAvatar || DEFAULT_XIAOC_MOMENT_AVATAR,
        avatarUri: account?.xiaocMomentAvatarUri || null,
      };
    }

    return {
      name: account?.displayName || DEFAULT_ACCOUNT_NAME,
      bio: "和小C一起留下的生活片段。",
      avatar: account?.userMomentAvatar || DEFAULT_USER_MOMENT_AVATAR,
      avatarUri: account?.userMomentAvatarUri || null,
    };
  }, [account, profile]);

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
              <Image
                source={coverUri ? { uri: coverUri } : defaultCover}
                style={styles.cover}
                contentFit="cover"
              />
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
            </View>

            <View style={styles.identity}>
              <View style={styles.identityText}>
                <Text style={styles.name}>{profileData.name}</Text>
                <Text style={styles.bio}>{profileData.bio}</Text>
              </View>
              <View style={styles.avatarFrame}>
                <MomentAvatar
                  profile={profile}
                  name={profileData.name}
                  avatar={profileData.avatar}
                  uri={profileData.avatarUri}
                  size={72}
                />
              </View>
            </View>

            <View style={styles.timelineHeader}>
              <Text style={styles.timelineTitle}>朋友圈</Text>
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
                <Text style={styles.summary} numberOfLines={3} ellipsizeMode="tail">
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
    height: 232,
    backgroundColor: "#E9E7E4",
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
  identity: {
    minHeight: 104,
    paddingHorizontal: 22,
    paddingBottom: 18,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  identityText: {
    flex: 1,
    alignItems: "flex-end",
    paddingTop: 14,
    paddingRight: 13,
  },
  name: {
    fontSize: 20,
    lineHeight: 27,
    fontWeight: "600",
    color: "#242321",
  },
  bio: {
    marginTop: 4,
    maxWidth: 240,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "right",
    color: "#8B8580",
  },
  avatarFrame: {
    width: 80,
    height: 80,
    marginTop: -20,
    padding: 4,
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
  },
  timelineHeader: {
    marginHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(120,120,128,0.18)",
  },
  timelineTitle: {
    fontSize: 14,
    fontWeight: "500",
    color: "#8C8782",
  },
  timelineItem: {
    minHeight: 94,
    marginHorizontal: 20,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "flex-start",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(120,120,128,0.14)",
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
    width: 76,
    height: 76,
    marginRight: 12,
    borderRadius: 5,
    backgroundColor: "#F1F0EE",
  },
  summaryWrap: {
    flex: 1,
    minHeight: 60,
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
