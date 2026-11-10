// 한 판(매치)을 돌리는 방. 서버가 모든 판정을 담당한다.
const S = require('../public/shared.js');
const { generate, lootBundle } = require('./mapgen');
const { botThink } = require('./bot');

const BOT_COUNT = process.env.BOTS !== undefined ? +process.env.BOTS : 24;
const LATE_JOIN = 40;      // 매치 시작 후 이 시간(초) 안에 들어오면 바로 참가
const END_DELAY = 7;       // 매치 종료 후 다음 판까지
const M = S.MAP_SIZE;
// [대기 시간, 줄어드는 시간, 목표 반지름, 초당 피해]
const ZONE_PHASES = [[45, 30, 1300, 1.5], [35, 25, 800, 3], [30, 20, 450, 5], [25, 20, 220, 8], [20, 15, 80, 12], [15, 15, 0, 20]];
const BOT_NAMES = ['감자총잡이', '숲속저격수', 'NoScope', '붕대장인', '치킨러버', '도토리', 'Ghost', '고양이', 'Pixel', '루키', '레드존', '탱크', '번개', 'Mango', 'Viper', '나무뒤', '판다', 'Nova', '하루', 'Blitz', '짱돌', 'Kiwi', '조약돌', 'Echo', '여우', 'Sparrow', '호랑이', 'Comet', '우주인', 'Duck'];
const AMMO_KEYS = Object.keys(S.AMMO);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

class Room {
  constructor(id) {
    this.id = id;
    this.clients = new Set();
    this.matchId = 0;
    this.newMatch();
    this.timer = setInterval(() => this.tick(), 1000 / S.TICK_RATE);
  }

  destroy() { clearInterval(this.timer); }

  // ---------------- 매치 관리 ----------------
  newMatch() {
    this.matchId++;
    const m = generate((Math.random() * 2 ** 31) | 0);
    this.rng = Math.random;
    this.obstacles = m.obstacles;
    this.obsById = new Map(this.obstacles.map((o) => [o.id, o]));
    this.buildings = m.buildings;
    this.grid = new S.Grid(M, 128);
    for (const o of this.obstacles) this.grid.insert(o);
    this.items = new Map(); this.nextItem = 1;
    for (const l of m.loot) this.spawnItem(l.type, l.x, l.y);
    this.players = new Map(); this.nextPid = 1;
    this.clientByPid = new Map();
    this.bullets = []; this.nextBullet = 1;
    this.time = 0; this.state = 'play'; this.endT = 0; this.noHumanT = 0;
    this.zone = { cx: M / 2, cy: M / 2, r: M * 0.75, phase: 0, stage: 'wait', t: ZONE_PHASES[0][0], total: ZONE_PHASES[0][0] };
    this.nextZone(ZONE_PHASES[0][2]);
    this.obsUpdates = new Map(); this.globalEv = []; this.newBullets = []; this.endedBullets = [];
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    for (let i = 0; i < BOT_COUNT; i++) this.addPlayer(names[i % names.length], true);
    for (const c of this.clients) this.joinMatch(c);
    for (const c of this.clients) this.sendInit(c);
    this.rosterDirty = false;
  }

  nextZone(nr) {
    const z = this.zone;
    const maxOff = Math.max(0, z.r - nr) * 0.85;
    const a = Math.random() * Math.PI * 2, off = Math.random() * maxOff;
    z.nr = nr;
    z.ncx = Math.max(nr * 0.5, Math.min(M - nr * 0.5, z.cx + Math.cos(a) * off));
    z.ncy = Math.max(nr * 0.5, Math.min(M - nr * 0.5, z.cy + Math.sin(a) * off));
  }

