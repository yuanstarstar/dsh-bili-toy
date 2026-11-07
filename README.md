# dsh-bili-toy

让 DSH 能玩 B站 Toy（<https://www.bilibili.com/btoy/square/>）的**工具版**插件：扫码登录、逛广场、搜、看详情、打开、读/发评论（可 @ 人）、点赞、收藏。

**不做**：toy 画面里的点击/按键操作 —— 那交给专用包（`dsh-coach-perceive-v3` / `dsh-cv-recall` 那套）。这里只负责"把 toy 打开并递过去"。

## 工具（17 个）

| 类别 | 工具 |
| --- | --- |
| 登录 | `toy_login_qr` / `toy_login_poll` / `toy_login_status` / `toy_logout`（设置页 **玩Toy** 里也能扫码，二维码直接显示） |
| 逛 | `toy_square`（tab：all/game/interactive-play/tool/test/guide/collection/other/recommend/weekly）· `toy_weekly` · `toy_activities` · `toy_search` · `toy_detail` |
| 打开 | `toy_open`（系统浏览器新标签）· `toy_current`（上次打开的是哪个） |
| 评论 | `toy_comments`（读，type 固定 11）· `toy_comment`（发，可 atName/atUid，支持楼中楼 root/parent） |
| 互动 | `toy_like` · `toy_favorite`（不传 id 就列收藏夹）· `toy_mine`（fav/created/visited/info） |
| 排查 | `toy_probe`（返回已验证的接口地图，纯本地） |

## 接口（2026-11 实测，读接口免登录、写接口要 cookie+csrf）

基址 `https://api.bilibili.com`，Toy 前缀 `/x/toy`：

* 广场 `/plaza/category?category=ALL|GAME|INTERACTIVE_PLAY|TOOL|TEST|GUIDE|COLLECTION|OTHER&pn=&ps=`（缺 category 会 -400）
* `/plaza/recommend?page=&days=` · `/plaza/search?keyword=&pn=&ps=` · `/plaza/weekly` · `/plaza/weekly/edition?edition_no=` · `/plaza/weekly/editions?pn=&ps=` · `/plaza/activities` · `/plaza/activity?activity=&pn=&ps=`
* `/favorite/mine?pn=&ps=` · `/plaza/my/created?pn=&ps=` · `/plaza/my/visited?pn=&ps=&sort=`（前者**不认 sort**，带了会 307000「请求参数错误」；visited 认 sort）
* `/detail?id=<数字id>` → `rid` 就是评论 oid；还有 `dyn_stat` / `stat.pv` / `user_action` / `url`
* `/related/videos?id=` · `/author/toys?mid=&pn=&ps=` · `/user/info`
* 写：`POST /x/toy/like {toy_id, action: like|cancel, csrf}`（**漏 csrf 会 -111**）· `POST /x/v2/reply/add {type:11, oid:<rid>, message, csrf}` · 收藏走 toy 专用端点 `POST /x/toy/favorite/add|del {toy_id, csrf}`（**不是**通用收藏接口 `/x/v3/fav/resource/deal`，后者对 toy 回 2001000 参数错误）
* 评论列表 `GET /x/v2/reply?type=11&oid=<rid>&pn=&ps=&sort=`（**type=11**，从 pc-detail 的 `data-params="11,<rid>"` 扒出）
* 普通收藏夹 `GET /x/v3/fav/folder/created/list-all?up_mid=<mid>`（toy 收藏不进这里，只作对照）

登录走 `https://passport.bilibili.com/x/passport-login/web/qrcode/{generate,poll}`（**注意是 passport 域，打到 api 域会 404**），token 从轮询响应的 **Set-Cookie** 里取，缺 buvid3 时补 `api` 的 `/x/frontend/finger/spi`。
打开 toy = 前端 `window.open(url + "?spm_id_from=333.40250.home.play.click")`，不是接口。
`b23.tv/xxxx` 这种短链只有 slug（`/toy/<slug>/index.html`），数字 id 在那个页面的内联脚本里：`M.toyID=51139072750592;` —— 扒出来就能查详情/评论。

## 家目录

`<DSH_HOME>/bili-toy/`（默认 `C:\Users\<你>\.dsh\bili-toy\`）

* `credential.json` —— SESSDATA / bili_jct / DedeUserID / buvid3（Windows 上 icacls 收紧）
* `settings.json` —— pageSize / category / replySort / 上次打开的 toy
* `toy.log` —— 操作日志（保留 400 行）

## 分发（包里不含任何凭证）

**凭证不在插件目录里**，而是登录后单独写到 `<DSH_HOME>/bili-toy/credential.json`（用户目录，Windows 上用 icacls 收紧到本人）。所以整个插件目录可以随意打包给别人：

* 收包方第一次用要自己扫码（设置页 **玩Toy** → 扫码登录），SESSDATA / bili_jct 不会跟着包走；
* 包内**不要**带 `credential.json`、`settings.json`、`toy.log`、`login-qr.png`、`selfcheck-out.json`；
* 打包脚本见 `D:\\plugins\\dist\`（`make-zip.ps1`），产物是 `dsh-bili-toy-<version>.zip`，解压后放进 `plugins/` 再按下面步骤装。

## 安装（本机已装好，仅作记录）

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-bili-toy" `
  -Target "D:\\plugins\\plugins\dsh-bili-toy"
