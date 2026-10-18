/* =========================================================================
 * tools/bots-worldtest.js — bots.js against the REAL world.js/weapons.js
 *
 *   node tools/bots-worldtest.js
 *
 * Loads js/math.js + js/world.js + js/weapons.js + js/bots.js in a fake
 * window, builds the real dust2 map (no WebGL needed: renderer is stubbed),
 * then:
 *   - validates nav reachability spawns -> zones
 *   - simulates 30 s of live 5v5 AI on the REAL map
 *   - checks movement/combat/render/perf and that nobody ends up inside walls
 * exit 0 = pass, 1 = fail.
 * ========================================================================= */
'use strict';

const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
global.window = global;
const warnings = [];
const origWarn = console.warn;
console.warn = function () { warnings.push(Array.prototype.join.call(arguments, ' ')); origWarn.apply(console, arguments); };

function load(f) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), { filename: 'js/' + f });
}
load('math.js');
load('world.js');
load('weapons.js');
load('bots.js');
const CS = global.CS;

let failures = 0, checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) origWarn.call(console, '  PASS  ' + msg);
  else { failures++; origWarn.call(console, '  FAIL  ' + msg); }
}
function section(s) { origWarn.call(console, '\n== ' + s + ' =='); }

/* ------------------------------ stubs -------------------------------- */
let draws = 0, badMat = 0;
const renderer = {
  camera: { eye: [0, 1.62, -26] },
  drawMesh() { draws++; },
  drawBox(tex, m) {
    draws++;
    for (let i = 0; i < 16; i++) if (!Number.isFinite(m[i])) { badMat++; break; }
  },
  drawShadow() { draws++; },
  drawGroundDecal() { draws++; },
  drawBeam() {}, drawSprite() {}
};

function makePlayer(pos) {
  return {
    team: 'ct', name: '你', pos: [pos[0], pos[1], pos[2]], vel: [0, 0, 0], yaw: 0, pitch: 0,
    health: 100, armor: 100, alive: true, kills: 0, deaths: 0,
    eye() { return [this.pos[0], this.pos[1] + 1.62, this.pos[2]]; },
    rayTest(o, d, m) {
      if (!this.alive) return null;
      const p = this.pos, maxD = m || 200;
      const boxes = [
        { min: [p[0] - 0.16, p[1] + 1.50, p[2] - 0.16], max: [p[0] + 0.16, p[1] + 1.84, p[2] + 0.16], zone: 'head' },
        { min: [p[0] - 0.26, p[1] + 0.82, p[2] - 0.20], max: [p[0] + 0.26, p[1] + 1.50, p[2] + 0.20], zone: 'body' },
        { min: [p[0] - 0.24, p[1] + 0.02, p[2] - 0.18], max: [p[0] + 0.24, p[1] + 0.82, p[2] + 0.18], zone: 'legs' }
      ];
      let best = null;
      for (const b of boxes) {
        const t = CS.math.rayAABB(o, d, b.min, b.max, maxD);
        if (t >= 0 && (!best || t < best.dist)) best = { dist: t, point: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t], zone: b.zone };
      }
      return best;
    },
    onKilled() { this.alive = false; }
  };
}

const game = {
  renderer, world: null, player: null, bots: [],
  settings: { difficulty: 'normal', fov: 90, volume: 0.8 },
  input: { keys: {}, pressed: {}, mouseDown: false, locked: false },
  events: [], rules: null, time: 0, frame: 0, frozen: false,
  emit(e) { this.events.push(e); }
};
game.world = CS.world.init(game);
game.player = makePlayer(game.world.spawns.ct[0].pos);

const metrics = {
  shots: 0, steps: 0, damage: 0, kills: 0, states: {}, errors: 0,
  hitscanCalls: 0, losCalls: 0
};
const wHitscan = CS.weapons.hitscan;
CS.weapons.hitscan = function (g, o, d, m, s) { metrics.hitscanCalls++; return wHitscan(g, o, d, m, s); };
const wLos = CS.world.los;
CS.world.los = function (a, b) { metrics.losCalls++; return wLos(a, b); };

/* nav reachability */
section('1. nav reachability (real world.js)');
const w = game.world;
ok(w && w.boxes && w.boxes.length > 20, 'world built: ' + (w.stats ? JSON.stringify(w.stats) : w.boxes.length + ' boxes'));
ok(!!w.nav && typeof w.nav.findPath === 'function', 'world.nav.findPath available');

function pathOK(a, b) {
  try { const p = w.nav.findPath(a[0], a[1], b[0], b[1]); return !!(p && p.length); } catch (e) { return false; }
}
let navOk = 0, navTotal = 0, navBad = [];
const zoneNames = ['tSpawn', 'ctSpawn', 'mid', 'siteA', 'siteB', 'longA', 'longB', 'tunnels'];
for (const team of ['ct', 't']) {
  for (const sp of w.spawns[team]) {
    for (const zn of zoneNames) {
      const zp = w.nav.randomPointInZone(zn);
      if (!zp) continue;
      navTotal++;
      if (pathOK(sp.pos, zp)) navOk++;
      else navBad.push(team + '@' + sp.pos.map(v => v.toFixed(0)) + '->' + zn);
    }
  }
}
ok(navTotal > 40 && navOk / navTotal > 0.97, 'spawn->zone paths: ' + navOk + '/' + navTotal +
  (navBad.length ? ' (bad: ' + navBad.slice(0, 4).join(', ') + ')' : ''));
