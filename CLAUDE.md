# CLAUDE.md — VibeDeck

Lire et appliquer `AGENTS.md` avant toute modification. Les règles de sécurité Electron, réseau, SQLite, clavier et release qu’il contient sont des invariants du produit.

## Ajouter une publication optimisée

Le registre `electron/publication-registry.mjs` est l’unique source de vérité. Une entrée validée par `definePublication()` produit automatiquement le catalogue public, la reconnaissance d’URL, les racines proxy exactes et l’adaptateur de lecture. Ne recopier une publication ni dans le renderer, ni dans `feed-engine.mjs`, ni dans `article-reader.mjs`.

1. Vérifier un endpoint officiel HTTPS RSS, Atom ou News Sitemap et au moins un article public lisible sans contourner paywall, anti-bot ou restriction d’accès.
2. Déposer l’icône officielle dans `public/provider-icons/<id>.png`, normalisée à 96 × 96 px et limitée à 64 Kio.
3. Ajouter une seule définition au tableau `entries` du registre : identité, langue/groupe, catégorie éditoriale (`general`, `local`, `business`, `sports` ou `culture`), rang, page d’accueil, domaines exacts, flux et éventuelles exceptions de lecteur ou d’enrichissement. L’intervalle hérité est de 60 secondes ; ne le préciser que pour une exception produit explicitement validée.
4. N’ajouter au profil lecteur que les exceptions aux sélecteurs communs. Une extraction incertaine doit conserver le repli vers la page originale.
5. Ajouter ou adapter le fixture HTML synthétique dans `electron/article-reader.test.mjs`. Les tests doivent couvrir le bon domaine, un mauvais domaine, le retrait des publicités et le repli paywall/blocage.
6. Exécuter `npm run test:publications`, `npm test`, `npm run build`, puis `npm run test:live` lorsque le réseau est disponible.
7. Vérifier les droits d’utilisation du flux et de l’icône. Toute nouvelle racine proxy doit faire l’objet d’une revue sécurité explicite ; ne jamais autoriser un domaine ou un motif large à la place de l’URL HTTPS exacte.

Si l’objectif est seulement d’ajouter une source libre, aucune modification de code n’est requise : l’utilisateur colle l’URL du site ou du flux dans l’interface, qui détecte le format après 700 ms et ne l’attache qu’après un test réussi et l’enregistrement du fil.
