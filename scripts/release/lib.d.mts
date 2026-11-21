/** Types for lib.mjs (the release pipeline's pure rules), for the TypeScript tests. */
export declare const REPO: string;
export declare const UPDATES_BRANCH: string;
export declare const DOWNLOAD_PREFIX: string;
export declare const MAX_NOTES: number;
export declare const MAX_NOTE_CHARS: number;
export declare const MAX_APK_BYTES: number;

export interface Parts {
  server: boolean;
  app: boolean;
}
export interface Plan {
  target: string;
  server: 'deploy' | 'current' | 'not-needed';
  app: 'publish' | 'current' | 'not-needed';
  kind: 'coordinated' | 'server-only' | 'app-only' | 'nothing';
  steps: Array<'validate' | 'build-apk' | 'deploy-server' | 'publish-app'>;
}
export interface Latest {
  version: string;
  date: string;
  apk: string;
  size: number;
  sha256: string;
  notes: string[];
  commit: string;
}

export declare function parseVersion(v: unknown): [number, number, number] | null;
export declare function compareVersions(a: string, b: string): -1 | 0 | 1;
export declare function versionCode(v: string): number;
export declare function tagOf(version: string): string;
export declare function versionOfTag(tag: unknown): string | null;
export declare function newestReleaseTag(tags: string[]): string | null;
export declare function componentsOf(path: string): Parts;
export declare function packageChanged(beforeText: string | null | undefined, afterText: string | null | undefined): boolean;
export declare function changedComponents(files: string[], pkg?: Record<string, [string | null, string | null]>): Parts & { why: string[] };
export declare function parseReleaseNotes(text: unknown): { lines: string[]; problems: string[] };
export declare function planRelease(o: { target: string; server: string | null; app: string | null; changedForServer?: Parts | null; changedForApp?: Parts | null }): Plan;
export declare function inMarketHoursIST(now: number): boolean;
export declare function buildLatest(o: { version: string; date: string; size: number; sha256: string; notes: string[]; commit: string }): Latest;
export declare function istDate(now: number): string;
