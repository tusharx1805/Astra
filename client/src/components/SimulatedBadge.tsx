import { Sparkles } from "lucide-react";

export function SimulatedBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`simulated-badge ${compact ? "simulated-badge--compact" : ""}`}>
      <Sparkles size={compact ? 11 : 13} strokeWidth={2.5} />
      {compact ? "SIMULATED" : "SIMULATED DATA · NOT A LIVE MODEL"}
    </span>
  );
}
