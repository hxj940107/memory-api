import { Image } from "expo-image";
import { useState } from "react";
import { Pressable, StyleProp, StyleSheet, ViewStyle } from "react-native";

import { getMomentImageLayout } from "../lib/momentImageLayout";
import { MomentImagePreview } from "./MomentImagePreview";

type Props = {
  uri: string;
  aspectRatio?: number | null;
  availableWidth: number;
  style?: StyleProp<ViewStyle>;
};

export function MomentSingleImage({
  uri,
  aspectRatio,
  availableWidth,
  style,
}: Props) {
  const [previewVisible, setPreviewVisible] = useState(false);
  const [resolvedRatio, setResolvedRatio] = useState(
    Number(aspectRatio) > 0 ? Number(aspectRatio) : 4 / 3,
  );
  const { width, height } = getMomentImageLayout(resolvedRatio, availableWidth);

  return (
    <>
      <Pressable
        style={[styles.frame, style, { width, height }]}
        onPress={() => setPreviewVisible(true)}
      >
        <Image
          source={{ uri }}
          style={styles.image}
          contentFit="contain"
          onLoad={(event) => {
            const sourceWidth = Number(event.source?.width);
            const sourceHeight = Number(event.source?.height);
            if (sourceWidth > 0 && sourceHeight > 0) {
              setResolvedRatio(sourceWidth / sourceHeight);
            }
          }}
        />
      </Pressable>

      <MomentImagePreview
        visible={previewVisible}
        images={[{ uri, width: resolvedRatio, height: 1 }]}
        onClose={() => setPreviewVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  frame: {
    backgroundColor: "#F7F7F7",
    borderRadius: 7,
    overflow: "hidden",
  },
  image: {
    ...StyleSheet.absoluteFillObject,
  },
});
