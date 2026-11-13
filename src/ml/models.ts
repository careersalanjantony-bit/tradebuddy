/**
 * Two small, well-understood learning methods, written out in full (no library, runs on the phone):
 *  - logistic regression: a weighted sum of the features → a chance between 0 and 1;
 *  - gradient-boosted decision trees (depth 2): many small "if this and that" rules, each fixing
 *    the mistakes of the ones before.
 * The app's chance is the average of the two (an "ensemble"), which is usually steadier than either.
 */

export interface Scaler {
  mean: number[];
  std: number[];
}

export interface LogisticModel {
  w: number[];
  b: number;
}

export interface TreeNode {
  /** split feature (-1 = leaf) */
  f: number;
  thr: number;
  /** leaf value (log-odds) */
  v: number;
  left?: TreeNode;
  right?: TreeNode;
}

export interface BoostedModel {
  base: number;
  lr: number;
  trees: TreeNode[];
}

export interface EnsembleModel {
  scaler: Scaler;
  logistic: LogisticModel;
  boosted: BoostedModel;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function fitScaler(X: number[][]): Scaler {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j]! += x[j]! / n;
  for (const x of X) for (let j = 0; j < d; j++) std[j]! += (x[j]! - mean[j]!) ** 2 / n;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]!) || 1;
  return { mean, std };
}

export const scale = (s: Scaler, x: number[]): number[] => x.map((v, j) => (v - s.mean[j]!) / s.std[j]!);

/** Full-batch gradient descent with L2 regularisation (keeps the weights small, against over-fitting). */
export function fitLogistic(X: number[][], y: number[], opts: { epochs?: number; lr?: number; l2?: number } = {}): LogisticModel {
  const epochs = opts.epochs ?? 300;
  const lr = opts.lr ?? 0.2;
  const l2 = opts.l2 ?? 0.02;
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const w = new Array<number>(d).fill(0);
  let b = 0;
  const gw = new Array<number>(d);
  for (let e = 0; e < epochs; e++) {
    gw.fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const x = X[i]!;
      let z = b;
      for (let j = 0; j < d; j++) z += w[j]! * x[j]!;
      const err = sigmoid(z) - y[i]!;
      gb += err;
      for (let j = 0; j < d; j++) gw[j]! += err * x[j]!;
    }
    for (let j = 0; j < d; j++) w[j]! -= lr * (gw[j]! / n + l2 * w[j]!);
    b -= lr * (gb / n);
  }
  return { w, b };
}

export const predictLogistic = (m: LogisticModel, x: number[]): number => sigmoid(m.b + m.w.reduce((s, w, j) => s + w * x[j]!, 0));

/** Candidate split points: quantiles of each feature (sorted, unique). */
function thresholds(X: number[][], bins: number): number[][] {
  const d = X[0]?.length ?? 0;
  const out: number[][] = [];
  for (let j = 0; j < d; j++) {
    const col = X.map((x) => x[j]!).sort((a, b) => a - b);
    const t = new Set<number>();
    for (let k = 1; k < bins; k++) t.add(col[Math.floor((k / bins) * (col.length - 1))]!);
    out.push([...t].sort((a, b) => a - b));
  }
  return out;
}

