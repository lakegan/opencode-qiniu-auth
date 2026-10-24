#!/usr/bin/env node
// 给 Magpie 的 providers.json 里 qiniu 条目补上 keysUrl / website。
//
// 为什么需要这一步：Magpie 的插件 provider 渲染「Get a key →」按钮时读的是
// providers.json 里该供应商的 keysUrl，而插件的 auth.methods 协议里没有
// 可点击链接字段（Go 侧的 provider.Method 只有 type/label/placeholder/keyless）。
// 所以只能直接写这个配置文件。
//
// `magpie plugin add` / 重新登录可能重写 providers.json 并丢掉这两个键，
// 发现按钮不见了就再跑一次本脚本。
//
// 用法：node scripts/patch-keys-url.mjs [--check]

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const KEYS_URL = "https://portal.qiniu.com/ai-inference/api-key"
const WEBSITE = "https://www.qiniu.com/ai/model/qiniu/conatus-free"
const PROVIDER = "qiniu"

const file = path.join(os.homedir(), ".config", "magpie", "providers.json")

if (!fs.existsSync(file)) {
  console.error(`找不到 ${file}\n先装好 Magpie 并添加本插件（magpie plugin add <本插件路径>）再运行。`)
  process.exit(1)
}

const raw = fs.readFileSync(file, "utf8")
const doc = JSON.parse(raw)
const list = Array.isArray(doc) ? doc : doc.providers ?? []
const target = list.find((p) => p && p.id === PROVIDER)

if (!target) {
  console.error(`providers.json 里没有 "${PROVIDER}"。先在 Magpie 里添加本插件并登录一次，让这个供应商出现。`)
  process.exit(1)
}

const checkOnly = process.argv.includes("--check")
const wanted = { keysUrl: KEYS_URL, website: WEBSITE }
const missing = Object.entries(wanted).filter(([k, v]) => target[k] !== v)

if (missing.length === 0) {
  console.log(`✓ ${PROVIDER} 已有 keysUrl / website，按钮应当正常显示`)
  console.log(`  keysUrl: ${target.keysUrl}`)
  process.exit(0)
}

if (checkOnly) {
  console.log(`✗ ${PROVIDER} 缺少：${missing.map(([k]) => k).join(", ")}`)
  process.exit(2)
}

// 改前留一份，出问题能回退
fs.copyFileSync(file, `${file}.bak-keysurl`)

for (const [key, value] of missing) target[key] = value
fs.writeFileSync(file, JSON.stringify(doc, null, 2))

console.log(`✓ 已给 ${PROVIDER} 写入：${missing.map(([k]) => k).join(", ")}`)
console.log(`  keysUrl: ${KEYS_URL}`)
console.log(`  备份：${file}.bak-keysurl`)
console.log("\n重启 Magpie 后，Key 输入框右侧会出现「Get a key →」按钮。")
