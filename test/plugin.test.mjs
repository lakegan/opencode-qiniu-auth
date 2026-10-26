import test from "node:test"
import assert from "node:assert/strict"

import { QiniuPlugin, _internal } from "../index.mjs"

const installFetch = (handler) => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status })

const apiAuth = (key = "sk-test", metadata) => async () => ({ type: "api", key, ...(metadata ? { metadata } : {}) })

const modelsPayload = {
  object: "list",
  data: [
    { id: "qiniu/conatus-free", object: "model", context_length: 1000000, max_tokens: 128000 },
    { id: "z-ai/glm-4.5-air-free", object: "model", context_length: 0, max_tokens: 0 },
    { id: "deepseek/deepseek-v4-pro", object: "model", context_length: 1000000, max_tokens: 384000 },
  ],
}

test("config 声明 qiniu 供应商与内置模型，且不覆盖已有配置", async () => {
  const hooks = await QiniuPlugin({})
  const cfg = {}
  await hooks.config(cfg)
  const provider = cfg.provider.qiniu
  assert.equal(provider.npm, "@ai-sdk/openai-compatible")
  assert.equal(provider.api, "https://api.qnaigc.com/v1")
  assert.ok(provider.models["conatus-free"])
  assert.equal(provider.models["conatus-free"].id, "qiniu/conatus-free")

  const preset = { provider: { qiniu: { name: "我自己配的", npm: "x", api: "y", models: {} } } }
  await hooks.config(preset)
  assert.equal(preset.provider.qiniu.name, "我自己配的")
})

test("auth 只提供一个 API Key 登录方式", async () => {
  const hooks = await QiniuPlugin({})
  assert.equal(hooks.auth.provider, "qiniu")
  assert.equal(hooks.auth.methods.length, 1)
  assert.equal(hooks.auth.methods[0].type, "api")
  assert.match(hooks.auth.methods[0].label, /七牛/)
  assert.equal(typeof hooks.auth.usage, "function")
})

test("登录时在界面上问 AK/SK，SecretKey 用掩码输入", async () => {
  const hooks = await QiniuPlugin({})
  const prompts = hooks.auth.methods[0].prompts ?? []
  const ak = prompts.find((p) => p.key === "accessKey")
  const sk = prompts.find((p) => p.key === "secretKey")
  assert.ok(ak, "要有 AccessKey 输入项")
  assert.ok(sk, "要有 SecretKey 输入项")
  assert.equal(ak.type, "text")
  // 密钥必须掩码，别在界面上明文显示
  assert.equal(sk.type, "password")
  // 两项都是可选的：只填 sk- 也能正常跑模型
  assert.doesNotMatch(ak.message, /必填/)
  assert.doesNotMatch(sk.message, /必填/)
})

test("loader 给出 baseURL / apiKey，且不把 key 写进 headers", async () => {
  const hooks = await QiniuPlugin({})
  const loader = await hooks.auth.loader(apiAuth("  sk-abc  "))
  assert.equal(loader.baseURL, "https://api.qnaigc.com/v1")
  assert.equal(loader.apiKey, "sk-abc")
  assert.equal(loader.headers, undefined)
  assert.equal(typeof loader.fetch, "function")
})

test("loader 在未登录时返回空对象", async () => {
  const hooks = await QiniuPlugin({})
  assert.deepEqual(await hooks.auth.loader(async () => undefined), {})
  assert.deepEqual(await hooks.auth.loader(async () => ({ type: "oauth" })), {})
})

test("loader.fetch 透传响应；密钥 401 时补 X-Magpie-Sign-In: expired", async () => {
  const hooks = await QiniuPlugin({})
  const loader = await hooks.auth.loader(apiAuth())

  const rejected = installFetch(() =>
    jsonResponse({ error: { message: "Invalid API key", code: "auth_api_key_invalid" } }, 401),
  )
  try {
    const res = await loader.fetch("https://api.qnaigc.com/v1/chat/completions", { method: "POST" })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("x-magpie-sign-in"), "expired")
    assert.deepEqual(await res.json(), { error: { message: "Invalid API key", code: "auth_api_key_invalid" } })
  } finally {
    rejected.restore()
  }

  const limited = installFetch(() => jsonResponse({ error: { message: "rate limit" } }, 429))
  try {
    const res = await loader.fetch("https://api.qnaigc.com/v1/chat/completions", { method: "POST" })
    assert.equal(res.status, 429)
    assert.equal(res.headers.get("x-magpie-sign-in"), null)
  } finally {
    limited.restore()
  }
})

