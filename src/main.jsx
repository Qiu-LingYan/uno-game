import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import './style.css';

const socket = io(import.meta.env.VITE_SOCKET_URL || undefined, { autoConnect: false, path: '/socket.io' });
const labels = { skip: '🚫', reverse: '🔄', draw2: '+2', wild: '变色', wild4: '+4' };
const colors = { red: '#ff5062', yellow: '#ffd843', green: '#48d597', blue: '#4c9aff', wild: '#252936' };
function App() {
  const [name, setName] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [game, setGame] = useState(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    socket.connect();
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('state', s => { setRoomCode(s.room); setGame(s); });
    socket.on('error-msg', e => setError(e.error));
    return () => { socket.off('state'); socket.off('error-msg'); socket.disconnect(); };
  }, []);
  const create = () => socket.emit('createRoom', { name: name || '玩家' }, r => { if (r.ok) setRoomCode(r.code); else setError(r.error); });
  const join = () => socket.emit('joinRoom', { code: codeInput, name: name || '玩家' }, r => { if (r.ok) setRoomCode(r.code); else setError(r.error); });
  const start = () => socket.emit('startGame', { code: roomCode });
  const play = i => {
    const card = game.yourHand[i];
    const chosenColor = card.color === 'wild' ? prompt('选择颜色：red / yellow / green / blue') : undefined;
    if (card.color === 'wild' && !chosenColor) return;
    socket.emit('playCard', { code: roomCode, cardIndex: i, chosenColor });
  };
  const draw = () => socket.emit('draw', { code: roomCode });
  const share = () => { navigator.clipboard?.writeText(`${location.origin}${location.pathname}?room=${roomCode}`); setError('邀请链接已复制'); };
  useEffect(() => { const c = new URLSearchParams(location.search).get('room'); if (c) setCodeInput(c); }, []);
  const meTurn = game?.turn === socket.id;
  return <main className="shell"><header><div className="brand"><span className="logo">U</span><div><b>UNO PARTY</b><small>在线派对 · 2—4 位玩家</small></div></div><span className={connected ? 'status on' : 'status'}>● {connected ? '已连接' : '连接中'}</span></header>
    {!roomCode ? <section className="welcome"><div className="hero"><div className="orbit">🟥 🟨 🟩 🟦</div><p className="eyebrow">THE CLASSIC, ONLINE</p><h1>牌局已就绪？<br/><em>开玩吧。</em></h1><p className="sub">创建房间，邀请好友，把友情放进弃牌堆。</p></div><div className="panel"><label>你的昵称</label><input value={name} onChange={e => setName(e.target.value)} maxLength="18" placeholder="输入昵称"/><button className="primary" onClick={create}>创建新房间 <span>↗</span></button><div className="divider"><span>或加入朋友的房间</span></div><div className="join"><input value={codeInput} onChange={e => setCodeInput(e.target.value.toUpperCase())} maxLength="4" placeholder="房间码"/><button onClick={join}>加入</button></div>{error && <p className="error">{error}</p>}</div></section> : <section className="table"><div className="roombar"><div><small>房间码</small><b>{roomCode}</b></div><button onClick={share}>邀请好友 ↗</button><span>{game?.players?.length || 1}/4 玩家</span></div>{!game?.started ? <div className="lobby"><h2>等待玩家加入</h2><div className="avatars">{(game?.players || [name || '你']).map((p,i)=><div className="avatar" key={i}><span>{p[0]}</span>{p}</div>)}</div><p>至少需要 2 位玩家开始游戏</p><button className="primary" disabled={(game?.players?.length || 1)<2} onClick={start}>开始游戏</button>{error && <p className="error">{error}</p>}</div> : <><div className="opponents">{(game.players || []).map((p,i)=><div className={'opponent '+(game.turn === p ? 'active' : '')} key={p}><span className="avatarSmall">{p[0]}</span><b>{p === socket.id ? '你' : `玩家 ${i+1}`}</b><small>{game.handCounts?.[p]} 张牌</small></div>)}</div><div className="center"><div className="pile" onClick={draw}><small>摸牌堆</small><div className="back">UNO</div><small>{game.drawPileCount} 张 · 点击摸牌</small></div><div className="discard"><small>弃牌 · {game.activeColor}</small><Card card={game.top}/></div></div><div className="turn">{game.winner ? `🏆 ${game.winner === socket.id ? '你赢了！' : '对手获胜'}` : meTurn ? '轮到你了！选择一张牌或摸牌' : '等待对手出牌…'}</div><div className="hand">{(game.yourHand || []).map((c,i)=><button key={i} disabled={!meTurn} onClick={()=>play(i)} className="cardButton"><Card card={c}/></button>)}</div><button className="drawButton" disabled={!meTurn} onClick={draw}>摸一张牌</button>{error && <p className="error">{error}</p>}</>}</section>}
  </main>;
}
function Card({ card }) { if (!card) return null; return <div className={'card '+(card.color==='wild'?'wild':'')} style={{'--card':colors[card.color]}}><span className="corner">{labels[card.value] || card.value}</span><strong>{labels[card.value] || card.value}</strong><span className="corner bottom">{labels[card.value] || card.value}</span></div>; }

createRoot(document.getElementById('root')).render(<App/>);
