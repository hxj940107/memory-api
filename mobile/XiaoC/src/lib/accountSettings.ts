import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

export type AccountSettings = {
  displayName: string;
  hasPassword: boolean;
  faceIdEnabled: boolean;
  userMomentAvatar: MomentAvatarId;
  xiaocMomentAvatar: MomentAvatarId;
  userMomentAvatarUri: string | null;
  xiaocMomentAvatarUri: string | null;
};

const ACCOUNT_DISPLAY_NAME_KEY = "xiaoc:account_display_name";
const LEGACY_ACCOUNT_PASSWORD_KEY = "xiaoc:account_password";
const ACCOUNT_PASSWORD_SECURE_KEY = "xiaoc.account_password";
const ACCOUNT_FACE_ID_KEY = "xiaoc:account_face_id";
const ACCOUNT_USER_MOMENT_AVATAR_KEY = "xiaoc:user_moment_avatar";
const ACCOUNT_XIAOC_MOMENT_AVATAR_KEY = "xiaoc:xiaoc_moment_avatar";
const ACCOUNT_USER_MOMENT_AVATAR_URI_KEY = "xiaoc:user_moment_avatar_uri";
const ACCOUNT_XIAOC_MOMENT_AVATAR_URI_KEY = "xiaoc:xiaoc_moment_avatar_uri";

export const DEFAULT_ACCOUNT_NAME = "大天使长";
const LEGACY_DEFAULT_ACCOUNT_NAME = "小天使";

export type MomentAvatarId =
  | "moonDark"
  | "moonSoft"
  | "sparkleLilac"
  | "initialWarm";

export const DEFAULT_USER_MOMENT_AVATAR: MomentAvatarId = "sparkleLilac";
export const DEFAULT_XIAOC_MOMENT_AVATAR: MomentAvatarId = "moonDark";

export const MOMENT_AVATAR_PRESETS: Array<{
  id: MomentAvatarId;
  name: string;
  symbol: string;
  backgroundColor: string;
  color: string;
  useInitial?: boolean;
}> = [
  {
    id: "moonDark",
    name: "深夜月牙",
    symbol: "☾",
    backgroundColor: "#2B2E35",
    color: "#FFFFFF",
  },
  {
    id: "moonSoft",
    name: "浅灰月牙",
    symbol: "☾",
    backgroundColor: "#EEEDEA",
    color: "#747474",
  },
  {
    id: "sparkleLilac",
    name: "淡紫星光",
    symbol: "✦",
    backgroundColor: "#B7A8EB",
    color: "#FFFFFF",
  },
  {
    id: "initialWarm",
    name: "昵称首字",
    symbol: "",
    backgroundColor: "#F0ECE6",
    color: "#7A736B",
    useInitial: true,
  },
];

export function normalizeMomentAvatarId(
  value: string | null,
  fallback: MomentAvatarId,
): MomentAvatarId {
  return MOMENT_AVATAR_PRESETS.some((preset) => preset.id === value)
    ? (value as MomentAvatarId)
    : fallback;
}

export async function getAccountSettings(): Promise<AccountSettings> {
  const [
    displayName,
    password,
    faceIdEnabled,
    userMomentAvatar,
    xiaocMomentAvatar,
    userMomentAvatarUri,
    xiaocMomentAvatarUri,
  ] = await Promise.all([
    AsyncStorage.getItem(ACCOUNT_DISPLAY_NAME_KEY),
    getAccountPassword(),
    AsyncStorage.getItem(ACCOUNT_FACE_ID_KEY),
    AsyncStorage.getItem(ACCOUNT_USER_MOMENT_AVATAR_KEY),
    AsyncStorage.getItem(ACCOUNT_XIAOC_MOMENT_AVATAR_KEY),
    AsyncStorage.getItem(ACCOUNT_USER_MOMENT_AVATAR_URI_KEY),
    AsyncStorage.getItem(ACCOUNT_XIAOC_MOMENT_AVATAR_URI_KEY),
  ]);

  return {
    displayName:
      !displayName || displayName === LEGACY_DEFAULT_ACCOUNT_NAME
        ? DEFAULT_ACCOUNT_NAME
        : displayName,
    hasPassword: Boolean(password),
    faceIdEnabled: faceIdEnabled === "1",
    userMomentAvatar: normalizeMomentAvatarId(
      userMomentAvatar,
      DEFAULT_USER_MOMENT_AVATAR,
    ),
    xiaocMomentAvatar: normalizeMomentAvatarId(
      xiaocMomentAvatar,
      DEFAULT_XIAOC_MOMENT_AVATAR,
    ),
    userMomentAvatarUri,
    xiaocMomentAvatarUri,
  };
}