test("loader.fetch 不改动成功响应", async () => {
  const hooks = await QiniuPlugin({})
  const loader = await hooks.auth.loader(apiAuth())
  const stub = installFetch(() => jsonResponse({ ok: true }))
  try {
    const res = await loader.fetch("https://api.qnaigc.com/v1/models")
    assert.equal(res.status, 200)
    assert.equal(res.headers.get("x-magpie-sign-in"), null)
    assert.deepEqual(await res.json(), { ok: true })
  } finally {
    stub.restore()
  }
})

test("provider.models 用线上列表覆盖内置快照，并保留本地已有模型", async () => {
  const hooks = await QiniuPlugin({})
  const stub = installFetch(() => jsonResponse(modelsPayload))
  try {
    const models = await hooks.provider.models(
      { models: { "conatus-free": { id: "qiniu/conatus-free", name: "Conatus（本地改名）" } } },
      { auth: { type: "api", key: "sk-test" } },
    )
    assert.equal(models["conatus-free"].name, "Conatus（本地改名）")
    assert.equal(models["deepseek-v4-pro"].id, "deepseek/deepseek-v4-pro")
    assert.equal(models["glm-4.5-air-free"].free, true)
    assert.equal(stub.calls[0].url, "https://api.qnaigc.com/v1/models")
    assert.equal(stub.calls[0].init.headers.authorization, "Bearer sk-test")
  } finally {
    stub.restore()
  }
})

test("provider.models 拉取失败时原样返回已有列表（Magpie 会保留）", async () => {
  const hooks = await QiniuPlugin({})
  const stub = installFetch(() => jsonResponse({ error: "boom" }, 500))
  const known = { "conatus-free": { id: "qiniu/conatus-free", name: "Conatus Free" } }
  try {
    const models = await hooks.provider.models({ models: known }, { auth: { type: "api", key: "sk-test" } })
    assert.deepEqual(models, known)
  } finally {
    stub.restore()
  }
})

test("provider.models 网络异常时也不抛错", async () => {
  const hooks = await QiniuPlugin({})
  const stub = installFetch(() => {
    throw new Error("ENOTFOUND")
  })
  const known = { "conatus-free": { id: "qiniu/conatus-free" } }
  try {
    assert.deepEqual(await hooks.provider.models({ models: known }, {}), known)
  } finally {
    stub.restore()
  }
})

// 评审意见：AK/SK 是可选项，缺省不该被渲染成故障。
// 早前返回 error，于是每个跳过这两项的账号都显示
// 「Allowance unavailable: 未填 AccessKey/SecretKey…」，像是坏了。
test("usage 未配置 AK/SK 时安静返回空窗口，不报错也不发请求", async () => {
  const stub = installFetch(() => jsonResponse({ status: true, data: [] }))
  const hooks = await QiniuPlugin({})
  try {
    const usage = await hooks.auth.usage(apiAuth())
    assert.deepEqual(usage.windows, [])
    // 可选字段缺失 ≠ 出错：不能带 error 字段，界面会把它渲染成故障态
    assert.equal(usage.error, undefined)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test("AK/SK 填在登录界面上（存进账号 metadata）就能读用量，不用改配置文件", async () => {
  const stub = installFetch((url) => {
    if (url.includes("/inapi/v3/stat/new")) {
      return jsonResponse({
        status: true,
        data: [
          {
            name: "qiniu/conatus-free",
            items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total: 1000 }],
          },
        ],
      })
    }
    return jsonResponse({ status: false, error: "unexpected" }, 404)
  })
  // options 里什么都没配 —— 模拟「只在界面上填了 AK/SK」
  const hooks = await QiniuPlugin({}, {})
  try {
    const usage = await hooks.auth.usage(apiAuth("sk-test", { accessKey: "ak-ui", secretKey: "fake-not-a-real-credential-01-xxxxxxxxxx" }))
    assert.equal(usage.windows.length, 1)
    assert.equal(stub.calls.length, 1)
    // 签名用的是界面上填的那一对
    assert.match(stub.calls[0].init.headers.authorization, /^Qiniu ak-ui:/)
  } finally {
    stub.restore()
  }
})

test("账号 metadata 的 AK/SK 优先于 options 里的", async () => {
  const stub = installFetch((url) => {
    if (url.includes("/inapi/v3/stat/new")) {
      return jsonResponse({
        status: true,
        data: [{ name: "qiniu/conatus-free", items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total: 5 }] }],
      })
    }
    return jsonResponse({ status: false }, 404)
  })
  const hooks = await QiniuPlugin({}, { accessKey: "ak-file", secretKey: "fake-not-a-real-credential-02-xxxxxxxxx" })
  try {
    await hooks.auth.usage(apiAuth("sk-test", { accessKey: "ak-ui", secretKey: "fake-not-a-real-credential-03-xxxxxxxxxx" }))
    assert.match(stub.calls[0].init.headers.authorization, /^Qiniu ak-ui:/)
  } finally {
    stub.restore()
  }
})

