// QR code as an SVG (qrcode-generator computes the modules; we draw them, no innerHTML).
import qrcode from 'qrcode-generator'

export function QrCode({ text, label, size = 176 }: { text: string; label: string; size?: number }) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  let d = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${n + 8} ${n + 8}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}
