# VibeDeck — runbook du pilote AFP

Ce document décrit les vérifications nécessaires avant de remettre une version à un desk AFP. Il ne remplace ni la validation sécurité de la DSI ni la validation juridique des droits attachés aux flux.

## Périmètre de la version 0.2

- fil local RSS, Atom ou Google News Sitemap ;
- pages web interactives dans l’application ;
- baseline au premier import, puis états distincts `nouveau`, `vu` et `ouvert` ;
- arrivées mises en attente pour ne jamais déplacer un journaliste en cours de lecture ;
- état de fraîcheur et erreurs explicites par source ;
- configuration de desk importable et exportable ;
- aperçu explicite du nombre de panels, sources et domaines avant import, puis sauvegarde automatique du dashboard remplacé ;
- diagnostic et métriques de pilote stockés localement ;
- aucune collaboration, IA générative, automatisation X ou lecture de cache WhatsApp/Signal.

## Vérification fonctionnelle

```bash
npm ci
npm test
npm run build
npm run test:pilot-ui
npm run test:live
npm run verify:release
```

Le test live doit être exécuté depuis le réseau cible. Il doit confirmer que Le Monde, Le Figaro et Le Parisien retournent chacun des éléments exploitables, sans panne silencieuse.

## Réseau AFP

Sur un poste géré, vérifier au minimum :

- détection du proxy système ;
- inspection TLS et chaîne de certificats AFP ;
- résolution DNS sur VPN et hors VPN ;
- accès aux trois flux de référence et aux pages web du desk ;
- comportement hors ligne : les articles en cache restent disponibles et la source est déclarée obsolète ;
- reprise après veille et changement de réseau.

Les rafraîchissements RSS, Atom et Sitemap sont bornés à six requêtes simultanées dans l’application et deux par nom d’hôte. Une même source demandée plusieurs fois est téléchargée une seule fois. Chaque document est limité à 12 Mo décompressés. Avant le parseur XML, un scanner linéaire impose au maximum 2 000 entrées, 50 000 jetons structurels — éléments, commentaires, sections CDATA et éventuelle déclaration XML —, 30 000 attributs et 64 niveaux ; les déclarations DOCTYPE/ENTITY et les instructions de traitement non essentielles sont refusées. L’unique déclaration XML admise doit être initiale, conforme et limitée à 256 caractères. Les URLs sont bornées à 4 096 caractères avant identification ou persistance. La découverte d’un flux dans une page HTML est limitée au `head` utile de 256 Kio, 4 000 éléments et 12 000 attributs ; le balisage riche d’un champ de flux est limité à 16 Kio avant nettoyage. La recette doit toutefois inclure un pack volumineux et confirmer avec les équipes réseau que ces limites conviennent aux politiques AFP.

Les URLs littérales de loopback, link-local et réseaux privés, ainsi que les noms `localhost`, `.local` et `.internal`, sont refusés dans le build de diffusion. Avant chaque requête et chaque saut de redirection en accès direct, la session Chromium réservée aux flux résout aussi le nom et refuse l’ensemble de la destination si une adresse A ou AAAA est locale, privée, réservée, CGNAT, ULA ou IPv4-mappée. La résolution et le téléchargement utilisent immédiatement la même session et son cache DNS afin de réduire la fenêtre de rebinding ; l’échec de résolution est fermé dans le paquet de production.

Un proxy HTTP ou SOCKS peut toutefois résoudre la cible de son propre côté : l’application ne peut alors pas prouver l’IP réellement choisie par le proxy. La V0 adopte donc une politique volontairement restrictive. Si `resolveProxy` annonce une route non `DIRECT` — même avec un fallback direct — seules quatre racines HTTPS exactes codées en dur sont autorisées : les trois flux des connecteurs optimisés Le Monde, Le Figaro et Le Parisien, plus le sitemap d’enrichissement du Parisien. Leurs redirections doivent rester en HTTPS sur le même site. Toute autre URL — y compris un chemin personnalisé ou une variante HTTP sur l’un de ces domaines — est bloquée avant la requête. Cette exception est une confiance explicite dans ces quatre endpoints, dans la validation TLS de Chromium et dans la politique PAC/DNS du réseau AFP, pas une preuve technique de l’IP distante. La recette DSI doit donc vérifier le split-DNS et les routes PAC de ces endpoints ; tout élargissement du catalogue proxy exigera une nouvelle racine de confiance revue.

Les redirections et les flux découverts automatiquement doivent en plus rester sur le même site enregistrable ; sinon le journaliste doit ajouter directement l’URL finale. Un futur flux réellement interne AFP devra disposer d’un consentement explicite et d’une politique dédiée avant d’entrer dans le pilote.

