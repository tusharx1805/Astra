export type RiskLevel = "SAFE" | "MEDIUM" | "HIGH" | "CRITICAL";

export type RiskInput = {
  title: string;
  source: string;
  changeType: "SQL" | "PYTHON" | "YAML" | "SCHEMA" | "CONFIG" | "GITHUB_PR";
};

export type SimulatedRiskAnalysis = {
  id: string;
  score: number;
  level: RiskLevel;
  predictionProbability: number;
  summary: string;
  simulated: true;
  factors: Array<{ label: string; weight: number; tone: "critical" | "warning" | "neutral" }>;
  affectedEntities: Array<{ type: "dataset" | "pipeline" | "dashboard" | "model"; name: string; owner: string; severity: RiskLevel }>;
  explanation: string[];
  analysisStages: Array<{ label: string; status: "complete" }>;
};

const stableId = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return `RA-${Math.abs(hash).toString(36).toUpperCase().padStart(5, "0")}`;
};

const levelFor = (score: number): RiskLevel => {
  if (score >= 80) return "CRITICAL";
  if (score >= 60) return "HIGH";
  if (score >= 35) return "MEDIUM";
  return "SAFE";
};

/**
 * Deterministic demo implementation for the future prediction-service contract.
 * Submitted source is pattern-matched only and is never executed.
 */
export function mockRiskEngine(input: RiskInput): SimulatedRiskAnalysis {
  const source = input.source.toLowerCase();
  const isSchemaChange = /alter\s+table|alter\s+column|create\s+table|drop\s+column/.test(source);
  const isTypeChange = /alter\s+column[\s\S]*?type\s+(varchar|char|int|bigint|numeric|text)/.test(source);
  const touchesIdentity = /customer_id|order_id|transaction_id|primary\s+key/.test(source);
  const hasDrop = /drop\s+(table|column)|truncate\s+table/.test(source);
  const touchesCustomers = /customers|customer_/.test(source);
  const isConfig = input.changeType === "YAML" || input.changeType === "CONFIG";

  let score = 11;
  if (isSchemaChange) score += 9;
  if (isTypeChange) score += 28;
  if (touchesIdentity) score += 18;
  if (touchesCustomers) score += 9;
  if (isTypeChange && touchesCustomers) score += 12;
  if (hasDrop) score += 25;
  if (isConfig) score += 12;
  score = Math.min(99, score);

  const level = levelFor(score);
  const factors: SimulatedRiskAnalysis["factors"] = [];
  if (isTypeChange) factors.push({ label: "Breaking datatype compatibility", weight: 32, tone: "critical" });
  if (touchesIdentity) factors.push({ label: "Identity-column contract exposure", weight: 21, tone: "critical" });
  if (touchesCustomers) factors.push({ label: "Downstream customer lineage", weight: 15, tone: "warning" });
  if (isSchemaChange) factors.push({ label: "Schema migration surface", weight: 10, tone: "warning" });
  if (hasDrop) factors.push({ label: "Destructive operation detected", weight: 28, tone: "critical" });
  if (!factors.length) factors.push({ label: "Low-impact source change", weight: 8, tone: "neutral" });

  const affectedEntities: SimulatedRiskAnalysis["affectedEntities"] = touchesCustomers || isSchemaChange
    ? [
        { type: "dataset", name: "customers", owner: "Maya Chen", severity: "CRITICAL" },
        { type: "pipeline", name: "customer_etl", owner: "Data Platform", severity: "HIGH" },
        { type: "dashboard", name: "Customer 360", owner: "Revenue Ops", severity: "HIGH" },
        { type: "model", name: "Fraud Model", owner: "Risk Intelligence", severity: "MEDIUM" },
      ]
    : [
        { type: "pipeline", name: "daily_sales", owner: "Sales Intelligence", severity: "MEDIUM" },
      ];

  const explanation = [
    isTypeChange
      ? "The proposed type change can invalidate downstream joins, validators, and warehouse contracts that expect a numeric identifier."
      : "The source has been classified as a non-destructive operational change.",
    touchesCustomers
      ? "Customer-domain lineage reaches four named downstream entities, increasing its coordination and rollback burden."
      : "No broad customer-domain dependency chain was detected by the simulated fixture graph.",
    hasDrop
      ? "A destructive operation raises the predicted recovery cost because historical dependents may not be compatible after deployment."
      : "No destructive statement was detected; source is analyzed only and is not executed.",
  ];

  return {
    id: stableId(`${input.changeType}:${input.source}`),
    score,
    level,
    predictionProbability: Math.min(97, Math.max(12, score + 4)),
    summary: level === "CRITICAL"
      ? "Reviewer attention required before deployment."
      : level === "HIGH"
        ? "Deployment is possible only after mitigation review."
        : "No severe contract break was detected by the simulated engine.",
    simulated: true,
    factors,
    affectedEntities,
    explanation,
    analysisStages: [
      "Change detected",
      "Schema compatibility checked",
      "Lineage analyzed",
      "Blast radius calculated",
      "Historical incident fixtures searched",
      "Risk predicted",
      "Explanation generated",
    ].map(label => ({ label, status: "complete" })),
  };
}
