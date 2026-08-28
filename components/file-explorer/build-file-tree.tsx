export interface FileNode {
  children?: FileNode[]
  content?: string
  expanded?: boolean
  name: string
  path: string
  type: 'file' | 'folder'
}

interface FileNodeBuilder {
  children?: Map<string, FileNodeBuilder>
  content?: string
  expanded?: boolean
  name: string
  path: string
  type: 'file' | 'folder'
}

export function buildFileTree(paths: string[]): FileNode[] {
  if (paths.length === 0) return []
  // File names are user data, not object keys: constructor/__proto__/toString
  // are ordinary names and must never resolve inherited object properties.
  const root = new Map<string, FileNodeBuilder>()

  for (const path of paths) {
    const isDirectory = path.endsWith('/')
    const parts = path.split('/').filter(Boolean)
    let current = root
    let currentPath = ''

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      currentPath += '/' + part
      const isFile = index === parts.length - 1 && !isDirectory

      let node = current.get(part)
      if (!node) {
        node = {
          name: part,
          type: isFile ? 'file' : 'folder',
          path: currentPath,
          content: isFile
            ? `// Content for ${currentPath}\n// This will be loaded when the file is selected`
            : undefined,
          children: isFile ? undefined : new Map(),
          expanded: false,
        }
        current.set(part, node)
      }

      if (!isFile) {
        // History can retain an old file entry after that path becomes a
        // folder. Keep its descendants visible regardless of arrival order;
        // never let stale metadata take down the entire workspace.
        if (!node.children) {
          node.type = 'folder'
          node.content = undefined
          node.children = new Map()
        }
        current = node.children
      }
    }
  }

  const convertToArray = (nodes: Map<string, FileNodeBuilder>): FileNode[] => {
    return Array.from(nodes.values())
      .map(
        (node): FileNode => ({
          ...node,
          children: node.children ? convertToArray(node.children) : undefined,
        })
      )
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'folder' ? -1 : 1
        }
        return a.name.localeCompare(b.name)
      })
  }

  return convertToArray(root)
}
