export const API_BASE_URL = "https://memory-api-beta.vercel.app";
export const APP_USER_ID = "user";

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
  },
): Promise<T> {
  const { query, ...fetchOptions } = options || {};
  const response = await fetch(apiUrl(path, query), fetchOptions);
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : "Request failed";

    throw new Error(message);
  }

  return data as T;
}

export function postJson<T>(path: string, body: unknown) {
  return apiJson<T>(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