Un proxy nécessitant une authentification interactive (`407 Proxy Authentication Required`) n’est pas pris en charge automatiquement dans cette version : les demandes d’identifiants émises par les vues web sont refusées par défaut. Si le poste AFP ne fournit pas déjà l’authentification via le système, le SSO ou le PAC, ce cas constitue un gate bloquant à traiter avec la DSI avant le pilote ; il ne faut pas ajouter d’identifiants dans l’application ou dans son diagnostic.

Le diagnostic exporté ne doit contenir ni titre d’article, ni URL consultée, ni cookie, ni contenu de page privée.

### Diagnostic proxy/PAC anonymisé

L’action « Exporter le diagnostic » demande à la session Chromium réservée aux flux de résoudre le proxy de chaque source. Le bloc `enterpriseNetwork.sources` ne contient que :

- `sourceId` : identifiant technique local de la source ;
- `resolutionStatus` : `resolved`, `failed` ou `unavailable` ;
- `routeTypes` : une liste limitée à `direct`, `proxy`, `https-proxy`, `socks`, `quic` ou `unknown`.

Le résultat brut de `resolveProxy`, l’adresse du PAC, les noms d’hôtes, ports, URLs et messages d’erreur ne sont jamais écrits dans le diagnostic. `failed` signifie uniquement que Chromium n’a pas fourni de décision exploitable, à cause d’une erreur ou du délai maximal ; ce statut ne révèle pas la cause. Une résolution réussie confirme le choix de route, pas l’accessibilité du flux ni la validité de la chaîne TLS.

Pour la recette AFP, exporter successivement un diagnostic en accès direct, derrière le proxy/PAC puis dans un cas de résolution volontairement indisponible. Vérifier que les catégories changent comme prévu et qu’aucune donnée réseau brute n’apparaît dans le JSON avant de transmettre le fichier.

### Durée active locale

Une session pilote est ouverte localement au démarrage. Un battement est enregistré toutes les 60 secondes ainsi que lors des changements de focus, visibilité ou réduction de la fenêtre. Le temps n’est considéré actif que si au moins une fenêtre VibeDeck est visible, non réduite et focalisée.

Depuis le schéma SQLite v6, chaque delta actif est découpé exactement aux limites des journées civiles du fuseau local du poste. Un battement retardé de plus de deux minutes reste plafonné à deux minutes avant cette ventilation, afin qu’une veille ou une suspension ne soit jamais comptée comme du temps actif. Une journée peut donc recevoir de la durée sans nouvelle session si l’application est restée ouverte après minuit. Les compteurs quotidiens signifient : session démarrée le jour indiqué, fermeture normale ce jour-là, ou session interrompue dont le dernier battement appartient à ce jour.

Les 400 journées locales les plus récentes sont conservées individuellement. Les journées plus anciennes sont agrégées dans un cumul borné, sans perte du total de durée ni des compteurs. Lors de la migration v5 vers v6, la durée historique d’une session — auparavant disponible uniquement sous forme d’un total indivisible — est attribuée à sa journée locale de démarrage ; le total global est conservé exactement. Tous les nouveaux deltas sont ensuite ventilés réellement.

Le diagnostic contient uniquement les durées agrégées et le nombre de sessions. Les événements récents exportés ne contiennent aucun identifiant de panel, source ou article ; les événements d’ouverture n’enregistrent plus l’identifiant déterministe de l’article. L’identifiant interne de session n’est exposé ni au renderer ni au JSON. Une fermeture normale clôt la session avant la fermeture de SQLite ; après un arrêt brutal, le lancement suivant classe automatiquement l’ancienne session comme interrompue. Cette mesure reste locale et ne constitue aucune télémétrie distante.

## macOS

La diffusion directe exige un certificat `Developer ID Application` et des identifiants de notarisation Apple configurés uniquement dans les secrets CI.

Release Please maintient la Release PR, `package.json`, `package-lock.json`, `.release-please-manifest.json` et `CHANGELOG.md`. Après fusion de cette PR, il crée un tag `vX.Y.Z` et une GitHub Release brouillon. Tant que `ENABLE_WINDOWS_RELEASE` vaut `false`, le tag déclenche uniquement le build macOS signé et le brouillon devient public après validation exacte des artefacts macOS et de leurs checksums. Le secret d’organisation `RELEASE_PLEASE_TOKEN` doit être autorisé uniquement pour ce dépôt et disposer des permissions Contents, Pull Requests et Issues en écriture.

Le secret `APPLE_API_KEY` accepte le contenu brut du fichier `.p8` ou sa version encodée en base64. `MAC_CSC_LINK` contient le certificat `.p12` encodé en base64 ; les mots de passe et identifiants ne sont jamais stockés dans le dépôt.

