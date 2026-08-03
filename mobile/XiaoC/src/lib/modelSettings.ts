import AsyncStorage from "@react-native-async-storage/async-storage";

export type ChatModelOption = {
  id: string;
  name: string;
};

export const AVAILABLE_CHAT_MODELS: ChatModelOption[] = [
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
  },
  {
    id: "anthropic/claude-opus-4.1",
    name: "Claude Opus 4.1",
  },
];

const SELECTED_CHAT_MODEL_KEY = "xiaoc:selected_chat_model";

export const DEFAULT_CHAT_MODEL = AVAILABLE_CHAT_MODELS[0];

export function findChatModel(modelId?: string | null) {
  return (
    AVAILABLE_CHAT_MODELS.find((model) => model.id === modelId) ||
    DEFAULT_CHAT_MODEL
  );
}

export async function getSelectedChatModel() {
  const modelId = await AsyncStorage.getItem(SELECTED_CHAT_MODEL_KEY);

  return findChatModel(modelId);
}

export async function saveSelectedChatModel(modelId: string) {
  const model = findChatModel(modelId);

  await AsyncStorage.setItem(SELECTED_CHAT_MODEL_KEY, model.id);

  return model;
}
