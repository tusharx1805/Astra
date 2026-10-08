import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../drizzle/schema";

/**
 * Application data connection: Supabase Postgres via DATABASE_URL
 * (Supabase dashboard → Connect). Authentication never uses this connection.
 *
 * `prepare: false` keeps it compatible with Supabase's transaction pooler
 * (port 6543) as well as direct / session connections (port 5432).
 */

/** Supabase requires TLS; local development databases usually do not. Override with DATABASE_SSL=disable|require. */
export function sslFor(url: string): "require" | false {
  const override = process.env.DATABASE_SSL;
  if (override === "disable") return false;
  if (override === "require") return "require";
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" ? false : "require";
  } catch {
    return "require";
  }
}

type Database = ReturnType<typeof drizzle<typeof schema>>;
let _db: Database | null = null;
let _client: ReturnType<typeof postgres> | null = null;

/** Close the pool (graceful shutdown). */
export async function closeDb() {
  const client = _client;
  _client = null;
  _db = null;
  if (client) await client.end({ timeout: 5 }).catch(() => undefined);
}

export async function getDb(): Promise<Database | null> {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const client = postgres(process.env.DATABASE_URL, {
        prepare: false,
        ssl: sslFor(process.env.DATABASE_URL),
        max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
        idle_timeout: 20,
        connect_timeout: 10,
      });
      _client = client;
      _db = drizzle(client, { schema });
    } catch (error) {
      console.warn("[Database] Failed to initialise:", error);
      _db = null;
    }
  }
  return _db;
}
