/** Runs async tasks one at a time (per queue), so read-modify-write of shared storage cannot interleave. */
export function createQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn);
    tail = result.catch(() => undefined);
    return result;
  };
}
