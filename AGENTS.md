# AGENTS.md — VibeDeck

Ce fichier s’applique à tout le dépôt. Il décrit les règles que tout humain ou agent doit préserver lorsqu’il modifie VibeDeck.

## Mission du produit

VibeDeck est un agrégateur de veille local pour journalistes. Il remplace une accumulation d’onglets par un dashboard composé de panels :

- `Fil` agrège plusieurs sources RSS, Atom, News Sitemap ou connecteurs spécialisés ;
- `Page web` affiche un vrai site dans une vue native isolée ;
- le layout se divise horizontalement ou verticalement et reste utilisable au clavier comme à la souris.

La V0 doit rester simple, rapide et locale. La complexité appartient au moteur, pas à l’interface.

## Priorités, dans cet ordre

1. Ne jamais perdre ni corrompre la configuration ou le cache local.
2. Ne jamais perturber la lecture en cours lors d’une arrivée ou d’un rafraîchissement.
3. Garder les frontières Electron, réseau et fichiers strictes.
4. Préserver l’usage intensif au clavier et la faible charge cognitive.
5. Maintenir macOS et Windows au même niveau de qualité.
6. Ajouter une abstraction seulement lorsqu’un besoin réel la justifie.

## Périmètre actuel

Sauf demande explicite, ne pas introduire :

- compte, serveur, synchronisation ou collaboration ;
- email, WhatsApp, Signal, Telegram ou X/Twitter ;
- résumé, classement ou génération par IA ;
- télémétrie distante ;
- contournement d’anti-bot, de paywall ou de restriction d’accès.

Les futurs types de panels doivent étendre le modèle existant sans spécialiser le moteur de layout.

## Carte du dépôt

- `src/` : renderer React, état d’interface, layout, navigation clavier et présentation des fils.
- `electron/main.mjs` : composition du processus principal et validation de tous les IPC.
- `electron/feed-engine.mjs` : réseau, découverte de flux, parsing, cache et connecteurs spécialisés.
- `electron/database.mjs` : schéma SQLite, migrations et mutations atomiques.
- `electron/web-panel-controller.mjs` : vues web natives, navigation, permissions et cycle de vie.
- `electron/preload.cjs` : unique API exposée au renderer.
- `scripts/` : parcours pilote, contrôles du paquet et garde-fous de release.
- `.github/workflows/` : builds macOS/Windows et releases signées.
- `PILOT_RELEASE.md` : protocole de diffusion et gates externes.

## Invariants d’architecture

### Frontière Electron

- Le renderer ne contacte jamais directement une publication et n’accède jamais à Node, SQLite ou au système de fichiers.
- Toute capacité renderer → main passe par une méthode étroite de `preload.cjs`, un canal IPC dédié et une validation fail-closed dans `main.mjs`.
- Ne jamais exposer au renderer un objet interne de restauration, une instance de base, un chemin arbitraire ou une primitive Electron brute.
- Les opérations composites restent possédées par le processus principal. La sauvegarde d’un fil doit demeurer une seule opération main-owned, suivie dans `activeOperations`.

### Configuration et persistance

- Une source est globale et peut être partagée par plusieurs panels. Modifier une source peut donc affecter plusieurs vues.
- Toute sauvegarde de configuration doit soit réussir entièrement, soit restaurer exactement le panel, l’ordre des rattachements et tous les champs source mutables.
- Le checkpoint de rollback reste privé au main process et la restauration SQLite reste transactionnelle.
- Les mutations structurelles sont sérialisées dans les deux ordres : `save → add` et `add → save`.
- Après succès, échec ou rollback, diffuser l’état réel final. Ne jamais laisser le renderer sur un état intermédiaire.
- Les nouvelles sources téléchargées avant un échec peuvent rester comme cache local détaché, mais aucune modification visible du fil ne doit subsister.
- Toute migration doit être ascendante, testée depuis les versions historiques couvertes et refuser un schéma futur inconnu.

### Réseau et connecteurs