  findSpawn() {
    for (let i = 0; i < 300; i++) {
      const p = { x: 100 + Math.random() * (M - 200), y: 100 + Math.random() * (M - 200) };
      if (this.buildings.some((b) => p.x > b.x - 40 && p.x < b.x + b.w + 40 && p.y > b.y - 40 && p.y < b.y + b.h + 40)) continue;
      const near = this.grid.query(p.x, p.y, 60).some((o) => !o.dead && o.solid && S.pushOut({ x: p.x, y: p.y }, S.PLAYER_R + 6, o));
      if (near) continue;
      let ok = true;
      for (const q of this.players.values()) if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 < 320 * 320) { ok = false; break; }
      if (ok || i > 250) return p;
    }
    return { x: M / 2, y: M / 2 };
  }

  addPlayer(name, isBot) {
    const sp = this.findSpawn();
    const p = {
      id: this.nextPid++, name, isBot, x: sp.x, y: sp.y, angle: 0, hp: 100, boost: 0, alive: true, kills: 0,
      keys: 0, shoot: false, clicks: 0, pendingClicks: 0, queue: [], credit: 0, lastSeq: 0,
      guns: [null, null], cur: 2, lastCur: 2, ammo: { '9mm': 0, '12g': 0, '762': 0 }, meds: { bandage: 0, medkit: 0, soda: 0 },
      helmet: 0, vest: 0, scope: 1, scopes: [1], cd: 0, reload: 0, reloadTotal: 0, action: null, hurtT: 0, punchT: 0,
      placement: 0,
    };
    this.players.set(p.id, p);
    this.rosterDirty = true;
    return p;
  }

  joinMatch(c) {
    c.spec = null;
    if (this.state === 'play' && this.time < LATE_JOIN) {
      const p = this.addPlayer(c.name, false);
      if (process.env.DEBUG_LOADOUT) { // 테스트용: 시작부터 총 지급
        p.guns = [{ type: 'ak47', mag: 30 }, { type: 'm870', mag: 5 }]; p.cur = 0;
        p.ammo = { '9mm': 60, '12g': 20, '762': 90 }; p.meds.bandage = 5; p.meds.medkit = 1; p.helmet = 2; p.vest = 1; p.scopes = [1, 4]; p.scope = 4;
      }
      c.pid = p.id;
      this.clientByPid.set(p.id, c);
    } else {
      c.pid = null;
      c.spec = this.randomAlive();
    }
  }

  addClient(c) {
    this.clients.add(c);
    this.joinMatch(c);
    this.sendInit(c);
  }

  removeClient(c) {
    this.clients.delete(c);
    if (c.pid) {
      const p = this.players.get(c.pid);
      if (p && p.alive) this.kill(p, null, '접속 종료');
      this.clientByPid.delete(c.pid);
    }
  }

  randomAlive(prefer) {
    if (prefer && this.players.get(prefer) && this.players.get(prefer).alive) return prefer;
    const alive = [...this.players.values()].filter((p) => p.alive);
    const humans = alive.filter((p) => !p.isBot);
    const pool = humans.length ? humans : alive;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)].id : null;
  }

  sendInit(c) {
    send(c, {
      t: 'init', id: c.pid, match: this.matchId, size: M, spec: c.spec,
      obs: this.obstacles.map((o) => [o.id, S.OBST_KINDS.indexOf(o.kind), r1(o.x), r1(o.y),
        o.shape === 'c' ? r1(o.cr) : o.w, o.shape === 'c' ? r1(o.vr || 0) : o.h, o.dead ? 0 : (o.hp === Infinity ? 1 : r2(o.hp / o.maxHp))]),
      bld: this.buildings.map((b) => [b.x, b.y, b.w, b.h, b.color]),
      roster: this.roster(),
    });
  }

  roster() { return [...this.players.values()].map((p) => [p.id, p.name, p.isBot ? 1 : 0]); }

  // ---------------- 메시지 처리 ----------------
  onMessage(c, m) {
    if (m.t === 'p') return send(c, { t: 'P', v: m.v });
    if (m.t === 'spec') {
      const alive = [...this.players.values()].filter((p) => p.alive);
      if (!alive.length) return;
      const i = alive.findIndex((p) => p.id === c.spec);
      c.spec = alive[(i + 1) % alive.length].id;
      return;
    }
    const p = c.pid && this.players.get(c.pid);
    if (!p || !p.alive || this.state !== 'play') return;
    if (m.t === 'i') {
      if (!Number.isInteger(m.s) || !Number.isFinite(m.a)) return;
      if (p.queue.length < 30) p.queue.push({ s: m.s, k: (m.k | 0) & 15, a: m.a, f: !!m.f, c: m.c | 0 });
    } else if (m.t === 'a') {
      switch (m.a) {
        case 'pickup': this.tryPickup(p); break;
        case 'reload': this.startReload(p); break;
        case 'slot': this.switchSlot(p, m.v | 0); break;
        case 'swap': this.switchSlot(p, p.lastCur); break;
        case 'use': this.useItem(p, String(m.v)); break;
        case 'cancel': p.action = null; break;
      }
    }
  }

  // ---------------- 메인 루프 ----------------
  tick() {
    if (this.clients.size === 0) return;
    const dt = S.DT;
    this.time += dt;
    if (this.state === 'ended') {
      this.endT -= dt;
      this.updateBullets(dt);
      if (this.endT <= 0) return this.newMatch();
      return this.broadcast();
    }

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.isBot) {
        botThink(p, this, dt);
        S.moveStep(p, p.keys, dt, S.speedMul(p.action, p.boost), this.grid);
      } else {
        p.credit = Math.min(p.credit + 1, 5);
        if (p.queue.length > 12) { // 렉으로 밀린 입력은 버린다
          const dropped = p.queue.splice(0, p.queue.length - 4);
          p.lastSeq = dropped[dropped.length - 1].s;
        }
        let steps = 0;
        while (p.queue.length && p.credit >= 1 && steps < 3) {
          const inp = p.queue.shift();
          p.credit--; steps++;
          p.keys = inp.k; p.angle = inp.a; p.shoot = inp.f;
          if (inp.c !== p.clicks) { p.pendingClicks = Math.min(1, p.pendingClicks + 1); p.clicks = inp.c; }
          S.moveStep(p, inp.k, dt, S.speedMul(p.action, p.boost), this.grid);
          p.lastSeq = inp.s;
        }
      }
      this.updatePlayer(p, dt);
    }
    this.updateBullets(dt);
    this.updateZone(dt);
    this.checkEnd(dt);
    this.broadcast();
  }

  curGun(p) { return p.cur < 2 ? p.guns[p.cur] : null; }

  updatePlayer(p, dt) {
    p.hurtT = Math.max(0, p.hurtT - dt);
    p.punchT = Math.max(0, p.punchT - dt);
    p.cd -= dt;
    if (p.boost > 0) {
      p.hp = Math.min(100, p.hp + (p.boost >= 50 ? 2 : 1) * dt);
      p.boost = Math.max(0, p.boost - 1.2 * dt);
    }
    if (p.reload > 0) {
      p.reload -= dt;
      if (p.reload <= 0) {
        p.reload = 0;
        const g = this.curGun(p);
        if (g) {
          const w = S.WEAPONS[g.type];
          const take = Math.min(w.mag - g.mag, p.ammo[w.ammo]);
          g.mag += take; p.ammo[w.ammo] -= take;
        }
      }
    }
    if (p.action) {
      p.action.t -= dt;
      if (p.action.t <= 0) {
        const a = p.action.type;
        if (a === 'bandage') p.hp = Math.min(100, p.hp + 15);
        else if (a === 'medkit') p.hp = 100;
        else if (a === 'soda') p.boost = Math.min(100, p.boost + 25);
        p.meds[a]--;
        p.action = null;
      }
    }

    // 사격
    const g = this.curGun(p);
    const w = g ? S.WEAPONS[g.type] : S.WEAPONS.fists;
    const trigger = w.melee || w.auto ? p.shoot : p.pendingClicks > 0;
    if (trigger) {
      if (p.action) p.action = null;
      if (p.cd <= 0) {
        if (w.melee) { this.punch(p); p.cd = w.cd; }
        else if (p.reload <= 0) {
          if (g.mag > 0) {
            this.fire(p, g);
            g.mag--; p.cd = w.cd;
            if (g.mag === 0) this.startReload(p);
          } else this.startReload(p);
        }
        p.pendingClicks = 0;
      }
    }

    this.autoPickup(p);

    // 자기장 피해
    const z = this.zone;
    if ((p.x - z.cx) ** 2 + (p.y - z.cy) ** 2 > z.r * z.r) {
      const dps = ZONE_PHASES[Math.min(z.phase, ZONE_PHASES.length - 1)][3];
      this.damage(p, dps * dt, null, '자기장', true);
    }
  }

  fire(p, g) {
    const w = S.WEAPONS[g.type];
    const moving = p.keys !== 0;
    for (let k = 0; k < w.pellets; k++) {
      const a = p.angle + (Math.random() * 2 - 1) * w.spread * (moving ? 1.4 : 1);
      const b = {
        id: this.nextBullet++, owner: p.id, x: p.x, y: p.y, ox: p.x, oy: p.y, dx: Math.cos(a), dy: Math.sin(a), a,
        speed: w.speed, dist: 0, max: w.range * (0.92 + Math.random() * 0.08), dmg: w.dmg, wname: w.name,
        falloff: w.pellets > 1 ? 0.65 : 0.25, ammo: w.ammo, len: w.len, tm: Date.now(),
      };
      this.bullets.push(b);
      this.newBullets.push(b);
    }
  }

  punch(p) {
    p.punchT = 0.22;
    const hx = p.x + Math.cos(p.angle) * (S.PLAYER_R + 16), hy = p.y + Math.sin(p.angle) * (S.PLAYER_R + 16);
    for (const q of this.players.values()) {
      if (q === p || !q.alive) continue;
      if ((q.x - hx) ** 2 + (q.y - hy) ** 2 < (S.PLAYER_R + 20) ** 2) this.damage(q, S.WEAPONS.fists.dmg, p, '주먹');
    }
    for (const o of this.grid.query(hx, hy, 24)) {
      if (o.dead || !o.blocksShots) continue;
      if (S.pushOut({ x: hx, y: hy }, 18, o)) this.hitObstacle(o, S.WEAPONS.fists.dmg, p);
    }
  }

  updateBullets(dt) {
    const keep = [];
    for (const b of this.bullets) {
      const step = Math.min(b.speed * dt, b.max - b.dist);
      let bestT = -1, hitP = null;
      for (const q of this.players.values()) {
        if (!q.alive || q.id === b.owner) continue;
        if (Math.abs(q.x - b.x) > step + 40 || Math.abs(q.y - b.y) > step + 40) continue;
        const t = S.segCircle(b.x, b.y, b.dx, b.dy, step, q.x, q.y, S.PLAYER_R);
        if (t >= 0 && (bestT < 0 || t < bestT)) { bestT = t; hitP = q; }
      }
      const ro = S.rayObstacles(this.grid, b.x, b.y, b.dx, b.dy, step);
      let hitO = null;
      if (ro.t >= 0 && (bestT < 0 || ro.t < bestT)) { bestT = ro.t; hitO = ro.o; hitP = null; }
      if (bestT >= 0) {
        b.dist += bestT;
        const dmg = b.dmg * (1 - b.falloff * (b.dist / b.max));
        if (hitP) this.damage(hitP, dmg, this.players.get(b.owner), b.wname);
        if (hitO) this.hitObstacle(hitO, dmg, this.players.get(b.owner));
        this.endedBullets.push(b);
        continue;
      }
      b.x += b.dx * step; b.y += b.dy * step; b.dist += step;
      if (b.dist < b.max - 0.01) keep.push(b);
    }
    this.bullets = keep;
  }

  damage(t, dmg, attacker, cause, ignoreArmor) {
    if (!t.alive || this.state !== 'play') return;
    if (!ignoreArmor) dmg *= 1 - (S.HELMET[t.helmet] + S.VEST[t.vest]);
    t.hp -= dmg;
    if (!ignoreArmor) t.hurtT = 0.15;
    if (t.hp <= 0) this.kill(t, attacker, cause);
  }

  kill(p, killer, cause) {
    if (!p.alive) return;
    p.alive = false; p.hp = 0; p.action = null; p.reload = 0;
    const aliveCount = [...this.players.values()].filter((q) => q.alive).length;
    p.placement = aliveCount + 1;
    if (killer && killer !== p) killer.kills++;
    this.dropAll(p);
    this.globalEv.push({ k: [killer && killer !== p ? killer.name : null, p.name, cause, killer ? killer.id : 0, p.id] });
    const c = this.clientByPid.get(p.id);
    const nextSpec = this.randomAlive(killer && killer.alive ? killer.id : null);
    if (c) {
      send(c, { t: 'dead', place: p.placement, kills: p.kills, killer: killer && killer !== p ? killer.name : null, cause });
      c.spec = nextSpec;
    }
    for (const cc of this.clients) if (cc.spec === p.id) cc.spec = nextSpec;
  }

  dropAll(p) {
    const drops = [];
    for (const g of p.guns) if (g) drops.push(['g:' + g.type, 1, g.mag]);
    for (const k of AMMO_KEYS) if (p.ammo[k] > 0) drops.push(['a:' + k, p.ammo[k]]);
    for (const k in p.meds) if (p.meds[k] > 0) drops.push(['m:' + k, p.meds[k]]);
    if (p.helmet) drops.push(['h:' + p.helmet, 1]);
    if (p.vest) drops.push(['v:' + p.vest, 1]);
    for (const s of p.scopes) if (s > 1) drops.push(['s:' + s, 1]);
    drops.forEach((d, i) => {
      const a = (i / drops.length) * Math.PI * 2, r = drops.length > 1 ? 36 : 0;
      this.spawnItem(d[0], p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, d[1], d[2]);
    });
    p.guns = [null, null]; p.ammo = { '9mm': 0, '12g': 0, '762': 0 }; p.meds = { bandage: 0, medkit: 0, soda: 0 };
    p.helmet = 0; p.vest = 0; p.scopes = [1];
  }

  hitObstacle(o, dmg, attacker) {
    if (o.dead || o.hp === Infinity) return;
    o.hp -= dmg;
    if (o.hp <= 0) {
      o.dead = true;
      this.obsUpdates.set(o.id, 0);
      const cx = o.shape === 'c' ? o.x : o.x + o.w / 2, cy = o.shape === 'c' ? o.y : o.y + o.h / 2;
      if (o.kind === 'crate') {
        const n = 1 + (Math.random() < 0.6 ? 1 : 0);
        for (let i = 0; i < n; i++) for (const t of lootBundle(Math.random)) this.spawnItem(t, cx + (Math.random() - 0.5) * 40, cy + (Math.random() - 0.5) * 40);
      }
      if (o.kind === 'barrel') this.explode(cx, cy, attacker);
    } else this.obsUpdates.set(o.id, r2(o.hp / o.maxHp));
  }

  explode(x, y, attacker) {
    const R = 150;
    this.globalEv.push({ ex: [r1(x), r1(y)] });
    for (const q of this.players.values()) {
      if (!q.alive) continue;
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < R) this.damage(q, 85 * (1 - d / R), attacker, '폭발');
    }
    for (const o of this.grid.query(x, y, R)) {
      if (o.dead) continue;
      const ox = o.shape === 'c' ? o.x : o.x + o.w / 2, oy = o.shape === 'c' ? o.y : o.y + o.h / 2;
      const d = Math.hypot(ox - x, oy - y);
      if (d < R) this.hitObstacle(o, 140 * (1 - d / R), attacker);
    }
  }

  // ---------------- 아이템 ----------------
  spawnItem(type, x, y, count, mag) {
    const info = S.itemInfo(type);
    if (count === undefined) count = info.kind === 'ammo' ? S.AMMO[info.sub].pack : info.kind === 'med' ? S.MEDS[info.sub].stack : 1;
    if (info.kind === 'gun' && mag === undefined) mag = S.WEAPONS[info.sub].mag;
    const it = { id: this.nextItem++, type, x: Math.max(20, Math.min(M - 20, x)), y: Math.max(20, Math.min(M - 20, y)), count, mag };
    this.items.set(it.id, it);
    this.itemsDirty = true;
    return it;
  }

  // 아이템을 먹을 수 있으면 먹고 true. manual: F키로 줍는 경우(총 교체 허용)
  takeItem(p, it, manual) {
    const info = S.itemInfo(it.type);
    switch (info.kind) {
      case 'ammo': {
        const space = S.AMMO[info.sub].max - p.ammo[info.sub];
        if (space <= 0) return false;
        const take = Math.min(space, it.count);
        p.ammo[info.sub] += take; it.count -= take;
        if (it.count <= 0) this.items.delete(it.id); this.itemsDirty = true;
        return true;
      }
      case 'med': {
        const space = S.MEDS[info.sub].max - p.meds[info.sub];
        if (space <= 0) return false;
        const take = Math.min(space, it.count);
        p.meds[info.sub] += take; it.count -= take;
        if (it.count <= 0) this.items.delete(it.id); this.itemsDirty = true;
        return true;
      }
      case 'helmet': case 'vest': {
        if (info.sub <= p[info.kind]) return false;
        if (p[info.kind]) this.spawnItem((info.kind === 'helmet' ? 'h:' : 'v:') + p[info.kind], p.x, p.y + 30);
        p[info.kind] = info.sub;
        this.items.delete(it.id); this.itemsDirty = true;
        return true;
      }
      case 'scope': {
        if (p.scopes.includes(info.sub)) return false;
        p.scopes.push(info.sub);
        p.scope = Math.max(...p.scopes);
        this.items.delete(it.id); this.itemsDirty = true;
        return true;
      }
      case 'gun': {
        let slot = p.guns[0] === null ? 0 : p.guns[1] === null ? 1 : -1;
        if (slot < 0) {
          if (!manual) return false;
          slot = p.cur < 2 ? p.cur : 0;
          const old = p.guns[slot];
          if (old.type === info.sub) return false;
          this.spawnItem('g:' + old.type, p.x, p.y + 30, 1, old.mag);
          if (p.cur === slot) p.reload = 0;
        }
        p.guns[slot] = { type: info.sub, mag: it.mag };
        this.items.delete(it.id); this.itemsDirty = true;
        if (p.cur === 2 || p.cur === slot) { p.lastCur = p.cur; p.cur = slot; p.reload = 0; p.cd = Math.max(p.cd, 0.25); }
        return true;
      }
    }
    return false;
  }

  autoPickup(p) {
    const rr = (S.PLAYER_R + S.ITEM_R) ** 2;
    for (const it of this.items.values()) {
      if ((it.x - p.x) ** 2 + (it.y - p.y) ** 2 > rr) continue;
      this.takeItem(p, it, false);
    }
  }

  tryPickup(p) {
    let best = null, bd = (S.PLAYER_R + S.ITEM_R + 30) ** 2;
    for (const it of this.items.values()) {
      const d = (it.x - p.x) ** 2 + (it.y - p.y) ** 2;
      if (d < bd) { bd = d; best = it; }
    }
    if (best) this.takeItem(p, best, true);
  }

  startReload(p) {
    const g = this.curGun(p);
    if (!g || p.reload > 0) return;
    const w = S.WEAPONS[g.type];
    if (g.mag >= w.mag || p.ammo[w.ammo] <= 0) return;
    p.action = null;
    p.reload = p.reloadTotal = w.reload;
  }

  switchSlot(p, slot) {
    if (slot < 0 || slot > 2 || slot === p.cur) return;
    if (slot < 2 && !p.guns[slot]) return;
    p.lastCur = p.cur; p.cur = slot; p.reload = 0;
    p.cd = Math.max(p.cd, 0.25);
    const g = this.curGun(p);
    if (g && g.mag === 0) this.startReload(p);
  }

  useItem(p, kind) {
    if (!S.MEDS[kind] || p.meds[kind] <= 0) return;
    if (kind !== 'soda' && p.hp >= 100) return;
    if (kind === 'bandage' && p.hp >= 100) return;
    if (kind === 'soda' && p.boost >= 100) return;
    if (p.action && p.action.type === kind) return;
    p.reload = 0;
    p.action = { type: kind, t: S.MEDS[kind].time, total: S.MEDS[kind].time };
  }

  // ---------------- 자기장 / 종료 ----------------
  updateZone(dt) {
    const z = this.zone;
    const ph = ZONE_PHASES[z.phase];
    if (!ph || z.stage === 'final') return;
    z.t -= dt;
    if (z.stage === 'wait') {
      if (z.t <= 0) { z.stage = 'shrink'; z.t = z.total = ph[1]; z.sr = z.r; z.scx = z.cx; z.scy = z.cy; }
    } else {
      const k = 1 - Math.max(0, z.t) / z.total;
      z.r = z.sr + (z.nr - z.sr) * k;
      z.cx = z.scx + (z.ncx - z.scx) * k;
      z.cy = z.scy + (z.ncy - z.scy) * k;
      if (z.t <= 0) {
        z.phase++;
        const nx = ZONE_PHASES[z.phase];
        if (nx) { z.stage = 'wait'; z.t = z.total = nx[0]; this.nextZone(nx[2]); }
        else { z.stage = 'final'; z.phase = ZONE_PHASES.length - 1; }
      }
    }
  }

  checkEnd(dt) {
    const all = [...this.players.values()];
    const alive = all.filter((p) => p.alive);
    const humansInMatch = all.some((p) => !p.isBot);
    const humansAlive = alive.some((p) => !p.isBot);
    if (humansInMatch && !humansAlive && alive.length > 1) this.noHumanT += dt; else this.noHumanT = 0;
    if (all.length < 2) return; // 혼자 있는 방(봇 0명)은 끝내지 않음
    if (alive.length <= 1 || this.noHumanT > 5) {
      this.state = 'ended';
      this.endT = END_DELAY;
      const w = alive.length === 1 ? alive[0] : null;
      for (const c of this.clients) send(c, { t: 'end', winner: w ? w.name : null, wid: w ? w.id : 0, you: c.pid === (w && w.id) });
      this.broadcast();
    }
  }

  // ---------------- 전송 ----------------
  broadcast() {
    if (this.rosterDirty) {
      this.rosterDirty = false;
      const l = this.roster();
      for (const c of this.clients) send(c, { t: 'r', l });
    }
    const obs = [...this.obsUpdates.entries()];
    this.obsUpdates.clear();
    const z = this.zone;
    const zone = [r1(z.cx), r1(z.cy), r1(z.r), r1(z.ncx), r1(z.ncy), r1(z.nr), z.stage === 'wait' ? 0 : z.stage === 'shrink' ? 1 : 2, r1(Math.max(0, z.t))];
    const aliveCount = [...this.players.values()].filter((p) => p.alive).length;
    const tm = Date.now();
    this.bcount = (this.bcount || 0) + 1;
    this.sendItems = this.bcount % 3 === 0 || this.itemsDirty;
    this.itemsDirty = false;

    for (const c of this.clients) {
      const me = c.pid ? this.players.get(c.pid) : null;
      const focus = me && me.alive ? me : (c.spec && this.players.get(c.spec)) || me || { x: M / 2, y: M / 2, scope: 1 };
      const hw = S.VIEW_W * S.SCOPE_ZOOM[focus.scope || 1] * 0.62;
      const inView = (x, y, pad) => Math.abs(x - focus.x) < hw + pad && Math.abs(y - focus.y) < hw + pad;
      const ps = [];
      for (const p of this.players.values()) {
        if (!p.alive || !inView(p.x, p.y, 40)) continue;
        const g = this.curGun(p);
        const flags = (p.hurtT > 0 ? 1 : 0) | (p.punchT > 0 ? 2 : 0) | (p.action ? 4 : 0) | (p.reload > 0 ? 8 : 0);
        ps.push([p.id, r1(p.x), r1(p.y), Math.round(p.angle * 1000) / 1000, g ? g.type : 'fists', p.helmet, p.vest, flags]);
      }
      let its = null;
      if (this.sendItems) { // 아이템 목록은 1초에 10번만 보냄 (대역폭 절약)
        its = [];
        for (const it of this.items.values()) if (inView(it.x, it.y, 30)) its.push([it.id, it.type, Math.round(it.x), Math.round(it.y), it.count]);
      }
      const nb = [], eb = [];
      for (const b of this.newBullets) if (inView(b.ox, b.oy, b.max)) nb.push([b.id, r1(b.ox), r1(b.oy), Math.round(b.a * 1000) / 1000, b.speed, Math.round(b.max), b.ammo, b.len, b.owner, b.tm]);
      for (const b of this.endedBullets) if (inView(b.ox, b.oy, b.max)) eb.push([b.id, Math.round(b.dist)]);
      const msg = { t: 's', tm, ps, z: zone, al: aliveCount };
      if (its) msg.it = its;
      if (nb.length) msg.nb = nb;
      if (eb.length) msg.eb = eb;
      if (obs.length) msg.ob = obs;
      if (this.globalEv.length) msg.ev = this.globalEv;
      if (me && me.alive) {
        const g = this.curGun(me);
        msg.ls = me.lastSeq;
        msg.me = {
          x: r1(me.x), y: r1(me.y), hp: r1(me.hp), bo: r1(me.boost), cur: me.cur,
          g: me.guns.map((g) => (g ? [g.type, g.mag] : null)), am: me.ammo, md: me.meds,
          he: me.helmet, ve: me.vest, sc: me.scope, k: me.kills,
          rl: me.reload > 0 ? [r2(me.reload), me.reloadTotal] : 0,
          ac: me.action ? [me.action.type, r2(me.action.t), me.action.total] : 0,
        };
      } else msg.spec = focus.id || 0;
      send(c, msg);
    }
    this.globalEv = [];
    this.newBullets = [];
    this.endedBullets = [];
  }
}

function send(c, obj) {
  if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj));
}

module.exports = { Room };
