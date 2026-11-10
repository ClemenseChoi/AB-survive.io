// 서버(Node.js)와 클라이언트(브라우저)가 함께 쓰는 게임 규칙/상수/충돌 코드
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAP_SIZE = 4800; // 맵 한 변 길이 (기존 3200 → 4800, 면적 2.25배)
  const PLAYER_R = 22;
  const BASE_SPEED = 250;
  const TICK_RATE = 30;
  const DT = 1 / TICK_RATE;
  const VIEW_W = 1400; // 1배율일 때 화면 가로에 보이는 월드 크기
  const ITEM_R = 24;

  const KEY = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8 };

  const WEAPONS = {
    fists: { name: '주먹', melee: true, dmg: 24, range: 34, cd: 0.32 },
    m9:    { name: 'M9',    ammo: '9mm', dmg: 12, cd: 0.14, spread: 0.025,  speed: 1700, range: 750,  mag: 15, reload: 1.5, auto: false, pellets: 1, len: 26 },
    mp5:   { name: 'MP5',   ammo: '9mm', dmg: 9,  cd: 0.075, spread: 0.05, speed: 1800, range: 650,  mag: 30, reload: 2.0, auto: true,  pellets: 1, len: 36 },
    m870:  { name: 'M870',  ammo: '12g', dmg: 11, cd: 0.85, spread: 0.14,  speed: 1500, range: 430,  mag: 5,  reload: 2.8, auto: false, pellets: 9, len: 44 },
    ak47:  { name: 'AK-47', ammo: '762', dmg: 14, cd: 0.1,  spread: 0.035,  speed: 2100, range: 950,  mag: 30, reload: 2.4, auto: true,  pellets: 1, len: 46 },
    mosin: { name: 'Mosin', ammo: '762', dmg: 72, cd: 1.5,  spread: 0.004, speed: 3000, range: 1600, mag: 5,  reload: 3.2, auto: false, pellets: 1, len: 56 },
  };
  const AMMO = {
    '9mm': { name: '9mm',     color: '#e8b54a', max: 150, pack: 30 },
    '12g': { name: '12게이지', color: '#d9443a', max: 40,  pack: 10 },
    '762': { name: '7.62mm',  color: '#4a86d9', max: 120, pack: 30 },
  };
  const MEDS = {
    bandage: { name: '붕대',       max: 15, time: 3, key: '7', stack: 5 },
    medkit:  { name: '구급상자',   max: 4,  time: 6, key: '8', stack: 1 },
    soda:    { name: '에너지 음료', max: 5,  time: 3, key: '9', stack: 1 },
  };
  const HELMET = [0, 0.075, 0.12, 0.165];
  const VEST = [0, 0.25, 0.38, 0.45];
  const SCOPE_ZOOM = { 1: 1, 2: 1.3, 4: 1.65, 8: 2.1 };
  const OBST_KINDS = ['tree', 'rock', 'crate', 'barrel', 'wall', 'bush'];

  // 아이템 타입 문자열: g:ak47 / a:9mm / m:bandage / h:2 / v:3 / s:4
  function itemInfo(type) {
    const [k, sub] = type.split(':');
    switch (k) {
      case 'g': return { kind: 'gun', sub, name: WEAPONS[sub].name, color: '#555' };
      case 'a': return { kind: 'ammo', sub, name: AMMO[sub].name, color: AMMO[sub].color };
      case 'm': return { kind: 'med', sub, name: MEDS[sub].name, color: sub === 'bandage' ? '#eee' : sub === 'medkit' ? '#e33' : '#3b6' };
      case 'h': return { kind: 'helmet', sub: +sub, name: `헬멧 Lv.${sub}`, color: ['', '#5a7d4a', '#3e5f86', '#222'][+sub] };
      case 'v': return { kind: 'vest', sub: +sub, name: `방탄복 Lv.${sub}`, color: ['', '#5a7d4a', '#3e5f86', '#222'][+sub] };
      case 's': return { kind: 'scope', sub: +sub, name: `${sub}배율 스코프`, color: '#ddd' };
    }
    return { kind: '?', sub, name: type, color: '#f0f' };
  }

  // ---------- 공간 분할 격자 ----------
  class Grid {
    constructor(size, cell) {
      this.cell = cell;
      this.n = Math.ceil(size / cell);
      this.cells = [];
      for (let i = 0; i < this.n * this.n; i++) this.cells.push([]);
      this.stamp = 0;
    }
    _range(x0, y0, x1, y1, fn) {
      const c = this.cell, n = this.n;
      const a = Math.max(0, Math.floor(x0 / c)), b = Math.min(n - 1, Math.floor(x1 / c));
      const d = Math.max(0, Math.floor(y0 / c)), e = Math.min(n - 1, Math.floor(y1 / c));
      for (let gy = d; gy <= e; gy++) for (let gx = a; gx <= b; gx++) fn(this.cells[gy * n + gx]);
    }
    insert(o) {
      const bb = bounds(o);
      this._range(bb[0], bb[1], bb[2], bb[3], (cell) => cell.push(o));
    }
    queryRect(x0, y0, x1, y1) {
      const s = ++this.stamp, out = [];
      this._range(x0, y0, x1, y1, (cell) => {
        for (const o of cell) if (o._s !== s) { o._s = s; out.push(o); }
      });
      return out;
    }
    query(x, y, r) { return this.queryRect(x - r, y - r, x + r, y + r); }
  }

  function bounds(o) {
    if (o.shape === 'c') return [o.x - o.cr, o.y - o.cr, o.x + o.cr, o.y + o.cr];
    return [o.x, o.y, o.x + o.w, o.y + o.h];
  }

  // 원(p, r)을 장애물 밖으로 밀어냄. 밀었으면 true
  function pushOut(p, r, o) {
    if (o.shape === 'c') {
      const dx = p.x - o.x, dy = p.y - o.y, rr = r + o.cr;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) return false;
      const d = Math.sqrt(d2) || 0.0001;
      p.x = o.x + (dx / d) * rr; p.y = o.y + (dy / d) * rr;
      return true;
    }
    const cx = Math.max(o.x, Math.min(p.x, o.x + o.w));
    const cy = Math.max(o.y, Math.min(p.y, o.y + o.h));
    let dx = p.x - cx, dy = p.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return false;
    if (d2 > 0.000001) {
      const d = Math.sqrt(d2);
      p.x = cx + (dx / d) * r; p.y = cy + (dy / d) * r;
    } else { // 중심이 사각형 안: 가장 가까운 변으로
      const l = p.x - o.x, rt = o.x + o.w - p.x, t = p.y - o.y, b = o.y + o.h - p.y;
      const m = Math.min(l, rt, t, b);
      if (m === l) p.x = o.x - r; else if (m === rt) p.x = o.x + o.w + r;
      else if (m === t) p.y = o.y - r; else p.y = o.y + o.h + r;
    }
    return true;
  }

  function resolve(p, r, grid) {
    for (let it = 0; it < 4; it++) {
      let moved = false;
      const cands = grid.query(p.x, p.y, r + 2);
      for (const o of cands) {
        if (o.dead || !o.solid) continue;
        if (pushOut(p, r, o)) moved = true;
      }
      if (!moved) break;
    }
    p.x = Math.max(r, Math.min(MAP_SIZE - r, p.x));
    p.y = Math.max(r, Math.min(MAP_SIZE - r, p.y));
  }

  function moveStep(p, keys, dt, speedMul, grid) {
    let dx = 0, dy = 0;
    if (keys & KEY.UP) dy -= 1;
    if (keys & KEY.DOWN) dy += 1;
    if (keys & KEY.LEFT) dx -= 1;
    if (keys & KEY.RIGHT) dx += 1;
    if (dx || dy) {
      const l = Math.hypot(dx, dy);
      const sp = (BASE_SPEED * speedMul * dt) / l;
      p.x += dx * sp; p.y += dy * sp;
    }
    resolve(p, PLAYER_R, grid);
  }

  // 플레이어 상태로 이동 속도 배율 계산 (서버/클라 동일해야 예측이 맞음)
  function speedMul(action, boost) {
    return (action ? 0.6 : 1) * (boost >= 50 ? 1.07 : 1);
  }

  // ---------- 광선 판정 ----------
  // (x0,y0)에서 단위벡터 (dx,dy) 방향으로 len 만큼. 맞으면 거리, 아니면 -1
  function segCircle(x0, y0, dx, dy, len, cx, cy, r) {
    const fx = x0 - cx, fy = y0 - cy;
    const c = fx * fx + fy * fy - r * r;
    if (c <= 0) return 0;
    const b = fx * dx + fy * dy;
    const disc = b * b - c;
    if (disc < 0) return -1;
    const t = -b - Math.sqrt(disc);
    return t >= 0 && t <= len ? t : -1;
  }
  function segRect(x0, y0, dx, dy, len, rx, ry, rw, rh) {
    let tmin = 0, tmax = len;
    if (Math.abs(dx) < 1e-9) { if (x0 < rx || x0 > rx + rw) return -1; }
    else {
      let t1 = (rx - x0) / dx, t2 = (rx + rw - x0) / dx;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
    if (Math.abs(dy) < 1e-9) { if (y0 < ry || y0 > ry + rh) return -1; }
    else {
      let t1 = (ry - y0) / dy, t2 = (ry + rh - y0) / dy;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
    return tmin;
  }
  function segObstacle(x0, y0, dx, dy, len, o) {
    return o.shape === 'c' ? segCircle(x0, y0, dx, dy, len, o.x, o.y, o.cr) : segRect(x0, y0, dx, dy, len, o.x, o.y, o.w, o.h);
  }
  // 장애물에 막히는 첫 지점 (bushes 등 통과 가능한 건 무시)
  function rayObstacles(grid, x0, y0, dx, dy, len, filter) {
    const x1 = x0 + dx * len, y1 = y0 + dy * len;
    const cands = grid.queryRect(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1));
    let best = -1, hit = null;
    for (const o of cands) {
      if (o.dead || !o.blocksShots) continue;
      if (filter && !filter(o)) continue;
      const t = segObstacle(x0, y0, dx, dy, len, o);
      if (t >= 0 && (best < 0 || t < best)) { best = t; hit = o; }
    }
    return { t: best, o: hit };
  }

  function angleDiff(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  return {
    MAP_SIZE, PLAYER_R, BASE_SPEED, TICK_RATE, DT, VIEW_W, ITEM_R, KEY,
    WEAPONS, AMMO, MEDS, HELMET, VEST, SCOPE_ZOOM, OBST_KINDS,
    itemInfo, Grid, bounds, pushOut, resolve, moveStep, speedMul,
    segCircle, segRect, segObstacle, rayObstacles, angleDiff,
  };
});
