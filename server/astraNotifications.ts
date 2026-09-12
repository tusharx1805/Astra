import type { SimulatedRiskAnalysis } from "./mockRiskEngine";
import type { ReviewRecord } from "./reviewStore";

export type OwnerNotifier = (payload: { title: string; content: string }) => Promise<boolean>;

export function notifyAnalysisComplete(
  notify: OwnerNotifier,
  title: string,
  analysis: SimulatedRiskAnalysis,
) {
  return notify({
    title: `ASTRA simulated risk analysis: ${analysis.level} ${analysis.score}/100`,
    content: `${title} has completed deterministic simulated analysis. ${analysis.affectedEntities.length} named dependencies were identified. This is a simulation; submitted source was not executed.`,
  });
}

export function notifyReviewChanged(
  notify: OwnerNotifier,
  record: ReviewRecord,
) {
  return notify({
    title: `ASTRA review decision: ${record.decision.replaceAll("_", " ")}`,
    content: `${record.reviewerName} recorded ${record.decision.replaceAll("_", " ")} for ${record.changeId} (${record.riskLevel}). This is an operational notification for the project owner.`,
  });
}
