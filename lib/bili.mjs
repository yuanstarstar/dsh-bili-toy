/**
 * lib/bili.mjs —— B站 Toy 的所有网络动作（跑在宿主进程里，不受 shell 沙箱限制）
 * ============================================================================
 * 分成四块：
 *   ① 底层 HTTP：带 cookie / UA / referer 的 fetch，统一解析 { code, message, data }
 *   ② 扫码登录：passport 生成二维码 → 轮询 → 从 **Set-Cookie** 取令牌 → 校验身份
 *   ③ 接口地图：全部真名路径（2026-11 从 plaza 的 Vite chunk 里扒出来的，已逐条 curl 验证）
 *        读接口一律不需要签名/登录；⚠️ 写接口（点赞/评论/收藏）必须带 cookie + csrf
 *   ④ Toy 操作：广场列表 / 搜索 / 周榜 / 详情 / 打开 / 评论（含 @）/ 点赞 / 收藏 / 我的
 * ============================================================================
 */
import { loadCred, saveCred, loadSettings, saveSettings, logLine } from './state.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'
const REFERER = 'https://www.bilibili.com/'
const API = 'https://api.bilibili.com'
const PASSPORT = 'https://passport.bilibili.com'

export const TOY_HOME = 'https://www.bilibili.com/btoy/square/'
export const toyUrlOf = (id) => `https://www.bilibili.com/toy/${String(id)}/index.html`
/** 评论类型：Toy 在 B站 评论体系里的 type 就是 11（从 pc-detail 的 `data-params="11,<rid>"` 扒出） */
export const REPLY_TYPE = 11

/** 饼干头 */
export function cookieOf() {
  const c = loadCred()
  if (!c) return ''
  const parts = []
  if (c.sessdata) parts.push('SESSDATA=' + c.sessdata)
  if (c.bili_jct) parts.push('bili_jct=' + c.bili_jct)
  if (c.dedeuserid) parts.push('DedeUserID=' + c.dedeuserid)
  if (c.buvid3) parts.push('buvid3=' + c.buvid3)
  if (c.buvid4) parts.push('buvid4=' + c.buvid4)
  return parts.join('; ')
}

/** 底层：返回 { status, headers, text } */
async function raw(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  const signal = AbortSignal.timeout(timeoutMs)
  const res = await fetch(url, { method, headers, body, signal, redirect: 'follow' })
  const text = await res.text()
  return { status: res.status, headers: res.headers, text }
}

/** 统一 JSON 接口：返回 { code, message, data }（HTTP 层错误也包成同样的形状） */
export async function apiJSON(path, { query, form, method, auth = true, referer = REFERER, timeoutMs = 15000, base = API } = {}) {
  // ⚠️ 二维码相关接口在 passport.bilibili.com 上，打到 api.bilibili.com 会拿到 404 HTML
  const url = new URL(path.startsWith('http') ? path : base + path)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      const s = String(v)
      // ⚠️ NaN / undefined 这类脏参数别塞进 URL，服务端只会回 -400「请求错误」
      if (s === 'NaN' || s === 'undefined' || s === 'null') continue
      url.searchParams.set(k, s)
    }
  }
  const headers = {
    'user-agent': UA,
    referer,
    origin: 'https://www.bilibili.com',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
  }
  if (auth) {
    const ck = cookieOf()
    if (ck) headers.cookie = ck
  }
  let body
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(form).toString()
  }
  try {
    const r = await raw(url.toString(), { method: form ? 'POST' : (method || 'GET'), headers, body, timeoutMs })
    if (!r.text.trim()) return { code: -1, message: `空响应（HTTP ${r.status}）`, data: null }
    try {
      const j = JSON.parse(r.text)
      return { ...j, __httpStatus: r.status }
    } catch {
      const head = r.text.slice(0, 120).replace(/\s+/g, ' ')
      return { code: -1, message: `返回不是 JSON（HTTP ${r.status}）：${head}`, data: null, __httpStatus: r.status }
    }
  } catch (e) {
    return { code: -1, message: `请求失败：${e?.message || e}`, data: null }
  }
}

/* ============================ ② 扫码登录 ============================ */

