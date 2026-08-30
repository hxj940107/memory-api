const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send"

const trimText = (value, limit = 160) =>
  String(value || "").replace(/\s+/g, " ").trim().slice(0, limit)

export const isExpoPushToken = value =>
  /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(String(value || ""))

export function buildProactivePushMessage({ token, content, previewEnabled, data }) {
  return {
    to: token,
    sound: "default",
    title: "小C",
    body: previewEnabled ? trimText(content) || "发来了一条消息" : "发来了一条消息",
    data: {
      type: "xiaoc_message",
      ...data,
    },
    priority: "high",
  }
}

export function buildContentUpdatePushMessage({ token, type }) {
  const isTreehole = type === "treehole_update"
  return {
    to: token,
    sound: null,
    title: "小C",
    body: isTreehole ? "小C刚刚更新了树洞" : "小C刚刚更新了朋友圈",
    data: { type },
    priority: "default",
  }
}

export async function sendExpoPushMessage(message, { accessToken = "", fetchImpl = fetch } = {}) {
  if (!isExpoPushToken(message?.to)) {
    return { attempted: false, delivered_to_expo: false, reason: "invalid_push_token" }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const response = await fetchImpl(EXPO_PUSH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(message),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null)
    const ticket = Array.isArray(payload?.data) ? payload.data[0] : payload?.data

    return {
      attempted: true,
      delivered_to_expo: response.ok && ticket?.status === "ok",
      reason: response.ok ? ticket?.message || null : `expo_push_http_${response.status}`,
      ticket_id: ticket?.id || null,
      error: ticket?.details?.error || payload?.errors?.[0]?.message || null,
    }
  } catch (error) {
    return {
      attempted: true,
      delivered_to_expo: false,
      reason: error?.name === "AbortError" ? "expo_push_timeout" : "expo_push_request_failed",
      ticket_id: null,
      error: trimText(error?.message, 240) || null,
    }
  } finally {
    clearTimeout(timeout)
  }
}
