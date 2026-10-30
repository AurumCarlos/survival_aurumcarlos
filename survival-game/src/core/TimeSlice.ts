/**
 * Runs `fn` over `items` on the main thread without blocking it: whenever a
 * slice has used `budgetMs`, it yields to the browser (rAF, or a macrotask
 * in hidden tabs where rAF is suspended) before continuing.
 *
 * For work that must happen on the main thread because it touches main-thread
 * objects (Cannon bodies, Three meshes) and so can't go to the worker.
 */
export async function timeSliced<T>(
  items: readonly T[],
  fn: (item: T, index: number) => void,
  opts: { budgetMs?: number; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<void> {
  const budget = opts.budgetMs ?? 6;
  let sliceStart = performance.now();
  for (let i = 0; i < items.length; i++) {
    fn(items[i]!, i);
    if (performance.now() - sliceStart > budget) {
      opts.onProgress?.((i + 1) / items.length);
      await yieldToBrowser();
      if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      sliceStart = performance.now();
    }
  }
  opts.onProgress?.(1);
}

export function yieldToBrowser(): Promise<void> {
  return new Promise((r) => {
    if (typeof document !== 'undefined' && !document.hidden && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => r());
    } else {
      setTimeout(r, 0);
    }
  });
}