- Les URLs personnalisées acceptent uniquement HTTP(S), sans identifiants intégrés.
- Préserver les protections SSRF à chaque redirection : résolution DNS publique, refus des réseaux privés et politique proxy fail-closed.
- Derrière un proxy, seules les racines HTTPS explicitement autorisées pour les connecteurs optimisés peuvent être utilisées ; ne pas élargir cette liste par motif de domaine vague.
- Respecter les budgets de réponse, cardinalité, profondeur XML, attributs, HTML de découverte et longueur d’URL existants.
- Refuser `DOCTYPE`, `ENTITY` et les instructions de traitement XML non essentielles avant parsing.
- Un échec réseau conserve toujours le dernier cache exploitable et produit une erreur compréhensible.
- Les tests unitaires utilisent des réponses déterministes ; `npm run test:live` est la seule preuve dépendante du réseau réel.
- Les publications optimisées sont déclarées uniquement dans `electron/publication-registry.mjs` avec `definePublication()` ; `feed-engine.mjs`, le catalogue public, les racines proxy et les adaptateurs lecteur en sont dérivés.

### Ajouter une publication optimisée

1. Vérifier un flux officiel HTTPS RSS, Atom ou News Sitemap et un article public lisible sans contournement.
2. Déposer une icône officielle PNG de `96 × 96 px`, limitée à 64 Kio, dans `public/provider-icons/<id>.png`.
3. Ajouter une définition au registre avec identité, langue/groupe, catégorie éditoriale, rang, page d’accueil, domaines exacts, flux et uniquement les exceptions du lecteur commun. L’intervalle par défaut de 60 secondes est automatique ; toute exception doit être explicitement justifiée et testée.
4. Fournir ou adapter le fixture lecteur déterministe ; couvrir le bon domaine, le mauvais domaine, les publicités, le paywall et le blocage.
5. Exécuter `npm run test:publications`, `npm test`, `npm run build`, puis `npm run test:live` si le réseau est disponible.
6. Vérifier les droits du flux et de l’icône. Toute nouvelle racine proxy exacte exige une revue sécurité explicite ; ne jamais autoriser un domaine entier ou un motif large.

### Vues web

- Conserver `contextIsolation`, l’absence de Node, le refus des permissions, téléchargements et popups.
- Une navigation initiée par une page ne doit pas contourner la validation d’URL.
- L’ouverture externe reste une action utilisateur explicite.
- Fermer une vue ne doit pas effacer les données utiles aux autres vues de la même origine.

## Invariants UI et produit

- Less is more : peu de commandes visibles, libellés courts, densité utile élevée.
- L’amber est un signal, pas une décoration : focus, sélection, arrivée ou action principale uniquement.
- Ne pas multiplier badges, bordures, cartes imbriquées, textes d’aide ou couleurs concurrentes.
- Chaque branche du layout doit conserver une taille réelle minimale de `256 × 176 px`, y compris après import et dans un arbre imbriqué.
- Une arrivée est promue automatiquement depuis le tampon propre au panel, sans déplacer le viewport, la sélection ou le focus.
- `Nouveau`, `Vu` et `Ouvert` sont trois états distincts et persistants.
- Le focus visuel et `document.activeElement` doivent toujours raconter la même chose.
- Le survol d’un `Fil` lui rend immédiatement le clavier, même depuis un champ, un bouton actif ou une page web de VibeDeck ; les panels `Page web` et `Nouveau` protègent leurs contrôles actifs.
- `Entrée`, `Échap`, les flèches, la double-flèche entre panels et `Alt + flèche` sont des contrats produit.
- Le scroll clavier est fluide : dans le fil, maintenir une flèche fait glisser la sélection en continu ; dans le lecteur, un appui avance d'une page animée en conservant environ 28 % de recouvrement visuel et maintenir la flèche déclenche un défilement continu. `prefers-reduced-motion` restaure les sauts instantanés.
- Un drag externe ou un MIME forgé ne doit jamais modifier le layout.

## Conventions de code

- Node.js `>=22.18.0` est le plancher du projet.
- Le projet est ESM, sauf `electron/preload.cjs` qui reste CommonJS pour Electron.
- Respecter les types et noms métier existants : `feed`, `web`, `source`, `panel`, `layout`.
- Préférer une petite fonction pure testable à une condition complexe enfouie dans un composant.
- Valider à la frontière, normaliser une fois, puis travailler avec des valeurs propres.
- Borner toute collection, chaîne ou document fourni par un fichier, le réseau ou le renderer.
- Ne pas ajouter de dépendance si la plateforme ou une fonction locale courte suffit.
- Toute dépendance ajoutée doit être épinglée dans `package.json` et `package-lock.json`, avec audits à zéro.
- Ne jamais journaliser titre d’article, URL consultée, cookie, contenu de page ou secret.

