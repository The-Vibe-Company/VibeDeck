import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import {
  createDevelopmentServerUrl,
  parseDevelopmentPort,
} from "./electron/development-config.mjs";

export default defineConfig(({ command }) => {
  const developmentPort = command === "serve"
    ? parseDevelopmentPort(process.env.VIBEDECK_DEV_SERVER_PORT, { fallback: 5173 })
    : 5173;
  const developmentUrl = createDevelopmentServerUrl(developmentPort);
  const developmentWebSocketUrl = developmentUrl.replace("http://", "ws://");

  return {
    base: "./",
    plugins: [
      react(),
      ...(command === "serve"
        ? [
            {
              name: "vibedeck-local-dev-csp",
              transformIndexHtml(html: string) {
                return html.replace(
                  "connect-src 'self'",
                  `connect-src 'self' ${developmentUrl} ${developmentWebSocketUrl}`,
                );
              },
            },
          ]
        : []),
    ],
    server: {
      host: "127.0.0.1",
      port: developmentPort,
      strictPort: true,
    },
    build: {
      outDir: "dist",
      sourcemap: false,
    },
  };
});
