# opencode-qiniu-auth

七牛云 MaaS（Modelink）的 **Magpie / OpenCode 供应商插件**。

登录一次七牛云 API Key，就能在 Magpie 里用 `qiniu/conatus-free`（1024 程序员节限时免费融合模型，1M 上下文 / 128K 输出 / 支持图像输入）以及七牛聚合的其余模型 —— DeepSeek、Qwen、GLM、Kimi、MiniMax、豆包、混元、小米 MiMo 等，目前 89 个。

- **模型列表不写死**：启动时调 `GET /v1/models` 拉线上清单；连不上厂商就用内置快照兜底（`lib/catalog.mjs`）
- **免费模型自动标记**：`qiniu/conatus-free`、`moonshotai/kimi-k3-free`、`z-ai/glm-4.5-air-free`、`nvidia/nemotron-3-ultra-550b-a55b0-free` 带 `free: true`，不占订阅额度
- **密钥失效能识别**：`401` + `auth_api_key_invalid` 会被标成 `X-Magpie-Sign-In: expired`，账号提示重新登录，而不是当成普通失败去故障切换
- **可选额度显示**：配 AK/SK 后账号上出现「今日 token」窗口（走平台管理接口，与调用用的 API Key 严格隔离）
- **兼容 OpenCode**：只用 `config` / `auth` / `provider` 三个标准钩子；`auth.usage` 是 Magpie 私有增至，OpenCode 会忽略

## 目录结构

```
opencode-qiniu-auth/
├── package.json           # magpie 字段：maxConcurrency、icon
├── index.mjs              # 插件入口（config / auth / provider）
├── lib/
│   ├── catalog.mjs        # 模型快照（scripts/gen-catalog.mjs 生成）
│   ├── models.mjs         # 快照 + 线上清单 → Magpie 模型对象
│   ├── sign.mjs           # 七牛 AK/SK 签名（HMAC-SHA1 + urlsafe base64）
│   └── usage.mjs          # 今日 token 用量（平台管理接口）
├── scripts/
│   ├── gen-catalog.mjs    # 重新抓 /v1/models 刷新快照
│   └── check.mjs          # 像 Magpie 一样加载插件做体检
├── test/                  # node --test，39 个用例，全部离线
└── README.md
```

## 安装

```sh
# 本地目录直接加载（改代码后需重启 Magpie 才会重新加载）
magpie plugin add ./opencode-qiniu-auth

# 登录：填控制台创建的 sk-… API Key
magpie plugin login qiniu

# 验证
magpie plugin                              # qiniu (七牛云, 89 models) signed in
magpie provider test qiniu qiniu/conatus-free
```

应用内：插件 → 添加插件 → 填文件夹路径 → 在供应商行登录。

### 登录时会问三项

| 问题 | 类型 | 必填 | 用途 | 在哪拿 |
| --- | --- | --- | --- | --- |
| API Key | 明文 | 是 | `sk-…`，调模型用 | <https://portal.qiniu.com/ai-inference/api-key> |
| AccessKey | 明文 | 否 | 读「今日已用」 | <https://portal.qiniu.com/developer/user/key> |
| SecretKey | 掩码 | 否 | 与 AccessKey 配对 | 同上，就在 AccessKey 旁边 |

| 凭证 | 前缀 | 长度 | 用途 |
| --- | --- | --- | --- |
| API Key | `sk-` | 约 67 位 | 调模型 |
| AccessKey | 无前缀 | 40 位 | 签名用 |
| SecretKey | 无前缀 | 40 位 | 签名用 |

> **最容易填错的一步**：把 `sk-` 开头的 API Key 当成 SecretKey。
> 这两套凭证完全不通用，填串了接口只会回一个笼统的 `401 {"error":"bad token"}`。
> 本插件会提前校验：发现 SecretKey 以 `sk-` 开头就直接报错说明，不再让你对着 401 猜。

SecretKey 在控制台「密钥管理」页，与 AccessKey 上下相邻，**不是** AI 推理那个页面里的 API Key。

> Key 输入框右侧会出现「Get a key →」按钮，点开直达
> <https://portal.qiniu.com/ai-inference/api-key>。
> 该按钮由 Magpie 读 `~/.config/magpie/providers.json` 里 `qiniu` 条目的 `keysUrl` 渲染——
> 插件的 `auth.methods` 协议没有可点击链接字段，所以安装后需把这个字段补进该配置。
> `magpie plugin add` 不会自动写入，重装插件后可能需要再补一次。

