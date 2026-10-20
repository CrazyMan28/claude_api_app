import type { ReactNode } from 'react'
import { Bot, FileCode2, FilePen, FilePlus2, FolderTree, GitBranch, GitCompare, History, Search, SearchCode, SquareTerminal, Wrench } from 'lucide-react'
import { str } from '../lib'

export type ToolCategory = 'read' | 'edit' | 'exec' | 'git' | 'agent'

export interface ToolDisplay {
  icon: ReactNode
  category: ToolCategory
  label: string
  title: ReactNode
}

/** How each tool call is presented in the chat (e.g. "Read src/app.ts", "Run `npm test`"). */
export function toolDisplay(name: string, input: Record<string, unknown>): ToolDisplay {
  const s = 14
  const path = str(input.path)
  switch (name) {
    case 'read_file':
      return { icon: <FileCode2 size={s} />, category: 'read', label: 'Read', title: <>Read <code>{path}</code></> }
    case 'write_file':
      return { icon: <FilePlus2 size={s} />, category: 'edit', label: 'Write', title: <>Write <code>{path}</code></> }
    case 'edit_file':
      return { icon: <FilePen size={s} />, category: 'edit', label: 'Edit', title: <>Edit <code>{path}</code></> }
    case 'list_dir':
      return { icon: <FolderTree size={s} />, category: 'read', label: 'List', title: <>List <code>{path || '.'}</code></> }
    case 'glob':
      return { icon: <Search size={s} />, category: 'read', label: 'Glob', title: <>Find <code>{str(input.pattern)}</code></> }
    case 'grep':
      return { icon: <SearchCode size={s} />, category: 'read', label: 'Grep', title: <>Search <code>{str(input.pattern)}</code>{input.include ? <> in <code>{str(input.include)}</code></> : null}</> }
    case 'run_command':
      return { icon: <SquareTerminal size={s} />, category: 'exec', label: 'Bash', title: <code>{str(input.command)}</code> }
    case 'git_status':
      return { icon: <GitBranch size={s} />, category: 'git', label: 'Git', title: <>git status</> }
    case 'git_diff':
      return { icon: <GitCompare size={s} />, category: 'git', label: 'Git', title: <>git diff{input.staged ? ' --staged' : ''}{input.path ? <> <code>{str(input.path)}</code></> : null}</> }
    case 'git_log':
      return { icon: <History size={s} />, category: 'git', label: 'Git', title: <>git log</> }
    case 'task':
      return { icon: <Bot size={s} />, category: 'agent', label: 'Subagent', title: <>Subagent: {str(input.description) || 'task'}</> }
    default:
      return { icon: <Wrench size={s} />, category: 'read', label: name, title: name }
  }
}
