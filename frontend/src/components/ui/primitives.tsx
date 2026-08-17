// Small UI primitives mirroring the Streamlit widgets the legacy app used.
// Hand-rolled CSS (styles.css) — no UI kit.

import { useMemo, useState, type ReactNode } from 'react'

// ── Tabs ──────────────────────────────────────────────────────

export function Tabs({
  items,
  active,
  onChange,
}: {
  items: { key: string; label: string }[]
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button
          key={it.key}
          role="tab"
          aria-selected={it.key === active}
          className={`tab ${it.key === active ? 'tab-active' : ''}`}
          onClick={() => onChange(it.key)}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

// ── Expander (collapsible section) ───────────────────────────

export function Expander({
  title,
  children,
  defaultOpen = false,
}: {
  title: ReactNode
  children: ReactNode
  defaultOpen?: boolean
}) {
  return (
    <details className="expander" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="expander-body">{children}</div>
    </details>
  )
}

// ── Pills (single/multi select chips) ────────────────────────

export function Pills({
  options,
  selected,
  onChange,
  multi = false,
}: {
  options: string[]
  selected: string[]
  onChange: (next: string[]) => void
  multi?: boolean
}) {
  const toggle = (opt: string) => {
    if (multi) {
      onChange(selected.includes(opt) ? selected.filter((s) => s !== opt) : [...selected, opt])
    } else {
      onChange([opt])
    }
  }
  return (
    <div className="pills">
      {options.map((opt) => (
        <button
          key={opt}
          className={`pill ${selected.includes(opt) ? 'pill-active' : ''}`}
          onClick={() => toggle(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}

// ── Pagination ───────────────────────────────────────────────

export function Pagination({
  page,
  totalPages,
  total,
  start,
  end,
  onPage,
}: {
  page: number
  totalPages: number
  total: number
  start: number
  end: number
  onPage: (p: number) => void
}) {
  if (totalPages <= 1) return null
  return (
    <div className="pagination">
      <button className="btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ◀ 上一页
      </button>
      <span className="pagination-info">
        第 <b>{page}</b> / {totalPages} 页（{start}–{end} / 共 {total} 条）
      </span>
      <button className="btn" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        下一页 ▶
      </button>
    </div>
  )
}

// ── DataTable (columnar table over records) ──────────────────

export function DataTable({
  rows,
  columns,
  compact = false,
}: {
  rows: Record<string, unknown>[]
  columns?: { key: string; label?: string; hide?: boolean }[]
  compact?: boolean
}) {
  const cols = useMemo(() => {
    if (columns) return columns.filter((c) => !c.hide)
    if (rows.length === 0) return []
    return Object.keys(rows[0]).map((key) => ({ key, label: key }))
  }, [rows, columns])

  if (rows.length === 0) return <div className="muted">（无数据）</div>
  return (
    <div className={`table-wrap ${compact ? 'table-compact' : ''}`}>
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key}>{c.label ?? c.key}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c.key}>{renderCell(row[c.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function renderCell(v: unknown): ReactNode {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return <code>{JSON.stringify(v)}</code>
  return String(v)
}

// ── File upload ──────────────────────────────────────────────

export function FileUpload({
  label,
  accept,
  onFile,
}: {
  label: string
  accept?: string
  onFile: (content: ArrayBuffer, name: string) => void
}) {
  return (
    <label className="file-upload">
      <span>{label}</span>
      <input
        type="file"
        accept={accept ?? '.ndjson,.jsonl,.txt,.json,.log'}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (!file) return
          file.arrayBuffer().then((buf) => onFile(buf, file.name))
        }}
      />
    </label>
  )
}

// ── Text input ───────────────────────────────────────────────

export function TextInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <label className="text-input">
      <span>{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

// ── Number input ─────────────────────────────────────────────

export function NumberInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <label className="text-input">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

// ── Copy block (mermaid source etc.) ─────────────────────────

export function CopyBlock({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="btn"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? '✅ 已复制' : `📋 ${label}`}
    </button>
  )
}

// ── Debug JSON viewer ────────────────────────────────────────

export function DebugJson({ value }: { value: unknown }) {
  return (
    <pre className="debug-json">{JSON.stringify(value, null, 2)}</pre>
  )
}

// ── Info / warning / error banners ───────────────────────────

export function Info({ children }: { children: ReactNode }) {
  return <div className="banner banner-info">ℹ️ {children}</div>
}

export function Warning({ children }: { children: ReactNode }) {
  return <div className="banner banner-warning">⚠️ {children}</div>
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return <div className="banner banner-error">❌ {children}</div>
}
