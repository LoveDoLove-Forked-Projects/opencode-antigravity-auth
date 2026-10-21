import { AsyncLocalStorage } from "node:async_hooks"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { Credential, Integration, Model, Plugin, Provider } from "@opencode/plugin"

import { authorizeAntigravity, exchangeAntigravity } from "./antigravity/oauth.ts"
import { ANTIGRAVITY_REDIRECT_URI } from "./constants.ts"
import { createAntigravityPlugin, persistAccountPool } from "./plugin.ts"
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "./plugin/auth.ts"
import { OPENCODE_V2_MODEL_DEFINITIONS } from "./plugin/config/models-v2.ts"
import { ensureProjectContext } from "./plugin/project.ts"
import { executeSearch, type SearchArgs } from "./plugin/search.ts"
import { startOAuthListener, type OAuthListener } from "./plugin/server.ts"
import { loadAccounts, saveAccounts } from "./plugin/storage.ts"
import { AntigravityTokenRefreshError, refreshAccessToken } from "./plugin/token.ts"
import type { AuthDetails, LoaderResult, OAuthAuthDetails, PluginClient } from "./plugin/types.ts"

const PROVIDER_ID = "google"
const METHOD_ID = "antigravity"
// Core rewrites the standard Google SDK package to its native transport after
// every provider/model update. Its local module URL avoids that conversion and
// lets Core's earlier generic SDK loader use our installed dependency directly.
const SDK_PACKAGE = typeof import.meta.resolve === "function"
  ? import.meta.resolve("@ai-sdk/google")
  : pathToFileURL(createRequire(import.meta.url).resolve("@ai-sdk/google")).href
const GOOGLE_PACKAGE = `aisdk:${SDK_PACKAGE}`
const API_KEY_SENTINEL = "antigravity-oauth"
const ownsModel = (id: string) => id.startsWith("antigravity-")
type Registration = { dispose(): Promise<void> }
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function mergeBody(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const previous = result[key]
    if (value === undefined) continue
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      && previous && typeof previous === "object" && !Array.isArray(previous)
      ? mergeBody(previous as Record<string, unknown>, value as Record<string, unknown>)
      : value
  }
  return result
}

// V2 owns credentials, notifications and session repair. The legacy transport
// only needs these methods to be awaitable; it never writes V2 session files.
function transportClient(): PluginClient {
  const unusedSession = async () => {
    throw new Error("Legacy session recovery is unavailable in OpenCode V2")
  }
  return {
    app: { log: async () => undefined },
    auth: { set: async () => undefined },
    tui: { showToast: async () => undefined },
    session: { prompt: unusedSession, abort: unusedSession, messages: unusedSession },
  }
}

function oauthCredential(auth: OAuthAuthDetails, metadata?: Credential.OAuth["metadata"]): Credential.OAuth {
  return {
    type: "oauth",
    methodID: Integration.MethodID.make(METHOD_ID),
    refresh: auth.refresh,
    access: auth.access ?? "",
    expires: auth.expires ?? 0,
    ...(metadata ? { metadata } : {}),
  }
}

function isAntigravityCredential(value: Credential.Value | undefined): value is Credential.OAuth {
  return value?.type === "oauth" && value.methodID === METHOD_ID && !!value.refresh
}