// 评审意见：AK/SK 不该退回环境变量。一个 QINIU_ACCESS_KEY 会被套到所有没填
// AK/SK 的账号上，查出来就是同一个人的用量；GUI 启动的 magpie 也读不到 shell 变量。
test("不读环境变量：只设了 QINIU_ACCESS_KEY/SECRET_KEY 时不发请求，也不显示用量", async () => {
  const saved = { ak: process.env.QINIU_ACCESS_KEY, sk: process.env.QINIU_SECRET_KEY }
  process.env.QINIU_ACCESS_KEY = "env-ak"
  process.env.QINIU_SECRET_KEY = "env-sk"
  const stub = installFetch(() => jsonResponse({ status: true, data: [] }))
  try {
    const hooks = await QiniuPlugin({}) // options 里没有 AK/SK
    const usage = await hooks.auth.usage(apiAuth())
    assert.equal(stub.calls.length, 0, "不能拿环境变量去查别人账号的用量")
    assert.deepEqual(usage.windows, [])
    // 环境变量没被读到，所以连「填错了」的提示都不该有
    assert.equal(usage.error, undefined)
  } finally {
    stub.restore()
    if (saved.ak === undefined) delete process.env.QINIU_ACCESS_KEY
    else process.env.QINIU_ACCESS_KEY = saved.ak
    if (saved.sk === undefined) delete process.env.QINIU_SECRET_KEY
    else process.env.QINIU_SECRET_KEY = saved.sk
  }
})

// 评审意见：不填 dailyQuota 时给出 1e8 的窗口是编的。窗口到 100% magpie 会挂起账号，
// 充值用户和用付费模型的用户都会被误伤，而且活动 2026-11-30 结束。
test("不填 dailyQuota 时只有已用量，没有 limit 也没有 used 百分比", async () => {
  const stub = installFetch(() =>
    jsonResponse({
      status: true,
      data: [
        {
          name: "qiniu/conatus-free",
          items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total: 2000 }],
        },
      ],
    }),
  )
  const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "sk" }) // 没填 dailyQuota
  try {
    const usage = await hooks.auth.usage(apiAuth())
    const [window] = usage.windows
    assert.equal(window.amount, 2_000_000)
    assert.equal(window.limit, undefined, "不能凭空造出每日上限")
    assert.equal(window.used, undefined, "没有上限就不该有百分比，否则 100% 会挂起账号")
    assert.match(window.display, /^已用 /)
    assert.equal(window.name, "今日已用")
  } finally {
    stub.restore()
  }
})

test("填了 dailyQuota 才出百分比，且只统计免费模型（活动额度只覆盖免费模型）", async () => {
  const stub = installFetch(() =>
    jsonResponse({
      status: true,
      data: [
        // 免费模型：计入活动额度
        { name: "qiniu/conatus-free", items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total: 20_000 }] },
        // 付费模型：不该算进活动额度
        { name: "deepseek/deepseek-v4-pro", items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total: 80_000 }] },
      ],
    }),
  )
  const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "sk", dailyQuota: 100_000_000 })
  try {
    const usage = await hooks.auth.usage(apiAuth())
    const [window] = usage.windows
    assert.equal(window.amount, 20_000_000, "只算 conatus-free 的 2e7，不含付费模型的 8e7")
    assert.equal(window.limit, 100_000_000)
    assert.equal(window.used, 20)
    assert.match(window.display, /剩余 80M/)
  } finally {
    stub.restore()
  }
})

test("不填 dailyQuota 时统计全部模型（不受免费过滤影响）", async () => {
  const stub = installFetch(() =>
    jsonResponse({
      status: true,
      data: [
        { name: "qiniu/conatus-free", items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total: 20_000 }] },
        { name: "deepseek/deepseek-v4-pro", items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total: 80_000 }] },
      ],
    }),
  )
  const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "sk" })
  try {
    const usage = await hooks.auth.usage(apiAuth())
    assert.equal(usage.windows[0].amount, 100_000_000, "2e7 + 8e7")
    assert.equal(usage.windows[0].used, undefined)
  } finally {
    stub.restore()
  }
})

test("默认套餐名是「七牛云」，不是活动名", async () => {
  const stub = installFetch(() =>
    jsonResponse({ status: true, data: [{ name: "qiniu/conatus-free", items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total: 1 }] }] }),
  )
  const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "sk" })
  try {
    const usage = await hooks.auth.usage(apiAuth())
    assert.equal(usage.plan, "七牛云")
  } finally {
    stub.restore()
  }
})

