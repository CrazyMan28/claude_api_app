import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Tailscale hands out IPv4 addresses from the CGNAT range 100.64.0.0/10. */
function inCgnat(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 100 && b >= 64 && b <= 127
}

/** ...and IPv6 addresses from fd7a:115c:a1e0::/48. */
function inTailscaleV6(ip: string): boolean {
  return /^fd7a:115c:a1e0:/i.test(ip)
}

/** True if `addr` (as reported by a socket, possibly IPv4-mapped) is inside the tailnet. */
export function isTailnetAddress(addr: string | undefined): boolean {
  if (!addr) return false
  const ip = addr.replace(/^::ffff:/i, '').replace(/%.*$/, '')
  return inCgnat(ip) || inTailscaleV6(ip)
}

/** This machine's Tailscale IPv4 address (preferred) or IPv6 address, or null if Tailscale is not up. */
export function findTailscaleAddress(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string | null {
  const all = Object.values(ifaces).flatMap((list) => list ?? [])
  const v4 = all.find((i) => i.family === 'IPv4' && !i.internal && inCgnat(i.address))
  if (v4) return v4.address
  const v6 = all.find((i) => i.family === 'IPv6' && !i.internal && inTailscaleV6(i.address))
  return v6?.address ?? null
}

function tailscaleCli(): string {
  if (process.platform === 'win32') {
    const p = 'C:\\Program Files\\Tailscale\\tailscale.exe'
    if (existsSync(p)) return p
  }
  return 'tailscale'
}

/** MagicDNS name of this machine (e.g. my-pc.tailnet-1234.ts.net), or null when the CLI is unavailable. */
export function tailscaleDnsName(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(tailscaleCli(), ['status', '--self', '--peers=false', '--json'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      try {
        const name = (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName
        resolve(name ? name.replace(/\.$/, '') : null)
      } catch {
        resolve(null)
      }
    })
  })
}
