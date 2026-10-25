// 七牛云 MaaS（Modelink）→ Magpie / OpenCode 供应商插件
//
// 登录：七牛云控制台创建的 API Key（sk- 开头，Bearer 认证）
// 协议：默认 [OI] Chat Completions —— https://api.qnaigc.com/v1/chat/completions
//       可用 options.baseURL 切到海外接入点 https://api.modelink.ai/v1
// 模型：启动时 GET /v1/models 拉取（该接口可匿名访问），失败则用内置快照 lib/catalog.mjs
// 额度：可选。配置 AK/SK 后通过平台管理接口显示今日 token 用量（与 API Key 严格隔离）
//
// 入口模块只导出插件函数和两个非函数对象：Magpie / OpenCode 会把入口的
// 每个导出函数都当作插件调用，所以所有辅助函数都不导出。

import { CATALOG, CATALOG_FETCHED_AT } from "./lib/catalog.mjs"
import { buildModels, prettify, selectModels } from "./lib/models.mjs"
import { todayUsageWindow } from "./lib/usage.mjs"

const PROVIDER = "qiniu"
const DEFAULT_BASE = "https://api.qnaigc.com/v1"
// 控制台里创建 API Key 的页面。放在 provider 元数据里交给宿主渲染，
// 插件不碰宿主的配置文件（早前写 ~/.config/magpie/providers.json 的做法已移除）。
const KEYS_URL = "https://portal.qiniu.com/ai-inference/api-key"
// AccessKey / SecretKey 所在的「密钥管理」页（与上面的 API Key 是两套凭证）
const KEYS_AKSK_PAGE = "https://portal.qiniu.com/developer/user/key"
const MODELS_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 10 * 60 * 1000
const DEFAULT_CONCURRENCY = 4
// 每日额度没有默认值：七牛不给「剩余额度」接口，任何内置档位都是编的。
// 只有用户自己填 options.dailyQuota 时才出百分比窗口。
// 另外活动（认证 1e8 / 充值 1e9）只覆盖免费模型且 2026-11-30 到期，
// 所以算百分比时只统计免费模型，见 FREE_MODEL_FILTER。
const FREE_MODEL_FILTER = "-free"

const stripSlash = (value) => String(value ?? "").replace(/\/+$/, "")

/** 统一成 `…/v1`：AI SDK 自己往后拼 /chat/completions 与 /models */
function resolveBaseUrl(options = {}) {
  const raw = stripSlash(options.baseURL || DEFAULT_BASE)
  return raw.endsWith("/v1") ? raw : `${raw}/v1`
}

function clampConcurrency(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return DEFAULT_CONCURRENCY
  return Math.min(1000, Math.max(1, parsed))
}

function clampError(message) {
  const text = String(message ?? "").trim() || "未知错误"
  return text.length > 480 ? `${text.slice(0, 477)}…` : text
}

/** GET {base}/models → [[id, context_length, max_tokens], …] */
async function fetchModelRows(base, key) {
  const headers = { accept: "application/json" }
  // 该接口可匿名访问；key 无效时返回 401，此时应回退到内置快照而不是空列表
  if (key) headers.authorization = `Bearer ${key}`
  const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`GET /models → HTTP ${res.status}`)
  const payload = await res.json()
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  return rows
    .map((row) => [row?.id, Number(row?.context_length) || 0, Number(row?.max_tokens) || 0])
    .filter((row) => typeof row[0] === "string" && row[0])
}

/** 只有密钥级的 401 才标记「需重新登录」，其他 401 交给 Magpie 正常处理 */
async function isKeyRejected(res) {
  if (res.status !== 401) return false
  try {
    const payload = await res.clone().json()
    const code = String(payload?.error?.code ?? payload?.error_code ?? "")
    const message = String(payload?.error?.message ?? payload?.error ?? "")
    if (!code && !message) return true
    return /auth|api_?key|token|credential|unauthor/i.test(`${code} ${message}`)
  } catch {
    return true
  }
}

/**
 * 取 AK/SK，优先级：账号里填的（登录时的 prompts，存在 metadata）
 * → 插件 options。都没配返回 null（那就是不显示额度，不是出错）。
 *
 * 不读环境变量：一个 QINIU_ACCESS_KEY 会被套到所有没填 AK/SK 的账号上，
 * 查出来就是同一个人的用量；而且 GUI 启动的 magpie 根本读不到 shell 变量。
 * 凭证必须跟着账号走。
 *
 * 同时做格式体检：七牛有两套完全不同的凭证，填串了接口只会回一个笼统的 401，
 * 排查起来很费劲，所以这里提前说清楚哪一项填错了。
 */
