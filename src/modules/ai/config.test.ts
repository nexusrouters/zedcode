import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_STEPS,
  stepBudgetForRound,
  compatModelIdForEndpoint,
  endpointIdFromCompatModel,
  getModelContextLimit,
  isCompatModelId,
  isZedcodeDynamicModelId,
  migrateLegacyCompatEndpoint,
  modelKeepsReasoning,
  modelSupportsTemperature,
  modelUsesReasoningTokens,
  resolveModel,
  setZedcodeDynamicModelIds,
  zedcodeModelsToInfos,
  type CustomEndpoint,
} from "./config";

const endpoint: CustomEndpoint = {
  id: "ab12cd34",
  name: "My LLM",
  baseURL: "https://api.example.com/v1",
  modelId: "llama-3.3-70b",
  contextLimit: 64_000,
};

describe("compat model id helpers", () => {
  it("round-trips endpoint id through the synthetic model id", () => {
    const mid = compatModelIdForEndpoint(endpoint.id);
    expect(isCompatModelId(mid)).toBe(true);
    expect(endpointIdFromCompatModel(mid)).toBe(endpoint.id);
  });

  it("treats static model ids as non-compat", () => {
    expect(isCompatModelId("gpt-5.4-mini")).toBe(false);
    expect(endpointIdFromCompatModel("gpt-5.4-mini")).toBe("");
  });
});

describe("resolveModel", () => {
  it("resolves a compat model id against its endpoint", () => {
    const mid = compatModelIdForEndpoint(endpoint.id);
    const info = resolveModel(mid, [endpoint]);
    expect(info.provider).toBe("openai-compatible");
    expect(info.id).toBe(mid);
    expect(info.label).toBe(endpoint.modelId);
  });

  it("falls back to a placeholder when the endpoint is gone", () => {
    const info = resolveModel(compatModelIdForEndpoint("missing"), []);
    expect(info.provider).toBe("openai-compatible");
  });

  it("resolves the static ZedCode model id from the registry", () => {
    expect(resolveModel("zedcode-auto").provider).toBe("zedcode");
  });

  it("throws on an unknown static model id", () => {
    expect(() => resolveModel("nope-not-real")).toThrow();
  });
});

describe("dynamic ZedCode models", () => {
  it("does not treat the static sentinel as a dynamic model", () => {
    setZedcodeDynamicModelIds(["gpt-4o"]);
    expect(isZedcodeDynamicModelId("zedcode-auto")).toBe(false);
  });

  it("recognises a registered plan model id and resolves it to the zedcode provider", () => {
    setZedcodeDynamicModelIds(["gpt-4o", "claude-sonnet-5"]);
    expect(isZedcodeDynamicModelId("gpt-4o")).toBe(true);
    const info = resolveModel("gpt-4o");
    expect(info.provider).toBe("zedcode");
    expect(info.id).toBe("gpt-4o");
  });

  it("stops recognising an id once it drops out of the plan", () => {
    setZedcodeDynamicModelIds(["gpt-4o"]);
    setZedcodeDynamicModelIds([]);
    expect(isZedcodeDynamicModelId("gpt-4o")).toBe(false);
    expect(() => resolveModel("gpt-4o")).toThrow();
  });

  it("maps the fetched plan list to zedcode ModelInfo entries", () => {
    const infos = zedcodeModelsToInfos([
      { id: "gpt-4o" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    ]);
    expect(infos).toHaveLength(2);
    expect(infos[0]).toMatchObject({ id: "gpt-4o", provider: "zedcode" });
    expect(infos[1].label).toBe("Claude Sonnet 5");
  });
});

describe("getModelContextLimit", () => {
  it("uses the per-endpoint override for compat models", () => {
    const mid = compatModelIdForEndpoint(endpoint.id);
    expect(getModelContextLimit(mid, endpoint.contextLimit)).toBe(64_000);
  });
});

describe("modelKeepsReasoning", () => {
  it("keeps reasoning for compat endpoints (freeform provider)", () => {
    const info = resolveModel(compatModelIdForEndpoint(endpoint.id), [endpoint]);
    expect(modelKeepsReasoning(info)).toBe(true);
  });

  it("keeps reasoning for the reasoning-tagged ZedCode model", () => {
    expect(modelKeepsReasoning(resolveModel("zedcode-auto"))).toBe(true);
  });
});

describe("model sampling capabilities", () => {
  it("defaults unknown provider models to temperature support", () => {
    expect(modelSupportsTemperature("openai-compatible", "custom-model")).toBe(
      true,
    );
  });

  it("keeps temperature for the ZedCode model", () => {
    expect(modelSupportsTemperature("zedcode", "zedcode-auto")).toBe(true);
  });

  it("allocates a reasoning output budget for the reasoning-tagged ZedCode model", () => {
    expect(modelUsesReasoningTokens("zedcode", "zedcode-auto")).toBe(true);
  });

  it("still recognises gpt-oss reasoning by pattern", () => {
    expect(modelUsesReasoningTokens("groq", "openai/gpt-oss-20b")).toBe(true);
  });
});

describe("migrateLegacyCompatEndpoint", () => {
  it("migrates a fully configured legacy endpoint", () => {
    const out = migrateLegacyCompatEndpoint(
      "https://api.example.com/v1",
      "llama-3.3-70b",
      32_000,
      "fixedid1",
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "fixedid1",
      baseURL: "https://api.example.com/v1",
      modelId: "llama-3.3-70b",
      contextLimit: 32_000,
    });
  });

  it("skips migration when base URL or model id is missing", () => {
    expect(migrateLegacyCompatEndpoint("", "m", 1, "x")).toEqual([]);
    expect(migrateLegacyCompatEndpoint("u", "  ", 1, "x")).toEqual([]);
  });
});

describe("stepBudgetForRound", () => {
  it("starts at VS Code's agent-mode default", () => {
    expect(stepBudgetForRound(0)).toBe(25);
    expect(MAX_AGENT_STEPS).toBe(25);
  });

  it("climbs one tier per Continue", () => {
    expect(stepBudgetForRound(1)).toBe(50);
    expect(stepBudgetForRound(2)).toBe(100);
  });

  it("holds at the top tier instead of growing without bound", () => {
    expect(stepBudgetForRound(3)).toBe(100);
    expect(stepBudgetForRound(99)).toBe(100);
  });

  it("clamps a negative round to the first tier", () => {
    expect(stepBudgetForRound(-1)).toBe(25);
  });

  it("never lets a later round shrink the budget", () => {
    for (let r = 1; r < 8; r++) {
      expect(stepBudgetForRound(r)).toBeGreaterThanOrEqual(
        stepBudgetForRound(r - 1),
      );
    }
  });
});