> `qiniu` 若已被内置预设占用，Magpie 会把插件供应商改叫 `qiniu-plugin`；`magpie plugin` 的输出里能看到真实 id。

## 模型怎么引用

agent 里写 `<供应商>/<模型 key>`。模型 key 去掉了与供应商重复的第一段，所以七牛的 `deepseek/deepseek-v4-pro` 在 Magpie 里就是 `qiniu/deepseek-v4-pro`：

| 七牛模型 id | Magpie 里的写法 |
| --- | --- |
| `qiniu/conatus-free` | `qiniu/conatus-free` |
| `deepseek/deepseek-v4-pro` | `qiniu/deepseek-v4-pro` |
| `moonshotai/kimi-k3-free` | `qiniu/kimi-k3-free` |
| `z-ai/glm-5.3` | `qiniu/glm-5.3` |
| `qwen/qwen3.8-max` | `qiniu/qwen3.8-max` |

请求体里的 `model` 始终是七牛的完整 id（写在模型对象的 `id` 字段），不会因为换了短名而打错。

## Conatus Free 的额度规则

按七牛官方活动页（2026-10-24 00:00 ~ 2026-11-30 23:59，北京时间）：

- **只消耗活动免费额度**：额度用尽直接拒绝请求，不扣余额 / 资源包 / 订阅 / 积分，也不会自动切到付费模型
- **按账号发放**：实名认证 1 亿 token/日；任意一笔满 100 元且已到账的充值提到 10 亿/日；同账号下所有 API Key 共享，每日 0 点重置、不结转
- **活动结束即停**：11-30 之后即使还有剩余额度也不能再调，不转为付费模型

因此本插件不做任何自动 fallback —— 额度没了就明确报错，不会偷偷换成更贵的模型继续跑。

## 配置（可选）

写在 `~/.config/magpie/plugins.json` 里该项的 `options`，或用命令：

```sh
magpie plugin options qiniu '{"onlyFree": true, "maxConcurrency": 2}'

# 或者只保留某些模型
magpie plugin options qiniu '{"include": ["deepseek", "/^qwen/"], "exclude": ["-exp"]}'
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://api.qnaigc.com/v1` | 海外接入点填 `https://api.modelink.ai`；省略 `/v1` 会自动补 |
| `name` | `七牛云` | 供应商显示名 |
| `maxConcurrency` | `4` | 每账号并发上限，夹在 1–1000 |
| `include` / `exclude` | — | 模型过滤，支持字符串前缀或 `/正则/` |
| `onlyFree` | `false` | 只保留 `-free` 模型，适合「只用免费额度」 |
| `accessKey` / `secretKey` | — | 可选。**只用于查用量**，不配就看不到任何额度数字；也可用环境变量 `QINIU_ACCESS_KEY` / `QINIU_SECRET_KEY` |
| `dailyQuota` | `100000000` | 每日 token 档位，用来算「剩余」（认证 1e8，充过 100 元填 1e9） |
| `plan` / `usageModel` | `Conatus Free` / — | 用量面板上的套餐名、按模型过滤 |

模型默认值也能在 `plugins.json` 的供应商 `models` 里逐项覆盖；`provider.models` 会把你写的字段合并进去，不会被线上清单冲掉：

```json
{
  "plugins": [{ "spec": "./opencode-qiniu-auth", "options": { "onlyFree": true } }],
  "config": {
    "provider": {
      "qiniu": {
        "models": {
          "conatus-free": { "name": "Conatus Free（活动）", "limit": { "context": 1000000, "output": 128000 } }
        }
      }
    }
  }
}
```

## 额度显示（剩余量从哪来）

**为什么默认看不到「剩余」**：七牛只提供**已消耗量**管理接口，没有公开的「免费额度剩余」接口：

```
GET https://api.qiniu.com/ai/inapi/v3/stat/new?start=…&end=…&g=day
Authorization: Qiniu <AccessKey>:<HMAC-SHA1 urlsafe-base64>
```

无凭证访问该接口直接返回 `401 {"error":"bad token","error_code":"BadToken"}`（已实测）。所以：

- **不配 AK/SK** → 一个数字都读不到，账号上会显示原因，而不是空白
- **配了 AK/SK** → 读到「今日已用」，再按 `dailyQuota` 反推「剩余」
- **剩余 = dailyQuota − 今日已用**，是配置档位算出来的，不是七牛返回的真实余额

