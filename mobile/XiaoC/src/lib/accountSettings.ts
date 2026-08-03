import AsyncStorage from "@react-native-async-storage/async-storage";

export type AccountSettings = {
  displayName: string;
  hasPassword: boolean;
  faceIdEnabled: boolean;
};

const ACCOUNT_DISPLAY_NAME_KEY = "xiaoc:account_display_name";
const ACCOUNT_PASSWORD_KEY = "xiaoc:account_password";
const ACCOUNT_FACE_ID_KEY = "xiaoc:account_face_id";

export const DEFAULT_ACCOUNT_NAME = "小天使";

export async function getAccountSettings(): Promise<AccountSettings> {
  const [displayName, password, faceIdEnabled] = await Promise.all([
    AsyncStorage.getItem(ACCOUNT_DISPLAY_NAME_KEY),
    AsyncStorage.getItem(ACCOUNT_PASSWORD_KEY),
    AsyncStorage.getItem(ACCOUNT_FACE_ID_KEY),
  ]);

  return {
    displayName: displayName || DEFAULT_ACCOUNT_NAME,
    hasPassword: Boolean(password),
    faceIdEnabled: faceIdEnabled === "1",
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
