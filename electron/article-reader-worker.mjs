import { parentPort } from "node:worker_threads";

import { extractArticleHtml } from "./article-reader.mjs";

if (!parentPort) throw new Error("Worker du lecteur indisponible.");

parentPort.once("message", (input) => {
  parentPort.postMessage(extractArticleHtml(input));
});
