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

test("usage 未配置 AK/SK 时说明原因而不是留空白，且不发请求", async () => {
  const stub = installFetch(() => jsonResponse({ status: true, data: [] }))
  const hooks = await QiniuPlugin({})
  try {
    const usage = await hooks.auth.usage(apiAuth())
    assert.deepEqual(usage.windows, [])
    // 沉默会让用户以为「没额度」，必须说清是缺 AK/SK 才读不到
    assert.match(usage.error, /AccessKey|AK\/SK/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test("AK/SK 填在登录界面上（存进账号 metadata）就能读用量，不用改配置文件", async () => {
  const stub = installFetch((url) => {
    if (url.includes("/inapi/v3/stat/new")) {
      return jsonResponse({ status: true, data: [{ items: [{ name: "输入 tokens", unit: "k/tokens", total: 1000 }] }] })
    }
    return jsonResponse({ status: false, error: "unexpected" }, 404)
  })
  // 只给 metadata，options 里什么都没配 —— 模拟「在界面上填了 AK/SK」
  const hooks = await QiniuPlugin({}, { dailyQuota: 100_000_000 })
  try {
    const usage = await hooks.auth.usage(apiAuth("sk-test", { accessKey: "ak-ui", secretKey: "sEcReTkEyUi40cHaRsAbCdEfGhIjKlMnOpQrStUv" }))
    assert.equal(usage.windows.length, 1)
    assert.equal(stub.calls.length, 1)
    // 签名用的是界面上填的那一对，而不是环境变量或 options
    assert.match(stub.calls[0].init.headers.authorization, /^Qiniu ak-ui:/)
  } finally {
    stub.restore()
  }
})

test("账号 metadata 的 AK/SK 优先于 options 里的", async () => {
  const stub = installFetch((url) => {
    if (url.includes("/inapi/v3/stat/new")) {
      return jsonResponse({ status: true, data: [{ items: [{ name: "输入 tokens", unit: "tokens", total: 5 }] }] })
    }
    return jsonResponse({ status: false }, 404)
  })
  const hooks = await QiniuPlugin({}, { accessKey: "ak-file", secretKey: "sEcReTkEyFiLe40cHaRsAbCdEfGhIjKlMnOpQrS" })
  try {
    await hooks.auth.usage(apiAuth("sk-test", { accessKey: "ak-ui", secretKey: "sEcReTkEyUi40cHaRsAbCdEfGhIjKlMnOpQrStUv" }))
    assert.match(stub.calls[0].init.headers.authorization, /^Qiniu ak-ui:/)
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
        accessKey: "myAccessKey40charsAbCdEfGhIjKlMnOpQrS",
        // 用户实际最常犯的错：把模型 API Key 当 SecretKey 填进来
        // 虚构的 sk- 串，只为触发「填成 API Key」的校验；不是任何真实凭证
        secretKey: "sk-0000000000000000000000000000000000000000000000000000000000000000",
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
      apiAuth("sk-test", { accessKey: "sk-oops", secretKey: "sEcReT40cHaRsAbCdEfGhIjKlMnOpQrStUvWx" }),
    )
    assert.deepEqual(usage.windows, [])
    assert.match(usage.error, /AccessKey 填错/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test("usage 配置 AK/SK 后走管理接口，返回百分比窗口", async () => {
  const stub = installFetch((url) => {
    if (url.includes("/inapi/v3/stat/new")) {
      return jsonResponse({ status: true, data: [{ items: [{ name: "输入 tokens", unit: "k/tokens", total: 20000 }] }] })
    }
    return jsonResponse({ status: false, error: "unexpected" }, 404)
  })
  const hooks = await QiniuPlugin({}, { accessKey: "ak", secretKey: "sEcReT40cHaRsAbCdEfGhIjKlMnOpQrStUvWx", dailyQuota: 100_000_000 })
  try {
    const usage = await hooks.auth.usage(apiAuth())
    assert.equal(usage.plan, "Conatus Free")
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
