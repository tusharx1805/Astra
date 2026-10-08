import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer } from "http";
import net from "net";
import { sql } from "drizzle-orm";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { supabaseConfigProblem } from "./supabaseAuth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic } from "./static";
import { closeDb, getDb } from "../db";
import { checkEnvironment } from "./envCheck";

const isProduction = process.env.NODE_ENV === "production";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

/**
 * Baseline security headers (no extra dependency).
 * CSP sources: Supabase (auth API), Google Fonts, jsDelivr (Monaco editor on the SQL sandbox page),
 * and the optional analytics endpoint.
 */
function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  const origin = (value: string | undefined) => { try { return value ? new URL(value).origin : ""; } catch { return ""; } };
  const supabase = origin(process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL);
  const analytics = origin(process.env.VITE_ANALYTICS_ENDPOINT);
  const cdn = "https://cdn.jsdelivr.net";
  const list = (...items: string[]) => items.filter(Boolean).join(" ");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("Content-Security-Policy", [
      "default-src 'self'",
      `script-src ${list("'self'", cdn, analytics)}`,
      `style-src ${list("'self'", "'unsafe-inline'", "https://fonts.googleapis.com", cdn)}`,
      `font-src ${list("'self'", "data:", "https://fonts.gstatic.com", cdn)}`,
      `img-src ${list("'self'", "data:", "blob:", supabase)}`,
      `connect-src ${list("'self'", supabase, supabase.replace(/^http/, "ws"), analytics, cdn)}`,
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "));
  }
  next();
}

async function startServer() {
  const env = checkEnvironment();
  env.warnings.forEach(message => console.warn(`[Config] ${message}`));
  if (env.errors.length) {
    env.errors.forEach(message => console.error(`[Config] ${message}`));
    if (isProduction) throw new Error("Refusing to start: required configuration is missing (see [Config] errors above).");
  }

  const app = express();
  app.disable("x-powered-by");
  // Behind a load balancer / reverse proxy (Render, Railway, Fly, Nginx…): trust the first hop for req.protocol / req.ip.
  app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 1));
  const server = createServer(app);
  app.use(securityHeaders);

  // Liveness + readiness: 200 only when the database answers.
  app.get("/healthz", async (_req, res) => {
    try {
      const db = await getDb();
      if (!db) throw new Error("DATABASE_URL not configured");
      await db.execute(sql`select 1`);
      res.status(200).json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable", database: "unreachable" });
    }
  });

  // Only the API parses bodies. 16 MB covers the 5M-character CSV import (UTF-8 + JSON escaping).
  app.use("/api/trpc", express.json({ limit: "16mb" }));
  // Legacy Manus storage proxy: unauthenticated presign service, so it is opt-in only.
  if (process.env.ASTRA_ENABLE_MANUS_STORAGE === "true") registerStorageProxy(app);
  // Authentication is Supabase Auth only (no application users table, no Manus OAuth).
  const authProblem = supabaseConfigProblem();
  if (authProblem) console.error(`[Auth] ${authProblem}: every protected API call will fail until it is configured.`);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      onError: ({ error, path }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") console.error(`[API] ${path ?? "?"}:`, error.cause ?? error.message);
      },
    })
  );
  // development mode uses Vite (loaded lazily: vite is a devDependency), production serves the built files
  if (process.env.NODE_ENV === "development") {
    // Non-literal specifier: esbuild leaves it out of the production bundle (vite is a devDependency).
    const devModule = "./vite";
    const { setupVite } = (await import(devModule)) as typeof import("./vite");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  // Body-parser errors (e.g. payload too large) → clean JSON, never a stack trace.
  app.use((error: { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    const status = error?.status && error.status >= 400 && error.status < 600 ? error.status : 500;
    res.status(status).json({ error: status === 413 ? "Request is too large." : status < 500 ? "Bad request." : "Internal error." });
  });

  const preferredPort = parseInt(process.env.PORT || "3000");
  // In production the platform assigns PORT; silently moving to another port would make the service unreachable.
  const port = isProduction ? preferredPort : await findAvailablePort(preferredPort);
  if (port !== preferredPort) console.log(`Port ${preferredPort} is busy, using port ${port} instead`);

  server.keepAliveTimeout = 65_000; // longer than typical load-balancer idle timeouts
  server.headersTimeout = 66_000;
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Server] ${signal} received: finishing in-flight requests, then exiting.`);
    const force = setTimeout(() => { console.error("[Server] Forced exit after 25 s."); process.exit(1); }, 25_000);
    force.unref();
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    server.closeIdleConnections?.();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", reason => console.error("[Server] Unhandled promise rejection:", reason));

startServer().catch(error => {
  console.error("[Server] Failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