# profile 的 package.json：
#   dependencies: "@local/dsh-bili-toy": "link:D:\\plugins\\plugins/dsh-bili-toy"
#   dsh.profile.bundles: 追加 "@local/dsh-bili-toy"
```

装好后**首次不用重启**：宿主有 HMR 监听 profile 的 `package.json`，改完几秒内自动加载（日志 `logs\host\dsh-<日期>.log` 里能看到 `[hmr]` 相关行，插件自己的 `<家>\toy.log` 里会写「host 已挂载」）。
如果没生效，先看那条日志里的报错：最常见的是 **package.json 的 `name` 必须等于装进 node_modules 的那个包名**（这里是 `@local/dsh-bili-toy`），否则报 `profile package identity is invalid`。

⚠️ 但 HMR 只负责**第一次挂载**：之后再改插件源码（`.js` / `.mjs`），实测 HMR 不会重新 import（改版本号、再动 profile 的 `package.json` 也不重载，工具跑的还是旧代码）。要让新代码生效就**重启 DSH Desktop**。
客户端那半（`client.js`，设置页 UI）在浏览器页面里加载，改完刷新一下页面即可；插件如果是第一次挂载，也得刷新页面（或重启）才会看到「玩Toy」这一节。

### 设置页不出现「玩Toy」的排查（本机踩过的坑）

宿主 `client-modules` 靠 `entry.options.name` + 包清单来认客户端包，两条解析路：
1. 有 `loader.internal.resolveSync` 时直接解析模块 URL；
2. **没有时（本机就是这样）退回 `createRequire(baseUrl).resolve('<包名>/package.json')`** —— 这条路要求 `exports` 里显式声明 `"./package.json": "./package.json"`，否则解析失败 → 返回 null → **包被静默跳过，设置页什么都不显示，日志里也没有任何报错**。

所以 `package.json` 必须同时有：

```json
"exports": { ".": "./index.js", "./client": "./client.js", "./package.json": "./package.json" },
"dsh": { "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-runtime"] } }
```

确认办法：`<家>\toy.log` 里出现 `自检：设置页 bundle = D:\...\client.js` 就说明进组合图了；浏览器侧会打 `[client] script / factory / registered / apply` 四行（`client.js` 里的 beacon 探针，走 `/api/bili-toy/ping`）。

## 踩坑记录（都是本机实测撞出来的）

| 症状 | 真正的原因 | 修法 |
|---|---|---|
| 广场/搜索/我的 一起回 `-400 请求错误`，但传了 `pageSize` 就正常 | 宿主传进来的 config 里 `pageSize` 是 `undefined`，`Math.min(undefined, 50)` = `NaN` → URL 里变成 `ps=NaN`（服务端见 `ps=NaN` 直接 -400） | `apply` 里归一化 `cfg.pageSize`；`apiJSON` 里跳过 `NaN/undefined/null` 参数 |
| `toy_like` 回 `-111` | 点赞的 POST 表单漏了 `csrf` | body 里带 `csrf: cred.bili_jct` |
| `toy_favorite` 回 `2001000 参数错误` | toy 收藏**不是**通用收藏接口，`/x/v3/fav/resource/deal` 不认 type=11 | 改用 `POST /x/toy/favorite/add|del {toy_id, csrf}` |
| `toy_mine` 的 fav/created 回 `-400` | 这两个接口不认 `sort` | 不传 sort |
| 设置页不出现「玩Toy」，日志里毫无报错 | `exports` 缺 `"./package.json"`，`createRequire().resolve()` 失败 → 包被静默跳过 | 补上 `"./package.json": "./package.json"` |
| 启动进恢复模式：`Unexpected token '﻿' … is not valid JSON` | 用 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 改过 `package.json`，它**会加 BOM**，宿主 `JSON.parse` 直接崩 | 插件的 json 一律保存成**无 BOM UTF-8**；改完用 `[IO.File]::ReadAllBytes` 看前 3 字节不是 `EF BB BF` |

## 自检


```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& "<DSH 安装目录>\\DSH Desktop.exe" "D:\\plugins\\plugins\dsh-bili-toy\selfcheck.mjs"
# 结果看 selfcheck-out.json：toolsOk / apiOk / qrOk 三个 true 就算健康
```

## 已知边界

* 少数 toy 有防盗链（例：SBTI 从首页卡片点「开始测试」会被弹回 `/toy/intro`，直接输 `/toy/SBTI/index.html` 再点就行）—— 这是页面自己的事，插件只负责把 url 打开。
* `toy_detail` / `toy_comments` 要**数字 toy id**（广场/搜索返回的 `id`）；`/toy/<slug>/` 这种链接只能 `toy_open`，查不了详情。
* 发评论/点赞/收藏是真实写操作，没有二次确认（按需求不做安全阀）。
* 页面内操作、滚动、OCR 一律不归这里。
