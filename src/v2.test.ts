import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { Credential, Integration, Model, Provider, type Plugin } from "@opencode/plugin"
import type { ConnectionInfo } from "@opencode/client"
import type { AISDKHooks } from "@opencode/plugin/promise/aisdk"
import type { IntegrationMethodRegistration } from "@opencode/plugin/promise/integration"
import type { ModelEditor } from "@opencode/plugin/promise/model"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import type { Info as ToolInfo, ToolContext } from "@opencode/plugin/promise/tool"
import type { DeepMutable } from "@opencode/plugin/promise/types"
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider"

import { AntigravityV2Plugin } from "./v2.ts"
import { createAntigravityPlugin } from "./plugin.ts"
import { ANTIGRAVITY_REDIRECT_URI } from "./constants.ts"
import { DEFAULT_CONFIG } from "./plugin/config/index.ts"
import type { AccountStorageV4 } from "./plugin/storage.ts"
import type { OAuthAuthDetails, PluginClient } from "./plugin/types.ts"

const state = vi.hoisted(() => ({
  storage: null as AccountStorageV4 | null,
  clear: vi.fn(),
  queueStart: vi.fn(),
  queueStop: vi.fn(),
  recovery: vi.fn(),
  updater: vi.fn(),
  closeListener: vi.fn(async () => undefined),
  callback: undefined as URL | undefined,
  exchange: vi.fn(),
  connectionStatus: vi.fn(async () => undefined),
}))

vi.mock("./plugin/storage.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plugin/storage.ts")>()
  return {
    ...original,
    loadAccounts: vi.fn(async () => state.storage ? structuredClone(state.storage) : null),
    saveAccounts: vi.fn(async (storage: AccountStorageV4) => {
      const accounts = new Map((state.storage?.accounts ?? []).map((account) => [account.refreshToken, account]))
      for (const account of storage.accounts) accounts.set(account.refreshToken, structuredClone(account))
      const merged = original.deduplicateAccountsByEmail([...accounts.values()])
      const index = (value: number | undefined) => Math.max(0, merged.findIndex((account) => account.refreshToken === storage.accounts[value ?? storage.activeIndex]?.refreshToken))
      state.storage = { ...structuredClone(storage), accounts: merged, activeIndex: index(storage.activeIndex),
        activeIndexByFamily: { claude: index(storage.activeIndexByFamily?.claude), gemini: index(storage.activeIndexByFamily?.gemini) } }
    }),
    saveAccountsReplace: vi.fn(async (storage: AccountStorageV4) => { state.storage = structuredClone(storage) }),
    clearAccounts: state.clear,
  }
})
vi.mock("./plugin/config/index.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("./plugin/config/index.ts")>(),
  loadConfig: () => ({ ...DEFAULT_CONFIG, proactive_token_refresh: true, request_jitter_max_ms: 0, quota_refresh_interval_minutes: 0 }),
}))
vi.mock("./plugin/version.ts", () => ({ refreshAntigravityVersion: async () => undefined, ANTIGRAVITY_VERSION_REFRESH_INTERVAL_MS: 10800000 }))
vi.mock("./plugin/project.ts", () => ({
  ensureProjectContext: async (auth: OAuthAuthDetails) => ({ auth, effectiveProjectId: "project" }),
  invalidateProjectContextCache: vi.fn(),
}))
vi.mock("./plugin/refresh-queue.ts", () => ({
  createProactiveRefreshQueue: () => ({ setAccountManager: vi.fn(), start: state.queueStart, stop: state.queueStop }),
}))
vi.mock("./plugin/recovery.ts", () => ({ createSessionRecoveryHook: state.recovery, getRecoverySuccessToast: vi.fn() }))
vi.mock("./hooks/auto-update-checker/index.ts", () => ({ createAutoUpdateCheckerHook: state.updater }))
vi.mock("./antigravity/oauth.ts", () => ({
  authorizeAntigravity: async () => ({ url: "https://accounts.google.com/auth?state=expected-state", verifier: "verifier", projectId: "project" }),
  exchangeAntigravity: state.exchange,
}))
vi.mock("./plugin/server.ts", () => ({
  startOAuthListener: async () => ({
    close: state.closeListener,
    waitForCallback: async () => state.callback ?? new URL(`${ANTIGRAVITY_REDIRECT_URI}?state=expected-state&code=callback-code`),
  }),
}))