export async function getAccountPassword() {
  const securePassword = await SecureStore.getItemAsync(
    ACCOUNT_PASSWORD_SECURE_KEY,
  );
  if (securePassword) return securePassword;

  const legacyPassword = await AsyncStorage.getItem(LEGACY_ACCOUNT_PASSWORD_KEY);
  if (legacyPassword) {
    await SecureStore.setItemAsync(ACCOUNT_PASSWORD_SECURE_KEY, legacyPassword);
    await AsyncStorage.removeItem(LEGACY_ACCOUNT_PASSWORD_KEY);
  }
  return legacyPassword;
}

export async function saveAccountDisplayName(displayName: string) {
  const normalizedName = displayName.trim() || DEFAULT_ACCOUNT_NAME;

  await AsyncStorage.setItem(ACCOUNT_DISPLAY_NAME_KEY, normalizedName);

  return normalizedName;
}

export async function saveAccountPassword(password: string) {
  const normalizedPassword = password.replace(/[^0-9]/g, "").slice(0, 6);

  if (!normalizedPassword) {
    await SecureStore.deleteItemAsync(ACCOUNT_PASSWORD_SECURE_KEY);
    await AsyncStorage.removeItem(LEGACY_ACCOUNT_PASSWORD_KEY);
    await AsyncStorage.removeItem(ACCOUNT_FACE_ID_KEY);
    return false;
  }

  await SecureStore.setItemAsync(ACCOUNT_PASSWORD_SECURE_KEY, normalizedPassword);
  await AsyncStorage.removeItem(LEGACY_ACCOUNT_PASSWORD_KEY);

  return true;
}

export async function clearAccountPassword() {
  await SecureStore.deleteItemAsync(ACCOUNT_PASSWORD_SECURE_KEY);
  await AsyncStorage.removeItem(LEGACY_ACCOUNT_PASSWORD_KEY);
  await AsyncStorage.removeItem(ACCOUNT_FACE_ID_KEY);
}

export async function saveAccountFaceIdEnabled(enabled: boolean) {
  await AsyncStorage.setItem(ACCOUNT_FACE_ID_KEY, enabled ? "1" : "0");
  return enabled;
}

export async function saveUserMomentAvatar(avatar: MomentAvatarId) {
  await AsyncStorage.setItem(ACCOUNT_USER_MOMENT_AVATAR_KEY, avatar);
  await AsyncStorage.removeItem(ACCOUNT_USER_MOMENT_AVATAR_URI_KEY);
  return avatar;
}

export async function saveXiaoCMomentAvatar(avatar: MomentAvatarId) {
  await AsyncStorage.setItem(ACCOUNT_XIAOC_MOMENT_AVATAR_KEY, avatar);
  await AsyncStorage.removeItem(ACCOUNT_XIAOC_MOMENT_AVATAR_URI_KEY);
  return avatar;
}

export async function saveUserMomentAvatarUri(uri: string) {
  await AsyncStorage.setItem(ACCOUNT_USER_MOMENT_AVATAR_URI_KEY, uri);
  return uri;
}

export async function saveXiaoCMomentAvatarUri(uri: string) {
  await AsyncStorage.setItem(ACCOUNT_XIAOC_MOMENT_AVATAR_URI_KEY, uri);
  return uri;
}
