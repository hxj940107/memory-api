import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";

import {
  DEFAULT_USER_MOMENT_AVATAR,
  DEFAULT_XIAOC_MOMENT_AVATAR,
  MOMENT_AVATAR_PRESETS,
  type MomentAvatarId,
} from "../lib/accountSettings";
import type { MomentProfileKind } from "../lib/momentProfile";

export function MomentAvatar({
  profile,
  name,
  avatar,
  uri,
  size = 44,
}: {
  profile: MomentProfileKind;
  name: string;
  avatar: MomentAvatarId;
  uri: string | null;
  size?: number;
}) {
  const avatarStyle = {
    width: size,
    height: size,
    borderRadius: Math.max(7, Math.round(size * 0.16)),
  };

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={avatarStyle}
        contentFit="cover"
        transition={120}
      />
    );
  }

  const fallback =
    profile === "xiaoc"
      ? DEFAULT_XIAOC_MOMENT_AVATAR
      : DEFAULT_USER_MOMENT_AVATAR;
  const preset =
    MOMENT_AVATAR_PRESETS.find((item) => item.id === avatar) ||
    MOMENT_AVATAR_PRESETS.find((item) => item.id === fallback) ||
    MOMENT_AVATAR_PRESETS[0];
  const symbol = preset.useInitial
    ? name.trim().slice(0, 1) || (profile === "xiaoc" ? "C" : "我")
    : preset.symbol;

  return (
    <View
      style={[
        styles.fallback,
        avatarStyle,
        { backgroundColor: preset.backgroundColor },
      ]}
    >
      <Text
        style={[
          styles.symbol,
          {
            color: preset.color,
            fontSize: preset.useInitial ? size * 0.4 : size * 0.52,
          },
        ]}
      >
        {symbol}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  symbol: {
    fontWeight: "600",
    includeFontPadding: false,
  },
});
