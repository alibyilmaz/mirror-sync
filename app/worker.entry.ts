// Standalone entry for the queue consumer. Bundled by esbuild into
// build/worker.mjs and imported by server.mjs so web + worker share one
// Node process. Can also run alone in dev: npm run dev:worker
import { startWorker } from "./lib/worker.server";

if (process.env.RUN_WORKER !== "false") {
  startWorker();
}
