import { describe, expect, it, vi } from "vitest"
import type { Plugin } from "@opencode/plugin/tui"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { AntigravityTuiPlugin } from "./tui.ts"

async function host(actions: Array<string | undefined>, confirmed = false) {
  let layer: KeymapLayer | undefined
  const account = { id: "account-id", email: "saved@example.test", enabled: true, current: true, verificationRequired: false, lastUsed: 1, connectionIDs: ["native-credential"] }
  const rpc = {
    list: vi.fn(async () => [account]), connections: vi.fn(async () => ({ ids: ["native-credential"] })), quotas: vi.fn(async () => ({ report: "Antigravity claude: 84% remaining; resets tomorrow", accounts: [{ id: account.id, email: account.email, disabled: false, report: "Antigravity claude: 84% remaining; resets tomorrow" }] })),
    update: vi.fn(async () => ({ message: "Account updated" })), models: vi.fn(async () => ({ count: 12 })),
  }
  const select = vi.fn(async (_options: { title: string; options: Array<{ title: string; value: string }> }) => actions.shift())
  const alert = vi.fn(async () => undefined)
  const remove = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => undefined)
  const ctx = {
    client: { rpc: () => rpc, credential: { remove }, integration: { oauth: {
      connect: vi.fn(async () => ({ data: { attemptID: "attempt", url: "https://accounts.google.com", instructions: "Sign in" } })),
      complete: vi.fn(async () => undefined), cancel,
    } } },
    location: { directory: "/tmp/menu-test" },
    ui: { dialog: { select, alert, confirm: async () => confirmed, prompt: async () => undefined }, toast: { show: vi.fn() } },
    keymap: { layer: (factory: () => KeymapLayer) => { layer = factory() } },
  } as unknown as Plugin.Context
  await AntigravityTuiPlugin.setup(ctx)
  const command = layer?.commands?.[0]
  if (!command) throw new Error("Account menu command was not registered")
  await command.run()
  return { command, rpc, select, alert, remove, cancel }
}

describe("Antigravity native menu", () => {
  it("opens from /antigravity, lists saved accounts, and displays quotas", async () => {
    const result = await host(["quotas", undefined])
    expect(result.command.slash).toEqual({ name: "antigravity", aliases: ["ag"] })
    expect(result.select.mock.calls[0]?.[0].options).toContainEqual(expect.objectContaining({ title: "saved@example.test [current]" }))
    expect(result.rpc.list).toHaveBeenCalledTimes(2)
    expect(result.rpc.quotas).toHaveBeenCalledOnce()
    expect(result.alert).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("84% remaining") }))
  })

  it("requires confirmation before deleting an account or its native connection", async () => {
    const cancelled = await host(["account-id", "delete", undefined])
    expect(cancelled.remove).not.toHaveBeenCalled()
    expect(cancelled.rpc.update).not.toHaveBeenCalled()
    const confirmed = await host(["account-id", "delete", undefined], true)
    expect(confirmed.remove).toHaveBeenCalledWith({ credentialID: "native-credential" })
    expect(confirmed.rpc.update).toHaveBeenCalledWith({ id: "account-id", action: "delete" }, expect.any(Object))
    expect(confirmed.remove.mock.invocationCallOrder[0]).toBeLessThan(confirmed.rpc.update.mock.invocationCallOrder[0]!)
  })

  it("cancels the OAuth attempt when the account dialog is dismissed", async () => {
    const result = await host(["add", undefined])
    expect(result.cancel).toHaveBeenCalledWith(expect.objectContaining({ attemptID: "attempt" }))
  })
})
