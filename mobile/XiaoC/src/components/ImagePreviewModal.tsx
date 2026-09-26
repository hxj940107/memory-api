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
  onLongPressImage?: (image: PreviewImage, index: number) => void;
  feedbackMessage?: string | null;
};

function PreviewPage({
  image,
  index,
  onClose,
  onLongPressImage,
}: {
  image: PreviewImage;
  index: number;
  onClose: () => void;
  onLongPressImage?: (image: PreviewImage, index: number) => void;
}) {
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
  const longPress = Gesture.LongPress()
    .enabled(Boolean(onLongPressImage))
    .minDuration(450)
    .maxDistance(20)
    .runOnJS(true)
    .onEnd((_event, success) => {
      if (success) onLongPressImage?.(image, index);
    });
  const previewGesture = Gesture.Race(pinch, longPress, tap);

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
  onLongPressImage,
  feedbackMessage,
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
          renderItem={({ item, index }) => (
            <PreviewPage
              image={item}
              index={index}
              onClose={onClose}
              onLongPressImage={onLongPressImage}
            />
          )}
        />
        {!!feedbackMessage && (
          <View pointerEvents="none" style={styles.feedbackToast}>
            <Animated.Text style={styles.feedbackToastText}>
              {feedbackMessage}
            </Animated.Text>
          </View>
        )}
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
  feedbackToast: {
    position: "absolute",
    alignSelf: "center",
    bottom: 72,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  feedbackToastText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "500",
  },
});