export async function loginQr() {
  const j = await apiJSON('/x/passport-login/web/qrcode/generate', {
    query: { source: 'main-fe-header' }, auth: false, base: PASSPORT,
  })
  if (j.code !== 0 || !j.data?.url) {
    return { ok: false, error: `生成二维码失败：code=${j.code} ${j.message || ''}`.trim() }
  }
  return { ok: true, key: j.data.qrcode_key, url: j.data.url, expireSeconds: 180 }
}

const CODE_TEXT = {
  0: 'ok',
  86101: 'wait',
  86090: 'scanned',
  86038: 'expired',
}

/** 解析 Set-Cookie 头 → { sessdata, bili_jct, dedeuserid, buvid3, buvid4 } */
function parseSetCookies(list) {
  const out = {}
  for (const line of list || []) {
    const first = String(line).split(';')[0]
    const i = first.indexOf('=')
    if (i <= 0) continue
    const name = first.slice(0, i).trim()
    const value = first.slice(i + 1).trim()
    if (!value) continue
    if (name === 'SESSDATA') out.sessdata = value
    else if (name === 'bili_jct') out.bili_jct = value
    else if (name === 'DedeUserID') out.dedeuserid = value
    else if (name === 'buvid3') out.buvid3 = value
    else if (name === 'buvid4') out.buvid4 = value
  }
  return out
}

/** 补 buvid3（没有它有些接口会 412） */
async function ensureBuvid(cred) {
  if (cred.buvid3) return cred
  const j = await apiJSON('/x/frontend/finger/spi', { auth: false })
  if (j.code === 0 && j.data?.b_3) {
    return { ...cred, buvid3: j.data.b_3, buvid4: j.data.b_4 || cred.buvid4 }
  }
  return cred
}

export async function loginPoll(key) {
  if (!key) return { ok: false, state: 'error', error: '缺少 key（先调 toy_login_qr）' }
  const url = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
    + `?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`
  let r
  try {
    r = await raw(url, { headers: { 'user-agent': UA, referer: REFERER } })
  } catch (e) {
    return { ok: false, state: 'error', error: `轮询失败：${e?.message || e}` }
  }
  let j
  try { j = JSON.parse(r.text) } catch {
    return { ok: false, state: 'error', error: `轮询返回不是 JSON：${r.text.slice(0, 160)}` }
  }
  const code = j?.data?.code
  const state = CODE_TEXT[code] || 'wait'
  if (state === 'wait') return { ok: true, state: 'wait', hint: '二维码还没被扫' }
  if (state === 'scanned') return { ok: true, state: 'scanned', hint: '手机已扫码，等他点「确认登录」' }
  if (state === 'expired') return { ok: true, state: 'expired', hint: '二维码过期了，重新生成一张' }
  if (code !== 0) return { ok: false, state: 'error', error: `未知状态 code=${code} ${j?.message || ''}`.trim() }

  // code === 0：令牌在 Set-Cookie 里
  const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
  let cred = parseSetCookies(setCookies)
  if (!cred.sessdata) {
    // 有些运行环境拿不到 getSetCookie —— 退一步：从 data.url 里再抠一次
    const u = String(j?.data?.url || '')
    try {
      const q = new URL(u)
      cred = {
        sessdata: decodeURIComponent(q.searchParams.get('SESSDATA') || ''),
        bili_jct: q.searchParams.get('bili_jct') || '',
        dedeuserid: q.searchParams.get('DedeUserID') || '',
        buvid3: cred.buvid3,
      }
    } catch { /* 忽略 */ }
  }
  if (!cred.sessdata) {
    return {
      ok: false, state: 'error',
      error: '登录成功但没拿到 SESSDATA（Set-Cookie 被运行环境藏了）。'
        + '可以改用浏览器 Cookie 手动导入：把 SESSDATA 填进设置页。',
    }
  }
  cred = await ensureBuvid(cred)
  const who = await navInfo({ cookieOverride: cred })
  if (who.ok) {
    cred.uname = who.uname
    cred.mid = who.mid
  }
  saveCred(cred)
  saveSettings({ lastLoginAt: new Date().toISOString() })
  logLine('login', { mid: cred.mid, uname: cred.uname })
  return {
    ok: true, state: 'ok',
    user: { mid: cred.mid || cred.dedeuserid, uname: cred.uname || '' },
    hint: '登录成功，凭证已存到插件家目录',
  }
}

