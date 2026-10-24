// 今日用量（AK/SK 管理接口）：GET https://api.qiniu.com/ai/inapi/v3/stat/new
//
// 响应结构（MaaS OpenAPI v1.0.0）：
//   { status, data: [ { name, items: [ { name, unit, total, values: [{ time, value }] } ] } ] }
//
// unit 是自由字符串，token 类计费项常见 `k/tokens`（千 token），另有 `次`。
// 这里做宽松解析：unit 或计费项名里出现 token 就按 token 累加，并识别 k / 百万 前缀；
// 认不出的计费项直接跳过，不猜。
//
// 重要：七牛没有公开「免费额度剩余」接口，只给已消耗量。
// 所以每日额度上限只能由用户在 options.dailyTokenLimit 里填（不填就只显示已用量、
// 不出百分比），避免把 1 亿 / 10 亿两种活动档位猜错。

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

/** unit/name → 每单位 token 数；不是 token 计费项返回 0 */
export function tokenFactor(unit, name = "") {
  const rawUnit = String(unit ?? "").toLowerCase()
  const rawName = String(name ?? "").toLowerCase()
  const source = rawUnit.includes("token") ? rawUnit : rawName.includes("token") ? rawName : ""
  if (!source) return 0
  if (/^k\//.test(source) || /千\s*token/.test(source)) return 1000
  if (/百万|m\/token|m\s*token/.test(source)) return 1e6
  return 1
}

/** 从 /stat/new 响应累加当天 token 与请求数 */
export function sumUsage(payload) {
  const groups = Array.isArray(payload?.data) ? payload.data : []
  let tokens = 0
  let requests = 0
  for (const group of groups) {
    const items = Array.isArray(group?.items) ? group.items : []
    for (const item of items) {
      const total = Number(item?.total)
      if (!Number.isFinite(total)) continue
      const factor = tokenFactor(item?.unit, item?.name)
      if (factor) {
        tokens += total * factor
        continue
      }
      if (/^(次|请求|requests?)$/i.test(String(item?.unit ?? "").trim())) requests += total
    }
  }
  return { tokens, requests }
}

/**
 * 查询账户今天的 token 用量。
 * @returns {Promise<{ tokens?: number, requests?: number, day?: object, error?: string }>}
 */
export async function fetchTodayUsage({ accessKey, secretKey, now = Date.now(), fetchImpl = fetch }) {
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

  const { tokens, requests } = sumUsage(payload)
  return { tokens, requests, day }
}

/**
 * 组装 magpie auth.usage 钩子的返回值。
 * @param {object} input
 * @param {string} input.accessKey
 * @param {string} input.secretKey
 * @param {number} [input.dailyLimit] 每日 token 上限；>0 才显示百分比
 * @param {string} [input.plan] 套餐名，显示在账号上
 * @param {string} [input.modelFilter] 只统计 id 含该词的模型
 */
export async function todayUsageWindow({
  accessKey,
  secretKey,
  dailyLimit = 0,
  plan,
  modelFilter,
  now = Date.now(),
  fetchImpl = fetch,
}) {
  const usage = await fetchTodayUsage({ accessKey, secretKey, now, fetchImpl })
  if (usage.error) return { windows: [], error: usage.error, ...(plan ? { plan } : {}) }

  const tokens = usage.tokens ?? 0
  const day = usage.day ?? shanghaiDay(now)
  const limit = Number(dailyLimit) > 0 ? Number(dailyLimit) : 0
  const left = limit ? Math.max(0, limit - tokens) : 0

  // magpie 的窗口字段只认 name/used/resetsAt/display/amount/limit/unit/span，
  // 没有 remaining：剩余量只能由 display 这个字符串自己说清楚。
  // 七牛只给「已消耗」，不公开「剩余额度」，所以 limit 必须由 options.dailyQuota 给，
  // 没给就只报已用量，绝不编一个剩余数出来。
  const window = {
    name: limit ? "今日额度" : "今日已用",
    span: 24 * 60 * 60,
    resetsAt: new Date(day.end).toISOString(),
    amount: tokens,
    unit: "tokens",
    ...(limit ? { used: Math.min(100, Math.round((tokens / limit) * 100)), limit } : {}),
    display: limit
      ? `剩余 ${compact(left)} / 共 ${compact(limit)}（已用 ${compact(tokens)}）`
      : `已用 ${compact(tokens)}（配 dailyQuota 可算剩余）`,
    ...(modelFilter ? { model: modelFilter } : {}),
  }

  return {
    ...(plan ? { plan } : {}),
    windows: [window],
  }
}
