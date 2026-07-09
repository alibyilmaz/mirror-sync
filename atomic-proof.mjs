import { PrismaClient } from "@prisma/client";
import { generatePairingCode, redeemPairingCode } from "./app/lib/pairing.server.ts";
const prisma = new PrismaClient();

const code = await generatePairingCode("mirror-sync.myshopify.com");
const conn = await redeemPairingCode("mirror-sync-dest.myshopify.com", code);
console.log("paired:", conn.id, "| t=0 — polling every 2s (Railway worker is doing the import)");

const t0 = Date.now();
let last = "";
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const c = await prisma.connection.findUnique({ where: { id: conn.id } });
  const m = await prisma.mapping.count({ where: { connectionId: conn.id } });
  const line = `status=${c.status} mappings=${m}`;
  if (line !== last) {
    console.log(`t+${((Date.now() - t0) / 1000).toFixed(0)}s  ${line}`);
    last = line;
  }
  if (c.status === "active") { console.log(">>> import finished"); break; }
  if (c.status === "paused") { console.log(">>> paused:", c.pausedReason); break; }
}
await prisma.$disconnect();
process.exit(0);
