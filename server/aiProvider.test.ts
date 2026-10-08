import { describe, expect, it } from "vitest";
import { callModel, describeAiConfig, getAiConfig } from "./aiProvider";

describe("Phase 10 AI configuration", () => {
  it("is disabled with a precise reason until provider, key and model are all set", () => {
    expect(getAiConfig({})).toMatchObject({ enabled: false, reason: expect.stringMatching(/AI_PROVIDER/) });
    expect(getAiConfig({ AI_PROVIDER: "gemini" })).toMatchObject({ enabled: false, reason: expect.stringMatching(/not supported/) });
    expect(getAiConfig({ AI_PROVIDER: "anthropic" })).toMatchObject({ enabled: false, reason: expect.stringMatching(/AI_API_KEY/) });
    expect(getAiConfig({ AI_PROVIDER: "anthropic", AI_API_KEY: "k" })).toMatchObject({ enabled: false, reason: expect.stringMatching(/AI_MODEL/) });
    expect(getAiConfig({ AI_PROVIDER: "OpenAI", AI_API_KEY: "k", AI_MODEL: "m", AI_TIMEOUT_MS: "999999" })).toMatchObject({ enabled: true, provider: "openai", baseUrl: "https://api.openai.com/v1", timeoutMs: 120000 });
  });

  it("never exposes the API key in what the UI receives", () => {
    const view = describeAiConfig(getAiConfig({ AI_PROVIDER: "anthropic", AI_API_KEY: "sk-secret", AI_MODEL: "m" }));
    expect(JSON.stringify(view)).not.toContain("sk-secret");
  });

  it("refuses to call when disabled", async () => {
    await expect(callModel({ system: "s", user: "u", maxTokens: 10 }, getAiConfig({}))).rejects.toMatchObject({ kind: "disabled" });
  });
});
