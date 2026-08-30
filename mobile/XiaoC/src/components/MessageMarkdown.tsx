import { useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from "react-native";
import * as Clipboard from "expo-clipboard";

import { XiaoCColors } from "../constants/theme";
import {
  hasBlockMarkdown,
  parseInlineMarkdown,
  parseMarkdownBlocks,
  type MarkdownBlock,
} from "../lib/messageMarkdown";

export { hasBlockMarkdown };

type MessageMarkdownVariant = "chat" | "detail";

export function InlineMarkdown({ text }: { text: string }) {
  return parseInlineMarkdown(text).map((token, index) => {
    if (token.type === "text") return token.text;

    return (
      <Text
        key={`${token.type}_${index}`}
        style={
          token.type === "strong"
            ? styles.strong
            : token.type === "emphasis"
              ? styles.emphasis
              : styles.inlineCode
        }
      >
        {token.text}
      </Text>
    );
  });
}

function CodeBlockCard({
  code,
  language,
}: {
  code: string;
  language?: string;
}) {
  const [copied, setCopied] = useState(false);
  const shouldWrap =
    !language ||
    ["text", "txt", "plaintext", "prompt", "md", "markdown"].includes(
      language.toLowerCase(),
    );

  const copyCode = async () => {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const codeText = (
    <Text
      selectable
      style={[styles.codeText, shouldWrap && styles.codeTextWrapped]}
    >
      {code}
    </Text>
  );

  return (
    <View style={styles.codeCard}>
      <View style={styles.codeCardHeader}>
        <Text style={styles.codeLanguage}>{language || "文本"}</Text>
        <Pressable hitSlop={8} onPress={copyCode}>
          <Text style={styles.codeCopy}>{copied ? "已复制" : "复制"}</Text>
        </Pressable>
      </View>
      {shouldWrap ? (
        codeText
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {codeText}
        </ScrollView>
      )}
    </View>
  );
}

function MarkdownContent({
  blocks,
  variant,
}: {
  blocks: MarkdownBlock[];
  variant: MessageMarkdownVariant;
}) {
  const baseTextStyle = [
    styles.text,
    variant === "detail" && styles.detailText,
  ];

  return blocks.map((block, blockIndex) => {
    if (block.type === "heading") {
      return (
        <Text
          key={`heading_${blockIndex}`}
          style={[
            baseTextStyle,
            styles.heading,
            block.level === 1 && styles.headingLarge,
            variant === "detail" && styles.detailHeading,
          ]}
        >
          <InlineMarkdown text={block.text} />
        </Text>
      );
    }

    if (block.type === "paragraph") {
      return (
        <Text key={`paragraph_${blockIndex}`} style={[baseTextStyle, styles.paragraph]}>
          <InlineMarkdown text={block.text} />
        </Text>
      );
    }

    if (block.type === "quote") {
      return (
        <View key={`quote_${blockIndex}`} style={styles.quote}>
          <Text style={[baseTextStyle, styles.quoteText]}>
            <InlineMarkdown text={block.text} />
          </Text>
        </View>
      );
    }

    if (block.type === "divider") {
      return <View key={`divider_${blockIndex}`} style={styles.divider} />;
    }

    if (block.type === "unorderedList" || block.type === "orderedList") {
      return (
        <View key={`list_${blockIndex}`} style={styles.list}>
          {block.items.map((item, itemIndex) => (
            <View key={`${item}_${itemIndex}`} style={styles.listItem}>
              <Text style={[baseTextStyle, styles.listMarker]}>
                {block.type === "orderedList" ? `${itemIndex + 1}.` : "•"}
              </Text>
              <Text style={[baseTextStyle, styles.listText]}>
                <InlineMarkdown text={item} />
              </Text>
            </View>
          ))}
        </View>
      );
    }

    return null;
  });
}

export function MessageMarkdown({
  text,
  variant = "chat",
  onLongPress,
}: {
  text: string;
  variant?: MessageMarkdownVariant;
  onLongPress?: (event: GestureResponderEvent) => void;
}) {
  const blocks = parseMarkdownBlocks(text);
  const content = (
    <View style={[styles.container, variant === "detail" && styles.detailContainer]}>
      {blocks.map((block, index) =>
        block.type === "codeBlock" ? (
          <CodeBlockCard
            key={`code_${index}`}
            code={block.code}
            language={block.language}
          />
        ) : (
          <MarkdownContent key={`content_${index}`} blocks={[block]} variant={variant} />
        ),
      )}
    </View>
  );

  return onLongPress ? (
    <Pressable onLongPress={onLongPress}>{content}</Pressable>
  ) : (
    content
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    gap: 7,
    paddingHorizontal: 17,
    paddingVertical: 9,
    borderRadius: 24,
    backgroundColor: XiaoCColors.assistantBubble,
    overflow: "hidden",
  },
  detailContainer: {
    paddingHorizontal: 0,
    paddingVertical: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    overflow: "visible",
  },
  text: {
    fontSize: 17,
    lineHeight: 25,
    color: XiaoCColors.textPrimary,
    flexShrink: 1,
    includeFontPadding: false,
  },
  detailText: {
    fontSize: 19,
    lineHeight: 31,
    color: "#3F3A37",
  },
  strong: {
    fontWeight: "600",
  },
  emphasis: {
    fontStyle: "italic",
  },
  inlineCode: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 15,
    color: XiaoCColors.textPrimary,
    backgroundColor: "rgba(120,120,128,0.10)",
  },
  heading: {
    fontSize: 18,
    lineHeight: 25,
    fontWeight: "600",
    marginBottom: 6,
  },
  headingLarge: {
    fontSize: 20,
    lineHeight: 28,
  },
  detailHeading: {
    fontSize: 20,
    lineHeight: 29,
  },
  paragraph: {
    marginBottom: 6,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: XiaoCColors.separator,
    marginVertical: 7,
  },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: "rgba(120,110,104,0.28)",
    paddingLeft: 12,
    marginBottom: 7,
  },
  quoteText: {
    color: "#6F6864",
  },
  list: {
    gap: 4,
    marginBottom: 6,
  },
  listItem: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  listMarker: {
    width: 24,
    flexShrink: 0,
  },
  listText: {
    flex: 1,
  },
  codeCard: {
    width: "100%",
    overflow: "hidden",
    borderRadius: 16,
    backgroundColor: XiaoCColors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: XiaoCColors.separator,
  },
  codeCardHeader: {
    minHeight: 36,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: XiaoCColors.separator,
  },
  codeLanguage: {
    fontSize: 13,
    color: XiaoCColors.textSecondary,
  },
  codeCopy: {
    fontSize: 13,
    color: XiaoCColors.textPrimary,
  },
  codeText: {
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 14,
    lineHeight: 21,
    color: XiaoCColors.textPrimary,
  },
  codeTextWrapped: {
    width: "100%",
  },
});
