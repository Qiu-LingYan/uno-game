# UNO Party

网页版 2–4 人实时 UNO：React + Vite 前端，Node.js + Socket.io 房间服务器。支持房间码/邀请链接、实时出牌与摸牌、变色牌、跳过、反转、+2、+4 和胜负判定。

## 本地开发

```sh
npm install
npm run dev
```

开发时先运行 `npm start` 启动监听 `127.0.0.1:3001` 的 Socket.io 服务端，再运行 `npm run dev`；Vite 会将 `/socket.io/` 代理到服务端。生产构建：

```sh
npm test
npm run build
npm start
```

## 部署（PM2 + nginx）

1. 将仓库放在 `/opt/uno-game`，安装 Node.js/npm 和 PM2，运行 `npm ci`（首次无 lock 文件时用 `npm install`），再运行 `npm run build`。
2. 检查 `ecosystem.config.cjs` 的 `cwd` 与端口，执行 `pm2 start ecosystem.config.cjs`、`pm2 save`；应用仅绑定 `127.0.0.1:3001`，不要开放该端口到公网。
3. 将 `deploy/nginx.conf` 复制到 nginx 可用站点配置目录，把 `uno.example.com` 替换为自己的域名并配置 TLS。它只作为示例，不会自动修改现有 nginx 配置。校验后由管理员自行 reload nginx。
4. 健康检查：`curl http://127.0.0.1:3001/healthz`。

## 测试

`npm test` 运行牌堆、合法出牌和胜负单测；`npm run smoke` 启动本地临时服务器，连接两个客户端，创建并加入房间、开始游戏并验证状态同步。
