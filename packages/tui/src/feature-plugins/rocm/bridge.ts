import { ToolBridge, protocolVersion, type PairingInfo } from "rocm-bridge-node"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { useSDK } from "../../context/sdk"
import type { useRoute } from "../../context/route"
import { parseModel, type useLocal } from "../../context/local"

// Integration of the ROCm Bridge SDK so a phone running the mobile client can pair over the LAN
// and drive opencode. We own only the three wirings the SDK asks for: show the QR (the dialog
// renders PairingInfo.payload), feed the phone's prompt into the live session, and pump the
// streamed assistant output back through the reply channel. Everything networking/pairing/protocol
// is the SDK's job — we never hand-roll IP selection, token minting, framing, or the transport.

export type RocmBridgeDeps = {
  sdk: ReturnType<typeof useSDK>
  route: ReturnType<typeof useRoute>
  local: ReturnType<typeof useLocal>
}

// The shape napi hands a command handler. The generated .d.ts types the callback loosely.
type RocmReply = { data(chunk: Buffer): void; end(): void; error(message: string): void }
type RocmCommand = { id: number; name: string; payload: Buffer; reply: RocmReply }

const DEFAULT_PORT = 7000

function port() {
  const raw = process.env["OPENCODE_ROCM_PORT"]
  const parsed = raw ? Number(raw) : NaN
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT
}

let started: { info: PairingInfo; bound: string } | undefined

// Lazily build, register, pair, and serve a single bridge. `serve()` takes ownership of the
// bridge (no more commands can be registered after), so repeated /rocm-connect reuses this.
export function startRocmBridge(deps: RocmBridgeDeps): { info: PairingInfo; bound: string } {
  if (started) return started

  const bridge = new ToolBridge()
  bridge.registerCommand("chat.completion", makeChatHandler(deps))
  // `rocm.telemetry` is registered automatically by the SDK (real GPU source via rocm-smi where
  // available, mock otherwise) — we only implement our own command, chat.
  registerFeatures(bridge, deps)

  const wsPort = port()
  const detail = deps.route.data?.type === "session" ? "session" : "ready"
  const info = bridge.startPairing(wsPort, process.env["OPENCODE_ROCM_HOST"] ?? null, "opencode", detail)
  const bound = bridge.serve("0.0.0.0:" + wsPort)

  started = { info, bound }
  return started
}

export function rocmProtocolVersion() {
  return protocolVersion()
}

// Serialize chat commands: we target the user's live session, so overlapping prompts would
// interleave. Chain handlers so only one prompt runs at a time.
let chain: Promise<unknown> = Promise.resolve()

function makeChatHandler(deps: RocmBridgeDeps) {
  return (cmd: RocmCommand) => {
    chain = chain.then(() => runChat(deps, cmd)).catch(() => {})
  }
}

async function runChat(deps: RocmBridgeDeps, cmd: RocmCommand): Promise<void> {
  const { sdk, route, local } = deps
  const prompt = cmd.payload.toString("utf8")

  let done = false
  const finish = (fn: () => void) => {
    if (done) return
    done = true
    fn()
  }

  // Resolve the live session, or create one if nothing is open in the TUI.
  let sessionID: string
  const current = route.data
  if (current?.type === "session" && typeof current.sessionID === "string") {
    sessionID = current.sessionID
  } else {
    try {
      const created = await sdk.client.session.create({}, { throwOnError: true })
      sessionID = (created.data as { id: string }).id
    } catch (err) {
      cmd.reply.error("failed to create session: " + String(err))
      return
    }
  }

  const model = local.model.current()
  const agent = local.agent.current()?.name
  const variant = local.model.variant.current()

  // Track cumulative text parts and emit only the newly-appended delta per part.
  const sent = new Map<string, number>()
  // IDs of assistant messages in this session. We only stream assistant text back — without this,
  // the user's own prompt part (also a `text` part in the session) would echo straight to the phone.
  const assistantMessages = new Set<string>()
  let activity = false

  const handler = (event: GlobalEvent) => {
    if (done) return
    const ev = event.payload

    if (ev.type === "message.part.updated") {
      const part = ev.properties.part
      if (part.sessionID !== sessionID) return
      if (part.type !== "text" || typeof part.text !== "string") return
      // Skip anything that isn't from an assistant message (e.g. the user's echoed prompt).
      if (!assistantMessages.has(part.messageID)) return
      activity = true
      const prev = sent.get(part.id) ?? 0
      if (part.text.length > prev) {
        cmd.reply.data(Buffer.from(part.text.slice(prev), "utf8"))
        sent.set(part.id, part.text.length)
      }
      return
    }

    if (ev.type === "session.error" && ev.properties.sessionID === sessionID) {
      const error = ev.properties.error
      const message = error ? String(error.name) : "session error"
      finish(() => {
        off()
        cmd.reply.error(message)
      })
      return
    }

    if (ev.type === "message.updated" && ev.properties.sessionID === sessionID) {
      const info = ev.properties.info
      if (info.role !== "assistant") return
      assistantMessages.add(info.id)
      // Completion: the assistant message gets a `completed` timestamp. Gate on having seen activity
      // first, so a stale update for a prior completed message can't end the stream early.
      if (info.time.completed != null && activity) {
        finish(() => {
          off()
          cmd.reply.end()
        })
      }
    }
  }

  const off = sdk.event.on("event", handler)

  try {
    await sdk.client.session.prompt(
      {
        sessionID,
        model: model ? { providerID: model.providerID, modelID: model.modelID } : undefined,
        agent,
        variant,
        parts: [{ type: "text", text: prompt }],
      },
      { throwOnError: true },
    )
  } catch (err) {
    finish(() => {
      off()
      cmd.reply.error(String(err))
    })
  }
}

