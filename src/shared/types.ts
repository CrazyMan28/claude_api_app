import type { Effort, TokenUsage } from './models'

/**
 * Persisted conversation history uses the exact block shapes the Messages API
 * returned (thinking signatures, fallback blocks, tool_use ids...) so a resumed
 * session replays append-only history the API accepts. The renderer only reads
 * the fields it renders, so it types blocks loosely here.
 */
export interface ApiBlock {
  type: string
  [key: string]: unknown
}

export interface ApiMessage {
  role: 'user' | 'assistant'
  content: string | ApiBlock[]
}

export type ApprovalMode = 'ask' | 'auto-edits' | 'auto' | 'read-only'

export interface ToolMeta {
  /** unified diff for file writes/edits */
  diff?: string
  path?: string
  status: 'ok' | 'error' | 'denied' | 'interrupted'
  durationMs?: number
  /** model + usage of a subagent run, if this tool was `task` */
  subagent?: { model: string; usage: TokenUsage; cost: number | null; steps: number }
}

export interface MessageUsageRecord {
  /** index into Session.messages of the assistant message */
  index: number
  model: string
  usage: TokenUsage
  cost: number | null
  stopReason: string | null
}

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  projectDir: string | null
  model: string
  effort: Effort
  messages: ApiMessage[]
  toolMeta: Record<string, ToolMeta>
  usage: MessageUsageRecord[]
  /** last run outcome, used to offer "Continue" */
  lastStop?: RunEndStatus
}

export interface SessionSummary {
  id: string
  title: string
  updatedAt: number
  projectDir: string | null
  model: string
  messageCount: number
  cost: number
}

export interface Settings {
  defaultModel: string
  defaultEffort: Effort
  approvalMode: ApprovalMode
  /** use `fallbacks: "default"` on models that support it */
  refusalFallback: boolean
  subagentModel: string
  subagentEffort: Effort
  maxStepsPerRun: number
  /** 0 = no limit (USD, estimated) */
  limitPerSession: number
  limitDaily: number
  limitMonthly: number
  lastProjectDir: string | null
  /** phone access over Tailscale; off until the user turns it on */
  remote: RemoteSettings
}

export interface RemoteSettings {
  enabled: boolean
  port: number
}

export interface RemoteDevice {
  id: string
  name: string
  createdAt: number
  lastSeen: number | null
  online: boolean
}

export interface RemoteStatus {
  enabled: boolean
  listening: boolean
  /** this PC's Tailscale address, if Tailscale is up */
  address: string | null
  /** MagicDNS name, e.g. my-pc.tailnet-1234.ts.net */
  dnsName: string | null
  port: number
  error: string | null
  devices: RemoteDevice[]
}

export interface PairingOffer {
  /** forge://pair?... link encoded in the QR code */
  link: string
  /** QR code as an SVG data URL */
  qr: string
  expiresAt: number
}

/** Present only in the Android app: the connection to the paired PC. */
export interface MobileBridge {
  host: string
  unpair(): Promise<void>
  onConnection(cb: (online: boolean) => void): () => void
}

export interface PublicSettings extends Settings {
  hasApiKey: boolean
  keyHint: string | null
  encryptionAvailable: boolean
}

export interface UsageSummary {
  today: { cost: number; usage: TokenUsage; requests: number }
  month: { cost: number; usage: TokenUsage; requests: number }
  allTime: { cost: number; usage: TokenUsage; requests: number }
  byModel: { model: string; cost: number; requests: number; usage: TokenUsage }[]
  unpricedRequests: number
}

export type RunEndStatus = 'completed' | 'stopped' | 'error' | 'max_tokens' | 'refusal' | 'limit' | 'max_steps'

export interface ApprovalRequest {
  requestId: string
  sessionId: string
  toolUseId: string
  tool: string
  summary: string
  input: Record<string, unknown>
  diff?: string
}

export type ApprovalDecision = 'approve' | 'deny' | 'always'

/** Events streamed from the main process for one session. */
export type AgentEvent =
  | { type: 'run_start' }
  | { type: 'stream_start'; model: string; parentToolUseId?: string }
  | { type: 'block_start'; index: number; blockType: string; name?: string; id?: string; parentToolUseId?: string }
  | { type: 'text_delta'; index: number; text: string; parentToolUseId?: string }
  | { type: 'thinking_delta'; index: number; text: string; parentToolUseId?: string }
  | { type: 'input_delta'; index: number; partial: string; parentToolUseId?: string }
  | { type: 'stream_end'; parentToolUseId?: string }
  | { type: 'messages_appended'; messages: ApiMessage[]; usage?: MessageUsageRecord }
  | { type: 'tool_running'; toolUseId: string; name: string }
  | { type: 'tool_meta'; toolUseId: string; meta: ToolMeta }
  | { type: 'subagent_progress'; parentToolUseId: string; text: string }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval_resolved'; requestId: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'run_end'; status: RunEndStatus; error?: string }

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  files: { path: string; index: string; worktree: string }[]
  error?: string
}

export interface GitCommit {
  hash: string
  subject: string
  author: string
  date: string
}

export interface ApiKeyTestResult {
  ok: boolean
  message: string
  models?: string[]
}

export interface ForgeApi {
  getSettings(): Promise<PublicSettings>
  updateSettings(patch: Partial<Settings>): Promise<PublicSettings>
  setApiKey(key: string): Promise<PublicSettings>
  clearApiKey(): Promise<PublicSettings>
  testApiKey(): Promise<ApiKeyTestResult>
  listSessions(): Promise<SessionSummary[]>
  getSession(id: string): Promise<Session | null>
  createSession(opts?: { projectDir?: string | null }): Promise<Session>
  renameSession(id: string, title: string): Promise<void>
  deleteSession(id: string): Promise<void>
  updateSession(id: string, patch: Partial<Pick<Session, 'model' | 'effort' | 'projectDir'>>): Promise<Session | null>
  send(sessionId: string, text: string): Promise<void>
  continueRun(sessionId: string): Promise<void>
  stop(sessionId: string): Promise<void>
  isRunning(sessionId: string): Promise<boolean>
  respondApproval(requestId: string, decision: ApprovalDecision): Promise<void>
  pickDirectory(): Promise<string | null>
  gitStatus(dir: string): Promise<GitStatus>
  gitDiff(dir: string, file?: string, staged?: boolean): Promise<string>
  gitLog(dir: string): Promise<GitCommit[]>
  usageSummary(): Promise<UsageSummary>
  openExternal(url: string): Promise<void>
  /** project folders already used by a session (what the phone may choose from) */
  listProjects(): Promise<string[]>
  runningSessions(): Promise<string[]>
  pendingApprovals(): Promise<ApprovalRequest[]>
  remoteStatus(): Promise<RemoteStatus>
  remoteStartPairing(): Promise<PairingOffer>
  remoteRevoke(deviceId: string): Promise<RemoteStatus>
  onAgentEvent(cb: (sessionId: string, ev: AgentEvent) => void): () => void
  /** a session was created, renamed or deleted (possibly from another device) */
  onSessionsChanged(cb: () => void): () => void
  platform: string
  mobile?: MobileBridge
}
