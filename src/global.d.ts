import type { MediaGenApi } from "./types";

declare global {
  interface Window {
    mediagen: MediaGenApi;
  }
}

export {};
