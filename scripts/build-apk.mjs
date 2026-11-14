#!/usr/bin/env node
/**
 * Builds the installable app: release/TradeBuddy-<version>.apk
 *
 *   node scripts/build-apk.mjs        (npm run apk)
 *
 * 1. web app (vite) → Android project (cap sync) → unsigned release APK (gradle)
 * 2. signs it with the keys from the PRIVATE tradebuddy-keys repository (../tradebuddy-keys, or the
 *    path in TRADEBUDDY_KEYS):
 *    - Android 9+ (API 28+): the new key, plus the old key's rotation lineage (APK Signature Scheme v3),
 *      so phones that have the old-key app accept the update and keep its data, and afterwards refuse
 *      files signed with the old key alone (its rollback capability is off);
 *    - Android 7–8: the old key (v1/v2), as before.
 * 3. checks the result with apksigner.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const sdk = process.env.ANDROID_HOME || '/opt/android-sdk';
const tools = join(sdk, 'build-tools', '36.0.0');
const keys = process.env.TRADEBUDDY_KEYS || join(root, '..', 'tradebuddy-keys');
const die = (m) => {
  console.error(`build-apk: ${m}`);
  process.exit(1);
};
if (!existsSync(join(keys, 'signing.properties'))) die(`no keys at ${keys} — clone the private tradebuddy-keys repository next to this one`);

const props = Object.fromEntries(
  readFileSync(join(keys, 'signing.properties'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
for (const k of ['oldStoreFile', 'oldStorePassword', 'oldKeyAlias', 'oldKeyPassword', 'newStoreFile', 'newStorePassword', 'newKeyAlias', 'newKeyPassword'])
  if (!props[k]) die(`signing.properties is missing ${k}`);
if (!existsSync(join(keys, 'lineage.bin'))) die('lineage.bin is missing');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], ...opts });

console.log(`── building TradeBuddy ${version}`);
run('npm', ['run', 'build']);
run('npx', ['cap', 'sync', 'android']);
run('./gradlew', ['--no-daemon', '-q', 'assembleRelease'], { cwd: join(root, 'android'), env: { ...process.env, ANDROID_HOME: sdk } });

const unsigned = join(root, 'android/app/build/outputs/apk/release/app-release-unsigned.apk');
if (!existsSync(unsigned)) die(`${unsigned} not found`);
const work = join(root, 'android/app/build/outputs/apk/release/aligned.apk');
const out = join(root, 'release', `TradeBuddy-${version}.apk`);
mkdirSync(join(root, 'release'), { recursive: true });
rmSync(work, { force: true });
run(join(tools, 'zipalign'), ['-p', '-f', '4', unsigned, work]);

console.log('── signing (new key + rotation lineage; old key for Android 7–8)');
// passwords go through environment variables, never the command line or the log
const env = { ...process.env, TB_OLD_SP: props.oldStorePassword, TB_OLD_KP: props.oldKeyPassword, TB_NEW_SP: props.newStorePassword, TB_NEW_KP: props.newKeyPassword };
run(
  join(tools, 'apksigner'),
  [
    'sign',
    '--ks', join(keys, props.oldStoreFile), '--ks-key-alias', props.oldKeyAlias, '--ks-pass', 'env:TB_OLD_SP', '--key-pass', 'env:TB_OLD_KP',
    '--next-signer',
    '--ks', join(keys, props.newStoreFile), '--ks-key-alias', props.newKeyAlias, '--ks-pass', 'env:TB_NEW_SP', '--key-pass', 'env:TB_NEW_KP',
    '--lineage', join(keys, 'lineage.bin'),
    '--rotation-min-sdk-version', '28',
    '--v4-signing-enabled', 'false',
    '--out', out,
    work,
  ],
  { env },
);
rmSync(work, { force: true });

console.log('── checking');
const verify = (extra) => execFileSync(join(tools, 'apksigner'), ['verify', '--print-certs', ...extra, out], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const digest = (txt) => /Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})/.exec(txt)?.[1];
const modern = digest(verify(['--min-sdk-version', '28']));
const older = digest(verify(['--min-sdk-version', '24', '--max-sdk-version', '27']));
const lineage = execFileSync(join(tools, 'apksigner'), ['lineage', '--in', join(keys, 'lineage.bin'), '--print-certs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const certs = [...lineage.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})/g)].map((m) => m[1]);
if (certs.length !== 2) die('the lineage should hold exactly two keys');
if (modern !== certs[1]) die(`Android 9+ signer is ${modern}, expected the new key ${certs[1]}`);
if (older !== certs[0]) die(`Android 7–8 signer is ${older}, expected the old key ${certs[0]}`);
console.log(`ok: ${out}\n    Android 9+: new key ${certs[1].slice(0, 16)}… (with lineage from ${certs[0].slice(0, 16)}…)\n    Android 7–8: old key ${certs[0].slice(0, 16)}…`);
