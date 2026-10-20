import { isAbsolute, relative, resolve, dirname, sep } from 'node:path'
import { promises as fs } from 'node:fs'

/** Nearest existing ancestor's real path (follows symlinks/junctions). */
async function realExisting(p: string): Promise<string> {
  let cur = p
  const tail: string[] = []
  for (;;) {
    try {
      const real = await fs.realpath(cur)
      return tail.length ? resolve(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return p
      tail.push(cur.slice(parent.length).replace(/^[\\/]+/, ''))
      cur = parent
    }
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Resolve a model-supplied path against the project root and refuse anything
 * that escapes it, including via `..`, another drive, or a symlink/junction.
 */
export async function resolveInProject(projectDir: string, p: string | undefined): Promise<string> {
  const root = resolve(projectDir)
  const target = resolve(root, p && p.trim() ? p.trim() : '.')
  if (!inside(root, target)) throw new Error(`Path is outside the project directory: ${p}`)
  const realRoot = await realExisting(root)
  const realTarget = await realExisting(target)
  if (!inside(realRoot, realTarget)) throw new Error(`Path resolves outside the project directory: ${p}`)
  return target
}

export function displayPath(projectDir: string, abs: string): string {
  const rel = relative(resolve(projectDir), abs)
  return (rel || '.').split(sep).join('/')
}