type OAuthMethod = Extract<IntegrationMethodRegistration, { refresh?: unknown }>
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const googleSDKPackage = `aisdk:${pathToFileURL(createRequire(import.meta.url).resolve("@ai-sdk/google")).href}`
const cleanups: Array<() => Promise<void> | void> = []

function credential(refresh = "refresh|project"): Credential.OAuth {
  return {
    type: "oauth",
    methodID: Integration.MethodID.make("antigravity"),
    refresh,
    access: "access-token",
    expires: Date.now() + 3600_000,
  }
}

function pool() {
  return {
    version: 4 as const,
    accounts: [{ refreshToken: "refresh", projectId: "project", email: "first@example.test", enabled: true, addedAt: 1, lastUsed: 1 }],
    activeIndex: 0,
  }
}

async function host(options: { value?: Credential.Value; connection?: boolean; nativeOverride?: boolean } = {}) {
  let value = options.value ?? credential()
  let connected = options.connection !== false
  const provider = { ...Provider.Info.empty(Provider.ID.google), name: "Google", package: "@opencode/google" }
  const models = new Map<string, DeepMutable<Model.Info>>([
    ["gemini-native-only", Model.Info.default(Provider.ID.google, Model.ID.make("gemini-native-only")) as DeepMutable<Model.Info>],
  ])
  const record = { provider, models }
  let method: OAuthMethod | undefined
  let sdkHook: ((event: AISDKHooks["sdk"]) => Promise<void> | void) | undefined
  let tool: ToolInfo | undefined
  const disposals: ReturnType<typeof vi.fn>[] = []
  const registration = () => {
    const dispose = vi.fn(async () => undefined)
    disposals.push(dispose)
    return { dispose }
  }
  // Core applies AISDKNative.rewrite after each update callback, including
  // model transforms. Setting the ordinary Google SDK token cannot opt out.
  const nativeRewrite = (target: { package?: string }) => {
    if (target.package === "aisdk:@ai-sdk/google") target.package = "@opencode/ai/providers/google"
  }
  const updateModel: ProviderEditor["models"]["update"] = (_providerID, id, update) => {
    const model = models.get(id) ?? Model.Info.default(Provider.ID.google, Model.ID.make(id)) as DeepMutable<Model.Info>
    update(model)
    nativeRewrite(model)
    models.set(id, model)
  }
  const providerEditor = {
    get: () => record,
    update: (_id: string, update: (input: typeof provider) => void) => update(provider),
    models: { update: updateModel },
  } as unknown as ProviderEditor
  const modelEditor = {
    list: () => [...models.values()],
    update: updateModel,
  } as unknown as ModelEditor
  const ctx = {
    location: { directory: "/tmp/antigravity-v2-test" },
    integration: {
      connection: {
        active: async (): Promise<ConnectionInfo | undefined> => connected ? { type: "env", name: "test" } : undefined,
        resolve: async () => value,
        status: state.connectionStatus,
      },
      transform: async (callback: (editor: { method: { update(input: OAuthMethod): void } }) => void) => {
        callback({ method: { update: (input) => { method = input } } })
        return registration()
      },
    },
    provider: { transform: async (callback: (editor: ProviderEditor) => void) => { callback(providerEditor); return registration() } },
    model: {
      transform: async (callback: (editor: ModelEditor) => void) => {
        if (options.nativeOverride) for (const model of models.values()) model.package = "@opencode/google"
        callback(modelEditor)
        return registration()
      },
    },
    aisdk: {
      hook: async (_name: string, callback: typeof sdkHook, scope: { providerID: string }) => {
        expect(scope).toEqual({ providerID: "google" })
        sdkHook = callback
        return registration()
      },
    },
    tool: {
      transform: async (callback: (editor: { add(input: ToolInfo): void }) => void) => {
        callback({ add: (input) => { tool = input } })
        return registration()
      },
    },
  } as unknown as Plugin.Context
  const cleanup = await AntigravityV2Plugin.setup(ctx)
  if (cleanup) cleanups.push(cleanup)
  if (!method || !sdkHook || !tool || !cleanup) throw new Error("Missing V2 registrations")
  const hook = sdkHook
  return {
    models, provider, method, tool, cleanup, disposals,
    setCredential: (next: Credential.Value) => { value = next },
    disconnect: () => { connected = false },
    async sdk(id = "antigravity-gemini-3-flash", settings: Record<string, unknown> = {}) {
      const model = models.get(id)
      if (!model) throw new Error("Missing model")
      const preparedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
      const event: AISDKHooks["sdk"] = {
        model: model as unknown as Model.Info,
        package: model.package?.replace(/^aisdk:/, "") ?? "",
        options: { ...model.settings, ...settings, fetch: preparedFetch },
      }
      await hook(event)
      return { sdk: event.sdk as ReturnType<typeof import("@ai-sdk/google")["createGoogleGenerativeAI"]>, preparedFetch }
    },
  }
}

