import express, { type Express } from "express";
import fs from "fs";
import path from "path";

/** Production static serving. Deliberately does NOT import vite (a devDependency). */
export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(`Could not find the build directory: ${distPath}, make sure to build the client first`);
  }
  // Hashed assets can be cached for a year; index.html must always be revalidated.
  app.use("/assets", express.static(path.join(distPath, "assets"), { immutable: true, maxAge: "365d", fallthrough: false }));
  app.use(express.static(distPath, { index: false, maxAge: 0 }));
  // Unknown API paths are a 404, not the SPA.
  app.use("/api", (_req, res) => { res.status(404).json({ error: "Not found" }); });
  app.use("*", (_req, res) => {
    res.set("Cache-Control", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
