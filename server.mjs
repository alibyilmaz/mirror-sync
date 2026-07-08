// Production server: serves the React Router app AND runs the pgmq
// consumer in the same always-on Node process (Fly.io/Railway).
import { createRequestHandler } from "@react-router/express";
import express from "express";

const app = express();
app.disable("x-powered-by");

app.use(
  "/assets",
  express.static("build/client/assets", { immutable: true, maxAge: "1y" }),
);
app.use(express.static("build/client", { maxAge: "1h" }));

app.all(
  "*splat",
  createRequestHandler({
    build: await import("./build/server/index.js"),
  }),
);

// Queue consumer — same process, no extra service.
const { startWorker, stopWorker } = await import("./build/worker.mjs");
if (process.env.RUN_WORKER !== "false") {
  startWorker();
}

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`MirrorSync listening on :${port}`);
});

// Graceful shutdown: platforms (Fly.io/Railway) send SIGTERM on every
// deploy. Stop taking new HTTP, let the worker finish its in-flight batch
// (bounded so we still exit before SIGKILL), then close. Anything not
// finished is safe to reprocess — the sync engine is idempotent.
const SHUTDOWN_DRAIN_MS = 25_000;
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, draining`);
  server.close();
  const drain = stopWorker();
  const timeout = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS));
  await Promise.race([drain, timeout]);
  console.log("[server] shutdown complete");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
