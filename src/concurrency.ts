/** Bound browser work while serializing fresh queue selection and input preparation. */
export function validateConcurrency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 8) {
    throw new Error('concurrency must be an integer from 1 to 8.');
  }
  return value;
}
export function concurrencyFromArgs(args: Set<string>): number {
  const arg = [...args].find(value => value.startsWith('--concurrency='));
  return validateConcurrency(arg ? Number(arg.slice(14)) : 1);
}
export async function runConcurrent<T>(jobs: AsyncIterable<T>, concurrency: number, process: (job: T) => Promise<void>) {
  validateConcurrency(concurrency);
  const active = new Set<Promise<void>>();
  let failed = false, failure: unknown;
  try {
    for await (const job of jobs) {
      if (failed) break;
      const task = Promise.resolve().then(() => process(job)).catch(error => {
        if (!failed) { failed = true; failure = error; }
      }).finally(() => { active.delete(task); });
      active.add(task);
      if (active.size >= concurrency) await Promise.race(active);
      if (failed) break;
    }
  } catch (error) { failed = true; failure = error; }
  // In-flight work must finish and persist before propagating source/setup errors.
  await Promise.all(active);
  if (failed) throw failure;
}
