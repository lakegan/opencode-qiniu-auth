import test from "node:test"
import assert from "node:assert/strict"

import { buildModels, keyFor, planKeys, prettify, selectModels } from "../lib/models.mjs"

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

// 评审意见：qwen3-coder-480b-a35b-instruct、qwen3-235b-a22b-instruct-2507 这类
// instruct 模型，因为名字里有 qwen3 就被标成推理模型。instruct 必须排除。
test("instruct 模型不被判为推理模型，即使家族名命中 qwen3 / deepseek-v4", () => {
  const ids = [
    "qwen3-235b-a22b-instruct-2507",
    "qwen3-30b-a3b-instruct-2507",
    "qwen3-coder-480b-a35b-instruct",
    "qwen3-next-80b-a3b-instruct",
    "deepseek/deepseek-v4-instruct",
  ]
  const models = buildModels(ids.map((id) => [id, 128000, 8192]))
  for (const id of ids) {
    const key = keyFor(id)
    assert.equal(models[key].reasoning, false, `${id} 不该被判为推理模型`)
  }
})

test("真正的推理模型仍然被判为推理模型（instruct 排除不能过头）", () => {
  const ids = [
    "qiniu/conatus-free",
    "deepseek/deepseek-v4-pro",
    "qwen/qwen3.8-max",
    "z-ai/glm-5.3",
    "minimax/minimax-m3",
  ]
  const models = buildModels(ids.map((id) => [id, 128000, 8192]))
  for (const id of ids) {
    assert.equal(models[keyFor(id)].reasoning, true, `${id} 应被判为推理模型`)
  }
})

// 评审意见：key 去前缀时「冲突才退回完整 id」取决于列表顺序，
// 七牛加一个同名模型，旧 key 就可能变。改成顺序无关。
test("模型 key 与列表顺序无关", () => {
  const ids = [["a/x", 1, 1], ["b/y", 1, 1], ["c/x", 1, 1], ["d/z", 1, 1]]
  const forward = buildModels(ids)
  const backward = buildModels([...ids].reverse())
  const shuffled = buildModels([ids[2], ids[0], ids[3], ids[1]])
  assert.deepEqual(Object.keys(forward).sort(), Object.keys(backward).sort())
  assert.deepEqual(Object.keys(forward).sort(), Object.keys(shuffled).sort())
})

test("短名唯一时用短名，撞名时全部退回完整 id（与顺序无关）", () => {
  // x 出现两次 → 两个都保留完整 id
  const models = buildModels([["a/x", 1, 1], ["b/x", 1, 1], ["c/only", 1, 1]])
  assert.deepEqual(Object.keys(models).sort(), ["a/x", "b/x", "only"])
})

test("planKeys 对同一份 id 集合给出确定结果", () => {
  const a = planKeys(["z/one", "y/two", "x/one"])
  const b = planKeys(["x/one", "y/two", "z/one"])
  assert.equal(a.get("x/one"), "x/one")
  assert.equal(b.get("x/one"), "x/one")
  assert.equal(a.get("y/two"), "two")
  assert.equal(b.get("y/two"), "two")
})
