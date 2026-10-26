// 模型目录 → magpie 模型对象
//
// 七牛的 GET /v1/models 只给出 [id, context_length, max_tokens]，
// 没有能力位（工具调用 / 视觉 / 思考）。这里用保守的启发式补上能力位，
// 并允许通过 plugins.json 的 options 覆盖，或在 provider.models 里逐模型覆盖。

const VENDOR_NAMES = {
  qiniu: "Qiniu",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  "z-ai": "Z.ai",
  z: "Z.ai",
  moonshotai: "Moonshot",
  minimax: "MiniMax",
  bytedance: "ByteDance",
  tencent: "Tencent",
  xiaomi: "Xiaomi",
  stepfun: "StepFun",
  nvidia: "NVIDIA",
  meituan: "Meituan",
}

const ACRONYMS = {
  glm: "GLM",
  vl: "VL",
  ai: "AI",
  llm: "LLM",
  gpt: "GPT",
  mcp: "MCP",
  moe: "MoE",
  // 品牌名大小写：deepseek-r1 这类没带厂商前缀的 id 也会走到这里
  deepseek: "DeepSeek",
  qwen: "Qwen",
  kimi: "Kimi",
  minimax: "MiniMax",
  doubao: "Doubao",
  nemotron: "Nemotron",
  longcat: "LongCat",
  hy: "HY",
  mimo: "MiMo",
  seed: "Seed",
  step: "Step",
  conatus: "Conatus",
}

// 官方页面明确支持图像输入的模型（含 1M 上下文的多模态旗舰）
const VISION_IDS = new Set([
  "qiniu/conatus-free",
  "moonshotai/kimi-k3",
  "moonshotai/kimi-k3-free",
  "moonshotai/kimi-k2.6",
  "moonshotai/kimi-k2.7-code",
  "minimax/minimax-m3",
  "minimax/minimax-m3.1-flash",
  "xiaomi/mimo-v2.6-pro",
  "xiaomi/mimo-v2.6-flash",
  "deepseek/deepseek-v4-flash-vision-exp",
  "z-ai/glm-5.3-flash",
  "qwen3.5-397b-a17b",
  "qwen/qwen3.7-max",
  "qwen/qwen3.7-plus",
  "qwen/qwen3.7-flash",
  "qwen/qwen3.8-max",
  "qwen/qwen3.8-flash-next",
  "doubao-1.5-vision-pro",
])

const VISION_RE = /(?:^|[-/])(?:vl|vision)(?:[-/]|$)/i
const DOUBAO_SEED_RE = /^(?:bytedance\/)?doubao-seed-/i

// 官方标注「深度思考」的模型家族
const REASONING_IDS = new Set([
  "qiniu/conatus-free",
  "moonshotai/kimi-k3",
  "moonshotai/kimi-k3-free",
  "minimax/minimax-m3",
  "minimax/minimax-m3.1-flash",
  "nvidia/nemotron-3-ultra-550b-a55b0-free",
  "tencent/hy4-preview",
])

const REASONING_RE = /(thinking|reasoner|(?:^|[-/])r1(?:[-/]|$)|deepseek-v3\.[12]|deepseek-v4|glm-5|qwen3|mimo-|doubao-seed-2)/i

// 名字里带 instruct 的是「指令微调」的非思考模型，即使家族名命中 REASONING_RE
// 也不该标成推理模型（qwen3-coder-480b-a35b-instruct、qwen3-235b-a22b-instruct-2507 …）。
// 七牛的 /v1/models 不给能力位，只能靠名字，所以这条排除必须显式写出来。
const INSTRUCT_RE = /(?:^|[-/])instruct(?:[-/]|$)/i

const FREE_RE = /-free$|conatus-free$/i

const DEFAULT_CONTEXT = 128000
const DEFAULT_OUTPUT = 8192

const hasVision = (id) => VISION_IDS.has(id) || VISION_RE.test(id) || DOUBAO_SEED_RE.test(id)

const hasReasoning = (id) => {
  // instruct 模型永远不是思考模型，优先级最高
  if (INSTRUCT_RE.test(id)) return false
  return REASONING_IDS.has(id) || REASONING_RE.test(id)
}

const isFree = (id) => FREE_RE.test(id)

function titleCase(word) {
  if (!word) return word
  const lower = word.toLowerCase()
  if (ACRONYMS[lower]) return ACRONYMS[lower]
  if (/^[a-z]{1,3}\d[\d.]*$/i.test(word)) return word.toUpperCase() // v4 → V4、k3 → K3、r1 → R1
  if (/^\d/.test(word)) return word
  return word[0].toUpperCase() + word.slice(1)
}