function readCredentials(options = {}, metadata = {}) {
  const accessKey = metadata.accessKey || options.accessKey
  const secretKey = metadata.secretKey || options.secretKey
  const ak = String(accessKey ?? "").trim()
  const sk = String(secretKey ?? "").trim()
  if (!ak || !sk) return null

  // sk- 开头的是 AI 推理的 API Key（调模型用），拿它当 SecretKey 签名必 401
  if (sk.startsWith("sk-")) {
    throw new Error(
      "SecretKey 填错了：以 sk- 开头的是「API Key」（调模型用的），不是 SecretKey。" +
        "SecretKey 在控制台 → 密钥管理，与 AccessKey 上下相邻，是 40 位、不带 sk- 前缀的一串。",
    )
  }
  // AccessKey 反过来也不该是 sk-
  if (ak.startsWith("sk-")) {
    throw new Error(
      "AccessKey 填错了：以 sk- 开头的是「API Key」。AccessKey 在控制台 → 密钥管理，40 位、不带 sk- 前缀。",
    )
  }
  return { accessKey: ak, secretKey: sk }
}

/**
 * 插件入口。
 * @param {object} input PluginInput：{ client, directory, worktree, $, … }
 * @param {object} [options] plugins.json 中该插件项的 options：
 *   baseURL        自定义接入点（默认 https://api.qnaigc.com/v1）
 *   name           供应商显示名（默认「七牛云」）
 *   maxConcurrency 每账号并发上限（默认 4，1–1000）
 *   include / exclude / onlyFree  模型过滤，支持字符串前缀或 /正则/
 *   accessKey / secretKey  可选，仅用于查询今日用量（不读环境变量，凭证跟账号走）
 *   dailyQuota     可选，每日 token 额度；**不填就不出百分比**，只报已用量
 *   plan / usageModel      可选，用量显示用的套餐名与模型过滤词
 */
