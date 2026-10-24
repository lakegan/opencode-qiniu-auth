// 七牛云平台管理接口（AK/SK）签名。
//
// 只有 auth.usage 用到：查询账户当天的 token 消耗，用于在 magpie 里显示
// 免费额度用了多少。业务请求（模型调用）走的是 sk- 开头的 API Key，
// 不经过这里 —— AK/SK 权限极高，绝不能被模型请求复用。
//
// 文档：https://developer.qiniu.com/kodo/1201/access-token
import { createHmac } from "node:crypto"

const URLSAFE = { "+": "-", "/": "_" }

const urlsafeBase64 = (buffer) =>
  buffer.toString("base64").replace(/[+/]/g, (ch) => URLSAFE[ch])

/**
 * @param {string} accessKey
 * @param {string} secretKey
 * @param {string} method GET / POST …
 * @param {string} path 含 query，如 /ai/inapi/v3/stat/new?g=day
 * @param {string} host 如 api.qiniu.com
 * @param {{ contentType?: string, body?: string, qiniuHeaders?: Record<string,string> }} [extra]
 * @returns {string} `<AccessKey>:<EncodedSign>`，直接放进 `Authorization: Qiniu <token>`
 */
export function signQiniuToken(accessKey, secretKey, method, path, host, extra = {}) {
  const { contentType = "", body = "", qiniuHeaders = {} } = extra
  let signing = `${method} ${path}\nHost: ${host}`
  if (contentType) signing += `\nContent-Type: ${contentType}`
  for (const name of Object.keys(qiniuHeaders).sort()) {
    signing += `\n${name}: ${qiniuHeaders[name]}`
  }
  signing += "\n\n"
  if (body && contentType && contentType !== "application/octet-stream") signing += body

  const digest = createHmac("sha1", secretKey).update(signing).digest()
  return `${accessKey}:${urlsafeBase64(digest)}`
}

/** Authorization 头 */
export function qiniuAuthorization(accessKey, secretKey, method, path, host, extra) {
  return `Qiniu ${signQiniuToken(accessKey, secretKey, method, path, host, extra)}`
}
