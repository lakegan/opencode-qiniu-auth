// 生成 lib/catalog.mjs：把七牛云 MaaS 的模型清单固化成离线兜底目录。
// 用法：node scripts/gen-catalog.mjs
//
// 插件运行时还会调用 GET /v1/models 拿最新列表（该接口可匿名访问），
// 所以这份快照只用于「首次启动/断网」时的兜底，不会过期到不可用。
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const BASE = "https://api.qnaigc.com/v1"
const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(15000) })
if (!res.ok) throw new Error(`GET ${BASE}/models -> ${res.status}`)
const { data } = await res.json()

const rows = data
  .filter((m) => m?.id)
  .map((m) => [m.id, Number(m.context_length) || 0, Number(m.max_tokens) || 0])
  .sort((a, b) => a[0].localeCompare(b[0]))

const fetchedAt = new Date().toISOString()
const body = `// 自动生成，请勿手工编辑：node scripts/gen-catalog.mjs
// 来源：GET ${BASE}/models
// 抓取时间：${fetchedAt}
// 每项：[模型 id, 上下文长度, 最大输出]
export const CATALOG_SOURCE = ${JSON.stringify(`${BASE}/models`)}
export const CATALOG_FETCHED_AT = ${JSON.stringify(fetchedAt)}
export const CATALOG = [
${rows.map((row) => `  ${JSON.stringify(row)},`).join("\n")}
]
`
await writeFile(join(root, "lib", "catalog.mjs"), body, "utf8")
console.log(`wrote lib/catalog.mjs (${rows.length} models, ${fetchedAt})`)
