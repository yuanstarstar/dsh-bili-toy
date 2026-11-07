/**
 * dsh-bili-toy —— host 半端
 * ============================================================================
 * 干什么：让 DSH 能玩 B站 的 Toy（网页互动内容平台 www.bilibili.com/btoy）。
 *   · 扫码登录（二维码显示在 DSH 设置页「玩Toy」里，也能让模型直接拿到 dataURL）
 *   · 逛广场 / 搜 toy / 周榜 / 活动 / 看详情 / 挑一个打开（**游戏操作不在这里，交给专用包**）
 *   · 读评论、发评论（可 @ 人）、点赞、收藏、看「我的」
 *
 * 接口来源：Toy 前端是 Vite SPA，接口路径打包在 JS 里。已从
 *   plaza 的 `useToast-BDO8F363.js`（前缀 `/x/toy`）和 pc-detail 的 `index.js` 里扒出真名路径，
 *   全部 curl 验过（读接口不需要签名/登录，写接口要 cookie + csrf）。
 *
 * 家目录：<DSH_HOME>/bili-toy/{credential,settings,endpoints}.json + toy.log
 * ============================================================================
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { loadHostDeps } from './lib/hostdeps.mjs'
import * as bili from './lib/bili.mjs'
import { homeDir, loadSettings, saveSettings, loadCred, clearCred, logLine, trimLog } from './lib/state.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

export const name = 'bili-toy'
export const inject = ['webServer', 'tools', 'settings']

/**
 * ⚠️ 每个字段都要 `.extra('volatile', true)`：
 *    DSH 的 settings.update() 只认 volatile 字段，否则报 "Plugin entry … has no volatile fields"。
 *    另外 loader entry 的 id 必须等于这里的 name（cordis.patch.yml 里就是 bili-toy）。
 */
export const Config = !z ? undefined : z.object({
  /** 总开关（关掉就只剩设置页，不注册工具） */
  enabled: z.boolean().default(true).extra('volatile', true),
  /** 广场默认分类（接口自己决定字面量，先留 all） */
  defaultCategory: z.string().default('all').extra('volatile', true),
  /** 一次列几条 */
  pageSize: z.natural().default(20).extra('volatile', true),
  /** 打开 toy 的方式：browser = 系统浏览器（默认） */
  openMode: z.string().default('browser').extra('volatile', true),
  /** 评论默认排序：2 = 热度，0 = 时间 */
  replySort: z.natural().default(2).extra('volatile', true),
})

const pluginDir = dirname(fileURLToPath(import.meta.url))

function myVersion() {
  try { return JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '' } catch { return '' }
}

/** 二维码：优先用宿主自带的 qrcode 包；没有就退到 py -3 的 qrcode 模块 */
function loadQrcode() {
  const req = createRequire(import.meta.url)
  const candidates = []
  try { if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'app', 'node_modules', 'qrcode')) } catch { /* 忽略 */ }
  try { candidates.push(join(dirname(process.execPath), 'resources', 'app', 'node_modules', 'qrcode')) } catch { /* 忽略 */ }
  candidates.push('qrcode')
  for (const p of candidates) {
    try { const m = req(p); if (m && typeof m.toDataURL === 'function') return m } catch { /* 下一个 */ }
  }
  return null
}

