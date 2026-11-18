import type { KVOverlay } from '../storage/kv';

/**
 * Secrets come only from the environment. The shared code reads them with getSecrets()
 * (`secrets` in local storage); on the server that key is answered from the environment and is never
 * written to the database, whatever the code tries to save there.
 */
export function secretsOverlay(env: { upstoxAnalyticsToken: string | null }): KVOverlay {
  return {
    read(key, stored) {
      if (key !== 'secrets') return stored;
      return env.upstoxAnalyticsToken ? { upstoxAnalyticsToken: env.upstoxAnalyticsToken } : {};
    },
    write(key, value) {
      return key === 'secrets' ? {} : value;
    },
  };
}
