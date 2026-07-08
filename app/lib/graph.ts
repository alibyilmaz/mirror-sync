// Connection-graph cycle check. Pairing must keep the graph acyclic:
// with no cycles, a change can only flow "downstream" and terminate, so
// infinite sync loops are topologically impossible (first line of defense;
// diff-based no-op writes are the second).

export type Edge = { sourceShopId: string; destShopId: string };

// Would adding source -> dest create a cycle? True if dest can already
// reach source through existing edges (or if it's a self-loop).
export function wouldCreateCycle(
  edges: Edge[],
  sourceShopId: string,
  destShopId: string,
): boolean {
  if (sourceShopId === destShopId) return true;
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.sourceShopId) ?? [];
    list.push(e.destShopId);
    adjacency.set(e.sourceShopId, list);
  }
  // DFS from dest: if we can reach source, the new edge closes a loop.
  const stack = [destShopId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === sourceShopId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adjacency.get(node) ?? []) stack.push(next);
  }
  return false;
}
