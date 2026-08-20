// Opencode standalone page: sidebar (upload) + body; back button.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useParse } from '../../hooks'
import { FileUpload, ErrorBanner } from '../../components/ui/primitives'
import type { AgentType, ParseResult } from '../../api/types'
import OpencodeBody from './OpencodeBody'

export default function OpencodeView() {
  const [content, setContent] = useState<ArrayBuffer | null>(null)
  const [name, setName] = useState('')
  const { data, error, isLoading } = useParse('opencode' as AgentType, content, name)

  return (
    <div className="page shell">
      <aside className="sidebar">
        <Link className="btn" to="/">← 返回选择页</Link>
        <hr />
        <h3>Opencode</h3>
        <FileUpload
          label="上传 trace-logger 生成的 .ndjson 文件"
          onFile={(buf, n) => {
            setContent(buf)
            setName(n)
          }}
        />
        {name && <p className="muted">已加载：{name}</p>}
        {error && <ErrorBanner>{String(error)}</ErrorBanner>}
      </aside>
      <div className="main">
        {isLoading && <p className="muted">解析中…</p>}
        {data && <OpencodeBody result={data as ParseResult} />}
        {!content && <p className="muted">请先上传一个 .ndjson trace 文件。</p>}
      </div>
    </div>
  )
}
