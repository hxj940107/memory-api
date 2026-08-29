import * as SecureStore from "expo-secure-store";

export const API_BASE_URL = "https://memory-api-beta.vercel.app";
export const APP_USER_ID = "user";
const PRIVATE_APP_TOKEN_KEY = "xiaoc.private_api_token";

let cachedPrivateAppToken: string | null | undefined;

async function getPrivateAppToken() {
  const buildToken = String(process.env.EXPO_PUBLIC_XIAOC_APP_TOKEN || "").trim();
  if (buildToken.length >= 32) {
    cachedPrivateAppToken = buildToken;
    SecureStore.setItemAsync(PRIVATE_APP_TOKEN_KEY, buildToken).catch(() => {});
    return buildToken;
  }

  if (cachedPrivateAppToken !== undefined) return cachedPrivateAppToken;
  cachedPrivateAppToken = await SecureStore.getItemAsync(PRIVATE_APP_TOKEN_KEY);
  return cachedPrivateAppToken;
}

type QueryValue = string | number | boolean | null | undefined;

export function apiUrl(
  path: string,
  query?: Record<string, QueryValue>,
) {
  const url = new URL(path, API_BASE_URL);

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

export async function apiJson<T>(
  path: string,
  options?: RequestInit & {
    query?: Record<string, QueryValue>;
    timeoutMs?: number;
  },
): Promise<T> {
  const { query, timeoutMs = 20000, signal, ...fetchOptions } = options || {};
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  if (signal) {
    signal.addEventListener("abort", () => {
      controller.abort();
    });
  }

  let response: Response;

  try {
    const headers = new Headers(fetchOptions.headers);
    const privateAppToken = await getPrivateAppToken();
    if (privateAppToken) headers.set("X-XiaoC-App-Token", privateAppToken);

    response = await fetch(apiUrl(path, query), {
      ...fetchOptions,
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Request timeout");
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : "Request failed";

    throw Object.assign(new Error(message), { status: response.status });
  }

  return data as T;
}

export function postJson<T>(
  path: string,
  body: unknown,
  options?: {
    timeoutMs?: number;
  },
) {
  return apiJson<T>(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs: options?.timeoutMs,
  });
}
