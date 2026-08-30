import AsyncStorage from "@react-native-async-storage/async-storage";

export type MomentProfileKind = "user" | "xiaoc";

export type MomentProfileRecord = {
  id: string;
  author?: string;
  createdAt?: string;
};

export const MOMENTS_COVER_URI_KEY = "xiaoc_moments_cover_uri_v1";
const XIAOC_MOMENTS_COVER_URI_KEY = "xiaoc:xiaoc_moments_cover_uri_v1";
const USER_MOMENT_PROFILE_BIO_KEY = "xiaoc:user_moment_profile_bio_v1";
const XIAOC_MOMENT_PROFILE_BIO_KEY = "xiaoc:xiaoc_moment_profile_bio_v1";

export const MOMENT_PROFILE_BIO_MAX_LENGTH = 80;

export const DEFAULT_MOMENT_PROFILE_BIOS: Record<MomentProfileKind, string> = {
  user: "和小C一起留下的生活片段。",
  xiaoc: "陪你一起生活，也记得我们走过的日子。",
};

export function getMomentAuthorType(author?: string): MomentProfileKind {
  return !author || author.trim() === "小C" ? "xiaoc" : "user";
}

export function filterMomentsForProfile<T extends MomentProfileRecord>(
  moments: T[],
  profile: MomentProfileKind,
) {
  return moments
    .filter((moment) => getMomentAuthorType(moment.author) === profile)
    .sort(
      (left, right) =>
        new Date(right.createdAt || 0).getTime() -
        new Date(left.createdAt || 0).getTime(),
    );
}

function getShanghaiDateParts(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

export function getMomentProfileDayKey(value: string) {
  const parts = getShanghaiDateParts(value);
  return parts
    ? `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`
    : "";
}

export function formatMomentProfileDate(value: string, now = new Date()) {
  const parts = getShanghaiDateParts(value);
  const today = getShanghaiDateParts(now);

  if (!parts || !today) return { primary: "", secondary: "" };
  if (
    parts.year === today.year &&
    parts.month === today.month &&
    parts.day === today.day
  ) {
    return { primary: "今天", secondary: "" };
  }

  return {
    primary: String(parts.day),
    secondary:
      parts.year === today.year
        ? `${parts.month}月`
        : `${parts.year}年\n${parts.month}月`,
  };
}

export function getMomentsCoverUri() {
  return AsyncStorage.getItem(MOMENTS_COVER_URI_KEY);
}

export function saveMomentsCoverUri(uri: string) {
  return AsyncStorage.setItem(MOMENTS_COVER_URI_KEY, uri);
}

export function getMomentProfileCoverUri(profile: MomentProfileKind) {
  return AsyncStorage.getItem(
    profile === "user" ? MOMENTS_COVER_URI_KEY : XIAOC_MOMENTS_COVER_URI_KEY,
  );
}

export function saveMomentProfileCoverUri(
  profile: MomentProfileKind,
  uri: string,
) {
  return AsyncStorage.setItem(
    profile === "user" ? MOMENTS_COVER_URI_KEY : XIAOC_MOMENTS_COVER_URI_KEY,
    uri,
  );
}

export async function getMomentProfileBio(profile: MomentProfileKind) {
  const value = await AsyncStorage.getItem(
    profile === "user"
      ? USER_MOMENT_PROFILE_BIO_KEY
      : XIAOC_MOMENT_PROFILE_BIO_KEY,
  );
  return value?.trim() || DEFAULT_MOMENT_PROFILE_BIOS[profile];
}

export async function saveMomentProfileBio(
  profile: MomentProfileKind,
  value: string,
) {
  const normalized = value.trim().slice(0, MOMENT_PROFILE_BIO_MAX_LENGTH);
  const bio = normalized || DEFAULT_MOMENT_PROFILE_BIOS[profile];
  await AsyncStorage.setItem(
    profile === "user"
      ? USER_MOMENT_PROFILE_BIO_KEY
      : XIAOC_MOMENT_PROFILE_BIO_KEY,
    bio,
  );
  return bio;
}
