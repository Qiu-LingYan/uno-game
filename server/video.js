// 回放视频生成：SVG 画帧 -> sharp 栅格化为 WebP -> VP8 关键帧封装为 WebM
// 纯代码生成，不依赖无头浏览器；sharp 为预编译二进制，懒加载避免抬高常驻内存
let sharp = null;

const W = 480, H = 720, FRAME_MS = 900;
const CLUSTER_MAX_MS = 20000; // SimpleBlock 时码是 16 位相对值，超长需分段 Cluster

const COLORS = { red: "#e64545", yellow: "#f2c14e", green: "#3aa76d", blue: "#4a7fe0", wild: "#7a5cd6" };
const COLOR_CN = { red: "红色", yellow: "黄色", green: "绿色", blue: "蓝色" };
const VALUE_CN = { skip: "跳过", reverse: "反转", draw2: "+2", wild: "万能", wild4: "+4" };
const FONT = "Droid Sans Fallback, DejaVu Sans, sans-serif";

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

// —— 最小 WebM(EBML) 封装 ——
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };

// EBML 数据长度：n 字节大端，值 = v + 2^(7n)
function ebmlLen(v) {
  for (let n = 1; n <= 8; n++) {
    if (v < (1 << (7 * n)) - 1 || n === 8) {
      let x = BigInt(v) + (1n << BigInt(7 * n));
      const b = Buffer.alloc(n);
      for (let i = n - 1; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
      return b;
    }
  }
}
function el(idHex, payload) {
  const id = Buffer.from(idHex.replace(/\s/g, ""), "hex");
  return Buffer.concat([id, ebmlLen(payload.length), payload]);
}
const uintEl = (id, v) => el(id, Buffer.from([v])); // 仅用于小值
const strEl = (id, s) => el(id, Buffer.from(s, "utf8"));

function ebmlHeader() {
  return el("1A45DFA3", Buffer.concat([
    uintEl("4286", 1), uintEl("42F7", 1), uintEl("42F2", 4), uintEl("42F3", 8),
    strEl("4282", "webm"), uintEl("4287", 2), uintEl("4285", 2),
  ]));
}

function mkInfo(durationMs) {
  const dur = Buffer.alloc(4);
  dur.writeFloatBE(durationMs);
  return el("1549A966", Buffer.concat([
    el("2AD7B1", u32(1000000)), // TimecodeScale 1ms
    strEl("4D80", "uno-game"), strEl("5741", "uno-game"),
    el("4489", dur), // Duration (float, ms)
  ]));
}

function mkTracks() {
  const video = el("E0", Buffer.concat([el("B0", u32(W)), el("BA", u32(H))]));
  const track = el("AE", Buffer.concat([
    el("D7", Buffer.from([0x01])),        // TrackNumber 1（普通 uint，非 vint）
    uintEl("73C5", 1),                    // TrackUID
    uintEl("83", 1),                      // TrackType video
    uintEl("9C", 0),                      // FlagLacing
    strEl("22B59C", "und"),               // Language
    strEl("86", "V_VP8"),
    strEl("258688", "VP8"),               // CodecName
    video,
  ]));
  return el("1654AE6B", track);
}

// webp(lossy) 的 VP8 码流即关键帧：跳过 RIFF/WEBP/VP8 头 20 字节
function webpToVp8(buf) {
  if (buf.slice(12, 16).toString() !== "VP8 ") throw new Error("not lossy webp");
  const frame = buf.subarray(20);
  if (frame[3] !== 0x9d || frame[4] !== 0x01 || frame[5] !== 0x2a) throw new Error("bad VP8 magic");
  return frame;
}

function simpleBlock(vp8, relMs) {
  return el("A3", Buffer.concat([Buffer.from([0x81]), u16(relMs), Buffer.from([0x80]), vp8])); // track1 | relTime | keyframe
}

export async function makeReplayVideo(actions) {
  if (!sharp) sharp = (await import("sharp")).default;
  const states = simulate(actions);
  if (!states.length) throw new Error("empty replay");
  // 末尾补一帧终局停留
  states.push({ ...states[states.length - 1], last: "对局结束" });

  const frames = [];
  for (let i = 0; i < states.length; i++) {
    const webp = await sharp(Buffer.from(frameSvg(states[i], i, states.length)))
      .webp({ quality: 68 }).toBuffer();
    frames.push(webpToVp8(webp));
  }

  const totalMs = frames.length * FRAME_MS;
  const clusters = [];
  let cluster = [], clusterStart = 0;
  for (let i = 0; i < frames.length; i++) {
    const t = i * FRAME_MS;
    if (cluster.length && t - clusterStart + FRAME_MS > CLUSTER_MAX_MS) {
      clusters.push(el("1F43B675", Buffer.concat([el("E7", u32(clusterStart)), ...cluster])));
      cluster = []; clusterStart = t;
    }
    cluster.push(simpleBlock(frames[i], t - clusterStart));
  }
  clusters.push(el("1F43B675", Buffer.concat([el("E7", u32(clusterStart)), ...cluster])));

  const segment = Buffer.concat([mkInfo(totalMs), mkTracks(), ...clusters]);
  return Buffer.concat([ebmlHeader(), el("18538067", segment)]);
}
