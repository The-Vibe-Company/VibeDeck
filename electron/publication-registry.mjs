const GROUPS = new Set(["france", "english-world"]);
const SOURCE_TYPES = new Set(["media", "primary"]);
const MEDIA_CATEGORIES = new Set(["general", "local", "business", "sports", "culture"]);
const PRIMARY_CATEGORIES = new Set(["public-decisions", "data", "alerts", "research"]);
const CATEGORIES = new Set([...MEDIA_CATEGORIES, ...PRIMARY_CATEGORIES]);
const CONNECTOR_KINDS = new Set(["rss", "atom", "news-sitemap"]);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ICON_PATH_PATTERN = /^\.\/provider-icons\/[a-z0-9]+(?:-[a-z0-9]+)*\.png$/;
export const DEFAULT_PUBLICATION_REFRESH_INTERVAL_SECONDS = 60;
export const DEFAULT_PRIMARY_SOURCE_REFRESH_INTERVAL_SECONDS = 300;

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
 * Validates and freezes the complete definition of one curated source.
 * Feed endpoints and reader rules stay main-owned; only the catalog projection
 * returned by publicSourceCatalog() may cross the Electron boundary. The
 * historical function name remains because existing optimized media definitions
 * and tests import it directly.
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
  const sourceType = definition.sourceType ?? "media";
  if (!SOURCE_TYPES.has(sourceType)) throw new TypeError(`Type de source invalide pour ${id}.`);
  if (!GROUPS.has(definition.group)) throw new TypeError(`Groupe invalide pour ${id}.`);
  if (!CATEGORIES.has(definition.category)) throw new TypeError(`Catégorie invalide pour ${id}.`);
  if (sourceType === "media" && !MEDIA_CATEGORIES.has(definition.category)) {
    throw new TypeError(`Catégorie média invalide pour ${id}.`);
  }
  if (sourceType === "primary" && !PRIMARY_CATEGORIES.has(definition.category)) {
    throw new TypeError(`Catégorie de source primaire invalide pour ${id}.`);
  }
  if (!Number.isInteger(definition.rank) || definition.rank < 1) {
    throw new TypeError(`Rang invalide pour ${id}.`);
  }
  if (sourceType === "media" && !ICON_PATH_PATTERN.test(definition.iconPath)) {
    throw new TypeError(`Chemin d’icône invalide pour ${id}.`);
  }
  if (sourceType === "primary" && !ICON_PATH_PATTERN.test(definition.iconPath)) {
    throw new TypeError(`Chemin d’icône invalide pour ${id}.`);
  }
  if (!CONNECTOR_KINDS.has(definition.connectorKind)) {
    throw new TypeError(`Type de flux invalide pour ${id}.`);
  }
  const refreshIntervalSeconds = definition.refreshIntervalSeconds
    ?? (sourceType === "primary"
      ? DEFAULT_PRIMARY_SOURCE_REFRESH_INTERVAL_SECONDS
      : DEFAULT_PUBLICATION_REFRESH_INTERVAL_SECONDS);
  if (
    !Number.isInteger(refreshIntervalSeconds) ||
    refreshIntervalSeconds < 30 ||
    refreshIntervalSeconds > 3_600
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
    sourceType,
    group: definition.group,
    category: definition.category,
    rank: definition.rank,
    iconPath: definition.iconPath ?? null,
    homepageUrl: cleanHttpsUrl(definition.homepageUrl, `Page d’accueil ${id}`),
    hostnames: cleanStringArray(definition.hostnames, `Domaines ${id}`),
    feedUrl: cleanHttpsUrl(definition.feedUrl, `Flux ${id}`),
    connectorKind: definition.connectorKind,
    refreshIntervalSeconds,
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
    feedUrl: "https://www.ouest-france.fr/rss/une", connectorKind: "rss",
  },
  {
    id: "le-figaro", name: "Le Figaro", group: "france", category: "general", rank: 2,
    description: "Le fil Flash Actu, avec lecture simplifiée privilégiée quand elle est disponible.",
    homepageUrl: "https://www.lefigaro.fr/", hostnames: ["lefigaro.fr"],
    feedUrl: "https://www.lefigaro.fr/rss/figaro_flash-actu.xml", connectorKind: "rss",
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
    feedUrl: "https://www.bfmtv.com/rss/news-24-7/", connectorKind: "rss",
  },
  {
    id: "franceinfo", name: "Franceinfo", group: "france", category: "general", rank: 4,
    description: "L’actualité du service public français, mise à jour en continu.",
    homepageUrl: "https://www.franceinfo.fr/", hostnames: ["franceinfo.fr"],
    feedUrl: "https://www.franceinfo.fr/titres.rss", connectorKind: "rss",
  },
  {
    id: "le-monde", name: "Le Monde", group: "france", category: "general", rank: 5,
    description: "L’actualité en continu, avec lecture simplifiée privilégiée quand elle est disponible.",
    homepageUrl: "https://www.lemonde.fr/", hostnames: ["lemonde.fr"],
    feedUrl: "https://www.lemonde.fr/rss/en_continu.xml", connectorKind: "rss",
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
    feedUrl: "https://dwh.lequipe.fr/api/edito/rss?path=/", connectorKind: "rss",
    reader: { rootSelectors: ["article"], premiumSelectors: ["[data-testid*='paywall']"] },
  },
  {
    id: "actu-fr", name: "Actu.fr", group: "france", category: "local", rank: 7,
    description: "Un réseau d’actualité locale couvrant les territoires français.",
    homepageUrl: "https://actu.fr/", hostnames: ["actu.fr"],
    feedUrl: "https://actu.fr/rss.xml", connectorKind: "rss",
  },
  {
    id: "20-minutes", name: "20 Minutes", group: "france", category: "general", rank: 8,
    description: "L’essentiel de l’actualité générale, locale et sportive.",
    homepageUrl: "https://www.20minutes.fr/", hostnames: ["20minutes.fr"],
    feedUrl: "https://www.20minutes.fr/feeds/rss-une.xml", connectorKind: "rss",
  },
  {
    id: "la-depeche", name: "La Dépêche", group: "france", category: "local", rank: 9,
    description: "L’actualité de l’Occitanie et les grands titres nationaux.",
    homepageUrl: "https://www.ladepeche.fr/", hostnames: ["ladepeche.fr"],
    feedUrl: "https://www.ladepeche.fr/rss.xml", connectorKind: "rss",
  },
  {
    id: "le-parisien", name: "Le Parisien", group: "france", category: "general", rank: 10,
    description: "L’actualité du Parisien, avec lecture simplifiée privilégiée quand elle est disponible.",
    homepageUrl: "https://www.leparisien.fr/", hostnames: ["leparisien.fr"],
    feedUrl: "https://feeds.leparisien.fr/leparisien/rss", connectorKind: "rss",
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
    feedUrl: "https://www.midilibre.fr/rss.xml", connectorKind: "rss",
  },
  {
    id: "foot-mercato", name: "Foot Mercato", group: "france", category: "sports", rank: 12,
    description: "Les informations et transferts du football français et international.",
    homepageUrl: "https://www.footmercato.net/", hostnames: ["footmercato.net"],
    feedUrl: "https://www.footmercato.net/flux-rss", connectorKind: "rss",
  },
  {
    id: "sud-ouest", name: "Sud Ouest", group: "france", category: "local", rank: 13,
    description: "L’actualité de la Nouvelle-Aquitaine et les grands sujets nationaux.",
    homepageUrl: "https://www.sudouest.fr/", hostnames: ["sudouest.fr"],
    feedUrl: "https://www.sudouest.fr/rss.xml", connectorKind: "rss",
  },
  {
    id: "le-dauphine", name: "Le Dauphiné Libéré", group: "france", category: "local", rank: 14,
    description: "L’actualité des Alpes, de la vallée du Rhône et des territoires voisins.",
    homepageUrl: "https://www.ledauphine.com/", hostnames: ["ledauphine.com"],
    feedUrl: "https://www.ledauphine.com/rss", connectorKind: "rss",
    reader: { rootSelectors: ["article", "[role='main']"] },
  },
  {
    id: "radio-france", name: "Radio France", group: "france", category: "general", rank: 15,
    description: "Les articles d’actualité publiés par les antennes de Radio France.",
    homepageUrl: "https://www.radiofrance.fr/", hostnames: ["radiofrance.fr"],
    feedUrl: "https://www.radiofrance.fr/sitemap-news.xml", connectorKind: "news-sitemap",
  },
  {
    id: "cnews", name: "CNews", group: "france", category: "general", rank: 16,
    description: "L’actualité politique, société, économie et internationale en continu.",
    homepageUrl: "https://www.cnews.fr/", hostnames: ["cnews.fr"],
    feedUrl: "https://www.cnews.fr/rss.xml", connectorKind: "rss",
  },
  {
    id: "ici", name: "ici", group: "france", category: "local", rank: 17,
    description: "L’actualité locale du réseau public ici dans toutes les régions.",
    homepageUrl: "https://www.ici.fr/", hostnames: ["ici.fr", "francebleu.fr"],
    feedUrl: "https://www.ici.fr/rss/a-la-une.xml", connectorKind: "rss",
  },
  {
    id: "lindependant", name: "L’Indépendant", group: "france", category: "local", rank: 18,
    description: "L’actualité de Perpignan, de l’Aude et des Pyrénées-Orientales.",
    homepageUrl: "https://www.lindependant.fr/", hostnames: ["lindependant.fr"],
    feedUrl: "https://www.lindependant.fr/rss.xml", connectorKind: "rss",
  },
  {
    id: "les-echos", name: "Les Échos", group: "france", category: "business", rank: 19,
    description: "L’actualité économique, financière et des entreprises.",
    homepageUrl: "https://www.lesechos.fr/", hostnames: ["lesechos.fr"],
    feedUrl: "https://www.lesechos.fr/sitemap_news.xml", connectorKind: "news-sitemap",
  },
  {
    id: "liberation", name: "Libération", group: "france", category: "general", rank: 20,
    description: "L’actualité politique, société, culture et internationale.",
    homepageUrl: "https://www.liberation.fr/", hostnames: ["liberation.fr"],
    feedUrl: "https://www.liberation.fr/arc/outboundfeeds/rss-all/?outputType=xml", connectorKind: "rss",
  },
  {
    id: "bbc", name: "BBC", group: "english-world", category: "general", rank: 1,
    description: "Global reporting from the BBC’s English-language newsroom.",
    homepageUrl: "https://www.bbc.com/news", hostnames: ["bbc.com", "bbc.co.uk"],
    feedUrl: "https://feeds.bbci.co.uk/news/rss.xml", connectorKind: "rss",
  },
  {
    id: "new-york-times", name: "The New York Times", group: "english-world", category: "general", rank: 2,
    description: "US and international reporting from The New York Times.",
    homepageUrl: "https://www.nytimes.com/", hostnames: ["nytimes.com"],
    feedUrl: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", connectorKind: "rss",
  },
  {
    id: "al-jazeera", name: "Al Jazeera", group: "english-world", category: "general", rank: 3,
    description: "International reporting and analysis from Al Jazeera English.",
    homepageUrl: "https://www.aljazeera.com/", hostnames: ["aljazeera.com"],
    feedUrl: "https://www.aljazeera.com/xml/rss/all.xml", connectorKind: "rss",
  },
  {
    id: "guardian", name: "The Guardian", group: "english-world", category: "general", rank: 4,
    description: "Independent reporting and analysis from The Guardian.",
    homepageUrl: "https://www.theguardian.com/international", hostnames: ["theguardian.com"],
    feedUrl: "https://www.theguardian.com/international/rss", connectorKind: "rss",
  },
  {
    id: "times-of-india", name: "The Times of India", group: "english-world", category: "general", rank: 5,
    description: "Indian and international news from The Times of India.",
    homepageUrl: "https://timesofindia.indiatimes.com/", hostnames: ["indiatimes.com"],
    feedUrl: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", connectorKind: "rss",
  },
  {
    id: "fox-news", name: "Fox News", group: "english-world", category: "general", rank: 6,
    description: "US and world reporting from Fox News.",
    homepageUrl: "https://www.foxnews.com/", hostnames: ["foxnews.com"],
    feedUrl: "https://moxie.foxnews.com/google-publisher/latest.xml", connectorKind: "rss",
  },
  {
    id: "daily-mail", name: "Daily Mail", group: "english-world", category: "general", rank: 7,
    description: "UK and international reporting from the Daily Mail.",
    homepageUrl: "https://www.dailymail.com/", hostnames: ["dailymail.com", "dailymail.co.uk"],
    feedUrl: "https://www.dailymail.com/home/index.rss", connectorKind: "rss",
    reader: { rootSelectors: ["#js-article-text"] },
  },
  {
    id: "people", name: "People", group: "english-world", category: "culture", rank: 8,
    description: "Entertainment and culture reporting from People.",
    homepageUrl: "https://people.com/", hostnames: ["people.com"],
    feedUrl: "https://people.com/google-news-sitemap.xml", connectorKind: "news-sitemap",
  },
  {
    id: "ndtv", name: "NDTV", group: "english-world", category: "general", rank: 9,
    description: "Indian and international breaking news from NDTV.",
    homepageUrl: "https://www.ndtv.com/", hostnames: ["ndtv.com"],
    feedUrl: "https://feeds.feedburner.com/ndtvnews-top-stories", connectorKind: "rss",
  },
  {
    id: "usa-today", name: "USA Today", group: "english-world", category: "general", rank: 10,
    description: "US national and international reporting from USA Today.",
    homepageUrl: "https://www.usatoday.com/", hostnames: ["usatoday.com"],
    feedUrl: "https://feeds.feedburner.com/UsatodaycomNation-TopStories", connectorKind: "rss",
  },
];