test("把 sk- 的 API Key 误填成 SecretKey 时，直说是填错了，而不是丢一个 401", async () => {
  const stub = installFetch(() => jsonResponse({ error: "bad token", error_code: "BadToken" }, 401))
  const hooks = await QiniuPlugin({})
  try {
    const usage = await hooks.auth.usage(
      apiAuth("sk-test", {
        accessKey: "fake-not-a-real-credential-04-xxxxxxx",
        // 用户实际最常犯的错：把模型 API Key 当 SecretKey 填进来
        // 虚构的 sk- 串，只为触发「填成 API Key」的校验；不是任何真实凭证
        secretKey: "sk-fake-model-api-key-not-real-05-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      }),
    )
    assert.deepEqual(usage.windows, [])
    assert.match(usage.error, /SecretKey 填错/)
    assert.match(usage.error, /sk-/)
    assert.match(usage.error, /密钥管理/)
    // 明确是配置错误，不必真去打接口
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test("AccessKey 误填成 sk- 时同样直接指出", async () => {
  const stub = installFetch(() => jsonResponse({ status: true, data: [] }))
  const hooks = await QiniuPlugin({})
  try {
    const usage = await hooks.auth.usage(
      apiAuth("sk-test", { accessKey: "sk-oops", secretKey: "fake-not-a-real-credential-06-xxxxxxx" }),
    )
    assert.deepEqual(usage.windows, [])
    assert.match(usage.error, /AccessKey 填错/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test("usage 配置 AK/SK 后走管理接口，返回百分比窗口", async () => {
  // 形状按七牛实测响应：计费项名在 key、单位在 unit_name、total 的单位是 unit_size_default 个 token
  const stub = installFetch((url) => {
    if (url.includes("/inapi/v3/stat/new")) {
      return jsonResponse({
        status: true,
        data: [
          {
            name: "qiniu/conatus-free",
            items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total: 20000 }],
          },
        ],
      })
    }
    return jsonResponse({ status: false, error: "unexpected" }, 404)
  })
  const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "fake-not-a-real-credential-07-xxxxxxx", dailyQuota: 100_000_000 })
  try {
    const usage = await hooks.auth.usage(apiAuth())
    assert.equal(usage.plan, "七牛云")
    const [window] = usage.windows
    assert.equal(window.amount, 20_000_000)
    assert.equal(window.used, 20)
    assert.equal(window.limit, 100_000_000)
    assert.match(window.display, /剩余 80M/)
    assert.equal(stub.calls[0].url.startsWith("https://api.qiniu.com/ai/inapi/v3/stat/new?"), true)
    assert.match(stub.calls[0].init.headers.authorization, /^Qiniu ak:/)
  } finally {
    stub.restore()
  }
})

test("usage 出错时返回 error 字段而不是抛异常", async () => {
  const stub = installFetch(() => jsonResponse({ error: "bad token", error_code: "BadToken" }, 401))
  const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "sk" })
  try {
    const usage = await hooks.auth.usage(apiAuth())
    assert.deepEqual(usage.windows, [])
    assert.match(usage.error, /AK\/SK/)
  } finally {
    stub.restore()
  }
})

// 回归：七牛把计费项名放在 `key`（cache/ncache/output）、单位放在 `unit_name`、
// 且 total 的单位是 unit_size_default(=1000) 个 token。早前按 name/unit 解析，
// token 恒为 0 → used 恒为 0 → 界面一直显示「剩余 100%」，看起来像没消耗。
test("真实响应字段（key/unit_name/unit_size_default）能算出席用量，不是恒 0", async () => {
  const stub = installFetch(() =>
    jsonResponse({
      status: true,
      data: [
        {
          name: "qiniu/conatus-free",
          items: [
            { key: "cache", unit_name: "token", unit_size_default: 1000, total: 537.1, values: [] },
            { key: "ncache", unit_name: "token", unit_size_default: 1000, total: 708.14, values: [] },
            { key: "output", unit_name: "token", unit_size_default: 1000, total: 15.73, values: [] },
          ],
        },
      ],
    }),
  )
  const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "sk", dailyQuota: 100_000_000 })
  try {
    const usage = await hooks.auth.usage(apiAuth())
    const [window] = usage.windows
    assert.equal(window.amount, 1_260_970, "1.26M token，不能是 0")
    assert.ok(window.used > 0, `used 必须动，实际 ${window.used}`)
    assert.equal(window.used, 1.26097)
    assert.notEqual(window.display, "剩余 100M / 共 100M（已用 0）")
  } finally {
    stub.restore()
  }
})

test("options.baseURL 支持海外接入点与省略 /v1", async () => {
  const hooks = await QiniuPlugin({}, { baseURL: "https://api.modelink.ai" })
  const cfg = {}
  await hooks.config(cfg)
  assert.equal(cfg.provider.qiniu.api, "https://api.modelink.ai/v1")
})

test("options.onlyFree 让内置与线上列表都只剩免费模型", async () => {
  const stub = installFetch(() => jsonResponse(modelsPayload))
  const hooks = await QiniuPlugin({}, { onlyFree: true })
  try {
    const cfg = {}
    await hooks.config(cfg)
    const builtin = Object.keys(cfg.provider.qiniu.models)
    assert.ok(builtin.length > 0)
    assert.ok(builtin.every((key) => /-free$/.test(key)), `非免费模型混入：${builtin.join(", ")}`)
    assert.ok(builtin.includes("conatus-free"))

    // 线上列表也与内置快照合并后过滤，付费模型（deepseek-v4-pro）不得出现
    const models = await hooks.provider.models({ models: cfg.provider.qiniu.models }, {})
    const keys = Object.keys(models)
    assert.ok(keys.every((key) => /-free$/.test(key)), `非免费模型混入：${keys.join(", ")}`)
    assert.equal(models["deepseek-v4-pro"], undefined)
    assert.ok(keys.includes("glm-4.5-air-free"))
  } finally {
    stub.restore()
  }
})

test("maxConcurrency 被夹到 1–1000", async () => {
  assert.equal((await QiniuPlugin({}, { maxConcurrency: 0 })).auth.maxConcurrency, 1)
  assert.equal((await QiniuPlugin({}, { maxConcurrency: 5000 })).auth.maxConcurrency, 1000)
  assert.equal((await QiniuPlugin({}, { maxConcurrency: "x" })).auth.maxConcurrency, 4)
})

test("_internal 暴露纯函数且不含插件函数，避免被当成插件加载", () => {
  assert.equal(typeof _internal, "object")
  for (const value of Object.values(_internal)) assert.notEqual(typeof value, "function" === typeof value ? "never" : "undefined")
  assert.equal(_internal.resolveBaseUrl(undefined), "https://api.qnaigc.com/v1")
  assert.equal(typeof _internal.buildModels, "function")
})

// ---------------------------------------------------------------------------
// 评审阻塞项 1：Magpie 只把供应商列表的**前 24 个**模型交给 agent
// ("agents see up to 24 of its models")。
// 按 id 字典序排时，大写开头的 bytedance/…、deepseek/… 吃满前 24，
// 小写开头的 qiniu/conatus-free、kimi-k3-free、glm-4.5-air-free、nemotron-…-free
// 全部落在外面 —— 也就是这个插件主打的东西，agent 一个都看不到。
// ---------------------------------------------------------------------------

const AGENT_MODEL_LIMIT = 24

/** 取 provider 真正交给 agent 的那部分顺序 */
const exposedOrder = (models) => Object.values(models).map((m) => m.id).slice(0, AGENT_MODEL_LIMIT)

test("内置快照不是按 id 字典序排的：免费模型排在最前", async () => {
  const hooks = await QiniuPlugin({})
  const cfg = {}
  await hooks.config(cfg)
  const ids = Object.values(cfg.provider.qiniu.models).map((m) => m.id)

  assert.ok(ids.length > AGENT_MODEL_LIMIT, "快照条目太少，这条测试没有意义")
  assert.equal(ids[0], "qiniu/conatus-free", "conatus-free 必须是第一个")

  const freeIds = ids.filter((id) => /-free$/.test(id))
  assert.ok(freeIds.length > 0, "快照里应该有免费模型")
  // 免费模型必须整体落在前 24 之内
  for (const id of freeIds) {
    assert.ok(
      ids.indexOf(id) < AGENT_MODEL_LIMIT,
      `${id} 排在第 ${ids.indexOf(id) + 1} 位，超过 agent 可见的 ${AGENT_MODEL_LIMIT} 个`,
    )
  }
})

test("线上列表返回的前 24 个模型里包含全部免费模型", async () => {
  // 用真实快照形状喂一份「线上列表」，只保留部分 id 是免费模型
  const live = _internal.CATALOG.slice().reverse() // 故意打乱顺序，验证排序不依赖输入顺序
  const payload = {
    object: "list",
    data: live.map(([id, context_length, max_tokens]) => ({ id, context_length, max_tokens })),
  }
  const stub = installFetch(() => jsonResponse(payload))
  const hooks = await QiniuPlugin({})
  try {
    const models = await hooks.provider.models({ models: {} }, { auth: { type: "api", key: "sk-test" } })
    const exposed = exposedOrder(models)
    const allFree = Object.values(models)
      .filter((m) => /-free$/.test(m.id))
      .map((m) => m.id)

    assert.ok(allFree.length > 0, "线上列表里应该有免费模型")
    for (const id of allFree) {
      assert.ok(exposed.includes(id), `${id} 被 24 条截断挡在外面`)
    }
    assert.equal(exposed[0], "qiniu/conatus-free")
  } finally {
    stub.restore()
  }
})

test("provider.models 的顺序与输入顺序无关", async () => {
  const makeRows = (rows) => ({
    object: "list",
    data: rows.map(([id, context_length, max_tokens]) => ({ id, context_length, max_tokens })),
  })
  const rows = _internal.CATALOG.slice(0, 40)

  const forward = installFetch(() => jsonResponse(makeRows(rows)))
  let a
  try {
    const hooks = await QiniuPlugin({})
    a = Object.values(await hooks.provider.models({ models: {} }, { auth: { type: "api", key: "sk-test" } })).map((m) => m.id)
  } finally {
    forward.restore()
  }

  const backward = installFetch(() => jsonResponse(makeRows([...rows].reverse())))
  let b
  try {
    const hooks = await QiniuPlugin({})
    b = Object.values(await hooks.provider.models({ models: {} }, { auth: { type: "api", key: "sk-test" } })).map((m) => m.id)
  } finally {
    backward.restore()
  }

  assert.deepEqual(a, b, "同一份列表换个顺序，agent 看到的模型顺序就变了")
})

// ---------------------------------------------------------------------------
// 评审阻塞项 3：已下线的模型不能永远挂在列表里
// 早前是 { ...known, ...buildModels(rows, known) }，known 作展开基底，
// 快照里每个 id 都会出现 —— 七牛下线模型后仍被提供，agent 选中就报错。
// ---------------------------------------------------------------------------

test("线上列表里没有的快照 id 不再出现", async () => {
  // 线上只剩 conatus-free，kimi-k3-free 已下线
  const payload = {
    object: "list",
    data: [{ id: "qiniu/conatus-free", object: "model", context_length: 1000000, max_tokens: 128000 }],
  }
  const stub = installFetch(() => jsonResponse(payload))
  const known = {
    "conatus-free": { id: "qiniu/conatus-free", name: "Conatus Free" },
    "kimi-k3-free": { id: "moonshotai/kimi-k3-free", name: "Kimi K3 Free" },
  }
  const hooks = await QiniuPlugin({})
  try {
    const models = await hooks.provider.models({ models: known }, { auth: { type: "api", key: "sk-test" } })
    const ids = Object.values(models).map((m) => m.id)
    assert.ok(ids.includes("qiniu/conatus-free"))
    assert.ok(!ids.includes("moonshotai/kimi-k3-free"), "已下线的模型不该继续提供")
  } finally {
    stub.restore()
  }
})

test("仍然在线的模型保留快照里的逐模型覆盖", async () => {
  const payload = {
    object: "list",
    data: [{ id: "qiniu/conatus-free", object: "model", context_length: 1000000, max_tokens: 128000 }],
  }
  const stub = installFetch(() => jsonResponse(payload))
  const known = { "conatus-free": { id: "qiniu/conatus-free", name: "我在本地改的名字" } }
  const hooks = await QiniuPlugin({})
  try {
    const models = await hooks.provider.models({ models: known }, { auth: { type: "api", key: "sk-test" } })
    assert.equal(models["conatus-free"].name, "我在本地改的名字", "覆盖不能因为改了驱动方式就失效")
  } finally {
    stub.restore()
  }
})

test("线上列表为空时回退到内置快照（有意的降级，不是 bug）", async () => {
  const stub = installFetch(() => jsonResponse({ object: "list", data: [] }))
  const known = { "conatus-free": { id: "qiniu/conatus-free" }, "kimi-k3-free": { id: "moonshotai/kimi-k3-free" } }
  const hooks = await QiniuPlugin({})
  try {
    const models = await hooks.provider.models({ models: known }, { auth: { type: "api", key: "sk-test" } })
    const ids = Object.values(models).map((m) => m.id)
    assert.ok(ids.includes("qiniu/conatus-free"))
    assert.ok(ids.includes("moonshotai/kimi-k3-free"), "拿不到线上数据时应该保留快照，而不是给空列表")
  } finally {
    stub.restore()
  }
})

// ---------------------------------------------------------------------------
// activityTier：七牛不返回套餐/认证状态，插件无法自动判断账号属于哪一档，
// 所以让用户声明档位名，由代码换算成数字，避免手填 100000000 时多一个零。
// ---------------------------------------------------------------------------

const usagePayload = (total) => ({
  status: true,
  data: [{ name: "qiniu/conatus-free", items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total }] }],
})

