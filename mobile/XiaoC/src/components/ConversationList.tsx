import { View, Text, FlatList, Pressable, StyleSheet } from "react-native";

import { useEffect, useState } from "react";

type Conversation = {
  id: string;
  title: string;
  created_at: string;
  latest: boolean;
  is_pinned: boolean;
};

export default function ConversationList() {
  const [list, setList] = useState<Conversation[]>([]);

  useEffect(() => {
    loadConversations();
  }, []);

  const loadConversations = async () => {
    const res = await fetch(
      "https://memory-api-beta.vercel.app/api/conversations?user_id=user",
    );

    const data = await res.json();

    setList(data);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>最近</Text>

      <FlatList
        data={list}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable style={styles.item}>
            <Text style={styles.text}>{item.title}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },

  title: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 24,
    color: "#333",
  },
  item: {
    paddingVertical: 14,
  },

  text: {
    fontSize: 17,
    color: "#222",
  },
});
