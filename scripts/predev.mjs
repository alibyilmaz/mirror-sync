// Pre-dev step: regenerate the Prisma client, but tolerate the Windows
// EPERM case where the running worker holds query_engine-windows.dll.node
// open. If a client already exists, reusing it is safe (schema changes
// still regenerate cleanly whenever the worker isn't running).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const result = spawnSync("npm", ["exec", "prisma", "generate"], {
  stdio: "inherit",
  shell: true,
});

if (result.status !== 0) {
  if (existsSync("node_modules/.prisma/client/index.js")) {
    console.warn(
      "[predev] prisma generate failed (engine DLL likely locked by the running worker); " +
        "reusing the existing client. If you changed prisma/schema.prisma, stop the worker and rerun.",
    );
    process.exit(0);
  }
  process.exit(result.status ?? 1);
}
