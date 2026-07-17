# VibeDeck

[![Licence MIT](https://img.shields.io/badge/licence-MIT-amber.svg)](./LICENSE)

Application locale de veille pour journalistes. À la création, chaque panel reçoit un type : **Fil** pour agréger des connecteurs ou **Page web** pour afficher un site réel dans l’application. Les panels se disposent librement côte à côte ou l’un au-dessus de l’autre.

![Aperçu de VibeDeck](./artifacts-pilot-final.png)

## Ce qui fonctionne

- jusqu’à neuf onglets persistants, chacun avec ses panneaux redimensionnables et réorganisables ;
- palette sombre à surfaces neutres, avec contrastes renforcés et amber réservé au focus, aux sélections et aux actions principales ;
- panels « Fil » pour fusionner plusieurs médias dans une chronologie unique ;
- pack de démarrage « Veille concurrents » avec Le Monde, Le Figaro et Le Parisien ;
- catalogue visuel local de 30 publications optimisées — 20 françaises et 10 anglophones — rangées dans des catégories repliables par langue et type éditorial, avec recherche globale, véritable icône et capacités « Fil optimisé » et « Lecture simplifiée prioritaire » ;
- intervalle initial commun de 1 minute pour toutes les publications optimisées, modifiable ensuite dans les réglages du fil ;
- premier import traité comme une baseline déjà vue, sans fausse alerte ;
- baseline interclassée par date éditoriale entre les médias ; les arrivées réellement nouvelles restent au-dessus de cette baseline et sont interclassées globalement par date éditoriale, indépendamment de leur cycle de rafraîchissement ;
- à la migration du cache v6, les arrivées antérieures sans identifiant de cycle sont regroupées une seule fois par minute UTC de détection ; les nouveaux cycles conservent ensuite un identifiant temporel exact, partagé et strictement croissant, sans prendre priorité sur la chronologie éditoriale ;
- arrivées suivantes insérées automatiquement sans déplacer le viewport ni la sélection, avec un tampon technique indépendant dans chaque panel qui partage la source ;
- états persistants et distincts `Nouveau`, `Vu` et `Ouvert`, avec filtre `Non vus` ;
- fraîcheur calculée sur la source la moins récente et erreurs datées sans masquer le cache ;
- ajout libre à partir d’un seul champ URL, avec options Auto, RSS, Atom ou Sitemap repliées ;
- test automatique après 700 ms d’inactivité — ou immédiatement avec Entrée — avec annulation à la frappe, format détecté et aperçu borné, sans rattacher la source au fil avant l’enregistrement ;
- fréquence d’actualisation par défaut configurable par fil, de 30 secondes à 30 minutes ;
- panels « Page web » pour garder un direct, un site ou un outil visible dans l’application ;
- aperçu interactif d’une Page web avant création, avec formulaires de connexion utilisables et session du site conservée dans le profil web local ;
- presets pour BFM TV, franceinfo, Le Monde en continu et Google Actualités ;
- ajout d’une page de site, d’un flux RSS/Atom ou d’un Google News Sitemap ;
- reconnaissance directe des 30 publications optimisées ;
- découverte automatique du RSS déclaré par les autres sites ;
- enrichissement des dates du Parisien avec son News Sitemap ;
- recherche locale hybride dans tous les fils, avec résultats FTS5 immédiats puis classement par pertinence combinant keywords et enrichissement E5 hors ligne, filtre explicite et navigation complète au clavier ;
- filtres par source, recherche et état de lecture, composables sans réordonner la chronologie ;
- lecteur web intégré au clic sur un article, avec option d’ouverture externe ;
- lecture simplifiée publique et éphémère pour les articles éligibles des 30 publications, avec repli immédiat vers la page originale pour les abonnements, formats non structurés, blocages et sources personnalisées ;
- actualisation automatique, cache hors ligne et déduplication ;
- backoff automatique des sources en échec, avec actualisation manuelle toujours disponible ;
- destinations locales/privées et redirections vers un autre site refusées avant chaque requête ; les réponses 3xx sont exposées sans suivi automatique, afin que chaque saut repasse par ces vérifications ; sur une route directe, chaque nom doit aussi résoudre uniquement vers des IP publiques, tandis qu’une route proxy n’accepte que les racines HTTPS exactes dérivées du registre des publications, puis leurs redirections HTTPS sur le même site, et refuse toute URL personnalisée ;
- réponses réseau lues progressivement et interrompues à 12 Mo, puis XML contrôlé avant parsing : 2 000 entrées, 50 000 jetons structurels — éléments, commentaires, sections CDATA et éventuelle déclaration XML —, 30 000 attributs, profondeur 64, aucune déclaration DOCTYPE/ENTITY ni instruction de traitement non essentielle et URLs limitées à 4 096 caractères ; l’unique déclaration XML autorisée doit être initiale et tenir sur 256 caractères, la découverte HTML est bornée au `head` utile de 256 Kio, 4 000 éléments et 12 000 attributs, tandis que chaque champ riche d’un article est tronqué à 16 Kio avant nettoyage ;
- import/export d’un dashboard de desk sans articles, cookies ni cache web, avec aperçu des volumes et des domaines contactés avant remplacement ;
- sauvegarde automatique de la configuration précédente lors d’un import, conservée à côté du fichier choisi ou dans le dossier local de l’application ;
- export d’un diagnostic local ne contenant ni titre, ni URL consultée, ni cookie ;
- mesure locale de la durée d’usage actif, uniquement lorsque l’application est visible, non réduite et focalisée ;
- stockage strictement local dans SQLite, sans compte, serveur ou collaboration.

Une URL explicitement liée à un RSS de rubrique ou à un sitemap reste prioritaire : elle n’est jamais remplacée par le flux « en continu » du journal.

Les rafraîchissements passent tous par la même file bornée : six téléchargements simultanés au maximum dans l’application, dont deux par domaine. Ajouter un grand pack de sources ne déclenche donc pas une rafale réseau incontrôlée, et deux demandes simultanées pour une même source mutualisent le téléchargement.

Chaque onglet possède son propre layout et jusqu’à six pages web. Les panels peuvent être déplacés vers une zone explicite d’un autre onglet ; les sources et leur cache restent globaux et réutilisables. Les vues web de l’onglet quitté sont masquées et rendues muettes immédiatement, conservées pendant une grâce de 30 secondes, puis déchargées.

Un onglet peut disposer jusqu’à trois panels sur un même axe horizontal ou vertical. Si le panel ciblé est trop étroit, l’application choisit l’autre orientation ou demande de le redimensionner. Les séparateurs appliquent ensuite une taille minimale réelle de 256 × 176 px à chaque branche, y compris dans un layout imbriqué ou importé. Cette limite maintient les commandes, les états de lecture et les titres utilisables sur l’écran minimal du pilote.

## Lancer l’application

```bash
npm install
npm run dev
```

Raccourcis principaux :

- `Cmd/Ctrl + N` : créer un panel ;
- `Cmd + 1…9` sur macOS ou `Ctrl + 1…9` sur Windows : ouvrir l’onglet à cette position, y compris avec un clavier AZERTY et depuis une page web ;
- `Cmd/Ctrl + K` : ouvrir la recherche globale et placer le focus dans la requête ;
- dans la recherche, `↑` / `↓` sélectionnent un résultat ; `Entrée` filtre les fils depuis le champ ou ouvre le résultat sélectionné ;
- `↑` / `↓` : parcourir le fil sous la souris, avec un défilement fluide et continu quand la touche reste enfoncée ;
- `Entrée` : ouvrir l’article ;
- dans le lecteur, `↑` / `↓` : un appui avance d’une page animée (≈ 28 % de recouvrement visuel), maintenir la touche déclenche un défilement rapide continu ;
- double-appui rapide sur `←` / `→` : passer au panel précédent ou suivant ;
- `Alt + ←` / `Alt + →` : déplacer le panel à la position précédente ou suivante, sans glisser-déposer ;
- `R` : actualiser le fil actif ;
- `Échap` : fermer la recherche sans modifier le filtre actif, puis retirer ce filtre depuis le dashboard ; fermer aussi les réglages.

Le simple déplacement de la souris au-dessus d’un `Fil` lui redonne immédiatement le focus clavier, même depuis un champ, un bouton ou une page web de VibeDeck. Les panels `Page web` et `Nouveau` conservent leurs contrôles actifs au survol. Après la fermeture du lecteur intégré avec `Échap`, la navigation dans le fil reprend directement.

Chaque en-tête de panel permet aussi de diviser l’espace verticalement ou horizontalement et de déplacer le panel par glisser-déposer. Les séparateurs se manipulent à la souris ou au clavier.

## Vérifier et construire

```bash
npm test
npm run test:publications
npm run test:pilot-ui
npm run test:live
npm run build
npm run verify:release
npm audit --omit=dev
npm audit
npm run dist:dir
npm run verify:packaged-fuses
npm run test:packaged
```

`test:publications` vérifie le registre, ses projections privées/publiques, les 20/10 rangs, les racines réseau exactes, les adaptateurs et les 30 PNG locaux. `test:pilot-ui` construit puis pilote Electron sur deux flux RSS et une base temporaires afin de prouver l’interclassement de la baseline, le catalogue, l’ajout URL, le retour clavier depuis le lecteur, la navigation et le déplacement avec conservation du focus, la géométrie minimale des panels, l’indépendance des tampons partagés et l’absence de déplacement du viewport lors des arrivées. La suite ne vole jamais le focus de l’écran : sur macOS la fenêtre reste totalement cachée (sans icône du Dock), ailleurs elle s’affiche sans être activée ; définir `VIBEDECK_PILOT_UI_SHOW=1` pour retrouver la fenêtre au premier plan pendant un débogage. En cas d’échec, elle conserve `.context/pilot-ui-failure.png`, uploadé par la CI comme diagnostic éphémère. `test:live` interroge réellement les 30 flux et vérifie au plus cinq décisions du lecteur par publication sans journaliser les articles testés ; il reste hors CI automatique car il dépend du réseau réel et doit être exécuté depuis le réseau cible. La lecture simplifiée est toujours tentée en premier ; son indisponibilité ponctuelle est normale pour un article réservé, bloqué, vidéo ou insuffisamment structuré, et déclenche alors la page originale sans contournement. `dist:dir` produit une application locale dans `release/`, `verify:packaged-fuses` lit directement le binaire Electron produit et `test:packaged` lance ce paquet via son ASAR et son protocole interne. La CI construit en plus le DMG/ZIP macOS et l’installateur NSIS Windows non signés, puis lance l’application réellement distribuée avant de valider le check stable `CI required`.

Les commandes `dist:mac:signed` et `dist:win:signed` imposent la présence des identifiants de diffusion. Windows utilise Azure Artifact Signing sans clé privée exportée lorsque `ENABLE_WINDOWS_SIGNING=true`; tant que cette variable est absente ou fausse, le workflow de release produit explicitement un installateur Windows non signé. Chaque branche vérifie les fuses, lance le paquet réel et publie l’EXE, sa blockmap et `latest.yml`. Le job final génère `release/SHA256SUMS.txt`, puis recalcule chaque somme avant de marquer la release comme `latest`. La notarisation macOS, la signature Windows et le réseau d’entreprise AFP restent donc des validations externes. Le protocole complet est décrit dans [PILOT_RELEASE.md](./PILOT_RELEASE.md).

Les versions sont préparées par Release Please à partir des commits Conventional Commits. Release Please ne s’exécute qu’après un `pilot-build` vert sur un push de `main`, et la protection de branche exige `CI required` avant toute fusion, Release PR comprise. Fusionner cette Release PR met à jour la version et le changelog, puis un nouveau passage vert sur `main` crée le tag `vX.Y.Z` et une GitHub Release non publique. Le workflow de diffusion vérifie encore que le SHA tagué porte le check `CI required` émis par GitHub Actions ; il ne rejoue pas les tests et audits génériques, mais conserve les gates propres à la diffusion : signature/notarisation macOS, paquet réel, métadonnées et checksums. À partir de la première version postérieure à `v0.10.0`, une release incomplète ou privée de son installateur Windows reste donc en brouillon. La signature Azure temporairement manquante est suivie dans [WINDOWS_RELEASE_TODO.md](./WINDOWS_RELEASE_TODO.md). À partir de la version 0.3.0, l’application télécharge les versions stables en arrière-plan et propose explicitement de redémarrer lorsqu’elles sont prêtes, y compris sur Windows via `latest.yml`.

## Architecture

Le rendu React ne contacte jamais directement les journaux. Le processus principal Electron télécharge et normalise les flux, puis conserve dashboard, panneaux, sources, articles et métadonnées HTTP dans une base SQLite locale. Une même source est mutualisée entre plusieurs panneaux et un échec réseau ne supprime jamais les articles déjà reçus. La recherche utilise un index dérivé et supprimable dans le profil local ; l’application empaquetée conserve le modèle E5 dans un cache stable identifié par son `appId`, tandis que chaque environnement de développement garde sa propre copie. Le modèle et l’index ne modifient jamais `vibedeck.sqlite3` et ne font pas partie des exports.

La durée d’usage du pilote est comptabilisée localement par intervalles d’une minute et lors des changements de focus ou de visibilité. Chaque intervalle actif est ventilé à la milliseconde entre les journées civiles du fuseau local du poste, y compris au passage de minuit et lors des changements d’heure. Les 400 journées les plus récentes restent détaillées ; les plus anciennes sont fusionnées dans un cumul qui préserve le total exact. Seules des durées et des quantités agrégées sont exportées dans le diagnostic : aucun identifiant de panel ou d’article n’est exporté, afin qu’une URL publique candidate ne permette pas de réidentifier ce qui a été ouvert.

Les panels Page web, leur aperçu de création et le lecteur d’article utilisent des vues natives Electron isolées du reste de l’application, sans accès Node, avec permissions et téléchargements refusés par défaut. L’aperçu est une vue temporaire autorisée par le processus principal : sa confirmation recrée le panel depuis l’URL validée par le main process, tandis que cookies, stockage local et cache restent disponibles grâce au profil Chromium persistant partagé. Pour les 30 publications validées, un adaptateur dédié télécharge uniquement le document HTML public dans une session Chromium mémoire partagée par publication, sans cookie ni cache, avec un budget de 900 ms et une limite de 2 Mio. Avant chaque requête et redirection, cette même session doit confirmer une route directe et des adresses IP publiques ; sinon le lecteur bascule sans requête vers la page originale. Aucun script, publicité, police ou autre sous-ressource de la page n’est chargé. Le processus principal extrait des données texte bornées avec Cheerio, puis ne montre qu’un document statique échappé avec CSP restrictive. Aucun HTML de publication ne passe au renderer et aucun contenu d’article n’est conservé. Une extraction incertaine, payante, bloquée ou trop courte recrée immédiatement la même vue avec le profil web persistant et affiche la page originale. Les sources personnalisées suivent directement ce dernier chemin. Les liens demandant une nouvelle fenêtre restent dans la page courante ; l’ouverture externe demeure une action explicite. À la fermeture d’une vue, ses service workers sont arrêtés sans effacer les cookies, le stockage local ou le cache HTTP utiles aux autres vues ; les origines encore ouvertes restent intactes.

En production, l’interface est chargée par le protocole interne sécurisé `vibedeck-app://` et non par `file://`. Le paquet désactive notamment l’exécution d’Electron comme Node, les options Node injectées par l’environnement et les privilèges supplémentaires du protocole fichier ; l’intégrité de l’ASAR et le chiffrement des cookies sont activés. La vérification des fuses se fait sur le binaire réellement empaqueté, pas seulement sur la configuration du projet.

Le type de panel est un modèle extensible : les futurs panels « Liste X », « Feed X » ou « Compte X » pourront rejoindre le sélecteur sans modifier le moteur de layout.

Les connecteurs génériques couvrent RSS, Atom et News Sitemap. Le registre validé `electron/publication-registry.mjs` est l’interface unique pour ajouter une publication optimisée ; il dérive automatiquement le catalogue public, la reconnaissance d’URL, les racines proxy exactes et les adaptateurs lecteur. La recette détaillée se trouve dans `AGENTS.md` et `CLAUDE.md`.

## Périmètre et droits

Cette V0 sert à valider le produit localement. Les éditeurs peuvent restreindre l’usage professionnel ou collectif de leurs flux. Avant un pilote AFP, il faut vérifier les licences de syndication existantes ou obtenir les autorisations nécessaires auprès des publications concernées. Aucun contournement de protection anti-bot n’est implémenté.

Le code source de VibeDeck est distribué sous [licence MIT](./LICENSE), copyright 2026 The Vibe Company. Cette licence ne modifie pas les droits attachés aux contenus ou aux flux des publications consultées.
