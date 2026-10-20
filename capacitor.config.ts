import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.crazyman28.forge',
  appName: 'Forge',
  webDir: 'mobile/www',
  backgroundColor: '#06070c',
  android: {
    path: 'mobile/android',
    backgroundColor: '#06070c'
  },
  server: {
    // The PC is reached at http://100.x.y.z inside the tailnet (Tailscale/WireGuard encrypts it),
    // so the app page itself is served over http to allow those requests.
    androidScheme: 'http',
    cleartext: true
  },
  plugins: {
    SplashScreen: { launchAutoHide: false, backgroundColor: '#06070c', showSpinner: false },
    StatusBar: { style: 'DARK', backgroundColor: '#06070c', overlaysWebView: false }
  }
}

export default config
