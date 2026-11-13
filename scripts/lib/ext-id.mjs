// Derives a Chrome extension ID from the manifest "key" (base64 SubjectPublicKeyInfo DER).
// Chrome takes SHA-256 of the DER, keeps the first 16 bytes, and maps each hex digit 0-f to a-p.
import { createHash } from 'node:crypto';

export function extensionIdFromKey(base64Key) {
  const der = Buffer.from(base64Key, 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

export function redirectUrlFor(id, path = 'upstox') {
  return `https://${id}.chromiumapp.org/${path}`;
}
