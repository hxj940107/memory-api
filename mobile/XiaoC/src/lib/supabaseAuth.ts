import * as SecureStore from "expo-secure-store";
import { createClient, type Session, type SupportedStorage } from "@supabase/supabase-js";

export const PRIVATE_AUTH_USER_UUID = "17aa1bd0-931d-40a0-b0d6-ef75c641c7b3";
const STORAGE_PREFIX = "xiaoc.supabase.auth.";
const CHUNK_SIZE = 1800;

const secureStorage: SupportedStorage = {
  async getItem(key) {
    const count = Number(await SecureStore.getItemAsync(`${STORAGE_PREFIX}${key}.count`));
    if (!Number.isInteger(count) || count < 1) return null;
    const chunks = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        SecureStore.getItemAsync(`${STORAGE_PREFIX}${key}.${index}`),
      ),
    );
    return chunks.every((chunk): chunk is string => chunk !== null) ? chunks.join("") : null;
  },
  async setItem(key, value) {
    await this.removeItem(key);
    const chunks = value.match(new RegExp(`.{1,${CHUNK_SIZE}}`, "gs")) || [];
    await Promise.all(
      chunks.map((chunk, index) =>
        SecureStore.setItemAsync(`${STORAGE_PREFIX}${key}.${index}`, chunk),
      ),
    );
    await SecureStore.setItemAsync(`${STORAGE_PREFIX}${key}.count`, String(chunks.length));
  },
  async removeItem(key) {
    const count = Number(await SecureStore.getItemAsync(`${STORAGE_PREFIX}${key}.count`));
    if (Number.isInteger(count) && count > 0) {
      await Promise.all(
        Array.from({ length: count }, (_, index) =>
          SecureStore.deleteItemAsync(`${STORAGE_PREFIX}${key}.${index}`),
        ),
      );
    }
    await SecureStore.deleteItemAsync(`${STORAGE_PREFIX}${key}.count`);
  },
};

const supabaseUrl = String(process.env.EXPO_PUBLIC_SUPABASE_URL || "").trim();
const supabaseAnonKey = String(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || "").trim();

export const supabaseAuth = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        storage: secureStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;

export const privateAuthEnrollmentEnabled =
  String(process.env.EXPO_PUBLIC_PRIVATE_AUTH_ENROLLMENT_ENABLED || "") === "true";

function requireAuthClient() {
  if (!supabaseAuth) {
    throw new Error("Private Auth is not configured in this build");
  }
  return supabaseAuth;
}

async function requirePrivateSession(session: Session | null): Promise<Session | null> {
  if (!session) return null;
  if (session.user.id !== PRIVATE_AUTH_USER_UUID) {
    await requireAuthClient().auth.signOut({ scope: "local" });
    throw new Error("Unexpected XiaoC Auth account");
  }
  return session;
}

export async function hasPrivateAuthSession() {
  if (!supabaseAuth) return false;
  const { data, error } = await supabaseAuth.auth.getSession();
  if (error) throw new Error("Unable to restore XiaoC Auth session");
  return Boolean(await requirePrivateSession(data.session));
}

export async function enrollPrivateAuthAccount(email: string, password: string) {
  const normalizedEmail = String(email || "").trim();
  if (!normalizedEmail || !password) throw new Error("Email and password are required");
  const client = requireAuthClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: normalizedEmail,
    password,
  });
  if (error || !data.session) throw new Error("Unable to establish XiaoC Auth session");
  const session = await requirePrivateSession(data.session);
  return { userId: session!.user.id };
}

export async function refreshPrivateAuthSession() {
  const client = requireAuthClient();
  const { data, error } = await client.auth.refreshSession();
  if (error || !data.session) throw new Error("Unable to refresh XiaoC Auth session");
  return requirePrivateSession(data.session);
}

export async function clearPrivateAuthSession() {
  if (!supabaseAuth) return;
  await supabaseAuth.auth.signOut({ scope: "local" });
}

export async function getPrivateAccessToken() {
  if (!supabaseAuth) return null;
  const { data, error } = await supabaseAuth.auth.getSession();
  if (error) throw new Error("Unable to restore XiaoC Auth session");
  let session = await requirePrivateSession(data.session);
  if (!session) return null;
  if (!session.expires_at || session.expires_at * 1000 <= Date.now() + 60_000) {
    session = await refreshPrivateAuthSession();
  }
  if (!session) throw new Error("Unable to refresh XiaoC Auth session");
  return session.access_token;
}
