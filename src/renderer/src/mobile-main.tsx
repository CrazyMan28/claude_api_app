import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import { Device } from '@capacitor/device'
import { Preferences } from '@capacitor/preferences'
import { SplashScreen } from '@capacitor/splash-screen'
import { StatusBar, Style } from '@capacitor/status-bar'
import { App } from './App'
import { PairScreen } from './remote/PairScreen'
import { createRemoteForge, type Pairing } from './remote/client'
import './styles.css'

const KEY = 'forge.pairing'

async function loadPairing(): Promise<Pairing | null> {
  const { value } = await Preferences.get({ key: KEY })
  if (!value) return null
  try {
    const p = JSON.parse(value) as Pairing
    return p.base && p.token ? p : null
  } catch {
    return null
  }
}

function Root({ initial, deviceName }: { initial: Pairing | null; deviceName: string }) {
  const [pairing, setPairing] = useState<Pairing | null>(initial)
  const [ready, setReady] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)

  // forge://pair links opened from the phone's camera app land here
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    const h = CapApp.addListener('appUrlOpen', ({ url }) => {
      if (url.startsWith('forge://pair')) setLink(url)
    })
    return () => void h.then((x) => x.remove())
  }, [])

  useEffect(() => {
    if (!pairing) {
      setReady(false)
      return
    }
    const forget = async (): Promise<void> => {
      await Preferences.remove({ key: KEY })
      setPairing(null)
    }
    const api = createRemoteForge(pairing, {
      onUnauthorized: () => {
        setNotice('This phone was removed in Forge on the PC. Pair it again.')
        void forget()
      },
      unpair: async () => {
        setNotice(null)
        await forget()
      }
    })
    window.forge = api
    setReady(true)
    return () => api.close()
  }, [pairing])

  if (!pairing || !ready) {
    return (
      <PairScreen
        key={link ?? 'scan'}
        deviceName={deviceName}
        initialLink={link}
        notice={notice}
        onPaired={(p) => {
          setNotice(null)
          setLink(null)
          void Preferences.set({ key: KEY, value: JSON.stringify(p) })
          setPairing(p)
        }}
      />
    )
  }
  // a new pairing gets a fresh App (fresh state, new connection)
  return <App key={pairing.token} />
}

void (async () => {
  if (Capacitor.isNativePlatform()) {
    void StatusBar.setStyle({ style: Style.Dark }).catch(() => {})
    void StatusBar.setBackgroundColor({ color: '#06070c' }).catch(() => {})
  }
  const [initial, info] = await Promise.all([loadPairing(), Device.getInfo().catch(() => null)])
  const deviceName = info ? [info.manufacturer, info.model].filter(Boolean).join(' ').trim() || 'Android phone' : 'Android phone'
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root initial={initial} deviceName={deviceName} />
    </StrictMode>
  )
  void SplashScreen.hide().catch(() => {})
})()
