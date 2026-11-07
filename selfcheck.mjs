/**
 * dsh-bili-toy 自检（不需要宿主，直接跑）
 * ---------------------------------------------------------------------------
 * 用法（Windows）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & "<DSH 安装目录>\\DSH Desktop.exe" "D:\\plugins\\plugins\dsh-bili-toy\selfcheck.mjs"
 *
 * 它做三件事：
 *   1) 用假 ctx 走一遍 apply()，确认 17 个工具 + /api/bili-toy 路由都注册上了
 *   2) 打真接口（广场 / 周榜 / 搜索 / 详情 / 评论），打印总数与第一条标题
 *   3) 生成一张扫码登录二维码，确认 qrcode 模块可用（不登录，不会改动凭证）
 * 结果同时写到 selfcheck-out.json，跑完看这个文件最省事（控制台中文可能是乱码）。
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = { steps: [], tools: [], routes: [], checks: {} }
const say = (m) => { out.steps.push(m); console.log(m) }

const mod = await import(pathToFileURL(join(here, 'index.js')).href)
say(`module: name=${mod.name} inject=${JSON.stringify(mod.inject)} config=${!!mod.Config}`)

const tools = []
const routes = []
const ctx = {
  tools: { register: (t) => { tools.push(t); return () => {} } },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  settings: {},
  effect: (fn) => { try { fn() } catch (e) { say('effect error: ' + (e && e.message)) } return () => {} },
}
mod.apply(ctx, { enabled: true, defaultCategory: 'all', pageSize: 10, openMode: 'browser', replySort: 2 })
out.tools = tools.map((t) => t.name)
out.routes = routes.map((r) => r.path)
say(`tools(${out.tools.length}): ${out.tools.join(', ')}`)
say(`routes(${out.routes.length}): ${out.routes.join(', ')}`)

const call = async (name, args) => {
  const t = tools.find((x) => x.name === name)
  if (!t) return { error: 'no such tool: ' + name }
  try { return await t.execute(args || {}, {}) } catch (e) { return { THROW: String((e && e.stack) || e) } }
}
const first = (r) => (r.items && r.items[0] ? { id: r.items[0].id, title: r.items[0].title } : null)
const mark = (k, v) => { out.checks[k] = v }

const square = await call('toy_square', { tab: 'all', pageSize: 2 })
mark('square', { ok: square.ok, total: square.total, first: first(square), error: square.error || square.message })
const weekly = await call('toy_weekly', {})
mark('weekly', { ok: weekly.ok, total: weekly.total, edition: weekly.editionNo, first: first(weekly) })
const search = await call('toy_search', { keyword: '大狗', pageSize: 1 })
mark('search', { ok: search.ok, total: search.total, first: first(search) })
const detail = await call('toy_detail', { id: '12420391163904' })
mark('detail', { ok: detail.ok, rid: detail.rid, pv: detail.pv, title: detail.toy && detail.toy.title })
const comments = await call('toy_comments', { toyId: '12420391163904', pageSize: 1 })
mark('comments', { ok: comments.ok, total: comments.total, type: comments.type })
const qr = await call('toy_login_qr', {})
mark('loginQr', { ok: qr.ok, keyLen: qr.key ? qr.key.length : 0, dataUrl: !!(qr.dataUrl), error: qr.error })
const status = await call('toy_login_status', {})
mark('loginStatus', { ok: status.ok, loggedIn: status.loggedIn })

out.summary = {
  toolsOk: out.tools.length === 17,
  apiOk: ['square', 'weekly', 'search', 'detail', 'comments'].every((k) => out.checks[k] && out.checks[k].ok),
  qrOk: !!(out.checks.loginQr && out.checks.loginQr.ok && out.checks.loginQr.dataUrl !== false),
}
writeFileSync(join(here, 'selfcheck-out.json'), JSON.stringify(out, null, 2), 'utf8')
console.log('summary=' + JSON.stringify(out.summary))
