import { OPENCODE_MODEL_DEFINITIONS, type OpencodeModelDefinitions } from "./models.ts"

// Current Hub backend IDs reported by the maintained CLIProxyAPI inventory.
// These suffixes are part of the backend ID, rather than user thinking variants.
// Account access must still be checked against fetchAvailableModels.
const CURRENT_HUB_MODELS: OpencodeModelDefinitions = {
  "antigravity-claude-opus-5-5-high": {
    name: "Claude Opus 5.5 High (Antigravity)",
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  },
  "antigravity-claude-sonnet-5-5-high": {
    name: "Claude Sonnet 5.5 High (Antigravity)",
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  },
  "antigravity-gemini-4-argon-high": {
    name: "Gemini 4 Argon High (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  },
  "antigravity-gemini-3.8-flash-high": {
    name: "Gemini 3.8 Flash High (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  },
  "antigravity-gemini-3.1-flash-lite": {
    name: "Gemini 3.1 Flash Lite (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  },
  "antigravity-gemini-3.5-flash-lite": {
    name: "Gemini 3.5 Flash Lite (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  },
}

/** V2 model configuration uses capabilities and an array of variant overlays. */
export const OPENCODE_V2_MODEL_DEFINITIONS = Object.fromEntries(
  Object.entries({ ...OPENCODE_MODEL_DEFINITIONS, ...CURRENT_HUB_MODELS }).filter(([id]) => id.startsWith("antigravity-")).map(([id, model]) => [id, {
    name: model.name,
    package: "aisdk:@ai-sdk/google",
    limit: { ...model.limit },
    capabilities: { tools: true, ...model.modalities },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    variants: Object.entries(model.variants ?? {}).map(([variant, settings]) => ({
      id: variant,
      settings: settings.thinkingLevel
        ? { thinkingConfig: { thinkingLevel: settings.thinkingLevel } }
        : { ...settings },
    })),
  }]),
)
