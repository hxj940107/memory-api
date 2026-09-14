export type ChatDeliveryFailure = {
  kind:
    | "timeout"
    | "network"
    | "authentication"
    | "account"
    | "rate_limit"
    | "persistence"
    | "service";
  notice: string;
  outcomeUnknown: boolean;
};

type RequestFailure = {
  message?: unknown;
  status?: unknown;
  code?: unknown;
};

export function classifyChatDeliveryFailure(
  failure: unknown,
): ChatDeliveryFailure {
  const error = (failure || {}) as RequestFailure;
  const message = typeof error.message === "string" ? error.message : "";
  const status = Number(error.status) || null;
  const code = typeof error.code === "string" ? error.code : "";

  if (message === "Request timeout") {
    return {
      kind: "timeout",
      notice: "连接有点慢，这次回复可能仍在处理中，不用重复发送。",
      outcomeUnknown: true,
    };
  }

  if (!status) {
    return {
      kind: "network",
      notice: "网络连接中断了，这条消息还没送达。检查网络后点重试。",
      outcomeUnknown: false,
    };
  }

  if (status === 401) {
    return {
      kind: "authentication",
      notice: "登录状态失效了，这条消息没有发送。重新打开 App 登录后再试。",
      outcomeUnknown: false,
    };
  }

  if (status === 403) {
    return {
      kind: "account",
      notice: "当前账号无法发送消息，请确认使用的是你的私人账号。",
      outcomeUnknown: false,
    };
  }

  if (status === 429) {
    return {
      kind: "rate_limit",
      notice: "刚才请求有点频繁，等一会儿再重试这条消息。",
      outcomeUnknown: false,
    };
  }

  if (code === "message_persistence_failed") {
    return {
      kind: "persistence",
      notice: "这条消息没有保存成功，小C还没有收到。点重试再发送。",
      outcomeUnknown: false,
    };
  }

  return {
    kind: "service",
    notice: "服务暂时出了点问题，这次回复没有完成。稍后再重试。",
    outcomeUnknown: false,
  };
}