function mockNetwork() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "refreshed-access", expires_in: 3600 })
    return new Response(`data: ${JSON.stringify({ response: {
      candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Hello from Antigravity" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
    } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
  })
}

async function stream(sdk: ReturnType<typeof import("@ai-sdk/google")["createGoogleGenerativeAI"]>, id = "antigravity-gemini-3-flash", signal?: AbortSignal) {
  const response = await sdk(id).doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    abortSignal: signal,
  })
  const reader = response.stream.getReader()
  const parts: LanguageModelV3StreamPart[] = []
  while (true) {
    const item = await reader.read()
    if (item.done) return parts
    parts.push(item.value)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.storage = pool()
  state.callback = undefined
  state.exchange.mockResolvedValue({ type: "success", refresh: "new-refresh|project", access: "new-access", expires: 12345, projectId: "project", email: "second@example.test" })
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
})

describe("OpenCode V2 adapter", () => {
  it("keeps its SDK route after Core rewrites standard Google packages following every transform", async () => {
    const adapter = await host({ nativeOverride: true })
    for (const [id, model] of adapter.models) {
      if (!id.startsWith("antigravity-")) continue
      expect(model.package).toBe(googleSDKPackage)
      expect(model.package).toMatch(/^aisdk:file:\/\//)
    }
    expect(adapter.provider.package).toBe("@opencode/google")
    expect(adapter.models.get("gemini-native-only")?.package).toBe("@opencode/google")
  })

  it("streams a real SDK 3 request through the existing interceptor and preserves the prepared fetch", async () => {
    const network = mockNetwork()
    const adapter = await host({ nativeOverride: true })
    const { sdk, preparedFetch } = await adapter.sdk()
    const parts = await stream(sdk)
    expect(parts).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "Hello from Antigravity" }))
    expect(parts).toContainEqual(expect.objectContaining({ type: "finish", finishReason: { unified: "stop", raw: "STOP" } }))
    expect(preparedFetch).toHaveBeenCalledOnce()
    const call = network.mock.calls.find(([input]) => (input instanceof Request ? input.url : String(input)).includes("streamGenerateContent"))
    expect(call).toBeDefined()
    const [input, init] = call!
    const request = new Request(input, init)
    expect(request.url).toContain("/v1internal:streamGenerateContent")
    expect(request.url).not.toContain("generativelanguage.googleapis.com")
    const headers = request.headers
    expect(headers.get("authorization")).toBe("Bearer access-token")
    expect(headers.has("x-goog-api-key")).toBe(false)
    const body = await request.text()
    expect(body).not.toContain("antigravity-oauth")
    expect(JSON.parse(body)).toMatchObject({ project: "project", model: "gemini-3-flash", request: { contents: expect.any(Array) } })
  })

  it("only changes owned models and leaves native Google API-key access available", async () => {
    const adapter = await host({ value: { type: "key", key: "real-key" } })
    expect(adapter.provider.package).toBe("@opencode/google")
    expect(adapter.models.get("gemini-native-only")?.package).toBeUndefined()
    expect(adapter.models.get("antigravity-gemini-3-flash")?.package).toBe(googleSDKPackage)
    expect(adapter.models.has("gemini-2.5-flash")).toBe(false)
    const { sdk } = await adapter.sdk("gemini-native-only", { apiKey: "real-key", baseURL: "https://custom.example.test" })
    expect(sdk).toBeUndefined()
    expect(state.clear).not.toHaveBeenCalled()
  })

  it("uses enabled saved accounts without a V2 connection and preserves the pool on disconnect", async () => {
    mockNetwork()
    state.storage!.accounts.unshift({ ...pool().accounts[0]!, refreshToken: "disabled", email: "disabled@example.test", enabled: false })
    const adapter = await host({ connection: false })
    expect(adapter.provider.activation).toBe("enabled")
    const { sdk } = await adapter.sdk()
    expect(await stream(sdk)).toContainEqual(expect.objectContaining({ type: "text-delta" }))
    expect(state.storage?.accounts).toHaveLength(2)
    expect(state.clear).not.toHaveBeenCalled()
  })

  it("recognizes a migrated V1 OAuth credential only when its token belongs to the saved pool", async () => {
    const network = mockNetwork()
    const adapter = await host({ value: { ...credential(), methodID: Integration.MethodID.make("oauth") } })
    const { sdk } = await adapter.sdk()
    expect(await stream(sdk)).toContainEqual(expect.objectContaining({ type: "text-delta" }))
    expect(network.mock.calls.some(([input]) => (input instanceof Request ? input.url : String(input)).includes("daily-cloudcode"))).toBe(true)
    adapter.setCredential({ ...credential("unrelated|project"), methodID: Integration.MethodID.make("oauth") })
    await stream(sdk)
    expect(String(network.mock.calls.at(-1)?.[0])).toContain("generativelanguage.googleapis.com")
  })

  it("keeps the pool loader stable when rotation changes the saved active account", async () => {
    mockNetwork()
    state.storage!.accounts.push({ ...pool().accounts[0]!, refreshToken: "other" })
    const adapter = await host({ connection: false })
    const { sdk } = await adapter.sdk()
    await stream(sdk)
    state.storage!.activeIndex = 1
    await stream(sdk)
    expect(state.queueStart).toHaveBeenCalledOnce()
  })

  it("uses a cached SDK after an account is added to an initially empty pool", async () => {
    mockNetwork()
    state.storage = null
    const adapter = await host({ connection: false })
    const { sdk } = await adapter.sdk()
    state.storage = pool()
    expect(await stream(sdk)).toContainEqual(expect.objectContaining({ type: "text-delta" }))
  })

  it("allows Core resolution after revocation so the transport rotates to a healthy account", async () => {
    state.storage!.accounts.push({ ...pool().accounts[0]!, refreshToken: "healthy", email: "healthy@example.test" })
    const original = mockNetwork().getMockImplementation()!
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("oauth2.googleapis.com") && String(init?.body).includes("refresh_token=refresh&")) {
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      }
      return original(input, init)
    })
    const adapter = await host()
    const refreshed = await adapter.method.refresh!(credential())
    expect(refreshed.access).toBe("")
    expect(refreshed.expires).toBeGreaterThan(Date.now() + 5 * 60_000)
    expect(state.connectionStatus).toHaveBeenCalledWith(expect.objectContaining({ status: expect.objectContaining({ status: "needs_auth" }) }))
    expect(state.storage!.accounts[0]!.enabled).toBe(false)
    adapter.setCredential(refreshed)
    const { sdk } = await adapter.sdk()
    expect(await stream(sdk)).toContainEqual(expect.objectContaining({ type: "text-delta" }))
    expect(state.storage!.activeIndexByFamily?.gemini).toBe(1)
  })

  it("keeps an account enabled after a temporary refresh failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Temporary network failure"))
    const adapter = await host()
    const refreshed = await adapter.method.refresh!(credential())
    expect(refreshed.access).toBe("")
    expect(state.storage!.accounts[0]!.enabled).toBe(true)
    expect(state.connectionStatus).not.toHaveBeenCalled()
  })

  it("returns V2 OAuth credentials, rejects invalid callback state and keeps multiple accounts", async () => {
    const adapter = await host()
    const auth = await adapter.method.authorize({ manual: true })
    if (auth.mode !== "code") throw new Error("Expected manual OAuth")
    await expect(auth.callback(`${ANTIGRAVITY_REDIRECT_URI}?code=code&state=wrong`)).rejects.toThrow("state")
    await expect(auth.callback("https://malicious.test/?code=code&state=expected-state")).rejects.toThrow("callback")
    expect(state.exchange).not.toHaveBeenCalled()
    const result = await auth.callback("manual-code")
    expect(result).toEqual({ type: "oauth", methodID: "antigravity", refresh: "new-refresh|project", access: "new-access", expires: 12345, metadata: { email: "second@example.test" } })
    expect(state.exchange).toHaveBeenCalledWith("manual-code", "expected-state")
    expect(state.storage?.accounts.map((account) => account.refreshToken)).toEqual(["refresh", "new-refresh"])
    const automatic = await adapter.method.authorize({ manual: false })
    if (automatic.mode !== "auto") throw new Error("Expected automatic OAuth")
    await expect(automatic.callback).resolves.toMatchObject({ type: "oauth", methodID: "antigravity" })
    expect(state.closeListener).toHaveBeenCalledOnce()
  })

  it("refreshes the V2 credential shape and merges rotated tokens by account identity", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "refreshed", refresh_token: "rotated", expires_in: 3600 }))
    const adapter = await host()
    const result = await adapter.method.refresh!(credential())
    expect(result).toMatchObject({ type: "oauth", methodID: "antigravity", refresh: "rotated|project", access: "refreshed" })
    expect(result.expires).toBeGreaterThan(Date.now())
    expect(String(network.mock.calls[0]?.[1]?.body)).toContain("refresh_token=refresh")
    expect(state.storage?.accounts).toHaveLength(1)
    expect(state.storage?.accounts[0]?.refreshToken).toBe("rotated")
  })

  it("rebuilds transport on credential changes and disposes refresh queues and registrations", async () => {
    mockNetwork()
    const adapter = await host()
    const { sdk } = await adapter.sdk()
    await stream(sdk)
    adapter.setCredential(credential("second|project"))
    await stream(sdk)
    expect(state.queueStart).toHaveBeenCalledTimes(2)
    expect(state.queueStop).toHaveBeenCalledOnce()
    expect(state.storage?.accounts).toHaveLength(2)
    expect(state.storage!.accounts[state.storage!.activeIndex]?.refreshToken).toBe("second")
    await adapter.cleanup()
    expect(state.queueStop).toHaveBeenCalledTimes(2)
    expect(adapter.disposals).toHaveLength(5)
    for (const dispose of adapter.disposals) expect(dispose).toHaveBeenCalledOnce()
    await expect(stream(sdk)).rejects.toThrow("disposed")
    expect(state.recovery).not.toHaveBeenCalled()
    expect(state.updater).not.toHaveBeenCalled()
  })

  it("retains cancellation through the prepared wrapper and aborts in-flight requests on cleanup", async () => {
    const adapter = await host()
    const { sdk } = await adapter.sdk()
    const network = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) reject(signal.reason)
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    }))
    const request = stream(sdk)
    const rejection = expect(request).rejects.toThrow("disposed")
    await vi.waitFor(() => expect(network).toHaveBeenCalled())
    await adapter.cleanup()
    await rejection
  })

  it("registers google_search with a JSON schema and V2 content result", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ response: { candidates: [{ content: { parts: [{ text: "Search answer" }] } }] } }))
    const adapter = await host()
    expect(adapter.tool.input).toMatchObject({ type: "object", required: ["query"] })
    const result = await adapter.tool.execute({ query: "latest", urls: ["https://example.test"] }, { signal: new AbortController().signal } as ToolContext)
    expect(result.content).toContain("Search answer")
    expect(String(network.mock.calls[0]?.[0])).toContain(":generateContent")
  })

  it("does not clear saved accounts when the shared loader sees no V2 OAuth", async () => {
    const noop = async () => undefined
    const client: PluginClient = { auth: { set: noop }, app: { log: noop }, tui: { showToast: noop }, session: { prompt: noop, abort: noop, messages: noop } }
    const plugin = await createAntigravityPlugin("google")({ client, directory: "/tmp/antigravity-v2-test", runtimeVersion: 2 })
    expect(await plugin.auth.loader(async () => ({ type: "none" }), {})).toEqual({})
    expect(state.clear).not.toHaveBeenCalled()
    await plugin.dispose?.()
  })
})