/** bin k ⇔ thr[k-1] < x ≤ thr[k]  (so "x ≤ thr[k]" ⇔ bin ≤ k) */
function binOf(thr: number[], x: number): number {
  let lo = 0;
  let hi = thr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x <= thr[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

interface Binned {
  cols: Uint8Array[];
  thr: number[][];
}

function buildTree(B: Binned, g: Float64Array, h: Float64Array, idx: Int32Array, depth: number, minLeaf: number, lambda: number): TreeNode {
  let G = 0;
  let H = 0;
  for (const i of idx) {
    G += g[i]!;
    H += h[i]!;
  }
  const leaf: TreeNode = { f: -1, thr: 0, v: -G / (H + lambda) };
  if (depth === 0 || idx.length < 2 * minLeaf) return leaf;
  const parent = (G * G) / (H + lambda);
  let best = { gain: 1e-9, f: -1, k: 0 };
  for (let f = 0; f < B.cols.length; f++) {
    const nb = B.thr[f]!.length + 1;
    const hg = new Float64Array(nb);
    const hh = new Float64Array(nb);
    const hn = new Int32Array(nb);
    const col = B.cols[f]!;
    for (const i of idx) {
      const b = col[i]!;
      hg[b]! += g[i]!;
      hh[b]! += h[i]!;
      hn[b]!++;
    }
    let gl = 0;
    let hl = 0;
    let nl = 0;
    for (let k = 0; k < nb - 1; k++) {
      gl += hg[k]!;
      hl += hh[k]!;
      nl += hn[k]!;
      const nr = idx.length - nl;
      if (nl < minLeaf || nr < minLeaf) continue;
      const gr = G - gl;
      const hr = H - hl;
      const gain = (gl * gl) / (hl + lambda) + (gr * gr) / (hr + lambda) - parent;
      if (gain > best.gain) best = { gain, f, k };
    }
  }
  if (best.f < 0) return leaf;
  const col = B.cols[best.f]!;
  const L: number[] = [];
  const R: number[] = [];
  for (const i of idx) (col[i]! <= best.k ? L : R).push(i);
  return {
    f: best.f,
    thr: B.thr[best.f]![best.k]!,
    v: 0,
    left: buildTree(B, g, h, Int32Array.from(L), depth - 1, minLeaf, lambda),
    right: buildTree(B, g, h, Int32Array.from(R), depth - 1, minLeaf, lambda),
  };
}

const treeValue = (n: TreeNode, x: number[]): number => (n.f < 0 ? n.v : treeValue(x[n.f]! <= n.thr ? n.left! : n.right!, x));

export function fitBoosted(X: number[][], y: number[], opts: { rounds?: number; lr?: number; depth?: number; minLeaf?: number; lambda?: number; bins?: number } = {}): BoostedModel {
  const rounds = opts.rounds ?? 80;
  const lr = opts.lr ?? 0.08;
  const depth = opts.depth ?? 2;
  const minLeaf = opts.minLeaf ?? Math.max(20, Math.round(X.length * 0.02));
  const lambda = opts.lambda ?? 1;
  const n = X.length;
  const pbar = Math.min(0.99, Math.max(0.01, y.reduce((a, v) => a + v, 0) / Math.max(1, n)));
  const base = Math.log(pbar / (1 - pbar));
  const thr = thresholds(X, Math.min(opts.bins ?? 16, 255));
  const B: Binned = { thr, cols: thr.map((t, f) => Uint8Array.from(X.map((x) => binOf(t, x[f]!)))) };
  const F = new Float64Array(n).fill(base);
  const all = Int32Array.from({ length: n }, (_, i) => i);
  const trees: TreeNode[] = [];
  const g = new Float64Array(n);
  const h = new Float64Array(n);
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n; i++) {
      const p = sigmoid(F[i]!);
      g[i] = p - y[i]!;
      h[i] = Math.max(1e-6, p * (1 - p));
    }
    const t = buildTree(B, g, h, all, depth, minLeaf, lambda);
    trees.push(t);
    for (let i = 0; i < n; i++) F[i]! += lr * treeValue(t, X[i]!);
  }
  return { base, lr, trees };
}

export const predictBoosted = (m: BoostedModel, x: number[]): number => sigmoid(m.trees.reduce((s, t) => s + m.lr * treeValue(t, x), m.base));

export function fitEnsemble(Xraw: number[][], y: number[]): EnsembleModel {
  const scaler = fitScaler(Xraw);
  const X = Xraw.map((x) => scale(scaler, x));
  return { scaler, logistic: fitLogistic(X, y), boosted: fitBoosted(X, y) };
}

export function predictEnsemble(m: EnsembleModel, xraw: number[]): number {
  const x = scale(m.scaler, xraw);
  return (predictLogistic(m.logistic, x) + predictBoosted(m.boosted, x)) / 2;
}

/** Area under the ROC curve: 0.5 = no better than a coin, 1 = perfect ranking. */
export function auc(p: number[], y: number[]): number | null {
  const pos = y.filter((v) => v === 1).length;
  const neg = y.length - pos;
  if (!pos || !neg) return null;
  const order = p.map((v, i) => [v, y[i]!] as const).sort((a, b) => a[0] - b[0]);
  let rank = 0;
  let sumPos = 0;
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j < order.length && order[j]![0] === order[i]![0]) j++;
    const avg = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) if (order[k]![1] === 1) sumPos += avg;
    rank = j;
    i = j;
  }
  void rank;
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}
