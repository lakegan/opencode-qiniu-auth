// 今日用量（AK/SK 管理接口）：GET https://api.qiniu.com/ai/inapi/v3/stat/new
//
// 实测响应（2026-10-25）：
//   {
//     "status": true,
//     "data": [
//       { "name": "qiniu/conatus-free",
//         "items": [
//           { "key": "cache",  "unit_name": "token", "unit_size_default": 1000,
//             "total": 537.1, "values": [{ "time": "2026-10-25", "value": 537.1 }] },
//           { "key": "ncache", "unit_name": "token", "unit_size_default": 1000, "total": 708.14, … },
//           { "key": "output", "unit_name": "token", "unit_size_default": 1000, "total": 15.73,  … }
//         ] }
//     ]
//   }
//
// 三个易踩的点：
//   1. 计费项名在 `key`（cache / ncache / output），不是 `name`；`name` 在组上，是模型 id。
//   2. 单位在 `unit_name`（"token"），不是 `unit`。
//   3. `total` 是「多少个 unit_size_default」，上面 unit_size_default=1000，
//      所以 total=537.1 其实是 537,100 token，不是 537 个。漏乘就是少算三个数量级。
//
// 重要：七牛没有公开「免费额度剩余」接口，只给已消耗量。
// 所以每日额度上限只能由 options.dailyQuota 给（不填就只显示已用量、不出百分比），
// 避免把 1 亿 / 10 亿两种活动档位猜错。

import { qiniuAuthorization } from "./sign.mjs"

const HOST = "api.qiniu.com"
const STAT_PATH = "/ai/inapi/v3/stat/new"
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000

const pad = (n) => String(n).padStart(2, "0")

/** 北京时间当天 00:00 ~ 次日 00:00 的毫秒时间戳 */
export function shanghaiDay(now = Date.now()) {
  const shifted = new Date(now + SHANGHAI_OFFSET)
  const startLocal = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  const start = startLocal - SHANGHAI_OFFSET
  return { start, end: start + 24 * 60 * 60 * 1000 }
}

/** 毫秒 → RFC3339（+08:00） */
export function rfc3339(ms) {
  const d = new Date(ms + SHANGHAI_OFFSET)
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`
  )
}

/** 1234567 → "1.23M" */
export function compact(n) {
  const value = Number(n)
  if (!Number.isFinite(value)) return "0"
  const abs = Math.abs(value)
  for (const [base, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ]) {
    if (abs >= base) {
      const scaled = value / base
      return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(2).replace(/\.?0+$/, "")}${suffix}`
    }
  }
  return String(Math.round(value))
}

