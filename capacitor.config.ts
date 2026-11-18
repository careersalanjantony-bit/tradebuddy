import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'in.tradebuddy.app',
  appName: 'TradeBuddy',
  webDir: 'dist',
  android: {
    // The app talks only to Upstox and NSE, always over HTTPS.
    allowMixedContent: false,
  },
  plugins: {
    // Requests are made through appFetch (src/platform/http.ts), not a patched fetch.
    CapacitorHttp: { enabled: false },
    LocalNotifications: { smallIcon: 'ic_stat_tradebuddy', iconColor: '#10b981' },
    // checks practice shares and fast risers about every 15 minutes, also when the app is closed
    BackgroundRunner: { label: 'in.tradebuddy.background', src: 'runners/background.js', event: 'checkMarket', repeat: true, interval: 15, autoStart: true },
  },
};

export default config;
