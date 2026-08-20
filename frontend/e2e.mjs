// Browser E2E for the Rust+TS trace visualizer (run: node e2e.mjs).
// Requires: backend running (default 8602) serving the built dist.

import { firefox } from 'playwright'
import { mkdirSync, writeFileSync, mkdirSync as mkdirp } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8602'
const FIX = '/home/q00938788/Desktop/ora-space/dashboard/agent_trace_visualizer/backend/tests/fixtures'
const OUT = '/tmp/atv-e2e'
mkdirSync(OUT, { recursive: true })

// Set up the Ora handoff fixtures (locator + child subagent trace).
const locatorDir = join(homedir(), '.local/share/space.ora.desktop/dashboard')
mkdirp(locatorDir, { recursive: true })
writeFileSync(
  join(locatorDir, 'e2e_sess.json'),
  JSON.stringify({ traceFilePath: `${FIX}/sample_opencode.ndjson`, agentType: 'opencode' }),
)
const ocTraceDir = join(homedir(), '.local/share/opencode/trace')
mkdirp(ocTraceDir, { recursive: true })
writeFileSync(
  join(ocTraceDir, 'ses_child123.ndjson'),
  [
    '{"type":"session.start","ts":100,"model":"m2","sessionID":"ses_child123","title":"child"}',
    '{"type":"step.start","ts":110,"globalStep":1}',
    '{"type":"step.finish","ts":120,"globalStep":1,"cumTokens":{"input":50,"output":10},"tokens":{},"reason":"end_turn"}',
  ].join('\n') + '\n',
)

const errors = []
const browser = await firefox.launch()
const page = await browser.newPage()
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`)
})
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`))

// ── 1. Landing page ───────────────────────────────────────────
await page.goto(`${BASE}/`)
await page.waitForSelector('text=Trace Visualizer')
await page.screenshot({ path: `${OUT}/1-landing.png`, fullPage: true })
console.log('1. landing OK')

// ── 2. Opencode standalone: upload → parse → tabs ─────────────
await page.click('text=Opencode 可视化')
await page.waitForURL('**/opencode')
await page.setInputFiles('input[type=file]', `${FIX}/sample_opencode.ndjson`)
await page.waitForSelector('text=会话回放', { timeout: 15000 })
await page.waitForSelector('.step-card', { timeout: 15000 })
const stepCount = await page.locator('.step-card').count()
console.log(`2. opencode upload OK (${stepCount} replay cards)`)
await page.screenshot({ path: `${OUT}/2-opencode-replay.png`, fullPage: true })

// overview tab + mermaid
await page.click('text=总览')
await page.waitForSelector('.mermaid-out svg', { timeout: 20000 })
console.log('3. overview + mermaid svg OK')
await page.screenshot({ path: `${OUT}/3-opencode-overview.png`, fullPage: true })

// tools tab (plotly)
await page.click('text=工具执行与消耗')
await page.waitForSelector('.js-plotly-plot', { timeout: 20000 })
console.log('4. tools tab + plotly OK')

// raw tab
await page.click('text=原始数据')
await page.waitForSelector('text=匹配')
console.log('5. raw tab OK')

// 时间轴 tab（opencode，同款三泳道）——fixture: 1 用户输入 + 4 工具 + 3 轮次
await page.click('text=时间轴')
await page.waitForSelector('.wf-row', { timeout: 20000 })
const ocTlRows = await page.locator('.wf-row').count()
if (ocTlRows !== 5) throw new Error(`opencode timeline expected 5 rows (1 user + 4 tools), got ${ocTlRows}`)
const ocTlTurns = await page.locator('.tl-turn-sep').count()
if (ocTlTurns !== 3) throw new Error(`opencode timeline expected 3 turns (globalStep 1-3), got ${ocTlTurns}`)
const ocTlLanes = await page.locator('.tl-lane').count()
if (ocTlLanes !== 3) throw new Error(`expected 3 lanes, got ${ocTlLanes}`)
const ocKinds = await page.evaluate(() => [...new Set([...document.querySelectorAll('.wf-row')].map((r) => r.getAttribute('data-kind')))].sort().join(','))
if (ocKinds !== 'tool,user') throw new Error(`opencode fixture rows must be user/tool only, got ${ocKinds}`)
// 工具行点击 → 面板（Payload 入参 + Result 输出）
await page.click('.wf-row[data-kind="tool"] >> nth=0')
await page.waitForSelector('.wf-panel', { timeout: 10000 })
await page.click('.wf-panel >> text=Result')
await page.waitForSelector('.wf-panel >> text=done', { timeout: 10000 })
console.log(`5d. opencode timeline OK (${ocTlRows} rows, ${ocTlTurns} turns, kinds=${ocKinds})`)

