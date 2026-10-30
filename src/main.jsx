import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import './style.css';

const uidPattern = /^[A-Za-z0-9_-]{8,64}$/;
const uidFromUrl = new URLSearchParams(location.search).get('u');
// 游客身份可显式写在 URL（?u=）：换浏览器/分享恢复状态；登录用户由账号恢复，忽略 URL 里的 u
const clientId = uidFromUrl && uidPattern.test(uidFromUrl) ? uidFromUrl : (localStorage.getItem('uno-client-id') || crypto.randomUUID());
localStorage.setItem('uno-client-id', clientId);
const socket = io(import.meta.env.VITE_SOCKET_URL || undefined, { autoConnect: false, path: '/socket.io', auth: callback => callback({ token: localStorage.getItem('uno-token'), clientId }) });
const storedName = localStorage.getItem('uno-name') || '';
const labels = { skip: '🚫', reverse: '🔄', draw2: '+2', wild: '变色', wild4: '+4' };
const colors = { red: '#ff5062', yellow: '#ffd843', green: '#48d597', blue: '#4c9aff', wild: '#252936' };
const colorNames = { red: '红色', yellow: '黄色', green: '绿色', blue: '蓝色', wild: '变色' };
const errMap = {
  'not your turn': '还没轮到你出牌',
  'card not playable': '这张牌现在不能出',
  'no such card': '手牌里没有这张牌',
  'choose a color': '请先选择颜色',
  'bad color': '颜色无效',
  'game over': '本局已结束',
  'game not started': '游戏还没开始',
  'not in game': '你已不在对局中',
  '只能打出刚摸到的牌': '只能打出刚摸到的这张牌',
  '只能叠加 +2 或 +4': '现在只能叠加 +2 或 +4',
  'UNO can only be called with one card': '只剩一张牌时才能喊 UNO',
  'no uno to catch': '现在没有可抓的 UNO',
  'too late': '手慢了，UNO 窗口已过',
  'cannot catch yourself': '不能抓自己',
};
const say = setErr => m => setErr(errMap[m] || m);
function App() {
  const [name, setName] = useState(storedName);
  const [authMode, setAuthMode] = useState('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [showProfile, setShowProfile] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [game, setGame] = useState(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [pickIndex, setPickIndex] = useState(null);
  const [unoFlash, setUnoFlash] = useState('');
  const [now, setNow] = useState(Date.now());
  const [viewUser, setViewUser] = useState(null);   // 点对手头像弹窗：username 或 'guest'
  const [viewData, setViewData] = useState(null);   // 公开战绩数据
  const [connecting, setConnecting] = useState(false); // 加入/重连过程中显示连接弹窗
  const [meDone, setMeDone] = useState(false);         // /api/me 探测完成后才同步 ?u= 参数
  const [nickModal, setNickModal] = useState(null);    // { action:'create'|'join', code? } 游客进房前填昵称
  const [nickInput, setNickInput] = useState(storedName);
  const show = say(setError);
  useEffect(() => { if (!error) return; const t = setTimeout(() => setError(''), 4500); return () => clearTimeout(t); }, [error]);
  useEffect(() => { if (!unoFlash) return; const t = setTimeout(() => setUnoFlash(''), 2200); return () => clearTimeout(t); }, [unoFlash]);
  useEffect(() => { if (!game?.kicks?.length) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [game?.kicks?.length, game?.kicks?.[0]?.until]);
  const api = async (path, options = {}) => {
    const token = localStorage.getItem('uno-token');
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '请求失败');
    return data;
  };
  // 游客：URL 显式携带 ?u=<clientId>（换浏览器/分享可恢复状态）；登录用户：账号即身份，去掉 u
  useEffect(() => {
    if (!meDone) return;
    const url = new URL(location.href);
    if (user) {
      if (url.searchParams.has('u')) { url.searchParams.delete('u'); history.replaceState(null, '', url); }
    } else if (url.searchParams.get('u') !== clientId) {
      url.searchParams.set('u', clientId);
      history.replaceState(null, '', url);
    }
  }, [user, meDone]);
  useEffect(() => {
    api('/api/me').then(setUser).catch(() => localStorage.removeItem('uno-token')).finally(() => setMeDone(true));
    socket.connect();
    socket.on('connect', () => {
      setConnected(true);
      // URL 优先；旧版本写入 localStorage 的房间码作为兼容回退
      const fromUrl = new URLSearchParams(location.search).get('room');
      const saved = (fromUrl || localStorage.getItem('uno-room') || '').toUpperCase();
      if (saved && !localStorage.getItem('uno-token') && !localStorage.getItem('uno-name')) {
        // 从没设过昵称的游客：先弹窗填写再进房，避免静默变成"玩家"
        setCodeInput(saved);
        setNickModal({ action: 'join', code: saved });
        return;
      }
      if (saved) {
        setConnecting(true);
        socket.emit('joinRoom', { code: saved, name: localStorage.getItem('uno-name') || '玩家' }, r => {
          setConnecting(false);
          if (r?.ok) {
            localStorage.setItem('uno-room', r.code);
            setRoomCode(r.code);
            const url = new URL(location.href);
            url.searchParams.set('room', r.code);
            history.replaceState(null, '', url);
          } else if (r?.error === '房间不存在') {
            localStorage.removeItem('uno-room');
            const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url);
            setError('之前的房间已解散');
          }
        });
      }
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('state', s => {
      setRoomCode(s.room); setGame(s); localStorage.setItem('uno-room', s.room);
      const url = new URL(location.href); url.searchParams.set('room', s.room); history.replaceState(null, '', url);
    });
    socket.on('error-msg', e => show(e.error));
    socket.on('uno-flash', ({ name: n }) => setUnoFlash(n));
    return () => { socket.off('state'); socket.off('error-msg'); socket.off('uno-flash'); socket.disconnect(); };
  }, []);
  const submitAuth = async event => {
    event.preventDefault();
    try {
      const result = authMode === 'login'
        ? await api('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) })
        : await api('/api/register', { method: 'POST', body: JSON.stringify({ email, password, username }) });
      if (authMode === 'register' && result.ok && !result.token) {
        setPendingEmail(email);
        setAuthMode('confirm');
        setError('验证码已发送到邮箱，请查收并输入');
        return;
      }
      localStorage.setItem('uno-token', result.token);
      socket.auth = { token: result.token, clientId };
      socket.disconnect();
      socket.connect();
      setUser(result.user);
      setError('登录成功');
      setPassword('');
    } catch (e) { setError(e.message); }
  };
  const confirmEmail = async event => {
    event.preventDefault();
    try {
      const result = await api('/api/register/confirm', { method: 'POST', body: JSON.stringify({ email: pendingEmail, password, code: verifyCode }) });
      localStorage.setItem('uno-token', result.token);
      socket.auth = { token: result.token, clientId };
      socket.disconnect(); socket.connect();
      setUser(result.user); setPassword(''); setVerifyCode(''); setAuthMode('login'); setError('邮箱验证成功，欢迎加入！');
    } catch (e) { setError(e.message); }
  };
  const openProfile = async () => {
    try { const data = await api('/api/profile'); setProfile(data); setNickname(data.nickname); setShowProfile(true); } catch (e) { setError(e.message); }
  };
  const saveNickname = async event => {
    event.preventDefault();
    try { const result = await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ nickname }) }); setProfile({ ...profile, nickname: result.nickname }); setError('昵称已更新'); }
    catch (e) { setError(e.message); }
  };
  const openUser = username => {
    setViewUser(username); setViewData(null);
    fetch(`/api/player/${encodeURIComponent(username)}`).then(r => r.ok ? r.json() : null).then(setViewData).catch(() => setViewData(null));
  };
  const signOut = async () => {
    try { await api('/api/logout', { method: 'POST' }); } finally { localStorage.removeItem('uno-token'); socket.auth = { clientId }; setUser(null); setProfile(null); setShowProfile(false); }
  };
  const setRoomUrl = code => { const url = new URL(location.href); if (code) url.searchParams.set('room', code); else url.searchParams.delete('room'); history.replaceState(null, '', url); };
  const create = (n = name || '玩家') => { localStorage.setItem('uno-name', n); setConnecting(true); socket.emit('createRoom', { name: n }, r => { setConnecting(false); if (r.ok) { setRoomCode(r.code); localStorage.setItem('uno-room', r.code); setRoomUrl(r.code); } else setError(r.error); }); };
  const join = (code, n = name || '玩家') => { const c = (code ?? codeInput).toUpperCase(); if (!c) return setError('请输入房间码'); localStorage.setItem('uno-name', n); setConnecting(true); socket.emit('joinRoom', { code: c, name: n }, r => { setConnecting(false); if (r.ok) { setRoomCode(r.code); localStorage.setItem('uno-room', r.code); setRoomUrl(r.code); if (r.spectating) setError('对局进行中，你已进入旁观席，下一轮自动加入'); } else setError(r.error); }); };
  // 游客进房前先填昵称；登录用户直接用账号昵称
  const guestNeedsNick = () => !user && meDone;
  const beginCreate = () => { if (guestNeedsNick()) return setNickModal({ action: 'create' }); create(); };
  const beginJoin = code => { if (guestNeedsNick()) return setNickModal({ action: 'join', code }); join(code); };
  const confirmNick = () => {
    const n = (nickInput.trim() || '玩家').slice(0, 18);
    setName(n); localStorage.setItem('uno-name', n);
    const m = nickModal; setNickModal(null);
    if (!m) return;
    if (m.action === 'create') create(n); else join(m.code ?? codeInput, n);
  };
  const leave = () => { socket.emit('leaveRoom', { code: roomCode }); localStorage.removeItem('uno-room'); setRoomUrl(null); setRoomCode(null); setGame(null); setError('已退出房间'); };
  const start = () => socket.emit('startGame', { code: roomCode });
  const playable = card => {
    if (!game?.top) return true;
    if (game.pendingDraw > 0) return card.value === 'wild4' || (card.value === 'draw2' && game.top.value === 'draw2');
    return card.color === 'wild' || card.color === game.activeColor || card.value === game.top.value;
  };
  const play = i => {
    const card = game.yourHand[i];
    if (card.color === 'wild') { setPickIndex(i); return; }
    if (!playable(card)) {
      if (game.pendingDraw > 0) return setError(`这张牌不能出：现在只能叠加 +2/+4（待摸 ${game.pendingDraw} 张）`);
      return setError(`这张牌不能出：需要 ${colorNames[game.activeColor] || '同色'}的牌，或与弃牌同数字/功能（${labels[game.top.value] || game.top.value}），或打出变色牌`);
    }
    socket.emit('playCard', { code: roomCode, cardIndex: i });
  };
  const playWild = chosenColor => { socket.emit('playCard', { code: roomCode, cardIndex: pickIndex, chosenColor }); setPickIndex(null); };
  const draw = () => socket.emit('draw', { code: roomCode });
  const keepDrawn = () => socket.emit('keepDrawn', { code: roomCode });
  const catchUnoBtn = () => socket.emit('catchUno', { code: roomCode }, r => { if (!r.ok) show(r.error); else setError('抓到了！对方罚摸两张'); });
  const callUno = () => socket.emit('callUno', { code: roomCode }, r => { if (!r.ok) show(r.error); });
  const voteKick = () => socket.emit('voteKick', { code: roomCode }, r => { if (!r.ok) show(r.error); else setError('已发起踢出投票：3 分钟内未回线将被移出'); });
  const share = () => { navigator.clipboard?.writeText(`${location.origin}${location.pathname}?room=${roomCode}`); setError('邀请链接已复制'); };
  useEffect(() => { const c = new URLSearchParams(location.search).get('room'); if (c) setCodeInput(c.toUpperCase()); }, []);
  const meTurn = game?.turn === socket.id;
  const playTime = seconds => `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`;
  const kickLeft = k => Math.max(0, Math.ceil((k.until - now) / 1000));
  const kicks = (game?.kicks || []).map(k => ({ key: k.playerId, name: game.names?.[k.playerId] || '玩家', left: kickLeft(k) }));
  return <main className="shell"><header><div className="brand"><span className="logo">U</span><div><b>UNO PARTY</b><small>在线派对 · 2—4 位玩家</small></div></div><div className="headerRight"><span className={connected ? 'status on' : 'status'}>● {connected ? '已连接' : '连接中'}</span>{user ? <button className="profileLink" onClick={openProfile}>{user.email} · 个人中心</button> : <span className="status">登录后保存个人战绩</span>}</div></header>
    {error && <div className="toast">{error}</div>}
    {unoFlash && <div className="unoFlash"><span>UNO！</span><small>{unoFlash} 只剩一张牌</small></div>}
    {connecting && <div className="modalBackdrop"><div className="colorModal connectModal"><div className="spinner"/><p>正在连接…</p><p className="authHint">正在加入房间，请稍候</p></div></div>}
    {nickModal && <div className="modalBackdrop" onClick={() => setNickModal(null)}><div className="colorModal nickModal" onClick={e => e.stopPropagation()}><p>{nickModal.action === 'create' ? '创建房间' : '加入房间'}</p><p className="authHint">游客也可以自定义昵称，牌桌上会显示它</p><input className="nickInput" maxLength="18" autoFocus value={nickInput} onChange={e => setNickInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') confirmNick(); }} placeholder="输入昵称（可留空，默认为“玩家”）"/><div className="nickActions"><button className="pickCancel" onClick={() => setNickModal(null)}>取消</button><button className="primary" onClick={confirmNick}>{nickModal.action === 'create' ? '创建并进入' : '加入房间'}</button></div></div></div>}
    {pickIndex !== null && <div className="modalBackdrop" onClick={() => setPickIndex(null)}><div className="colorModal" onClick={e => e.stopPropagation()}><p>为变色牌选择颜色</p><div className="colorOptions">{[['red','红色'],['yellow','黄色'],['green','绿色'],['blue','蓝色']].map(([c,label]) => <button key={c} className={'pick '+c} onClick={() => playWild(c)}><i/>{label}</button>)}</div><button className="pickCancel" onClick={() => setPickIndex(null)}>取消</button></div></div>}
    {viewUser !== null && <div className="modalBackdrop" onClick={() => setViewUser(null)}><div className="colorModal playerModal" onClick={e => e.stopPropagation()}>{viewUser === 'guest' ? <><p className="playerModalName">游客玩家</p><p className="authHint">该玩家未登录，没有战绩档案。登录后即可在个人中心查看胜率、胜场与游玩时长。</p></> : viewData ? <><p className="eyebrow">PLAYER PROFILE</p><p className="playerModalName">{viewData.nickname}</p><p className="playerModalHandle">@{viewData.username}</p><div className="statsGrid"><Stat label="胜率" value={`${viewData.winRate}%`}/><Stat label="胜场" value={viewData.wins}/><Stat label="总场次" value={viewData.gamesPlayed}/><Stat label="累计游玩" value={playTime(viewData.playSeconds)}/></div><p className="authHint">加入时间：{(viewData.memberSince || '').slice(0, 10)}</p></> : <><p className="playerModalName">@{viewUser}</p><p className="authHint">正在加载战绩…</p></>}<button className="pickCancel" onClick={() => setViewUser(null)}>关闭</button></div></div>}
    {showProfile && profile ? <section className="profilePage"><button className="backLink" onClick={() => setShowProfile(false)}>← 返回游戏</button><p className="eyebrow">PLAYER PROFILE</p><h1>个人中心</h1><p className="profileEmail">{profile.email}</p><p className="profileHandle">@{profile.username}</p><form className="nicknameForm" onSubmit={saveNickname}><label>游戏昵称</label><input value={nickname} minLength="2" maxLength="20" onChange={e => setNickname(e.target.value)} placeholder="输入昵称"/><button type="submit">保存昵称</button></form><div className="statsGrid"><Stat label="胜率" value={`${profile.winRate}%`}/><Stat label="胜场" value={profile.wins}/><Stat label="总场次" value={profile.gamesPlayed}/><Stat label="累计游玩" value={playTime(profile.playSeconds)}/></div><button className="logoutButton" onClick={signOut}>退出登录</button></section> : !roomCode ? <section className="welcome"><div className="hero"><div className="orbit">🟥 🟨 🟩 🟦</div><p className="eyebrow">THE CLASSIC, ONLINE</p><h1>牌局已就绪？<br/><em>开玩吧。</em></h1><p className="sub">创建房间，邀请好友，把友情放进弃牌堆。</p></div><div className="panel"><label>你的昵称</label><input value={name} onChange={e => setName(e.target.value)} maxLength="18" placeholder="输入昵称"/><button className="primary" onClick={beginCreate}>创建新房间 <span>↗</span></button><div className="divider"><span>或加入朋友的房间</span></div><div className="join"><input value={codeInput} onChange={e => setCodeInput(e.target.value.toUpperCase())} maxLength="4" placeholder="房间码"/><button onClick={() => beginJoin()}>加入</button></div>{!user && (authMode === 'confirm' ? <form className="authForm" onSubmit={confirmEmail}><div className="divider"><span>验证邮箱</span></div><h3>输入邮件验证码</h3><p className="authHint">验证码已发送至 {pendingEmail}，10 分钟内有效</p><input required inputMode="numeric" pattern="[0-9]{6}" maxLength="6" value={verifyCode} onChange={e => setVerifyCode(e.target.value)} placeholder="6 位验证码"/><button className="primary" type="submit">验证并创建账号</button></form> : <form className="authForm" onSubmit={submitAuth}><div className="divider"><span>账号中心</span></div><h3>{authMode === 'login' ? '邮箱登录' : '注册账号'}</h3>{authMode === 'register' && <><input required minLength="3" maxLength="20" pattern="[A-Za-z0-9_]{3,20}" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} placeholder="唯一用户名（字母/数字/下划线）"/><p className="authHint">username 唯一；游戏昵称可在个人中心修改</p></>}<input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="邮箱地址"/><input type="password" required minLength="8" maxLength="128" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="密码（至少 8 位）"/><button className="primary" type="submit">{authMode === 'login' ? '登录并同步战绩' : '发送邮箱验证码'}</button><button className="modeLink" type="button" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>{authMode === 'login' ? '还没有账号？立即注册' : '已有账号？返回登录'}</button></form>)}</div></section> : <section className="table"><div className="roombar"><div><small>房间码</small><b>{roomCode}</b></div><button onClick={share}>邀请好友 ↗</button><span>{game?.players?.length || 1}/4 玩家</span><button className="leaveRoom" onClick={leave}>退出房间</button></div>{!game?.started ? <div className="lobby"><h2>等待玩家加入</h2><div className="avatars">{(game?.players || [name || '你']).map((p,i)=><div className="avatar" key={i}><span>{p[0]}</span>{p}</div>)}</div>{game?.spectatorNames?.length ? <p className="spectateList">👀 旁观席：{game.spectatorNames.join('、')}</p> : null}<p>至少需要 2 位玩家开始游戏</p><button className="primary" disabled={(game?.players?.length || 1)<2} onClick={start}>开始游戏</button></div> : <><div className="opponents">{(game.players || []).map((p,i)=><div className={'opponent '+(game.turn === p ? 'active' : '')+(game.offlineIds?.includes(p) ? ' offline' : '')} key={p}><span className={'avatarSmall'+(game.roster?.[p]?.username ? ' clickable' : '')} title={game.roster?.[p]?.username ? '查看战绩' : '游客'} onClick={() => game.roster?.[p]?.username ? openUser(game.roster[p].username) : setViewUser('guest')}>{(game.names?.[p] || '?')[0]}</span><b>{p === socket.id ? '你' : (game.names?.[p] || `玩家 ${i+1}`)}{game.offlineIds?.includes(p) ? ' ⚠️' : ''}</b><small>{game.handCounts?.[p]} 张牌{game.offlineIds?.includes(p) && !game.kicks?.length ? ' · 掉线' : ''}</small>{game.offlineIds?.includes(p) && !game.spectating && <button className="kickBtn" onClick={voteKick}>踢出</button>}</div>)}</div><div className="center"><div className="pile" onClick={() => { if (meTurn && game.mayPlayDrawn == null) draw(); }}><small>摸牌堆</small><div className="back">UNO</div><small>{game.drawPileCount} 张 · 点击摸牌</small></div><div className="discard"><small>弃牌堆</small><Card card={game.top}/></div><div className="activeColor"><small>当前颜色</small><div className={'colorChip '+game.activeColor}>{colorNames[game.activeColor] || '变色'}</div></div></div><div className="turn">{game.winner ? (game.winner === socket.id ? '🏆 你赢了！' : `🏆 ${game.names?.[game.winner] || '对手'} 获胜`) : meTurn ? (game.pendingDraw > 0 ? `你的回合：叠加 +2/+4，否则摸 ${game.pendingDraw} 张` : (game.mayPlayDrawn != null ? '摸到的牌可以出，或选择留着' : '轮到你了！选择一张牌或摸牌')) : `等待 ${game.names?.[game.turn] || '对手'} 出牌…`}</div>
{kicks.map(k => !game.winner && <div className="kickBar" key={k.key}>⏳ {k.name} 掉线中，{Math.floor(k.left/60)}:{String(k.left%60).padStart(2,'0')} 后将被移出对局（回线自动取消）</div>)}
{(game.unoVulnerable && game.unoVulnerable.player !== socket.id && !game.winner && !game.spectating) && <div className="unoCatch"><button className="catchButton" onClick={catchUnoBtn}>⚡ 抓 UNO！</button></div>}
{meTurn && game.pendingDraw > 0 && <div className="stackWarn">当前待摸 {game.pendingDraw} 张 · 可用 +2/+4 叠加传给下家</div>}
{game.spectating ? <div className="spectateBar">👀 观战中 · 本轮结束后自动加入牌局</div> : <><div className="hand">{(game.yourHand || []).map((c,i)=><button key={`${c.color}-${c.value}-${i}`} disabled={!meTurn} onClick={()=>play(i)} className={'cardButton'+(i===game.mayPlayDrawn?' drawn':'')+(meTurn && game.mayPlayDrawn == null && !game.winner ? (playable(c) ? ' playable' : ' dim') : '')}><Card card={c}/></button>)}</div>
{meTurn && game.mayPlayDrawn != null && <div className="drawnActions"><button className="drawButton" onClick={()=>play(game.mayPlayDrawn)}>打出这张</button><button className="drawButton" onClick={keepDrawn}>留着，结束回合</button></div>}
<div className="gameActions"><button className="drawButton" disabled={!meTurn || game.mayPlayDrawn != null} onClick={draw}>摸一张牌</button><button className="unoButton" disabled={!game.yourHand || game.yourHand.length !== 1} onClick={callUno}>喊 UNO！</button></div></>}
{connecting && <div className="modalBackdrop"><div className="colorModal connectModal"><div className="spinner"/><p>正在连接…</p><p className="authHint">正在加入房间，请稍候</p></div></div>}
{nickModal && <div className="modalBackdrop" onClick={() => setNickModal(null)}><div className="colorModal nickModal" onClick={e => e.stopPropagation()}><p>{nickModal.action === 'create' ? '创建房间' : '加入房间'}</p><p className="authHint">游客也可以自定义昵称，牌桌上会显示它</p><input className="nickInput" maxLength="18" autoFocus value={nickInput} onChange={e => setNickInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') confirmNick(); }} placeholder="输入昵称（可留空，默认为“玩家”）"/><div className="nickActions"><button className="pickCancel" onClick={() => setNickModal(null)}>取消</button><button className="primary" onClick={confirmNick}>{nickModal.action === 'create' ? '创建并进入' : '加入房间'}</button></div></div></div>}
{pickIndex !== null && <div className="modalBackdrop" onClick={() => setPickIndex(null)}><div className="colorModal" onClick={e => e.stopPropagation()}><p>为变色牌选择颜色</p><div className="colorOptions">{[['red','红色'],['yellow','黄色'],['green','绿色'],['blue','蓝色']].map(([c,label]) => <button key={c} className={'pick '+c} onClick={() => playWild(c)}><i/>{label}</button>)}</div><button className="pickCancel" onClick={() => setPickIndex(null)}>取消</button></div></div>}
{viewUser !== null && <div className="modalBackdrop" onClick={() => setViewUser(null)}><div className="colorModal playerModal" onClick={e => e.stopPropagation()}>{viewUser === 'guest' ? <><p className="playerModalName">游客玩家</p><p className="authHint">该玩家未登录，没有战绩档案。登录后即可在个人中心查看胜率、胜场与游玩时长。</p></> : viewData ? <><p className="eyebrow">PLAYER PROFILE</p><p className="playerModalName">{viewData.nickname}</p><p className="playerModalHandle">@{viewData.username}</p><div className="statsGrid"><Stat label="胜率" value={`${viewData.winRate}%`}/><Stat label="胜场" value={viewData.wins}/><Stat label="总场次" value={viewData.gamesPlayed}/><Stat label="累计游玩" value={playTime(viewData.playSeconds)}/></div><p className="authHint">加入时间：{(viewData.memberSince || '').slice(0, 10)}</p></> : <><p className="playerModalName">@{viewUser}</p><p className="authHint">正在加载战绩…</p></>}<button className="pickCancel" onClick={() => setViewUser(null)}>关闭</button></div></div>}</>}</section>}
  </main>;
}
function Stat({ label, value }) { return <div className="statCard"><span>{label}</span><strong>{value}</strong></div>; }
function Card({ card }) { if (!card) return null; return <div className={'card '+(card.color==='wild'?'wild':'')} style={{'--card':colors[card.color]}}><span className="corner">{labels[card.value] || card.value}</span><strong>{labels[card.value] || card.value}</strong><span className="corner bottom">{labels[card.value] || card.value}</span></div>; }

createRoot(document.getElementById('root')).render(<App/>);