/** 取字符串字段，兼容七牛历史命名 */
const field = (item, ...keys) => {
  for (const k of keys) {
    const v = item?.[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

/**
 * 计费项 → 每个「total 单位」折算多少 token。
 * 不是 token 类计费项（请求数、存储等）返回 0，由调用方另算。
 *
 * 七牛现在用 `unit_name` + `unit_size_default` 表达：
 *   unit_name="token", unit_size_default=1000  → 1 个 total = 1000 token
 * 早期/其他接口可能用 `unit` 字符串（`k/tokens`、`百万token`），一并兼容。
 */
export function tokenFactor(item) {
  const unitName = field(item, "unit_name", "unit").toLowerCase()
  const key = field(item, "key", "name").toLowerCase()
  // 计费项名（cache/ncache/output）不含 "token"，单位名里才有，所以主要看 unit
  const source = unitName.includes("token") ? unitName : key.includes("token") ? key : ""
  if (!source) return 0

  // 首选显式乘数：unit_size_default 就是「1 个 total 等于多少 token」
  const size = Number(item?.unit_size_default ?? item?.unitSizeDefault)
  if (Number.isFinite(size) && size > 0) return size

  // 没有显式乘数时，从单位串里猜
  if (/^k\//.test(source) || /千\s*token/.test(source)) return 1000
  if (/百万|m\/token|m\s*token/.test(source)) return 1e6
  return 1
}

/**
 * 从 /stat/new 响应累加 token 用量。
 * @param {object} payload
 * @param {object} [options]
 * @param {string} [options.modelFilter] 只统计 name（模型 id）包含该词的组
 */
export function sumUsage(payload, { modelFilter } = {}) {
  const groups = Array.isArray(payload?.data) ? payload.data : []
  const needle = String(modelFilter ?? "").trim().toLowerCase()
  let tokens = 0
  let requests = 0
  const byModel = {}

  for (const group of groups) {
    const model = field(group, "name")
    if (needle && !model.toLowerCase().includes(needle)) continue
    const items = Array.isArray(group?.items) ? group.items : []
    let groupTokens = 0

    for (const item of items) {
      const total = Number(item?.total)
      if (!Number.isFinite(total)) continue
      const factor = tokenFactor(item)
      if (factor) {
        groupTokens += total * factor
        continue
      }
      if (/^(次|请求|requests?)$/i.test(field(item, "unit_name", "unit"))) requests += total
    }

    tokens += groupTokens
    if (model) byModel[model] = (byModel[model] ?? 0) + groupTokens
  }
  return { tokens, requests, byModel }
}

/**
 * 查询账户今天的 token 用量。
 * @returns {Promise<{ tokens?: number, requests?: number, byModel?: object, day?: object, error?: string }>}
 */
export async function fetchTodayUsage({
  accessKey,
  secretKey,
  modelFilter,
  now = Date.now(),
  fetchImpl = fetch,
}) {
  const day = shanghaiDay(now)
  const query = new URLSearchParams({
    start: rfc3339(day.start),
    end: rfc3339(Math.min(now, day.end)),
    g: "day",
  }).toString()
  const path = `${STAT_PATH}?${query}`

  let res
  try {
    res = await fetchImpl(`https://${HOST}${path}`, {
      headers: {
        authorization: qiniuAuthorization(accessKey, secretKey, "GET", path, HOST),
        accept: "application/json",
      },
    })
  } catch (err) {
    return { error: `连接七牛用量接口失败：${err?.message ?? err}` }
  }

  const text = await res.text().catch(() => "")
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    /* 非 JSON，落到下面的错误分支 */
  }

  if (res.status === 401 || res.status === 403) {
    return { error: `七牛拒绝了 AK/SK（HTTP ${res.status}），请检查 AccessKey/SecretKey` }
  }
  if (!res.ok) {
    const detail = payload?.error ?? text.slice(0, 120)
    return { error: `用量接口返回 HTTP ${res.status}${detail ? `：${detail}` : ""}` }
  }
  if (payload?.status === false) {
    return { error: `用量接口返回失败：${payload?.error ?? "未知原因"}` }
  }

  const usage = sumUsage(payload, { modelFilter })
  return { ...usage, day }
}

/**
 * 组装 magpie auth.usage 钩子的返回值。
 * @param {object} input
 * @param {string} input.accessKey
 * @param {string} input.secretKey
 * @param {number} [input.dailyLimit] 每日 token 上限；>0 才显示百分比
 * @param {string} [input.plan] 套餐名，显示在账号上
 * @param {string} [input.modelFilter] 只统计 id 含该词的模型
 * @param {string} [input.expiredTier] 用户配了但已过期的活动档位名；
 *   有值时说明「为什么没有剩余额度」，但仍只报已用量
 */
export async function todayUsageWindow({
  accessKey,
  secretKey,
  dailyLimit = 0,
  plan,
  modelFilter,
  expiredTier,
  now = Date.now(),
  fetchImpl = fetch,
}) {
  const usage = await fetchTodayUsage({ accessKey, secretKey, modelFilter, now, fetchImpl })
  if (usage.error) return { windows: [], error: usage.error, ...(plan ? { plan } : {}) }

  const tokens = usage.tokens ?? 0
  const day = usage.day ?? shanghaiDay(now)
  const limit = Number(dailyLimit) > 0 ? Number(dailyLimit) : 0
  const left = limit ? Math.max(0, limit - tokens) : 0

  // 活动到期后仍配着档位：说清楚原因，而不是给一个「没有额度」的空窗口
  const expiredNote = expiredTier
    ? `（活动档位 ${expiredTier} 已于 2026-11-30 结束，如需显示剩余请填 dailyQuota）`
    : "（配 dailyQuota 可算剩余）"

  // magpie 的窗口字段只认 name/used/resetsAt/display/amount/limit/unit/span，
  // 没有 remaining：剩余量只能由 display 这个字符串自己说清楚。
  // used 是 0–100 的百分比（参照 cline 插件：used: (100 * used) / total）。
  const window = {
    name: limit ? "今日额度" : "今日已用",
    span: 24 * 60 * 60,
    resetsAt: new Date(day.end).toISOString(),
    amount: tokens,
    unit: "tokens",
    display: limit
      ? `剩余 ${compact(left)} / 共 ${compact(limit)}（已用 ${compact(tokens)}）`
      : `已用 ${compact(tokens)}${expiredNote}`,
    ...(limit ? { used: Math.min(100, (tokens / limit) * 100), limit } : {}),
    ...(modelFilter ? { model: modelFilter } : {}),
  }

  return {
    ...(plan ? { plan } : {}),
    windows: [window],
  }
}
