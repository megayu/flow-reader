export interface INode {
  id: string
  depth?: number
  expanded?: boolean
  subitems?: INode[]
}

export function find<T extends INode>(nodes: T[] = [], id: string): T | undefined {
  if (!id) return

  const node = nodes.find((n) => n.id === id)
  if (node) return node
  for (const child of nodes) {
    const node = find(child.subitems, id)
    if (node) return node as T
  }
  return undefined
}

export function dfs<T extends INode>(node: T, fn: (node: T) => void) {
  fn(node)
  node.subitems?.forEach((child) => dfs(child as T, fn))
}
