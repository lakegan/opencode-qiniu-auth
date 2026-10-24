import test from "node:test"
import assert from "node:assert/strict"

import { compact, fetchTodayUsage, rfc3339, shanghaiDay, sumUsage, todayUsageWindow, tokenFactor } from "../lib/usage.mjs"

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

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

test("tokenFactor 识别 k/tokens 与普通 tokens", () => {
  assert.equal(tokenFactor("k/tokens"), 1000)
  assert.equal(tokenFactor("tokens"), 1)
  assert.equal(tokenFactor("", "文本输入 tokens"), 1)
  assert.equal(tokenFactor("次"), 0)
  assert.equal(tokenFactor("张"), 0)
})

test("sumUsage 汇总 token 计费项，跳过认不出的项", () => {
  const payload = {
    status: true,
    data: [
      {
        name: "qiniu/conatus-free",
        items: [
          { name: "输入 tokens", unit: "k/tokens", total: 12.5, values: [] },
          { name: "输出 tokens", unit: "k/tokens", total: 3.5, values: [] },
          { name: "请求", unit: "次", total: 4, values: [] },
        ],
      },
      {
        name: "deepseek/deepseek-v4-pro",
        items: [{ name: "输入 tokens", unit: "k/tokens", total: 1, values: [] }],
      },
    ],
  }
  const { tokens, requests } = sumUsage(payload)
  assert.equal(tokens, (12.5 + 3.5 + 1) * 1000)
  assert.equal(requests, 4)
})

test("sumUsage 对空/异常响应返回 0，不抛错", () => {
  assert.deepEqual(sumUsage(null), { tokens: 0, requests: 0 })
  assert.deepEqual(sumUsage({ data: "nope" }), { tokens: 0, requests: 0 })
  assert.deepEqual(sumUsage({ data: [{ items: [{ total: "x" }] }] }), { tokens: 0, requests: 0 })
})

test("fetchTodayUsage 成功路径会带签名头与时间窗", async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return jsonResponse({ status: true, data: [{ items: [{ name: "输入 tokens", unit: "k/tokens", total: 2 }] }] })
  }
  const result = await fetchTodayUsage({
    accessKey: "ak",
    secretKey: "sk",
    now: Date.parse("2026-10-24T20:52:00+08:00"),
    fetchImpl,
  })
  assert.equal(result.tokens, 2000)
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
    fetchImpl: async () => jsonResponse({ status: true, data: [{ items: [{ unit: "k/tokens", total: 1500 }] }] }),
  })
  const [w] = window.windows
  assert.equal(w.amount, 1_500_000)
  assert.equal(w.used, undefined)
  assert.equal(w.limit, undefined)
  // 没给上限就不能编剩余量，只报已用并说明怎么才能算剩余
  assert.equal(w.display, "已用 1.5M（配 dailyQuota 可算剩余）")
  assert.equal(new Date(w.resetsAt).toISOString(), "2026-10-24T16:00:00.000Z")
})

test("todayUsageWindow 传上限时给出百分比和剩余", async () => {
  const window = await todayUsageWindow({
    accessKey: "ak",
    secretKey: "sk",
    dailyLimit: 100_000_000,
    now: Date.parse("2026-10-24T20:52:00+08:00"),
    fetchImpl: async () => jsonResponse({ status: true, data: [{ items: [{ unit: "k/tokens", total: 25000 }] }] }),
  })
  const [w] = window.windows
  assert.equal(w.used, 25)
  assert.equal(w.limit, 100_000_000)
  // 剩余 = 上限 − 已用，直接说人话，而不是只丢一个百分比
  assert.equal(w.display, "剩余 75M / 共 100M（已用 25M）")
})

test("todayUsageWindow 已用超过上限时剩余按 0 算，百分比封顶 100", async () => {
  const window = await todayUsageWindow({
    accessKey: "ak",
    secretKey: "sk",
    dailyLimit: 1_000_000,
    now: Date.parse("2026-10-24T20:52:00+08:00"),
    fetchImpl: async () => jsonResponse({ status: true, data: [{ items: [{ unit: "tokens", total: 2_500_000 }] }] }),
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
