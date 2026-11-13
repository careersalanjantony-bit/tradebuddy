// Prints the fixed extension ID and the Upstox redirect URL derived from manifest.json "key".
import { readFileSync } from 'node:fs';
import { extensionIdFromKey, redirectUrlFor } from './lib/ext-id.mjs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
if (!manifest.key) {
  console.error('manifest.json has no "key". Run: npm run gen-key');
  process.exit(1);
}
const id = extensionIdFromKey(manifest.key);
console.log(`Extension ID : ${id}`);
console.log(`Redirect URL : ${redirectUrlFor(id)}   (register this in your Upstox app)`);
