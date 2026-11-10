// 브라우저 클라이언트: 입력 전송, 내 캐릭터 예측 이동, 다른 플레이어 보간, 화면 그리기
(() => {
  const S = window.Shared;
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);
  const INTERP_DELAY = 100; // ms
  const AMMO_COLOR = { '9mm': '#ffd36b', '12g': '#ff7b5c', '762': '#8fc2ff' };
  const HELMET_COLOR = ['', '#6b8f4e', '#3e6ea8', '#2a2a2a'];

  let W = 0, H = 0, DPR = 1;
  let SAFE = { t: 0, r: 0, b: 0, l: 0 }; // 아이패드/아이폰 화면 가장자리(홈 바 등) 여백
  const safeProbe = document.getElementById('safe');
  // 캔버스가 실제로 화면에 그려지는 크기를 그대로 사용해야 늘어나거나 찌그러지지 않는다
  // (iPad Safari는 주소창·탭바가 접히고 펴지면서 window.innerHeight와 실제 크기가 달라질 수 있음)
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width || window.innerWidth));
    H = Math.max(1, Math.round(r.height || window.innerHeight));
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    if (safeProbe) {
      const cs = getComputedStyle(safeProbe);
      SAFE = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
    }
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => { resize(); setTimeout(resize, 300); setTimeout(resize, 800); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  resize();

  // ---------------- 상태 ----------------
  let ws = null, connected = false;
  let myId = null, mode = 'menu'; // menu | play | dead | spectate
  let world = null; // {obs: Map, list, grid, bld}
  const roster = new Map();
  let snaps = [];
  let me = null, lastMsg = null, items = [], zone = null, alive = 0, specId = 0;
  let pred = { x: 0, y: 0 }, prevPred = { x: 0, y: 0 }, offset = { x: 0, y: 0 };
  let pending = [], seq = 0, accum = 0;
  let clockOff = null, ping = 0;
  const bullets = new Map();
  const killfeed = [], explosions = [];
  let hurtFlash = 0, lastHp = 100, zoomCur = 1, roofAlpha = [];
  let camX = 0, camY = 0, scale = 1;
  const input = { keys: 0, mouseX: 0, mouseY: 0, down: false, clicks: 0, angle: 0, touchKeys: 0, touchFire: false, touchAngle: 0 };
  let touchMode = false, UI = 1; // UI: HUD 크기 배율 (작은 화면에서 줄임)
  const sticks = { move: null, aim: null };
  const STICK_R = 64;
  let muted = false, ended = false;

  // ---------------- 메뉴 ----------------
  try { $('name').value = localStorage.getItem('s2d_name') || ''; } catch (e) { /* 저장소 사용 불가 */ }
  fetch('/status').then((r) => r.json()).then((s) => { $('status').textContent = `접속 중인 플레이어: ${s.players}명`; }).catch(() => { $('status').textContent = '서버에 연결할 수 없습니다'; });
  $('play').onclick = start;
  $('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  $('spectate').onclick = () => { $('dead').classList.add('hidden'); mode = 'spectate'; };

  function start() {
    const name = $('name').value.trim();
    try { localStorage.setItem('s2d_name', name); } catch (e) { /* 무시 */ }
    $('play').disabled = true; $('play').textContent = '연결 중…';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { connected = true; ws.send(JSON.stringify({ t: 'join', name })); };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      connected = false;
      $('menu').classList.remove('hidden');
      $('play').disabled = false; $('play').textContent = '다시 연결';
      $('status').textContent = '서버와 연결이 끊어졌습니다';
      mode = 'menu';
    };
    initAudio();
  }
  setInterval(() => { if (connected) ws.send(JSON.stringify({ t: 'p', v: performance.now() })); }, 2000);

  // ---------------- 네트워크 ----------------
  function onMessage(m) {
    switch (m.t) {
      case 'init': return onInit(m);
      case 'r': roster.clear(); for (const [id, name, bot] of m.l) roster.set(id, { name, bot }); return;
      case 's': return onState(m);
      case 'dead':
        mode = 'dead';
        $('deadPlace').textContent = `#${m.place}`;
        $('deadKills').textContent = m.kills;
        $('deadBy').textContent = m.killer || m.cause;
        $('dead').classList.remove('hidden');
        return;
      case 'end':
        ended = true;
        showBanner(m.you ? '🏆 승리!' : m.winner ? `${m.winner} 우승` : '경기 종료', m.you ? '최후의 1인이 되었습니다!' : '잠시 후 다음 판이 시작됩니다', 6500);
        return;
      case 'P': ping = Math.round(performance.now() - m.v); return;
    }
  }

  function onInit(m) {
    myId = m.id;
    ended = false;
    roster.clear(); for (const [id, name, bot] of m.roster) roster.set(id, { name, bot });
    const obs = new Map(), list = [];
    for (const [id, k, x, y, a, b, hp] of m.obs) {
      const kind = S.OBST_KINDS[k];
      const shape = kind === 'crate' || kind === 'wall' ? 'r' : 'c';
      const o = shape === 'c' ? { id, kind, shape, x, y, cr: a, vr: b } : { id, kind, shape, x, y, w: a, h: b };
      o.hp = hp; o.dead = hp === 0;
      o.solid = kind !== 'bush'; o.blocksShots = kind !== 'bush';
      obs.set(id, o); list.push(o);
    }
    const grid = new S.Grid(m.size, 128);
    for (const o of list) grid.insert(o);
    world = { obs, list, grid, bld: m.bld.map(([x, y, w, h, color]) => ({ x, y, w, h, color })) };
    roofAlpha = world.bld.map(() => 1);
    snaps = []; pending = []; bullets.clear(); items = []; me = null; lastMsg = null;
    specId = m.spec || 0;
    $('menu').classList.add('hidden');
    $('dead').classList.add('hidden');
    $('banner').classList.add('hidden');
    mode = myId ? 'play' : 'spectate';
    if (!myId) showBanner('관전 중', '이미 진행 중인 판입니다. 다음 판에 자동으로 참가합니다.', 4000);
    lastHp = 100;
  }

  function onState(m) {
    const now = performance.now();
    const sample = m.tm - now;
    clockOff = clockOff === null ? sample : clockOff + (sample - clockOff) * 0.05;
    const ps = new Map();
    for (const p of m.ps) ps.set(p[0], p);
    snaps.push({ tm: m.tm, ps });
    if (snaps.length > 40) snaps.shift();
    if (m.it) items = m.it;
    zone = m.z; alive = m.al;
    if (m.spec !== undefined) specId = m.spec;

    if (m.nb) for (const b of m.nb) bullets.set(b[0], { x: b[1], y: b[2], a: b[3], sp: b[4], max: b[5], end: b[5], ammo: b[6], len: b[7], owner: b[8], tm: b[9] });
    if (m.eb) for (const [id, d] of m.eb) { const b = bullets.get(id); if (b) b.end = d; }
    if (m.nb) playShots(m.nb);
    if (m.ob && world) for (const [id, hp] of m.ob) { const o = world.obs.get(id); if (o) { o.hp = hp; if (hp === 0) o.dead = true; } }
    if (m.ev) for (const e of m.ev) {
      if (e.k) { killfeed.push({ t: now, k: e.k }); if (killfeed.length > 6) killfeed.shift(); }
      if (e.ex) { explosions.push({ x: e.ex[0], y: e.ex[1], t: now }); playBoom(e.ex[0], e.ex[1]); }
    }

    if (m.me) {
      const first = !me;
      me = m.me;
      if (me.hp < lastHp - 0.5) hurtFlash = 1;
      lastHp = me.hp;
      if (first) { pred = { x: me.x, y: me.y }; prevPred = { ...pred }; pending = []; }
      else reconcile(m.ls);
    } else me = null;
    lastMsg = m;
  }

  // 서버가 확인한 위치에서 아직 확인 안 된 입력을 다시 적용
  function reconcile(ls) {
    const before = { x: pred.x, y: pred.y };
    pred.x = me.x; pred.y = me.y;
    pending = pending.filter((i) => i.s > ls);
    const mul = S.speedMul(me.ac, me.bo);
    for (const i of pending) S.moveStep(pred, i.k, S.DT, mul, world.grid);
    const dx = pred.x - before.x, dy = pred.y - before.y;
    prevPred.x += dx; prevPred.y += dy;
    offset.x -= dx; offset.y -= dy;
    if (Math.hypot(offset.x, offset.y) > 160) offset = { x: 0, y: 0 };
  }

  function inputStep() {
    if (!connected || mode !== 'play' || !me || !world || ended) return;
    seq++;
    const keys = input.keys | input.touchKeys;
    if (input.touchFire) input.clicks++; // 모바일: 조준 스틱을 끝까지 밀면 단발총도 자동 연사
    ws.send(JSON.stringify({ t: 'i', s: seq, k: keys, a: Math.round(input.angle * 1000) / 1000, f: input.down || input.touchFire, c: input.clicks }));
    prevPred = { x: pred.x, y: pred.y };
    S.moveStep(pred, keys, S.DT, S.speedMul(me.ac, me.bo), world.grid);
    pending.push({ s: seq, k: keys });
    if (pending.length > 90) pending.shift();
  }

  function action(a, v) { if (connected && mode === 'play') ws.send(JSON.stringify({ t: 'a', a, v })); }

  // ---------------- 입력 ----------------
  const KEYMAP = { KeyW: S.KEY.UP, ArrowUp: S.KEY.UP, KeyS: S.KEY.DOWN, ArrowDown: S.KEY.DOWN, KeyA: S.KEY.LEFT, ArrowLeft: S.KEY.LEFT, KeyD: S.KEY.RIGHT, ArrowRight: S.KEY.RIGHT };
  window.addEventListener('keydown', (e) => {
    if (document.activeElement === $('name')) return;
    if (KEYMAP[e.code]) { input.keys |= KEYMAP[e.code]; e.preventDefault(); return; }
    if (e.repeat) return;
    switch (e.code) {
      case 'KeyF': action('pickup'); break;
      case 'KeyR': action('reload'); break;
      case 'Digit1': action('slot', 0); break;
      case 'Digit2': action('slot', 1); break;
      case 'Digit3': action('slot', 2); break;
      case 'KeyQ': action('swap'); break;
      case 'Digit7': action('use', 'bandage'); break;
      case 'Digit8': action('use', 'medkit'); break;
      case 'Digit9': action('use', 'soda'); break;
      case 'KeyM': muted = !muted; break;
      case 'Space': if (mode === 'spectate' && connected) ws.send(JSON.stringify({ t: 'spec' })); e.preventDefault(); break;
    }
  });
  window.addEventListener('keyup', (e) => { if (KEYMAP[e.code]) input.keys &= ~KEYMAP[e.code]; });
  window.addEventListener('blur', () => { input.keys = 0; input.down = false; });
  canvas.addEventListener('mousemove', (e) => { input.mouseX = e.clientX; input.mouseY = e.clientY; });
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (hudClick(e.clientX, e.clientY)) return;
    input.down = true; input.clicks++;
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 0) input.down = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---------------- 터치 (모바일/태블릿) ----------------
  // 왼쪽 화면: 이동 스틱 / 오른쪽 화면: 조준 스틱 (끝까지 밀면 사격)
  function onTouchStart(e) {
    e.preventDefault();
    touchMode = true;
    if (actx && actx.state === 'suspended') actx.resume();
    for (const t of e.changedTouches) {
      const x = t.clientX, y = t.clientY;
      if (hudClick(x, y)) continue;
      const st = { id: t.identifier, ox: x, oy: y, x, y };
      if (x < W / 2) { if (!sticks.move) sticks.move = st; }
      else if (!sticks.aim) sticks.aim = st;
    }
    updateSticks();
  }
  function onTouchMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      for (const k of ['move', 'aim']) {
        const st = sticks[k];
        if (st && st.id === t.identifier) { st.x = t.clientX; st.y = t.clientY; }
      }
    }
    updateSticks();
  }
  function onTouchEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      for (const k of ['move', 'aim']) if (sticks[k] && sticks[k].id === t.identifier) sticks[k] = null;
    }
    updateSticks();
  }
  function updateSticks() {
    input.touchKeys = 0; input.touchFire = false;
    const m = sticks.move;
    if (m) {
      // 손가락이 너무 멀어지면 스틱 중심이 따라오게
      let dx = m.x - m.ox, dy = m.y - m.oy, d = Math.hypot(dx, dy);
      if (d > STICK_R) { m.ox = m.x - (dx / d) * STICK_R; m.oy = m.y - (dy / d) * STICK_R; dx = m.x - m.ox; dy = m.y - m.oy; d = STICK_R; }
      if (d > 14) {
        const oct = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
        const K = S.KEY;
        input.touchKeys = [K.RIGHT, K.RIGHT | K.DOWN, K.DOWN, K.DOWN | K.LEFT, K.LEFT, K.LEFT | K.UP, K.UP, K.UP | K.RIGHT][oct];
      }
    }
    const a = sticks.aim;
    if (a) {
      let dx = a.x - a.ox, dy = a.y - a.oy, d = Math.hypot(dx, dy);
      if (d > STICK_R) { a.ox = a.x - (dx / d) * STICK_R; a.oy = a.y - (dy / d) * STICK_R; d = STICK_R; dx = a.x - a.ox; dy = a.y - a.oy; }
      if (d > 8) input.touchAngle = Math.atan2(dy, dx);
      input.touchFire = d > STICK_R * 0.6;
    }
  }
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });
  canvas.addEventListener('mousemove', () => { if (touchMode && !sticks.move && !sticks.aim && navigator.maxTouchPoints === 0) touchMode = false; });
  canvas.addEventListener('wheel', (e) => {
    if (!me) return;
    const order = [0, 1, 2].filter((i) => i === 2 || me.g[i]);
    const idx = order.indexOf(me.cur);
    action('slot', order[(idx + (e.deltaY > 0 ? 1 : order.length - 1)) % order.length]);
  }, { passive: true });

  // ---------------- 사운드 ----------------
  let actx = null, noiseBuf = null, shotsThisFrame = 0;
  function initAudio() {
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      noiseBuf = actx.createBuffer(1, actx.sampleRate * 0.4, actx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    } catch (e) { actx = null; }
  }
  function noise(vol, freq, dur) {
    if (!actx || muted || vol < 0.02 || shotsThisFrame > 8) return;
    shotsThisFrame++;
    const src = actx.createBufferSource(); src.buffer = noiseBuf;
    const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
    const g = actx.createGain(); g.gain.setValueAtTime(vol, actx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
    src.connect(f); f.connect(g); g.connect(actx.destination);
    src.start(); src.stop(actx.currentTime + dur);
  }
  function volAt(x, y) { const d = Math.hypot(x - camX, y - camY); return Math.max(0, 1 - d / 1400) * 0.35; }
  function playShots(nb) {
    const seen = new Set();
    for (const b of nb) {
      const key = b[8] + ':' + b[9];
      if (seen.has(key)) continue; // 산탄총 펠릿은 한 번만
      seen.add(key);
      noise(volAt(b[1], b[2]), b[6] === '12g' ? 1400 : b[6] === '762' ? 2600 : 3800, b[6] === '9mm' ? 0.12 : 0.22);
    }
  }
  function playBoom(x, y) { noise(volAt(x, y) * 2.2, 600, 0.6); }

  // ---------------- 보간 ----------------
  function renderTime() { return performance.now() + (clockOff || 0) - INTERP_DELAY; }
  function interpPlayers() {
    const out = [];
    if (!snaps.length) return out;
    const rt = renderTime();
    let a = snaps[0], b = snaps[snaps.length - 1];
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i - 1].tm <= rt) { a = snaps[i - 1]; b = snaps[i]; break; }
    }
    const t = b.tm === a.tm ? 1 : Math.max(0, Math.min(1, (rt - a.tm) / (b.tm - a.tm)));
    for (const [id, pb] of b.ps) {
      const pa = a.ps.get(id);
      if (!pa) { out.push(toP(pb, pb, 1)); continue; }
      out.push(toP(pa, pb, t));
    }
    return out;
  }
  function toP(a, b, t) {
    return { id: b[0], x: a[1] + (b[1] - a[1]) * t, y: a[2] + (b[2] - a[2]) * t, angle: a[3] + S.angleDiff(a[3], b[3]) * t, weapon: b[4], helmet: b[5], vest: b[6], flags: b[7] };
  }

  // ---------------- HUD 클릭 영역 ----------------
  let hudButtons = [];
  function hudClick(x, y) {
    x = (x - SAFE.l) / UI; y = (y - SAFE.t) / UI;
    for (const b of hudButtons) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { b.fn(); return true; }
    return false;
  }

  // ---------------- 그리기 ----------------
  let lastFrame = performance.now();
  function frame(now) {
    if (Math.abs(canvas.clientWidth - W) > 1 || Math.abs(canvas.clientHeight - H) > 1) resize();
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    shotsThisFrame = 0;
    accum += dt;
    let steps = 0;
    while (accum >= S.DT && steps < 4) { inputStep(); accum -= S.DT; steps++; }
    if (steps === 4) accum = 0;
    const k = Math.exp(-dt * 12);
    offset.x *= k; offset.y *= k;
    hurtFlash = Math.max(0, hurtFlash - dt * 2.5);
    draw(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.__s2d = () => ({ pred, me, offset, pending: pending.length, mode, ping, items, bld: world && world.bld }); // 디버그용

  function draw(dt) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#2b3a22';
    ctx.fillRect(0, 0, W, H);
    hudButtons = [];
    if (!world) return;

    const players = interpPlayers();
    let focus = null;
    if (me && mode === 'play') {
      const a = Math.min(1, accum / S.DT);
      focus = { x: prevPred.x + (pred.x - prevPred.x) * a + offset.x, y: prevPred.y + (pred.y - prevPred.y) * a + offset.y };
    } else {
      const sp = players.find((p) => p.id === specId);
      if (sp) focus = { x: sp.x, y: sp.y };
      else focus = { x: camX || S.MAP_SIZE / 2, y: camY || S.MAP_SIZE / 2 };
    }
    camX = focus.x; camY = focus.y;
    const zoomTarget = S.SCOPE_ZOOM[(me && me.sc) || 1];
    zoomCur += (zoomTarget - zoomCur) * Math.min(1, dt * 4);
    // 화면 비율과 상관없이 보이는 면적이 같도록 (iPad 4:3, 세로 화면, 16:9 모두 대응)
    scale = Math.sqrt(W * H) / (S.VIEW_W * 0.75 * zoomCur);
    UI = Math.max(0.62, Math.min(1, Math.min(W, H) / 720));

    // 마우스 조준 각도 (내 캐릭터는 화면 중앙)
    input.angle = touchMode ? input.touchAngle : Math.atan2(input.mouseY - H / 2, input.mouseX - W / 2);

    const vw = W / scale / 2 + 120, vh = H / scale / 2 + 120;
    const x0 = camX - vw, x1 = camX + vw, y0 = camY - vh, y1 = camY + vh;

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(scale, scale);
    ctx.translate(-camX, -camY);

    // 바닥
    ctx.fillStyle = '#5f8a3c';
    ctx.fillRect(-2000, -2000, S.MAP_SIZE + 4000, S.MAP_SIZE + 4000);
    ctx.fillStyle = '#80af50';
    ctx.fillRect(0, 0, S.MAP_SIZE, S.MAP_SIZE);
    ctx.strokeStyle = 'rgba(0,0,0,0.07)'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let gx = Math.max(0, Math.floor(x0 / 100) * 100); gx <= Math.min(S.MAP_SIZE, x1); gx += 100) { ctx.moveTo(gx, Math.max(0, y0)); ctx.lineTo(gx, Math.min(S.MAP_SIZE, y1)); }
    for (let gy = Math.max(0, Math.floor(y0 / 100) * 100); gy <= Math.min(S.MAP_SIZE, y1); gy += 100) { ctx.moveTo(Math.max(0, x0), gy); ctx.lineTo(Math.min(S.MAP_SIZE, x1), gy); }
    ctx.stroke();

    // 건물 바닥
    for (const b of world.bld) {
      if (b.x > x1 || b.x + b.w < x0 || b.y > y1 || b.y + b.h < y0) continue;
      ctx.fillStyle = '#b8935f'; ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = 'rgba(80,50,20,0.25)'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let yy = b.y + 24; yy < b.y + b.h; yy += 24) { ctx.moveTo(b.x, yy); ctx.lineTo(b.x + b.w, yy); }
      ctx.stroke();
    }

    // 아이템
    for (const it of items) {
      if (it[2] < x0 || it[2] > x1 || it[3] < y0 || it[3] > y1) continue;
      drawItem(it[1], it[2], it[3], it[4]);
    }

    const visObs = world.grid.queryRect(x0, y0, x1, y1).filter((o) => !o.dead);
    // 낮은 장애물
    for (const o of visObs) if (o.kind !== 'tree' && o.kind !== 'bush') drawObstacle(o);

    // 총알
    const rtNow = performance.now() + (clockOff || 0);
    ctx.lineCap = 'round';
    for (const [id, b] of bullets) {
      const t = b.owner === myId ? rtNow : rtNow - INTERP_DELAY;
      const d = (b.sp * (t - b.tm)) / 1000;
      if (d - 90 > b.end) { bullets.delete(id); continue; }
      const head = Math.min(d, b.end), tail = Math.max(S.PLAYER_R + b.len, d - 80);
      if (head <= tail) continue;
      const cx = Math.cos(b.a), cy = Math.sin(b.a);
      ctx.strokeStyle = AMMO_COLOR[b.ammo] || '#ff0';
      ctx.lineWidth = b.ammo === '12g' ? 3 : 4;
      ctx.beginPath(); ctx.moveTo(b.x + cx * tail, b.y + cy * tail); ctx.lineTo(b.x + cx * head, b.y + cy * head); ctx.stroke();
    }

    // 플레이어
    for (const p of players) {
      if (p.id === myId && me && mode === 'play') continue;
      drawPlayer(p.x, p.y, p.angle, p.weapon, p.helmet, p.vest, p.flags, p.id === specId && mode !== 'play');
      const r = roster.get(p.id);
      if (r) { ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(r.name, p.x, p.y + S.PLAYER_R + 22); }
    }
    if (me && mode === 'play') {
      const g = me.cur < 2 && me.g[me.cur] ? me.g[me.cur][0] : 'fists';
      const myFlags = players.find((p) => p.id === myId);
      drawPlayer(focus.x, focus.y, input.angle, g, me.he, me.ve, myFlags ? myFlags.flags & 3 : 0, true);
    }

    // 덤불, 나무 (플레이어 위에 덮임)
    for (const o of visObs) {
      if (o.kind !== 'tree' && o.kind !== 'bush') continue;
      const inside = Math.hypot(camX - o.x, camY - o.y) < (o.kind === 'tree' ? o.vr : o.cr) - 6;
      if (o.kind === 'bush') {
        const r = o.cr * (0.75 + 0.25 * o.hp);
        ctx.globalAlpha = inside ? 0.55 : 0.94;
        ctx.fillStyle = '#4c8a32'; circle(o.x, o.y, r); ctx.fill();
        ctx.fillStyle = '#5c9c3e'; circle(o.x - r * 0.25, o.y - r * 0.25, r * 0.55); ctx.fill();
      } else {
        ctx.globalAlpha = inside ? 0.5 : 0.92;
        const r = o.vr * (0.8 + 0.2 * o.hp);
        ctx.fillStyle = '#2f6b2a'; circle(o.x, o.y, r); ctx.fill();
        ctx.fillStyle = '#3b7f33'; circle(o.x, o.y, r * 0.72); ctx.fill();
        ctx.fillStyle = '#5b3b22'; circle(o.x, o.y, o.cr * 0.55); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // 지붕
    world.bld.forEach((b, i) => {
      const inside = camX > b.x && camX < b.x + b.w && camY > b.y && camY < b.y + b.h;
      roofAlpha[i] += ((inside ? 0 : 1) - roofAlpha[i]) * Math.min(1, dt * 8);
      if (roofAlpha[i] < 0.02 || b.x > x1 || b.x + b.w < x0 || b.y > y1 || b.y + b.h < y0) return;
      ctx.globalAlpha = roofAlpha[i];
      ctx.fillStyle = b.color; ctx.fillRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      if (b.w > b.h) ctx.fillRect(b.x - 6, b.y + b.h / 2, b.w + 12, b.h / 2 + 6); else ctx.fillRect(b.x + b.w / 2, b.y - 6, b.w / 2 + 6, b.h + 12);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 6; ctx.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
      ctx.globalAlpha = 1;
    });

    // 폭발
    const nowMs = performance.now();
    for (let i = explosions.length - 1; i >= 0; i--) {
      const e = explosions[i], t = (nowMs - e.t) / 500;
      if (t > 1) { explosions.splice(i, 1); continue; }
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = '#ffb347'; circle(e.x, e.y, 40 + 120 * t); ctx.fill();
      ctx.fillStyle = '#fff3c4'; circle(e.x, e.y, 20 + 60 * t); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 자기장
    if (zone) {
      const [cx, cy, r, ncx, ncy, nr, stage] = zone;
      ctx.fillStyle = 'rgba(210, 40, 30, 0.32)';
      ctx.beginPath();
      ctx.rect(x0 - 200, y0 - 200, (x1 - x0) + 400, (y1 - y0) + 400);
      ctx.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2, true);
      ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(255,80,60,0.9)'; ctx.lineWidth = 6;
      circle(cx, cy, Math.max(0, r)); ctx.stroke();
      if (stage !== 2) {
        ctx.setLineDash([24, 18]); ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 4;
        circle(ncx, ncy, Math.max(0, nr)); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    ctx.restore();

    drawHUD(players);
  }

  function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }

  function drawObstacle(o) {
    const hp = o.hp === undefined ? 1 : o.hp;
    switch (o.kind) {
      case 'rock': {
        const r = o.cr * (0.7 + 0.3 * hp);
        ctx.fillStyle = '#6f6f6f'; circle(o.x, o.y, r); ctx.fill();
        ctx.fillStyle = '#868686'; circle(o.x - r * 0.15, o.y - r * 0.15, r * 0.75); ctx.fill();
        break;
      }
      case 'barrel': {
        const r = o.cr * (0.8 + 0.2 * hp);
        ctx.fillStyle = '#34495e'; circle(o.x, o.y, r); ctx.fill();
        ctx.strokeStyle = '#22303d'; ctx.lineWidth = 4; circle(o.x, o.y, r * 0.65); ctx.stroke();
        ctx.fillStyle = '#c0392b'; circle(o.x, o.y, r * 0.3); ctx.fill();
        break;
      }
      case 'crate': {
        const s = 0.75 + 0.25 * hp, w = o.w * s, h = o.h * s;
        const x = o.x + (o.w - w) / 2, y = o.y + (o.h - h) / 2;
        ctx.fillStyle = '#9a6a33'; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#6b4520'; ctx.lineWidth = 5; ctx.strokeRect(x + 2.5, y + 2.5, w - 5, h - 5);
        ctx.beginPath(); ctx.moveTo(x + 5, y + 5); ctx.lineTo(x + w - 5, y + h - 5); ctx.moveTo(x + w - 5, y + 5); ctx.lineTo(x + 5, y + h - 5); ctx.stroke();
        break;
      }
      case 'wall':
        ctx.fillStyle = '#4a3d2e'; ctx.fillRect(o.x, o.y, o.w, o.h);
        break;
    }
  }

  function drawItem(type, x, y, count) {
    const info = S.itemInfo(type);
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; circle(x, y, 22); ctx.fill();
    ctx.strokeStyle = info.kind === 'gun' ? '#ffe58a' : 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2.5; circle(x, y, 22); ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    switch (info.kind) {
      case 'gun':
        ctx.save(); ctx.translate(x, y); ctx.rotate(-0.5);
        ctx.fillStyle = '#2b2b2b'; ctx.fillRect(-16, -4, 32, 8); ctx.fillRect(-16, -2, 8, 12);
        ctx.restore();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.fillText(info.name, x, y + 31);
        break;
      case 'ammo':
        ctx.fillStyle = info.color;
        for (let i = -1; i <= 1; i++) { ctx.fillRect(x + i * 8 - 3, y - 9, 6, 18); }
        break;
      case 'med':
        if (info.sub === 'bandage') { ctx.fillStyle = '#f2f2f2'; ctx.fillRect(x - 12, y - 6, 24, 12); ctx.fillStyle = '#d9c7a8'; ctx.fillRect(x - 3, y - 6, 6, 12); }
        else if (info.sub === 'medkit') { ctx.fillStyle = '#fff'; ctx.fillRect(x - 13, y - 10, 26, 20); ctx.fillStyle = '#e33'; ctx.fillRect(x - 3, y - 7, 6, 14); ctx.fillRect(x - 7, y - 3, 14, 6); }
        else { ctx.fillStyle = '#3cbf5a'; ctx.fillRect(x - 7, y - 12, 14, 24); ctx.fillStyle = '#ddd'; ctx.fillRect(x - 7, y - 12, 14, 4); }
        break;
      case 'helmet':
        ctx.fillStyle = info.color; ctx.beginPath(); ctx.arc(x, y + 4, 13, Math.PI, 0); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.fillText(info.sub, x, y + 10);
        break;
      case 'vest':
        ctx.fillStyle = info.color; ctx.fillRect(x - 11, y - 12, 22, 24);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif'; ctx.fillText(info.sub, x, y + 1);
        break;
      case 'scope':
        ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif'; ctx.fillText(info.sub + 'x', x, y + 1);
        break;
    }
    ctx.textBaseline = 'alphabetic';
  }

  function drawPlayer(x, y, angle, weapon, helmet, vest, flags, highlight) {
    const R = S.PLAYER_R;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const w = S.WEAPONS[weapon] || S.WEAPONS.fists;
    // 손과 총
    ctx.fillStyle = '#f2c38b'; ctx.strokeStyle = '#2a2016'; ctx.lineWidth = 3;
    if (w.melee) {
      const punch = flags & 2 ? 14 : 0;
      circle(R * 0.85 + punch, -R * 0.6, 8); ctx.fill(); ctx.stroke();
      circle(R * 0.85, R * 0.6, 8); ctx.fill(); ctx.stroke();
    } else {
      ctx.fillStyle = '#1f1f1f';
      ctx.fillRect(R * 0.3, -5, R * 0.7 + w.len, 10);
      ctx.fillStyle = '#3a3a3a';
      ctx.fillRect(R * 0.3, -2, R * 0.7 + w.len - 3, 4);
      ctx.fillStyle = '#f2c38b';
      circle(R * 0.85, 5, 8); ctx.fill(); ctx.stroke();
      circle(R + w.len * 0.4, -1, 8); ctx.fill(); ctx.stroke();
    }
    // 몸
    if (vest) { ctx.fillStyle = HELMET_COLOR[vest]; circle(0, 0, R + 4); ctx.fill(); }
    ctx.fillStyle = flags & 1 ? '#ff8a7a' : '#f2c38b';
    ctx.lineWidth = 3; ctx.strokeStyle = highlight ? '#1f1a12' : '#3a2c1c';
    circle(0, 0, R); ctx.fill(); ctx.stroke();
    if (helmet) { ctx.fillStyle = HELMET_COLOR[helmet]; circle(-2, 0, R * 0.68); ctx.fill(); }
    ctx.restore();
  }

  // ---------------- HUD ----------------
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
  function panel(x, y, w, h, a) { ctx.fillStyle = `rgba(0,0,0,${a || 0.45})`; roundRect(x, y, w, h, 8); ctx.fill(); }

  function drawHUD(players) {
    const nowMs = performance.now();
    ctx.textBaseline = 'alphabetic';
    // 피격 효과
    if (hurtFlash > 0) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(255,0,0,0)'); g.addColorStop(1, `rgba(200,0,0,${0.45 * hurtFlash})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    // 터치 스틱
    for (const k of ['move', 'aim']) {
      const st = sticks[k];
      if (!st) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; circle(st.ox, st.oy, STICK_R); ctx.fill();
      ctx.strokeStyle = k === 'aim' && input.touchFire ? 'rgba(255,90,70,0.9)' : 'rgba(255,255,255,0.5)'; ctx.lineWidth = 3;
      circle(st.ox, st.oy, STICK_R); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.75)'; circle(st.x, st.y, 26); ctx.fill();
    }
    if (touchMode && mode === 'play' && !sticks.move && !sticks.aim && me) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('← 왼쪽: 이동', W * 0.22, H - 22);
      ctx.fillText('오른쪽: 조준 · 끝까지 밀면 사격 →', W * 0.72, H * 0.42);
    }
    // 아래부터는 UI 배율을 적용한 좌표계 (W, H를 가상 크기로 바꿔서 그림)
    ctx.setTransform(DPR * UI, 0, 0, DPR * UI, DPR * SAFE.l, DPR * SAFE.t);
    const W0 = W, H0 = H;
    W = (W0 - SAFE.l - SAFE.r) / UI; H = (H0 - SAFE.t - SAFE.b) / UI;
    try { drawHUDInner(players, nowMs); } finally { W = W0; H = H0; }
  }

  function drawHUDInner(players, nowMs) {

    // 좌상단: 생존자, 킬, 핑
    panel(14, 14, 150, 64);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = 'bold 20px sans-serif';
    ctx.fillText(`생존 ${alive}`, 26, 40);
    ctx.font = '14px sans-serif'; ctx.fillStyle = '#ddd';
    ctx.fillText(`처치 ${me ? me.k : 0}  ·  ${ping}ms`, 26, 64);

    // 우상단: 킬 피드
    ctx.textAlign = 'right'; ctx.font = '14px sans-serif';
    let ky = 30;
    for (let i = killfeed.length - 1; i >= 0; i--) {
      const f = killfeed[i];
      const age = (nowMs - f.t) / 1000;
      if (age > 7) continue;
      const [killer, victim, cause, kid, vid] = f.k;
      const text = killer ? `${killer}  [${cause}]  ${victim}` : `${victim}  (${cause})`;
      const tw = ctx.measureText(text).width;
      ctx.globalAlpha = Math.min(1, 7 - age);
      panel(W - tw - 34, ky - 18, tw + 20, 26, 0.5);
      ctx.fillStyle = kid === myId ? '#9eff7a' : vid === myId ? '#ff8a7a' : '#fff';
      ctx.fillText(text, W - 24, ky);
      ctx.globalAlpha = 1;
      ky += 32;
    }

    // 상단 중앙: 자기장 안내
    if (zone) {
      const [cx, cy, r, ncx, ncy, nr, stage, t] = zone;
      let msg = stage === 0 ? `자기장 축소까지 ${Math.ceil(t)}초` : stage === 1 ? `⚠ 자기장이 줄어드는 중 (${Math.ceil(t)}초)` : '최종 자기장';
      ctx.textAlign = 'center'; ctx.font = 'bold 17px sans-serif';
      const tw = ctx.measureText(msg).width;
      panel(W / 2 - tw / 2 - 14, 14, tw + 28, 34);
      ctx.fillStyle = stage === 1 ? '#ffb4a8' : '#fff'; ctx.fillText(msg, W / 2, 37);
      if (me && Math.hypot(pred.x - cx, pred.y - cy) > r) {
        ctx.font = 'bold 22px sans-serif'; ctx.fillStyle = '#ff5a4a';
        ctx.fillText('자기장 밖입니다! 안전지대로 이동하세요', W / 2, 82);
      }
    }

    drawMinimap();

    if (mode !== 'play' || !me) {
      if (mode === 'spectate') {
        const r = roster.get(specId);
        ctx.textAlign = 'center'; ctx.font = 'bold 18px sans-serif';
        const msg = `관전 중: ${r ? r.name : '-'}   ·   [Space] 다음 플레이어`;
        const tw = ctx.measureText(msg).width;
        panel(W / 2 - tw / 2 - 16, H - 70, tw + 32, 40);
        ctx.fillStyle = '#fff'; ctx.fillText(msg, W / 2, H - 43);
      }
      return;
    }

    // 하단 중앙: 체력 / 부스트
    const bw = Math.min(380, W * 0.4), bx = W / 2 - bw / 2, by = H - 46;
    panel(bx - 6, by - 26, bw + 12, 54);
    ctx.fillStyle = '#333'; ctx.fillRect(bx, by, bw, 18);
    const hp = Math.max(0, me.hp) / 100;
    ctx.fillStyle = hp > 0.6 ? '#e8e8e8' : hp > 0.3 ? '#f2c14e' : '#e5484d';
    ctx.fillRect(bx, by, bw * hp, 18);
    ctx.fillStyle = '#111'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(Math.ceil(me.hp), W / 2, by + 14);
    for (let i = 0; i < 4; i++) {
      const seg = Math.max(0, Math.min(1, (me.bo - i * 25) / 25));
      ctx.fillStyle = '#2a2a2a'; ctx.fillRect(bx + i * (bw / 4) + 1, by - 16, bw / 4 - 2, 8);
      ctx.fillStyle = '#ff9f1c'; ctx.fillRect(bx + i * (bw / 4) + 1, by - 16, (bw / 4 - 2) * seg, 8);
    }
    // 방어구 아이콘
    ctx.textAlign = 'left'; ctx.font = 'bold 13px sans-serif';
    const armor = [];
    if (me.he) armor.push(['헬멧', me.he]);
    if (me.ve) armor.push(['조끼', me.ve]);
    if (me.sc > 1) armor.push(['스코프', me.sc + 'x']);
    armor.forEach(([n, v], i) => {
      const ax = bx - 80 - i * 70;
      panel(ax, by - 20, 64, 42);
      ctx.fillStyle = '#ccc'; ctx.fillText(n, ax + 8, by - 3);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 15px sans-serif'; ctx.fillText(typeof v === 'number' ? 'Lv.' + v : v, ax + 8, by + 16); ctx.font = 'bold 13px sans-serif';
    });

    // 장전/회복 진행
    const prog = me.rl ? ['장전 중', 1 - me.rl[0] / me.rl[1]] : me.ac ? [S.MEDS[me.ac[0]].name + ' 사용 중', 1 - me.ac[1] / me.ac[2]] : null;
    if (prog) {
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 8;
      ctx.beginPath(); ctx.arc(W / 2, H / 2, 46, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(W / 2, H / 2, 46, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog[1]); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(prog[0], W / 2, H / 2 + 76);
    }

    // 우하단: 무기 슬롯
    const sw = 190, sh = 46;
    for (let i = 2; i >= 0; i--) {
      const sx = W - sw - 16, sy = H - 16 - (3 - i) * (sh + 6);
      const g = i < 2 ? me.g[i] : ['fists', 0];
      panel(sx, sy, sw, sh, me.cur === i ? 0.7 : 0.4);
      if (me.cur === i) { ctx.strokeStyle = '#f3d36b'; ctx.lineWidth = 2; roundRect(sx, sy, sw, sh, 8); ctx.stroke(); }
      ctx.textAlign = 'left'; ctx.fillStyle = '#aaa'; ctx.font = 'bold 12px sans-serif'; ctx.fillText(i + 1, sx + 10, sy + 18);
      ctx.fillStyle = g ? '#fff' : '#666'; ctx.font = 'bold 16px sans-serif';
      ctx.fillText(g ? S.WEAPONS[g[0]].name : '비어 있음', sx + 28, sy + 29);
      if (g && i < 2) {
        const w = S.WEAPONS[g[0]];
        ctx.textAlign = 'right'; ctx.font = 'bold 18px sans-serif'; ctx.fillStyle = g[1] === 0 ? '#ff6b5c' : '#fff';
        ctx.fillText(g[1], sx + sw - 46, sy + 30);
        ctx.font = '12px sans-serif'; ctx.fillStyle = AMMO_COLOR[w.ammo]; ctx.fillText('/' + me.am[w.ammo], sx + sw - 10, sy + 30);
      }
      if (g) hudButtons.push({ x: sx, y: sy, w: sw, h: sh, fn: () => action('slot', i) });
    }

    // 우측: 탄약 / 회복템
    const meds = [['bandage', '7'], ['medkit', '8'], ['soda', '9']];
    let my = H - 16 - 3 * (sh + 6) - 16;
    meds.slice().reverse().forEach(([k, key]) => {
      const n = me.md[k];
      my -= 40;
      const mx = W - 16 - 150;
      panel(mx, my, 150, 34, me.ac && me.ac[0] === k ? 0.75 : 0.4);
      ctx.globalAlpha = n ? 1 : 0.45;
      ctx.textAlign = 'left'; ctx.fillStyle = '#aaa'; ctx.font = 'bold 12px sans-serif'; ctx.fillText(key, mx + 10, my + 22);
      ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif'; ctx.fillText(S.MEDS[k].name, mx + 28, my + 22);
      ctx.textAlign = 'right'; ctx.font = 'bold 15px sans-serif'; ctx.fillText(n, mx + 140, my + 22);
      ctx.globalAlpha = 1;
      hudButtons.push({ x: mx, y: my, w: 150, h: 34, fn: () => action('use', k) });
    });
    my -= 8;
    if (touchMode) {
      // 장전 버튼 (무기 슬롯 왼쪽)
      const rx = W - sw - 16 - 50, ry = H - 16 - 3 * (sh + 6) + sh / 2 + 10, rr = 34;
      ctx.fillStyle = me.rl ? 'rgba(243,211,107,0.6)' : 'rgba(0,0,0,0.45)'; circle(rx, ry, rr); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2; circle(rx, ry, rr); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('장전', rx, ry + 5);
      hudButtons.push({ x: rx - rr, y: ry - rr, w: rr * 2, h: rr * 2, fn: () => action('reload') });
    }
    if (!touchMode) panel(W - 16 - 150, my - 26 * 3 - 4, 150, 26 * 3 + 2, 0.4);
    if (!touchMode) Object.keys(S.AMMO).reverse().forEach((k) => {
      my -= 26;
      const mx = W - 16 - 150;
      ctx.textAlign = 'left'; ctx.font = '13px sans-serif'; ctx.fillStyle = AMMO_COLOR[k];
      ctx.globalAlpha = me.am[k] ? 1 : 0.4;
      ctx.fillText(S.AMMO[k].name, mx + 10, my + 18);
      ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif'; ctx.fillText(me.am[k], mx + 140, my + 18);
      ctx.globalAlpha = 1;
    });

    // 줍기 안내
    let near = null, nd = (S.PLAYER_R + S.ITEM_R + 30) ** 2;
    for (const it of items) { const d = (it[2] - pred.x) ** 2 + (it[3] - pred.y) ** 2; if (d < nd) { nd = d; near = it; } }
    if (near) {
      const info = S.itemInfo(near[1]);
      const txt = `${touchMode ? '👆 탭해서 줍기:' : '[F]'} ${info.name}${near[4] > 1 ? ' ×' + near[4] : ''}`;
      ctx.font = `bold ${touchMode ? 18 : 16}px sans-serif`; ctx.textAlign = 'center';
      const tw = ctx.measureText(txt).width, bh = touchMode ? 44 : 30;
      panel(W / 2 - tw / 2 - 14, H / 2 + 90, tw + 28, bh, touchMode ? 0.65 : 0.45);
      ctx.fillStyle = '#fff'; ctx.fillText(txt, W / 2, H / 2 + 90 + bh / 2 + 6);
      hudButtons.push({ x: W / 2 - tw / 2 - 14, y: H / 2 + 90, w: tw + 28, h: bh, fn: () => action('pickup') });
    }
  }

  function drawMinimap() {
    const size = touchMode ? Math.min(150, W * 0.2) : Math.min(190, W * 0.22), mx = 14, my = touchMode ? 88 : H - size - 14;
    const k = size / S.MAP_SIZE;
    ctx.save();
    panel(mx - 4, my - 4, size + 8, size + 8, 0.55);
    ctx.beginPath(); ctx.rect(mx, my, size, size); ctx.clip();
    ctx.fillStyle = '#6f9a48'; ctx.fillRect(mx, my, size, size);
    ctx.fillStyle = 'rgba(70,50,30,0.8)';
    for (const b of world.bld) ctx.fillRect(mx + b.x * k, my + b.y * k, Math.max(2, b.w * k), Math.max(2, b.h * k));
    if (zone) {
      const [cx, cy, r, ncx, ncy, nr, stage] = zone;
      ctx.fillStyle = 'rgba(210,40,30,0.4)';
      ctx.beginPath(); ctx.rect(mx, my, size, size); ctx.arc(mx + cx * k, my + cy * k, Math.max(0, r * k), 0, Math.PI * 2, true); ctx.fill('evenodd');
      if (stage !== 2) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(mx + ncx * k, my + ncy * k, Math.max(0, nr * k), 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(mx + camX * k, my + camY * k, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  let bannerTimer = null;
  function showBanner(title, sub, ms) {
    $('bannerTitle').textContent = title; $('bannerSub').textContent = sub;
    $('banner').classList.remove('hidden');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => $('banner').classList.add('hidden'), ms);
  }
})();
