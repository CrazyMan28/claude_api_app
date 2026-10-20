import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { glob } from 'tinyglobby'
import { createTwoFilesPatch } from 'diff'
import type Anthropic from '@anthropic-ai/sdk'
import type { ApprovalMode, ToolMeta } from '@shared/types'
import { displayPath, resolveInProject } from './pathsafe'
import { runProcess, shellFor, shellName, truncateMiddle } from './exec'
import { git } from './git'

export type ToolKind = 'read' | 'edit' | 'exec' | 'agent'

export interface ToolOutput {
  content: string
  isError?: boolean
  meta?: Partial<ToolMeta>
}

export interface ApprovalAsk {
  summary: string
  diff?: string
}

export interface ToolContext {
  projectDir: string
  signal: AbortSignal
  toolUseId: string
  /** Resolves true when the user (or the approval mode) allows the action. */
  requestApproval(ask: ApprovalAsk): Promise<boolean>
  runSubagent?(prompt: string, description: string): Promise<ToolOutput>
}

interface ToolDef<S extends z.ZodType> {
  name: string
  kind: ToolKind
  description: string
  schema: S
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>
}

const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**', '**/.next/**', '**/__pycache__/**', '**/.venv/**']
const MAX_READ_CHARS = 250_000

function defineTool<S extends z.ZodType>(d: ToolDef<S>): ToolDef<S> {
  return d
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

async function readTextFile(abs: string): Promise<string> {
  const buf = await fs.readFile(abs)
  if (isBinary(buf)) throw new Error('File appears to be binary; refusing to read it as text.')
  return buf.toString('utf8')
}

function makeDiff(path: string, before: string, after: string): string {
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3 })
}

const readFile = defineTool({
  name: 'read_file',
  kind: 'read',
  description:
    'Read a text file from the project. Returns lines prefixed with line numbers (1-based). Use offset/limit for large files.',
  schema: z
    .object({
      path: z.string().describe('File path, relative to the project root'),
      offset: z.number().int().min(1).optional().describe('First line to return (1-based)'),
      limit: z.number().int().min(1).max(5000).optional().describe('Maximum number of lines (default 2000)')
    })
    .strict(),
  async run(input, ctx) {
    const abs = await resolveInProject(ctx.projectDir, input.path)
    const text = await readTextFile(abs)
    const lines = text.split(/\r?\n/)
    const start = (input.offset ?? 1) - 1
    const slice = lines.slice(start, start + (input.limit ?? 2000))
    let out = slice.map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`).join('\n')
    if (out.length > MAX_READ_CHARS) out = out.slice(0, MAX_READ_CHARS) + '\n… [truncated; use offset/limit]'
    const more = start + slice.length < lines.length ? `\n\n(${lines.length} lines total; showing ${start + 1}-${start + slice.length})` : ''
    return { content: (out || '(empty file)') + more, meta: { path: displayPath(ctx.projectDir, abs) } }
  }
})

const writeFile = defineTool({
  name: 'write_file',
  kind: 'edit',
  description:
    'Create a new file or completely overwrite an existing one with the given content. Prefer edit_file for changes to existing files.',
  schema: z
    .object({
      path: z.string().describe('File path, relative to the project root'),
      content: z.string().describe('The complete new file content')
    })
    .strict(),
  async run(input, ctx) {
    const abs = await resolveInProject(ctx.projectDir, input.path)
    const rel = displayPath(ctx.projectDir, abs)
    let before = ''
    let existed = true
    try {
      before = await readTextFile(abs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') existed = false
      else throw err
    }
    const diff = makeDiff(rel, before, input.content)
    const ok = await ctx.requestApproval({ summary: `${existed ? 'Overwrite' : 'Create'} ${rel}`, diff })
    if (!ok) return { content: 'The user denied this file write.', isError: true, meta: { status: 'denied', path: rel, diff } }
    await fs.mkdir(dirname(abs), { recursive: true })
    await fs.writeFile(abs, input.content, 'utf8')
    const lines = input.content.split('\n').length
    return { content: `${existed ? 'Overwrote' : 'Created'} ${rel} (${lines} lines).`, meta: { path: rel, diff } }
  }
})

const editFile = defineTool({
  name: 'edit_file',
  kind: 'edit',
  description:
    'Replace an exact string in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first.',
  schema: z
    .object({
      path: z.string().describe('File path, relative to the project root'),
      old_string: z.string().min(1).describe('Exact text to replace'),
      new_string: z.string().describe('Replacement text'),
      replace_all: z.boolean().optional().describe('Replace every occurrence (default false)')
    })
    .strict(),
  async run(input, ctx) {
    const abs = await resolveInProject(ctx.projectDir, input.path)
    const rel = displayPath(ctx.projectDir, abs)
    const before = await readTextFile(abs)
    let oldS = input.old_string
    let newS = input.new_string
    // Windows files are often CRLF while the model writes LF.
    if (!before.includes(oldS) && before.includes('\r\n') && !oldS.includes('\r\n')) {
      const crlf = oldS.replace(/\n/g, '\r\n')
      if (before.includes(crlf)) {
        oldS = crlf
        newS = newS.replace(/\r?\n/g, '\r\n')
      }
    }
    const count = before.split(oldS).length - 1
    if (count === 0) {
      return { content: `old_string was not found in ${rel}. Read the file again and copy the text exactly.`, isError: true }
    }
    if (count > 1 && !input.replace_all) {
      return {
        content: `old_string occurs ${count} times in ${rel}. Add surrounding context to make it unique, or set replace_all.`,
        isError: true
      }
    }
    const after = input.replace_all ? before.split(oldS).join(newS) : before.replace(oldS, () => newS)
    const diff = makeDiff(rel, before, after)
    const ok = await ctx.requestApproval({ summary: `Edit ${rel}`, diff })
    if (!ok) return { content: 'The user denied this edit.', isError: true, meta: { status: 'denied', path: rel, diff } }
    await fs.writeFile(abs, after, 'utf8')
    return { content: `Edited ${rel} (${input.replace_all ? count : 1} replacement${count > 1 && input.replace_all ? 's' : ''}).`, meta: { path: rel, diff } }
  }
})

const listDir = defineTool({
  name: 'list_dir',
  kind: 'read',
  description: 'List the entries of a directory in the project (directories end with "/").',
  schema: z.object({ path: z.string().optional().describe('Directory, relative to the project root (default ".")') }).strict(),
  async run(input, ctx) {
    const abs = await resolveInProject(ctx.projectDir, input.path ?? '.')
    const entries = await fs.readdir(abs, { withFileTypes: true })
    const rows = entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 1000)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    return { content: rows.length ? rows.join('\n') : '(empty directory)' }
  }
})

const globTool = defineTool({
  name: 'glob',
  kind: 'read',
  description: 'Find files by glob pattern (e.g. "src/**/*.ts"). Ignores node_modules, .git and build output.',
  schema: z
    .object({
      pattern: z.string().min(1).describe('Glob pattern relative to the search directory'),
      path: z.string().optional().describe('Directory to search from (default project root)')
    })
    .strict(),
  async run(input, ctx) {
    const abs = await resolveInProject(ctx.projectDir, input.path ?? '.')
    const files = await glob(input.pattern, { cwd: abs, ignore: IGNORE, dot: true, onlyFiles: true })
    files.sort()
    const shown = files.slice(0, 500)
    const note = files.length > shown.length ? `\n… and ${files.length - shown.length} more` : ''
    return { content: shown.length ? shown.join('\n') + note : 'No files matched.' }
  }
})