test("activityTier: verified 换算成 1e8", async () => {
  // 22000 个 unit_size_default(=1000) = 22,000,000 token
  const stub = installFetch(() => jsonResponse(usagePayload(22_000)))
  const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "sk", activityTier: "verified" })
  try {
    const [window] = (await hooks.auth.usage(apiAuth())).windows
    assert.equal(window.limit, 100_000_000)
    assert.equal(window.amount, 22_000_000)
    assert.equal(window.used, 22)
    assert.match(window.display, /剩余 78M \/ 共 100M/)
  } finally {
    stub.restore()
  }
})

test("activityTier: verified-plus 换算成 1e9", async () => {
  const stub = installFetch(() => jsonResponse(usagePayload(20_000)))
  const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "sk", activityTier: "verified-plus" })
  try {
    const [window] = (await hooks.auth.usage(apiAuth())).windows
    assert.equal(window.limit, 1_000_000_000)
    assert.equal(window.used, 2)
    assert.match(window.display, /剩余 980M \/ 共 1B/)
  } finally {
    stub.restore()
  }
})

test("activityTier 大小写与空格都容忍", async () => {
  const stub = installFetch(() => jsonResponse(usagePayload(1_000_000)))
  try {
    for (const tier of ["Verified", "  VERIFIED  ", "verified"]) {
      const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "sk", activityTier: tier })
      const [window] = (await hooks.auth.usage(apiAuth())).windows
      assert.equal(window.limit, 100_000_000, `档位 ${JSON.stringify(tier)} 没被识别`)
    }
  } finally {
    stub.restore()
  }
})

