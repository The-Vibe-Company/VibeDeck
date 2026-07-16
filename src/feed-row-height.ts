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
  textScale: number,
  hasDaySeparator: boolean,
) {
  const separatorHeight = hasDaySeparator ? 20 * textScale : 0;
  const titleSize = 14 * textScale;
  const titleLineHeight = titleSize * 1.42;
  // 0.65em de padding haut et bas, résolus dans la fonte de la rangée.
  const rowPadding = 1.3 * titleSize;
  if (!item) return separatorHeight + rowPadding + titleLineHeight + 1;
  const read = item.seenAt !== null || item.openedAt !== null;
  const titleWeight = read ? 480 : 680;
  const titleFont = `${titleWeight} ${titleSize}px "Libre Franklin Variable"`;
  // Chrome horizontal de la rangée 2a : liseré 2px, paddings 0.7em/1em,
  // gouttière d'heure 68px×échelle, icône ~20px×échelle, coche éventuelle,
  // et les trois gaps de 0.8em.
  const chromeWidth =
    2 +
    (9.8 + 68 + 20 + 14) * textScale +
    3 * 0.8 * titleSize +
    (read ? 14 * textScale : 0);
  // La colonne du titre plafonne à 56ch (≈ 0.6em par caractère en Libre
  // Franklin). L'estimation n'a pas besoin d'être exacte : le virtualiseur
  // mesure ensuite chaque rangée rendue (measureElement).
  const measureCap = 56 * 0.6 * titleSize;
  const titleWidth = Math.max(24, Math.min(measureCap, width - chromeWidth));
  const titleHeight = textLines(item.title, titleFont, titleWidth, titleLineHeight) * titleLineHeight;
  return separatorHeight + Math.max(20 * textScale, titleHeight) + rowPadding + 1;
}
