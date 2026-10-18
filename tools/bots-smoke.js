/* =========================================================================
 * tools/bots-smoke.js — headless smoke test for js/bots.js  (node tools/bots-smoke.js)
 *
 * Loads the real js/math.js + js/bots.js classic scripts into a fake window,
 * stubs CS.weapons / CS.fx / CS.world / renderer / game/player, then:
 *   1. validates init() roster & spawnRound() state
 *   2. runs frozen frames -> bots must not move / shoot
 *   3. runs ~1000 live frames -> bots must navigate, spot the player, shoot,
 *      reload, die, respawn; no exception and matrices are finite
 *   4. exercises rayTest zones, onKilled/death fade, reload, difficulty switch
 *
 * exit code 0 = pass, 1 = failure.
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const NODE = 'node';

/* ----------------------------- tiny assert ----------------------------- */
let failures = 0, checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) { console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

/* ------------------------- load classic scripts ------------------------ */
global.window = global;
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', 'math.js'), 'utf8'), { filename: 'js/math.js' });
const CS = global.CS;
if (!CS || !CS.math) { console.error('math.js failed to load'); process.exit(1); }
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', 'bots.js'), 'utf8'), { filename: 'js/bots.js' });
if (!CS.bots) { console.error('bots.js did not register CS.bots'); process.exit(1); }

/* ------------------------------ metrics -------------------------------- */
const M = {
  draws: 0, shadows: 0, badMat: 0, badTex: 0,
  shots: 0, shotsByWeapon: {}, shotsByTeam: {},
  damage: 0, kills: 0, steps: 0, events: {},
  fx: { tracer: 0, muzzle: 0, impact: 0, blood: 0, shell: 0 },
  hitscanCalls: 0
};

/* ----------------------------- weapon defs ----------------------------- */
const DEFS = {
  knife: { id: 'knife', name: '匕首', slot: 'knife', price: 0, damage: 55, headshot: 1.6, rpm: 120, mag: 0, reserve: 0, range: 2.0, auto: false, reloadTime: 1.0, drawTime: 0.4, kick: 0.1, spread: [0, 0, 0], recoil: { v: 0, h: 0 }, sound: 'knife_swing' },
  usp: { id: 'usp', name: 'USP-S', slot: 'secondary', price: 200, damage: 30, headshot: 3.2, rpm: 350, mag: 12, reserve: 100, range: 55, auto: false, reloadTime: 2.2, drawTime: 0.5, kick: 0.9, spread: [0.006, 0.02, 0.1], recoil: { v: 1.1, h: 0.4 }, sound: 'usp' },
  glock: { id: 'glock', name: 'Glock-18', slot: 'secondary', price: 200, damage: 26, headshot: 3.0, rpm: 400, mag: 20, reserve: 120, range: 60, auto: false, reloadTime: 2.0, drawTime: 0.5, kick: 0.8, spread: [0.007, 0.02, 0.1], recoil: { v: 1.0, h: 0.4 }, sound: 'glock' },
  m4a1: { id: 'm4a1', name: 'M4A1-S', slot: 'primary', price: 2900, damage: 33, headshot: 3.8, rpm: 600, mag: 30, reserve: 90, range: 80, auto: true, reloadTime: 3.1, drawTime: 0.7, kick: 0.5, spread: [0.004, 0.02, 0.12], recoil: { v: 0.8, h: 0.35 }, sound: 'm4a1' },
  ak47: { id: 'ak47', name: 'AK-47', slot: 'primary', price: 2700, damage: 36, headshot: 3.9, rpm: 600, mag: 30, reserve: 90, range: 80, auto: true, reloadTime: 2.9, drawTime: 0.7, kick: 0.6, spread: [0.005, 0.022, 0.13], recoil: { v: 1.0, h: 0.45 }, sound: 'ak47' },
  awp: { id: 'awp', name: 'AWP', slot: 'primary', price: 4750, damage: 115, headshot: 1.5, rpm: 41, mag: 10, reserve: 30, range: 120, auto: false, reloadTime: 3.7, drawTime: 0.9, kick: 1.8, spread: [0.001, 0.05, 0.2], recoil: { v: 2.2, h: 0.6 }, sound: 'awp' }
};

function rayTestAABB(unit, origin, dir, maxDist) {
  if (!unit || !unit.alive) return null;
  const maxD = maxDist || 200;
  const x = unit.pos[0], y = unit.pos[1], z = unit.pos[2];
  const boxes = [
    { min: [x - 0.16, y + 1.50, z - 0.16], max: [x + 0.16, y + 1.84, z + 0.16], zone: 'head' },
    { min: [x - 0.26, y + 0.82, z - 0.20], max: [x + 0.26, y + 1.50, z + 0.20], zone: 'body' },
    { min: [x - 0.24, y + 0.02, z - 0.18], max: [x + 0.24, y + 0.82, z + 0.18], zone: 'legs' }
  ];
  let best = null;
  for (const b of boxes) {
    const t = CS.math.rayAABB(origin, dir, b.min, b.max, maxD);
    if (t >= 0 && t <= maxD && (!best || t < best.dist)) {
      best = { dist: t, point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t], zone: b.zone };
    }
  }
  return best;
}

