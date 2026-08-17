// Mermaid renderer — replaces the legacy CDN-in-iframe hack with the npm
// package while preserving its three key behaviors:
//   1. event-cap slider + seeded sampling (sampling happens server-side)
//   2. IntersectionObserver-gated rendering (hidden tabs have zero layout)
//   3. 30-try × 400ms retry loop
// StrictMode double-mount is handled via a renderedRef guard + cleanup.

import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { CopyBlock } from './ui/primitives'

mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  sequence: { mirrorActors: false, messageAlign: 'left' },
})

export default function MermaidView({
  src,
  theme = 'default',
  showCopy = true,
  notice,
}: {
  src: string
  theme?: string
  showCopy?: boolean
  notice?: string | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const renderedRef = useRef(false)
  const triesRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Re-render whenever the source changes.
    renderedRef.current = false
    triesRef.current = 0
    setError(null)

    const render = async () => {
      const out = containerRef.current
      if (!out) return
      if (renderedRef.current) return
      const id = `mmd-${triesRef.current}`
      try {
        // theme switch requires re-initialization
        const { svg } = await mermaid.render(id, src)
        if (renderedRef.current) return
        out.innerHTML = svg
        renderedRef.current = true
        triesRef.current = 0
      } catch (e) {
        out.textContent = ''
        triesRef.current += 1
        if (triesRef.current < 30) {
          timerRef.current = setTimeout(render, 400)
        } else {
          setError(e instanceof Error ? e.message : String(e))
          triesRef.current = 0
        }
      }
    }

    // IntersectionObserver: render only when visible (active tab).
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry.isIntersecting && !renderedRef.current) {
          triesRef.current = 0
          render()
        }
        if (!entry.isIntersecting) {
          renderedRef.current = false
          triesRef.current = 0
        }
      },
      { threshold: 0.1 },
    )
    if (containerRef.current) observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      if (timerRef.current) clearTimeout(timerRef.current)
      renderedRef.current = false
    }
  }, [src, theme])

  return (
    <div>
      {notice && <div className="muted mermaid-notice">{notice}</div>}
      {error && <div className="banner banner-error">Mermaid: {error}</div>}
      <div
        ref={containerRef}
        className="mermaid-out"
        style={{ fontSize: theme === 'dark' ? 'inherit' : undefined }}
      />
      {showCopy && (
        <div className="mermaid-actions">
          <CopyBlock text={src} label="复制 Mermaid 源码" />
        </div>
      )}
    </div>
  )
}
