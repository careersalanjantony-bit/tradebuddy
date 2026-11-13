import { useNow, useSessionValue } from '../hooks';

/** The download counts in steps of 5 stocks; no step for this long means it is waiting, not working. */
export const DOWNLOAD_QUIET_MS = 90_000;

/**
 * "Downloading price history: 60 of 100…" — and, when the counter has not moved for a while
 * (owner, 12 Nov 2026: "its stuck here why?"), a plain note that it is waiting for Upstox and
 * carries on by itself, instead of a counter that looks frozen.
 */
export function DownloadNote({ tail, testid }: { tail: string; testid?: string }) {
  const progress = useSessionValue('syncProgress');
  const now = useNow(10_000);
  if (!progress?.running || !(progress.total > 0)) return null;
  const quiet = now - progress.at > DOWNLOAD_QUIET_MS;
  return (
    <div class="banner info small" data-testid={testid}>
      {quiet ? (
        <>
          Price history: {progress.done} of {progress.total} companies so far. <b>Waiting for Upstox</b> (it is slow right now, mostly at night) — the download carries on by itself. You can use
          everything else meanwhile.
        </>
      ) : (
        <>
          Downloading price history: {progress.done} of {progress.total} companies… {tail}
        </>
      )}
    </div>
  );
}