test("activityTier 填错时报错，而不是静默当成没有额度", async () => {
  const stub = installFetch(() => jsonResponse(usagePayload(1000)))
  const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "sk", activityTier: "pro" })
  try {
    const usage = await hooks.auth.usage(apiAuth())
    assert.deepEqual(usage.windows, [])
    assert.match(usage.error, /activityTier 填错了/)
    // 可选值要列出来，用户才知道该填什么
    assert.match(usage.error, /verified/)
    assert.match(usage.error, /verified-plus/)
    assert.equal(stub.calls.length, 0, "配置错了不必真去打接口")
  } finally {
    stub.restore()
  }
})

test("dailyQuota 手填数字优先于 activityTier", async () => {
  // 1000 个 unit_size_default(=1000) = 1,000,000 token
  const stub = installFetch(() => jsonResponse(usagePayload(1_000)))
  // 档位说 1e8，手填 5e7 —— 按手填的算
  const hooks = await QiniuPlugin(
    {},
    { accessKey: "ak", secretKey: "sk", activityTier: "verified", dailyQuota: 50_000_000 },
  )
  try {
    const [window] = (await hooks.auth.usage(apiAuth())).windows
    assert.equal(window.limit, 50_000_000)
    // 1,000,000 token / 50,000,000 = 2%
    assert.equal(window.used, 2)
  } finally {
    stub.restore()
  }
})