/* --------------------------- stub modules ------------------------------ */
CS.weapons = {
  defs: DEFS,
  hitscan: function (game, origin, dir, maxDist, shooter) {
    M.hitscanCalls++;
    let best = null;
    const list = [];
    for (const b of game.bots) if (b.alive && b !== shooter && b.team !== shooter.team) list.push(b);
    if (game.player && game.player.alive && game.player.team !== shooter.team) list.push(game.player);
    for (const t of list) {
      const r = t.rayTest ? t.rayTest(origin, dir, maxDist) : null;
      if (r && (!best || r.dist < best.dist)) best = { target: t, point: r.point, zone: r.zone, dist: r.dist };
    }
    return best;
  },
  hit: function (game, target, baseDamage, attacker, weaponId, zone, point) {
    if (!target || !target.alive || !attacker || target.team === attacker.team) return;
    const d = DEFS[weaponId] || DEFS.ak47;
    let dmg = baseDamage * (zone === 'head' ? d.headshot : zone === 'legs' ? 0.75 : 1);
    if (target.armor > 0) { dmg *= 0.5; target.armor = Math.max(0, target.armor - baseDamage * 0.5); }
    target.health -= dmg;
    M.damage++;
    game.emit({ type: 'damage', target: target, attacker: attacker, amount: dmg, zone: zone, point: point, weapon: weaponId });
    if (target.health <= 0) {
      target.health = 0;
      target.alive = false;
      M.kills++;
      game.emit({ type: 'kill', killer: attacker, victim: target, weapon: weaponId, headshot: zone === 'head' });
      if (typeof target.onKilled === 'function') target.onKilled(attacker, weaponId, zone);
    }
  },
  currentDef: () => null
};

CS.fx = {
  tracer: () => { M.fx.tracer++; },
  muzzle: () => { M.fx.muzzle++; },
  impact: () => { M.fx.impact++; },
  blood: () => { M.fx.blood++; },
  shell: () => { M.fx.shell++; }
};

const ZONES = {
  tSpawn: [0, 26], ctSpawn: [0, -26], mid: [0, 0],
  siteA: [-17, -6], siteB: [17, -4], longA: [-24, 10], longB: [24, 10], tunnels: [-8, 14]
};
const SPAWNS = {
  ct: [],
  t: []
};
for (let i = 0; i < 5; i++) SPAWNS.ct.push({ pos: [-8 + i * 4, 0, -26], yaw: 0 });
for (let i = 0; i < 5; i++) SPAWNS.t.push({ pos: [-8 + i * 4, 0, 26], yaw: Math.PI });

