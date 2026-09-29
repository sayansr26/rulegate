import { compareCodepoint } from './order.js';

/** A tool that must be reached, and the folders it would read the thing from, preferred first. */
export interface CoverTarget {
  readonly id: string;
  readonly dirs: readonly string[];
}

/**
 * The fewest directories that reach every target, greedily: at each step the directory read
 * by the most uncovered targets, then the one they rank highest in their own preference
 * order, then codepoint order. Greedy is not always minimal in general set cover, but here
 * the sets are small and nested enough that it is, and it is deterministic, which matters
 * more than optimality: the same repository must render the same directories everywhere.
 */
export function cover(targets: readonly CoverTarget[]): string[] {
  const uncovered = new Set(targets.map((t) => t.id));
  const chosen: string[] = [];
  while (uncovered.size > 0) {
    const pending = targets.filter((t) => uncovered.has(t.id));
    const candidates = [...new Set(pending.flatMap((t) => t.dirs))].sort(compareCodepoint);
    let best: { dir: string; count: number; rank: number } | undefined;
    for (const dir of candidates) {
      const readers = pending.filter((t) => t.dirs.includes(dir));
      const rank = readers.reduce((sum, t) => sum + t.dirs.indexOf(dir), 0);
      if (
        best === undefined ||
        readers.length > best.count ||
        (readers.length === best.count && rank < best.rank)
      ) {
        best = { dir, count: readers.length, rank };
      }
    }
    chosen.push(best!.dir);
    for (const t of pending) if (t.dirs.includes(best!.dir)) uncovered.delete(t.id);
  }
  return chosen.sort(compareCodepoint);
}