const primarySourceEntries = [
  {
    id: "assemblee-nationale", name: "Assemblée nationale", sourceType: "primary",
    group: "france", category: "public-decisions", rank: 1,
    description: "Les communiqués officiels de l’Assemblée nationale et de ses commissions.",
    homepageUrl: "https://www.assemblee-nationale.fr/", hostnames: ["assemblee-nationale.fr"],
    feedUrl: "https://www.assemblee-nationale.fr/dyn/rss/communiques-de-presse.xml", connectorKind: "rss",
  },
  {
    id: "senat", name: "Sénat", sourceType: "primary",
    group: "france", category: "public-decisions", rank: 2,
    description: "Les derniers rapports publiés par le Sénat et ses commissions.",
    homepageUrl: "https://www.senat.fr/", hostnames: ["senat.fr"],
    feedUrl: "https://www.senat.fr/rss/rapports.rss", connectorKind: "rss",
  },
  {
    id: "cour-des-comptes", name: "Cour des comptes", sourceType: "primary",
    group: "france", category: "public-decisions", rank: 3,
    description: "Les publications et actualités des juridictions financières.",
    homepageUrl: "https://www.ccomptes.fr/fr", hostnames: ["ccomptes.fr"],
    feedUrl: "https://www.ccomptes.fr/fr/rss/general", connectorKind: "rss",
  },
  {
    id: "conseil-constitutionnel", name: "Conseil constitutionnel", sourceType: "primary",
    group: "france", category: "public-decisions", rank: 4,
    description: "Les décisions, saisines et actualités du Conseil constitutionnel.",
    homepageUrl: "https://www.conseil-constitutionnel.fr/", hostnames: ["conseil-constitutionnel.fr"],
    feedUrl: "https://www.conseil-constitutionnel.fr/flux/rss.xml", connectorKind: "rss",
  },
  {
    id: "insee", name: "Insee", sourceType: "primary",
    group: "france", category: "data", rank: 5,
    description: "Les indicateurs et publications conjoncturelles de la statistique publique.",
    homepageUrl: "https://www.insee.fr/fr/accueil", hostnames: ["insee.fr"],
    feedUrl: "https://www.insee.fr/fr/flux/3", connectorKind: "rss",
  },
  {
    id: "drees", name: "Drees", sourceType: "primary",
    group: "france", category: "data", rank: 6,
    description: "Les études et statistiques publiques sur la santé et les solidarités.",
    homepageUrl: "https://drees.solidarites-sante.gouv.fr/", hostnames: ["drees.solidarites-sante.gouv.fr"],
    feedUrl: "https://drees.solidarites-sante.gouv.fr/rss.xml", connectorKind: "rss",
  },
  {
    id: "arcep", name: "Arcep", sourceType: "primary",
    group: "france", category: "data", rank: 7,
    description: "Les décisions et données du régulateur des télécoms, postes et médias.",
    homepageUrl: "https://www.arcep.fr/", hostnames: ["arcep.fr"],
    feedUrl: "https://www.arcep.fr/actualites/suivre-actualite-regulation-arcep/fil-dinfos/rss.xml", connectorKind: "rss",
  },
  {
    id: "arcom", name: "Arcom", sourceType: "primary",
    group: "france", category: "data", rank: 8,
    description: "Les décisions du régulateur de l’audiovisuel et du numérique.",
    homepageUrl: "https://www.arcom.fr/", hostnames: ["arcom.fr"],
    feedUrl: "https://www.arcom.fr/rss/decisions", connectorKind: "rss",
  },
  {
    id: "sante-publique-france", name: "Santé publique France", sourceType: "primary",
    group: "france", category: "alerts", rank: 9,
    description: "Les nouvelles de surveillance, prévention et santé publique.",
    homepageUrl: "https://www.santepubliquefrance.fr/", hostnames: ["santepubliquefrance.fr"],
    feedUrl: "https://www.santepubliquefrance.fr/rss/news/1008", connectorKind: "rss",
  },
  {
    id: "cert-fr", name: "CERT-FR", sourceType: "primary",
    group: "france", category: "alerts", rank: 10,
    description: "Les avis, alertes et bulletins de sécurité informatique du CERT-FR.",
    homepageUrl: "https://www.cert.ssi.gouv.fr/", hostnames: ["cert.ssi.gouv.fr"],
    feedUrl: "https://www.cert.ssi.gouv.fr/feed/", connectorKind: "rss",
  },
  {
    id: "rappel-conso", name: "RappelConso", sourceType: "primary",
    group: "france", category: "alerts", rank: 11,
    description: "Les rappels officiels de produits dangereux publiés par l’administration.",
    homepageUrl: "https://rappel.conso.gouv.fr/", hostnames: ["rappel.conso.gouv.fr"],
    feedUrl: "https://rappel.conso.gouv.fr/rss", connectorKind: "rss",
  },
  {
    id: "cnrs", name: "CNRS", sourceType: "primary",
    group: "france", category: "research", rank: 12,
    description: "Les communiqués de presse sur les résultats scientifiques du CNRS.",
    homepageUrl: "https://www.cnrs.fr/fr", hostnames: ["cnrs.fr"],
    feedUrl: "https://www.cnrs.fr/fr/rss/press.rss", connectorKind: "rss",
  },
  {
    id: "inserm", name: "Inserm", sourceType: "primary",
    group: "france", category: "research", rank: 13,
    description: "Les nouvelles de la recherche biomédicale et en santé de l’Inserm.",
    homepageUrl: "https://www.inserm.fr/", hostnames: ["inserm.fr"],
    feedUrl: "https://www.inserm.fr/actualite/feed/", connectorKind: "rss",
  },
  {
    id: "cea", name: "CEA", sourceType: "primary",
    group: "france", category: "research", rank: 14,
    description: "Les dernières actualités scientifiques et technologiques du CEA.",
    homepageUrl: "https://www.cea.fr/", hostnames: ["cea.fr"],
    feedUrl: "https://www.cea.fr/_layouts/15/i2i/web/ceasrchrss.ashx?pid=3748&wid=g_9cac7691_a0b2_4e18_850e_0aeff2541696", connectorKind: "rss",
  },
  {
    id: "conseil-ue", name: "Conseil de l’Union européenne", sourceType: "primary",
    group: "english-world", category: "public-decisions", rank: 1,
    description: "Les communiqués officiels du Conseil européen et du Conseil de l’Union européenne.",
    homepageUrl: "https://www.consilium.europa.eu/en/", hostnames: ["consilium.europa.eu"],
    feedUrl: "https://www.consilium.europa.eu/en/rss/pressreleases.ashx", connectorKind: "rss",
  },
  {
    id: "oms", name: "Organisation mondiale de la Santé", sourceType: "primary",
    group: "english-world", category: "alerts", rank: 2,
    description: "Les alertes, recommandations et communiqués mondiaux de l’OMS en anglais.",
    homepageUrl: "https://www.who.int/", hostnames: ["who.int"],
    feedUrl: "https://www.who.int/rss-feeds/news-english.xml", connectorKind: "rss",
  },
];

