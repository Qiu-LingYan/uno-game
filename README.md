<div align="center">

# 🎴 UNO Party — 在线派对 UNO

**把友情放进弃牌堆。** 一个为多人在线派对而生的 UNO 游戏服务。

[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4-white?logo=socket.io)](https://socket.io)
[![SQLite](https://img.shields.io/badge/SQLite-零运维-003B57?logo=sqlite&logoColor=white)](https://sqlite.org)
[![Tests](https://img.shields.io/badge/tests-20%20passing-3DDC84)](#-测试)

*牌局已就绪？开玩吧。*

</div>

---

## ✨ 亮点

| | |
|---|---|
| 🎮 **完整规则引擎** | 变色、跳过、反转、+2/+4、**可叠加惩罚**（+2 叠 +2、+4 见 +2 就加）、摸到能出就继续出、抓 UNO 惩罚、胜利判定——全部由纯函数引擎驱动，20 项单测覆盖 |
| ⚡ **毫秒级实时对战** | Socket.IO 房间广播，2–4 人同场竞技，掉线重连无缝恢复座位 |
| 👀 **旁观席机制** | 对局进行中加入？自动入座观战席，本轮结束未满员即刻转正上场 |
| 🛡️ **民主踢人** | 队友掉线不再干等——一键发起 votekick，3 分钟倒计时，回线自动取消 |
| 💥 **UNO！突脸动画** | 任何玩家只剩一张牌，全房间共享 2.2 秒 "UNO！" 高光时刻；15 秒抓 UNO 窗口，手慢无 |
| 👤 **账号与战绩系统** | 邮箱验证码注册、全局唯一 username、个人中心展示胜率 / 胜场 / 总场次 / 累计游玩时长 |
| 🔁 **断线无忧** | 房间码写入 URL、断线 1 小时宽限、匿名玩家凭客户端指纹恢复座位——刷新页面照样回到牌桌 |
| 📱 **移动端优先** | richup.io 风格设计基因：Nunito 字体、深紫夜色、霓虹发光；触控目标放大、手牌横向滑动吸附 |
| 🪶 **轻量部署** | SQLite 零运维存储，全栈单进程可跑在 64MB 堆上限内——一台 2GB 小鸡 hosting 一整个派对 |

## 🏗️ 架构

```
┌─────────────┐   Socket.IO / REST   ┌──────────────────┐
│  React 19    │ ───────────────────► │  Node.js 服务端   │
│  Vite 5 SPA  │ ◄─────────────────── │  · Socket.IO 房间 │
│  richup 风格 │   状态广播 / 事件驱动  │  · 纯函数规则引擎  │
└─────────────┘                       │  · Resend 邮件    │
                                      └────────┬─────────┘
                                               │ better-sqlite3
                                        ┌──────▼──────┐
                                        │   SQLite    │
                                        │ 账号/会话/战绩 │
                                        └─────────────┘
```

- **`server/game.js`** — 纯函数 UNO 规则引擎：不碰 IO、不碰时钟（时间由外部注入），可独立单测
- **`server/index.js`** — Socket.IO 房间生命周期：座位恢复、旁观席转正、votekick 计时、房间 TTL 清扫
- **`server/store.js`** — SQLite 持久层：账号、会话 token、对局战绩
- **`src/main.jsx`** — 单文件 React 前端：错误 toast、UNO 突脸、变色 modal、旁观/踢人 UI

## 🚀 快速开始

```sh
git clone https://github.com/Qiu-LingYan/uno-game.git
cd uno-game
npm install
npm start        # 服务端监听 127.0.0.1:3001
npm run dev      # Vite 开发服务器（/socket.io/ 自动代理）
```

打开浏览器，输入昵称，创建房间，把链接甩给朋友即可开局。

### 启用邮箱注册

在被 git 忽略的 `.env.local` 中配置 [Resend](https://resend.com)：

```ini
RESEND_API_KEY=re_xxx          # API key 绝不提交到 git
RESEND_FROM_EMAIL=no@your.tld  # 须为 Resend 验证过的发件域名
RESEND_FROM_NAME=UNO Party
APP_URL=https://your.domain
```

验证码 10 分钟有效，最多校验 5 次。

## 🧪 测试

```sh
npm test        # 规则引擎 / 胜负 / UNO 宣告 / 注册登录 / SQLite 战绩（含 mock Resend 集成测试）
npm run smoke   # 双客户端加入同一房间并同步出牌、摸牌动作
```

## 📦 生产部署（PM2 + nginx）

1. 仓库放至 `/opt/uno-game`，`npm ci` 后配置 `.env.local`，确保 `data/` 可写，`npm run build`
2. `pm2 start ecosystem.config.cjs && pm2 save` — 应用仅绑定 `127.0.0.1:3001`，**切勿将该端口暴露公网**
3. 参考 `deploy/nginx.conf` 配置反向代理与 TLS（示例文件，需替换域名并自行校验后 reload）
4. 健康检查：`curl http://127.0.0.1:3001/healthz`
5. 备份：SQLite 文件位于 `data/uno.sqlite`（连同 WAL/SHM）

## 📜 License

MIT
