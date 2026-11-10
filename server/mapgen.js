// 맵 생성: 건물, 나무, 바위, 상자, 드럼통, 덤불, 바닥 아이템
const S = require('../public/shared.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOOT_TABLE = [
  ['g:m9', 14], ['g:mp5', 10], ['g:m870', 9], ['g:ak47', 7], ['g:mosin', 3],
  ['a:9mm', 10], ['a:12g', 6], ['a:762', 8],
  ['m:bandage', 14], ['m:medkit', 4], ['m:soda', 6],
  ['h:1', 6], ['h:2', 3], ['h:3', 1],
  ['v:1', 6], ['v:2', 3], ['v:3', 1],
  ['s:2', 5], ['s:4', 2], ['s:8', 1],
];
const LOOT_TOTAL = LOOT_TABLE.reduce((a, b) => a + b[1], 0);

function rollLoot(rng) {
  let r = rng() * LOOT_TOTAL;
  for (const [type, w] of LOOT_TABLE) { if ((r -= w) < 0) return type; }
  return 'm:bandage';
}

// 아이템 묶음(총이면 탄약도 같이)
function lootBundle(rng) {
  const t = rollLoot(rng);
  const out = [t];
  if (t.startsWith('g:')) {
    const ammo = S.WEAPONS[t.slice(2)].ammo;
    out.push('a:' + ammo, 'a:' + ammo);
  }
  return out;
}

function generate(seed) {
  const rng = mulberry32(seed);
  const M = S.MAP_SIZE;
  const obstacles = [];
  const buildings = [];
  const loot = []; // {type, x, y}
  let oid = 1;

  const overlapsBuilding = (x, y, pad) =>
    buildings.some((b) => x > b.x - pad && x < b.x + b.w + pad && y > b.y - pad && y < b.y + b.h + pad);

  // 건물
  for (let tries = 0; buildings.length < 9 && tries < 400; tries++) {
    const w = 300 + Math.floor(rng() * 140), h = 240 + Math.floor(rng() * 120);
    const x = 200 + rng() * (M - 400 - w), y = 200 + rng() * (M - 400 - h);
    if (buildings.some((b) => x < b.x + b.w + 160 && x + w + 160 > b.x && y < b.y + b.h + 160 && y + h + 160 > b.y)) continue;
    const b = { id: buildings.length, x: Math.round(x), y: Math.round(y), w, h, color: ['#8a6b4a', '#7b7f86', '#9a5b4b', '#6f7d5c'][Math.floor(rng() * 4)] };
    buildings.push(b);
    const T = 16, DOOR = 92;
    const sides = ['n', 's', 'w', 'e'];
    const doors = new Set([sides[Math.floor(rng() * 4)]]);
    if (rng() < 0.6) doors.add(sides[Math.floor(rng() * 4)]);
    const wall = (wx, wy, ww, wh) => {
      if (ww <= 0 || wh <= 0) return;
      obstacles.push({ id: oid++, kind: 'wall', shape: 'r', x: wx, y: wy, w: ww, h: wh, hp: Infinity, maxHp: Infinity, solid: true, blocksShots: true });
    };
    const hwall = (yy, door) => {
      if (!door) return wall(b.x, yy, b.w, T);
      const dx = b.x + 40 + Math.floor(rng() * (b.w - 80 - DOOR));
      wall(b.x, yy, dx - b.x, T); wall(dx + DOOR, yy, b.x + b.w - dx - DOOR, T);
    };
    const vwall = (xx, door) => {
      if (!door) return wall(xx, b.y + T, T, b.h - 2 * T);
      const dy = b.y + T + 30 + Math.floor(rng() * (b.h - 2 * T - 60 - DOOR));
      wall(xx, b.y + T, T, dy - b.y - T); wall(xx, dy + DOOR, T, b.y + b.h - T - dy - DOOR);
    };
    hwall(b.y, doors.has('n')); hwall(b.y + b.h - T, doors.has('s'));
    vwall(b.x, doors.has('w')); vwall(b.x + b.w - T, doors.has('e'));
    // 실내 상자 1개 + 아이템
    obstacles.push(makeCrate(oid++, b.x + T + 10 + rng() * (b.w - 2 * T - 80), b.y + T + 10 + rng() * (b.h - 2 * T - 80)));
    const n = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      for (const t of lootBundle(rng)) loot.push({ type: t, x: b.x + 50 + rng() * (b.w - 100), y: b.y + 50 + rng() * (b.h - 100) });
    }
  }

  function makeCrate(id, x, y) {
    return { id, kind: 'crate', shape: 'r', x: Math.round(x), y: Math.round(y), w: 64, h: 64, hp: 90, maxHp: 90, solid: true, blocksShots: true };
  }

  const placed = []; // 겹침 체크용 원
  const free = (x, y, r) => !overlapsBuilding(x, y, r + 30) && placed.every((p) => (p.x - x) ** 2 + (p.y - y) ** 2 > (p.r + r + 30) ** 2);
  function scatter(count, r, make) {
    for (let i = 0, tries = 0; i < count && tries < count * 30; tries++) {
      const x = 80 + rng() * (M - 160), y = 80 + rng() * (M - 160);
      if (!free(x, y, r)) continue;
      placed.push({ x, y, r });
      obstacles.push(make(x, y));
      i++;
    }
  }
  scatter(115, 30, (x, y) => ({ id: oid++, kind: 'tree', shape: 'c', x, y, cr: 22, vr: 52 + rng() * 14, hp: 180, maxHp: 180, solid: true, blocksShots: true }));
  scatter(55, 46, (x, y) => { const cr = 32 + rng() * 18; return { id: oid++, kind: 'rock', shape: 'c', x, y, cr, hp: 350, maxHp: 350, solid: true, blocksShots: true }; });
  scatter(60, 46, (x, y) => makeCrate(oid++, x - 32, y - 32));
  scatter(30, 30, (x, y) => ({ id: oid++, kind: 'barrel', shape: 'c', x, y, cr: 26, hp: 60, maxHp: 60, solid: true, blocksShots: true }));
  scatter(60, 46, (x, y) => ({ id: oid++, kind: 'bush', shape: 'c', x, y, cr: 46, hp: 80, maxHp: 80, solid: false, blocksShots: false }));

  // 바닥 아이템
  for (let i = 0, tries = 0; i < 110 && tries < 3000; tries++) {
    const x = 60 + rng() * (M - 120), y = 60 + rng() * (M - 120);
    if (overlapsBuilding(x, y, 20) || placed.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 < (p.r + 30) ** 2)) continue;
    for (const t of lootBundle(rng)) loot.push({ type: t, x: x + (rng() - 0.5) * 50, y: y + (rng() - 0.5) * 50 });
    i++;
  }

  return { obstacles, buildings, loot, rng };
}

module.exports = { generate, lootBundle, mulberry32 };