// subagent tab: overview with child-trace enrichment + per-subagent details
await page.click('text=Subagent')
await page.waitForSelector('text=Subagent 派发概览（共 2 个）', { timeout: 15000 })
await page.waitForSelector('text=数据可用', { timeout: 15000 })
await page.waitForSelector('text=逐个 Subagent 详情', { timeout: 15000 })
// expand the resolved child-trace detail → metrics render inside
await page.click('text=session: ses_child123…')
await page.waitForSelector('text=工具调用成功率', { timeout: 10000 })
// pending subagent (no tool.finish) shows the info state after expanding
await page.click('text=派发中，尚无子会话 ID')
await page.waitForSelector('text=该 task 调用还没有对应的 tool.finish', { timeout: 10000 })
// token/tool charts for the available subagent
await page.waitForSelector('text=各 Subagent Token 消耗', { timeout: 15000 })
await page.waitForSelector('.js-plotly-plot', { timeout: 20000 })
console.log('5b. opencode subagent tab OK')
await page.screenshot({ path: `${OUT}/5b-subagent.png`, fullPage: true })

// token trend tab: all 3 turns must appear (legacy semantics)
await page.click('text=Token 趋势')
await page.waitForSelector('.js-plotly-plot', { timeout: 20000 })
const ocTrendPoints = await page.evaluate(() => {
  const el = document.querySelectorAll('.js-plotly-plot')[0]
  return el?.data?.[0]?.x?.length ?? 0
})
if (ocTrendPoints !== 3) throw new Error(`opencode trend should have 3 turn points, got ${ocTrendPoints}`)
const ocTrend = await page.evaluate(() => {
  const el = document.querySelectorAll('.js-plotly-plot')[0]
  return (el?.data ?? []).map((t) => ({ name: t.name, y: t.y }))
})
const ocCacheTrace = ocTrend.find((t) => String(t.name).includes('Cache Read'))
if (!ocCacheTrace) throw new Error(`opencode trend missing Cache Read line: ${ocTrend.map((t) => t.name).join('|')}`)
// per-step values (300/500/150), NOT the cumsum (300/800/950)
if (String(ocCacheTrace.y) !== '300,500,150') {
  throw new Error(`Cache Read must be per-step [300,500,150], got [${ocCacheTrace.y}]`)
}
// hit-rate chart renders below the trend
await page.waitForSelector('text=缓存命中率（Cache Read / 真实上下文窗口）', { timeout: 10000 })
console.log(`5c. opencode token trend OK (${ocTrendPoints} points, per-step cache ${ocCacheTrace.y})`)

