import { z } from 'zod'
import { EFFORTS } from '@shared/models'
import type { RemoteMethod } from './server'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handlers = Record<string, (...args: any[]) => unknown>

const id = z.string().min(1).max(200)
const text = z.string().max(200_000)
const dir = z.string().min(1).max(4096)
const sessionPatch = z
  .object({
    model: z.string().min(1).max(200).optional(),
    effort: z.enum(EFFORTS as [string, ...string[]]).optional(),
    projectDir: dir.nullable().optional()
  })
  .strict()

/**
 * What the phone may call. Everything else (API key, settings changes, native dialogs,
 * opening URLs, remote-access management) is only reachable from the PC itself.
 * Project folders are limited to ones already used on the PC, so a phone can never point
 * the agent or the git panels at an arbitrary path.
 */
export function remoteMethods(h: Handlers, knownProjects: () => Promise<string[]>, unpair: (deviceId: string) => Promise<void>): Record<string, RemoteMethod> {
  const known = async (d: string | null | undefined): Promise<void> => {
    if (d === null || d === undefined) return
    if (!(await knownProjects()).includes(d)) throw new Error('That folder has not been used on the PC yet. Choose it once in Forge on the PC first.')
  }
  const m = <T extends unknown[]>(args: z.ZodType<T>, run: (args: T, ctx: { deviceId: string }) => unknown): RemoteMethod => ({
    args: args as unknown as z.ZodType<unknown[]>,
    run: run as RemoteMethod['run']
  })
  const call = (channel: string) => (args: unknown[]) => h[channel]!(...args)
  return {
    'settings:get': m(z.tuple([]), async () => ({ ...((await h['settings:get']!()) as object), keyHint: null })),
    'sessions:list': m(z.tuple([]), call('sessions:list')),
    'sessions:get': m(z.tuple([id]), call('sessions:get')),
    'sessions:create': m(z.tuple([z.object({ projectDir: dir.nullable().optional() }).strict().optional()]), async ([opts]) => {
      await known(opts?.projectDir)
      return h['sessions:create']!(opts)
    }),
    'sessions:rename': m(z.tuple([id, z.string().max(500)]), call('sessions:rename')),
    'sessions:delete': m(z.tuple([id]), call('sessions:delete')),
    'sessions:update': m(z.tuple([id, sessionPatch]), async ([sid, patch]) => {
      await known(patch.projectDir)
      return h['sessions:update']!(sid, patch)
    }),
    'agent:send': m(z.tuple([id, text]), call('agent:send')),
    'agent:continue': m(z.tuple([id]), call('agent:continue')),
    'agent:stop': m(z.tuple([id]), call('agent:stop')),
    'agent:running': m(z.tuple([id]), call('agent:running')),
    'agent:runningSessions': m(z.tuple([]), call('agent:runningSessions')),
    'agent:pendingApprovals': m(z.tuple([]), call('agent:pendingApprovals')),
    'agent:approval': m(z.tuple([id, z.enum(['approve', 'deny', 'always'])]), call('agent:approval')),
    'git:status': m(z.tuple([dir]), async ([d]) => {
      await known(d)
      return h['git:status']!(d)
    }),
    'git:diff': m(z.tuple([dir, z.string().max(4096).optional(), z.boolean().optional()]), async ([d, file, staged]) => {
      await known(d)
      return h['git:diff']!(d, file, staged)
    }),
    'git:log': m(z.tuple([dir]), async ([d]) => {
      await known(d)
      return h['git:log']!(d)
    }),
    'usage:summary': m(z.tuple([]), call('usage:summary')),
    'projects:list': m(z.tuple([]), () => knownProjects()),
    'device:unpair': m(z.tuple([]), (_args, ctx) => unpair(ctx.deviceId))
  }
}