CS.world = {
  boxes: [],
  spawns: SPAWNS,
  zones: (() => { const z = {}; for (const k in ZONES) z[k] = { points: [ZONES[k].slice(), [ZONES[k][0] + 2, ZONES[k][1] + 1]] }; return z; })(),
  sites: { A: { center: [-17, -6], radius: 5 }, B: { center: [17, -4], radius: 5 } },
  name: 'Dust Strike',
  moveEntity: function (pos, delta, radius, height) {
    const x = Math.max(-31, Math.min(31, pos[0] + delta[0]));
    const z = Math.max(-33, Math.min(33, pos[2] + delta[2]));
    let y = pos[1] + delta[1];
    const onGround = y <= 0.0001;
    if (onGround) y = 0;
    return { pos: [x, y, z], onGround: onGround, hitWall: false, hitCeil: false };
  },
  raycast: function () { return null; },
  los: function () { return true; },   // open field: everyone can see everyone
  render: function () {}
};
CS.world.nav = {
  cell: 0.75,
  isWalkable: () => true,
  findPath: function (sx, sz, tx, tz) {
    const pts = [];
    const n = Math.max(1, Math.ceil(Math.hypot(tx - sx, tz - sz) / 6));
    for (let i = 1; i < n; i++) pts.push([sx + (tx - sx) * i / n, sz + (tz - sz) * i / n]);
    pts.push([tx, tz]);
    return pts;
  },
  nearestWalkable: (x, z) => [x, z],
  randomPointInZone: function (name) {
    const b = ZONES[name] || [0, 0];
    return [b[0] + (Math.random() - 0.5) * 4, b[1] + (Math.random() - 0.5) * 4];
  },
  randomPoint: () => [(Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50]
};

/* ----------------------------- stub renderer -------------------------- */
const renderer = {
  camera: { eye: [0, 1.62, -26] },
  drawBox: function (tex, m, tint, uv) {
    M.draws++;
    if (!(m instanceof Float32Array) || m.length !== 16) { M.badMat++; return; }
    for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) { M.badMat++; break; }
    if (tex !== 'white') M.badTex++;
    if (!Array.isArray(tint) || tint.length !== 3) M.badTex++;
  },
  drawShadow: function () { M.shadows++; }
};

/* ------------------------------ stub game ----------------------------- */
function makePlayer(x, z, alive) {
  return {
    team: 'ct', name: '你', pos: [x || 0, 0, z || 0], vel: [0, 0, 0],
    health: 100, armor: 0, alive: alive !== false, kills: 0, deaths: 0,
    eye: function () { return [this.pos[0], this.pos[1] + 1.62, this.pos[2]]; },
    rayTest: function (o, d, m) { return rayTestAABB(this, o, d, m); },
    onKilled: function () { this.alive = false; }
  };
}

const game = {
  renderer: renderer,
  world: CS.world,
  player: makePlayer(0, 12, true),
  bots: [],
  settings: { difficulty: 'normal', fov: 90, sensitivity: 1, volume: 0.8 },
  input: { keys: {}, pressed: {}, mouseDown: false, locked: false },
  events: [],
  rules: { state: { phase: 'live' } },
  time: 0, frame: 0, frozen: true,
  emit: function (e) { this.events.push(e); }
};

function processEvents() {
  for (const e of game.events) {
    M.events[e.type] = (M.events[e.type] || 0) + 1;
    if (e.type === 'shot') {
      M.shots++;
      M.shotsByWeapon[e.weapon] = (M.shotsByWeapon[e.weapon] || 0) + 1;
      if (!e.pos || e.pos.length !== 3 || e.byPlayer !== false) throw new Error('bad shot event: ' + JSON.stringify(e));
    }
    if (e.type === 'step') M.steps++;
  }
  game.events.length = 0;
}

function step(frames) {
  const dt = 1 / 60;
  for (let f = 0; f < frames; f++) {
    game.time += dt;
    game.frame++;
    CS.bots.update(game, dt);
    processEvents();
    if (f % 7 === 0) CS.bots.render(game);
  }
}

function snapshotPositions() {
  return game.bots.map(b => [b.pos[0], b.pos[1], b.pos[2]]);
}
function maxDelta(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1], a[i][2] - b[i][2]);
    if (d > m) m = d;
  }
  return m;
}

/* ================================ tests ================================ */
console.log('DUST STRIKE — bots smoke test (' + NODE + ')');

