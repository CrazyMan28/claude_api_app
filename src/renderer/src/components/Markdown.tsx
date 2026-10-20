import { memo, useEffect, useMemo, useRef } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'

const marked = new Marked({ gfm: true, breaks: false })

function render(src: string): string {
  const html = marked.parse(src, { async: false }) as string
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}

/** Sanitized GitHub-flavored Markdown with syntax highlighting and copy buttons. */
export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => render(text), [text])

  useEffect(() => {
    const root = ref.current
    if (!root) return
    root.querySelectorAll('pre code').forEach((el) => {
      const code = el as HTMLElement
      if (!code.dataset.highlighted) {
        try {
          hljs.highlightElement(code)
        } catch {
          /* unknown language */
        }
      }
      const pre = code.parentElement
      if (pre && !pre.querySelector('.copy-btn') && !streaming) {
        const btn = document.createElement('button')
        btn.className = 'copy-btn'
        btn.textContent = 'Copy'
        btn.onclick = () => {
          void navigator.clipboard.writeText(code.innerText)
          btn.textContent = 'Copied'
          setTimeout(() => (btn.textContent = 'Copy'), 1200)
        }
        pre.appendChild(btn)
      }
    })
    // links open in the system browser via the main process' window-open handler
    root.querySelectorAll('a').forEach((a) => a.setAttribute('target', '_blank'))
  }, [html, streaming])

  return <div ref={ref} className={`md${streaming ? ' cursor' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />
})