export function apply(ctx, config) {
  const rawCfg = config || {}
  const cfg = { enabled: true, defaultCategory: 'all', pageSize: 20, openMode: 'browser', replySort: 2 }
  // ⚠️ 实战踩坑：宿主传进来的 config 里每个字段都可能是 undefined / "0" / NaN，
  //    甚至是个空对象 {}（schemastery 的默认值没展开）。pageSize 变 NaN 会让 ps=NaN（接口 -400），
  //    defaultCategory 变 {} 会让 category=[object Object]（同样 -400）——所以这里逐字段归一化。
  const str = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
  const num = (v, fallback, lo, hi) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return fallback
    const s = Math.floor(n)
    return Math.min(hi, Math.max(lo, s))
  }
  if (typeof rawCfg.enabled === 'boolean') cfg.enabled = rawCfg.enabled
  cfg.defaultCategory = str(rawCfg.defaultCategory, 'all').toLowerCase()
  cfg.pageSize = num(rawCfg.pageSize, 20, 1, 50)
  cfg.openMode = str(rawCfg.openMode, 'browser')
  cfg.replySort = num(rawCfg.replySort, 2, 0, 2)
  const log = (m) => { try { logLine('host', typeof m === 'string' ? m : JSON.stringify(m)) } catch { /* 忽略 */ } }
  log(`config 归一化：${JSON.stringify({ enabled: cfg.enabled, category: cfg.defaultCategory, pageSize: cfg.pageSize, openMode: cfg.openMode, replySort: cfg.replySort })}（原始 ${JSON.stringify(rawCfg)}）`)
  const home = homeDir()
  const qrCache = new Map()   // key → { dataUrl, at }
  const QRCache = loadQrcode()

  /* ─────────────── 工具返回体 ─────────────── */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }

  /** 宿主只吃"无损 JSON"：塞函数/循环引用会报 value is not lossless JSON */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  const QR_PNG = () => join(home, 'login-qr.png')

  const qrDataUrl = async (text) => {
    if (QRCache) {
      try {
        const dataUrl = await QRCache.toDataURL(text, { margin: 1, width: 280, errorCorrectionLevel: 'M' })
        // 顺手落一份 PNG：对话里直接贴图用，不用再手搓渲染脚本
        try { await QRCache.toFile(QR_PNG(), text, { margin: 2, width: 440, errorCorrectionLevel: 'M' }) } catch { /* 落盘失败不影响主流程 */ }
        return dataUrl
      } catch { /* 走 python */ }
    }
    try {
      const out = join(home, `.qr-${Date.now()}.png`)
      const py = spawnSync('py', ['-3', '-c',
        'import sys, qrcode; qrcode.make(sys.argv[1]).save(sys.argv[2])', text, out], { stdio: 'ignore', timeout: 15000 })
      if (py.status === 0 && existsSync(out)) {
        const b64 = readFileSync(out).toString('base64')
        try { unlinkSync(out) } catch { /* 忽略 */ }
        return 'data:image/png;base64,' + b64
      }
    } catch { /* 忽略 */ }
    return null
  }

  /* ─────────────── 工具 ─────────────── */

  if (cfg.enabled !== false) {
    tool({
      name: 'toy_login_qr',
      description: '生成 B站 扫码登录二维码（Toy 相关操作要先登录）。返回 qrcode key 与二维码图片 dataURL；'
        + '设置页「玩Toy」里也会显示同一张图。拿到后把 key 交给 toy_login_poll 轮询。',
      parameters: {},
      async execute() {
        const r = await bili.loginQr()
        if (!r.ok) return { ok: false, ...r, hint: '网络不通或 B站 改了接口；先检查宿主进程能不能上网（别的联网工具能用就说明能）' }
        const dataUrl = await qrDataUrl(r.url)
        qrCache.set(r.key, { dataUrl, at: Date.now() })
        return {
          ok: true, key: r.key, url: r.url,
          file: existsSync(QR_PNG()) ? QR_PNG() : null,
          dataUrl: dataUrl ? dataUrl.slice(0, 60) + '…（完整图在设置页「玩Toy」里，或用上面的 file 路径直接贴图）' : null,
          expireSeconds: r.expireSeconds || 180,
          hint: '让用户用手机 B站 扫这张图（对话里贴 file 那张 PNG，或设置页「玩Toy」），然后调 toy_login_poll{key} 查结果',
        }
      },
    })

    tool({
      name: 'toy_login_poll',
      description: '查扫码结果：wait=没扫 / scanned=扫了没确认 / ok=登录成功（凭证自动落盘）/ expired=过期要重新生成。',
      parameters: { key: { type: 'string', description: 'toy_login_qr 返回的 key（qrcode_key）' } },
      async execute(args) {
        const r = await bili.loginPoll(String(args.key || ''))
        if (r.ok && r.state === 'ok') log('login ok')
        return r
      },
    })

    tool({
      name: 'toy_login_status',
      description: '看当前登录状态：凭证在不在、是否还有效、登录的是谁（昵称 / mid）。',
      parameters: {},
      async execute() {
        const cred = loadCred()
        if (!cred) {
          return { ok: true, loggedIn: false, hint: '还没登录：设置页「玩Toy」点扫码登录，或先调 toy_login_qr' }
        }
        const who = await bili.navInfo()
        return {
          ok: true,
          loggedIn: !!who.ok,
          savedUser: { uname: cred.uname || '', mid: cred.mid || cred.dedeuserid || '' },
          live: who.ok ? { uname: who.uname, mid: who.mid, level: who.level } : null,
          message: who.message || who.error || '',
          hint: who.ok ? '凭证有效' : '凭证可能过期了，重新扫码',
        }
      },
    })

    tool({
      name: 'toy_logout',
      description: '删掉本机存的 B站 凭证（退出登录）。',
      parameters: {},
      async execute() {
        clearCred()
        return { ok: true, hint: '本地凭证已删除（B站 那边没动，等于只是本机忘掉）' }
      },
    })

    tool({
      name: 'toy_square',
      description: '逛 Toy 广场。tab: all(全部) / game(游戏) / interactive-play(互动玩法) / tool(工具) / '
        + 'test(测试) / guide(攻略) / collection(合集) / other(其他) / recommend(今日推荐) / weekly(本周必玩)。'
        + '返回条目含 id / rid / 标题 / 作者 / 播放量 / 直达链接。',
      parameters: {
        tab: { type: 'string', description: '分类 key，默认 all' },
        page: { type: 'number', description: '第几页（从 1 开始，默认 1）' },
        pageSize: { type: 'number', description: '一页几条（默认 20，最大 50）' },
        days: { type: 'number', description: 'tab=recommend 时：最近几天（默认 1）' },
        activity: { type: 'string', description: '活动 code（如 s_race_2026）；给了就打活动列表，忽略 tab' },
      },
      async execute(args) {
        const page = Math.max(1, Number(args.page) || 1)
        const pageSize = Math.max(1, Math.min(Number(args.pageSize) || cfg.pageSize, 50))
        if (args.activity) return bili.plazaActivity({ activity: String(args.activity), page, pageSize })
        return bili.square({ tab: String(args.tab || cfg.defaultCategory || 'all'), page, pageSize, days: Number(args.days) || 1 })
      },
    })

    tool({
      name: 'toy_weekly',
      description: 'Toy 周榜：不给 edition 就返回本周（本周必玩）；给 edition 返回到那一期。',
      parameters: { edition: { type: 'number', description: '期号（可省略 = 当前期）' } },
      async execute(args) {
        if (args.edition) return bili.plazaWeeklyEdition(Number(args.edition))
        return bili.plazaWeekly()
      },
    })

    tool({
      name: 'toy_activities',
      description: 'Toy 广场的活动（例如 S赛）：不传 activity 列活动列表；传 activity 拿该活动下的 toy。',
      parameters: {
        activity: { type: 'string', description: '活动 code（可省略）' },
        page: { type: 'number', description: '第几页（默认 1）' },
      },
      async execute(args) {
        if (!args.activity) return bili.plazaActivities()
        return bili.plazaActivity({ activity: String(args.activity), page: Math.max(1, Number(args.page) || 1), pageSize: cfg.pageSize })
      },
    })

    tool({
      name: 'toy_search',
      description: '在 Toy 里搜关键词（先试真接口，不行就在广场结果里本地过滤，会说明用的哪种）。',
      parameters: {
        keyword: { type: 'string', description: '关键词' },
        page: { type: 'number', description: '第几页（默认 1）' },
      },
      async execute(args) {
        return bili.searchToy({
          keyword: String(args.keyword || ''),
          page: Math.max(1, Number(args.page) || 1),
          pageSize: Math.max(1, Math.min(Number(args.pageSize) || cfg.pageSize, 50)),
        })
      },
    })

    tool({
      name: 'toy_detail',
      description: '看一个 toy 的详情：标题 / 作者(mid) / 分类 / 播放量 / 点赞 / 收藏 / 评论数 / 直达链接 / '
        + '评论 oid(rid) / 我有没有点过赞收藏过。id 也可以是完整链接（数字 id 或 /toy/<数字>/ 链接）。',
      parameters: { id: { type: 'string', description: 'toy 数字 id 或完整链接' } },
      async execute(args) { return bili.detail(String(args.id || '')) },
    })

    tool({
      name: 'toy_open',
      description: '打开一个 toy：在系统浏览器里新开标签（游戏画面里的操作交给专用包，这里只负责打开）。',
      parameters: { id: { type: 'string', description: 'toy 数字 id 或完整链接' } },
      async execute(args) { return bili.openToy(String(args.id || '')) },
    })

    tool({
      name: 'toy_current',
      description: '看最近打开过哪个 toy（以及登录状态），方便接着玩。',
      parameters: {},
      async execute() {
        const s = loadSettings()
        return {
          ok: true,
          currentToy: s.currentToy || null,
          loggedIn: !!loadCred()?.sessdata,
          home,
          version: myVersion(),
          hint: s.currentToy ? '接着看就用 toy_open 重新打开它' : '还没打开过任何 toy',
        }
      },
    })

    tool({
      name: 'toy_comments',
      description: '读一个 toy 的评论（type 已固定为 11，不需要你猜）。给 toyId 或直接给 oid(rid)。',
      parameters: {
        toyId: { type: 'string', description: 'toy 数字 id（会自动换成 rid）' },
        oid: { type: 'string', description: '评论 oid = detail 里的 rid（知道就直接给）' },
        page: { type: 'number', description: '第几页（默认 1）' },
        pageSize: { type: 'number', description: '一页几条（默认 20，最大 50）' },
        sort: { type: 'number', description: '0=最新，2=最热（默认 2）' },
      },
      async execute(args) {
        return bili.comments({
          toyId: args.toyId ? String(args.toyId) : '',
          oid: args.oid ? String(args.oid) : '',
          page: Math.max(1, Number(args.page) || 1),
          pageSize: Math.max(1, Math.min(Number(args.pageSize) || cfg.pageSize, 50)),
          sort: args.sort === 0 || args.sort === '0' ? 0 : (Number(cfg.replySort) || 2),
        })
      },
    })

    tool({
      name: 'toy_comment',
      description: '在一个 toy 下发评论（可 @ 人）。⚠️ 会用你的账号真的发出去，没有二次确认。'
        + 'atName 写昵称（正文开头加 @昵称）；atUid 是对方 mid。',
      parameters: {
        toyId: { type: 'string', description: 'toy 数字 id（会自动换成 rid）' },
        oid: { type: 'string', description: '评论 oid = detail 里的 rid（可选）' },
        text: { type: 'string', description: '评论正文' },
        atName: { type: 'string', description: '要 @ 的昵称（可省略）' },
        atUid: { type: 'string', description: '要 @ 的 mid（可省略）' },
        root: { type: 'string', description: '回复楼中楼时的根评论 rpid（可省略）' },
        parent: { type: 'string', description: '回复某条评论的 rpid（可省略）' },
      },
      async execute(args) {
        return bili.postComment({
          toyId: args.toyId ? String(args.toyId) : '',
          oid: args.oid ? String(args.oid) : '',
          text: String(args.text || ''),
          atName: args.atName ? String(args.atName) : '',
          atUid: args.atUid ? String(args.atUid) : '',
          root: args.root ? String(args.root) : '',
          parent: args.parent ? String(args.parent) : '',
        })
      },
    })

    tool({
      name: 'toy_like',
      description: '给 toy 点赞 / 取消点赞（要登录）。',
      parameters: {
        id: { type: 'string', description: 'toy 数字 id' },
        on: { type: 'boolean', description: 'true=点赞（默认），false=取消' },
      },
      async execute(args) { return bili.like({ toyId: String(args.id || ''), on: args.on !== false }) },
    })

    tool({
      name: 'toy_favorite',
      description: '收藏 / 取消收藏一个 toy（要登录；toy 收藏是独立的一套，不进普通收藏夹）。不传 id 时列出收藏夹（普通收藏夹，仅供查看）。',
      parameters: {
        id: { type: 'string', description: 'toy 数字 id（省略 = 列普通收藏夹）' },
        on: { type: 'boolean', description: 'true=收藏（默认），false=取消' },
      },
      async execute(args) {
        if (!args.id) return bili.favFolders()
        return bili.favorite({ toyId: String(args.id), on: args.on !== false })
      },
    })

    tool({
      name: 'toy_mine',
      description: '「我的」：what=fav(我收藏的) / created(我创作的) / visited(近期玩过) / info(账号信息)。要登录。',
      parameters: {
        what: { type: 'string', description: 'fav | created | visited | info，默认 fav' },
        page: { type: 'number', description: '第几页（默认 1）' },
      },
      async execute(args) {
        const what = String(args.what || 'fav').toLowerCase()
        const page = Math.max(1, Number(args.page) || 1)
        if (what === 'info') return bili.userInfo()
        if (what === 'created') return bili.myCreated({ page, pageSize: cfg.pageSize })
        if (what === 'visited') return bili.myVisited({ page, pageSize: cfg.pageSize })
        return bili.favoriteMine({ page, pageSize: cfg.pageSize })
      },
    })

    tool({
      name: 'toy_probe',
      description: '列出已经验证过的 Toy 接口地图（纯本地，不发请求）。排查"哪个接口变了"时看它。',
      parameters: {},
      async execute() { return bili.probe() },
    })
  }

  /* ─────────────── 设置页要的 HTTP 路由 ─────────────── */

  const sendJson = (res, status, body) => {
    try {
      const buf = Buffer.from(JSON.stringify(body), 'utf8')
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(buf)
    } catch { /* 连接断了就算了 */ }
  }

  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy() })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })

  /** 只接受本机同源请求（本机别的网页也可能打到 127.0.0.1） */
  const sameOriginOk = (req) => {
    try {
      const host = String(req.headers.host || '')
      if (!host) return true
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
      const pick = String(req.headers.origin || req.headers.referer || '')
      if (!pick) return true
      const u = new URL(pick)
      return /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)
    } catch { return false }
  }

  const handle = async (req, res, url) => {
    const p = url.pathname.replace(/^\/api\/bili-toy/, '') || '/'
    const method = String(req.method || 'GET').toUpperCase()

    if (method === 'GET' && (p === '/status' || p === '/')) {
      const cred = loadCred()
      const s = loadSettings()
      return sendJson(res, 200, {
        ok: true,
        loggedIn: !!cred?.sessdata,
        user: cred ? { uname: cred.uname || '', mid: cred.mid || cred.dedeuserid || '' } : null,
        settings: s,
        version: myVersion(),
        home,
        qrReady: !!QRCache,
        endpoints: 'located',
      })
    }

    if (method === 'GET' && p === '/qr') {
      const r = await bili.loginQr()
      if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error })
      const dataUrl = await qrDataUrl(r.url)
      qrCache.set(r.key, { dataUrl, at: Date.now() })
      return sendJson(res, 200, { ok: true, key: r.key, url: r.url, dataUrl, expireSeconds: r.expireSeconds || 180, qrReady: !!QRCache }) // 前端只要 dataUrl
    }

    if (method === 'POST' && p === '/poll') {
      const body = await readBody(req)
      const r = await bili.loginPoll(String(body.key || ''))
      return sendJson(res, 200, r)
    }

    if (method === 'POST' && p === '/logout') {
      clearCred()
      return sendJson(res, 200, { ok: true })
    }

    if (method === 'GET' && p === '/settings') {
      return sendJson(res, 200, { ok: true, settings: loadSettings(), config: cfg })
    }

    if (method === 'POST' && p === '/settings') {
      const body = await readBody(req)
      const next = saveSettings(body.patch || body || {})
      return sendJson(res, 200, { ok: true, settings: next })
    }

    if (method === 'GET' && p === '/probe') {
      return sendJson(res, 200, { ok: true, probe: await bili.probe() })
    }

    // 客户端半端的探针：浏览器里 bundle 加载/apply/注册到哪一步了，全靠它回报
    if (method === 'GET' && p === '/ping') {
      const where = String(url.searchParams.get('where') || '?')
      const extra = String(url.searchParams.get('x') || '')
      log(`[client] ${where}${extra ? ' | ' + extra : ''}`)
      return sendJson(res, 200, { ok: true })
    }

    return sendJson(res, 404, { ok: false, error: '没有这个接口：' + p })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-toy',
      handler: async (req, res) => {
        if (!sameOriginOk(req)) return sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
        try {
          await handle(req, res, new URL(req.url, 'http://127.0.0.1'))
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message || String(e) })
        }
      },
    }), 'bili-toy: /api/bili-toy 路由')
  } catch (e) {
    log(`HTTP 路由没挂上：${e?.message || e}`)
  }

  // ── 自检：设置页那一半（client bundle）有没有进组合图 ──
  // 组合是异步 flush 的，apply 当下通常还没轮到我们，所以延迟采一次。
  // ⚠️ 客户端包能不能被认出来，取决于 package.json 的 exports 里有 "./package.json"
  //    （client-modules 在没有 loader.internal 的运行时走 createRequire 兜底解析）。
  try {
    const cm = (typeof ctx.get === 'function' ? ctx.get('clientModules') : null) || ctx.clientModules
    if (cm && typeof cm.clientPath === 'function') {
      setTimeout(() => {
        try {
          log(`自检：设置页 bundle = ${cm.clientPath('@local/dsh-bili-toy') || '没进组合图（检查 exports["./package.json"] 与 dsh.client）'}`)
        } catch { /* 忽略 */ }
      }, 6000)
    }
  } catch { /* 忽略 */ }

  log(`已挂载（家=${home}，qrcode=${QRCache ? '宿主自带' : 'python 兜底'}，v${myVersion()}）`)
}
