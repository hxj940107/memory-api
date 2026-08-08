import AsyncStorage from "@react-native-async-storage/async-storage";

export type AccountSettings = {
  displayName: string;
  hasPassword: boolean;
  faceIdEnabled: boolean;
  userMomentAvatar: MomentAvatarId;
  xiaocMomentAvatar: MomentAvatarId;
};

const ACCOUNT_DISPLAY_NAME_KEY = "xiaoc:account_display_name";
const ACCOUNT_PASSWORD_KEY = "xiaoc:account_password";
const ACCOUNT_FACE_ID_KEY = "xiaoc:account_face_id";
const ACCOUNT_USER_MOMENT_AVATAR_KEY = "xiaoc:user_moment_avatar";
const ACCOUNT_XIAOC_MOMENT_AVATAR_KEY = "xiaoc:xiaoc_moment_avatar";

export const DEFAULT_ACCOUNT_NAME = "小天使";

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
  ] = await Promise.all([
    AsyncStorage.getItem(ACCOUNT_DISPLAY_NAME_KEY),
    AsyncStorage.getItem(ACCOUNT_PASSWORD_KEY),
    AsyncStorage.getItem(ACCOUNT_FACE_ID_KEY),
    AsyncStorage.getItem(ACCOUNT_USER_MOMENT_AVATAR_KEY),
    AsyncStorage.getItem(ACCOUNT_XIAOC_MOMENT_AVATAR_KEY),
  ]);

  return {
    displayName: displayName || DEFAULT_ACCOUNT_NAME,
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
  };
}

export async function getAccountPassword() {
  return AsyncStorage.getItem(ACCOUNT_PASSWORD_KEY);
}

export async function saveAccountDisplayName(displayName: string) {
  const normalizedName = displayName.trim() || DEFAULT_ACCOUNT_NAME;

  await AsyncStorage.setItem(ACCOUNT_DISPLAY_NAME_KEY, normalizedName);

  return normalizedName;
}

export async function saveAccountPassword(password: string) {
  const normalizedPassword = password.replace(/[^0-9]/g, "").slice(0, 6);

  if (!normalizedPassword) {
    await AsyncStorage.removeItem(ACCOUNT_PASSWORD_KEY);
    await AsyncStorage.removeItem(ACCOUNT_FACE_ID_KEY);
    return false;
  }

  await AsyncStorage.setItem(ACCOUNT_PASSWORD_KEY, normalizedPassword);

  return true;
}

export async function clearAccountPassword() {
  await AsyncStorage.removeItem(ACCOUNT_PASSWORD_KEY);
  await AsyncStorage.removeItem(ACCOUNT_FACE_ID_KEY);
}

export async function saveUserMomentAvatar(avatar: MomentAvatarId) {
  await AsyncStorage.setItem(ACCOUNT_USER_MOMENT_AVATAR_KEY, avatar);
  return avatar;
}

export async function saveXiaoCMomentAvatar(avatar: MomentAvatarId) {
  await AsyncStorage.setItem(ACCOUNT_XIAOC_MOMENT_AVATAR_KEY, avatar);
  return avatar;
}
