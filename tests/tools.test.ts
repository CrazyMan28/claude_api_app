import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_TOOLS, approvalPolicy, apiToolDefs, executeTool, toolByName, type ToolContext } from '../src/main/agent/tools'
import { resolveInProject } from '../src/main/agent/pathsafe'
import { parsePorcelain } from '../src/main/agent/git'
import { truncateMiddle } from '../src/main/agent/exec'
import { tempDir } from './helpers'

function ctx(projectDir: string, approve = true): ToolContext {
  return { projectDir, signal: new AbortController().signal, toolUseId: 't1', requestApproval: async () => approve }
}
const tool = (name: string) => toolByName(ALL_TOOLS, name)!
const WIN = process.platform === 'win32'

describe('path safety', () => {
  it('rejects paths that escape the project', async () => {
    const root = tempDir()
    await expect(resolveInProject(root, '../outside.txt')).rejects.toThrow(/outside/)
    await expect(resolveInProject(root, '/etc/passwd')).rejects.toThrow(/outside/)
    expect(await resolveInProject(root, 'src/a.ts')).toBe(join(root, 'src/a.ts'))
  })
  it('rejects symlinks that point outside', async () => {
    const root = tempDir()
    const other = tempDir()
    symlinkSync(other, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(resolveInProject(root, 'link/secret.txt')).rejects.toThrow(/outside/)
  })
})

describe('file tools', () => {
  it('reads with line numbers and paging', async () => {
    const root = tempDir()
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
    const r = await executeTool(tool('read_file'), { path: 'a.txt', offset: 2, limit: 1 }, ctx(root))
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('     2\ttwo')
    expect(r.content).not.toContain('one')
  })
  it('writes a new file and returns a diff', async () => {
    const root = tempDir()
    const r = await executeTool(tool('write_file'), { path: 'src/new.ts', content: 'export const x = 1\n' }, ctx(root))
    expect(r.isError).toBeFalsy()
    expect(readFileSync(join(root, 'src/new.ts'), 'utf8')).toBe('export const x = 1\n')
    expect(r.meta?.diff).toContain('+export const x = 1')
  })
  it('does not write when approval is denied', async () => {
    const root = tempDir()
    const r = await executeTool(tool('write_file'), { path: 'x.txt', content: 'hi' }, ctx(root, false))
    expect(r.isError).toBe(true)
    expect(existsSync(join(root, 'x.txt'))).toBe(false)
  })
  it('edits a unique string, refuses ambiguous ones, handles CRLF', async () => {
    const root = tempDir()
    writeFileSync(join(root, 'f.txt'), 'alpha\r\nbeta\r\nbeta\r\n')
    const amb = await executeTool(tool('edit_file'), { path: 'f.txt', old_string: 'beta', new_string: 'gamma' }, ctx(root))
    expect(amb.isError).toBe(true)
    expect(amb.content).toMatch(/2 times/)
    const ok = await executeTool(tool('edit_file'), { path: 'f.txt', old_string: 'alpha\nbeta', new_string: 'ALPHA\nBETA' }, ctx(root))
    expect(ok.isError).toBeFalsy()
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('ALPHA\r\nBETA\r\nbeta\r\n')
    const all = await executeTool(tool('edit_file'), { path: 'f.txt', old_string: 'beta', new_string: 'b', replace_all: true }, ctx(root))
    expect(all.isError).toBeFalsy()
    const missing = await executeTool(tool('edit_file'), { path: 'f.txt', old_string: 'zzz', new_string: 'y' }, ctx(root))
    expect(missing.content).toMatch(/not found/)
  })
  it('validates tool input against the schema', async () => {
    const root = tempDir()
    const r = await executeTool(tool('read_file'), { path: 42 }, ctx(root))
    expect(r.isError).toBe(true)
    expect(r.content).toContain('INVALID_INPUT')
  })
})

describe('search tools', () => {
  it('globs and greps, skipping node_modules', async () => {
    const root = tempDir()
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'node_modules/pkg'), { recursive: true })
    writeFileSync(join(root, 'src/a.ts'), 'const needle = 1\n')
    writeFileSync(join(root, 'src/b.js'), 'nothing here\n')
    writeFileSync(join(root, 'node_modules/pkg/i.ts'), 'needle\n')
    const g = await executeTool(tool('glob'), { pattern: '**/*.ts' }, ctx(root))
    expect(g.content.trim()).toBe('src/a.ts')
    const r = await executeTool(tool('grep'), { pattern: 'need+le' }, ctx(root))
    expect(r.content).toBe('src/a.ts:1: const needle = 1')
    const ls = await executeTool(tool('list_dir'), {}, ctx(root))
    expect(ls.content.split('\n')[0]).toBe('node_modules/')
  })
})

