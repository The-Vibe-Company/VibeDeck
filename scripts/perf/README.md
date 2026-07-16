# Harnais UI 50 × 500

Le harnais crée une base SQLite temporaire et déterministe avec 50 sources et
25 000 articles, lance l'application Electron construite avec un profil
temporaire, mesure le renderer, puis efface tous les fichiers créés.

Après `npm run build` :

```bash
NODE_NO_WARNINGS=1 node scripts/test-perf-ui.mjs
```

Le processus échoue si la virtualisation n'est pas active ou si un budget DOM,
`requestAnimationFrame` ou clavier est dépassé. Les seuils par défaut reprennent
le contrat produit : 55 FPS, moins de 1 % de frames au-delà de 33 ms et vrai
focus DOM en moins de 8 ms au p95. Le rapport JSON complet est
écrit sur stdout. Les compteurs CDP incluent un GC explicite quand Chromium le
permet. Le compteur IPC ne couvre que les événements `ipcRenderer.send`
observables par `webContents`, pas les appels `ipcRenderer.invoke`.

Variables utiles :

- `VIBEDECK_PERF_REPORT=chemin.json` conserve aussi le rapport dans un fichier ;
- `VIBEDECK_PERF_ENFORCE=0` collecte une baseline sans appliquer les budgets ;
- `VIBEDECK_PERF_UI_SHOW=1` affiche et active la fenêtre pendant le diagnostic ;
- `VIBEDECK_PERF_MAX_ROWS`, `VIBEDECK_PERF_MAX_DOM_ELEMENTS`,
  `VIBEDECK_PERF_MAX_RAF_P95_MS`, `VIBEDECK_PERF_MAX_ARROW_FOCUS_P95_MS` et
  `VIBEDECK_PERF_MAX_ARROW_FRAME_P95_MS` remplacent ponctuellement les budgets ;
- `VIBEDECK_PERF_MAX_RAF_OVER_33_PERCENT` ajuste le plafond de frames longues.

Script npm recommandé :

```json
"test:perf-ui": "npm run build && cross-env NODE_NO_WARNINGS=1 node scripts/test-perf-ui.mjs"
```