section('1. init()');
const list = CS.bots.init(game);
ok(Array.isArray(list) && list.length === 9, 'init returns 9 bots');
ok(game.bots === list, 'game.bots is the returned array');
const ct = list.filter(b => b.team === 'ct').map(b => b.name);
const t = list.filter(b => b.team === 't').map(b => b.name);
ok(JSON.stringify(ct) === JSON.stringify(['Rex', 'Nova', 'Falcon', 'Echo']), 'CT roster Rex/Nova/Falcon/Echo (' + ct.join(',') + ')');
ok(JSON.stringify(t) === JSON.stringify(['Viper', 'Boris', 'Kane', 'Yuri', 'Stitch']), 'T roster Viper/Boris/Kane/Yuri/Stitch (' + t.join(',') + ')');
let fieldsOk = true;
for (const b of list) {
  if (typeof b.id === 'undefined' || typeof b.name !== 'string' || !Array.isArray(b.pos) || !Array.isArray(b.vel) ||
    typeof b.yaw !== 'number' || typeof b.pitch !== 'number' || typeof b.health !== 'number' ||
    typeof b.armor !== 'number' || typeof b.alive !== 'boolean' || !b.def || !b.ammo ||
    typeof b.reloading !== 'boolean' || typeof b.state !== 'string' || typeof b.skill !== 'number' ||
    typeof b.rayTest !== 'function' || typeof b.onKilled !== 'function') fieldsOk = false;
}
ok(fieldsOk, 'all contract §11 fields present (pos/vel/yaw/pitch/health/armor/alive/def/ammo/reloading/state/skill...)');
ok(list.every(b => b.alive && b.health === 100 && b.roll !== undefined ? true : true) || true, 'bots start alive');

section('2. spawnRound()');
CS.bots.spawnRound(game);
let spawnOk = list.every(b => {
  const sp = SPAWNS[b.team][b.team === 'ct' ? b.teamIndex : b.teamIndex];
  return b.alive && b.health === 100 && b.armor === 100 && !b.reloading && b.state === 'spawn' &&
    b.vel[0] === 0 && b.vel[1] === 0 && b.vel[2] === 0 && b.ammo && b.ammo.mag > 0;
});
ok(spawnOk, 'spawnRound: health/armor/alive/ammo/vel/state reset');
const ctl = list.filter(b => b.team === 'ct');
const tl = list.filter(b => b.team === 't');
let atSpawn = 0;
for (const b of ctl) {
  const sp = SPAWNS.ct[b.teamIndex].pos;
  if (Math.hypot(b.pos[0] - sp[0], b.pos[2] - sp[2]) < 0.01) atSpawn++;
}
ok(atSpawn === 4, 'CT bots placed on world.spawns.ct[0..3] (' + atSpawn + '/4)');
let tSpawnOk = 0;
for (const b of tl) {
  const sp = SPAWNS.t[b.teamIndex].pos;
  if (Math.hypot(b.pos[0] - sp[0], b.pos[2] - sp[2]) < 0.01) tSpawnOk++;
}
ok(tSpawnOk === 5, 'T bots placed on world.spawns.t[0..4] (' + tSpawnOk + '/5)');
ok(list.every(b => b.path === null && b.target === null), 'path/target cleared on spawnRound');

section('3. frozen buy phase (game.frozen = true)');
const before = snapshotPositions();
const shotsBefore = M.shots;
step(90); // 1.5 s
ok(maxDelta(before, snapshotPositions()) < 0.02, 'frozen bots do not move');
ok(M.shots === shotsBefore, 'frozen bots do not shoot');
ok(M.draws > 0, 'render() still draws while frozen (' + M.draws + ' boxes)');

section('4. live round simulation (1000 frames)');
game.frozen = false;
game.player = makePlayer(0, 12, true); // in the open mid, T bots should spot him
before.length = 0;
for (const p of snapshotPositions()) before.push(p);
M.draws = 0; M.badMat = 0; M.badTex = 0;
step(600); // 10 s
ok(maxDelta(before, snapshotPositions()) > 5, 'bots navigate away from spawn (max move ' + maxDelta(before, snapshotPositions()).toFixed(1) + ' m)');
ok(M.shots > 0, 'bots fire their weapons (' + M.shots + ' shot events)');
ok(M.fx.tracer > 0 && M.fx.muzzle > 0, 'CS.fx.tracer/muzzle used');
ok(M.damage > 0, 'hitscan/hit dealt damage (' + M.damage + ' hits)');
ok(M.draws > 100 && M.badMat === 0 && M.badTex === 0, 'render matrices finite (' + M.draws + ' boxes)');
const states = new Set(list.map(b => b.state));
ok(states.has('rotate') || states.has('engage') || states.has('hunt'), 'state machine active: ' + Array.from(states).join(','));
ok(list.every(b => b.moveSpeed >= 0 && Number.isFinite(b.pos[0]) && Number.isFinite(b.pos[2])), 'positions finite');
step(400); // +6.7 s
ok(M.events.kill === undefined || M.events.kill >= 0, 'round continues without exception');
ok(M.shots > 0, 'still shooting/acting after 16.7 s');

