export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  // Supabase Auth: the only authentication configuration. Both values are public (anon key, never service_role).
  supabaseUrl: process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "",
};
