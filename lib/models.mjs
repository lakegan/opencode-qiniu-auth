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

const FREE_RE = /-free$|conatus-free$/i

const DEFAULT_CONTEXT = 128000
const DEFAULT_OUTPUT = 8192

const hasVision = (id) => VISION_IDS.has(id) || VISION_RE.test(id) || DOUBAO_SEED_RE.test(id)

const hasReasoning = (id) => REASONING_IDS.has(id) || REASONING_RE.test(id)

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

/**
 * magpie / OpenCode 用 `<provider>/<model>` 指代模型。
 * 七牛的 id 自带厂商前缀（deepseek/deepseek-v4-pro），若原样当 key，
 * 用户写出来就是 qiniu/deepseek/deepseek-v4-pro。这里去掉重复的第一段，
 * 请求时才用完整 id（模型对象的 id 字段），因此 qiniu/deepseek-v4-pro 即可。
 */
export function keyFor(id) {
  const idx = String(id).indexOf("/")
  return idx === -1 ? String(id) : String(id).slice(idx + 1)
}

function clampOutput(maxOutput, context) {
  const out = Number(maxOutput) > 0 ? Number(maxOutput) : DEFAULT_OUTPUT
  return Math.min(out, context)
}

/**
 * @param {Array<[string, number, number]>} rows [id, context_length, max_tokens]
 * @param {Record<string, object>} [fallback] config/plugins.json 里已有的模型定义，优先保留
 */
export function buildModels(rows, fallback = {}) {
  const models = {}
  const used = new Set()
  for (const row of rows) {
    const id = Array.isArray(row) ? row[0] : row?.id
    if (!id) continue
    // 去掉会与供应商重复的前缀；万一撞名（线上同时有 deepseek-v4-flash 与
    // deepseek/deepseek-v4-flash），退回完整 id，宁可难读也不能覆盖
    let key = keyFor(id)
    if (used.has(key)) key = id
    used.add(key)

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
  return out
}
