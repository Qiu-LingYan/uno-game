# UNO Party

网页版 2–4 人实时 UNO：React + Vite 前端，Node.js + Socket.io 房间服务器。支持邮箱+密码注册登录、邮箱验证码验证、注册时设置全局唯一 username、个人中心修改 nickname 并查看胜率/胜场/总场次/累计游玩时长、房间码邀请、实时出牌与摸牌、变色牌、跳过、反转、+2、+4、UNO 宣告和胜负判定。账号、会话及战绩存于本机 SQLite。

## 本地开发

```sh
npm install
npm run dev
```

开发时先运行 `npm start` 启动监听 `127.0.0.1:3001` 的服务端，再运行 `npm run dev`；Vite 会将 `/socket.io/` 代理到服务端。`.env.local` 只由 Node 服务端加载，绝不传给客户端。在被 git 忽略的 `.env.local` 设置 `RESEND_API_KEY`、`RESEND_FROM_EMAIL`（必须是 Resend 验证过的发件域名邮箱）、`RESEND_FROM_NAME` 和 `APP_URL` 启用邮箱注册验证；API key 不要提交到 git。验证码 10 分钟有效，最多校验 5 次。

```sh
npm test
npm run build
npm start
```

## 部署（PM2 + nginx）

1. 将仓库放在 `/opt/uno-game`，安装 Node.js/npm 和 PM2，运行 `npm ci`，设置 `.env.local` 中的 Resend 配置并确保 `data/` 可写，再运行 `npm run build`。
2. 执行 `pm2 start ecosystem.config.cjs`、`pm2 save`；应用仅绑定 `127.0.0.1:3001`，不要开放该端口到公网。SQLite 文件默认为 `data/uno.sqlite`，备份该文件及其 WAL 数据。
3. 将 `deploy/nginx.conf` 复制到 nginx 可用站点配置目录，把 `uno.example.com` 替换为自己的域名并配置 TLS。它只作为示例，不会自动修改现有 nginx 配置。校验后由管理员自行 reload nginx。
4. 健康检查：`curl http://127.0.0.1:3001/healthz`。

## 测试

`npm test` 覆盖牌堆/规则/胜负、UNO 宣告、邮箱验证码注册/登录/会话、SQLite 战绩统计，以及使用 mock Resend 的 HTML 邮件/API 集成；`npm run smoke` 验证两个客户端加入房间并同步动作。