## Méthode de modification

Avant de changer le code :

1. Lire les fichiers directement concernés et leurs tests.
2. Vérifier `git status` et préserver toute modification qui ne vous appartient pas.
3. Identifier la frontière touchée : renderer, IPC, moteur, base, réseau, vue web ou release.
4. Énoncer l’invariant qui doit rester vrai après le changement.

Pendant la modification :

- garder le patch aussi local que possible ;
- ne pas affaiblir un contrôle pour faire passer un test ;
- ne pas supprimer silencieusement du cache ou de la configuration ;
- traiter explicitement annulation, erreur, fermeture et concurrence pour toute opération asynchrone ;
- ajouter le test qui aurait échoué avant le correctif.

## Tests requis

Le minimum avant de déclarer un changement terminé :

```bash
npm test
npm run build
```

Ajouter selon le périmètre :

- UI, clavier, focus, layout, buffers : `npm run test:pilot-ui` (ne vole jamais le focus de l’écran : fenêtre cachée sur macOS, affichée sans activation ailleurs ; `VIBEDECK_PILOT_UI_SHOW=1` pour la mettre au premier plan en débogage) ;
- connecteur ou politique réseau : tests ciblés puis `npm run test:live` si le réseau est disponible ;
- preload, IPC, SQLite ou import/export : tests Electron correspondants et scénario d’échec/rollback ;
- release, dépendances ou packaging : `npm run verify:release` et les deux audits npm ;
- paquet Electron : construire un paquet frais, puis exécuter `npm run verify:packaged-fuses` et `npm run test:packaged` sur ce paquet.

Pour un changement prêt à être livré, exécuter :

```bash
npm ci
npm test
npm run test:pilot-ui
npm run test:live
npm run verify:release
npm audit --omit=dev
npm audit
```

Les signatures macOS/Windows, la notarisation Apple et la recette réseau AFP sont des gates externes : ne jamais les déclarer réussies sur la base d’un build local non signé.

## Règles de test importantes

- Pour le clavier, vérifier le vrai focus DOM, puis l’action clavier suivante dans la destination ; une classe CSS ne suffit pas.
- Pour un rollback, comparer l’état exact avant/après, y compris ordre, sources orphelines et champs partagés.
- Tester les courses dans les deux sens, ainsi que l’annulation et la libération des verrous.
- Utiliser une base et un profil temporaires ; ne jamais dépendre des données locales du développeur.
- Séparer le contrat multiplateforme des garanties POSIX. Les bits de permission Unix ne se testent pas sur Windows.
- Un test du paquet doit utiliser l’application réellement empaquetée et son protocole `vibedeck-app://`, pas seulement le serveur Vite.

## Git, PR et release

- Titres de PR et commits au format Commitizen/Conventional Commits, par exemple `feat(veille): ajouter un connecteur`.
- Une PR doit expliquer le résultat utilisateur, les validations, les risques et le retour arrière.
- Ne jamais fusionner, publier une release ou pousser sur `main` sans demande explicite.
- Ne pas committer `node_modules/`, `dist/`, `release/`, bases SQLite, profils Electron, certificats, secrets ou rapports de travail internes.
- Les GitHub Actions sensibles restent épinglées sur un SHA complet. Les références locales, Docker, dynamiques ou mutables sont refusées par le garde-fou de release.
- Ne jamais contourner `forceCodeSigning`, les fuses Electron, l’intégrité ASAR ou les checksums pour produire un artefact.

## Définition de terminé

Un changement est terminé lorsque :

- le comportement demandé est réellement utilisable dans l’application ;
- les invariants concernés sont explicitement protégés ;
- les tests proportionnés au risque sont verts ;
- les audits restent propres ;
- le diff ne contient ni secret, artefact généré ni modification étrangère ;
- les limites ou validations externes restantes sont dites clairement ;
- la documentation est mise à jour si le contrat utilisateur ou l’architecture change.

En cas de doute, choisir la solution qui cache le plus de complexité au journaliste tout en conservant la preuve la plus forte dans le moteur et les tests.
