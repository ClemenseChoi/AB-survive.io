// 서버에서 돌아가는 AI 봇. 사람 플레이어와 똑같은 입력(이동 키, 조준 각도, 사격)을 만들어 낸다.
const S = require('../public/shared.js');

const PREF_RANGE = { m870: 160, mosin: 520, m9: 300, mp5: 260, ak47: 360 };
const GUN_SCORE = { ak47: 5, mp5: 4, m870: 3.5, mosin: 3, m9: 2 };

function keysFromDir(dx, dy) {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return 0;
  const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  const K = S.KEY;
  switch (oct) {
    case 0: return K.RIGHT;
    case 1: return K.RIGHT | K.DOWN;
    case 2: return K.DOWN;
    case 3: return K.DOWN | K.LEFT;
    case 4: case -4: return K.LEFT;
    case -3: return K.LEFT | K.UP;
    case -2: return K.UP;
    case -1: return K.UP | K.RIGHT;
  }
  return 0;
}

function lineOfSight(room, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
  if (d < 1) return true;
  return S.rayObstacles(room.grid, a.x, a.y, dx / d, dy / d, d).t < 0;
}

function hasAmmo(p, g) { return g && (g.mag > 0 || p.ammo[S.WEAPONS[g.type].ammo] > 0); }

function wantsItem(p, it) {
  const info = S.itemInfo(it.type);
  switch (info.kind) {
    case 'gun': return (p.guns[0] === null || p.guns[1] === null) && !p.guns.some((g) => g && g.type === info.sub);
    case 'ammo': return p.guns.some((g) => g && S.WEAPONS[g.type].ammo === info.sub) && p.ammo[info.sub] < S.AMMO[info.sub].max * 0.8;
    case 'med': return p.meds[info.sub] < S.MEDS[info.sub].max;
    case 'helmet': return info.sub > p.helmet;
    case 'vest': return info.sub > p.vest;
    case 'scope': return !p.scopes.includes(info.sub);
  }
  return false;
}

