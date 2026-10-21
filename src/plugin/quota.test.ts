import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./token", () => ({
  refreshAccessToken: vi.fn(async (auth: { refresh: string }) => ({
    type: "oauth",
    refresh: auth.refresh,
    access: "access-token",
    expires: Date.now() + 3_600_000,
  })),
}))

import { getAntigravityUserAgent } from "../constants.ts"
import { checkAccountsQuota } from "./quota.ts"
import type { AccountMetadataV3 } from "./storage.ts"
import type { PluginClient } from "./types.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const account: AccountMetadataV3 = {
  email: "user@example.com",
  refreshToken: "refresh-token",
  managedProjectId: "managed-project",
  addedAt: 0,
  lastUsed: 0,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("checkAccountsQuota", () => {
  it("reads Antigravity quota from the daily host with the Hub User-Agent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/v1internal:fetchAvailableModels")) {
        return jsonResponse({
          models: {
            "claude-opus-5-5-high": { quotaInfo: { remainingFraction: 0.5, resetTime: "2026-10-22T00:00:00Z" } },
            "gemini-3.8-flash-high": { quotaInfo: { remainingFraction: 0.25 } },
            "malformed-entry": null,
          },
        })
      }
      if (url.endsWith("/v1internal:retrieveUserQuota")) {
        return jsonResponse({ buckets: [] })
      }
      return jsonResponse({ error: "unexpected" }, 404)
    })
    vi.stubGlobal("fetch", fetchMock)

    const [result] = await checkAccountsQuota([account], {} as PluginClient)

    expect(result?.status).toBe("ok")
    expect(result?.quota?.groups.claude?.remainingFraction).toBe(0.5)
    expect(result?.quota?.groups["gemini-flash"]?.remainingFraction).toBe(0.25)

    const modelsCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/v1internal:fetchAvailableModels"))
    expect(modelsCalls).toHaveLength(1)
    const [modelsUrl, modelsInit] = modelsCalls[0]!
    expect(String(modelsUrl)).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels")
    expect(new Headers(modelsInit?.headers).get("User-Agent")).toBe(getAntigravityUserAgent())
    expect(JSON.parse(String(modelsInit?.body))).toEqual({ project: "managed-project" })

    // Gemini CLI quota buckets stay on production.
    const cliCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/v1internal:retrieveUserQuota"))
    expect(String(cliCall?.[0])).toBe("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")
  })
})
