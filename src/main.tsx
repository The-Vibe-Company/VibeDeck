import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/libre-franklin/index.css";
import "@fontsource/ibm-plex-mono/400.css";
import App from "./App";
import { installTauriVibeDeckApi } from "./tauri-client";
import "./styles.css";

// Electron keeps using the context-isolated preload. Tauri has no preload, so
// install its narrow compatibility facade before React effects can read it.
installTauriVibeDeckApi();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