test("dailyQuota 非法值不挡住 activityTier", async () => {
  const stub = installFetch(() => jsonResponse(usagePayload(1_000_000)))
  const hooks = await QiniuPlugin(
    {},
    { accessKey: "ak", secretKey: "sk", activityTier: "verified-plus", dailyQuota: "abc" },
  )
  try {
    const [window] = (await hooks.auth.usage(apiAuth())).windows
    assert.equal(window.limit, 1_000_000_000, "非法 dailyQuota 应该忽略，退回档位")
  } finally {
    stub.restore()
  }
})

test("activityTier 与 dailyQuota 都不填时只报已用量", async () => {
  const stub = installFetch(() => jsonResponse(usagePayload(2_000_000)))
  const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "sk" })
  try {
    const [window] = (await hooks.auth.usage(apiAuth())).windows
    assert.equal(window.limit, undefined)
    assert.equal(window.used, undefined)
    assert.match(window.display, /^已用 /)
    assert.equal(window.name, "今日已用")
  } finally {
    stub.restore()
  }
})

test("resolveDailyLimit 优先级与档位表", () => {
  const { resolveDailyLimit, ACTIVITY_TIERS } = _internal
  assert.deepEqual(ACTIVITY_TIERS, { verified: 100_000_000, "verified-plus": 1_000_000_000 })

  assert.deepEqual(resolveDailyLimit({}), { limit: 0, source: null })
  assert.deepEqual(resolveDailyLimit({ activityTier: "verified" }), { limit: 1e8, source: "activityTier" })
  assert.deepEqual(resolveDailyLimit({ activityTier: "verified-plus" }), { limit: 1e9, source: "activityTier" })
  // 手填数字优先
  assert.deepEqual(resolveDailyLimit({ dailyQuota: 123, activityTier: "verified-plus" }), {
    limit: 123,
    source: "dailyQuota",
  })
  // 空字符串等于没填
  assert.deepEqual(resolveDailyLimit({ activityTier: "   " }), { limit: 0, source: null })
  assert.throws(() => resolveDailyLimit({ activityTier: "vip" }), /activityTier 填错了/)
})

