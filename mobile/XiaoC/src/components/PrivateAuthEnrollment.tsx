import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  enrollPrivateAuthAccount,
  hasPrivateAuthSession,
  privateAuthEnrollmentEnabled,
} from "../lib/supabaseAuth";

export function PrivateAuthEnrollment() {
  const [checking, setChecking] = useState(privateAuthEnrollmentEnabled);
  const [hasSession, setHasSession] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!privateAuthEnrollmentEnabled) return;
    let active = true;
    hasPrivateAuthSession()
      .then((value) => {
        if (active) setHasSession(value);
      })
      .catch(() => {
        if (active) setHasSession(false);
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!privateAuthEnrollmentEnabled || hasSession) return null;

  const enroll = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await enrollPrivateAuthAccount(email, password);
      setPassword("");
      setEmail("");
      setHasSession(true);
      Alert.alert("身份已连接", "这台 iPhone 已安全连接到你的私人小C账号。");
    } catch {
      setPassword("");
      Alert.alert("连接失败", "账号不正确或登录已失效，请重新确认后再试。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>连接私人账号</Text>
      <Text style={styles.detail}>仅用于这台 iPhone 的一次性安全连接。</Text>
      {checking ? (
        <ActivityIndicator style={styles.activity} />
      ) : (
        <>
          <TextInput
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            placeholder="Supabase Auth 邮箱"
            value={email}
            onChangeText={setEmail}
            style={styles.input}
          />
          <TextInput
            autoCapitalize="none"
            autoComplete="current-password"
            placeholder="密码"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={enroll}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            disabled={submitting}
            onPress={enroll}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          >
            <Text style={styles.buttonText}>{submitting ? "连接中…" : "连接"}</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#FFFFFF",
    borderColor: "rgba(32,138,239,0.18)",
    borderRadius: 22,
    borderWidth: 1,
    marginBottom: 16,
    padding: 18,
  },
  title: { color: "#222", fontSize: 17, fontWeight: "600" },
  detail: { color: "#777", fontSize: 13, lineHeight: 19, marginTop: 5 },
  activity: { marginVertical: 18 },
  input: {
    backgroundColor: "#F5F5F7",
    borderRadius: 13,
    color: "#222",
    fontSize: 15,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  button: {
    alignItems: "center",
    backgroundColor: "#208AEF",
    borderRadius: 13,
    marginTop: 14,
    paddingVertical: 12,
  },
  buttonPressed: { opacity: 0.75 },
  buttonText: { color: "#FFF", fontSize: 15, fontWeight: "600" },
});