/** qiniu/conatus-free → "Conatus Free"，deepseek/deepseek-v4-pro → "DeepSeek V4 Pro" */
export function prettify(id) {
  const raw = String(id)
  const slash = raw.indexOf("/")

  let vendorRaw = ""
  let modelRaw = raw
  if (slash > 0) {
    vendorRaw = raw.slice(0, slash)
    modelRaw = raw.slice(slash + 1)
  } else {
    // 没有斜杠时也尝试认出已知厂商前缀：deepseek-r1 → DeepSeek / R1
    const hit = Object.keys(VENDOR_NAMES)
      .filter((name) => name.length > 2)
      .find((name) => raw.toLowerCase().startsWith(`${name}-`))
    if (hit) {
      vendorRaw = hit
      modelRaw = raw.slice(hit.length + 1)
    }
  }

  const vendor = vendorRaw ? VENDOR_NAMES[vendorRaw.toLowerCase()] ?? titleCase(vendorRaw) : ""
  // 去掉模型名里与厂商重复的前缀：deepseek/deepseek-v4-pro → DeepSeek V4 Pro
  const dupPrefix = `${vendorRaw.toLowerCase()}-`
  const trimmed = modelRaw.toLowerCase().startsWith(dupPrefix) ? modelRaw.slice(dupPrefix.length) : modelRaw
  const model = trimmed
    .split(/[-_]/)
    .map(titleCase)
    .join(" ")
    // doubao-seed-2-1-pro → Doubao Seed 2.1 Pro（两段相邻个位数视为版本号）
    .replace(/\b(\d) (\d)\b/g, "$1.$2")

  if (!vendor || vendor === "Qiniu") return model || id
  // 厂商名已在模型名开头（qwen/qwen3.8-max），不再重复
  if (model.toLowerCase().startsWith(vendor.toLowerCase())) return model
  return `${vendor} ${model}`
}

// ---------------------------------------------------------------------------
// 排序：Magpie 只把供应商列表的**前 24 个**模型交给 agent
// ("agents see up to 24 of its models")。所以顺序是功能，不是审美。
//
// 按 id 字典序排的后果：大写开头的 bytedance/…、deepseek/… 占满前 24，
// 小写开头的 qiniu/conatus-free、kimi-k3-free、glm-4.5-air-free 全被截断在外面
// —— 也就是这个插件主打的东西，agent 一个都看不到。
// ---------------------------------------------------------------------------

// 排在最前的旗舰（不含免费模型；免费模型永远排它们前面）
const FLAGSHIP_ORDER = [
  "qiniu/conatus-free",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "moonshotai/kimi-k3",
  "minimax/minimax-m3",
  "qwen/qwen3.7-max",
  "qwen/qwen3.8-max",
  "z-ai/glm-5.3-flash",
]

const CONATUS_ID = "qiniu/conatus-free"

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * 模型排序：免费模型 → 旗舰 → 其余按 id。
 * 组内 `qiniu/conatus-free` 固定第一（provider 的代表模型），其余按 id 升序，
 * 保证同一份列表任何时候排出来的结果都一样。
 */
export function sortModelIds(ids) {
  const rank = (id) => {
    if (isFree(id)) return 0
    return FLAGSHIP_ORDER.includes(id) ? 1 : 2
  }
  return [...ids].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    if (ra === 0) {
      // 免费组内：conatus 第一，其余按 id
      const ca = a === CONATUS_ID
      const cb = b === CONATUS_ID
      if (ca !== cb) return ca ? -1 : 1
      return byId(a, b)
    }
    if (ra === 1) {
      // 旗舰组内：按 FLAGSHIP_ORDER 的声明顺序
      const ia = FLAGSHIP_ORDER.indexOf(a)
      const ib = FLAGSHIP_ORDER.indexOf(b)
      if (ia !== ib) return ia - ib
      return byId(a, b)
    }
    return byId(a, b)
  })
}

/** 按 sortModelIds 的顺序重排模型 map，保持 key → model 的结构 */
export function sortModels(models) {
  const ids = Object.values(models).map((m) => String(m.id ?? ""))
  const order = sortModelIds(ids)
  const rankOf = new Map(order.map((id, i) => [id, i]))
  return Object.fromEntries(
    Object.entries(models).sort(([, a], [, b]) => {
      const ia = rankOf.get(String(a.id ?? "")) ?? Number.MAX_SAFE_INTEGER
      const ib = rankOf.get(String(b.id ?? "")) ?? Number.MAX_SAFE_INTEGER
      return ia - ib
    }),
  )
}

