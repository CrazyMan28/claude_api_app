import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, ForgeApi } from '../shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: ForgeApi = {
  getSettings: () => invoke('settings:get'),
  updateSettings: (patch) => invoke('settings:update', patch),
  setApiKey: (key) => invoke('apikey:set', key),
  clearApiKey: () => invoke('apikey:clear'),
  testApiKey: () => invoke('apikey:test'),
  listSessions: () => invoke('sessions:list'),
  getSession: (id) => invoke('sessions:get', id),
  createSession: (opts) => invoke('sessions:create', opts),
  renameSession: (id, title) => invoke('sessions:rename', id, title),
  deleteSession: (id) => invoke('sessions:delete', id),
  updateSession: (id, patch) => invoke('sessions:update', id, patch),
  send: (id, text) => invoke('agent:send', id, text),
  continueRun: (id) => invoke('agent:continue', id),
  stop: (id) => invoke('agent:stop', id),
  isRunning: (id) => invoke('agent:running', id),
  respondApproval: (requestId, decision) => invoke('agent:approval', requestId, decision),
  pickDirectory: () => invoke('dialog:pickDirectory'),
  gitStatus: (dir) => invoke('git:status', dir),
  gitDiff: (dir, file, staged) => invoke('git:diff', dir, file, staged),
  gitLog: (dir) => invoke('git:log', dir),
  usageSummary: () => invoke('usage:summary'),
  openExternal: (url) => invoke('shell:openExternal', url),
  listProjects: () => invoke('projects:list'),
  runningSessions: () => invoke('agent:runningSessions'),
  pendingApprovals: () => invoke('agent:pendingApprovals'),
  remoteStatus: () => invoke('remote:status'),
  remoteStartPairing: () => invoke('remote:startPairing'),
  remoteRevoke: (id) => invoke('remote:revoke', id),
  onAgentEvent: (cb) => {
    const listener = (_e: unknown, sessionId: string, ev: AgentEvent): void => cb(sessionId, ev)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
  onSessionsChanged: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('sessions:changed', listener)
    return () => ipcRenderer.removeListener('sessions:changed', listener)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('forge', api)
