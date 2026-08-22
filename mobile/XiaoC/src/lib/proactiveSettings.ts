import { APP_USER_ID, apiJson, postJson } from "../config/api";

export type InactivityReachOutMode =
  | "frequent"
  | "normal"
  | "relaxed"
  | "off";

type InactivityReachOutModeResponse = {
  mode?: InactivityReachOutMode;
};

export const DEFAULT_INACTIVITY_REACH_OUT_MODE: InactivityReachOutMode =
  "normal";

export const INACTIVITY_REACH_OUT_OPTIONS: Array<{
  mode: InactivityReachOutMode;
  label: string;
  detail: string;
}> = [
  { mode: "frequent", label: "经常", detail: "约1-2小时" },
  { mode: "normal", label: "正常", detail: "约2.5-4小时" },
  { mode: "relaxed", label: "偶尔", detail: "约5-8小时" },
  { mode: "off", label: "关闭", detail: "不主动联系" },
];

export function normalizeInactivityReachOutMode(
  value?: string | null,
): InactivityReachOutMode {
  return INACTIVITY_REACH_OUT_OPTIONS.some((option) => option.mode === value)
    ? (value as InactivityReachOutMode)
    : DEFAULT_INACTIVITY_REACH_OUT_MODE;
}

export function getInactivityReachOutModeLabel(
  mode: InactivityReachOutMode,
) {
  return (
    INACTIVITY_REACH_OUT_OPTIONS.find((option) => option.mode === mode)?.label ||
    "正常"
  );
}

export async function getInactivityReachOutMode() {
  const response = await apiJson<InactivityReachOutModeResponse>(
    "/api/user-state",
    {
      query: {
        user_id: APP_USER_ID,
        action: "inactivity-reach-out-mode",
      },
    },
  );

  return normalizeInactivityReachOutMode(response.mode);
}

export async function saveInactivityReachOutMode(
  mode: InactivityReachOutMode,
) {
  const response = await postJson<InactivityReachOutModeResponse>(
    "/api/user-state",
    {
      user_id: APP_USER_ID,
      action: "set-inactivity-reach-out-mode",
      mode,
    },
  );

  return normalizeInactivityReachOutMode(response.mode);
}
