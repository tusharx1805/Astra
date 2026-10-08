/**
 * Phase 10 — the ONLY code that calls an LLM API. Server-side only: the API key is
 * read from the server environment and never reaches the browser.
 *
 * Configuration (all server env):
 *   AI_PROVIDER      anthropic | openai        (unset → AI features are disabled, clearly)
 *   AI_API_KEY       provider API key
 *   AI_MODEL         model id, e.g. an Anthropic Claude model id or an OpenAI model id
 *   AI_BASE_URL      optional; default https://api.anthropic.com or https://api.openai.com/v1
 *                    (any OpenAI-compatible endpoint works with AI_PROVIDER=openai)
 *   AI_TIMEOUT_MS    optional; default 30000 (whole call including one retry)
 */

export const AI_PROVIDERS = ["anthropic", "openai"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export type AiConfig = { enabled: true; provider: AiProviderName; model: string; baseUrl: string; apiKey: string; timeoutMs: number } | { enabled: false; reason: string };

export function getAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const provider = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (!provider) return { enabled: false, reason: "AI is not configured on this server (AI_PROVIDER is not set)." };
  if (!(AI_PROVIDERS as readonly string[]).includes(provider)) return { enabled: false, reason: `AI_PROVIDER "${provider}" is not supported. Use "anthropic" or "openai".` };
  const apiKey = (env.AI_API_KEY ?? "").trim();
  if (!apiKey) return { enabled: false, reason: "AI_API_KEY is not set on this server." };
  const model = (env.AI_MODEL ?? "").trim();
  if (!model) return { enabled: false, reason: "AI_MODEL is not set on this server." };
  const defaultBase = provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
  const baseUrl = (env.AI_BASE_URL ?? "").trim().replace(/\/+$/, "") || defaultBase;
  const timeoutMs = Math.min(120_000, Math.max(3_000, Number(env.AI_TIMEOUT_MS) || 30_000));
  return { enabled: true, provider: provider as AiProviderName, model, baseUrl, apiKey, timeoutMs };
}

/** Public, secret-free description for the UI. */
export function describeAiConfig(config: AiConfig) {
  return config.enabled ? { enabled: true as const, provider: config.provider, model: config.model, timeoutMs: config.timeoutMs } : { enabled: false as const, reason: config.reason };
}

export type AiFailureKind = "disabled" | "auth" | "model" | "rate_limited" | "unavailable" | "timeout" | "network" | "bad_request" | "invalid_output" | "refused";
export class AiCallError extends Error {
  constructor(public kind: AiFailureKind, message: string, public status: number | null = null) {
    super(message);
    this.name = "AiCallError";
  }
}

export type AiCallResult = { text: string; model: string; inputTokens: number | null; outputTokens: number | null; latencyMs: number; stopReason: string | null };

function failureFor(status: number, provider: AiProviderName): AiCallError {
  if (status === 401 || status === 403) return new AiCallError("auth", `The ${provider} API rejected the API key (HTTP ${status}).`, status);
  if (status === 404) return new AiCallError("model", `The ${provider} API does not know this model or endpoint (HTTP 404). Check AI_MODEL / AI_BASE_URL.`, status);
  if (status === 429) return new AiCallError("rate_limited", `The ${provider} API is rate-limiting or out of credit (HTTP 429). Try again later.`, status);
  if (status >= 500) return new AiCallError("unavailable", `The ${provider} API is unavailable (HTTP ${status}).`, status);
  return new AiCallError("bad_request", `The ${provider} API rejected the request (HTTP ${status}).`, status);
}

const retryable = (error: AiCallError) => error.kind === "unavailable" || error.kind === "rate_limited" || error.kind === "network";

async function once(config: Extract<AiConfig, { enabled: true }>, system: string, user: string, maxTokens: number, signal: AbortSignal): Promise<Omit<AiCallResult, "latencyMs">> {
  const request: { url: string; headers: Record<string, string>; body: unknown } = config.provider === "anthropic"
    ? {
      url: `${config.baseUrl}/v1/messages`,
      headers: { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
      body: { model: config.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] },
    }
    : {
      url: `${config.baseUrl}/chat/completions`,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: { model: config.model, max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }], response_format: { type: "json_object" } },
    };
  let response: Response;
  try {
    response = await fetch(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal });
  } catch (error) {
    if (signal.aborted) throw new AiCallError("timeout", `The ${config.provider} API did not answer within ${Math.round(config.timeoutMs / 1000)} seconds.`);
    throw new AiCallError("network", `The ${config.provider} API could not be reached from the Astra server.`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw failureFor(response.status, config.provider);
  }
  let json: any;
  try { json = await response.json(); } catch { throw new AiCallError("invalid_output", "The AI API returned a response that is not JSON."); }
  if (config.provider === "anthropic") {
    const text = Array.isArray(json?.content) ? json.content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("") : "";
    if (json?.stop_reason === "refusal") throw new AiCallError("refused", "The model declined to answer.");
    if (!text.trim()) throw new AiCallError("invalid_output", "The model returned no text.");
    return { text, model: String(json.model ?? config.model), inputTokens: Number(json.usage?.input_tokens ?? NaN) || null, outputTokens: Number(json.usage?.output_tokens ?? NaN) || null, stopReason: json.stop_reason ?? null };
  }
  const choice = json?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  if (choice?.message?.refusal) throw new AiCallError("refused", "The model declined to answer.");
  if (!text.trim()) throw new AiCallError("invalid_output", "The model returned no text.");
  return { text, model: String(json.model ?? config.model), inputTokens: Number(json.usage?.prompt_tokens ?? NaN) || null, outputTokens: Number(json.usage?.completion_tokens ?? NaN) || null, stopReason: choice?.finish_reason ?? null };
}

/** One model call with a hard overall timeout and at most one retry for transient failures. */
export async function callModel(input: { system: string; user: string; maxTokens: number }, config: AiConfig = getAiConfig()): Promise<AiCallResult> {
  if (!config.enabled) throw new AiCallError("disabled", config.reason);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await once(config, input.system, input.user, input.maxTokens, controller.signal);
        return { ...result, latencyMs: Date.now() - started };
      } catch (error) {
        const failure = error instanceof AiCallError ? error : new AiCallError("network", "The AI call failed.");
        const remaining = config.timeoutMs - (Date.now() - started);
        if (attempt >= 1 || !retryable(failure) || remaining < 2_000) throw failure;
        await new Promise(resolve => setTimeout(resolve, Math.min(1_000, remaining / 4)));
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
