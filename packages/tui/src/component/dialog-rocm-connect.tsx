import { createMemo } from "solid-js"
import { TextAttributes } from "@opentui/core"
import QRCode from "qrcode"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"

export type DialogRocmConnectProps = {
  payload: string
  host: string
  bound: string
}

const QUIET_ZONE = 2
// Hardcode black-on-white for scan reliability — QR scanning needs real contrast, not theme colors.
const DARK = "#000000"
const LIGHT = "#ffffff"

// Encode two module rows per terminal line with half-block glyphs, so the QR stays square
// (a full character cell is ~1:2, half-blocks make each module ~1:1). The code is rendered
// full-width (no horizontal dialog padding) so the square form fits without wrapping.
function renderQr(payload: string): string[] {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" })
  const size = qr.modules.size
  const data = qr.modules.data
  const dim = size + QUIET_ZONE * 2

  const dark = (row: number, col: number) => {
    const r = row - QUIET_ZONE
    const c = col - QUIET_ZONE
    if (r < 0 || c < 0 || r >= size || c >= size) return false
    return data[r * size + c] === 1
  }

  const lines: string[] = []
  for (let row = 0; row < dim; row += 2) {
    let line = ""
    for (let col = 0; col < dim; col++) {
      const top = dark(row, col)
      const bottom = row + 1 < dim ? dark(row + 1, col) : false
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " "
    }
    lines.push(line)
  }
  return lines
}

export function DialogRocmConnect(props: DialogRocmConnectProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const lines = createMemo(() => renderQr(props.payload))

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: "Close",
        group: "Dialog",
        cmd: () => dialog.clear(),
      },
    ],
  }))

  return (
    <box gap={1}>
      <box paddingLeft={2} paddingRight={2} flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Connect ROCm mobile client
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box alignItems="center">
        {lines().map((line) => (
          <text fg={DARK} bg={LIGHT}>
            {line}
          </text>
        ))}
      </box>
      <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.textMuted}>Scan with the ROCm Bridge app · serving on {props.bound}</text>
        <text fg={theme.textMuted}>Advertising host {props.host}</text>
      </box>
    </box>
  )
}
