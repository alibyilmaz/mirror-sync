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
await import("./build/worker.mjs");

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`MirrorSync listening on :${port}`);
});
