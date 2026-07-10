import type { VibeDeckApi } from "./types";

declare global {
  interface Window {
    vibedeck: VibeDeckApi;
  }
}

export {};
