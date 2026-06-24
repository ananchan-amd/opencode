import { ToolBridge, protocolVersion, type PairingInfo } from "rocm-bridge-node"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { useSDK } from "../../context/sdk"
import type { useRoute } from "../../context/route"
import type { useLocal } from "../../context/local"

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
  let activity = false

  const handler = (event: GlobalEvent) => {
    if (done) return
    const ev = event.payload

    if (ev.type === "message.part.updated") {
      const part = ev.properties.part
      if (part.sessionID !== sessionID) return
      activity = true
      if (part.type === "text" && typeof part.text === "string") {
        const prev = sent.get(part.id) ?? 0
        if (part.text.length > prev) {
          cmd.reply.data(Buffer.from(part.text.slice(prev), "utf8"))
          sent.set(part.id, part.text.length)
        }
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

    // Completion: the assistant message for our session gets a `completed` timestamp. Gate on
    // having seen activity first, so a stale update for a prior completed message can't end early.
    if (
      ev.type === "message.updated" &&
      ev.properties.sessionID === sessionID &&
      ev.properties.info.role === "assistant" &&
      ev.properties.info.time.completed != null &&
      activity
    ) {
      finish(() => {
        off()
        cmd.reply.end()
      })
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
