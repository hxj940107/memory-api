export type PrependScrollAnchor = {
  contentHeight: number;
  scrollOffsetY: number;
};

export function getPrependAnchoredOffset(
  anchor: PrependScrollAnchor,
  nextContentHeight: number,
) {
  const insertedHeight = Math.max(0, nextContentHeight - anchor.contentHeight);
  return Math.max(0, anchor.scrollOffsetY + insertedHeight);
}