/** 谁登录着（凭证是否还有效） */
export async function navInfo({ cookieOverride } = {}) {
  const ck = cookieOverride ? '' : cookieOf()
  const headers = { 'user-agent': UA, referer: REFERER }
  const cookie = cookieOverride
    ? Object.entries({ SESSDATA: cookieOverride.sessdata, bili_jct: cookieOverride.bili_jct, DedeUserID: cookieOverride.dedeuserid })
      .filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ')
    : ck
  if (cookie) headers.cookie = cookie
  try {
    const r = await raw(`${API}/x/web-interface/nav`, { headers })
    const j = JSON.parse(r.text)
    const d = j?.data || {}
    return {
      ok: !!d.isLogin,
      code: j?.code,
      message: j?.message,
      uname: d.uname || '',
      mid: d.mid || 0,
      vip: d.vipStatus === 1 || d.vipstatus === 1,
      level: d.level_info?.current_level ?? null,
    }
  } catch (e) {
    return { ok: false, error: `查询登录状态失败：${e?.message || e}` }
  }
}

/* ============================ ③ 接口地图 ============================ */

/**
 * 真名接口表（全部 `https://api.bilibili.com` + 路径，GET，读接口不需要 WBI 签名）。
 * 来源：plaza 的 `useToast-BDO8F363.js`（`var Eu="/x/toy"` + `Z()` 调用点）与
 *       pc-detail 的 `index.js`（`Md="/x/toy"` + `Ld()` 调用点）。
 */
export const ENDPOINTS = {
  login: {
    qr: 'GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header',
    poll: 'GET https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=&source=main-fe-header',
    nav: 'GET /x/web-interface/nav',
  },
  plaza: {
    'category': 'GET /x/toy/plaza/category?category=<ALL|GAME|INTERACTIVE_PLAY|TOOL|TEST|GUIDE|COLLECTION|OTHER>&pn=&ps=',
    'recommend': 'GET /x/toy/plaza/recommend?page=&days=',
    'search': 'GET /x/toy/plaza/search?keyword=&pn=&ps=',
    'weekly': 'GET /x/toy/plaza/weekly',
    'weekly/edition': 'GET /x/toy/plaza/weekly/edition?edition_no=',
    'weekly/editions': 'GET /x/toy/plaza/weekly/editions?pn=&ps=',
    'activity': 'GET /x/toy/plaza/activity?activity=&pn=&ps=',
    'activities': 'GET /x/toy/plaza/activities',
    'favorite/mine': 'GET /x/toy/favorite/mine?pn=&ps= (需登录，不认 sort)',
    'plaza/my/created': 'GET /x/toy/plaza/my/created?pn=&ps= (需登录，不认 sort)',
    'plaza/my/visited': 'GET /x/toy/plaza/my/visited?pn=&ps=&sort= (需登录，认 sort)',
    'user/info': 'GET /x/toy/user/info (需登录)',
  },
  toy: {
    detail: 'GET /x/toy/detail?id=<数字 id>  ← rid 字段就是评论 oid',
    relatedVideos: 'GET /x/toy/related/videos?id=<数字 id>',
    authorToys: 'GET /x/toy/author/toys?mid=&pn=&ps=',
    like: 'POST /x/toy/like {toy_id, action: like|cancel} (需登录 + csrf)',
    report: 'POST /x/toy/report {toy_id, ...} (需登录)',
  },
  comment: {
    list: 'GET /x/v2/reply?type=11&oid=<rid>&pn=&ps=&sort=2',
    add: 'POST /x/v2/reply/add {type:11, oid:<rid>, message, csrf} (需登录)',
  },
  favorite: {
    add: 'POST /x/toy/favorite/add {toy_id, csrf} (需登录)',
    del: 'POST /x/toy/favorite/del {toy_id, csrf} (需登录)',
    mine: 'GET /x/toy/favorite/mine?pn=&ps= (需登录)',
  },
  open: 'window.open(playUrl + "?spm_id_from=...")  —— 前端行为，不是接口',
}

/** 兼容旧接口：返回接口地图（纯本地，不再发请求） */
export async function probe() {
  return { ok: true, at: new Date().toISOString(), note: '接口已定位并验证，这里只是静态地图', endpoints: ENDPOINTS }
}

/* ============================ ④ Toy 操作 ============================ */

