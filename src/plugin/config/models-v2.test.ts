import { describe, expect, it } from "vitest"
import { OPENCODE_V2_MODEL_DEFINITIONS } from "./models-v2"

describe("OpenCode V2 models", () => {
  it("registers tools, modalities, and V2 variant overlays", () => {
    expect(OPENCODE_V2_MODEL_DEFINITIONS["gemini-2.5-flash"]).toBeUndefined()
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-3-flash"]).toMatchObject({
      package: "aisdk:@ai-sdk/google",
      capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
      variants: expect.arrayContaining([{ id: "high", settings: { thinkingConfig: { thinkingLevel: "high" } } }]),
    })
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-claude-opus-4-6-thinking"]?.variants).toContainEqual({
      id: "max", settings: { thinkingConfig: { thinkingBudget: 32768 } },
    })
  })

  it("exposes current Hub model IDs without removing their backend tier", () => {
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-claude-opus-5-5-high"]).toMatchObject({
      name: "Claude Opus 5.5 High (Antigravity)",
      limit: { context: 1000000, output: 128000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      variants: [],
    })
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-4-argon-high"]).toBeDefined()
    expect(OPENCODE_V2_MODEL_DEFINITIONS["antigravity-gemini-3.8-flash-high"]).toBeDefined()
  })
})