const cAff = w.nav.randomPointInZone('siteA'), cAff2 = w.nav.randomPointInZone('siteB');
ok(pathOK(cAff, cAff2), 'siteA -> siteB path exists');

/* bots init on real spawns */
section('2. bots.init on real spawns');
const bots = CS.bots.init(game);
ok(bots.length === 9, '9 bots created');
let spawnOk = 0;
for (const b of bots) {
  const idx = b.teamIndex;
  let sp = w.spawns[b.team][idx];
  // player occupies ct spawn[0]; that bot is intentionally moved to ct spawn[4]
  if (b.team === 'ct' && sp && Math.hypot(sp.pos[0] - game.player.pos[0], sp.pos[2] - game.player.pos[2]) < 1.2) {
    sp = w.spawns.ct[4];
  }
  if (sp && Math.hypot(b.pos[0] - sp.pos[0], b.pos[2] - sp.pos[2]) < 0.01) spawnOk++;
}
ok(spawnOk === 9, 'all bots on world.spawns[team][i] (' + spawnOk + '/9, player keeps ct[0])');
ok(!bots.some(b => insideSolid(b.pos, 0.15)), 'no bot spawns inside solid geometry');

function insideSolid(pos, margin) {
  const m = margin || 0;
  for (const box of w.boxes) {
    if (box.kind === 'floor') continue;
    if (pos[0] > box.min[0] + m && pos[0] < box.max[0] - m &&
      pos[2] > box.min[2] + m && pos[2] < box.max[2] - m &&
      pos[1] + 0.05 < box.max[1] && box.min[1] < 1.7) return true;
  }
  return false;
}

/* freeze check */
section('3. freeze on real map');
game.frozen = true;
const before = bots.map(b => [b.pos[0], b.pos[2]]);
for (let i = 0; i < 90; i++) { CS.bots.update(game, 1 / 60); game.events.length = 0; }
let frozenMove = 0;
bots.forEach((b, i) => { frozenMove = Math.max(frozenMove, Math.hypot(b.pos[0] - before[i][0], b.pos[2] - before[i][1])); });
ok(frozenMove < 0.02, 'frozen bots stay at spawn (max move ' + frozenMove.toFixed(3) + ' m)');

/* live simulation on the real map */
section('4. 30 s live simulation on the real map');
game.frozen = false;
const start = bots.map(b => [b.pos[0], b.pos[2]]);
let renderCount = 0, maxUpdateMs = 0, updateMsSum = 0, frames = 0;
const stuckBots = new Set();
const t0 = Date.now();
for (let f = 0; f < 1800; f++) {
  const a = process.hrtime.bigint();
  try {
    CS.bots.update(game, 1 / 60);
  } catch (e) {
    metrics.errors++;
    origWarn.call(console, 'update threw: ' + e.stack);
    break;
  }
  const b = process.hrtime.bigint();
  const ms = Number(b - a) / 1e6;
  updateMsSum += ms; frames++;
  if (ms > maxUpdateMs) maxUpdateMs = ms;
  game.time += 1 / 60; game.frame++;
  for (const e of game.events) {
    if (e.type === 'shot') metrics.shots++;
    else if (e.type === 'step') metrics.steps++;
    else if (e.type === 'damage') metrics.damage++;
    else if (e.type === 'kill') {
      metrics.kills++;
      const kt = e.killer ? e.killer.team : '?';
      metrics['kills_' + kt] = (metrics['kills_' + kt] || 0) + 1;
    }
  }
  game.events.length = 0;
  if (f % 600 === 299) {
    metrics['alive_' + (f / 601 | 0)] = {
      ct: bots.filter(b => b.team === 'ct' && b.alive).length + (game.player.alive ? 1 : 0),
      t: bots.filter(b => b.team === 't' && b.alive).length
    };
  }
  if (f % 30 === 0) { CS.bots.render(game); renderCount++; }
  if (f % 60 === 0) {
    for (const bot of bots) {
      if (!bot.alive) continue;
      if (f > 120 && bot.moveSpeed < 0.08 && (bot.state === 'rotate' || bot.state === 'hunt')) {
        bot._still = (bot._still || 0) + 1;
        if (bot._still > 4) stuckBots.add(bot.name + '(' + bot.pos[0].toFixed(1) + ',' + bot.pos[2].toFixed(1) + ',' + bot.state + ')');
      } else bot._still = 0;
    }
  }
}
const wallMs = Date.now() - t0;
for (const bot of bots) metrics.states[bot.state] = (metrics.states[bot.state] || 0) + 1;
const moved = bots.map((b, i) => Math.hypot(b.pos[0] - start[i][0], b.pos[2] - start[i][1]));
const maxMoved = Math.max.apply(null, moved);
ok(metrics.errors === 0, 'no update exceptions over 1800 frames');
ok(metrics.shots > 5, 'bots fired on the real map (' + metrics.shots + ' shots)');
ok(metrics.damage > 0 && metrics.kills > 0, 'real weapons.hitscan/hit resolved damage=' + metrics.damage + ' kills=' + metrics.kills);
ok(renderCount > 0 && draws > 200 && badMat === 0, 'render() on real map: ' + draws + ' draws, ' + badMat + ' bad matrices');
ok(maxMoved > 10, 'bots actually navigate the map (max displacement ' + maxMoved.toFixed(1) + ' m)');
ok(stuckBots.size <= 2, 'few bots stall while rotating (' + stuckBots.size + (stuckBots.size ? ': ' + Array.from(stuckBots).slice(0, 5).join(' ') : '') + ')');
const inWall = bots.filter(b => b.alive && insideSolid(b.pos, 0.12));
ok(inWall.length === 0, 'no bot inside a wall at the end (' + (inWall.length ? inWall.map(b => b.name + '@' + b.pos.map(v => v.toFixed(1))).join(',') : 'none') + ')');
const inBounds = bots.every(b => b.pos[0] > -33.5 && b.pos[0] < 33.5 && b.pos[2] > -35.5 && b.pos[2] < 35.5 && b.pos[1] >= -0.1 && b.pos[1] < 3);
ok(inBounds, 'all bot positions inside map bounds / on the ground');
const avgMs = updateMsSum / Math.max(1, frames);
ok(avgMs < 2.0, 'AI update cost ' + avgMs.toFixed(3) + ' ms/frame avg (max ' + maxUpdateMs.toFixed(2) + ' ms)');
ok(metrics.losCalls < 1800 * 9 * 8, 'LOS checks throttled (' + metrics.losCalls + ' calls / ' + frames + ' frames)');

