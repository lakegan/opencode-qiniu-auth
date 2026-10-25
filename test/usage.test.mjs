import test from "node:test"
import assert from "node:assert/strict"

import { compact, fetchTodayUsage, rfc3339, shanghaiDay, sumUsage, todayUsageWindow, tokenFactor } from "../lib/usage.mjs"

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// 七牛 /stat/new 的真实响应形状（2026-10-25 实测抓取）：
// 计费项名在 `key`，单位在 `unit_name`，`total` 的单位是 `unit_size_default` 个 token。
const realPayload = (overrides = {}) => ({
  status: true,
  data: [
    {
      name: "qiniu/conatus-free",
      items: [
        { key: "cache", unit_name: "token", unit_size_default: 1000, total: 537.1, values: [{ time: "2026-10-25", value: 537.1 }] },
        { key: "ncache", unit_name: "token", unit_size_default: 1000, total: 708.14, values: [{ time: "2026-10-25", value: 708.14 }] },
        { key: "output", unit_name: "token", unit_size_default: 1000, total: 15.73, values: [{ time: "2026-10-25", value: 15.73 }] },
      ],
      ...overrides,
    },
  ],
})

test("shanghaiDay 对齐北京时间零点", () => {
  // 2026-10-24 20:52 +08:00
  const now = Date.parse("2026-10-24T20:52:00+08:00")
  const { start, end } = shanghaiDay(now)
  assert.equal(end - start, 24 * 60 * 60 * 1000)
  assert.equal(new Date(start).toISOString(), "2026-10-23T16:00:00.000Z") // = 北京时间 10-24 00:00
  assert.equal(new Date(end).toISOString(), "2026-10-24T16:00:00.000Z")
})

test("rfc3339 输出 +08:00 后缀", () => {
  const ms = Date.parse("2026-10-24T00:00:00+08:00")
  assert.equal(rfc3339(ms), "2026-10-24T00:00:00+08:00")
})

test("tokenFactor 用 unit_size_default 当乘数（七牛真实字段）", () => {
  // 单位名 "token"，但 total 的单位是 1000 token —— 漏乘就是少算三个数量级
  assert.equal(tokenFactor({ key: "output", unit_name: "token", unit_size_default: 1000 }), 1000)
  assert.equal(tokenFactor({ key: "cache", unit_name: "token", unit_size_default: 1000 }), 1000)
  // 没有显式乘数时，默认 1 个 total = 1 token
  assert.equal(tokenFactor({ key: "output", unit_name: "token" }), 1)
})

test("tokenFactor 兼容老的 name/unit 字段名与 k/百万 前缀", () => {
  assert.equal(tokenFactor({ name: "输入 tokens", unit: "k/tokens" }), 1000)
  assert.equal(tokenFactor({ name: "输出 tokens", unit: "百万token" }), 1e6)
  assert.equal(tokenFactor({ name: "输入 tokens" }), 1)
  // 非 token 计费项返回 0，由调用方另算
  assert.equal(tokenFactor({ key: "requests", unit_name: "次" }), 0)
  assert.equal(tokenFactor({ key: "storage", unit_name: "GB" }), 0)
  assert.equal(tokenFactor({}), 0)
})

test("sumUsage 汇总七牛真实的 cache/ncache/output 三项", () => {
  const { tokens, requests, byModel } = sumUsage(realPayload())
  // (537.1 + 708.14 + 15.73) × 1000
  assert.equal(tokens, 1_260_970)
  assert.equal(requests, 0)
  assert.equal(byModel["qiniu/conatus-free"], 1_260_970)
})

test("sumUsage 遇到没有 unit_size_default 的老响应也不炸", () => {
  const payload = {
    status: true,
    data: [
      {
        name: "qiniu/conatus-free",
        items: [{ key: "output", unit_name: "token", total: 120 }],
      },
    ],
  }
  assert.equal(sumUsage(payload).tokens, 120)
})

test("sumUsage 可按模型过滤（modelFilter）", () => {
  const payload = {
    status: true,
    data: [
      { name: "qiniu/conatus-free", items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total: 10 }] },
      { name: "moonshotai/kimi-k3-free", items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total: 3 }] },
    ],
  }
  assert.equal(sumUsage(payload).tokens, 13_000)
  assert.equal(sumUsage(payload, { modelFilter: "conatus" }).tokens, 10_000)
  assert.equal(sumUsage(payload, { modelFilter: "kimi" }).tokens, 3_000)
  assert.equal(sumUsage(payload, { modelFilter: "不存在" }).tokens, 0)
})