```sh
# 1. 打开七牛控制台 → 密钥管理，拿 AccessKey / SecretKey（与调用用的 sk- API Key 是两套东西）
export QINIU_ACCESS_KEY=...
export QINIU_SECRET_KEY=...

# 2. 告诉插件你的每日档位（认证用户 1e8；充过 100 元是 1e9）
magpie plugin options qiniu '{"dailyQuota": 100000000}'

# 3. 看结果
magpie quota
```

窗口里的 `display` 会写成：

| 配置 | 显示 |
| --- | --- |
| 配了 `dailyQuota` | `剩余 75M / 共 100M（已用 25M）` |
| 没配 | `已用 1.5M（配 dailyQuota 可算剩余）` |

> magpie 的用量窗口只认 `name / used / resetsAt / display / amount / limit / unit / span`，**没有** `remaining` 这类数值字段。所以「剩余」只能由 `display` 这个字符串表达，百分比条走 `used`（0–100）。真实余额仍以七牛控制台为准。

### 接口返回的字段名（容易看错）

七牛这个接口的字段命名和直觉不一样，改代码前先对一遍：

```json
{ "status": true,
  "data": [ { "name": "qiniu/conatus-free",
              "items": [ { "key": "cache", "unit_name": "token",
                           "unit_size_default": 1000, "total": 537.1,
                           "values": [{ "time": "2026-10-25", "value": 537.1 }] } ] } ] }
```

| 你以为 | 实际 | 后果 |
| --- | --- | --- |
| `item.name` | **`item.key`**（`cache` / `ncache` / `output`）；`name` 在**组**上，是模型 id | 取 `item.name` 永远 `undefined` |
| `item.unit` | **`item.unit_name`**（`"token"`） | 同上 |
| `total` 就是 token 数 | `total` 的单位是 **`unit_size_default` 个 token**（当前是 1000） | 漏乘少算三个数量级 |

三项分别是**缓存命中输入**（`cache`）、**未命中输入**（`ncache`）、**输出**（`output`），加起来才是当天消耗。

> 0.3.2 之前只认 `name` / `unit`，导致 token 恒为 0、`used` 恒为 0，界面上就一直显示「剩余 100%」——看起来像一点没用。现已修正并加了回归测试。

**安全**：AK/SK 权限极高（能建删全账号的 Key、读全量日志），只放环境变量或本机配置，别提交到仓库、别贴进对话。插件只拿它读用量，绝不用于模型请求。

## 和 `qiniu/skills` 的分工

```sh
npx skills add qiniu/skills --skill maas
```

- **本插件**：模型**调用**链路 —— 让 Magpie / [CC] / Codex 这类 agent 用七牛模型跑对话
- **`maas` skill**：平台**运维** —— 请求日志、按天/小时用量报表、API Key 生命周期与限额；只在服务端用 AK/SK

## 测试

```sh
node --test "test/*.test.mjs"   # 39 个用例：签名、用量解析、钩子契约；全部 stub fetch，不花额度
node scripts/check.mjs          # 像 Magpie 一样加载插件，检查钩子形状 + 拉一次线上模型清单
node scripts/gen-catalog.mjs    # 刷新 lib/catalog.mjs 内置快照
```

`check.mjs` 输出示例：

```
✓ 插件检查通过（opencode-qiniu-auth@0.1.0）
  · 内置模型 89 个，免费 4 个
  · 线上模型 89 个
```

沙箱里跑一遍真实加载（不污染本机配置）：

```sh
sb=$(mktemp -d)
m() { env HOME=$sb XDG_CONFIG_HOME=$sb/.config MAGPIE_ADDR=127.0.0.1:3499 magpie "$@"; }
m plugin add ./opencode-qiniu-auth </dev/null
m plugin --json
m plugin login qiniu
m provider test qiniu qiniu/conatus-free
```

## 已知限制

- 能力位（工具调用 / 视觉 / 思考）是**启发式推断**：`/v1/models` 只返回 `context_length` 和 `max_tokens`。判错了在 `plugins.json` 里覆盖即可。
- `z-ai/glm-4.5-air-free` 在线上清单里的 `context_length` 是 0，按 128K 兜底。
- 只实现 Chat Completions（`@ai-sdk/openai-compatible`）。要用七牛的 Anthropic Messages 端点需另配 `@ai-sdk/anthropic`，目前不在本插件范围内。
- 用量窗口的百分比是配置估算，不是官方额度接口。
- 模型清单与活动规则会变；`conatus-free` 是否仍可用以 `GET /v1/models` 和控制台为准。

## License

MIT
