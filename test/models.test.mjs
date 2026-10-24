import test from "node:test"
import assert from "node:assert/strict"

import { buildModels, keyFor, prettify, selectModels } from "../lib/models.mjs"

const ROWS = [
  ["qiniu/conatus-free", 1000000, 128000],
  ["deepseek/deepseek-v4-pro", 1000000, 384000],
  ["z-ai/glm-5.3", 1000000, 128000],
  ["moonshotai/kimi-k3-free", 1048576, 1048576],
  ["doubao-1.5-pro-32k", 128000, 12000],
]

test("keyFor 去掉与供应商重复的第一段，避免 qiniu/deepseek/deepseek-v4-pro", () => {
  assert.equal(keyFor("qiniu/conatus-free"), "conatus-free")
  assert.equal(keyFor("deepseek/deepseek-v4-pro"), "deepseek-v4-pro")
  assert.equal(keyFor("doubao-1.5-pro-32k"), "doubao-1.5-pro-32k")
})

test("prettify 生成人类可读名字", () => {
  assert.equal(prettify("qiniu/conatus-free"), "Conatus Free")
  assert.equal(prettify("deepseek/deepseek-v4-pro"), "DeepSeek V4 Pro")
  assert.equal(prettify("z-ai/glm-5.3"), "Z.ai GLM 5.3")
  // 厂商名已出现在模型名里就不重复：qwen/qwen3.8-max → Qwen3.8 Max
  assert.equal(prettify("qwen/qwen3.8-max"), "Qwen3.8 Max")
  assert.equal(prettify("minimax/minimax-m3"), "MiniMax M3")
  // 相邻个位数段视为版本号
  assert.equal(prettify("bytedance/doubao-seed-2-1-pro"), "ByteDance Doubao Seed 2.1 Pro")
})

test("buildModels 保留真实模型 id，key 用短名", () => {
  const models = buildModels(ROWS)
  assert.deepEqual(Object.keys(models).sort(), [
    "conatus-free",
    "deepseek-v4-pro",
    "doubao-1.5-pro-32k",
    "glm-5.3",
    "kimi-k3-free",
  ])
  assert.equal(models["conatus-free"].id, "qiniu/conatus-free")
  assert.deepEqual(models["conatus-free"].limit, { context: 1000000, output: 128000 })
})

test("buildModels 标记免费模型与能力位", () => {
  const models = buildModels(ROWS)
  assert.equal(models["conatus-free"].free, true)
  assert.equal(models["kimi-k3-free"].free, true)
  assert.equal(models["deepseek-v4-pro"].free, undefined)
  assert.equal(models["conatus-free"].tool_call, true)
  assert.equal(models["conatus-free"].reasoning, true)
  assert.deepEqual(models["conatus-free"].modalities.input, ["text", "image"])
  assert.deepEqual(models["deepseek-v4-pro"].modalities.input, ["text"])
})

test("buildModels 上下文缺失时回退，不产生 0 长度窗口", () => {
  const models = buildModels([["z-ai/glm-4.5-air-free", 0, 0]])
  assert.ok(models["glm-4.5-air-free"].limit.context > 0)
  assert.ok(models["glm-4.5-air-free"].limit.output > 0)
  assert.ok(models["glm-4.5-air-free"].limit.output <= models["glm-4.5-air-free"].limit.context)
})

test("buildModels 保留已有模型定义里的用户覆盖（如 id 映射）", () => {
  const models = buildModels([["qiniu/conatus-free", 1000000, 128000]], {
    "conatus-free": { name: "我的 Conatus", limit: { context: 200000 } },
  })
  assert.equal(models["conatus-free"].name, "我的 Conatus")
  assert.equal(models["conatus-free"].limit.context, 200000)
  assert.equal(models["conatus-free"].limit.output, 128000)
})

test("selectModels 支持 onlyFree / include / exclude", () => {
  const models = buildModels(ROWS)
  assert.deepEqual(Object.keys(selectModels(models, { onlyFree: true })).sort(), ["conatus-free", "kimi-k3-free"])
  assert.deepEqual(Object.keys(selectModels(models, { include: ["deepseek"] })), ["deepseek-v4-pro"])
  assert.deepEqual(Object.keys(selectModels(models, { exclude: ["deepseek"] })).sort(), [
    "conatus-free",
    "doubao-1.5-pro-32k",
    "glm-5.3",
    "kimi-k3-free",
  ])
  assert.deepEqual(Object.keys(selectModels(models, { include: ["/^glm/"] })), ["glm-5.3"])
})
