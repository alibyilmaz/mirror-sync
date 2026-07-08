// Production worker surface bundled into build/worker.mjs and imported by
// server.mjs, which owns the process lifecycle (start on boot, drain on
// SIGTERM alongside the HTTP server). No auto-start or signal handling here.
export { startWorker, stopWorker } from "./lib/worker.server";
