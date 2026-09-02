import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { APP_USER_ID, apiJson } from "../config/api";
import { MomentAvatar } from "../components/MomentAvatar";
import { XiaoCColors } from "../constants/theme";
import {
  DEFAULT_ACCOUNT_NAME,
  DEFAULT_USER_MOMENT_AVATAR,
  DEFAULT_XIAOC_MOMENT_AVATAR,
  getAccountSettings,
  type AccountSettings,
} from "../lib/accountSettings";

type SearchResult = {
  id: string;
  role: "user" | "assistant";
  snippet: string;
  created_at: string;
};

const SEARCH_PAGE_SIZE = 30;

function formatShanghaiTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (!query || index < 0) return <Text>{text}</Text>;

  return (
    <Text>
      {text.slice(0, index)}
      <Text style={styles.matchText}>{text.slice(index, index + query.length)}</Text>
      {text.slice(index + query.length)}
    </Text>
  );
}

export default function ChatSearchScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ conversationId?: string }>();
  const conversationId = String(params.conversationId || "");
  const inputRef = useRef<TextInput>(null);
  const requestVersionRef = useRef(0);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [account, setAccount] = useState<AccountSettings>({
    displayName: DEFAULT_ACCOUNT_NAME,
    hasPassword: false,
    faceIdEnabled: false,
    userMomentAvatar: DEFAULT_USER_MOMENT_AVATAR,
    xiaocMomentAvatar: DEFAULT_XIAOC_MOMENT_AVATAR,
    userMomentAvatarUri: null,
    xiaocMomentAvatarUri: null,
  });

  const normalizedQuery = query.trim();

  useEffect(() => {
    getAccountSettings()
      .then(setAccount)
      .catch((loadError) => console.log("Chat search account settings failed:", loadError));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const version = ++requestVersionRef.current;
    const controller = new AbortController();

    if (!conversationId || !normalizedQuery) {
      setResults([]);
      setHasMore(false);
      setLoading(false);
      setError("");
      return () => controller.abort();
    }

    setLoading(true);
    setError("");
    const timer = setTimeout(async () => {
      try {
        const data = await apiJson<SearchResult[]>("/api/history", {
          query: {
            action: "search",
            user_id: APP_USER_ID,
            conversation_id: conversationId,
            search_query: normalizedQuery,
            limit: SEARCH_PAGE_SIZE,
          },
          signal: controller.signal,
        });
        if (requestVersionRef.current !== version) return;
        setResults(data);
        setHasMore(data.length === SEARCH_PAGE_SIZE);
      } catch (requestError) {
        if (controller.signal.aborted || requestVersionRef.current !== version) return;
        console.log("Chat search failed:", requestError);
        setError("暂时没能搜索聊天记录");
      } finally {
        if (requestVersionRef.current === version) setLoading(false);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [conversationId, normalizedQuery]);

  const loadMore = async () => {
    const last = results[results.length - 1];
    if (!last || !hasMore || loading || loadingMore || !normalizedQuery) return;

    setLoadingMore(true);
    try {
      const data = await apiJson<SearchResult[]>("/api/history", {
        query: {
          action: "search",
          user_id: APP_USER_ID,
          conversation_id: conversationId,
          search_query: normalizedQuery,
          limit: SEARCH_PAGE_SIZE,
          before_created_at: last.created_at,
          before_id: last.id,
        },
      });
      setResults((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...data.filter((item) => !seen.has(item.id))];
      });
      setHasMore(data.length === SEARCH_PAGE_SIZE);
    } catch (requestError) {
      console.log("More chat search results failed:", requestError);
      setError("更早的搜索结果暂时没有加载出来");
    } finally {
      setLoadingMore(false);
    }
  };

  const openContext = (result: SearchResult) => {
    Keyboard.dismiss();
    router.replace({
      pathname: "/chat",
      params: {
        conversationId,
        targetMessageId: result.id,
      },
    } as never);
  };

  const emptyLabel = useMemo(() => {
    if (!normalizedQuery) return "输入文字，搜索这个聊天窗口的全部记录";
    if (loading) return "";
    if (error) return error;
    return "没有找到相关聊天";
  }, [error, loading, normalizedQuery]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={{ height: insets.top }} />
      <View style={styles.searchHeader}>
        <View style={styles.searchField}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput
            ref={inputRef}
            value={query}
            onChangeText={setQuery}
            placeholder="搜索聊天记录"
            placeholderTextColor={XiaoCColors.placeholder}
            returnKeyType="search"
            clearButtonMode="while-editing"
            autoCorrect={false}
            style={styles.searchInput}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="取消搜索"
          hitSlop={6}
          onPress={() => router.back()}
        >
          <Text style={styles.cancelText}>取消</Text>
        </Pressable>
      </View>

      {loading && results.length === 0 ? (
        <View style={styles.centered}>
          <ActivityIndicator color={XiaoCColors.textSecondary} />
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={results.length ? styles.resultsContent : styles.emptyContent}
          onEndReached={loadMore}
          onEndReachedThreshold={0.35}
          ListEmptyComponent={<Text style={styles.emptyText}>{emptyLabel}</Text>}
          ListFooterComponent={loadingMore ? (
            <ActivityIndicator style={styles.footerLoader} color={XiaoCColors.textSecondary} />
          ) : null}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.resultRow, pressed && styles.resultPressed]}
              onPress={() => openContext(item)}
            >
              <View style={styles.resultAvatar} pointerEvents="none">
                <MomentAvatar
                  profile={item.role === "user" ? "user" : "xiaoc"}
                  name={item.role === "user" ? account.displayName : "小C"}
                  avatar={item.role === "user"
                    ? account.userMomentAvatar
                    : account.xiaocMomentAvatar}
                  uri={item.role === "user"
                    ? account.userMomentAvatarUri
                    : account.xiaocMomentAvatarUri}
                  size={42}
                />
              </View>
              <View style={styles.resultBody}>
                <View style={styles.resultMeta}>
                  <Text style={styles.resultName}>
                    {item.role === "user" ? account.displayName : "小C"}
                  </Text>
                  <Text style={styles.resultTime}>{formatShanghaiTime(item.created_at)}</Text>
                </View>
                <Text style={styles.resultSnippet} numberOfLines={3}>
                  <HighlightedText text={item.snippet} query={normalizedQuery} />
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: XiaoCColors.background,
  },
  searchHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: XiaoCColors.separator,
    backgroundColor: XiaoCColors.navigationBackground,
  },
  searchField: {
    flex: 1,
    height: 38,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 11,
    borderRadius: 11,
    backgroundColor: XiaoCColors.surface,
  },
  searchIcon: {
    marginRight: 7,
    marginTop: -2,
    fontSize: 22,
    color: XiaoCColors.textSecondary,
  },
  searchInput: {
    flex: 1,
    height: 38,
    paddingVertical: 0,
    fontSize: 16,
    color: XiaoCColors.textPrimary,
  },
  cancelText: {
    marginLeft: 12,
    fontSize: 16,
    color: "#3478F6",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  emptyContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingBottom: 120,
  },
  emptyText: {
    textAlign: "center",
    fontSize: 14,
    lineHeight: 21,
    color: XiaoCColors.textSecondary,
  },
  resultsContent: {
    paddingBottom: 28,
  },
  resultRow: {
    minHeight: 82,
    flexDirection: "row",
    paddingLeft: 16,
    backgroundColor: XiaoCColors.inputSurface,
  },
  resultPressed: {
    backgroundColor: XiaoCColors.selected,
  },
  resultAvatar: {
    width: 42,
    height: 42,
    marginTop: 16,
  },
  resultBody: {
    flex: 1,
    marginLeft: 12,
    paddingTop: 13,
    paddingRight: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: XiaoCColors.separator,
  },
  resultMeta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 5,
  },
  resultName: {
    fontSize: 15,
    fontWeight: "600",
    color: XiaoCColors.textPrimary,
  },
  resultTime: {
    marginLeft: 12,
    fontSize: 12,
    color: XiaoCColors.textSecondary,
  },
  resultSnippet: {
    fontSize: 15,
    lineHeight: 21,
    color: XiaoCColors.textSecondary,
  },
  matchText: {
    color: XiaoCColors.userBubble,
    fontWeight: "600",
  },
  footerLoader: {
    marginVertical: 18,
  },
});