// ── 6. Claude Code upload (transcript) ────────────────────────
await page.goto(`${BASE}/claude-code`)
await page.click('text=上传文件') // default mode is browse (~/.claude/projects)
await page.setInputFiles('input[type=file]', `${FIX}/sample_claude_code_transcript.jsonl`)
await page.waitForSelector('text=交互会话记录（transcript JSONL）', { timeout: 15000 })
await page.waitForSelector('.step-card', { timeout: 15000 })
console.log('6. claude transcript OK')
// timeline tab: 三泳道时间线 + 框选过滤 + 列表 + 右侧详情面板
await page.click('text=时间轴')
await page.waitForSelector('.wf-row', { timeout: 20000 })
const wfRowCount = await page.locator('.wf-row').count()
// fixture: 1 用户真实输入 + 3 模型文本 + 2 工具(调用+结果已合并) = 6
if (wfRowCount !== 6) throw new Error(`expected 6 timeline rows, got ${wfRowCount}`)
// three lanes render with blocks
const laneCount = await page.locator('.tl-lane').count()
if (laneCount !== 3) throw new Error(`expected 3 lanes, got ${laneCount}`)
const blockCount = await page.locator('.tl-block').count()
if (blockCount < 6) throw new Error(`lane blocks missing (${blockCount})`)
const tickCount = await page.locator('.tl-tick').count()
if (tickCount < 2) throw new Error(`ruler ticks missing (${tickCount})`)
// 只展示三种类型：无 system/thinking 行、无元事件开关、恰 3 个过滤 pill
const kinds = await page.evaluate(() => [...new Set([...document.querySelectorAll('.wf-row')].map((r) => r.getAttribute('data-kind')))].sort().join(','))
if (kinds !== 'llm,tool,user') throw new Error(`rows must be exactly user/llm/tool, got ${kinds}`)
const metaPill = await page.locator('.pill', { hasText: '元事件' }).count()
if (metaPill !== 0) throw new Error('元事件 pill must be gone')
const pillCount = await page.locator('.wf-toolbar .pill').count()
if (pillCount !== 3) throw new Error(`expected exactly 3 filter pills, got ${pillCount}`)
// 只统计真实用户输入：tool_result 包装消息不显示 → 1 个轮次
const turnSeps = await page.locator('.tl-turn-sep').count()
if (turnSeps !== 1) throw new Error(`expected 1 turn separator, got ${turnSeps}`)
const toolRows = await page.locator('.wf-row[data-kind="tool"]').count()
if (toolRows !== 2) throw new Error(`expected 2 merged tool rows, got ${toolRows}`)
console.log(`7. strip timeline OK (${wfRowCount} rows, ${laneCount} lanes, ${blockCount} blocks, ${turnSeps} turn, kinds=${kinds})`)
await page.screenshot({ path: `${OUT}/7-claude-timeline.png`, fullPage: true })

// brush-select a time range on the strip → list filters to events inside it
const stripBox = await page.locator('.tl-strip').boundingBox()
await page.mouse.move(stripBox.x + stripBox.width * 0.1, stripBox.y + stripBox.height / 2)
await page.mouse.down()
await page.mouse.move(stripBox.x + stripBox.width * 0.95, stripBox.y + stripBox.height / 2, { steps: 8 })
await page.mouse.up()
// range [12s, 114s] covers: tool Read(90s) + llm(90s) = 2 rows
// （60s 的 tool_result 包装消息与 95s 的顶层结果均已合并隐藏）
await page.waitForFunction(() => document.querySelectorAll('.wf-row').length === 2, null, { timeout: 10000 })
await page.waitForSelector('text=清除时间选择', { timeout: 10000 })
console.log('7b. brush time-range filter OK (2 rows in range)')

// single click on the strip clears the brush
await page.mouse.click(stripBox.x + stripBox.width * 0.5, stripBox.y + stripBox.height / 2)
await page.waitForFunction(() => document.querySelectorAll('.wf-row').length === 6, null, { timeout: 10000 })
console.log('7c. brush clear OK (back to 6 rows)')

// 三种类型过滤（关掉 用户输入/模型文本 → 仅剩 2 个工具行）
await page.click('.pill:has-text("用户输入")')
await page.click('.pill:has-text("模型文本")')
await page.waitForFunction(() => document.querySelectorAll('.wf-row').length === 2, null, { timeout: 10000 })
console.log('7f. kind filter OK (tools only: 2 rows)')