function botThink(p, room, dt) {
  const ai = p.ai || (p.ai = {
    think: Math.random() * 0.3, target: null, seen: 0, strafe: Math.random() < 0.5 ? 1 : -1, strafeT: 0,
    wp: null, wpT: 0, loot: null, lootT: 0, ignore: new Set(), stuckT: 0, lx: p.x, ly: p.y, unstuckT: 0, ux: 0, uy: 0,
    aimErr: 0, aimErrT: 0, burstT: 0, skill: 0.4 + Math.random() * 0.45,
  });
  const z = room.zone;

  ai.think -= dt;
  if (ai.think <= 0) {
    ai.think = 0.25 + Math.random() * 0.1;
    // 적 찾기
    let best = null, bd = 520;
    for (const q of room.players.values()) {
      if (q === p || !q.alive) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd && lineOfSight(room, p, q)) { best = q; bd = d; }
    }
    // 총이 없으면 아주 가까운 적만 상대하고, 나머지는 파밍 우선
    const armed = p.guns.some((g) => hasAmmo(p, g));
    if (best && !armed && !(bd < 110 || (p.hurtT > 0 && bd < 250)) ) best = null;
    if (best) { if (ai.target !== best.id) { ai.target = best.id; ai.seen = 0; } }
    else { ai.target = null; ai.seen = 0; }

    // 아이템 찾기
    if (!ai.loot || !room.items.has(ai.loot) || ai.lootT > 7) {
      if (ai.loot && ai.lootT > 7) ai.ignore.add(ai.loot);
      ai.loot = null; ai.lootT = 0;
      let bl = 600;
      for (const it of room.items.values()) {
        if (ai.ignore.has(it.id)) continue;
        const d = Math.hypot(it.x - p.x, it.y - p.y);
        if (d < bl && wantsItem(p, it)) { bl = d; ai.loot = it.id; }
      }
    }

    // 무기 선택
    const target = ai.target && room.players.get(ai.target);
    let bestSlot = 2, bestScore = 0;
    p.guns.forEach((g, i) => {
      if (!hasAmmo(p, g)) return;
      let s = GUN_SCORE[g.type];
      if (target) {
        const d = Math.hypot(target.x - p.x, target.y - p.y);
        if (g.type === 'm870' && d < 220) s += 3;
        if (g.type === 'mosin' && d > 450) s += 3;
      }
      if (s > bestScore) { bestScore = s; bestSlot = i; }
    });
    if (bestSlot !== p.cur && p.reload <= 0) room.switchSlot(p, bestSlot);

    // 장전 / 회복
    const g = room.curGun(p);
    const threat = target ? Math.hypot(target.x - p.x, target.y - p.y) : Infinity;
    if (g && !target && g.mag < S.WEAPONS[g.type].mag) room.startReload(p);
    if (!p.action && p.reload <= 0 && threat > 420) {
      if (p.hp < 40 && p.meds.medkit > 0) room.useItem(p, 'medkit');
      else if (p.hp < 70 && p.meds.bandage > 0) room.useItem(p, 'bandage');
      else if (p.boost < 40 && p.meds.soda > 0 && p.hp < 90) room.useItem(p, 'soda');
    }
  }

  let mx = 0, my = 0;
  p.shoot = false;
  const target = ai.target && room.players.get(ai.target);
  if (target && !target.alive) ai.target = null;

  if (target && target.alive) {
    ai.seen += dt;
    const dx = target.x - p.x, dy = target.y - p.y, d = Math.hypot(dx, dy) || 1;
    ai.aimErrT -= dt;
    if (ai.aimErrT <= 0) { ai.aimErr = (Math.random() - 0.5) * 0.42 * (1.3 - ai.skill); ai.aimErrT = 0.35; }
    p.angle = Math.atan2(dy, dx) + ai.aimErr;
    const g = room.curGun(p);
    ai.strafeT -= dt;
    if (ai.strafeT <= 0) { ai.strafe *= -1; ai.strafeT = 0.6 + Math.random() * 1.2; }
    if (g) {
      const w = S.WEAPONS[g.type];
      const pref = PREF_RANGE[g.type];
      const ax = dx / d, ay = dy / d;
      const radial = d > pref + 80 ? 1 : d < pref - 80 ? -1 : 0;
      mx = ax * radial + -ay * ai.strafe * 0.8;
      my = ay * radial + ax * ai.strafe * 0.8;
      if (ai.seen > 0.8 - ai.skill * 0.3 && d < w.range * 0.9 && g.mag > 0 && p.reload <= 0) {
        if (w.auto) {
          ai.burstT -= dt;
          if (ai.burstT < -0.35) ai.burstT = 0.4 + Math.random() * 0.5;
          p.shoot = ai.burstT > 0;
        } else if (p.cd <= 0 && Math.random() < 0.5) p.pendingClicks = 1;
      }
    } else {
      // 맨손: 달려들기
      mx = dx / d + (-dy / d) * ai.strafe * 0.3; my = dy / d + (dx / d) * ai.strafe * 0.3;
      if (d < S.PLAYER_R * 2 + 26 && ai.seen > 0.3) p.shoot = true;
    }
    if (p.hp < 30 && d > 200 && g == null) { mx = -dx / d; my = -dy / d; }
  } else if (ai.loot && room.items.has(ai.loot)) {
    ai.lootT += dt;
    const it = room.items.get(ai.loot);
    mx = it.x - p.x; my = it.y - p.y;
  } else {
    ai.wpT -= dt;
    const zc = z.stage === 'final' ? { x: z.cx, y: z.cy, r: z.r } : { x: z.ncx, y: z.ncy, r: z.nr };
    if (!ai.wp || ai.wpT <= 0 || Math.hypot(ai.wp.x - p.x, ai.wp.y - p.y) < 40) {
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * Math.max(30, zc.r * 0.7);
      ai.wp = { x: zc.x + Math.cos(a) * rr, y: zc.y + Math.sin(a) * rr };
      ai.wpT = 8;
    }
    mx = ai.wp.x - p.x; my = ai.wp.y - p.y;
  }

  // 자기장: 다음 안전지대 밖이면 안으로
  const nr = z.stage === 'final' ? z.r : z.nr, ncx = z.stage === 'final' ? z.cx : z.ncx, ncy = z.stage === 'final' ? z.cy : z.ncy;
  const dz = Math.hypot(p.x - ncx, p.y - ncy);
  const dCur = Math.hypot(p.x - z.cx, p.y - z.cy);
  const urgent = dCur > z.r - 60 || (z.stage === 'shrink' && dz > nr * 0.9) || (z.stage === 'wait' && z.t < 15 && dz > nr * 0.9);
  if (urgent) {
    const tx = (ncx - p.x) / (dz || 1), ty = (ncy - p.y) / (dz || 1);
    const l = Math.hypot(mx, my) || 1;
    mx = tx * 1.5 + (mx / l) * 0.3; my = ty * 1.5 + (my / l) * 0.3;
  }

  // 끼임 탈출
  ai.stuckT += dt;
  if (ai.stuckT > 1) {
    const moved = Math.hypot(p.x - ai.lx, p.y - ai.ly);
    if (p.keys && moved < 30) { ai.unstuckT = 0.6 + Math.random() * 0.5; const a = Math.random() * Math.PI * 2; ai.ux = Math.cos(a); ai.uy = Math.sin(a); }
    ai.stuckT = 0; ai.lx = p.x; ai.ly = p.y;
  }
  if (ai.unstuckT > 0) { ai.unstuckT -= dt; mx = ai.ux; my = ai.uy; }

  const l = Math.hypot(mx, my);
  if (l > 0.01) { mx /= l; my /= l; }
  p.keys = keysFromDir(mx, my);
  if (!target && l > 0.01) p.angle = Math.atan2(my, mx);
}

module.exports = { botThink };