const grepTool = defineTool({
  name: 'grep',
  kind: 'read',
  description:
    'Search file contents with a JavaScript regular expression. Returns "path:line: text" matches. Use include to restrict files (glob).',
  schema: z
    .object({
      pattern: z.string().min(1).describe('Regular expression'),
      path: z.string().optional().describe('Directory to search (default project root)'),
      include: z.string().optional().describe('Glob of files to search, e.g. "**/*.ts" (default all files)'),
      case_insensitive: z.boolean().optional(),
      files_only: z.boolean().optional().describe('Only list matching file paths')
    })
    .strict(),
  async run(input, ctx) {
    const abs = await resolveInProject(ctx.projectDir, input.path ?? '.')
    let re: RegExp
    try {
      re = new RegExp(input.pattern, input.case_insensitive ? 'i' : '')
    } catch (err) {
      return { content: `Invalid regular expression: ${(err as Error).message}`, isError: true }
    }
    const files = await glob(input.include ?? '**/*', { cwd: abs, ignore: IGNORE, dot: true, onlyFiles: true })
    files.sort()
    const out: string[] = []
    const MAX = 300
    for (const f of files) {
      if (ctx.signal.aborted) break
      if (out.length >= MAX) break
      const full = `${abs}/${f}`
      let buf: Buffer
      try {
        const st = await fs.stat(full)
        if (st.size > 2_000_000) continue
        buf = await fs.readFile(full)
      } catch {
        continue
      }
      if (isBinary(buf)) continue
      const lines = buf.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i] ?? '')) {
          if (input.files_only) {
            out.push(f)
            break
          }
          out.push(`${f}:${i + 1}: ${(lines[i] ?? '').slice(0, 300)}`)
          if (out.length >= MAX) break
        }
      }
    }
    if (!out.length) return { content: 'No matches.' }
    return { content: out.join('\n') + (out.length >= MAX ? `\n… (stopped at ${MAX} results; narrow the search)` : '') }
  }
})