// click a tool row → panel: Payload(入参 JSON) + Result(归一化的输出全文)
await page.click('.wf-row >> nth=0')
await page.waitForSelector('.wf-panel', { timeout: 10000 })
await page.waitForSelector('.wf-panel >> text=摘要', { timeout: 10000 })
await page.waitForSelector('.wf-panel >> text=Payload', { timeout: 10000 })
await page.click('.wf-panel >> text=Payload')
await page.waitForSelector('.wf-panel .debug-json', { timeout: 10000 })
// 工具输出原为 [{type:text,text:...}] 块数组 → 归一化为纯文本
await page.click('.wf-panel >> text=Result')
await page.waitForSelector('.wf-panel >> text=found 2 suspects', { timeout: 10000 })
await page.click('.wf-panel >> text=Timing')
await page.waitForSelector('.wf-panel >> text=开始时间', { timeout: 10000 })
// 恢复过滤 → 点击模型文本行 → Result 显示模型输出的文本内容
await page.click('.wf-panel >> text=关闭')
await page.click('.pill:has-text("用户输入")')
await page.click('.pill:has-text("模型文本")')
await page.waitForFunction(() => document.querySelectorAll('.wf-row[data-kind="llm"]').length === 3, null, { timeout: 10000 })
await page.click('.wf-row[data-kind="llm"] >> nth=0')
await page.waitForSelector('.wf-panel', { timeout: 10000 })
await page.click('.wf-panel >> text=Result')
await page.waitForSelector('.wf-panel >> text=look into', { timeout: 10000 })
// 用户输入行：摘要直接展示输入文本全文
await page.click('.wf-panel >> text=关闭')
await page.click('.wf-row[data-kind="user"] >> nth=0')
await page.waitForSelector('.wf-panel >> text=输入内容', { timeout: 10000 })
await page.waitForSelector('.wf-panel >> text=fix the bug in parser', { timeout: 10000 })
// 回归：切到 Result 再点回 摘要，内容必须仍在（中文标签 tab key 修复）
await page.click('.wf-panel >> text=Result')
await page.waitForSelector('.wf-panel >> text=用户输入事件没有输出内容', { timeout: 10000 })
await page.click('.wf-panel >> text=摘要')
await page.waitForSelector('.wf-panel >> text=输入内容', { timeout: 10000 })
await page.waitForSelector('.wf-panel >> text=fix the bug in parser', { timeout: 10000 })
console.log('7d. per-type panel OK (tool Result 归一化 + llm text + user 输入全文 + 摘要 tab 回归)')
await page.screenshot({ path: `${OUT}/7d-waterfall-drawer.png`, fullPage: true })

// subagent tab: dispatch overview + per-call detail expanders
await page.click('text=🤖 Subagent')
await page.waitForSelector('text=Subagent 派发概览（共 1 个）', { timeout: 15000 })
await page.waitForSelector('text=逐个 Subagent 详情', { timeout: 15000 })
await page.click('text=Subagent #1:')
await page.waitForSelector('text=基本信息', { timeout: 15000 })
await page.waitForSelector('text=任务描述', { timeout: 15000 })
await page.waitForSelector('text=📥 输入参数（完整 JSON）', { timeout: 15000 })
await page.waitForSelector('text=📤 输出内容', { timeout: 15000 })
console.log('7b. claude subagent tab OK')
await page.screenshot({ path: `${OUT}/7b-claude-subagent.png`, fullPage: true })

// token trend tab: 3 distinct input windows must NOT collapse into one turn
await page.click('text=Token 趋势')
await page.waitForSelector('.js-plotly-plot', { timeout: 20000 })
await page.waitForSelector('text=已合并连续相同 input_tokens 的 Turn。原始 3 个 → 合并后 3 个有效数据点。', { timeout: 15000 })
const ccTrendPoints = await page.evaluate(() => {
  const el = document.querySelectorAll('.js-plotly-plot')[0]
  return el?.data?.[0]?.x?.length ?? 0
})
if (ccTrendPoints !== 3) throw new Error(`claude trend should have 3 turn points, got ${ccTrendPoints}`)
const ccDelta = await page.evaluate(() => {
  const el = document.querySelectorAll('.js-plotly-plot')[1]
  return (el?.data ?? []).map((t) => t.name).join('|')
})
if (!ccDelta.includes('Input Δ')) throw new Error(`claude delta chart missing: ${ccDelta}`)
console.log(`7c. claude token trend OK (${ccTrendPoints} points)`)