test("sumUsage 对空/异常响应返回 0，不抛错", () => {
  assert.deepEqual(sumUsage(null), { tokens: 0, requests: 0, byModel: {} })
  assert.deepEqual(sumUsage({ data: "nope" }), { tokens: 0, requests: 0, byModel: {} })
  assert.deepEqual(sumUsage({ data: [{ items: [{ total: "x" }] }] }), { tokens: 0, requests: 0, byModel: {} })
})

test("fetchTodayUsage 成功路径会带签名头与时间窗", async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return jsonResponse(realPayload())
  }
  const result = await fetchTodayUsage({
    accessKey: "ak",
    secretKey: "sk",
    now: Date.parse("2026-10-24T20:52:00+08:00"),
    fetchImpl,
  })
  assert.equal(result.tokens, 1_260_970)
  assert.ok(seen.url.startsWith("https://api.qiniu.com/ai/inapi/v3/stat/new?"))
  assert.match(seen.init.headers.authorization, /^Qiniu ak:/)
  assert.match(decodeURIComponent(seen.url), /start=2026-10-24T00:00:00\+08:00/)
  assert.match(decodeURIComponent(seen.url), /g=day/)
})

test("fetchTodayUsage 401 给出可执行的错误提示", async () => {
  const result = await fetchTodayUsage({
    accessKey: "ak",
    secretKey: "sk",
    fetchImpl: async () => jsonResponse({ error: "bad token", error_code: "BadToken" }, 401),
  })
  assert.match(result.error, /AK\/SK/)
  assert.equal(result.tokens, undefined)
})

test("fetchTodayUsage 网络异常不抛错", async () => {
  const result = await fetchTodayUsage({
    accessKey: "ak",
    secretKey: "sk",
    fetchImpl: async () => {
      throw new Error("ECONNRESET")
    },
  })
  assert.match(result.error, /ECONNRESET/)
})

test("todayUsageWindow 不传上限时只显示已用量，不出百分比", async () => {
  const window = await todayUsageWindow({
    accessKey: "ak",
    secretKey: "sk",
    now: Date.parse("2026-10-24T20:52:00+08:00"),
    fetchImpl: async () => jsonResponse(realPayload()),
  })
  const [w] = window.windows
  assert.equal(w.amount, 1_260_970)
  assert.equal(w.used, undefined)
  assert.equal(w.limit, undefined)
  // 没给上限就不能编剩余量，只报已用并说明怎么才能算剩余
  assert.equal(w.display, "已用 1.26M（配 dailyQuota 可算剩余）")
  assert.equal(new Date(w.resetsAt).toISOString(), "2026-10-24T16:00:00.000Z")
})

test("todayUsageWindow 传上限时给出百分比和剩余（真的动，不再是恒 0）", async () => {
  const window = await todayUsageWindow({
    accessKey: "ak",
    secretKey: "sk",
    dailyLimit: 100_000_000,
    now: Date.parse("2026-10-24T20:52:00+08:00"),
    fetchImpl: async () => jsonResponse(realPayload()),
  })
  const [w] = window.windows
  // 1,260,970 / 100,000,000 ≈ 1.26% —— 关键回归：之前这里是恒 0，界面才一直显示剩余 100%
  assert.ok(w.used > 0, `used 应大于 0，实际 ${w.used}`)
  assert.equal(w.used, 1.26097)
  assert.equal(w.limit, 100_000_000)
  assert.equal(w.display, "剩余 98.74M / 共 100M（已用 1.26M）")
})

test("todayUsageWindow 已用超过上限时剩余按 0 算，百分比封顶 100", async () => {
  const window = await todayUsageWindow({
    accessKey: "ak",
    secretKey: "sk",
    dailyLimit: 1_000_000,
    now: Date.parse("2026-10-24T20:52:00+08:00"),
    fetchImpl: async () =>
      jsonResponse({
        status: true,
        data: [{ name: "qiniu/conatus-free", items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total: 2500 }] }],
      }),
  })
  const [w] = window.windows
  assert.equal(w.used, 100)
  assert.equal(w.display, "剩余 0 / 共 1M（已用 2.5M）")
})

test("todayUsageWindow 出错时把错误放进窗口位置，不影响账号", async () => {
  const window = await todayUsageWindow({
    accessKey: "ak",
    secretKey: "sk",
    fetchImpl: async () => jsonResponse({ error: "bad token" }, 401),
  })
  assert.deepEqual(window.windows, [])
  assert.match(window.error, /AK\/SK/)
})

test("compact 输出易读数量", () => {
  assert.equal(compact(0), "0")
  assert.equal(compact(999), "999")
  assert.equal(compact(1500), "1.5K")
  assert.equal(compact(1_500_000), "1.5M")
  assert.equal(compact(100_000_000), "100M")
  assert.equal(compact(2_000_000_000), "2B")
  assert.equal(compact(undefined), "0")
})
