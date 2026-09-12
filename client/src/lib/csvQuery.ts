export type CsvQueryResult = { rows: Array<Record<string, string>>; durationMs: number };

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(value => value.trim());
  return lines.slice(1).map(line => {
    const values = line.split(",").map(value => value.trim());
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

/**
 * Executes a deliberately small SELECT subset against user-provided CSV preview text.
 * It never sends SQL to a server, executes JavaScript, or connects to a warehouse.
 */
export function executeCsvPreview(sqlText: string, csvText: string): CsvQueryResult {
  const startedAt = performance.now();
  const sql = sqlText.trim().replace(/;$/, "");
  if (!/^select\s+/i.test(sql) || /\b(insert|update|delete|drop|alter|create|truncate)\b/i.test(sql)) {
    throw new Error("Only read-only SELECT queries are supported in the CSV preview.");
  }
  const rows = parseCsv(csvText);
  const countQuery = /^select\s+count\(\*\)\s+from\s+preview$/i.test(sql);
  const limitMatch = sql.match(/\s+limit\s+(\d+)$/i);
  const whereMatch = sql.match(/\s+where\s+([a-zA-Z0-9_]+)\s*=\s*['"]([^'"]*)['"]/i);
  let output = whereMatch ? rows.filter(row => row[whereMatch[1]] === whereMatch[2]) : rows;
  if (limitMatch) output = output.slice(0, Math.min(Number(limitMatch[1]), 1000));
  if (countQuery) output = [{ count: String(output.length) }];
  if (!countQuery && !/^select\s+\*\s+from\s+preview(?:\s+where[\s\S]+)?(?:\s+limit\s+\d+)?$/i.test(sql)) {
    throw new Error("Preview runner supports SELECT * FROM preview and SELECT COUNT(*) FROM preview.");
  }
  return { rows: output, durationMs: Math.max(1, Math.round(performance.now() - startedAt)) };
}
