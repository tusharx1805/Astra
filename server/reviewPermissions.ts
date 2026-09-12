export type AstraRole = "admin" | "developer" | "reviewer";

export function mayRecordReview(role: AstraRole): boolean {
  return role === "admin" || role === "reviewer";
}
