export type SyncMessage = {
  id: string;
  cloudId?: string;
  clientId?: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
  status?: string;
  imageUri?: string;
  imageUris?: string[];
  fileName?: string;
  fileMimeType?: string | null;
  fileSize?: number | null;
  treeholeDraft?: unknown;
  treeholeSaveStatus?: string;
  diarySaveStatus?: string;
  metadata?: object;
  attachments?: unknown[];
};

export const getValidCloudMessageId = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : null;

export const getStableMessageId = (message: Pick<SyncMessage, "id" | "cloudId">) =>
  String(message.cloudId || message.id);

const sameStringList = (left?: string[], right?: string[]) => {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
};

const sameJsonValue = (left: unknown, right: unknown) => {
  if (left === right) return true;
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
};

const sameMessageMetadata = (left?: object, right?: object) => {
  if (left === right) return true;
  const leftValue = (left || {}) as Record<string, unknown>;
  const rightValue = (right || {}) as Record<string, unknown>;
  const keys = [
    "proactive",
    "proactiveType",
    "proactiveTaskId",
    "proactiveActivityId",
    "attachments",
  ];

  return keys.every((key) => sameJsonValue(leftValue[key], rightValue[key]));
};

const sameRenderableMessage = <T extends SyncMessage>(left: T, right: T) =>
  getStableMessageId(left) === getStableMessageId(right) &&
  left.role === right.role &&
  left.text === right.text &&
  left.createdAt === right.createdAt &&
  left.status === right.status &&
  left.imageUri === right.imageUri &&
  sameStringList(left.imageUris, right.imageUris) &&
  left.fileName === right.fileName &&
  left.fileMimeType === right.fileMimeType &&
  left.fileSize === right.fileSize &&
  left.treeholeSaveStatus === right.treeholeSaveStatus &&
  left.diarySaveStatus === right.diarySaveStatus &&
  sameJsonValue(left.treeholeDraft, right.treeholeDraft) &&
  sameJsonValue(left.attachments, right.attachments) &&
  sameMessageMetadata(left.metadata, right.metadata);

const compareMessages = <T extends SyncMessage>(left: T, right: T) => {
  const timeOrder = String(left.createdAt || "").localeCompare(
    String(right.createdAt || ""),
  );

  return timeOrder || getStableMessageId(left).localeCompare(getStableMessageId(right));
};

const preserveArrayWhenUnchanged = <T extends SyncMessage>(
  previous: T[],
  next: T[],
) => {
  if (
    previous.length === next.length &&
    previous.every((message, index) => message === next[index])
  ) {
    return previous;
  }

  return next;
};

export function mergeCloudMessages<T extends SyncMessage>(
  current: T[],
  incoming: T[],
) {
  const currentByCloudId = new Map(
    current
      .filter((message) => message.cloudId)
      .map((message) => [String(message.cloudId), message]),
  );
  const localByClientId = new Map(
    current
      .filter((message) => !message.cloudId && message.clientId)
      .map((message) => [String(message.clientId), message]),
  );
  const claimedLocalMessages = new Set<T>();
  const mergedByCloudId = new Map<string, T>();

  for (const cloudMessage of incoming) {
    const cloudId = String(cloudMessage.cloudId || cloudMessage.id);
    const normalized = {
      ...cloudMessage,
      id: cloudId,
      cloudId,
    } as T;
    const matchingLocal = cloudMessage.clientId
      ? localByClientId.get(String(cloudMessage.clientId))
      : undefined;
    const existing = currentByCloudId.get(cloudId) || matchingLocal;
    if (matchingLocal) claimedLocalMessages.add(matchingLocal);
    const merged = existing
      ? ({ ...existing, ...normalized, id: cloudId, cloudId } as T)
      : normalized;

    mergedByCloudId.set(
      cloudId,
      existing && sameRenderableMessage(existing, merged) ? existing : merged,
    );
  }

  const localOnly = current.filter(
    (message) => !message.cloudId && !claimedLocalMessages.has(message),
  );
  const next = [...mergedByCloudId.values(), ...localOnly].sort(compareMessages);
  return preserveArrayWhenUnchanged(current, next);
}

export function reconcileLocalMessageCloudId<T extends SyncMessage>(
  current: T[],
  localId: string,
  cloudIdValue?: string | null,
  updates: Partial<T> = {},
) {
  if (!cloudIdValue) {
    return current.map((message) =>
      message.id === localId ? ({ ...message, ...updates } as T) : message,
    );
  }

  const cloudId = String(cloudIdValue);
  const localMessage = current.find((message) => message.id === localId);
  const cloudMessage = current.find(
    (message) => message.cloudId === cloudId || message.id === cloudId,
  );

  if (!localMessage && cloudMessage) {
    return current.map((message) =>
      message === cloudMessage
        ? ({ ...message, ...updates, id: cloudId, cloudId } as T)
        : message,
    );
  }

  if (!localMessage) return current;

  const reconciled = {
    ...(cloudMessage || {}),
    ...localMessage,
    ...updates,
    id: cloudId,
    cloudId,
    createdAt: cloudMessage?.createdAt || localMessage.createdAt,
  } as T;
  const next = current
    .filter((message) => message !== localMessage && message !== cloudMessage)
    .concat(reconciled)
    .sort(compareMessages);

  return next;
}

export function upsertCloudMessage<T extends SyncMessage>(
  current: T[],
  incoming: T,
) {
  const cloudId = String(incoming.cloudId || incoming.id);
  const normalized = { ...incoming, id: cloudId, cloudId } as T;
  const existingIndex = current.findIndex(
    (message) => message.cloudId === cloudId || message.id === cloudId,
  );

  if (existingIndex < 0) {
    return [...current, normalized].sort(compareMessages);
  }

  const existing = current[existingIndex];
  const merged = {
    ...existing,
    ...normalized,
    id: cloudId,
    cloudId,
    createdAt: existing.createdAt || normalized.createdAt,
  } as T;
  if (sameRenderableMessage(existing, merged)) return current;

  const next = [...current];
  next[existingIndex] = merged;
  return next.sort(compareMessages);
}
