// 像 Magpie 一样加载这个插件，检查钩子形状。
// 用法：node scripts/check.mjs
//
// 只做静态/离线检查：不登录、不发模型请求，唯一的外网调用是 GET /v1/models
// （可匿名访问）。想验证真实调用请用 magpie provider test。
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const failures = []
const notes = []

const check = (ok, message) => {
  if (ok) return
  failures.push(message)
}

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
check(typeof pkg.name === "string" && pkg.name, "package.json 缺 name")
check(pkg.type === "module", "package.json 的 type 必须是 module")
check(typeof pkg.main === "string", "package.json 缺 main")

const mod = await import(new URL(`file://${join(root, pkg.main)}`).href)
const exported = Object.entries(mod)
const pluginFns = exported.filter(([, value]) => typeof value === "function")

// Magpie 会把入口的每个导出函数都当成插件调用
check(pluginFns.length === 1, `入口导出了 ${pluginFns.length} 个函数，Magpie 会全部当成插件（应只有 1 个）`)

const logs = []
const input = { client: { app: { log: ({ body }) => logs.push(body) } } }
const hooks = await pluginFns[0][1](input, {})

check(typeof hooks.config === "function", "缺 config 钩子")
check(hooks.auth && typeof hooks.auth === "object", "缺 auth 钩子")
check(typeof hooks.auth.loader === "function", "auth 缺 loader")
check(Array.isArray(hooks.auth.methods) && hooks.auth.methods.length > 0, "auth.methods 为空")
check(hooks.provider && typeof hooks.provider.models === "function", "缺 provider.models")
check(hooks.auth.provider === hooks.provider.id, "auth.provider 与 provider.id 必须一致（模型 id 靠它拼）")

const cfg = {}
await hooks.config(cfg)
const provider = cfg.provider?.[hooks.auth.provider]
check(!!provider, "config 没有声明供应商")
if (provider) {
  check(["openai-compatible", "openai"].some((api) => String(provider.npm).includes(api)), `npm 建议用 openai-compatible，实际 ${provider.npm}`)
  const models = provider.models ?? {}
  check(Object.keys(models).length > 0, "内置模型为空")
  for (const [key, model] of Object.entries(models)) {
    check(/^[a-z0-9._-]+$/i.test(key), `模型 key 含非法字符：${key}`)
    check(typeof model.id === "string" && model.id, `模型 ${key} 缺 id（请求体里的 model 会落空）`)
    check(model.limit?.context > 0, `模型 ${key} 上下文为 0`)
    check(model.limit?.output > 0 && model.limit.output <= model.limit.context, `模型 ${key} 输出上限异常`)
  }
  notes.push(`内置模型 ${Object.keys(models).length} 个，免费 ${Object.values(models).filter((m) => m.free).length} 个`)
}

// provider.models 联网一次，确认线上清单可解析
const online = await hooks.provider.models({ models: provider?.models ?? {} }, { auth: undefined })
const onlineKeys = Object.keys(online ?? {})
check(onlineKeys.length > 0, "provider.models 返回空列表")
notes.push(`线上模型 ${onlineKeys.length} 个`)

if (!onlineKeys.includes("conatus-free")) notes.push("线上清单里没有 conatus-free（活动可能已结束，或七牛改了 id）")

// loader 只检查形状，不填真 key
const loader = await hooks.auth.loader(async () => ({ type: "api", key: "sk-check-only" }))
check(typeof loader.baseURL === "string" && loader.baseURL.startsWith("https://"), "loader.baseURL 异常")
check(loader.apiKey === "sk-check-only", "loader.apiKey 没有透传")
check(typeof loader.fetch === "function", "loader 缺自定义 fetch")

const logsSeen = logs.filter((entry) => entry?.service === "qiniu")
if (logsSeen.length) notes.push(`插件日志 ${logsSeen.length} 条：${logsSeen.map((l) => l.message).join("；")}`)

if (failures.length) {
  console.error(`✗ ${failures.length} 项检查未通过`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`✓ 插件检查通过（${pkg.name}@${pkg.version}）`)
  for (const note of notes) console.log(`  · ${note}`)
}
