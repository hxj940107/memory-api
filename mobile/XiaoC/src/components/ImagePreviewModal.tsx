import { Image } from "expo-image";
import { useEffect } from "react";
import {
  Dimensions,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

export type PreviewImage = {
  uri: string;
  width?: number | null;
  height?: number | null;
};

type Props = {
  visible: boolean;
  images: PreviewImage[];
  initialIndex?: number;
  onClose: () => void;
};

function PreviewPage({ image, onClose }: { image: PreviewImage; onClose: () => void }) {
  const screen = Dimensions.get("window");
  const ratio =
    Number(image.width) > 0 && Number(image.height) > 0
      ? Number(image.width) / Number(image.height)
      : null;
  const displayWidth = ratio
    ? Math.min(screen.width, screen.height * ratio)
    : screen.width;
  const displayHeight = ratio ? displayWidth / ratio : screen.height;
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);

  useEffect(() => {
    scale.value = 1;
    savedScale.value = 1;
  }, [image.uri, savedScale, scale]);

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      scale.value = Math.min(4, Math.max(1, savedScale.value * event.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= 1) {
        scale.value = withTiming(1);
        savedScale.value = 1;
      }
    });
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((_event, success) => {
      if (success) onClose();
    });
  const previewGesture = Gesture.Exclusive(pinch, tap);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <View style={[styles.page, { width: screen.width, height: screen.height }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <GestureDetector gesture={previewGesture}>
        <Animated.View
          style={[
            styles.imageWrap,
            { width: displayWidth, height: displayHeight },
            animatedStyle,
          ]}
        >
          <Image source={{ uri: image.uri }} style={styles.image} contentFit="contain" />
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

export function ImagePreviewModal({
  visible,
  images,
  initialIndex = 0,
  onClose,
}: Props) {
  const screenWidth = Dimensions.get("window").width;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <FlatList
          data={images}
          horizontal
          pagingEnabled
          initialScrollIndex={Math.min(initialIndex, Math.max(images.length - 1, 0))}
          getItemLayout={(_, index) => ({
            length: screenWidth,
            offset: screenWidth * index,
            index,
          })}
          keyExtractor={(item, index) => `${item.uri}-${index}`}
          showsHorizontalScrollIndicator={false}
          renderItem={({ item }) => <PreviewPage image={item} onClose={onClose} />}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "#000000",
  },
  page: {
    alignItems: "center",
    justifyContent: "center",
  },
  imageWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: "100%",
    height: "100%",
  },
});
