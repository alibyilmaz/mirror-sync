// Standalone entry for the queue consumer (npm run dev:worker). In
// production the worker is started by server.mjs instead; this file is only
// the dev process, so it owns its own shutdown.
import { startWorker, stopWorker } from "./lib/worker.server";

if (process.env.RUN_WORKER !== "false") {
  startWorker();
}

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} received, draining current batch`);
  await stopWorker();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