/** OpenCode 2.1's source transforms and AI SDK 3 transport adapter. */
export const AntigravityV2Plugin = Plugin.define({
  id: "opencode-antigravity-auth",
  async setup(ctx) {
    const client = transportClient()
    const outbound = new AsyncLocalStorage<Fetch>()
    const transport = await createAntigravityPlugin(PROVIDER_ID)({
      client,
      directory: ctx.location.directory,
      runtimeVersion: 2,
      fetch: (input, init) => {
        const send = outbound.getStore() ?? globalThis.fetch
        // Core's wrapper applies model.body to string init.body. It has already
        // been applied to the Google request before interception, so a Request
        // prevents applying that overlay again to the Antigravity envelope.
        const request = new Request(input, init)
        request.headers.delete("x-goog-api-key")
        return send(request, { signal: init?.signal })
      },
    })
    const registrations: Registration[] = []
    const saved = await loadAccounts()
    const hasSavedAccounts = saved?.accounts.some((account) => account.enabled !== false && !!account.refreshToken)
    const listeners = new Set<OAuthListener>()
    const lifetime = new AbortController()
    let disposed = false
    let loader: LoaderResult | undefined
    let loaderIdentity: string | undefined
    let generation = 0
    let observedIdentity: string | undefined
    let loading: Promise<LoaderResult | undefined> | undefined

    type ResolvedAuth = { auth: OAuthAuthDetails; identity: string; select: boolean }
    const observeAuth = (resolved: ResolvedAuth | undefined) => {
      if (observedIdentity !== resolved?.identity) {
        observedIdentity = resolved?.identity
        generation += 1
        loader = undefined
        loaderIdentity = undefined
      }
      return resolved
    }
    const resolveAuth = async (): Promise<ResolvedAuth | undefined> => {
      const connection = await ctx.integration.connection.active(PROVIDER_ID)
      if (connection) {
        const value = await ctx.integration.connection.resolve(connection)
        const stored = await loadAccounts()
        const migrated = value?.type === "oauth" && value.methodID === "oauth"
          && stored?.accounts.some((account) => account.refreshToken === parseRefreshParts(value.refresh).refreshToken)
        if (!isAntigravityCredential(value) && !migrated) return observeAuth(undefined)
        if (value?.type !== "oauth") return observeAuth(undefined)
        // V1 credentials are imported with a generic method ID. Only matching
        // this plugin's existing pool establishes their Antigravity ownership.
        return observeAuth({ auth: value, identity: `credential:${parseRefreshParts(value.refresh).refreshToken}`, select: true })
      }
      // The independent pool also supports V1 migration without a connection.
      const stored = await loadAccounts()
      const active = stored?.accounts[stored.activeIndex]
      const account = active?.enabled !== false && active?.refreshToken
        ? active
        : stored?.accounts.find((item) => item.enabled !== false && item.refreshToken)
      return observeAuth(account ? {
        auth: { type: "oauth", refresh: formatRefreshParts(account) },
        identity: "account-pool",
        select: false,
      } : undefined)
    }
    const currentAuth = async () => (await resolveAuth())?.auth
    const invalidateLoader = () => { generation += 1; loader = undefined; loaderIdentity = undefined }

    const rememberAuth = async (auth: OAuthAuthDetails, email?: string) => {
      const parts = parseRefreshParts(auth.refresh)
      await persistAccountPool([{
        type: "success",
        refresh: auth.refresh,
        access: auth.access ?? "",
        expires: auth.expires ?? 0,
        projectId: parts.projectId ?? "",
        email,
      }])
    }

    const getLoader = async (): Promise<LoaderResult> => {
      if (disposed) throw new Error("Antigravity plugin has been disposed")
      const resolved = await resolveAuth()
      if (!resolved) throw new Error("Connect Google with Antigravity OAuth to use this model")
      const { auth, identity } = resolved
      if (loader && loaderIdentity === identity) return loader
      if (loading) { await loading; return getLoader() }
      const expectedGeneration = generation
      loading = (async () => {
        // Finish an older manager's pending save before selecting a new
        // connection, so it cannot overwrite the newly selected cursors.
        await transport.flush?.()
        const token = parseRefreshParts(auth.refresh).refreshToken
        let stored = await loadAccounts()
        if (!stored?.accounts.some((account) => account.refreshToken === token)) {
          await rememberAuth(auth)
          stored = await loadAccounts()
        }
        if (resolved.select && stored) {
          const index = stored.accounts.findIndex((account) => account.refreshToken === token && account.enabled !== false)
          if (index >= 0) {
            stored.activeIndex = index
            stored.activeIndexByFamily = { claude: index, gemini: index }
            await saveAccounts(stored)
          }
        }
        const result = await transport.auth.loader(async (): Promise<AuthDetails> =>
          await currentAuth() ?? { type: "none" }, {})
        if (typeof result.fetch !== "function") throw new Error("Antigravity OAuth is unavailable")
        if (disposed) throw new Error("Antigravity plugin has been disposed")
        if (generation !== expectedGeneration) return undefined
        loader = result as LoaderResult
        loaderIdentity = identity
        return loader
      })()
      let result: LoaderResult | undefined
      try { result = await loading } finally { loading = undefined }
      return result ?? getLoader()
    }

    const scopedFetch = (fallback: unknown, body?: Model.Info["body"]): Fetch => async (input, init) => {
      if (disposed) throw new Error("Antigravity plugin has been disposed")
      const original: Fetch = typeof fallback === "function" ? fallback as Fetch : globalThis.fetch
      if (!await currentAuth()) return original(input, init)
      if (body && typeof init?.body === "string") {
        init = { ...init, body: JSON.stringify(mergeBody(JSON.parse(init.body) as Record<string, unknown>, body)) }
      }
      const interceptor = await getLoader()
      const signal = AbortSignal.any([
        lifetime.signal,
        ...(init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : []),
      ])
      return outbound.run(original, () => interceptor.fetch(input instanceof URL ? input.toString() : input, { ...init, signal }))
    }

    const cleanup = async () => {
      if (disposed) return
      disposed = true
      lifetime.abort(new Error("Antigravity plugin disposed"))
      await Promise.allSettled([...listeners].map((listener) => listener.close()))
      await Promise.allSettled(registrations.reverse().map((registration) => registration.dispose()))
      await transport.dispose?.()
      loader = undefined
    }

    try {
      registrations.push(await ctx.integration.transform((editor) => {
        editor.method.update({
          integrationID: PROVIDER_ID,
          method: {
            id: METHOD_ID,
            type: "oauth",
            label: "Google OAuth (Antigravity)",
            form: [
              { key: "projectId", type: "string", title: "Google Cloud project ID (optional)" },
              { key: "manual", type: "boolean", title: "Paste an authorization code or callback URL", default: true },
            ],
          },
          async authorize(answer) {
            const auth = await authorizeAntigravity(typeof answer.projectId === "string" ? answer.projectId : "")
            const state = new URL(auth.url).searchParams.get("state")
            if (!state) throw new Error("Antigravity authorization did not provide OAuth state")
            const complete = async (input: string) => {
              let code = input.trim()
              if (/^https?:\/\//i.test(code)) {
                const callback = new URL(code)
                const redirect = new URL(ANTIGRAVITY_REDIRECT_URI)
                if (callback.origin !== redirect.origin || callback.pathname !== redirect.pathname || callback.searchParams.get("state") !== state) {
                  throw new Error("Invalid Antigravity OAuth callback URL or state")
                }
                code = callback.searchParams.get("code") ?? ""
              }
              if (!code) throw new Error("Missing Antigravity authorization code")
              const result = await exchangeAntigravity(code, state)
              if (result.type !== "success") throw new Error("Antigravity authorization failed; please try signing in again")
              await persistAccountPool([result])
              invalidateLoader()
              return oauthCredential({ ...result, type: "oauth" }, result.email ? { email: result.email } : undefined)
            }
            if (answer.manual !== false) {
              return { url: auth.url, instructions: "Open this URL, then paste the authorization code or full callback URL.", mode: "code", callback: complete }
            }
            const listener = await startOAuthListener()
            listeners.add(listener)
            const callback = listener.waitForCallback()
              .then((url) => complete(url.toString()))
              .finally(async () => {
                listeners.delete(listener)
                await listener.close()
              })
            // The host consumes this promise after returning the authorization.
            void callback.catch(() => undefined)
            return { url: auth.url, instructions: "Open this URL in your browser to connect Antigravity.", mode: "auto", callback }
          },
          async refresh(credential) {
            try {
              const refreshed = await refreshAccessToken(credential, client, PROVIDER_ID)
              if (!refreshed?.access) throw new Error("Antigravity token refresh temporarily unavailable")
              const stored = await loadAccounts()
              const email = stored?.accounts.find((account) => account.refreshToken === parseRefreshParts(credential.refresh).refreshToken)?.email
              await rememberAuth(refreshed, email)
              return oauthCredential(refreshed, credential.metadata)
            } catch (error) {
              if (error instanceof AntigravityTokenRefreshError && error.code === "invalid_grant") {
                const stored = await loadAccounts()
                const account = stored?.accounts.find((item) => item.refreshToken === parseRefreshParts(credential.refresh).refreshToken)
                if (account && stored) { account.enabled = false; await saveAccounts(stored) }
                const connection = await ctx.integration.connection.active(PROVIDER_ID)
                if (connection) await ctx.integration.connection.status({ integrationID: PROVIDER_ID, connection, status: { status: "needs_auth", message: "Google revoked this account; sign in again." } })
                invalidateLoader()
              }
              // Core resolves credentials before model construction. Keep that
              // step available so the transport can rotate to another account.
              // Six minutes clears Core's five-minute refresh buffer briefly.
              return { ...credential, access: "", expires: Date.now() + 6 * 60_000 }
            }
          },
          label: (credential) => typeof credential.metadata?.email === "string" ? credential.metadata.email : undefined,
        })
      }))

      registrations.push(await ctx.provider.transform((editor) => {
        // Keep the native Google provider and every unrelated model intact.
        // Only a missing provider (e.g. a minimal host) needs a source template.
        if (!editor.get(PROVIDER_ID)) {
          editor.add({
            info: { ...Provider.Info.empty(Provider.ID.google), name: "Google", package: GOOGLE_PACKAGE },
            models: [],
          })
        }
        if (hasSavedAccounts) {
          editor.update(PROVIDER_ID, (provider) => {
            if (provider.activation === "auto") provider.activation = "enabled"
          })
        }
        for (const [id, definition] of Object.entries(OPENCODE_V2_MODEL_DEFINITIONS)) {
          editor.models.update(PROVIDER_ID, id, (model) => {
            Object.assign(model, structuredClone(definition), { package: GOOGLE_PACKAGE })
            model.variants = structuredClone(definition.variants).map((variant) => ({ ...variant, id: Model.VariantID.make(variant.id) }))
          })
        }
      }))

      registrations.push(await ctx.model.transform((editor) => {
        for (const model of editor.list(PROVIDER_ID)) {
          const id = String(model.id)
          if (!ownsModel(id)) continue
          editor.update(PROVIDER_ID, id, (target) => {
            // A native provider override can otherwise bypass the SDK hook.
            target.package = GOOGLE_PACKAGE
          })
        }
      }))

      registrations.push(await ctx.aisdk.hook("sdk", async (event) => {
        if (event.package !== SDK_PACKAGE || !ownsModel(event.model.id)) return
        event.sdk = createGoogleGenerativeAI({
          ...event.options,
          fetch: scopedFetch(event.options.fetch, event.model.body),
          // SDK 3 checks for a nonempty key before invoking custom fetch. The
          // interceptor replaces this sentinel with account-specific OAuth.
          apiKey: event.options.apiKey ?? API_KEY_SENTINEL,
          baseURL: event.options.baseURL ?? "https://generativelanguage.googleapis.com/v1beta",
        })
      }, { providerID: PROVIDER_ID }))

      registrations.push(await ctx.tool.transform((editor) => {
        editor.add({
          name: "google_search",
          description: "Search Google for current information and analyze URLs. Include URLs from the question in the urls argument.",
          input: {
            type: "object",
            properties: {
              query: { type: "string", minLength: 1 },
              urls: { type: "array", items: { type: "string" } },
              thinking: { type: "boolean", default: true },
            },
            required: ["query"],
            additionalProperties: false,
          },
          async execute(input, context) {
            const args = input as SearchArgs
            if (!args || typeof args.query !== "string" || !args.query.trim()) throw new Error("A search query is required")
            let auth = await currentAuth()
            if (!auth) return { content: "Connect Google with Antigravity OAuth to use Google Search." }
            if (!auth.access || accessTokenExpired(auth)) auth = await refreshAccessToken(auth, client, PROVIDER_ID)
            if (!auth?.access) throw new Error("Antigravity token refresh failed; please sign in again")
            const project = await ensureProjectContext(auth)
            return { content: await executeSearch(args, auth.access, project.effectiveProjectId, AbortSignal.any([context.signal, lifetime.signal])) }
          },
        })
      }))
      return cleanup
    } catch (error) {
      await cleanup()
      throw error
    }
  },
})
