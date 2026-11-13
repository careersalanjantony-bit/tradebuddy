// Generates a new RSA key pair and writes the public key into manifest.json "key".
// The key pins the extension ID, and therefore the Upstox OAuth redirect URL.
// WARNING: running this again (with --force) changes the ID, and you must update
// the redirect URL in your Upstox app.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extensionIdFromKey, redirectUrlFor } from './lib/ext-id.mjs';

const manifestUrl = new URL('../manifest.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
const force = process.argv.includes('--force');

if (manifest.key && !force) {
  console.error('manifest.json already has a "key". Changing it changes the extension ID and the');
  console.error('Upstox redirect URL. Re-run with --force only if you really want a new ID.');
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubDer = publicKey.export({ type: 'spki', format: 'der' });
manifest.key = Buffer.from(pubDer).toString('base64');
writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');

// The private key is only needed to pack a .crx. It is git-ignored; keep it somewhere safe.
const keysDir = new URL('../keys/', import.meta.url);
if (!existsSync(keysDir)) mkdirSync(keysDir);
writeFileSync(new URL('extension-private.pem', keysDir), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

const id = extensionIdFromKey(manifest.key);
console.log('Wrote public key to manifest.json and private key to keys/extension-private.pem');
console.log(`Extension ID : ${id}`);
console.log(`Redirect URL : ${redirectUrlFor(id)}`);
