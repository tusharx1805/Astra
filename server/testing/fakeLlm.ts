// TEST-ONLY fake LLM for Phase 10 (never imported by the app). Speaks the Anthropic Messages API and the OpenAI
// chat-completions API. Behaviour is chosen by the model name. It writes its brief FROM the
// context it receives, so grounding/validation run end to end.
import http from "node:http";
export type FakeLlm = { port: number; requests: Array<{ url: string; key: string; body: any }>; counts: Record<string, number>; close: () => Promise<void> };

export function startFakeLlm(port = 0): Promise<FakeLlm> {
  const requests: FakeLlm["requests"] = [];
  const counts: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", async () => {
      const json: any = JSON.parse(body || "{}");
      const anthropic = req.url === "/v1/messages";
      const key: string = anthropic ? String(req.headers["x-api-key"] ?? "") : String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      requests.push({ url: String(req.url), key, body: json });
      const model = String(json.model ?? "");
      counts[model] = (counts[model] ?? 0) + 1;
      const send = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
      if (key !== "test-ai-key") return send(401, { error: "bad key" });
      if (model === "fake-500") return send(500, { error: "down" });
      if (model === "fake-429") return send(429, { error: "slow down" });
      if (model === "fake-404") return send(404, { error: "no such model" });
      if (model === "fake-slow") await new Promise(r => setTimeout(r, 6000));
      const user = anthropic ? json.messages[0].content : json.messages[1].content;
      const ctx = JSON.parse((user as string).slice(user.indexOf("{"), user.lastIndexOf("}") + 1));
      const factors = (ctx.analysis.factors as any[]).filter(f => f.weight > 0).sort((a, b) => b.weight - a.weight);
      const level = ctx.analysis.level;
      const brief: any = {
        headline: `${level} ${ctx.analysis.score}/100 — ${ctx.analysis.summary}`.slice(0, 160),
        whatChanges: (ctx.proposed?.steps.length ? ctx.proposed.steps : ["No steps"]).slice(0, 4).map((s: string) => `Proposed: ${s}`),
        riskPoints: factors.slice(0, 3).map(f => ({ factor: f.code, point: `${f.label}. ${f.evidence}` })),
        checkBeforeApproving: [factors[0] ? `Confirm the owners of affected entities accept: ${factors[0].label}.` : "Confirm the output still meets consumer expectations."],
        suggestion: level === "CRITICAL" ? "block" : level === "HIGH" ? "request_changes" : level === "MEDIUM" ? "needs_human_judgment" : "approve",
        suggestionReason: `Deterministic engine rated this ${level}.`,
      };
      if (model === "fake-hallucinate") { brief.riskPoints.push({ factor: "made_up_factor", point: "Invented risk that the engine never found." }); brief.suggestion = "approve"; }
      let text = "```json\n" + JSON.stringify(brief) + "\n```";
      if (model === "fake-garbage") text = "Sure! This change looks mostly fine to me, go ahead.";
      if (model === "fake-badshape") text = JSON.stringify({ headline: "x", suggestion: "yolo" });
      if (anthropic) return send(200, { id: "msg_fake", type: "message", model, role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: Math.round(user.length / 4), output_tokens: Math.round(text.length / 4) } });
      return send(200, { id: "chatcmpl_fake", model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: Math.round(user.length / 4), completion_tokens: Math.round(text.length / 4) } });
    });
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, requests, counts, close: () => new Promise<void>(r => server.close(() => r())) })));
}
