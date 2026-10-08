/**
 * Startup configuration check. Errors stop a production server from starting
 * (better than a server that answers every request with "unavailable");
 * warnings describe optional features that will be off.
 */
export function checkEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const has = (key: string) => Boolean((env[key] ?? "").trim());
  if (!has("DATABASE_URL")) errors.push("DATABASE_URL is not set (Supabase → Connect → connection string).");
  if (!has("VITE_SUPABASE_URL") && !has("SUPABASE_URL")) errors.push("VITE_SUPABASE_URL (or SUPABASE_URL) is not set.");
  if (!has("VITE_SUPABASE_ANON_KEY") && !has("SUPABASE_ANON_KEY")) errors.push("VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY) is not set.");
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITE_") && /SERVICE_ROLE|SECRET|PASSWORD|API_KEY/i.test(key) && key !== "VITE_SUPABASE_ANON_KEY" && key !== "VITE_FRONTEND_FORGE_API_KEY") {
      errors.push(`${key} looks like a secret but has the VITE_ prefix, which ships it to every browser. Rename it without VITE_.`);
    }
  }
  if (has("SUPABASE_SERVICE_ROLE_KEY")) warnings.push("SUPABASE_SERVICE_ROLE_KEY is set but Astra does not use it; remove it from this service.");
  const key = env.CONNECTION_ENCRYPTION_KEY ?? "";
  if (!key) warnings.push("CONNECTION_ENCRYPTION_KEY is not set: PostgreSQL connections cannot be saved.");
  else if (key.length < 32) errors.push("CONNECTION_ENCRYPTION_KEY must be at least 32 characters (use: openssl rand -base64 48).");
  if (env.ASTRA_CONNECTOR_ALLOW_PRIVATE_NETWORK === "true" && env.NODE_ENV === "production") warnings.push("ASTRA_CONNECTOR_ALLOW_PRIVATE_NETWORK=true in production: users can reach hosts on this server's private network.");
  if (!has("AI_PROVIDER")) warnings.push("AI_PROVIDER is not set: AI review briefs are off (everything else works).");
  else if (!has("AI_API_KEY") || !has("AI_MODEL")) errors.push("AI_PROVIDER is set but AI_API_KEY or AI_MODEL is missing.");
  return { errors, warnings };
}