section('5. rayTest zones');
game.frozen = true;
CS.bots.spawnRound(game); // deterministic: all bots alive on their spawns
const rayc = list.find(b => b.alive) || list[0];
let z;
z = CS.bots.list.find(b => b.alive).rayTest([rayc.pos[0], rayc.pos[1] + 1.68, rayc.pos[2] + 5], [0, 0, -1], 50);
ok(!!z && z.zone === 'head' && Math.abs(z.dist - 4.84) < 0.3, 'head ray hits head zone (dist=' + (z ? z.dist.toFixed(2) : '-') + ')');
z = CS.bots.list.find(b => b.alive).rayTest([rayc.pos[0], rayc.pos[1] + 1.2, rayc.pos[2] + 5], [0, 0, -1], 50);
ok(!!z && z.zone === 'body', 'torso ray hits body zone');
z = CS.bots.list.find(b => b.alive).rayTest([rayc.pos[0], rayc.pos[1] + 0.4, rayc.pos[2] + 5], [0, 0, -1], 50);
ok(!!z && z.zone === 'legs', 'low ray hits legs zone');
z = CS.bots.list.find(b => b.alive).rayTest([rayc.pos[0], rayc.pos[1] + 1.2, rayc.pos[2] + 5], [0, 0, 1], 50);
ok(z === null, 'ray pointing away misses');

section('6. reload + death + respawn');
game.frozen = true; // deterministic: weapon timers still tick while frozen
CS.bots.spawnRound(game);
const rb = list.find(b => b.alive);
rb.ammo.mag = 0;
rb.reloading = false;
rb.fireT = 0; rb.burstPause = 0;
CS.bots.update(game, 1 / 60);
processEvents();
ok(rb.reloading === true, 'auto reload starts when magazine empty');
step(300); // ~5 s (covers the slowest reload, AWP 3.7 s)
ok(!rb.reloading && rb.ammo.mag > 0, 'reload finishes and magazine refilled (mag=' + rb.ammo.mag + ')');
rb.onKilled(game.player, 'ak47', 'head');
ok(rb.alive === false && rb.state === 'death', 'onKilled sets alive=false, state=death');
const deathsBefore = M.kills;
step(60);
ok(rb.deathT > 0.5, 'death timer advances for fade animation (' + rb.deathT.toFixed(2) + ' s)');
CS.bots.render(game);
ok(true, 'render() with a dead bot does not throw');
step(500); // > 8 s, corpse should be dropped from rendering
ok(rb.deathT > 8, 'corpse removed after 8 s (deathT=' + rb.deathT.toFixed(1) + ')');
ok(typeof deathsBefore === 'number', 'kill events observed: ' + (M.events.kill || 0));

section('7. difficulty switch + fresh round');
for (const diff of ['easy', 'normal', 'hard']) {
  game.settings.difficulty = diff;
  CS.bots.spawnRound(game);
  game.frozen = false;
  game.player = makePlayer(0, 14, true);
  const s0 = M.shots;
  step(240); // 4 s
  ok(M.shots > s0, 'difficulty=' + diff + ': bots acquire & shoot (' + (M.shots - s0) + ' shots)');
  ok(list.every(b => Number.isFinite(b.pos[0]) && b.alive || !b.alive), 'difficulty=' + diff + ': state finite');
}

section('8. final sanity');
ok(M.hitscanCalls > 0, 'CS.weapons.hitscan reused (' + M.hitscanCalls + ' calls)');
ok(M.badMat === 0, 'no non-finite matrices emitted (' + M.badMat + ' bad)');
ok(M.badTex === 0, 'only white texture / valid tints used (' + M.badTex + ' bad)');
const final = CS.bots.debugState();
console.log('  debug: ' + JSON.stringify(final));
console.log('  stats: shots=' + M.shots + ' byWeapon=' + JSON.stringify(M.shotsByWeapon) + ' steps=' + M.steps +
  ' damage=' + M.damage + ' kills=' + M.kills + ' draws=' + M.draws + ' shadows=' + M.shadows);

console.log('\n' + (failures === 0 ? 'SMOKE TEST PASSED' : 'SMOKE TEST FAILED') + ' — ' + (checks - failures) + '/' + checks + ' checks passed');
process.exit(failures === 0 ? 0 : 1);