test("有额度时只统计免费模型（activityTier 也要触发这个过滤）", async () => {
  const stub = installFetch(() =>
    jsonResponse({
      status: true,
      data: [
        { name: "qiniu/conatus-free", items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total: 20_000 }] },
        { name: "deepseek/deepseek-v4-pro", items: [{ key: "output", unit_name: "token", unit_size_default: 1000, total: 80_000 }] },
      ],
    }),
  )
  const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "sk", activityTier: "verified" })
  try {
    const [window] = (await hooks.auth.usage(apiAuth())).windows
    assert.equal(window.amount, 20_000_000, "只算 conatus-free 的 2e7，不含付费模型的 8e7")
    assert.equal(window.model, "-free")
  } finally {
    stub.restore()
  }
})

// ---------------------------------------------------------------------------
// 活动规则（2026-10 核对）：
//   verified       实名认证                     → 1 亿 token / 天
//   verified-plus  实名 + 累计充值满 100 元       → 10 亿 token / 天
//   截止 2026-11-30，到期后档位不再代表任何真实额度。
// ---------------------------------------------------------------------------

test("档位表与活动规则一致：实名 1 亿 / 实名+充值满 100 元 10 亿", () => {
  const { ACTIVITY_TIERS, TIER_HINTS } = _internal
  assert.equal(ACTIVITY_TIERS.verified, 100_000_000)
  assert.equal(ACTIVITY_TIERS["verified-plus"], 1_000_000_000)
  // 提示里要写清判定条件，只说数字用户没法确认自己属于哪一档
  assert.match(TIER_HINTS.verified, /实名/)
  assert.match(TIER_HINTS["verified-plus"], /充值/)
  assert.match(TIER_HINTS["verified-plus"], /100/)
})

test("活动截止 2026-11-30：之前有效，之后失效", () => {
  const { activityExpired } = _internal
  // 2026-11-30 23:00 北京时间 —— 仍在活动期内
  assert.equal(activityExpired(Date.parse("2026-11-30T23:00:00+08:00")), false)
  // 2026-12-01 00:01 北京时间 —— 已过期
  assert.equal(activityExpired(Date.parse("2026-12-01T00:01:00+08:00")), true)
  // 今天（2026-10-26）当然还没过期
  assert.equal(activityExpired(Date.parse("2026-10-26T12:00:00+08:00")), false)
})

test("活动过期后档位不再产出额度（避免又编造额度）", () => {
  const { resolveDailyLimit } = _internal
  const expired = Date.parse("2026-12-01T00:01:00+08:00")

  const r = resolveDailyLimit({ activityTier: "verified" }, expired)
  assert.equal(r.limit, 0, "活动结束后不能再按 1 亿算百分比")
  assert.equal(r.expired, true, "要标记为过期，好在卡片上说明原因")

  // 手填 dailyQuota 不受活动期影响：用户填的可能是活动之外的额度
  assert.equal(resolveDailyLimit({ dailyQuota: 12345 }, expired).limit, 12345)
})

test("活动过期且仍配着档位时，卡片说明原因但仍报已用量", async () => {
  const stub = installFetch(() => jsonResponse(usagePayload(2_000)))
  const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "sk", activityTier: "verified" })
  try {
    // 直接调 todayUsageWindow，注入一个活动期后的时间点
    const { todayUsageWindow } = await import("../lib/usage.mjs")
    const result = await todayUsageWindow({
      accessKey: "ak",
      secretKey: "sk",
      dailyLimit: 0,
      modelFilter: "-free",
      expiredTier: "verified",
      // 2026-12-01：活动已结束
      now: Date.parse("2026-12-01T10:00:00+08:00"),
    })
    const [window] = result.windows
    assert.equal(window.limit, undefined, "过期后不能凭空给出上限")
    assert.equal(window.used, undefined)
    assert.equal(window.amount, 2_000_000, "已用量照报")
    assert.match(window.display, /活动档位 verified 已于 2026-11-30 结束/)
  } finally {
    stub.restore()
    void hooks
  }
})