/** UI 标签 key → 接口 category 值 */
export const CATEGORY_MAP = {
  all: 'ALL',
  game: 'GAME',
  'interactive-play': 'INTERACTIVE_PLAY',
  tool: 'TOOL',
  test: 'TEST',
  guide: 'GUIDE',
  collection: 'COLLECTION',
  other: 'OTHER',
}
/** 也可以直接传大写值 */
const CATEGORY_LABELS = {
  ALL: '全部', GAME: '游戏', INTERACTIVE_PLAY: '互动玩法', TOOL: '工具',
  TEST: '测试', GUIDE: '攻略', COLLECTION: '合集', OTHER: '其他',
}

/** 把接口返回的 toy 对象规整成统一形状 */
export function normalizeToy(o) {
  if (!o || typeof o !== 'object') return null
  const id = String(o.id ?? o.toy_id ?? '')
  const stat = o.stat || {}
  const dyn = o.dyn_stat || {}
  const plays = o.play_count ?? stat.pv ?? stat.play ?? dyn.play ?? null
  const url = String(o.url || (id ? toyUrlOf(id) : ''))
  return {
    id,
    rid: String(o.rid ?? ''),                    // 评论 oid
    title: String(o.title || '').replace(/<[^>]+>/g, '').trim(),
    category: o.category || '',
    categoryCn: CATEGORY_LABELS[o.category] || o.category || '',
    author: o.user_info?.name || '',
    authorMid: o.user_info?.mid ?? null,
    plays,
    likes: dyn.like ?? null,
    comments: dyn.comment ?? null,
    favorites: dyn.favorite ?? null,
    url,
  }
}

export function allItemsOf(data) {
  if (!data) return []
  if (Array.isArray(data.list)) return data.list
  if (Array.isArray(data.items)) return data.items
  if (Array.isArray(data.replies)) return data.replies
  if (Array.isArray(data)) return data
  return []
}
export function firstItemOf(data) { return allItemsOf(data)[0] || null }

function pageOf(data, page, pageSize, root) {
  const total = root?.item_count ?? root?.total ?? data?.page?.count ?? data?.total ?? null
  const items = allItemsOf(data).map(normalizeToy).filter(Boolean)
  return { ok: true, page, pageSize, total, count: items.length, items }
}

/** 广场分类列表 */
export async function plazaCategory({ category = 'ALL', page = 1, pageSize = 20 } = {}) {
  const key = CATEGORY_MAP[String(category || '').toLowerCase()] || String(category || 'ALL').toUpperCase()
  const j = await apiJSON('/x/toy/plaza/category', { query: { category: key, pn: page, ps: pageSize } })
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message, hint: j.code === 307000 ? 'category 值不合法（用 all/game/tool/test/guide/collection/other/interactive-play）' : '' }
  return { ...pageOf(j.data, page, pageSize, j.data), category: key, categoryCn: CATEGORY_LABELS[key] || key }
}

/** 今日推荐 */
export async function plazaRecommend({ page = 1, days = 1 } = {}) {
  const j = await apiJSON('/x/toy/plaza/recommend', { query: { page, days } })
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message }
  return { ...pageOf(j.data, page, 0, j.data), showDate: j.data?.show_date || '' }
}

/** 广场周榜 */
export async function plazaWeekly() {
  const j = await apiJSON('/x/toy/plaza/weekly')
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message }
  const p = pageOf(j.data, 1, 0, j.data)
  return { ...p, pageSize: p.count, editionNo: j.data?.edition_no ?? null, status: j.data?.status || '' }
}

export async function plazaWeeklyEditions({ page = 1, pageSize = 20 } = {}) {
  const j = await apiJSON('/x/toy/plaza/weekly/editions', { query: { pn: page, ps: pageSize } })
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message }
  return pageOf(j.data, page, pageSize, j.data)
}

export async function plazaWeeklyEdition(editionNo) {
  const j = await apiJSON('/x/toy/plaza/weekly/edition', { query: { edition_no: editionNo } })
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message }
  return { ...pageOf(j.data, 1, 0, j.data), editionNo: j.data?.edition_no ?? Number(editionNo) }
}

/** 广场活动（S赛等） */
export async function plazaActivities() {
  const j = await apiJSON('/x/toy/plaza/activities')
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message }
  return { ok: true, items: j.data?.list || [] }
}

