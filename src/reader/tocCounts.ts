import type { NavItem } from '@flow/epub-engine/navigation'

// Reloading replaces the tree; expansion and label edits leave these counts valid.
const countsByToc = new WeakMap<readonly NavItem[], ReadonlyMap<NavItem, number>>()

export function getTocDescendantCounts(nodes: readonly NavItem[]): ReadonlyMap<NavItem, number> {
  const cached = countsByToc.get(nodes)
  if (cached) return cached

  const ordered = [...nodes]
  for (const node of ordered) {
    for (const child of node.subitems ?? []) ordered.push(child)
  }

  const counts = new Map<NavItem, number>()
  // Process children before parents without relying on the JavaScript call stack.
  for (const node of ordered.reverse()) {
    let total = 0
    for (const child of node.subitems ?? []) total += 1 + (counts.get(child) ?? 0)
    counts.set(node, total)
  }

  countsByToc.set(nodes, counts)
  return counts
}