export const QiniuPlugin = async (input, options) => {
  const opts = options ?? {}
  const base = resolveBaseUrl(opts)
  const log = (level, message) => {
    try {
      input?.client?.app?.log?.({ body: { service: "qiniu", level, message } })
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  let cache = { at: 0, rows: null }

  async function liveModelRows(key) {
    if (cache.rows && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows
    try {
      const rows = await fetchModelRows(base, key)
      if (!rows.length) {
        log("warn", "GET /models 返回空列表，改用内置模型快照")
        return null
      }
      cache = { at: Date.now(), rows }
      return rows
    } catch (error) {
      log("warn", `GET /models 失败（${error?.message ?? error}），改用内置模型快照 ${CATALOG_FETCHED_AT}`)
      return null
    }
  }

  // 静态声明：没登录、断网、接口异常时也看得到模型
  const declared = selectModels(buildModels(CATALOG), opts)

  return {
    // ---------- 供应商与模型 ----------
    config: async (cfg) => {
      cfg.provider ??= {}
      // ??= ：用户在 plugins.json 里自己写的供应商配置优先，插件不覆盖
      cfg.provider[PROVIDER] ??= {
        name: opts.name ?? "七牛云",
        npm: "@ai-sdk/openai-compatible",
        api: base,
        models: declared,
        // 只放在 provider 元数据里，由宿主自己决定怎么渲染；
        // 插件不去写宿主的 providers.json。
        keysUrl: KEYS_URL,
        website: "https://www.qiniu.com/ai/model/qiniu/conatus-free",
      }
    },

    // ---------- 登录 ----------
    auth: {
      provider: PROVIDER,
      maxConcurrency: clampConcurrency(opts.maxConcurrency),
      methods: [
        {
          type: "api",
          label: "七牛云 API Key",
          placeholder: "sk-…（控制台 → AI 推理 → API Key）",
          // Magpie 把 prompts 的回答存进账号的 metadata，loader/usage 里用 getAuth() 读回来。
          // AK/SK 与调用用的 sk- API Key 是两套凭证，只用于读「今日已用」，
          // 两项都允许留空（留空就只跑模型、不显示额度）。
          prompts: [
            {
              type: "text",
              key: "accessKey",
              message: `AccessKey（可选，显示今日额度用）← 取这个：${KEYS_AKSK_PAGE}`,
              placeholder: "40 位，如 aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd　留空跳过",
            },
            {
              type: "password",
              key: "secretKey",
              message: "SecretKey（与上一步配对，可选；不是 sk- 开头的那个！）",
              placeholder: "40 位、不带 sk- 前缀。sk-… 是模型 API Key，填这里会 401　留空跳过",
            },
          ],
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api" || !auth.key) return {}
        const key = String(auth.key).trim()

        return {
          baseURL: base,
          apiKey: key,
          // 401 且错误码指向密钥本身时补一个 X-Magpie-Sign-In: expired，
          // 让 Magpie 把账号标成「需重新登录」，而不是当成一次普通请求失败去做故障切换。
          // 响应体原样返回，不读流、不改内容。
          async fetch(request, init) {
            const response = await fetch(request, init)
            if (!(await isKeyRejected(response))) return response
            const headers = new Headers(response.headers)
            headers.set("x-magpie-sign-in", "expired")
            // 换掉 body 流后长度/压缩头不再可信，删掉以免下游解析出错
            headers.delete("content-length")
            headers.delete("content-encoding")
            return new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            })
          },
        }
      },

      // Magpie 自有钩子：今日 token 用量。
      // 七牛不公开「剩余额度」接口，只提供 AK/SK 管理接口查「已消耗量」，
      // 所以必须配 AccessKey/SecretKey 才能读到任何数字；缺了就明说原因，
      // 而不是静默返回空 windows 让界面一片空白。
      //
      // 关于「额度」：七牛从来没有返回过每日上限，所以这里**不设默认档位**。
      // 只有用户自己填了 options.dailyQuota，才给出 limit + used 百分比；
      // 否则只报已用量。编一个 1e8 出来会让窗口在 100% 时触发 magpie 挂起账号，
      // 充值用户、用付费模型的用户都会被误伤，而且活动 2026-11-30 就结束了。
      // 算百分比时还必须只统计免费模型——活动额度只覆盖它们。
      async usage(getAuth) {
        const auth = await getAuth().catch(() => undefined)
        if (auth?.type !== "api" || !auth.key) return { windows: [] }
        // AK/SK 是登录时 prompts 问的，Magpie 存在账号 metadata 里
        let creds
        try {
          creds = readCredentials(opts, auth.metadata ?? {})
        } catch (error) {
          // 填串了凭证（最常见：把 sk- 的 API Key 当 SecretKey）——
          // 直接把原因摆到用量卡片上，别让用户对着 401 猜
          return { windows: [], error: clampError(error?.message ?? error) }
        }
        if (!creds) {
          return {
            windows: [],
            error:
              "未填 AccessKey/SecretKey：七牛只提供「已消耗量」接口，需要 AK/SK 才能读到今日用量。" +
              "重新登录并填写这两项即可",
          }
        }

        const limit = Number(opts.dailyQuota)
        const hasLimit = Number.isFinite(limit) && limit > 0
        // 有上限时只算活动覆盖的免费模型（用户可用 usageModel 覆盖成别的词）；
        // 没上限时统计全部模型，毕竟「今天用了多少」本身是有意义的
        const modelFilter = hasLimit ? opts.usageModel ?? FREE_MODEL_FILTER : opts.usageModel

        const result = await todayUsageWindow({
          ...creds,
          dailyLimit: hasLimit ? limit : 0,
          modelFilter,
        })
        if (result.error) return { windows: [], error: clampError(result.error) }
        return { plan: opts.plan ?? "七牛云", ...result }
      },
    },

    // ---------- 该账号可用的模型 ----------
    provider: {
      id: PROVIDER,
      async models(provider, ctx = {}) {
        const known = provider?.models ?? declared
        const key = ctx?.auth?.type === "api" ? String(ctx.auth.key ?? "").trim() : ""
        const rows = await liveModelRows(key)
        if (!rows) return known // 原样返回：Magpie 会保留这份列表
        return selectModels({ ...known, ...buildModels(rows, known) }, opts)
      },
    },
  }
}

// 非函数导出，不会被当成插件调用；供单测使用
export const _internal = {
  PROVIDER,
  DEFAULT_BASE,
  KEYS_URL,
  KEYS_AKSK_PAGE,
  FREE_MODEL_FILTER,
  resolveBaseUrl,
  clampConcurrency,
  clampError,
  isKeyRejected,
  readCredentials,
  prettify,
  buildModels,
  selectModels,
  CATALOG,
  CATALOG_FETCHED_AT,
}
