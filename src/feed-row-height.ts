import { clearCache, layout, prepare, type PreparedText } from "@chenglou/pretext";
import type { FeedItem } from "./types";

const MAX_PREPARED_TEXTS = 8_192;
const preparedTexts = new Map<string, PreparedText>();

function prepared(text: string, font: string) {
  const key = `${font}\u0000${text}`;
  const cached = preparedTexts.get(key);
  if (cached) {
    preparedTexts.delete(key);
    preparedTexts.set(key, cached);
    return cached;
  }
  if (preparedTexts.size >= MAX_PREPARED_TEXTS) {
    for (const oldestKey of [...preparedTexts.keys()].slice(0, MAX_PREPARED_TEXTS / 8)) {
      preparedTexts.delete(oldestKey);
    }
    // Pretext possède aussi son cache interne. Sa remise à zéro périodique
    // garantit que le cache global reste borné sans jeter notre LRU préparée.
    clearCache();
  }
  const value = prepare(text, font, { wordBreak: "normal" });
  preparedTexts.set(key, value);
  return value;
}

function textLines(text: string, font: string, width: number, lineHeight: number, maximum?: number) {
  const count = Math.max(1, layout(prepared(text, font), Math.max(24, width), lineHeight).lineCount);
  return maximum ? Math.min(maximum, count) : count;
}

export function resetFeedRowHeightCache() {
  preparedTexts.clear();
  clearCache();
}

export function estimateFeedRowHeight(
  item: FeedItem | null,
  width: number,
  density: "dense" | "comfort",
  textScale: number,
  hasDaySeparator: boolean,
) {
  const separatorHeight = hasDaySeparator ? 20 * textScale : 0;
  if (!item) return separatorHeight + (density === "dense" ? 34 : 82) * textScale;
  const read = item.seenAt !== null || item.openedAt !== null;
  const titleSize = 14 * textScale;
  const titleLineHeight = titleSize * 1.35;
  const titleWeight = read ? (density === "dense" ? 450 : 550) : 650;
  const titleFont = `${titleWeight} ${titleSize}px "Libre Franklin Variable"`;

  if (density === "dense") {
    const chromeWidth = 20 + 80 * textScale + 44 + 21 + 18;
    const titleWidth = Math.max(24, width - chromeWidth);
    const titleHeight = textLines(item.title, titleFont, titleWidth, titleLineHeight) * titleLineHeight;
    return separatorHeight + Math.max(20, titleHeight) + 11;
  }

  const contentWidth = Math.max(24, width - 70 * textScale - 15 - 20 - 18);
  const titleHeight = textLines(
    item.title,
    titleFont,
    contentWidth,
    titleLineHeight,
    2,
  ) * titleLineHeight;
  const metaHeight = 9 * textScale * 1.2 + 3;
  const summarySize = 11.5 * textScale;
  const summaryLineHeight = summarySize * 1.4;
  const summaryHeight = item.summary
    ? 3 + textLines(
        item.summary,
        `400 ${summarySize}px "Libre Franklin Variable"`,
        contentWidth,
        summaryLineHeight,
        2,
      ) * summaryLineHeight
    : 0;
  return separatorHeight + 17 + metaHeight + titleHeight + summaryHeight;
}