export async function plazaActivity({ activity, page = 1, pageSize = 20 } = {}) {
  if (!activity) return { ok: false, error: '需要 activity（先 toy_square 传 activity:true 或看 toy_activities 的 code）' }
  const j = await apiJSON('/x/toy/plaza/activity', { query: { activity, pn: page, ps: pageSize } })
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message }
  return { ...pageOf(j.data, page, pageSize, j.data), activity }
}

/**
 * 广场总入口：tab 决定打哪个接口
 * tab: all / game / interactive-play / tool / test / guide / collection / other / recommend / weekly
 */
export async function square({ tab = 'all', page = 1, pageSize = 20, days = 1 } = {}) {
  const t = String(tab || 'all').toLowerCase()
  if (t === 'recommend') return { ...(await plazaRecommend({ page, days })), tab: t }
  if (t === 'weekly') return { ...(await plazaWeekly()), tab: t }
  return { ...(await plazaCategory({ category: t, page, pageSize })), tab: t }
}

/** 搜索 */
export async function searchToy({ keyword, page = 1, pageSize = 20 } = {}) {
  const kw = String(keyword || '').trim()
  if (!kw) return { ok: false, error: '关键词不能为空' }
  const j = await apiJSON('/x/toy/plaza/search', { query: { keyword: kw, pn: page, ps: pageSize } })
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message, hint: j.code === -352 ? '被风控了，等一会或登录后再试' : '' }
  return { ...pageOf(j.data, page, pageSize, j.data), keyword: kw }
}

/** 详情（含 rid / 作者 / 播放量 / 点赞收藏评论数 / 关注状态） */
export async function detail(idOrUrl) {
  const id = toyIdOf(idOrUrl)
  if (!id) return { ok: false, error: `认不出 toy id：${idOrUrl}（要数字 id 或 /toy/<id>/ 链接）` }
  const j = await apiJSON('/x/toy/detail', { query: { id } })
  if (j.code !== 0) return { ok: false, id, code: j.code, message: j.message, hint: j.code === -404 ? '没有这个 toy（id 错了？）' : '' }
  const d = j.data || {}
  return {
    ok: true,
    toy: normalizeToy(d),
    rid: String(d.rid ?? ''),
    version: d.version ?? null,
    theme: d.theme || '',
    dynId: d.dyn_id || '',
    action: d.user_action || {},
    pv: d.stat?.pv ?? null,
    ctime: d.ctime ? new Date(d.ctime * 1000).toISOString() : '',
    mtime: d.mtime ? new Date(d.mtime * 1000).toISOString() : '',
  }
}

/** 从链接/数字里取 toy id */
export function toyIdOf(idOrUrl) {
  const s = String(idOrUrl ?? '').trim()
  if (!s) return ''
  if (/^\d{6,}$/.test(s)) return s
  const m = s.match(/\/toy\/([A-Za-z0-9_-]+)\/index\.html/i)
  // slug 不是 id，但 /toy/<数字>/ 也可能是 id
  const digits = s.match(/\/toy\/(\d{6,})(?:\/|$)/)
  if (digits) return digits[1]
  if (m && /^\d{6,}$/.test(m[1])) return m[1]
  return ''
}