describe('run_command', () => {
  it('captures output and exit code', async () => {
    const root = tempDir()
    const r = await executeTool(tool('run_command'), { command: WIN ? "Write-Output hello; [Console]::Error.WriteLine('oops'); exit 3" : 'echo hello && echo oops 1>&2 && exit 3' }, ctx(root))
    expect(r.content).toContain('hello')
    expect(r.content).toContain('[stderr]\noops')
    expect(r.content).toContain('[exit code: 3]')
    expect(r.isError).toBe(true)
  })
  it('is killed on abort', async () => {
    const root = tempDir()
    const ac = new AbortController()
    const started = Date.now()
    setTimeout(() => ac.abort(), 200)
    const r = await executeTool(tool('run_command'), { command: WIN ? 'Start-Sleep -Seconds 30' : 'sleep 30' }, { ...ctx(root), signal: ac.signal })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(r.content).toContain('[stopped by user]')
  })
  it('does not run when denied', async () => {
    const root = tempDir()
    const r = await executeTool(tool('run_command'), { command: WIN ? "Set-Content made.txt 'x'" : 'touch made.txt' }, ctx(root, false))
    expect(r.isError).toBe(true)
    expect(existsSync(join(root, 'made.txt'))).toBe(false)
  })
})

describe('policy and definitions', () => {
  it('maps approval modes', () => {
    expect(approvalPolicy('ask', 'read')).toBe('allow')
    expect(approvalPolicy('ask', 'edit')).toBe('ask')
    expect(approvalPolicy('auto-edits', 'edit')).toBe('allow')
    expect(approvalPolicy('auto-edits', 'exec')).toBe('ask')
    expect(approvalPolicy('auto', 'exec')).toBe('allow')
    expect(approvalPolicy('read-only', 'edit')).toBe('deny')
  })
  it('produces JSON schemas with eager input streaming', () => {
    const defs = apiToolDefs(ALL_TOOLS)
    const edit = defs.find((d) => d.name === 'edit_file')!
    expect(edit.eager_input_streaming).toBe(true)
    expect(edit.input_schema.type).toBe('object')
    expect(edit.input_schema.required).toEqual(['path', 'old_string', 'new_string'])
    expect((edit.input_schema as Record<string, unknown>).$schema).toBeUndefined()
  })
})

describe('helpers', () => {
  it('parses git porcelain', () => {
    const p = parsePorcelain('## main...origin/main [ahead 2, behind 1]\n M src/a.ts\n?? new.txt\nR  old.ts -> renamed.ts\n')
    expect(p.branch).toBe('main')
    expect(p.ahead).toBe(2)
    expect(p.behind).toBe(1)
    expect(p.files.map((f) => f.path)).toEqual(['src/a.ts', 'new.txt', 'renamed.ts'])
    expect(parsePorcelain('## No commits yet on dev\n').branch).toBe('dev')
  })
  it('truncates the middle of long output', () => {
    const t = truncateMiddle('a'.repeat(100) + 'b'.repeat(100), 50)
    expect(t.startsWith('a'.repeat(25))).toBe(true)
    expect(t.endsWith('b'.repeat(25))).toBe(true)
  })
})
