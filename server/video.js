// 回放视频生成：SVG 画帧 -> sharp 栅格化 PNG -> 管道喂 ffmpeg(libx264) 编码 H.264 MP4
// 无头浏览器不参与；sharp/ffmpeg 均为预编译二进制，懒加载避免抬高常驻内存。
let sharp = null;

import { spawn } from "node:child_process";
import fs from "node:fs";

const W = 720, H = 1080, FRAME_MS = 900;
const FONT = "Droid Sans Fallback, DejaVu Sans, sans-serif";
const COLORS = { red: "#e64545", yellow: "#f2c14e", green: "#3aa76d", blue: "#4a7fe0", wild: "#7a5cd6" };
const COLOR_CN = { red: "红色", yellow: "黄色", green: "绿色", blue: "蓝色" };
const VALUE_CN = { skip: "跳过", reverse: "反转", draw2: "+2", wild: "万能", wild4: "+4" };

function esc(s) { return String(s ?? "").replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">"); }

function cardText(card) {
  if (!card) return "";
  return VALUE_CN[card.value] ?? String(card.value);
}

function cardSvg(x, y, w, h, card) {
  const fill = COLORS[card?.color] || COLORS.wild;
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w * 0.16}" fill="${fill}" stroke="#fff" stroke-width="4"/>
    <ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w * 0.34}" ry="${h * 0.28}" fill="rgba(255,255,255,.88)"/>
    <text x="${x + w / 2}" y="${y + h / 2 + w * 0.14}" font-size="${w * 0.34}" font-weight="bold" text-anchor="middle" fill="#221a33" font-family="${FONT}">${esc(cardText(card))}</text>
  </g>`;
}

// 由动作流模拟可展示状态：弃牌顶/当前颜色/各家手牌数/最近动作文案
function simulate(actions) {
  const players = [];
  const get = n => players.find(p => p.name === n);
  const states = [];
  let top = null, active = null, last = "开局";
  for (const a of actions) {
    if (a.a === "flip") { top = a.card; active = a.color; last = `${a.n} 翻开起始牌`; }
    else if (a.a === "play") {
      top = a.card; active = a.color || a.card?.color;
      last = `${a.n} 打出 ${COLOR_CN[a.card?.color] || ""} ${cardText(a.card)}`.trim();
    } else if (a.a === "draw") {
      last = `${a.n} 摸了 ${a.k || 1} 张牌`;
    } else if (a.a === "uno") last = `${a.n} 喊了 UNO！`;
    else if (a.a === "catch") last = `${a.n} 抓住 ${a.t2} 没喊 UNO`;
    else if (a.a === "keep") last = `${a.n} 保留摸到的牌`;
    // 玩家首见按起手 7 张初始化，再套用本动作增减
    if (a.n && !get(a.n)) players.push({ name: a.n, count: 7 });
    const p = a.n && get(a.n);
    if (a.a === "play" && p) p.count = Math.max(0, p.count - 1);
    if (a.a === "draw" && p) p.count += a.k || 1;
    // 快照：帧之间不得共享同一数组
    states.push({ top, active, last, players: players.map(pl => ({ ...pl })) });
  }
  if (states.length) states.push({ ...states[states.length - 1], last: "对局结束" });
  return states;
}

function frameSvg(st, idx, total) {
  const players = st.players.map((p, i) => {
    const y = 470 + i * 44;
    return `<g>
      <rect x="40" y="${y}" width="400" height="36" rx="18" fill="rgba(255,255,255,.06)"/>
      <text x="64" y="${y + 25}" font-size="19" fill="#e8e2f7" font-family="${FONT}">${esc(p.name)}</text>
      <text x="416" y="${y + 25}" font-size="19" fill="#a99bd6" text-anchor="end" font-family="${FONT}">${p.count} 张</text>
    </g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#130f1d"/>
  <rect x="0" y="0" width="${W}" height="6" fill="#6647e0"/>
  <text x="${W / 2}" y="52" font-size="20" fill="#a99bd6" text-anchor="middle" letter-spacing="6" font-family="DejaVu Sans, sans-serif">UNO REPLAY</text>
  <text x="60" y="118" font-size="15" fill="#7d729e" font-family="${FONT}">弃牌堆</text>
  ${st.top ? cardSvg(60, 136, 150, 210, st.top) : ""}
  <text x="270" y="118" font-size="15" fill="#7d729e" font-family="${FONT}">当前颜色</text>
  <rect x="270" y="136" width="120" height="46" rx="23" fill="${COLORS[st.active] || COLORS.wild}"/>
  <text x="330" y="167" font-size="20" fill="#fff" text-anchor="middle" font-family="${FONT}">${esc(COLOR_CN[st.active] || "—")}</text>
  <rect x="40" y="390" width="400" height="56" rx="12" fill="rgba(102,71,224,.18)"/>
  <text x="240" y="426" font-size="19" fill="#e8e2f7" text-anchor="middle" font-family="${FONT}">${esc(st.last)}</text>
  ${players}
  <text x="${W / 2}" y="${H - 24}" font-size="14" fill="#5c5378" text-anchor="middle" font-family="DejaVu Sans, sans-serif">${idx + 1} / ${total}</text>
</svg>`;
}

// PNG 帧管道 -> ffmpeg 编码 H.264 MP4（yuv420p + faststart，压缩率高、全端可播）
export async function makeReplayVideo(actions) {
  if (!sharp) sharp = (await import("sharp")).default;
  const states = simulate(actions);
  if (!states.length) throw new Error("empty replay");
  const { default: ffmpegPath } = await import("ffmpeg-static");

  return new Promise((resolve, reject) => {
    // stdin 管道进帧；mp4 muxer 需要 seekable 输出，先写临时文件（同盘 tmpfs/磁盘，很快）
    const tmpOut = `/tmp/uno-video-${process.pid}-${Date.now()}.mp4`;
    const ff = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "image2pipe", "-framerate", String(1000 / FRAME_MS), "-i", "-",
      "-c:v", "libx264", "-preset", "faster", "-crf", "23",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      tmpOut,
    ]);
    let err = "";
    ff.stderr.on("data", c => { err += c; });
    ff.on("error", reject);
    ff.on("close", code => {
      try {
        if (code === 0) resolve(fs.readFileSync(tmpOut));
        else reject(new Error(`ffmpeg failed: ${err.slice(0, 300)}`));
      } finally { try { fs.unlinkSync(tmpOut); } catch {} }
    });
    (async () => {
      for (let i = 0; i < states.length; i++) {
        const png = await sharp(Buffer.from(frameSvg(states[i], i, states.length)))
          .png({ compressionLevel: 6 }).toBuffer();
        if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once("drain", r));
      }
      ff.stdin.end();
    })().catch(e => { ff.kill(); reject(e); });
  });
}