/** 打开 toy：优先用详情里的 url，拿到就拉起系统浏览器 */
export async function openToy(idOrUrl) {
  let url = /^https?:/i.test(String(idOrUrl)) ? String(idOrUrl) : ''
  let toy = null
  const id = toyIdOf(idOrUrl)
  if (id) {
    const d = await detail(id)
    if (d.ok) { toy = d.toy; url = toy.url }
  }
  if (!url) return { ok: false, error: `不知道要打开什么：${idOrUrl}` }
  // 加上来源参数，跟广场「Toy启动」一致
  const finalUrl = url.includes('?') ? url : `${url}?spm_id_from=333.40250.home.play.click`
  const { spawn } = await import('node:child_process')
  try {
    if (process.platform === 'win32') {
      spawn('rundll32', ['url.dll,FileProtocolHandler', finalUrl], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [finalUrl], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [finalUrl], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch (e) {
    return { ok: false, url: finalUrl, error: `拉起浏览器失败：${e?.message || e}` }
  }
  saveSettings({ currentToy: { id: toy?.id || id, title: toy?.title || '', url: finalUrl, at: new Date().toISOString() } })
  logLine('open', { id: toy?.id || id })
  return {
    ok: true, url: finalUrl, id: toy?.id || id, title: toy?.title || '',
    hint: '已经在系统浏览器里打开；游戏里的操作交给专用包（cv/coach 那套）',
  }
}

/** rid / oid：评论需要 detail 里的 rid（数字字符串） */
async function ensureRid({ toyId, oid }) {
  if (oid) return { ok: true, oid: String(oid) }
  const d = await detail(toyId)
  if (!d.ok) return { ok: false, error: d.error || d.message || '拿不到 toy 详情' }
  if (!d.rid) return { ok: false, error: '这个 toy 没有 rid（可能被关闭评论了）' }
  return { ok: true, oid: d.rid, toy: d.toy }
}

/** 评论列表（type=11） */
export async function comments({ toyId, oid, page = 1, pageSize = 20, sort = 2 } = {}) {
  const r = await ensureRid({ toyId, oid })
  if (!r.ok) return r
  const j = await apiJSON('/x/v2/reply', { query: { type: REPLY_TYPE, oid: r.oid, pn: page, ps: pageSize, sort } })
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message, oid: r.oid }
  const list = (j.data?.replies || []).map((x) => ({
    rpid: String(x.rpid_str || x.rpid),
    uname: x.member?.uname || '',
    mid: x.mid_str || String(x.mid || ''),
    text: String(x.content?.message || '').replace(/<[^>]+>/g, ''),
    like: x.like || 0,
    replies: x.rcount || 0,
    root: x.root ?? 0,
    parent: x.parent ?? 0,
    at: x.ctime ? new Date(x.ctime * 1000).toISOString() : '',
  }))
  return {
    ok: true, oid: r.oid, type: REPLY_TYPE, page, sort,
    total: j.data?.page?.count ?? null, items: list,
    hint: list.length ? '' : '这页没评论了（或都被删了）',
  }
}

/** 发评论（可 @ 人）；type 固定 11 */
export async function postComment({ toyId, oid, text, atName, atUid, root, parent } = {}) {
  const cred = loadCred()
  if (!cred?.sessdata) return { ok: false, error: '还没登录：先在设置页「玩Toy」里扫码（或调 toy_login_qr → toy_login_poll）' }
  if (!cred.bili_jct) return { ok: false, error: '凭证里缺 bili_jct（发评论要它作 csrf）。重新扫码登录一次' }
  const body = String(text || '').trim()
  if (!body) return { ok: false, error: '评论内容不能为空' }
  if (body.length > 990) return { ok: false, error: `太长了（${body.length} 字），B站 评论上限 1000 字` }
  const r = await ensureRid({ toyId, oid })
  if (!r.ok) return r
  let message = body
  if (atName) message = `@${String(atName).replace(/^@/, '')} ` + body
  const form = { oid: r.oid, type: REPLY_TYPE, message, csrf: cred.bili_jct, plat: 1, ordering: 'heat' }
  if (root) form.root = root
  if (parent) form.parent = parent
  if (atUid) form.at_uids = atUid
  const j = await apiJSON('/x/v2/reply/add', { form })
  if (j.code !== 0) {
    return {
      ok: false, code: j.code, message: j.message,
      hint: j.code === -111 ? 'csrf 校验失败：重新登录' : j.code === -404 ? '内容不存在（oid 不对）' : j.code === -412 ? '被风控了，过一会再发' : 'B站 拒绝了这条评论',
    }
  }
  logLine('comment', { oid: r.oid, rpid: j.data?.rpid })
  return { ok: true, rpid: String(j.data?.rpid_str || j.data?.rpid || ''), oid: r.oid, message: j.data?.reply?.content?.message || message, hint: '评论发出去了' }
}

/** 点赞 / 取消点赞 */
export async function like({ toyId, on = true } = {}) {
  const id = toyIdOf(toyId) || String(toyId || '')
  if (!id) return { ok: false, error: '需要 toy id' }
  const cred = loadCred()
  if (!cred?.sessdata) return { ok: false, error: '还没登录：先扫码' }
  if (!cred.bili_jct) return { ok: false, error: '凭证里缺 bili_jct（点赞要它作 csrf）。重新扫码登录一次' }
  // ⚠️ 必须带 csrf，否则 B站 回 -111
  const j = await apiJSON('/x/toy/like', { form: { toy_id: id, action: on ? 'like' : 'cancel', csrf: cred.bili_jct } })
  if (j.code !== 0) {
    return {
      ok: false, code: j.code, message: j.message,
      hint: j.code === -111 ? 'csrf 校验失败：重新扫码登录一次' : '',
    }
  }
  logLine('like', { id, on })
  return { ok: true, id, action: on ? 'like' : 'cancel', hint: on ? '已点赞' : '已取消点赞' }
}

/** 收藏夹列表（拿默认收藏夹 id） */
export async function favFolders() {
  const cred = loadCred()
  if (!cred?.dedeuserid) return { ok: false, error: '还没登录：先扫码' }
  const j = await apiJSON('/x/v3/fav/folder/created/list-all', { query: { up_mid: cred.dedeuserid } })
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message }
  return { ok: true, items: (j.data?.list || []).map((f) => ({ id: f.id, title: f.title, count: f.media_count })) }
}

/** 收藏 / 取消收藏。⚠️ 不是通用收藏接口：toy 走 /x/toy/favorite/add|del，body 只要 toy_id */
export async function favorite({ toyId, on = true } = {}) {
  const cred = loadCred()
  if (!cred?.sessdata) return { ok: false, error: '还没登录：先扫码' }
  if (!cred.bili_jct) return { ok: false, error: '凭证里缺 bili_jct（收藏要它作 csrf）' }
  const id = toyIdOf(toyId) || String(toyId || '')
  if (!id) return { ok: false, error: '需要 toy id' }
  const path = on ? '/x/toy/favorite/add' : '/x/toy/favorite/del'
  const j = await apiJSON(path, { form: { toy_id: id, csrf: cred.bili_jct } })
  if (j.code !== 0) {
    return {
      ok: false, code: j.code, message: j.message,
      hint: j.code === -111 ? 'csrf 校验失败：重新扫码登录一次' : j.code === 65004 ? '取消收藏没成功（可能本来就没收藏）' : '',
    }
  }
  logLine('favorite', { id, on })
  return { ok: true, id, action: on ? 'add' : 'del' }
}

/** 我的收藏（toy 维度）——这个接口不认 sort，带了会 307000 */
export async function favoriteMine({ page = 1, pageSize = 20 } = {}) {
  const j = await apiJSON('/x/toy/favorite/mine', { query: { pn: page, ps: pageSize } })
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message, hint: j.code === -101 ? '要登录' : '' }
  return pageOf(j.data, page, pageSize, j.data)
}