/**
 * 模型 key：去掉与厂商重复的第一段，让用户写 qiniu/deepseek-v4-pro 而不是
 * qiniu/deepseek/deepseek-v4-pro。请求时仍用完整 id（模型对象的 id 字段）。
 *
 * 但「去前缀」只在**全局唯一**时才用，且判断与列表顺序无关：
 * 先按原始 id 排序，统计每个短名出现几次，只有出现一次的短名才被采用，
 * 其余的保留完整 id。这样同一份模型列表无论以什么顺序返回，得到的 key 都一样
 * ——早前「遇到重复才回退」是按遍历顺序决定的，换个顺序 key 就变了。
 *
 * 已知取舍：七牛日后若新增一个撞名的模型，对应的短名会退回完整 id，
 * 那个模型的 key 会变一次。这是任何去前缀方案都无法避免的，要绝对稳定只能用完整 id。
 */
export function keyFor(id) {
  const raw = String(id)
  const idx = raw.indexOf("/")
  return idx === -1 ? raw : raw.slice(idx + 1)
}

/** 由整份 id 列表算出 id → key 的映射（顺序无关） */
export function planKeys(ids) {
  const list = [...new Set(ids.map(String))].sort()
  const shortCount = new Map()
  for (const id of list) {
    const short = keyFor(id)
    shortCount.set(short, (shortCount.get(short) ?? 0) + 1)
  }
  const out = new Map()
  for (const id of list) {
    const short = keyFor(id)
    out.set(id, shortCount.get(short) === 1 ? short : id)
  }
  return out
}

function clampOutput(maxOutput, context) {
  const out = Number(maxOutput) > 0 ? Number(maxOutput) : DEFAULT_OUTPUT
  return Math.min(out, context)
}

/**
 * 由线上列表构建模型，`fallback` **只做覆盖，不新增 id**。
 *
 * 这一点很关键：早前是 `{ ...known, ...buildModels(rows, known) }`，known 作为
 * 展开基底，快照里每个 id 都会出现在结果里 —— 七牛下线某个模型后，provider
 * 仍然提供它，agent 选中它、发请求、然后报错，看起来像 provider 坏了。
 *
 * @param {Array<[string, number, number]>} rows [id, context_length, max_tokens]
 * @param {Record<string, object>} [fallback] 已声明的模型定义，按 key 或 id 查表覆盖
 */
export function buildModels(rows, fallback = {}) {
  const models = {}
  const ids = []
  for (const row of rows) {
    const id = Array.isArray(row) ? row[0] : row?.id
    if (id) ids.push(String(id))
  }
  // key 由整份列表共同决定，与顺序无关（见 planKeys）
  const keys = planKeys(ids)

  for (const row of rows) {
    const rawId = Array.isArray(row) ? row[0] : row?.id
    if (!rawId) continue
    const id = String(rawId)
    const key = keys.get(id) ?? keyFor(id)

    const base = fallback[key] ?? fallback[id] ?? {}
    const rawContext = Number(Array.isArray(row) ? row[1] : row?.context_length) || 0
    const rawOutput = Number(Array.isArray(row) ? row[2] : row?.max_tokens) || 0
    const context = rawContext > 0 ? rawContext : base?.limit?.context ?? DEFAULT_CONTEXT
    const model = {
      id,
      name: prettify(id),
      limit: { context, output: clampOutput(rawOutput || base?.limit?.output, context) },
      tool_call: true,
      reasoning: hasReasoning(id),
      modalities: { input: hasVision(id) ? ["text", "image"] : ["text"] },
      ...(isFree(id) ? { free: true } : {}),
    }
    models[key] = { ...model, ...base, limit: { ...model.limit, ...(base?.limit ?? {}) } }
  }
  return models
}

function compileMatcher(patterns) {
  const list = (patterns ?? []).filter((p) => typeof p === "string" && p)
  if (!list.length) return null
  const tests = list.map((pattern) => {
    if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
      const end = pattern.lastIndexOf("/")
      const re = new RegExp(pattern.slice(1, end), pattern.slice(end + 1) || "i")
      return (id, key) => re.test(id) || re.test(key)
    }
    return (id, key) => id === pattern || key === pattern || id.startsWith(pattern)
  })
  return (id, key) => tests.some((test) => test(id, key))
}

/** 按 options.include / options.exclude / options.onlyFree 过滤 */
export function selectModels(models, options = {}) {
  const include = compileMatcher(options.include)
  const exclude = compileMatcher(options.exclude)
  const out = {}
  for (const [key, model] of Object.entries(models)) {
    const id = model.id ?? key
    if (options.onlyFree && !model.free) continue
    if (include && !include(id, key)) continue
    if (exclude && exclude(id, key)) continue
    out[key] = model
  }
  // 过滤后立即排序：Magpie 只取前 24 个模型交给 agent，顺序决定谁能被看到
  return sortModels(out)
}