// deepseek-style usage convention (input_tokens EXCLUDES cache reads):
// the real session transcripts on this machine have cache_read ≫ input.
// The trend must show the true window (input + cache_read) and the hit
// rate must never exceed 100%.
const exclLines = [
  ['u1', 'user', { role: 'user', content: 'go' }, null],
  ['a1', 'assistant', { role: 'assistant', model: 'deepseek-v4-pro', content: [{ type: 'text', text: 'ok' }], stop_reason: 'tool_use' }, { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
  ['a2', 'assistant', { role: 'assistant', model: 'deepseek-v4-pro', content: [{ type: 'text', text: 'ok' }], stop_reason: 'tool_use' }, { input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 25216, cache_creation_input_tokens: 0 }],
  ['a3', 'assistant', { role: 'assistant', model: 'deepseek-v4-pro', content: [{ type: 'text', text: 'ok' }], stop_reason: 'tool_use' }, { input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 25216, cache_creation_input_tokens: 0 }],
  ['a4', 'assistant', { role: 'assistant', model: 'deepseek-v4-pro', content: [{ type: 'text', text: 'ok' }], stop_reason: 'tool_use' }, { input_tokens: 500, output_tokens: 30, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 }],
].map(([uuid, type, message, usage], i) =>
  JSON.stringify({
    type,
    uuid,
    parentUuid: i === 0 ? null : 'prev',
    timestamp: `2025-06-03T10:00:0${i}.000Z`,
    sessionId: 'excl-sess',
    cwd: '/tmp',
    version: '2.0.0',
    message: usage === null ? message : { ...message, usage },
  }),
)
writeFileSync(`${OUT}/excludes_cache.jsonl`, exclLines.join('\n') + '\n')

await page.goto(`${BASE}/claude-code`)
await page.click('text=上传文件')
await page.setInputFiles('input[type=file]', `${OUT}/excludes_cache.jsonl`)
await page.waitForSelector('text=交互会话记录（transcript JSONL）', { timeout: 15000 })
await page.click('text=Token 趋势')
await page.waitForSelector('.js-plotly-plot', { timeout: 20000 })
await page.waitForSelector('text=原始 4 个 → 合并后 3 个有效数据点', { timeout: 15000 })
await page.waitForSelector('text=该会话的 input_tokens 不含缓存命中', { timeout: 15000 })
const exclTrend = await page.evaluate(() => {
  const el = document.querySelectorAll('.js-plotly-plot')[0]
  return { name: el?.data?.[0]?.name, y: el?.data?.[0]?.y }
})
// input line shows the RAW json values (merged): [1000, 200, 500]
if (String(exclTrend.y) !== '1000,200,500') {
  throw new Error(`excludes-cache input must be raw json values, got: [${exclTrend.y}] (${exclTrend.name})`)
}
const exclHit = await page.evaluate(() => {
  const el = document.querySelectorAll('.js-plotly-plot')[2]
  return (el?.data?.[0]?.y ?? []).every((v) => v <= 100)
})
if (!exclHit) throw new Error('hit rate must never exceed 100%')
console.log(`7d. claude excludes-cache convention OK (raw input ${exclTrend.y}, hit ≤100%)`)

// ── 8. Gemini upload ──────────────────────────────────────────
await page.goto(`${BASE}/gemini`)
await page.setInputFiles('input[type=file]', `${FIX}/sample_gemini.log`)
await page.waitForSelector('text=解析调试面板', { timeout: 15000 })
await page.waitForSelector('.js-plotly-plot', { timeout: 20000 })
console.log('8. gemini debug panel + plot OK')
await page.screenshot({ path: `${OUT}/8-gemini.png`, fullPage: true })

// ── 9. Embedded (Ora contract) ────────────────────────────────
await page.goto(`${BASE}/?session_id=e2e_sess&agent_type=opencode`)
await page.waitForSelector('text=refactor dashboard', { timeout: 15000 })
await page.waitForSelector('.step-card', { timeout: 15000 })
const hasFilePicker = await page.locator('input[type=file]').count()
if (hasFilePicker !== 0) throw new Error('embedded view must not show file pickers')
console.log('9. embedded mode OK (no pickers)')
await page.screenshot({ path: `${OUT}/9-embedded.png`, fullPage: true })

// error states
await page.goto(`${BASE}/?session_id=nope_xyz&agent_type=opencode`)
await page.waitForSelector('text=定位器尚未生成', { timeout: 10000 })
console.log('10. embedded locator_missing OK')
await page.goto(`${BASE}/?session_id=e2e_sess&agent_type=claude_code`)
await page.waitForSelector('text=agent_type 不一致', { timeout: 10000 })
console.log('11. embedded agent_mismatch OK')

// ── 12. Compare page ──────────────────────────────────────────
await page.goto(`${BASE}/?app_mode=compare`)
await page.waitForSelector('text=使用方法', { timeout: 10000 })
console.log('12. compare placeholder OK')
await page.screenshot({ path: `${OUT}/12-compare.png`, fullPage: true })

// ── 13. SPA fallback route ────────────────────────────────────
await page.goto(`${BASE}/opencode`)
await page.waitForSelector('text=Opencode')
console.log('13. SPA fallback route OK')

await browser.close()

if (errors.length > 0) {
  console.log('\nJS errors:')
  for (const e of errors.slice(0, 10)) console.log('  ' + e)
  process.exit(1)
}
console.log('\nALL E2E CHECKS PASSED')
