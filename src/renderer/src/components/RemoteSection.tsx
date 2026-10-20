import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Copy, Loader2, QrCode, ShieldCheck, Smartphone, Trash2, Wifi, WifiOff } from 'lucide-react'
import type { PairingOffer, PublicSettings, RemoteStatus } from '@shared/types'
import { relTime } from '../lib'

interface Props {
  settings: PublicSettings
  onChange(s: PublicSettings): void
}

const cleanErr = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Settings → Phone: pair the Forge Android app over Tailscale. */
export function RemoteSection({ settings, onChange }: Props) {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [offer, setOffer] = useState<PairingOffer | null>(null)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await window.forge.remoteStatus())
    } catch (e) {
      setError(cleanErr(e))
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => {
      setNow(Date.now())
      void load()
    }, 2000)
    return () => clearInterval(t)
  }, [load])

  // a successful pairing adds a device: hide the code
  const deviceCount = status?.devices.length ?? 0
  const [countAtOffer, setCountAtOffer] = useState(0)
  useEffect(() => {
    if (offer && deviceCount > countAtOffer) setOffer(null)
  }, [offer, deviceCount, countAtOffer])

  const enabled = settings.remote.enabled
  const toggle = async (): Promise<void> => {
    setError(null)
    setOffer(null)
    onChange(await window.forge.updateSettings({ remote: { ...settings.remote, enabled: !enabled } }))
    await load()
  }

  const pair = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      setCountAtOffer(deviceCount)
      setOffer(await window.forge.remoteStartPairing())
    } catch (e) {
      setError(cleanErr(e))
    } finally {
      setBusy(false)
    }
  }

  const secondsLeft = offer ? Math.max(0, Math.round((offer.expiresAt - now) / 1000)) : 0
  const expired = !!offer && secondsLeft === 0

  return (
    <section className="field-group remote-section">
      <h3>
        <Smartphone size={13} /> Phone (Forge for Android)
      </h3>
      <div className="key-card">
        <div className="input-row">
          <span style={{ flex: 1 }}>
            Use Forge from your Android phone: see, start and delete sessions, chat, and approve changes.
            <span className="muted"> Works only over your private Tailscale network.</span>
          </span>
          <button className={`toggle ${enabled ? 'on' : ''}`} onClick={() => void toggle()} aria-label="toggle phone access" />
        </div>

        {enabled && status && (
          <div className={`remote-status ${status.listening ? 'ok' : 'warn'}`}>
            {status.listening ? <Wifi size={14} /> : <WifiOff size={14} />}
            <span className="grow">
              {status.listening ? (
                <>
                  Listening on Tailscale <code>{status.dnsName ?? status.address}</code>
                  <span className="muted"> · port {status.port}</span>
                </>
              ) : (
                (status.error ?? 'Starting…')
              )}
            </span>
          </div>
        )}

        {enabled && status?.listening && (
          <div className="input-row">
            <button className="btn primary" onClick={() => void pair()} disabled={busy}>
              {busy ? <Loader2 size={14} className="spin" /> : <QrCode size={14} />} {offer ? 'New code' : 'Pair a phone'}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              Install Tailscale on the phone and sign in to the same account, then scan the code with Forge.
            </span>
          </div>
        )}

        <AnimatePresence>
          {offer && (
            <motion.div className="pair-card" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}>
              <div className={`qr ${expired ? 'expired' : ''}`}>
                <img src={offer.qr} alt="Pairing QR code" />
              </div>
              <div className="pair-info">
                <strong>Scan with Forge on your phone</strong>
                <span className="muted">
                  {expired ? 'This code expired.' : `Single use · expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`}
                </span>
                <span className="muted" style={{ fontSize: 12 }}>
                  <ShieldCheck size={12} style={{ verticalAlign: -2, color: 'var(--ok)' }} /> Traffic stays inside your tailnet (WireGuard-encrypted). Only this code can pair a new phone.
                </span>
                <button
                  className="btn"
                  onClick={() => {
                    void navigator.clipboard?.writeText(offer.link).then(() => setCopied(true))
                    setTimeout(() => setCopied(false), 1500)
                  }}
                  disabled={expired}
                >
                  <Copy size={13} /> {copied ? 'Copied' : 'Copy pairing link'}
                </button>
                <code className="pair-link" data-testid="pair-link">
                  {offer.link}
                </code>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {error && <div className="test-result err">{error}</div>}

        {(status?.devices.length ?? 0) > 0 && (
          <div className="device-list">
            {status!.devices.map((d) => (
              <div key={d.id} className="device-row">
                <span className={`dot ${d.online ? 'on' : ''}`} />
                <Smartphone size={14} style={{ opacity: 0.7 }} />
                <span className="grow">{d.name}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {d.online ? 'connected' : d.lastSeen ? `last seen ${relTime(d.lastSeen)}` : 'never connected'}
                </span>
                <button
                  className="icon-btn sm"
                  title="Remove this phone"
                  onClick={async () => {
                    if (confirm(`Remove "${d.name}"? It will need to be paired again.`)) setStatus(await window.forge.remoteRevoke(d.id))
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
