import type { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";

// Every authenticated request loads the session row from Postgres — a
// cross-region round-trip that lands on every navigation. Sessions change
// rarely (token refresh ~hourly), so a short in-memory cache in front of
// PrismaSessionStorage removes that read from the hot path. Writes go
// through to the DB and update the cache, so a refreshed token is never
// served stale. Single web instance -> the cache is coherent.
const TTL_MS = 60_000;

export class CachedSessionStorage implements SessionStorage {
  private cache = new Map<string, { session: Session; at: number }>();

  constructor(private inner: SessionStorage) {}

  async storeSession(session: Session): Promise<boolean> {
    const ok = await this.inner.storeSession(session);
    if (ok) this.cache.set(session.id, { session, at: Date.now() });
    return ok;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.session;
    const session = await this.inner.loadSession(id);
    if (session) this.cache.set(id, { session, at: Date.now() });
    else this.cache.delete(id);
    return session;
  }

  async deleteSession(id: string): Promise<boolean> {
    this.cache.delete(id);
    return this.inner.deleteSession(id);
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    for (const id of ids) this.cache.delete(id);
    return this.inner.deleteSessions(ids);
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    // Rare path (uninstall cleanup); no caching needed.
    return this.inner.findSessionsByShop(shop);
  }
}
