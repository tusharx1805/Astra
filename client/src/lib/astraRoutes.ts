export type AstraRouteKind = "home" | "dataset" | "pipeline" | "changes" | "risk" | "monitoring" | "reports" | "other";

export function getAstraRouteKind(pathname: string): AstraRouteKind {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/datasets")) return "dataset";
  if (pathname.startsWith("/pipelines")) return "pipeline";
  if (pathname.startsWith("/changes")) return "changes";
  if (pathname.startsWith("/risk-analysis")) return "risk";
  if (pathname.startsWith("/monitoring")) return "monitoring";
  if (pathname.startsWith("/reports")) return "reports";
  return "other";
}
