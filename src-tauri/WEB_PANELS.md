# Vues web natives Tauri/Wry

`src/web_panels.rs` possède les child webviews de publications. Le renderer
local ne reçoit aucun handle Wry et la capability Tauri reste limitée au label
exact `main`. Les labels générés (`web-panel-native-*`) ne correspondent donc à
aucune capability.

## Contrat commun macOS / Windows

- six vues persistantes au maximum ;
- deux chargements natifs simultanés au maximum, avec le panel focalisé en
  tête de file ;
- navigation principale limitée à HTTP(S), sans identifiants dans l'URL, à
  chaque navigation et redirection vue par Wry ;
- popups refusées et téléchargements annulés par les hooks natifs ;
- un overlay masque toutes les vues et restaure ensuite uniquement celles que
  le layout demandait visibles ;
- création hors-écran, puis application des dimensions ; une vue qui doit
  rester masquée reçoit `hide` avant son déplacement. Les redimensionnements
  visibles évitent volontairement un cycle `hide`/`show` afin de ne pas flasher.

La création, la synchronisation et la destruction sont sérialisées. Avant de
construire une child webview, le worker vérifie de nouveau que le panel possède
toujours son label : une destruction arrivée pendant la file d'attente ne peut
donc pas recréer la vue après coup. Une erreur de `hide`, bounds ou `show`
retire immédiatement la vue de son panel et marque celui-ci en échec. Si la
fermeture native échoue, le contrôleur libère le slot de chargement mais garde
le handle après une tentative de masquage pour retenter la fermeture lors d'un
callback ou du prochain `destroy_all`, au lieu de perdre le seul handle vers
une vue potentiellement vivante. Ce handle continue à compter dans la limite de
six vues : tant qu'il n'est pas fermé, aucun remplacement ne peut créer une
septième child webview.

Chaque chargement `Loading` porte une deadline monotone de 30 secondes. Un
timer one-shot annulable est armé uniquement pour ce chargement : il n'existe
aucun tick ni polling global. Si Wry ne produit jamais de `PageLoad::Finished`,
la deadline retire le label actif, marque le panel `Failed`, ferme au mieux sa
vue éventuelle et donne immédiatement les slots aux panels suivants.

Sur Windows, le callback `Finished` générique de Wry est volontairement ignoré
car Wry 0.55.1 ne transmet pas `NavigationCompleted.IsSuccess`. Un adaptateur
WebView2 natif conserve ce bit : seule une complétion réussie, précédée du
`Started` attendu, portant l'URL attendue et le même `NavigationId` natif, peut
publier `Ready`. Une complétion retardée d'une navigation annulée est ignorée,
même si une navigation de remplacement a déjà démarré. Une erreur DNS, TLS,
proxy ou réseau corrélée publie `Failed` et conserve le chemin de retry. Sur
macOS, `WKNavigationDelegate.didFinishNavigation` constitue déjà le signal de
succès tandis qu'un échec ne produit pas ce callback et expire fail-closed.

Les données de publications ne partagent pas le store du renderer local :

- macOS 14+ utilise un `data_store_identifier` WKWebView fixe, partagé entre
  les six vues de publications ;
- Windows utilise un répertoire WebView2 dédié sous les données de
  l'application.

L'effacement du profil utilise exactement une vue de publication vivante,
possédée par le contrôleur et encore rattachée à un panel ; les six vues
partagent ce profil. Si aucune telle vue n'existe, l'API publique commune ne
permet pas de cibler ce profil sur les deux plateformes : la commande échoue
alors explicitement avec une erreur native. Elle ne retourne jamais un succès
vide et n'utilise pas un handle orphelin après un échec de fermeture.

## Limites des API publiques épinglées

Avec Tauri `2.11.5` et Wry `0.55.1`, le builder public d'une child webview
n'expose ni handler générique de permission, ni handler de challenge
d'authentification HTTP. Wry accorde en outre la capture média dans son delegate
WKWebView interne. Le contrôleur ne prétend donc pas bloquer ces deux surfaces.

L'API publique n'expose pas non plus l'arrêt ou l'effacement sélectif des
service workers du store de publications lors de la destruction d'une vue.
Cookies, stockage local, cache et service workers persistent dans le store
séparé. Un cutover depuis Electron reste bloqué tant que ces écarts ne sont pas
acceptés ou fermés au niveau natif.

La détection et la récupération d'un crash du processus de contenu ne sont pas
non plus établies par cette couche. Elles restent un gate du spike natif, au
même titre que permissions, authentification HTTP et service workers.

## Gates physiques restantes

Les tests Rust prouvent la politique pure, l'ordre `focused-first`, la limite de
concurrence et les transitions de visibilité. Le modèle exécute notamment 100
cycles de création/destruction de six panels et 500 cycles `hide`/`show` des
six panels, puis vérifie qu'aucune file, aucun slot et aucun label ne subsiste.
Ils vérifient aussi que les labels natifs sont générés indépendamment des IDs et
URLs et ne peuvent pas devenir le label de capability `main`, que deux
chargements expirés libèrent les quatre suivants et qu'un effacement sans vue
ne peut pas réussir silencieusement. La compilation croisée prouve la
disponibilité des symboles macOS/Windows. Ces preuves ne prouvent pas :

- l'absence absolue d'un flash natif à la création ;
- le comportement réel des prompts permission/auth ;
- l'isolation effective des cookies et service workers dans les runtimes
  WKWebView/WebView2 installés ;
- la détection/récupération d'un crash du processus de contenu ;
- focus, z-order, redimensionnement, `hide`/`show` et destruction native sous
  charge sur des machines physiques macOS 14 et Windows 11.

Ces points demandent une recette instrumentée sur les deux plateformes et ne
doivent pas être déclarés verts à partir d'un build local non signé.

## Surface IPC locale

Toutes les commandes vérifient que le webview **et** sa fenêtre portent le
label exact `main`. Les arguments Tauri utilisent le camelCase :

- `sync_web_panels({ descriptors, focusedPanelId })` ;
- `set_web_panel_visibility({ panelId, visible })` ;
- `set_web_panel_bounds({ panelId, bounds })` ;
- `focus_web_panel({ panelId })` ;
- `clear_web_panel_data()` ;
- `set_web_panel_overlay_active({ active })` ;
- `destroy_web_panel({ panelId })` et `clear_web_panels()` ;
- `get_web_panel_states()` ;
- `get_web_panel_security_coverage()`.

Un état renderer contient uniquement `panelId`, l'ordre monotone
`generation`/`sequence`, `bounds`, `phase`, `requestedVisible` et `visible`.
La génération change à chaque remplacement de vue et la séquence à chaque
transition de cette vue ; une livraison asynchrone retardée ne peut donc jamais
faire régresser le renderer. Ni l'URL chargée, ni un handle Tauri/Wry ne
franchissent la frontière IPC. La couverture de sécurité expose explicitement
les garanties absentes avec la valeur `false` ; elle ne les transforme pas en
capacités.