export const PUBLICATIONS = Object.freeze(entries.map((entry) => definePublication({
  ...entry,
  iconPath: `./provider-icons/${entry.id}.png`,
})));

export const PRIMARY_SOURCES = Object.freeze(primarySourceEntries.map((entry) => definePublication({
  ...entry,
  iconPath: `./provider-icons/${entry.id}.png`,
})));

export const CURATED_SOURCES = Object.freeze([...PUBLICATIONS, ...PRIMARY_SOURCES]);

const ids = new Set();
const ranks = new Set();
for (const source of CURATED_SOURCES) {
  if (ids.has(source.id)) throw new TypeError(`Source dupliquée : ${source.id}.`);
  ids.add(source.id);
  const rankKey = `${source.sourceType}:${source.group}:${source.rank}`;
  if (ranks.has(rankKey)) throw new TypeError(`Rang de source dupliqué : ${rankKey}.`);
  ranks.add(rankKey);
}

export const SOURCE_CATALOG = Object.freeze(CURATED_SOURCES.map((source) => Object.freeze({
  id: source.id,
  name: source.name,
  description: source.description,
  sourceType: source.sourceType,
  group: source.group,
  category: source.category,
  rank: source.rank,
  iconPath: source.iconPath,
  homepageUrl: source.homepageUrl,
  connectorKind: source.connectorKind,
  refreshIntervalSeconds: source.refreshIntervalSeconds,
  capabilities: Object.freeze(source.sourceType === "media"
    ? ["optimized-feed", "simplified-reading"]
    : ["optimized-feed"]),
})));

export const CURATED_PROXY_ROOTS = Object.freeze(CURATED_SOURCES.flatMap((source) => [
  source.feedUrl,
  ...(source.enrichment ? [source.enrichment.url] : []),
]));

export function publicationById(id) {
  return PUBLICATIONS.find((publication) => publication.id === id) ?? null;
}

export function publicationForFeedUrl(feedUrl) {
  return PUBLICATIONS.find((publication) => publication.feedUrl === feedUrl) ?? null;
}

export function curatedSourceById(id) {
  return CURATED_SOURCES.find((source) => source.id === id) ?? null;
}

export function curatedSourceForFeedUrl(feedUrl) {
  return CURATED_SOURCES.find((source) => source.feedUrl === feedUrl) ?? null;
}

export function publicSourceCatalog() {
  return SOURCE_CATALOG.map((source) => ({
    ...source,
    capabilities: [...source.capabilities],
  }));
}
