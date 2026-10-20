import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Write a file atomically (temp file + rename) so a crash never leaves half a session. */
export async function writeFileAtomic(path: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, data)
  try {
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}
