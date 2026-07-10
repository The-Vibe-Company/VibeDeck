import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [
    react(),
    ...(command === "serve"
      ? [
          {
            name: "mediagen-local-dev-csp",
            transformIndexHtml(html: string) {
              return html.replace(
                "connect-src 'self'",
                "connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173",
              );
            },
          },
        ]
      : []),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
}));
