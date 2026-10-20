import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

export interface ExecResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}

const MAX_CAPTURE = 2_000_000

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

let winShell: string | null = null

/** On Windows prefer PowerShell 7 (`pwsh`, supports && and ||); fall back to Windows PowerShell 5.1. */
export function windowsShell(): string {
  if (winShell === null) {
    const r = spawnSync('where.exe', ['pwsh.exe'], { windowsHide: true, encoding: 'utf8' })
    winShell = r.status === 0 && r.stdout.trim() ? 'pwsh.exe' : 'powershell.exe'
  }
  return winShell
}

/** Human-readable name of the shell `run_command` uses, for the tool description and system prompt. */
export function shellName(): string {
  if (process.platform !== 'win32') return 'bash'
  return windowsShell() === 'pwsh.exe' ? 'PowerShell 7 (pwsh)' : 'Windows PowerShell 5.1 (no && or || operators; chain with ";" and check $LASTEXITCODE)'
}

/** Shell used for `run_command`: PowerShell on Windows, bash elsewhere. */
export function shellFor(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const prelude = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference="SilentlyContinue"; '
    return {
      file: windowsShell(),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prelude + command]
    }
  }
  return { file: '/bin/bash', args: ['-c', command] }
}

export function runProcess(
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolvePromise({ exitCode, stdout, stderr, timedOut, aborted })
    }
    const onAbort = (): void => {
      aborted = true
      killTree(child)
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, opts.timeoutMs)
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      if (stdout.length < MAX_CAPTURE) stdout += d
    })
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < MAX_CAPTURE) stderr += d
    })
    child.on('error', (err) => {
      stderr += `\n${err.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

/** Keep the head and tail of long output so the model sees both the start and the error at the end. */
export function truncateMiddle(text: string, max = 30_000): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n\n… [${text.length - max} characters truncated] …\n\n${text.slice(-half)}`
}