// --- Tool features (the "core trio") -----------------------------------------------------------
// OpenCode is the single source of truth. Every reported value is derived by calling OpenCode's own
// getters (`local.model.*`, `local.agent.*`, the session message list); the SDK descriptor is only a
// display mirror. After a phone-driven change we apply it via OpenCode's setter, then re-read the
// resolved current state and push *that* back — so a rejected/normalized set still mirrors reality.

type Local = RocmBridgeDeps["local"]

function modelKey(m: { providerID: string; modelID: string }): string {
  return `${m.providerID}/${m.modelID}`
}

function modelDetail(local: Local): string {
  const p = local.model.parsed()
  return `${p.provider} · ${p.model}`
}

// Static menu: current ∪ recent ∪ favorite, deduped, current first.
function modelOptions(local: Local): string[] {
  const current = local.model.current()
  const all = [...(current ? [current] : []), ...local.model.recent(), ...local.model.favorite()]
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of all) {
    const key = modelKey(m)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

// The one funnel that maps OpenCode's current state → the SDK display mirror.
function pushFeatureState(bridge: ToolBridge, local: Local): void {
  const m = local.model.current()
  if (m) {
    bridge.updateFeatureState("opencode.model", JSON.stringify({ value: modelKey(m), detail: modelDetail(local) }))
  }
  const a = local.agent.current()
  if (a) {
    bridge.updateFeatureState("opencode.agent", JSON.stringify({ value: a.name, detail: a.name }))
  }
}

function registerFeatures(bridge: ToolBridge, deps: RocmBridgeDeps): void {
  const { local } = deps

  const currentModel = local.model.current()
  const modelDescriptor = {
    id: "opencode.model",
    label: "Model",
    group: "Model",
    detail: modelDetail(local),
    control: { kind: "select", options: modelOptions(local), value: currentModel ? modelKey(currentModel) : null },
  }
  bridge.registerFeature(JSON.stringify(modelDescriptor), (cmd: RocmCommand) => {
    local.model.set(parseModel(cmd.payload.toString("utf8")), { recent: true })
    pushFeatureState(bridge, local)
    cmd.reply.data(Buffer.from("model set", "utf8"))
    cmd.reply.end()
  })

  const currentAgent = local.agent.current()
  const agentDescriptor = {
    id: "opencode.agent",
    label: "Active agent",
    group: "Agent",
    detail: currentAgent?.name,
    control: { kind: "select", options: local.agent.list().map((a) => a.name), value: currentAgent?.name ?? null },
  }
  bridge.registerFeature(JSON.stringify(agentDescriptor), (cmd: RocmCommand) => {
    local.agent.set(cmd.payload.toString("utf8"))
    pushFeatureState(bridge, local)
    cmd.reply.data(Buffer.from("agent set", "utf8"))
    cmd.reply.end()
  })

  const statsDescriptor = {
    id: "opencode.stats",
    label: "Session stats",
    group: "Stats",
    control: { kind: "info" },
  }
  bridge.registerFeature(JSON.stringify(statsDescriptor), (cmd: RocmCommand) => {
    void runStats(deps, cmd)
  })
}

function formatTokens(n: number): { value: string; unit?: string } {
  if (n >= 1000) return { value: (n / 1000).toFixed(1), unit: "k" }
  return { value: String(n) }
}

// `info` handler: read the live session every time (no mirror). Sums assistant cost and reports the
// latest assistant message's context-token total, mirroring OpenCode's own sidebar computation.
async function runStats(deps: RocmBridgeDeps, cmd: RocmCommand): Promise<void> {
  const { sdk, route } = deps
  const current = route.data

  if (!(current?.type === "session" && typeof current.sessionID === "string")) {
    cmd.reply.data(Buffer.from(JSON.stringify({ items: [{ label: "session", value: "none" }] }), "utf8"))
    cmd.reply.end()
    return
  }

  const sessionID = current.sessionID
  try {
    const result = await sdk.client.v2.session.messages({ sessionID }, { throwOnError: true })
    const messages = (result.data as { data: Array<{ type: string; cost?: number; tokens?: AssistantTokens }> }).data

    let cost = 0
    let assistantCount = 0
    for (const m of messages) {
      if (m.type !== "assistant") continue
      assistantCount++
      if (typeof m.cost === "number") cost += m.cost
    }

    let tokens = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.type === "assistant" && m.tokens && m.tokens.output > 0) {
        const t = m.tokens
        tokens = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
        break
      }
    }

    const tok = formatTokens(tokens)
    const items = [
      { label: "context", value: tok.value, unit: tok.unit },
      { label: "cost", value: "$" + cost.toFixed(2) },
      { label: "messages", value: String(assistantCount) },
    ]
    cmd.reply.data(Buffer.from(JSON.stringify({ items }), "utf8"))
    cmd.reply.end()
  } catch (err) {
    cmd.reply.error("failed to read session stats: " + String(err))
  }
}

type AssistantTokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}