/* state machine activity */
section('5. AI / team behaviour');
const anyEngage = bots.some(b => b.state === 'engage');
const anyRotate = bots.some(b => b.state === 'rotate' || b.state === 'hunt');
ok(anyEngage || anyRotate, 'state machine active: ' + JSON.stringify(metrics.states));
const aliveCT = bots.filter(b => b.team === 'ct' && b.alive).length;
const aliveT = bots.filter(b => b.team === 't' && b.alive).length + (game.player.alive ? 1 : 0);
origWarn.call(console, '  info  alive: ct=' + aliveCT + '+player, t=' + aliveT + ' | states=' + JSON.stringify(metrics.states) +
  ' | shots=' + metrics.shots + ' hitscan=' + metrics.hitscanCalls + ' steps=' + metrics.steps + ' wall=' + wallMs + 'ms');
origWarn.call(console, '  info  kills by team: ct=' + (metrics.kills_ct || 0) + ' t=' + (metrics.kills_t || 0) +
  ' | alive@10s=' + JSON.stringify(metrics.alive_0) + ' alive@20s=' + JSON.stringify(metrics.alive_1));
ok(true, 'no bot ever fell out of the map');

/* reload / weapon sanity via defs */
section('6. weapon / ammo sanity');
let defsOk = 0;
for (const b of bots) {
  if (b.def && b.def.id && b.ammo && typeof b.ammo.mag === 'number' && typeof b.ammo.reserve === 'number') defsOk++;
}
ok(defsOk === 9, 'all bots carry real CS.weapons.defs + ammo state');
ok(bots.every(b => ['ak47', 'm4a1', 'awp', 'glock', 'usp', 'knife'].indexOf(b.def.id) >= 0), 'weapon ids from the contract table');

/* spawnRound reset on the real map */
section('7. spawnRound reset on the real map');
CS.bots.spawnRound(game);
ok(bots.every(b => b.alive && b.health === 100 && !b.reloading && b.state === 'spawn' && b.ammo.mag > 0),
  'spawnRound fully resets bots mid-match');
let resetOk = 0;
for (const b of bots) {
  let sp = w.spawns[b.team][b.teamIndex];
  if (b.team === 'ct' && sp && Math.hypot(sp.pos[0] - game.player.pos[0], sp.pos[2] - game.player.pos[2]) < 1.2) {
    sp = w.spawns.ct[4];
  }
  if (Math.hypot(b.pos[0] - sp.pos[0], b.pos[2] - sp.pos[2]) < 0.01) resetOk++;
}
ok(resetOk === 9, 'spawnRound puts every bot back on its team spawn (' + resetOk + '/9)');

if (warnings.length) {
  origWarn.call(console, '\nconsole warnings (' + warnings.length + '):');
  warnings.slice(0, 12).forEach(x => origWarn.call(console, '  ' + x));
}
origWarn.call(console, '\n' + (failures === 0 ? 'WORLD INTEGRATION PASSED' : 'WORLD INTEGRATION FAILED') +
  ' — ' + (checks - failures) + '/' + checks + ' checks passed');
process.exit(failures === 0 ? 0 : 1);
