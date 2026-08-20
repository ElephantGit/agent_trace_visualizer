// Grouped tool-efficiency table (port of `tool_efficiency_table`).

import type { ToolCall } from '../api/types'
import { DataTable } from './ui/primitives'
import { shapeTools } from '../derive'

export default function ToolEfficiencyTable({ tools }: { tools: ToolCall[] }) {
  const rows = shapeTools(tools).map((r) => ({
    '工具': r.name,
    '调用次数': r.count,
    '总输出chars': r.total_chars.toLocaleString('en-US'),
    '均输出chars': Math.round(r.avg_chars).toLocaleString('en-US'),
    '总TiktokenTokens': r.total_tiktoken.toLocaleString('en-US'),
    '均TiktokenTokens': Math.round(r.avg_tiktoken).toLocaleString('en-US'),
    '错误次数': r.errors,
    '成功率': r.success_rate,
    ...(r.avg_duration_ms !== null
      ? {
          '平均耗时ms': Math.round(r.avg_duration_ms).toLocaleString('en-US'),
          '最大耗时ms': Math.round(r.max_duration_ms!).toLocaleString('en-US'),
        }
      : {}),
  }))
  return <DataTable rows={rows} />
}
