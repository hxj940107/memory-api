export type SharedAlbumImportDraft = {
  uri: string;
  width?: number | null;
  height?: number | null;
  successMessage?: string;
  temporaryFileUri?: string;
};

let pendingDraft: SharedAlbumImportDraft | null = null;

export const stageSharedAlbumImport = (draft: SharedAlbumImportDraft) => {
  pendingDraft = draft.uri ? { ...draft } : null;
};

export const consumeSharedAlbumImport = () => {
  const draft = pendingDraft;
  pendingDraft = null;
  return draft;
};
