import test from "node:test"
import assert from "node:assert/strict"

import { qiniuAuthorization, signQiniuToken } from "../lib/sign.mjs"

test("签名头是 `Qiniu <AK>:<urlsafe-base64>`，保留 = 填充", () => {
  const token = signQiniuToken("ak-test", "sk-test", "GET", "/ai/inapi/v3/apikeys", "api.qiniu.com")
  assert.match(token, /^ak-test:[A-Za-z0-9\-_]+=*$/)
  assert.ok(!token.includes("+") && !token.includes("/"))
  assert.equal(qiniuAuthorization("ak-test", "sk-test", "GET", "/ai/inapi/v3/apikeys", "api.qiniu.com"), `Qiniu ${token}`)
})

test("签名可复现：同输入同结果", () => {
  const args = ["ak", "sk", "GET", "/ai/inapi/v3/stat/new?g=day", "api.qiniu.com"]
  assert.equal(signQiniuToken(...args), signQiniuToken(...args))
})

test("签名对 method / path / host / tk 变化敏感", () => {
  const base = signQiniuToken("ak", "sk", "GET", "/a", "api.qiniu.com")
  assert.notEqual(base, signQiniuToken("ak", "sk", "POST", "/a", "api.qiniu.com"))
  assert.notEqual(base, signQiniuToken("ak", "sk", "GET", "/b", "api.qiniu.com"))
  assert.notEqual(base, signQiniuToken("ak", "sk", "GET", "/a", "other.qiniu.com"))
  assert.notEqual(base, signQiniuToken("ak", "other", "GET", "/a", "api.qiniu.com"))
})

test("签名与官方 Node 示例等价", async () => {
  const { createHmac } = await import("node:crypto")
  const ak = "AKexample"
  const sk = "SKexample"
  const method = "GET"
  const path = "/ai/inapi/v3/stat/new?start=2026-10-24T00%3A00%3A00%2B08%3A00&g=day"
  const host = "api.qiniu.com"

  const signing = `${method} ${path}\nHost: ${host}\n\n`
  const expected = `${ak}:${createHmac("sha1", sk).update(signing).digest().toString("base64").replace(/\+/g, "-").replace(/\//g, "_")}`

  assert.equal(signQiniuToken(ak, sk, method, path, host), expected)
})
