/**
 * dsh-bili-toy —— 浏览器半端（设置里的一页「玩Toy」）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是自注册脚本：
 *     window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
 * ⭐ 进「设置」的写法：slots.inject('settings.section', () => slots.register({...}, () => h(Panel)))
 * 这一页要给的：账号绑定（二维码直接显示在页里 + 扫完自动变状态）、几个选项、接口探测。
 * ============================================================================
 */
/* 诊断探针：bundle 被浏览器执行时回报一次（脚本级，早于 factory） */
try { fetch('/api/bili-toy/ping?where=script'); } catch (e) { /* 忽略 */ }
window.__ModuleLoader__.load({
  id: '@local/dsh-bili-toy',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const API = '/api/bili-toy'

    /* 诊断探针：客户端半端走到哪一步，回报给宿主写日志 */
    const ping = (where, extra) => {
      try {
        fetch(API + '/ping?where=' + encodeURIComponent(where) + (extra ? '&x=' + encodeURIComponent(String(extra)) : ''),
          { credentials: 'same-origin' }).catch(() => {})
      } catch (e) { /* 忽略 */ }
    }
    ping('factory')

    const asJson = async (res) => {
      if (res.ok) return res.json()
      throw new Error('HTTP ' + res.status + (res.status === 403 ? '（被宿主拦了）' : ''))
    }
    const jget = (p) => fetch(API + p, { credentials: 'same-origin' }).then(asJson)
    const jpost = (p, body) => fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(asJson)

    const CSS = `
    [data-bt-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 8px;max-width:620px;}
    [data-bt-card]{border:1px solid var(--dsw-alias-border-secondary,#2c2f36);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px;}
    [data-bt-title]{font-size:14px;font-weight:600;}
    [data-bt-note]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
    [data-bt-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
    [data-bt-btn]{border:1px solid var(--dsw-alias-border-secondary,#3a3f47);background:transparent;color:inherit;
      border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;}
    [data-bt-btn]:hover{background:rgba(127,127,127,.12);}
    [data-bt-btn][data-primary]{background:#1a73e8;border-color:#1a73e8;color:#fff;}
    [data-bt-btn]:disabled{opacity:.5;cursor:default;}
    [data-bt-qr]{width:200px;height:200px;border-radius:10px;background:#fff;padding:6px;display:block;}
    [data-bt-badge]{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-secondary,#3a3f47);}
    [data-bt-badge][data-on]{border-color:#2e7d32;color:#3ddc84;}
    [data-bt-input]{background:transparent;border:1px solid var(--dsw-alias-border-secondary,#3a3f47);
      border-radius:8px;padding:6px 10px;color:inherit;font-size:12px;width:200px;}
    [data-bt-pre]{font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all;max-height:240px;overflow:auto;
      background:rgba(127,127,127,.08);border-radius:8px;padding:10px;margin:0;}
    `

    const State = (props) => h('span', { 'data-bt-badge': '', 'data-on': props.on ? '' : undefined }, props.label)

    function Panel() {
      const [status, setStatus] = useState(null)
      const [qr, setQr] = useState(null)
      const [left, setLeft] = useState(0)
      const [pollState, setPollState] = useState('')
      const [busy, setBusy] = useState(false)
      const [err, setErr] = useState('')
      const [probe, setProbe] = useState(null)
      const [settings, setSettings] = useState(null)
      const timer = useRef(null)
      const tick = useRef(null)
      const auto = useRef(0)

      const refresh = async () => {
        try {
          const s = await jget('/status')
          setStatus(s)
          setSettings(s.settings || {})
          return s
        } catch (e) { setErr(String(e.message || e)); return null }
      }

      const stopTimers = () => {
        if (timer.current) { clearInterval(timer.current); timer.current = null }
        if (tick.current) { clearInterval(tick.current); tick.current = null }
      }

      const startQr = async (isAuto) => {
        if (!isAuto) auto.current = 0
        setErr('')
        setBusy(true)
        stopTimers()
        try {
          const r = await jget('/qr')
          if (!r.ok) { setErr(r.error || '生成二维码失败'); return }
          setQr(r)
          setLeft(r.expireSeconds || 180)
          setPollState('wait')
          tick.current = setInterval(() => setLeft((v) => (v > 0 ? v - 1 : 0)), 1000)
          timer.current = setInterval(async () => {
            try {
              const p = await jpost('/poll', { key: r.key })
              if (!p.ok) { setPollState('error: ' + (p.error || '')); return }
              setPollState(p.state)
              if (p.state === 'ok') { stopTimers(); setLeft(0); setTimeout(refresh, 300) }
              if (p.state === 'expired') stopTimers()
            } catch (e) { setPollState('error: ' + String(e.message || e)) }
          }, 2000)
        } catch (e) { setErr(String(e.message || e)) } finally { setBusy(false) }
      }

      // 打开「玩Toy」就先拿一张码，别让用户再点一次
      useEffect(() => {
        refresh().then((s) => { if (s && !s.loggedIn) startQr(true) })
      }, [])

      // 倒计时归零 → 自动换一张（最多自动换 3 次，之后要手动点）
      useEffect(() => {
        if (!qr || left > 0 || pollState === 'ok' || pollState === 'expired') return
        if (auto.current >= 3) return
        auto.current += 1
        startQr(true)
      }, [left, qr])

      useEffect(() => () => stopTimers(), [])

      const logout = async () => {
        setBusy(true)
        try { await jpost('/logout'); setQr(null); setPollState(''); await refresh() } catch (e) { setErr(String(e.message || e)) } finally { setBusy(false) }
      }

      const runProbe = async () => {
        setBusy(true)
        setProbe({ running: true })
        try { setProbe(await jget('/probe?fresh=1')) } catch (e) { setProbe({ error: String(e.message || e) }) } finally { setBusy(false) }
      }

      const patch = async (p) => {
        try {
          const r = await jpost('/settings', { patch: p })
          if (r.ok) setSettings(r.settings)
        } catch (e) { setErr(String(e.message || e)) }
      }

      const loggedIn = !!status?.loggedIn
      const leftText = qr && left > 0 && pollState !== 'ok' ? `（${left}s 后自动换码）` : ''
      const pollText = ({
        wait: '等他扫码…', scanned: '已扫码，等他点确认', ok: '登录成功 ✓', expired: '二维码过期了，点「重新生成二维码」',
      }[pollState] || pollState) + leftText

      return h('div', { 'data-bt-page': '' },
        h('div', { 'data-bt-card': '' },
          h('div', { 'data-bt-row': '' },
            h('span', { 'data-bt-title': '' }, 'B站 账号'),
            h(State, { on: loggedIn, label: loggedIn ? '已登录' : '未登录' }),
            status?.user?.uname ? h('span', { 'data-bt-note': '' }, `${status.user.uname}（mid ${status.user.mid}）`) : null,
            h('span', { 'data-bt-note': '', style: { marginLeft: 'auto' } }, status?.version ? 'v' + status.version : ''),
          ),
          h('div', { 'data-bt-row': '' },
            h('button', { 'data-bt-btn': '', 'data-primary': '', disabled: busy, onClick: startQr }, qr ? '重新生成二维码' : '扫码登录'),
            loggedIn ? h('button', { 'data-bt-btn': '', disabled: busy, onClick: logout }, '退出登录') : null,
            h('span', { 'data-bt-note': '' }, pollText),
          ),
          qr?.dataUrl ? h('img', { 'data-bt-qr': '', src: qr.dataUrl, alt: '登录二维码' }) : null,
          qr?.dataUrl
            ? h('div', { 'data-bt-note': '' }, '用手机 B站 扫上面这张图，扫完在手机上点「确认登录」，这里会自动变成已登录。'
              + '码 180 秒过期，快过期会自动换一张（最多自动换 3 次）。')
            : h('div', { 'data-bt-note': '' }, '登录凭证存在本机 <DSH_HOME>/bili-toy/credential.json，不会上传。'),
          err ? h('div', { 'data-bt-note': '', style: { color: '#ff8a80' } }, err) : null,
        ),

        h('div', { 'data-bt-card': '' },
          h('span', { 'data-bt-title': '' }, '玩法'),
          h('div', { 'data-bt-row': '' },
            h('span', { 'data-bt-note': '' }, '每页条数'),
            h('input', {
              'data-bt-input': '', type: 'number', min: 1, max: 50,
              value: settings?.pageSize ?? 20,
              onChange: (e) => patch({ pageSize: Math.max(1, Math.min(50, Number(e.target.value) || 20)) }),
            }),
          ),
          h('div', { 'data-bt-row': '' },
            h('span', { 'data-bt-note': '' }, '默认分类'),
            h('input', {
              'data-bt-input': '', type: 'text',
              value: settings?.category ?? 'all',
              onChange: (e) => patch({ category: e.target.value }),
            }),
          ),
          h('div', { 'data-bt-note': '' },
            '逛广场、打开 toy、看/发评论都在对话里用工具做（toy_square / toy_open / toy_comments / toy_comment）；'
            + '游戏画面里的按键操作不归这个包，交给专用包。'),
        ),

        h('div', { 'data-bt-card': '' },
          h('div', { 'data-bt-row': '' },
            h('span', { 'data-bt-title': '' }, '接口地图'),
            h('button', { 'data-bt-btn': '', disabled: busy, onClick: runProbe }, '看一下'),
          ),
          h('div', { 'data-bt-note': '' },
            'Toy 的接口没公开文档，这套工具用的路径是从前端 JS 里扒出来、逐条 curl 验过的。'
            + '点一下列出已验证的接口地图，排查"哪个接口变了"时用（纯本地，不发请求）。'),
          probe?.running ? h('div', { 'data-bt-note': '' }, '读取中…') : null,
          probe && !probe.running
            ? h('pre', { 'data-bt-pre': '' }, JSON.stringify(probe.probe || probe, null, 2).slice(0, 4000))
            : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ping('apply')
        try {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-bili-toy')
          style.textContent = CSS
          document.head.appendChild(style)
          if (typeof ctx.effect === 'function') ctx.effect(() => () => style.remove(), 'dsh-bili-toy: 设置页样式')
        } catch (e) { ping('style-fail', e && e.message) }

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) { ping('no-slots', 'get=' + typeof ctx.get + ', ctx.slots=' + typeof ctx.slots); return }
        try {
          slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: 'bili-toy', order: 32, label: '玩Toy' },
            () => h(Panel),
          ))
          ping('registered')
        } catch (e) { ping('register-fail', e && e.message) }

        // 备选入口：设置 → 插件 页里的一个标签（万一 section 列表没吃第三方的）
        try {
          slots.inject('settings.plugins.tab', () => slots.register(
            { name: 'settings.plugins.tab', id: 'bili-toy-tab', order: 40, label: '玩Toy' },
            () => h(Panel),
          ))
          ping('tab-registered')
        } catch (e) { ping('tab-fail', e && e.message) }
      },
    }
  },
})
