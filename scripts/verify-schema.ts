/**
 * Read-only check that the database behind DATABASE_URL matches drizzle/schema.ts.
 * Usage:  DATABASE_URL=postgres://... pnpm verify:schema
 * Reports every table/column the app expects that is missing or different. Writes nothing.
 */
import "dotenv/config";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "../drizzle/schema";

type DbColumn = { table_name: string; column_name: string; data_type: string; udt_name: string; is_nullable: "YES" | "NO" };

const normalize = (column: DbColumn) => (column.data_type === "USER-DEFINED" ? column.udt_name : column.data_type);
const expectedType = (sqlType: string) => sqlType
  .replace(/^varchar\(\d+\)$/, "character varying")
  .replace(/^timestamp with time zone$/, "timestamp with time zone")
  .replace(/^integer$/, "integer")
  .replace(/^bigint$/, "bigint");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { prepare: false, max: 1 });
  const rows = await sql<DbColumn[]>`select table_name, column_name, data_type, udt_name, is_nullable from information_schema.columns where table_schema = 'public'`;
  const byTable = new Map<string, Map<string, DbColumn>>();
  for (const row of rows) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Map());
    byTable.get(row.table_name)!.set(row.column_name, row);
  }
  const problems: string[] = [];
  let checked = 0;
  for (const value of Object.values(schema)) {
    if (!value || typeof value !== "object" || !(Symbol.for("drizzle:IsDrizzleTable") in value)) continue;
    const config = getTableConfig(value as PgTable);
    const live = byTable.get(config.name);
    if (!live) { problems.push(`missing table public.${config.name}`); continue; }
    for (const column of config.columns) {
      checked += 1;
      const actual = live.get(column.name);
      if (!actual) { problems.push(`missing column ${config.name}.${column.name}`); continue; }
      const want = expectedType(column.getSQLType());
      const have = normalize(actual);
      if (want !== have) problems.push(`type mismatch ${config.name}.${column.name}: app expects ${want}, database has ${have}`);
      if (column.notNull && actual.is_nullable === "YES") problems.push(`nullability ${config.name}.${column.name}: app expects NOT NULL, database allows NULL`);
    }
  }
  await sql.end();
  if (problems.length) {
    console.error(`Schema check FAILED (${problems.length} problem(s), ${checked} columns checked):\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`Schema check passed: ${checked} columns across ${Object.values(schema).filter(v => v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v).length} tables match the database.`);
}

main().catch(error => { console.error("Schema check error:", error instanceof Error ? error.message : error); process.exit(1); });
