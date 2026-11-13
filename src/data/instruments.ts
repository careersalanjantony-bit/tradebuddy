import { createLogger } from '../lib/log';
import { getDb } from '../storage/db';
import { INSTRUMENTS_URL, parseInstruments, type Instrument } from './instrumentsParse';
import { appFetch } from '../platform/http';

const log = createLogger('instruments');

/** Downloads NSE.json.gz (public file, no token needed) and replaces the stored list. */
export async function refreshInstruments(): Promise<number> {
  const res = await appFetch(INSTRUMENTS_URL, { timeoutMs: 60_000 });
  if (!res.ok) throw new Error(`Instruments download failed: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let text: string;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(buf); // already decompressed by the network layer
  }
  const list = parseInstruments(JSON.parse(text));
  if (list.length < 1000) throw new Error(`Instruments file looks incomplete (${list.length} NSE equities)`);
  const db = await getDb();
  const tx = db.transaction('instruments', 'readwrite');
  await tx.store.clear();
  for (const i of list) void tx.store.put(i);
  await tx.done;
  log.info(`Instruments updated: ${list.length} NSE equities and indices`);
  return list.length;
}

export async function getInstrument(key: string): Promise<Instrument | undefined> {
  return (await getDb()).get('instruments', key);
}

export async function getAllInstruments(): Promise<Instrument[]> {
  return (await getDb()).getAll('instruments');
}

export async function countInstruments(): Promise<number> {
  return (await getDb()).count('instruments');
}

export async function findBySymbol(symbol: string): Promise<Instrument | undefined> {
  const all = await (await getDb()).getAllFromIndex('instruments', 'by_symbol', symbol);
  return all.find((i) => i.instrument_type === 'EQ') ?? all[0];
}