const runCommand = defineTool({
  name: 'run_command',
  kind: 'exec',
  get description() {
    return `Run a shell command in the project directory using ${shellName()}. Use for builds, tests, package managers and git. Commands are non-interactive; stdout and stderr are returned.`
  },
  schema: z
    .object({
      command: z.string().min(1).describe('The command line to run'),
      timeout_seconds: z.number().int().min(1).max(1800).optional().describe('Timeout in seconds (default 120)'),
      cwd: z.string().optional().describe('Working directory relative to the project root (default root)')
    })
    .strict(),
  async run(input, ctx) {
    const cwd = await resolveInProject(ctx.projectDir, input.cwd ?? '.')
    const ok = await ctx.requestApproval({ summary: input.command })
    if (!ok) return { content: 'The user denied running this command.', isError: true, meta: { status: 'denied' } }
    const sh = shellFor(input.command)
    const r = await runProcess(sh.file, sh.args, { cwd, timeoutMs: (input.timeout_seconds ?? 120) * 1000, signal: ctx.signal })
    const parts: string[] = []
    if (r.stdout.trim()) parts.push(r.stdout.trimEnd())
    if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`)
    if (r.timedOut) parts.push(`[timed out after ${input.timeout_seconds ?? 120}s]`)
    if (r.aborted) parts.push('[stopped by user]')
    parts.push(`[exit code: ${r.exitCode ?? 'none'}]`)
    return { content: truncateMiddle(parts.join('\n\n')), isError: r.exitCode !== 0 }
  }
})

const gitStatusTool = defineTool({
  name: 'git_status',
  kind: 'read',
  description: 'Show the git branch and working tree status of the project.',
  schema: z.object({}).strict(),
  async run(_input, ctx) {
    const r = await git(ctx.projectDir, ['status', '--short', '--branch'], ctx.signal)
    return r.ok ? { content: r.out.trim() || 'Clean working tree.' } : { content: r.err || 'Not a git repository.', isError: true }
  }
})

const gitDiffTool = defineTool({
  name: 'git_diff',
  kind: 'read',
  description: 'Show uncommitted changes (git diff). Set staged to see the index, path to limit to one file.',
  schema: z.object({ staged: z.boolean().optional(), path: z.string().optional() }).strict(),
  async run(input, ctx) {
    const args = ['diff', '--no-ext-diff', '--stat', '--patch']
    if (input.staged) args.push('--cached')
    if (input.path) args.push('--', (await resolveInProject(ctx.projectDir, input.path)))
    const r = await git(ctx.projectDir, args, ctx.signal)
    return r.ok ? { content: truncateMiddle(r.out.trim() || 'No changes.') } : { content: r.err, isError: true }
  }
})

const gitLogTool = defineTool({
  name: 'git_log',
  kind: 'read',
  description: 'Show recent commits (one line each).',
  schema: z.object({ count: z.number().int().min(1).max(200).optional() }).strict(),
  async run(input, ctx) {
    const r = await git(ctx.projectDir, ['log', `-n${input.count ?? 20}`, '--oneline', '--decorate'], ctx.signal)
    return r.ok ? { content: r.out.trim() || 'No commits yet.' } : { content: r.err, isError: true }
  }
})

const taskTool = defineTool({
  name: 'task',
  kind: 'agent',
  description:
    'Delegate a self-contained research task to a subagent that has read-only tools (read_file, list_dir, glob, grep, git_status, git_diff, git_log). Use it for broad codebase exploration so your own context stays small. The subagent cannot edit files or run commands. Give it a complete, standalone prompt; it returns a written report.',
  schema: z
    .object({
      description: z.string().min(1).max(120).describe('Short (3-8 word) label for the task'),
      prompt: z.string().min(1).describe('Full instructions for the subagent')
    })
    .strict(),
  async run(input, ctx) {
    if (!ctx.runSubagent) return { content: 'Subagents are not available here.', isError: true }
    return ctx.runSubagent(input.prompt, input.description)
  }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDef<any>

export const ALL_TOOLS: AnyTool[] = [readFile, writeFile, editFile, listDir, globTool, grepTool, runCommand, gitStatusTool, gitDiffTool, gitLogTool, taskTool]
export const SUBAGENT_TOOLS: AnyTool[] = ALL_TOOLS.filter((t) => t.kind === 'read')

export function toolByName(tools: AnyTool[], name: string): AnyTool | undefined {
  return tools.find((t) => t.name === name)
}

/** API tool definitions; eager_input_streaming because every request is streamed. */
export function apiToolDefs(tools: AnyTool[]): Anthropic.Beta.BetaTool[] {
  return tools.map((t) => {
    const schema = z.toJSONSchema(t.schema) as Record<string, unknown>
    delete schema.$schema
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Beta.BetaTool['input_schema'],
      eager_input_streaming: true
    }
  })
}

/** Decide whether a tool call needs a prompt, runs automatically, or is refused. */
export function approvalPolicy(mode: ApprovalMode, kind: ToolKind): 'allow' | 'ask' | 'deny' {
  if (kind === 'read' || kind === 'agent') return 'allow'
  switch (mode) {
    case 'auto':
      return 'allow'
    case 'auto-edits':
      return kind === 'edit' ? 'allow' : 'ask'
    case 'read-only':
      return 'deny'
    default:
      return 'ask'
  }
}

/** Validate model input against the tool's schema before running (eager streaming skips server validation). */
export async function executeTool(tool: AnyTool, rawInput: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = tool.schema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      content: JSON.stringify({ INVALID_INPUT: parsed.error.issues.map((i: z.core.$ZodIssue) => `${i.path.join('.')}: ${i.message}`), received: rawInput }),
      isError: true
    }
  }
  try {
    return await tool.run(parsed.data, ctx)
  } catch (err) {
    return { content: `Error: ${(err as Error).message}`, isError: true }
  }
}
