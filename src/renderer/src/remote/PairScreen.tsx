import { useState } from 'react'
import { motion } from 'framer-motion'
import { ClipboardPaste, Loader2, QrCode, ShieldCheck, XCircle } from 'lucide-react'
import { Capacitor } from '@capacitor/core'
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning'
import { pairWithPc, parsePairLink, type Pairing } from './client'

interface Props {
  deviceName: string
  initialLink?: string | null
  notice?: string | null
  onPaired(p: Pairing): void
}

async function scanQr(): Promise<string | null> {
  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()
  if (!available) {
    await BarcodeScanner.installGoogleBarcodeScannerModule()
    throw new Error('Downloading the Google QR scanner (one time). Try again in a few seconds.')
  }
  const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] })
  return barcodes[0]?.rawValue ?? null
}

/** First run on the phone: scan the QR code from Forge Settings → Phone on the PC. */
export function PairScreen({ deviceName, initialLink, notice, onPaired }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState(initialLink ?? '')
  const native = Capacitor.isNativePlatform()

  const pair = async (raw: string | null): Promise<void> => {
    if (!raw) return
    const link = parsePairLink(raw)
    if (!link) return setError('That is not a Forge pairing code. Open Forge on your PC → Settings → Phone → Pair a phone.')
    setBusy(true)
    setError(null)
    try {
      onPaired(await pairWithPc(link, deviceName))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="aurora" />
      <div className="grid-overlay" />
      <div className="pair-screen">
        <motion.div className="pair-panel" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 26 }}>
          <div className="brand-mark big">F</div>
          <h1>Forge</h1>
          <p className="muted">Your Claude coding agent, from your phone.</p>

          <ol className="pair-steps">
            <li>
              Install <strong>Tailscale</strong> on your PC and this phone and sign in to the same account.
            </li>
            <li>
              On the PC open Forge → <strong>Settings → Phone</strong>, turn it on and press <strong>Pair a phone</strong>.
            </li>
            <li>Scan the QR code.</li>
          </ol>

          {notice && <div className="notice warn">{notice}</div>}

          {native && (
            <button
              className="btn primary big"
              disabled={busy}
              onClick={() => {
                setError(null)
                scanQr()
                  .then(pair)
                  .catch((e) => setError((e as Error).message))
              }}
            >
              {busy ? <Loader2 size={18} className="spin" /> : <QrCode size={18} />} Scan QR code
            </button>
          )}

          <div className="pair-manual">
            <input className="input mono" placeholder="…or paste the pairing link (forge://pair?…)" value={manual} onChange={(e) => setManual(e.target.value)} autoComplete="off" spellCheck={false} />
            <button className="btn" disabled={busy || !manual.trim()} onClick={() => void pair(manual)} title="Pair with link">
              <ClipboardPaste size={15} /> Pair
            </button>
          </div>

          {error && (
            <div className="test-result err">
              <XCircle size={14} /> <span>{error}</span>
            </div>
          )}

          <div className="pair-foot muted">
            <ShieldCheck size={13} style={{ color: 'var(--ok)', flex: 'none' }} />
            <span>Everything travels inside your private, encrypted Tailscale network. Your API key stays on the PC.</span>
          </div>
        </motion.div>
      </div>
    </>
  )
}