/** 我创作的（不认 sort） */
export async function myCreated({ page = 1, pageSize = 20 } = {}) {
  const j = await apiJSON('/x/toy/plaza/my/created', { query: { pn: page, ps: pageSize } })
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message }
  return pageOf(j.data, page, pageSize, j.data)
}

/** 近期玩过（这个认 sort） */
export async function myVisited({ page = 1, pageSize = 20, sort = 0 } = {}) {
  const j = await apiJSON('/x/toy/plaza/my/visited', { query: { pn: page, ps: pageSize, sort } })
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message }
  return pageOf(j.data, page, pageSize, j.data)
}

/** 自己的账号信息 */
export async function userInfo() {
  const j = await apiJSON('/x/toy/user/info')
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message, hint: j.code === -101 ? '要登录' : '' }
  return { ok: true, ...j.data }
}

/** 作者的其他 toy */
export async function authorToys({ mid, page = 1, pageSize = 20 } = {}) {
  if (!mid) return { ok: false, error: '需要作者 mid' }
  const j = await apiJSON('/x/toy/author/toys', { query: { mid, pn: page, ps: pageSize } })
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message }
  return pageOf(j.data, page, pageSize, j.data)
}

/** 相关视频（toy 详情页底部） */
export async function relatedVideos({ id } = {}) {
  const tid = toyIdOf(id) || String(id || '')
  if (!tid) return { ok: false, error: '需要 toy id' }
  const j = await apiJSON('/x/toy/related/videos', { query: { id: tid } })
  if (j.code !== 0) return { ok: false, code: j.code, message: j.message }
  return { ok: true, total: j.data?.total ?? 0, items: (j.data?.items || []).map((v) => ({ bvid: v.bvid, title: v.title, cover: v.cover, aid: v.aid })) }
}

export function lastProbeReport() {
  return ENDPOINTS
}
