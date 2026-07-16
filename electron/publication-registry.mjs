const GROUPS = new Set(["france", "english-world"]);
const CATEGORIES = new Set(["general", "local", "business", "sports", "culture"]);
const CONNECTOR_KINDS = new Set(["rss", "atom", "news-sitemap"]);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ICON_PATH_PATTERN = /^\.\/provider-icons\/[a-z0-9]+(?:-[a-z0-9]+)*\.png$/;

function cleanHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} invalide.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError(`${label} doit être une URL HTTPS sans identifiants ni fragment.`);
  }
  return url.toString();
}

function cleanStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} invalide.`);
  }
  const cleaned = [...new Set(value.map((entry) => String(entry).trim().toLowerCase()))];
  if (cleaned.some((entry) => !entry || entry.includes(":") || entry.includes("/"))) {
    throw new TypeError(`${label} invalide.`);
  }
  return cleaned;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Validates and freezes the complete definition of one optimized publication.
 * Feed endpoints and reader rules stay main-owned; only the catalog projection
 * returned by publicSourceCatalog() may cross the Electron boundary.
 */
export function definePublication(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new TypeError("Définition de publication invalide.");
  }
  const id = String(definition.id ?? "").trim();
  if (!ID_PATTERN.test(id)) throw new TypeError("Identifiant de publication invalide.");
  const name = String(definition.name ?? "").trim();
  const description = String(definition.description ?? "").trim();
  if (!name || name.length > 120 || !description || description.length > 120) {
    throw new TypeError(`Nom ou description invalide pour ${id}.`);
  }
  if (!GROUPS.has(definition.group)) throw new TypeError(`Groupe invalide pour ${id}.`);
  if (!CATEGORIES.has(definition.category)) throw new TypeError(`Catégorie invalide pour ${id}.`);
  if (!Number.isInteger(definition.rank) || definition.rank < 1) {
    throw new TypeError(`Rang invalide pour ${id}.`);
  }
  if (!ICON_PATH_PATTERN.test(definition.iconPath)) {
    throw new TypeError(`Chemin d’icône invalide pour ${id}.`);
  }
  if (!CONNECTOR_KINDS.has(definition.connectorKind)) {
    throw new TypeError(`Type de flux invalide pour ${id}.`);
  }
  if (
    !Number.isInteger(definition.refreshIntervalSeconds) ||
    definition.refreshIntervalSeconds < 30 ||
    definition.refreshIntervalSeconds > 3_600
  ) {
    throw new TypeError(`Intervalle invalide pour ${id}.`);
  }

  const reader = definition.reader ?? {};
  const enrichment = definition.enrichment == null
    ? null
    : {
        kind: definition.enrichment.kind,
        url: cleanHttpsUrl(definition.enrichment.url, `URL d’enrichissement ${id}`),
        ttlSeconds: definition.enrichment.ttlSeconds ?? 120,
      };
  if (enrichment && enrichment.kind !== "news-sitemap") {
    throw new TypeError(`Enrichissement invalide pour ${id}.`);
  }

  return deepFreeze({
    id,
    name,
    description,
    group: definition.group,
    category: definition.category,
    rank: definition.rank,
    iconPath: definition.iconPath,
    homepageUrl: cleanHttpsUrl(definition.homepageUrl, `Page d’accueil ${id}`),
    hostnames: cleanStringArray(definition.hostnames, `Domaines ${id}`),
    feedUrl: cleanHttpsUrl(definition.feedUrl, `Flux ${id}`),
    connectorKind: definition.connectorKind,
    refreshIntervalSeconds: definition.refreshIntervalSeconds,
    enrichment,
    reader: {
      domains: cleanStringArray(reader.domains ?? definition.hostnames, `Domaines lecteur ${id}`),
      rootSelectors: reader.rootSelectors ?? null,
      titleSelectors: reader.titleSelectors ?? null,
      bylineSelectors: reader.bylineSelectors ?? null,
      imageSelectors: reader.imageSelectors ?? null,
      removeSelectors: reader.removeSelectors ?? [],
      premiumSelectors: reader.premiumSelectors ?? null,
      premiumPhrases: reader.premiumPhrases ?? null,
      blockedPhrases: reader.blockedPhrases ?? null,
      requireDeclaredFreeAccess: reader.requireDeclaredFreeAccess === true,
    },
  });
}

const entries = [
  {
    id: "ouest-france", name: "Ouest-France", group: "france", category: "local", rank: 1,
    description: "L’actualité nationale et régionale du premier quotidien français.",
    homepageUrl: "https://www.ouest-france.fr/", hostnames: ["ouest-france.fr"],
    feedUrl: "https://www.ouest-france.fr/rss/une", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "le-figaro", name: "Le Figaro", group: "france", category: "general", rank: 2,
    description: "Le fil Flash Actu, avec lecture simplifiée privilégiée quand elle est disponible.",
    homepageUrl: "https://www.lefigaro.fr/", hostnames: ["lefigaro.fr"],
    feedUrl: "https://www.lefigaro.fr/rss/figaro_flash-actu.xml", connectorKind: "rss", refreshIntervalSeconds: 600,
    reader: {
      titleSelectors: ["main article h1", "main h1"],
      bylineSelectors: ["main article [rel='author']", "main article [class*='author']", "main article [class*='fig-profile']"],
      removeSelectors: [".fig-sharebar", ".fig-sharebar-transversal", ".fig-share-tools", ".fig-ranking-profile-container"],
      premiumSelectors: ["[data-testid*='paywall']", ".fig-paywall", "[class*='premium-content']"],
    },
  },
  {
    id: "bfmtv", name: "BFMTV", group: "france", category: "general", rank: 3,
    description: "Les dernières informations françaises et internationales en continu.",
    homepageUrl: "https://www.bfmtv.com/", hostnames: ["bfmtv.com"],
    feedUrl: "https://www.bfmtv.com/rss/news-24-7/", connectorKind: "rss", refreshIntervalSeconds: 180,
  },
  {
    id: "franceinfo", name: "Franceinfo", group: "france", category: "general", rank: 4,
    description: "L’actualité du service public français, mise à jour en continu.",
    homepageUrl: "https://www.franceinfo.fr/", hostnames: ["franceinfo.fr"],
    feedUrl: "https://www.franceinfo.fr/titres.rss", connectorKind: "rss", refreshIntervalSeconds: 180,
  },
  {
    id: "le-monde", name: "Le Monde", group: "france", category: "general", rank: 5,
    description: "L’actualité en continu, avec lecture simplifiée privilégiée quand elle est disponible.",
    homepageUrl: "https://www.lemonde.fr/", hostnames: ["lemonde.fr"],
    feedUrl: "https://www.lemonde.fr/rss/en_continu.xml", connectorKind: "rss", refreshIntervalSeconds: 300,
    reader: {
      rootSelectors: ["main > article", "main article"],
      titleSelectors: ["h1.article__title", "article h1", "main h1"],
      bylineSelectors: [".article__author", "[rel='author']", "[class*='author']"],
    },
  },
  {
    id: "lequipe", name: "L’Équipe", group: "france", category: "sports", rank: 6,
    description: "L’actualité sportive française et internationale.",
    homepageUrl: "https://www.lequipe.fr/", hostnames: ["lequipe.fr"],
    feedUrl: "https://dwh.lequipe.fr/api/edito/rss?path=/", connectorKind: "rss", refreshIntervalSeconds: 300,
    reader: { rootSelectors: ["article"], premiumSelectors: ["[data-testid*='paywall']"] },
  },
  {
    id: "actu-fr", name: "Actu.fr", group: "france", category: "local", rank: 7,
    description: "Un réseau d’actualité locale couvrant les territoires français.",
    homepageUrl: "https://actu.fr/", hostnames: ["actu.fr"],
    feedUrl: "https://actu.fr/rss.xml", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "20-minutes", name: "20 Minutes", group: "france", category: "general", rank: 8,
    description: "L’essentiel de l’actualité générale, locale et sportive.",
    homepageUrl: "https://www.20minutes.fr/", hostnames: ["20minutes.fr"],
    feedUrl: "https://www.20minutes.fr/feeds/rss-une.xml", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "la-depeche", name: "La Dépêche", group: "france", category: "local", rank: 9,
    description: "L’actualité de l’Occitanie et les grands titres nationaux.",
    homepageUrl: "https://www.ladepeche.fr/", hostnames: ["ladepeche.fr"],
    feedUrl: "https://www.ladepeche.fr/rss.xml", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "le-parisien", name: "Le Parisien", group: "france", category: "general", rank: 10,
    description: "L’actualité du Parisien, avec lecture simplifiée privilégiée quand elle est disponible.",
    homepageUrl: "https://www.leparisien.fr/", hostnames: ["leparisien.fr"],
    feedUrl: "https://feeds.leparisien.fr/leparisien/rss", connectorKind: "rss", refreshIntervalSeconds: 180,
    enrichment: { kind: "news-sitemap", url: "https://www.leparisien.fr/arc/outboundfeeds/sitemapnews/?outputType=xml&from=0", ttlSeconds: 120 },
    reader: {
      rootSelectors: [".article-section.margin_bottom_article"],
      premiumSelectors: [], premiumPhrases: [], requireDeclaredFreeAccess: true,
    },
  },
  {
    id: "midi-libre", name: "Midi Libre", group: "france", category: "local", rank: 11,
    description: "L’actualité de Montpellier, du Languedoc et de l’Occitanie.",
    homepageUrl: "https://www.midilibre.fr/", hostnames: ["midilibre.fr"],
    feedUrl: "https://www.midilibre.fr/rss.xml", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "foot-mercato", name: "Foot Mercato", group: "france", category: "sports", rank: 12,
    description: "Les informations et transferts du football français et international.",
    homepageUrl: "https://www.footmercato.net/", hostnames: ["footmercato.net"],
    feedUrl: "https://www.footmercato.net/flux-rss", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "sud-ouest", name: "Sud Ouest", group: "france", category: "local", rank: 13,
    description: "L’actualité de la Nouvelle-Aquitaine et les grands sujets nationaux.",
    homepageUrl: "https://www.sudouest.fr/", hostnames: ["sudouest.fr"],
    feedUrl: "https://www.sudouest.fr/rss.xml", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "le-dauphine", name: "Le Dauphiné Libéré", group: "france", category: "local", rank: 14,
    description: "L’actualité des Alpes, de la vallée du Rhône et des territoires voisins.",
    homepageUrl: "https://www.ledauphine.com/", hostnames: ["ledauphine.com"],
    feedUrl: "https://www.ledauphine.com/rss", connectorKind: "rss", refreshIntervalSeconds: 300,
    reader: { rootSelectors: ["article", "[role='main']"] },
  },
  {
    id: "radio-france", name: "Radio France", group: "france", category: "general", rank: 15,
    description: "Les articles d’actualité publiés par les antennes de Radio France.",
    homepageUrl: "https://www.radiofrance.fr/", hostnames: ["radiofrance.fr"],
    feedUrl: "https://www.radiofrance.fr/sitemap-news.xml", connectorKind: "news-sitemap", refreshIntervalSeconds: 90,
  },
  {
    id: "cnews", name: "CNews", group: "france", category: "general", rank: 16,
    description: "L’actualité politique, société, économie et internationale en continu.",
    homepageUrl: "https://www.cnews.fr/", hostnames: ["cnews.fr"],
    feedUrl: "https://www.cnews.fr/rss.xml", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "ici", name: "ici", group: "france", category: "local", rank: 17,
    description: "L’actualité locale du réseau public ici dans toutes les régions.",
    homepageUrl: "https://www.ici.fr/", hostnames: ["ici.fr", "francebleu.fr"],
    feedUrl: "https://www.ici.fr/rss/a-la-une.xml", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "lindependant", name: "L’Indépendant", group: "france", category: "local", rank: 18,
    description: "L’actualité de Perpignan, de l’Aude et des Pyrénées-Orientales.",
    homepageUrl: "https://www.lindependant.fr/", hostnames: ["lindependant.fr"],
    feedUrl: "https://www.lindependant.fr/rss.xml", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "les-echos", name: "Les Échos", group: "france", category: "business", rank: 19,
    description: "L’actualité économique, financière et des entreprises.",
    homepageUrl: "https://www.lesechos.fr/", hostnames: ["lesechos.fr"],
    feedUrl: "https://www.lesechos.fr/sitemap_news.xml", connectorKind: "news-sitemap", refreshIntervalSeconds: 90,
  },
  {
    id: "liberation", name: "Libération", group: "france", category: "general", rank: 20,
    description: "L’actualité politique, société, culture et internationale.",
    homepageUrl: "https://www.liberation.fr/", hostnames: ["liberation.fr"],
    feedUrl: "https://www.liberation.fr/arc/outboundfeeds/rss-all/?outputType=xml", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "bbc", name: "BBC", group: "english-world", category: "general", rank: 1,
    description: "Global reporting from the BBC’s English-language newsroom.",
    homepageUrl: "https://www.bbc.com/news", hostnames: ["bbc.com", "bbc.co.uk"],
    feedUrl: "https://feeds.bbci.co.uk/news/rss.xml", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "new-york-times", name: "The New York Times", group: "english-world", category: "general", rank: 2,
    description: "US and international reporting from The New York Times.",
    homepageUrl: "https://www.nytimes.com/", hostnames: ["nytimes.com"],
    feedUrl: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "al-jazeera", name: "Al Jazeera", group: "english-world", category: "general", rank: 3,
    description: "International reporting and analysis from Al Jazeera English.",
    homepageUrl: "https://www.aljazeera.com/", hostnames: ["aljazeera.com"],
    feedUrl: "https://www.aljazeera.com/xml/rss/all.xml", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "guardian", name: "The Guardian", group: "english-world", category: "general", rank: 4,
    description: "Independent reporting and analysis from The Guardian.",
    homepageUrl: "https://www.theguardian.com/international", hostnames: ["theguardian.com"],
    feedUrl: "https://www.theguardian.com/international/rss", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "times-of-india", name: "The Times of India", group: "english-world", category: "general", rank: 5,
    description: "Indian and international news from The Times of India.",
    homepageUrl: "https://timesofindia.indiatimes.com/", hostnames: ["indiatimes.com"],
    feedUrl: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "fox-news", name: "Fox News", group: "english-world", category: "general", rank: 6,
    description: "US and world reporting from Fox News.",
    homepageUrl: "https://www.foxnews.com/", hostnames: ["foxnews.com"],
    feedUrl: "https://moxie.foxnews.com/google-publisher/latest.xml", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "daily-mail", name: "Daily Mail", group: "english-world", category: "general", rank: 7,
    description: "UK and international reporting from the Daily Mail.",
    homepageUrl: "https://www.dailymail.com/", hostnames: ["dailymail.com", "dailymail.co.uk"],
    feedUrl: "https://www.dailymail.com/home/index.rss", connectorKind: "rss", refreshIntervalSeconds: 300,
    reader: { rootSelectors: ["#js-article-text"] },
  },
  {
    id: "people", name: "People", group: "english-world", category: "culture", rank: 8,
    description: "Entertainment and culture reporting from People.",
    homepageUrl: "https://people.com/", hostnames: ["people.com"],
    feedUrl: "https://people.com/google-news-sitemap.xml", connectorKind: "news-sitemap", refreshIntervalSeconds: 90,
  },
  {
    id: "ndtv", name: "NDTV", group: "english-world", category: "general", rank: 9,
    description: "Indian and international breaking news from NDTV.",
    homepageUrl: "https://www.ndtv.com/", hostnames: ["ndtv.com"],
    feedUrl: "https://feeds.feedburner.com/ndtvnews-top-stories", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
  {
    id: "usa-today", name: "USA Today", group: "english-world", category: "general", rank: 10,
    description: "US national and international reporting from USA Today.",
    homepageUrl: "https://www.usatoday.com/", hostnames: ["usatoday.com"],
    feedUrl: "https://feeds.feedburner.com/UsatodaycomNation-TopStories", connectorKind: "rss", refreshIntervalSeconds: 300,
  },
];

export const PUBLICATIONS = Object.freeze(entries.map((entry) => definePublication({
  ...entry,
  iconPath: `./provider-icons/${entry.id}.png`,
})));

const ids = new Set();
const ranks = new Set();
for (const publication of PUBLICATIONS) {
  if (ids.has(publication.id)) throw new TypeError(`Publication dupliquée : ${publication.id}.`);
  ids.add(publication.id);
  const rankKey = `${publication.group}:${publication.rank}`;
  if (ranks.has(rankKey)) throw new TypeError(`Rang de publication dupliqué : ${rankKey}.`);
  ranks.add(rankKey);
}

export const SOURCE_CATALOG = Object.freeze(PUBLICATIONS.map((publication) => Object.freeze({
  id: publication.id,
  name: publication.name,
  description: publication.description,
  group: publication.group,
  category: publication.category,
  rank: publication.rank,
  iconPath: publication.iconPath,
  homepageUrl: publication.homepageUrl,
  connectorKind: publication.connectorKind,
  refreshIntervalSeconds: publication.refreshIntervalSeconds,
  capabilities: Object.freeze(["optimized-feed", "simplified-reading"]),
})));

export const CURATED_PROXY_ROOTS = Object.freeze(PUBLICATIONS.flatMap((publication) => [
  publication.feedUrl,
  ...(publication.enrichment ? [publication.enrichment.url] : []),
]));

export function publicationById(id) {
  return PUBLICATIONS.find((publication) => publication.id === id) ?? null;
}

export function publicationForFeedUrl(feedUrl) {
  return PUBLICATIONS.find((publication) => publication.feedUrl === feedUrl) ?? null;
}

export function publicSourceCatalog() {
  return SOURCE_CATALOG.map((source) => ({
    ...source,
    capabilities: [...source.capabilities],
  }));
}
