import { defineConfig } from "drizzle-kit";

/**
 * The Supabase schema is owned by the SQL files in supabase/migrations/ (run them in the
 * Supabase SQL editor or with `supabase db push`). drizzle-kit is configured for
 * inspection only (e.g. `npx drizzle-kit pull` into ./drizzle/introspect) — do not use
 * `drizzle-kit push`/`migrate` against Supabase, it would try to own tables it did not create.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle/introspect",
  dialect: "postgresql",
  schemaFilter: ["public"],
  dbCredentials: { url: connectionString },
});