```bash
npm run dist:mac:signed
npm run verify:packaged-fuses
codesign --verify --deep --strict --verbose=2 "release/mac-universal/VibeDeck.app"
spctl --assess --type execute --verbose=2 "release/mac-universal/VibeDeck.app"
xcrun stapler validate "release/mac-universal/VibeDeck.app"
npm run checksums:release
npm run verify:checksums
```

Le job `release-signed` refuse de produire une version de diffusion si le certificat est absent. Ses actions tierces sont épinglées par SHA, le tag doit correspondre exactement à la version de `package.json` et pointer sur l’historique de `main`, et le bundle contenu dans le DMG est monté, vérifié puis réellement lancé avant publication. Le ZIP et `latest-mac.yml` sont publiés avec le DMG pour permettre l’auto-mise à jour.

Les secrets de signature doivent vivre uniquement dans l’environnement GitHub `signed-release`, protégé par un reviewer obligatoire. Le dépôt doit être public seulement après un scan de secrets de tout son historique ; `main` et les tags `v*` restent protégés. Les certificats ne doivent pas être provisionnés tant que ces règles et le reviewer `StanGirard` ne sont pas en place.

Sur un dossier synchronisé par iCloud/FileProvider, macOS peut réattacher des attributs étendus au bundle et invalider une vérification locale stricte. Construire et vérifier la version de diffusion sur le disque temporaire du runner CI ou dans un dossier local non synchronisé, puis vérifier également l’application réellement contenue dans le DMG. Ce phénomène ne doit jamais être contourné en relâchant les contrôles de signature.

## Windows

La publication Windows est temporairement désactivée avec la variable GitHub `ENABLE_WINDOWS_RELEASE=false`. Voir [WINDOWS_RELEASE_TODO.md](./WINDOWS_RELEASE_TODO.md) pour le blocage Azure et la procédure de réactivation. Une release déjà publiée en mode macOS uniquement reste immuable : Windows doit être activé avant le tag d’une version SemVer supérieure.

Le build x64 et l’installateur doivent être produits sur une machine Windows ou par le job CI Windows.

```powershell
npm ci
npm run dist:win:signed
npm run verify:packaged-fuses
Get-AuthenticodeSignature "release\VibeDeck Setup 0.2.0.exe"
npm run checksums:release
npm run verify:checksums
```

Vérifier installation, premier lancement, installation d’une version supérieure, désinstallation et absence de données résiduelles non documentées. Tester au moins Windows 11 x64 sur un poste géré AFP.

La variable d’environnement GitHub `WIN_PUBLISHER_NAME` doit contenir exactement le nom juridique validé par Azure Artifact Signing. Le job Windows s’authentifie avec une application Entra limitée au rôle `Artifact Signing Certificate Profile Signer`, puis electron-builder signe l’application et l’installateur avec le profil public configuré. L’installateur, sa blockmap et `latest.yml` sont attachés au même brouillon que les artefacts macOS. La release reste invisible tant que le job final n’a pas validé les deux plateformes.

## Mise à jour automatique

À partir de la version 0.3.0, l’application installée vérifie le canal stable public au démarrage puis toutes les six heures. Une nouvelle version est téléchargée en arrière-plan, mais son installation reste une action explicite « Redémarrer ». Avant de lancer l’installeur, le main process annule les rafraîchissements, attend les mutations actives, ferme les vues web puis SQLite. La version 0.2.0 ne contient pas ce mécanisme et doit donc être remplacée une dernière fois manuellement.

Une release publiée est immuable. En cas de défaut, publier une version SemVer supérieure ; ne jamais remplacer un installateur ou un fichier `latest*.yml` existant. Un workflow manuel peut reprendre un brouillon associé à un tag existant, mais ne peut pas inventer une nouvelle version.

## Gate du pilote

Avant le premier shift :

- aucune fausse nouveauté issue de la baseline ;
- une première réponse valide mais vide laisse la baseline en attente jusqu’aux premiers articles ;
- aucune insertion qui déplace le viewport ou la sélection ;
- une source utilisée dans deux panels conserve un tampon d’arrivées indépendant dans chacun ;
- état global calculé sur la source la moins fraîche ;
- cache visible lorsque le réseau échoue ;
- configuration du desk installable en moins d’une minute ;
- domaines contactés par cette configuration relus et acceptés dans l’aperçu d’import ;
- export du diagnostic validé sur un cas sain et un cas en erreur ;
- application signée sur la plateforme distribuée.

Pendant le pilote, consigner chaque jour : durée d’usage, sources en erreur, signaux utiles, éléments manqués et maintien éventuel des anciens onglets Chrome.
