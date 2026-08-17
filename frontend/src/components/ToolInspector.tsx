// Select + 2-column detail view for a single tool call (port of
// `tool_inspector` in the legacy shared views).

import { useState } from 'react'
import type { ToolCall } from '../api/types'
import { grouped } from '../derive'

export default function ToolInspector({ tools }: { tools: ToolCall[] }) {
  const [idx, setIdx] = useState(0)
  if (tools.length === 0) return null
  const selected = tools[Math.min(idx, tools.length - 1)]
  const rawInput = selected.input

  return (
    <div>
      <label className="text-input">
        <span>选择一次工具调用进行深度审查：</span>
        <select value={Math.min(idx, tools.length - 1)} onChange={(e) => setIdx(Number(e.target.value))}>
          {tools.map((t, i) => (
            <option key={i} value={i}>
              [Turn {t.turn_no}] #{t.call_idx + 1}  {t.name}  |  {t.is_error ? '❌ 错误' : '✅'}  |{' '}
              {grouped(t.tiktoken_tokens)} tokens
            </option>
          ))}
        </select>
      </label>
      <div className="two-col">
        <div>
          <div className="banner banner-info">Turn: {selected.turn_no}</div>
          <div className="banner banner-info">Tiktoken Tokens: {grouped(selected.tiktoken_tokens)}</div>
          <div className="banner banner-info">输出大小: {grouped(selected.output_chars)} chars</div>
          <div className="banner banner-info">是否错误: {selected.is_error ? '是 ❌' : '否 ✅'}</div>
          {selected.duration_ms > 0 && (
            <div className="banner banner-info">耗时: {selected.duration_ms.toFixed(0)} ms</div>
          )}
          {rawInput !== null && rawInput !== undefined && (
            <>
              <h4>入参（JSON）</h4>
              <pre className="debug-json">{JSON.stringify(rawInput, null, 2)}</pre>
            </>
          )}
        </div>
        <div>
          <h4>工具返回内容</h4>
          <textarea className="tool-output" readOnly value={selected.output} rows={16} />
        </div>
      </div>
    </div>
  )
}
