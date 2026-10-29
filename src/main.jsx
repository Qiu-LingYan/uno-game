import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import './style.css';

const clientId = localStorage.getItem('uno-client-id') || crypto.randomUUID();
localStorage.setItem('uno-client-id', clientId);
const socket = io(import.meta.env.VITE_SOCKET_URL || undefined, { autoConnect: false, path: '/socket.io', auth: callback => callback({ token: localStorage.getItem('uno-token'), clientId }) });
const storedName = localStorage.getItem('uno-name') || '';
const labels = { skip: '🚫', reverse: '🔄', draw2: '+2', wild: '变色', wild4: '+4' };
const colors = { red: '#ff5062', yellow: '#ffd843', green: '#48d597', blue: '#4c9aff', wild: '#252936' };
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
  useEffect(() => { if (!error) return; const t = setTimeout(() => setError(''), 4500); return () => clearTimeout(t); }, [error]);
  const api = async (path, options = {}) => {
    const token = localStorage.getItem('uno-token');
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '请求失败');
    return data;
  };
  useEffect(() => {
    api('/api/me').then(setUser).catch(() => localStorage.removeItem('uno-token'));
    socket.connect();
    socket.on('connect', () => {
      setConnected(true);
      // URL 优先；旧版本写入 localStorage 的房间码作为兼容回退
      const fromUrl = new URLSearchParams(location.search).get('room');
      const saved = (fromUrl || localStorage.getItem('uno-room') || '').toUpperCase();
      if (saved) socket.emit('joinRoom', { code: saved, name: localStorage.getItem('uno-name') || '玩家' }, r => {
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
        } else if (r?.error === '游戏已开始') {
          setError('游戏已开始，暂时无法重新加入');
        }
      });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('state', s => {
      setRoomCode(s.room); setGame(s); localStorage.setItem('uno-room', s.room);
      const url = new URL(location.href); url.searchParams.set('room', s.room); history.replaceState(null, '', url);
    });
    socket.on('error-msg', e => setError(e.error));
    return () => { socket.off('state'); socket.off('error-msg'); socket.disconnect(); };
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
      socket.auth = { token: result.token };
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
      socket.auth = { token: result.token };
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
  const signOut = async () => {
    try { await api('/api/logout', { method: 'POST' }); } finally { localStorage.removeItem('uno-token'); socket.auth = {}; setUser(null); setProfile(null); setShowProfile(false); }
  };
  const setRoomUrl = code => { const url = new URL(location.href); if (code) url.searchParams.set('room', code); else url.searchParams.delete('room'); history.replaceState(null, '', url); };
  const create = () => { localStorage.setItem('uno-name', name || '玩家'); socket.emit('createRoom', { name: name || '玩家' }, r => { if (r.ok) { setRoomCode(r.code); localStorage.setItem('uno-room', r.code); setRoomUrl(r.code); } else setError(r.error); }); };
  const join = (code) => { const c = (code ?? codeInput).toUpperCase(); if (!c) return setError('请输入房间码'); localStorage.setItem('uno-name', name || '玩家'); socket.emit('joinRoom', { code: c, name: name || '玩家' }, r => { if (r.ok) { setRoomCode(r.code); localStorage.setItem('uno-room', r.code); setRoomUrl(r.code); } else setError(r.error); }); };
  const leave = () => { socket.emit('leaveRoom', { code: roomCode }); localStorage.removeItem('uno-room'); setRoomUrl(null); setRoomCode(null); setGame(null); setError('已退出房间'); };
  const start = () => socket.emit('startGame', { code: roomCode });
  const play = i => {
    const card = game.yourHand[i];
    if (card.color === 'wild') { setPickIndex(i); return; }
    socket.emit('playCard', { code: roomCode, cardIndex: i });
  };
  const playWild = chosenColor => { socket.emit('playCard', { code: roomCode, cardIndex: pickIndex, chosenColor }); setPickIndex(null); };
  const draw = () => socket.emit('draw', { code: roomCode });
  const keepDrawn = () => socket.emit('keepDrawn', { code: roomCode });
  const catchUnoBtn = () => socket.emit('catchUno', { code: roomCode }, r => { if (!r.ok) setError(r.error); else setError('抓到了！对方罚摸两张'); });
  const callUno = () => socket.emit('callUno', { code: roomCode }, r => { if (!r.ok) setError(r.error); else setError('UNO！已宣告'); });
  const share = () => { navigator.clipboard?.writeText(`${location.origin}${location.pathname}?room=${roomCode}`); setError('邀请链接已复制'); };
  useEffect(() => { const c = new URLSearchParams(location.search).get('room'); if (c) setCodeInput(c.toUpperCase()); }, []);
  const meTurn = game?.turn === socket.id;
  const playTime = seconds => `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`;
  return <main className="shell"><header><div className="brand"><span className="logo">U</span><div><b>UNO PARTY</b><small>在线派对 · 2—4 位玩家</small></div></div><div className="headerRight"><span className={connected ? 'status on' : 'status'}>● {connected ? '已连接' : '连接中'}</span>{user ? <button className="profileLink" onClick={openProfile}>{user.email} · 个人中心</button> : <span className="status">登录后保存个人战绩</span>}</div></header>
    {showProfile && profile ? <section className="profilePage"><button className="backLink" onClick={() => setShowProfile(false)}>← 返回游戏</button><p className="eyebrow">PLAYER PROFILE</p><h1>个人中心</h1><p className="profileEmail">{profile.email}</p><p className="profileHandle">@{profile.username}</p><form className="nicknameForm" onSubmit={saveNickname}><label>游戏昵称</label><input value={nickname} minLength="2" maxLength="20" onChange={e => setNickname(e.target.value)} placeholder="输入昵称"/><button type="submit">保存昵称</button></form><div className="statsGrid"><Stat label="胜率" value={`${profile.winRate}%`}/><Stat label="胜场" value={profile.wins}/><Stat label="总场次" value={profile.gamesPlayed}/><Stat label="累计游玩" value={playTime(profile.playSeconds)}/></div><button className="logoutButton" onClick={signOut}>退出登录</button></section> : !roomCode ? <section className="welcome"><div className="hero"><div className="orbit">🟥 🟨 🟩 🟦</div><p className="eyebrow">THE CLASSIC, ONLINE</p><h1>牌局已就绪？<br/><em>开玩吧。</em></h1><p className="sub">创建房间，邀请好友，把友情放进弃牌堆。</p></div><div className="panel"><label>你的昵称</label><input value={name} onChange={e => setName(e.target.value)} maxLength="18" placeholder="输入昵称"/><button className="primary" onClick={create}>创建新房间 <span>↗</span></button><div className="divider"><span>或加入朋友的房间</span></div><div className="join"><input value={codeInput} onChange={e => setCodeInput(e.target.value.toUpperCase())} maxLength="4" placeholder="房间码"/><button onClick={() => join()}>加入</button></div>{!user && (authMode === 'confirm' ? <form className="authForm" onSubmit={confirmEmail}><div className="divider"><span>验证邮箱</span></div><h3>输入邮件验证码</h3><p className="authHint">验证码已发送至 {pendingEmail}，10 分钟内有效</p><input required inputMode="numeric" pattern="[0-9]{6}" maxLength="6" value={verifyCode} onChange={e => setVerifyCode(e.target.value)} placeholder="6 位验证码"/><button className="primary" type="submit">验证并创建账号</button></form> : <form className="authForm" onSubmit={submitAuth}><div className="divider"><span>账号中心</span></div><h3>{authMode === 'login' ? '邮箱登录' : '注册账号'}</h3>{authMode === 'register' && <><input required minLength="3" maxLength="20" pattern="[A-Za-z0-9_]{3,20}" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} placeholder="唯一用户名（字母/数字/下划线）"/><p className="authHint">username 唯一；游戏昵称可在个人中心修改</p></>}<input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="邮箱地址"/><input type="password" required minLength="8" maxLength="128" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="密码（至少 8 位）"/><button className="primary" type="submit">{authMode === 'login' ? '登录并同步战绩' : '发送邮箱验证码'}</button><button className="modeLink" type="button" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>{authMode === 'login' ? '还没有账号？立即注册' : '已有账号？返回登录'}</button></form>)}{error && <p className="error">{error}</p>}</div></section> : <section className="table"><div className="roombar"><div><small>房间码</small><b>{roomCode}</b></div><button onClick={share}>邀请好友 ↗</button><span>{game?.players?.length || 1}/4 玩家</span><button className="leaveRoom" onClick={leave}>退出房间</button></div>{!game?.started ? <div className="lobby"><h2>等待玩家加入</h2><div className="avatars">{(game?.players || [name || '你']).map((p,i)=><div className="avatar" key={i}><span>{p[0]}</span>{p}</div>)}</div><p>至少需要 2 位玩家开始游戏</p><button className="primary" disabled={(game?.players?.length || 1)<2} onClick={start}>开始游戏</button>{error && <p className="error">{error}</p>}</div> : <><div className="opponents">{(game.players || []).map((p,i)=><div className={'opponent '+(game.turn === p ? 'active' : '')} key={p}><span className="avatarSmall">{(game.names?.[p] || '?')[0]}</span><b>{p === socket.id ? '你' : (game.names?.[p] || `玩家 ${i+1}`)}</b><small>{game.handCounts?.[p]} 张牌</small></div>)}</div><div className="center"><div className="pile" onClick={() => { if (meTurn && game.mayPlayDrawn == null) draw(); }}><small>摸牌堆</small><div className="back">UNO</div><small>{game.drawPileCount} 张 · 点击摸牌</small></div><div className="discard"><small>弃牌 · {game.activeColor}</small><Card card={game.top}/></div></div><div className="turn">{game.winner ? (game.winner === socket.id ? '🏆 你赢了！' : `🏆 ${game.names?.[game.winner] || '对手'} 获胜`) : meTurn ? (game.pendingDraw > 0 ? `你的回合：叠加 +2/+4，否则摸 ${game.pendingDraw} 张` : (game.mayPlayDrawn != null ? '摸到的牌可以出，或选择留着' : '轮到你了！选择一张牌或摸牌')) : `等待 ${game.names?.[game.turn] || '对手'} 出牌…`}</div>
{(game.unoVulnerable && game.unoVulnerable.player !== socket.id && !game.winner) && <div className="unoCatch"><button className="catchButton" onClick={catchUnoBtn}>⚡ 抓 UNO！{game.names?.[game.unoVulnerable.player] || '对手'} 忘了喊</button></div>}
{meTurn && game.pendingDraw > 0 && <div className="stackWarn">当前待摸 {game.pendingDraw} 张 · 可用 +2/+4 叠加传给下家</div>}<div className="hand">{(game.yourHand || []).map((c,i)=><button key={i} disabled={!meTurn} onClick={()=>play(i)} className={'cardButton'+(i===game.mayPlayDrawn?' drawn':'')}><Card card={c}/></button>)}</div>
{meTurn && game.mayPlayDrawn != null && <div className="drawnActions"><button className="drawButton" onClick={()=>play(game.mayPlayDrawn)}>打出这张</button><button className="drawButton" onClick={keepDrawn}>留着，结束回合</button></div>}
<div className="gameActions"><button className="drawButton" disabled={!meTurn || game.mayPlayDrawn != null} onClick={draw}>摸一张牌</button><button className="unoButton" disabled={!game.yourHand || game.yourHand.length !== 1} onClick={callUno}>喊 UNO！</button></div>{pickIndex !== null && <div className="colorPick"><p>为变色牌选择颜色</p><div className="colorOptions">{[['red','红色'],['yellow','黄色'],['green','绿色'],['blue','蓝色']].map(([c,label]) => <button key={c} className={'pick '+c} onClick={() => playWild(c)}><i/>{label}</button>)}</div><button className="pickCancel" onClick={() => setPickIndex(null)}>取消</button></div>}{error && <p className="error">{error}</p>}</>}</section>}
  </main>;
}
function Stat({ label, value }) { return <div className="statCard"><span>{label}</span><strong>{value}</strong></div>; }
function Card({ card }) { if (!card) return null; return <div className={'card '+(card.color==='wild'?'wild':'')} style={{'--card':colors[card.color]}}><span className="corner">{labels[card.value] || card.value}</span><strong>{labels[card.value] || card.value}</strong><span className="corner bottom">{labels[card.value] || card.value}</span></div>; }

createRoot(document.getElementById('root')).render(<App/>);
