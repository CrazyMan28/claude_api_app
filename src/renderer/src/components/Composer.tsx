import { useEffect, useRef, useState } from 'react'
import { ArrowUp, CornerDownLeft, Play, Square } from 'lucide-react'

interface Props {
  running: boolean
  disabledReason: string | null
  canContinue: boolean
  onSend(text: string): void
  onStop(): void
  onContinue(): void
  focusKey: string
}

export function Composer({ running, disabledReason, canContinue, onSend, onStop, onContinue, focusKey }: Props) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [focusKey])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [text])

  const send = (): void => {
    if (running || disabledReason || !text.trim()) return
    onSend(text)
    setText('')
  }

  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={disabledReason ?? (running ? 'Claude is working… (you can type your next message)' : 'Ask Claude to build, fix, explain or refactor…')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !window.forge.mobile) {
            e.preventDefault()
            send()
          }
          if (e.key === 'Escape' && running) onStop()
        }}
      />
      <div className="composer-bar">
        <div className="composer-hint">
          <span>
            <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline{running ? <> · <kbd>Esc</kbd> stop</> : null}
          </span>
        </div>
        {canContinue && !running && (
          <button className="btn" onClick={onContinue} title="Let Claude continue where it stopped">
            <Play size={14} /> Continue
          </button>
        )}
        {running ? (
          <button className="send-btn stop" onClick={onStop} title="Stop (Esc)">
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button className="send-btn" disabled={!!disabledReason || !text.trim()} onClick={send} title="Send (Enter)">
            {text.includes('\n') ? <CornerDownLeft size={16} /> : <ArrowUp size={17} />}
          </button>
        )}
      </div>
    </div>
  )
}
