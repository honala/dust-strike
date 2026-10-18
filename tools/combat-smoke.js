/* =========================================================================
 * DUST STRIKE — combat smoke test (weapons.js + player.js)
 * Temporary tool owned by: combat. Run: node tools/combat-smoke.js
 * Uses stubs for game/world/renderer/fx/audio; no browser needed.
 * ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---- load classic scripts into the node "window" (global) ---- */
global.window = global;
const JS = path.join(__dirname, '..', 'js');
for (const f of ['math.js', 'weapons.js', 'player.js']) {
  const code = fs.readFileSync(path.join(JS, f), 'utf8');
  eval(code); /* eslint-disable-line no-eval */
}
const CS = global.CS;
const M = CS.math;

/* ------------------------------ mini test ------------------------------ */
let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; failures.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function near(a, b, eps, name) { ok(Math.abs(a - b) <= eps, name, 'a=' + a + ' b=' + b); }
function section(t) { console.log('\n== ' + t + ' =='); }

/* ------------------------------- stubs -------------------------------- */
function buildStubs() {
  const boxes = [
    { min: [-6, 0, 3], max: [6, 4, 4], kind: 'wall' },      /* wall north (+Z) */
    { min: [-6, 0, -34], max: [6, 4, -33], kind: 'wall2' }  /* wall south (-Z) */
  ];
  const world = {
    name: 'Stub Strike',
    boxes: boxes,
    spawns: {
      ct: [{ pos: [0, 0, -27], yaw: Math.PI }, { pos: [2, 0, -27], yaw: Math.PI }],
      t: [{ pos: [0, 0, 27], yaw: 0 }, { pos: [2, 0, 27], yaw: 0 }]
    },
    sites: { A: { center: [-17, -6], radius: 5 }, B: { center: [17, -4], radius: 5 } },
    zones: {},
    raycast(origin, dir, maxDist) {
      let best = null, bestT = maxDist === undefined ? 1e9 : maxDist;
      /* floor plane y=0 */
      if (dir[1] < -1e-6 && origin[1] > 0) {
        const t = -origin[1] / dir[1];
        if (t >= 0 && t < bestT) {
          bestT = t;
          best = { dist: t, point: [origin[0] + dir[0] * t, 0, origin[2] + dir[2] * t], normal: [0, 1, 0], box: { kind: 'floor' } };
        }
      }
      for (const b of boxes) {
        const t = M.rayAABB(origin, dir, b.min, b.max, bestT);
        if (t >= 0 && t < bestT) {
          bestT = t;
          const p = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
          let n = [0, 0, 0];
          const eps = 1e-4;
          if (Math.abs(p[0] - b.min[0]) < eps) n = [-1, 0, 0];
          else if (Math.abs(p[0] - b.max[0]) < eps) n = [1, 0, 0];
          else if (Math.abs(p[1] - b.min[1]) < eps) n = [0, -1, 0];
          else if (Math.abs(p[1] - b.max[1]) < eps) n = [0, 1, 0];
          else if (Math.abs(p[2] - b.min[2]) < eps) n = [0, 0, -1];
          else n = [0, 0, 1];
          best = { dist: t, point: p, normal: n, box: b };
        }
      }
      return best;
    },
    los(a, b) { return true; },
    moveEntity(pos, delta, radius, height) {
      const np = [pos[0] + delta[0], pos[1] + delta[1], pos[2] + delta[2]];
      let hitWall = false;
      if (np[0] < -28) { np[0] = -28; hitWall = true; }
      if (np[0] > 28) { np[0] = 28; hitWall = true; }
      if (np[2] < -31) { np[2] = -31; hitWall = true; }
      if (np[2] > 31) { np[2] = 31; hitWall = true; }
      let onGround = false;
      if (np[1] <= 0) { np[1] = 0; onGround = true; }
      return { pos: np, onGround, hitWall, hitCeil: false };
    },
    render() {}
  };
  const fx = {
    calls: {}, init() {},
    tracer() { this.calls.tracer = (this.calls.tracer || 0) + 1; },
    impact() { this.calls.impact = (this.calls.impact || 0) + 1; },
    muzzle() { this.calls.muzzle = (this.calls.muzzle || 0) + 1; },
    blood() { this.calls.blood = (this.calls.blood || 0) + 1; },
    shell() { this.calls.shell = (this.calls.shell || 0) + 1; },
    update() {}, render() {}, clear() {}
  };
  const audio = { played: [], init() {}, play(name) { this.played.push(name); }, onEvent() {}, setListener() {}, setVolume() {} };
  const game = {
    world, fx, audio,
    settings: { sensitivity: 1.0, difficulty: 'normal', volume: 0.8, fov: 90 },
    input: { keys: {}, mouseDown: false, mouseDX: 0, mouseDY: 0, pressed: {}, locked: true, rightDown: false, rightPressed: false },
    events: [], emit(e) { this.events.push(e); },
    frozen: false,
    hud: { isBlockingInput() { return false; } },
    rules: { state: { phase: 'live' } },
    bots: [],
    player: null,
    canvas: null
  };
  CS.fx = fx;
  CS.audio = audio;
  CS.world = world;
  return { game, world, fx, audio };
}
function drain(game) { const e = game.events.slice(); game.events.length = 0; return e; }
function countType(events, type) { return events.filter(e => e.type === type).length; }

/* shared actor rayTest geometry (same shape player.js uses), for fake bots */
function actorRayTest(actor, origin, dir, maxDist) {
  if (!actor.alive) return null;
  const md = maxDist || 200;
  const h = actor.height || 1.8;
  const px = actor.pos[0], py = actor.pos[1], pz = actor.pos[2];
  const tHead = M.raySphere(origin, dir, [px, py + h - 0.16, pz], 0.16, md);
  const tBody = M.rayAABB(origin, dir, [px - 0.26, py + h * 0.45, pz - 0.18], [px + 0.26, py + h * 0.82, pz + 0.18], md);
  const tLegs = M.rayAABB(origin, dir, [px - 0.21, py + 0.02, pz - 0.16], [px + 0.21, py + h * 0.45, pz + 0.16], md);
  let best = -1, zone = null;
  if (tHead >= 0) { best = tHead; zone = 'head'; }
  if (tBody >= 0 && (best < 0 || tBody < best)) { best = tBody; zone = 'body'; }
  if (tLegs >= 0 && (best < 0 || tLegs < best)) { best = tLegs; zone = 'legs'; }
  if (best < 0) return null;
  return { dist: best, point: [origin[0] + dir[0] * best, origin[1] + dir[1] * best, origin[2] + dir[2] * best], zone: zone };
}
function makeBot(id, x, z, team) {
  const b = {
    id, name: id, team: team || 't', alive: true, health: 100, armor: 0,
    pos: [x, 0, z], yaw: 0, height: 1.8, kills: 0, deaths: 0,
    rayTest(origin, dir, maxDist) { return actorRayTest(b, origin, dir, maxDist); },
    onKilled() { b.killCalls = (b.killCalls || 0) + 1; }
  };
  return b;
}

/* ================================ run ================================= */
const { game } = buildStubs();
section('player.init');
const p = CS.player.init(game);
ok(!!p, 'CS.player.init returns player');
ok(game.player === p, 'game.player set');
ok(p.alive === true && p.health === 100, 'starts alive at 100hp');
ok(p.team === 'ct' && p.name === '你', 'player is CT named 你');
ok(p.pos[0] === 0 && p.pos[2] === -27, 'spawns at world.spawns.ct[0]', JSON.stringify(p.pos));
ok(p.current === 'secondary' && p.loadout.secondary === 'usp', 'starts with USP');
ok(p.loadout.knife === 'knife', 'has knife');
ok(p.ammo.usp.mag === 12 && p.ammo.usp.reserve === 100, 'USP ammo 12/100');
ok(typeof CS.player.resetForRound === 'function' && typeof CS.player.equip === 'function', 'module-level resetForRound/equip exist');
ok(typeof p.rayTest === 'function' && typeof p.eye === 'function' && typeof p.currentDef === 'function', 'instance API exists');
ok(p.currentDef().id === 'usp', 'currentDef() -> usp');

/* ---------------------------- weapon deps ----------------------------- */
section('weapons.defs');
const required = ['id', 'name', 'slot', 'price', 'damage', 'headshot', 'rpm', 'mag', 'reserve', 'range', 'auto', 'reloadTime', 'drawTime', 'kick', 'spread', 'recoil', 'sound'];
for (const id of ['knife', 'usp', 'glock', 'm4a1', 'ak47', 'awp']) {
  const d = CS.weapons.defs[id];
  const missing = required.filter(k => !(k in d));
  ok(!!d && missing.length === 0, 'def ' + id + ' has all required fields', missing.join(','));
  ok(Array.isArray(d.spread) && d.spread.length === 3, id + ' spread is [base,move,air]');
  ok(d.recoil && typeof d.recoil.v === 'number' && typeof d.recoil.h === 'number', id + ' recoil {v,h}');
}
ok(CS.weapons.defs.ak47.damage === 36 && CS.weapons.defs.awp.damage === 115, 'signature damage values');

/* ------------------------------ look ---------------------------------- */
section('mouse look');
game.input.locked = true;
game.input.mouseDX = 100; game.input.mouseDY = 0;
const yaw0 = p.yaw;
CS.player.update(game, 1 / 60);
near(p.yaw, M.normalizeAngle(yaw0 + 100 * 0.0022), 1e-6, 'yaw += dx*0.0022 (sens 1.0)');
game.input.mouseDX = 0; game.input.mouseDY = 100;
const pitch0 = p.pitch;
CS.player.update(game, 1 / 60);
near(p.pitch, pitch0 - 100 * 0.0022, 1e-6, 'pitch -= dy*0.0022');
game.input.mouseDY = 0;
/* pitch clamp */
p.pitch = 0;
for (let i = 0; i < 200; i++) { game.input.mouseDY = 100; CS.player.update(game, 1 / 60); }
ok(p.pitch >= -1.5501, 'pitch clamped to -1.55', String(p.pitch));
p.pitch = 0;
/* unlocked -> no look */
game.input.locked = false;
const yawU = p.yaw; game.input.mouseDX = 100;
CS.player.update(game, 1 / 60);
near(p.yaw, yawU, 1e-9, 'no look while pointer unlocked');
game.input.locked = true; game.input.mouseDX = 0;

/* ---------------------------- movement -------------------------------- */
section('movement');
p.yaw = Math.PI; p.pitch = 0; p.pos = [0, 0, -27]; p.vel = [0, 0, 0];
game.input.keys = { KeyW: true };
for (let i = 0; i < 60; i++) CS.player.update(game, 1 / 60);
ok(p.pos[2] > -25, 'W moves forward (+Z when yaw=PI): z=' + p.pos[2].toFixed(2));
near(p.hspeed, 5.2, 0.35, 'run speed ~5.2 m/s');
game.input.keys = { KeyW: true, ShiftLeft: true };
for (let i = 0; i < 90; i++) CS.player.update(game, 1 / 60);
near(p.hspeed, 2.6, 0.35, 'shift walk speed ~2.6 m/s');
game.input.keys = { KeyW: true, ControlLeft: true };
for (let i = 0; i < 90; i++) CS.player.update(game, 1 / 60);
ok(p.crouching && p.height < 1.3 && p.eyeHeight < 1.25, 'crouch lowers height/eye');
near(p.hspeed, 2.0, 0.35, 'crouch speed ~2.0 m/s');
game.input.keys = {};
for (let i = 0; i < 120; i++) CS.player.update(game, 1 / 60);
ok(!p.crouching && p.height > 1.75, 'stands back up when Ctrl released');
ok(p.hspeed < 0.05, 'friction stops player');
/* jump */
game.input.keys = { Space: true };
CS.player.update(game, 1 / 60);
ok(p.vel[1] > 4.5 && p.onGround === false, 'jump gives upward velocity ~5.2');
game.input.keys = {};
let landed = false;
for (let i = 0; i < 120; i++) { CS.player.update(game, 1 / 60); if (p.onGround && p.pos[1] <= 0.001) { landed = true; break; } }
ok(landed, 'lands back on the floor');
/* out-of-bounds stress */
game.input.keys = { KeyW: true };
for (let i = 0; i < 900; i++) {
  if (i % 120 === 0) p.yaw = (i / 120) * 1.1;
  CS.player.update(game, 1 / 60);
}
game.input.keys = {};
ok(p.pos[0] >= -30.01 && p.pos[0] <= 30.01 && p.pos[2] >= -32.01 && p.pos[2] <= 32.01, 'stays inside stub bounds', JSON.stringify(p.pos));
ok([p.pos[0], p.pos[1], p.pos[2], p.yaw, p.pitch, p.health].every(Number.isFinite), 'state stays finite');

/* ------------------------- semi-auto shooting ------------------------- */
section('shooting / hitscan walls');
p.pos = [0, 0, -27]; p.yaw = Math.PI; p.pitch = 0; p.vel = [0, 0, 0];
p.ammo.usp.mag = 12; p.ammo.usp.reserve = 100; p.fireT = 0;
game.input.mouseDown = false; CS.player.update(game, 1 / 60);
drain(game);
game.input.mouseDown = true;
CS.player.update(game, 1 / 60);
let evs = drain(game);
ok(p.ammo.usp.mag === 11, 'semi-auto fires one round', 'mag=' + p.ammo.usp.mag);
ok(countType(evs, 'shot') === 1 && evs.find(e => e.type === 'shot').weapon === 'usp', 'emits shot {weapon:usp}');
ok(countType(evs, 'shot') === 1 && evs[0].byPlayer === true, 'shot has byPlayer:true');
ok(CS.fx.calls.muzzle >= 1 && CS.fx.calls.tracer >= 1, 'fx muzzle + tracer called');
/* holding does not auto-fire a semi weapon */
for (let i = 0; i < 30; i++) CS.player.update(game, 1 / 60);
ok(p.ammo.usp.mag === 11, 'holding LMB does not repeat-fire semi-auto');
/* release + press fires again after cooldown */
game.input.mouseDown = false;
for (let i = 0; i < 15; i++) CS.player.update(game, 1 / 60);
game.input.mouseDown = true; CS.player.update(game, 1 / 60);
ok(p.ammo.usp.mag === 10, 'second click fires again after RPM cooldown');
game.input.mouseDown = false; CS.player.update(game, 1 / 60);

/* empty magazine (a fresh press is required for the edge) */
p.ammo.usp.mag = 0; p.fireT = 0;
game.input.mouseDown = false; CS.player.update(game, 1 / 60);
drain(game);
game.input.mouseDown = true; CS.player.update(game, 1 / 60);
evs = drain(game);
ok(countType(evs, 'empty') === 1, 'empty event when magazine is empty');
ok(p.ammo.usp.mag === 0, 'empty gun stays empty');
game.input.mouseDown = false; CS.player.update(game, 1 / 60);

/* auto weapon RPM */
section('auto fire + reload');
CS.player.equip(game, 'm4a1');
ok(p.loadout.primary === 'm4a1' && p.current === 'primary', 'equip m4a1 switches to primary');
ok(p.ammo.m4a1.mag === 30 && p.drawT > 0, 'm4a1 equipped full mag, draw animation pending');
ok(p.currentDef().id === 'm4a1', 'currentDef m4a1');
/* cannot fire during draw time */
drain(game); game.input.mouseDown = true;
CS.player.update(game, 1 / 60);
ok(p.ammo.m4a1.mag === 30, 'no fire during draw time');
/* wait draw, then hold */
for (let i = 0; i < 70; i++) CS.player.update(game, 1 / 60);
game.input.mouseDown = false;
ok(p.ammo.m4a1.mag < 30, 'some shots fired after draw (' + p.ammo.m4a1.mag + '/30)');
const magBefore = p.ammo.m4a1.mag;
game.input.mouseDown = true;
for (let i = 0; i < 60; i++) CS.player.update(game, 1 / 60);
game.input.mouseDown = false;
const fired = magBefore - p.ammo.m4a1.mag;
ok(fired >= 8 && fired <= 12, 'auto fire ~600rpm over 1s: ' + fired);
/* reload */
const magNow = p.ammo.m4a1.mag;
p.ammo.m4a1.reserve = 90;
game.input.pressed = { reload: true };
CS.player.update(game, 1 / 60);
game.input.pressed = {};
ok(p.reloading === true && p.reloadT > 2.5, 'R starts reload (3.1s)');
for (let i = 0; i < 15; i++) CS.player.update(game, 1 / 60);
ok(p.ammo.m4a1.mag === magNow, 'mag not refilled mid-reload');
for (let i = 0; i < 240; i++) CS.player.update(game, 1 / 60);
ok(!p.reloading && p.ammo.m4a1.mag === 30, 'reload completes to 30/90');
ok(p.ammo.m4a1.reserve === 90 - (30 - magNow), 'reserve consumed correctly', String(p.ammo.m4a1.reserve));
/* reload with empty reserve does nothing */
p.ammo.m4a1.mag = 3; p.ammo.m4a1.reserve = 0; p.reloading = false;
game.input.pressed = { reload: true }; CS.player.update(game, 1 / 60); game.input.pressed = {};
ok(!p.reloading, 'no reload without reserve');

/* ------------------------- weapon switching --------------------------- */
section('weapon switching');
CS.player.equip(game, 'ak47');
p.drawT = 0;
game.input.pressed = { slot2: true }; CS.player.update(game, 1 / 60); game.input.pressed = {};
ok(p.current === 'secondary' && p.currentDef().id === 'usp', 'slot2 -> usp');
ok(p.drawT > 0, 'switch triggers draw time');
game.input.pressed = { slot3: true }; CS.player.update(game, 1 / 60); game.input.pressed = {};
ok(p.current === 'knife' && p.currentDef().slot === 'knife', 'slot3 -> knife');
game.input.pressed = { slot1: true }; CS.player.update(game, 1 / 60); game.input.pressed = {};
ok(p.current === 'primary' && p.currentDef().id === 'ak47', 'slot1 -> ak47');

/* ------------------------------ knife --------------------------------- */
section('knife');
p.pos = [0, 0, -27]; p.yaw = Math.PI; p.pitch = 0; p.vel = [0, 0, 0]; p.hspeed = 0;
CS.player.equip(game, 'knife');
p.drawT = 0; p.fireT = 0;
game.input.mouseDown = false; CS.player.update(game, 1 / 60);
game.bots = [makeBot('bot-knife', 0, -25.4, 't')];   /* 1.6m in front */
drain(game);
game.input.mouseDown = true; CS.player.update(game, 1 / 60);
evs = drain(game);
ok(countType(evs, 'shot') === 1 && evs.find(e => e.type === 'shot').weapon === 'knife', 'knife swing emits shot');
ok(CS.fx.calls.blood >= 1, 'knife hit draws blood');
ok(game.bots[0].health < 100, 'knife damages nearby bot', String(game.bots[0].health));
game.input.mouseDown = false;
game.bots = [];

/* --------------------------- hitscan actors --------------------------- */
section('hitscan vs bots');
p.pos = [0, 0, -27]; p.yaw = Math.PI; p.pitch = 0; p.vel = [0, 0, 0];
const bot1 = makeBot('bot1', 0, -20, 't');
const friendly = makeBot('friend1', 0, -18, 'ct');
const deadBot = makeBot('dead1', 0, -16, 't'); deadBot.alive = false;
game.bots = [bot1, friendly, deadBot];
const origin = p.eye();
let hs = CS.weapons.hitscan(game, origin, [0, 0, 1], 60, p);
ok(!!hs && hs.target === bot1, 'hitscan finds enemy bot');
ok(!!hs && hs.zone === 'head', 'head hit at eye-level ray', hs && hs.zone);
ok(!!hs && Math.abs(hs.dist - 7) < 0.5, 'hitscan distance ~7m', hs && String(hs.dist));
const teammateOnly = CS.weapons.hitscan(game, origin, [0, 0, 1], 60, friendly);
ok(!teammateOnly || teammateOnly.target !== friendly, 'teammate not a valid target');
const selfScan = CS.weapons.hitscan(game, origin, [0, 0, 1], 60, p);
ok(!selfScan || selfScan.target !== p, 'shooter never hits itself');
/* wall-only result */
hs = CS.weapons.hitscan(game, [0, 1.0, 0], [0, 0, 1], 60, friendly);
ok(!!hs && hs.target === null && !!hs.normal, 'wall-only hitscan returns {target:null, normal}');
/* max distance -> null */
hs = CS.weapons.hitscan(game, origin, [0, 0, 1], 3, p);
ok(hs === null || hs.target === null, 'hit beyond maxDist returns null (or wall=null)');

/* ------------------------- damage / armor ----------------------------- */
section('weapons.hit damage rules');
function freshTarget(team) {
  return { id: 'tgt', name: 'Tgt', team: team || 't', health: 100, armor: 0, alive: true, onKilled(a, w, z) { this.killedBy = w; } };
}
drain(game);
let tgt = freshTarget('t');
let res = CS.weapons.hit(game, tgt, 30, p, 'usp', 'head', [0, 1.6, 0]);
near(tgt.health, 4, 1e-6, 'USP headshot: 30*3.2=96 -> 4hp');
ok(res.damage === 96 && res.killed === false, 'hit returns {damage,killed}');
evs = drain(game);
ok(countType(evs, 'damage') === 1 && countType(evs, 'kill') === 0, 'emits damage only (alive)');

tgt = freshTarget('t');
res = CS.weapons.hit(game, tgt, 30, p, 'usp', 'legs', [0, 0.4, 0]);
near(tgt.health, 100 - 22.5, 1e-6, 'legs multiplier 0.75');
tgt = freshTarget('t');
CS.weapons.hit(game, tgt, 30, p, 'usp', 'body', [0, 1.2, 0]);
near(tgt.health, 70, 1e-6, 'body damage = base');

/* armor: dmg * 0.5, armor -= base*0.5 */
tgt = freshTarget('t'); tgt.armor = 100;
CS.weapons.hit(game, tgt, 30, p, 'usp', 'body', [0, 1.2, 0]);
near(tgt.health, 85, 1e-6, 'armor halves body damage');
near(tgt.armor, 85, 1e-6, 'armor absorbs baseDamage*0.5');
/* Lead-requested balance: AWP headshot multiplier 4.0 -> 115*4*0.5 = 230
   through armor, i.e. an AWP headshot always kills (CS-like). */
tgt = freshTarget('t'); tgt.armor = 100;
CS.weapons.hit(game, tgt, 115, p, 'awp', 'head', [0, 1.6, 0]);
ok(tgt.alive === false && tgt.health === 0, 'AWP headshot kills through armor (230 dmg)');
near(tgt.armor, 42.5, 1e-6, 'armor reduced by 115*0.5');
tgt = freshTarget('t');
CS.weapons.hit(game, tgt, 115, p, 'awp', 'head', [0, 1.6, 0]);
ok(tgt.alive === false, 'unarmored AWP headshot kills (460 dmg)');
/* friendly fire */
tgt = freshTarget('ct');
res = CS.weapons.hit(game, tgt, 30, p, 'usp', 'body', [0, 1.2, 0]);
ok(res === null && tgt.health === 100, 'no friendly fire');
/* dead target ignored */
tgt = freshTarget('t'); tgt.alive = false;
ok(CS.weapons.hit(game, tgt, 30, p, 'usp', 'body', null) === null, 'dead target ignored');
/* null target safe */
ok(CS.weapons.hit(game, null, 30, p, 'usp', 'body', null) === null, 'null target safe');
/* kill event + onKilled */
drain(game);
tgt = freshTarget('t');
res = CS.weapons.hit(game, tgt, 36, p, 'ak47', 'head', [0, 1.6, 0]);
evs = drain(game);
ok(res.killed === true && countType(evs, 'kill') === 1, 'lethal hit emits kill');
const killEv = evs.find(e => e.type === 'kill');
ok(killEv && killEv.killer === p && killEv.victim === tgt && killEv.headshot === true, 'kill event fields');
ok(tgt.killedBy === 'ak47', 'victim.onKilled called');
ok(tgt.alive === false, 'victim marked dead');

/* player.rayTest zones */
section('player.rayTest');
p.pos = [0, 0, -27]; p.height = 1.8;
let rt = p.rayTest([0, 1.64, -30], [0, 0, 1], 20);
ok(!!rt && rt.zone === 'head', 'player head hitbox', rt && rt.zone);
rt = p.rayTest([0, 1.2, -30], [0, 0, 1], 20);
ok(!!rt && rt.zone === 'body', 'player body hitbox', rt && rt.zone);
rt = p.rayTest([0, 0.5, -30], [0, 0, 1], 20);
ok(!!rt && rt.zone === 'legs', 'player legs hitbox', rt && rt.zone);
ok(p.rayTest([0, 1.64, -30], [0, 1, 0], 20) === null, 'miss above returns null');
p.alive = false;
ok(p.rayTest([0, 1.64, -30], [0, 0, 1], 20) === null, 'dead player rayTest null');
p.alive = true;
/* crouched headbox lower */
p.height = 1.2;
rt = p.rayTest([0, 1.04, -30], [0, 0, 1], 20);
ok(!!rt && rt.zone === 'head', 'crouched head hitbox at ~1.04m', rt && rt.zone);
p.height = 1.8;

/* ------------------------ damage / kill lifecycle --------------------- */
section('onKilled + frozen + resetForRound');
CS.player.onKilled({ name: 'Viper' }, 'ak47', 'head');
ok(p.alive === false && p.health === 0, 'onKilled sets dead');
ok(p.killedBy === 'Viper', 'killedBy recorded');
const deadPos = p.pos.slice();
game.input.keys = { KeyW: true };
for (let i = 0; i < 30; i++) CS.player.update(game, 1 / 60);
game.input.keys = {};
ok(p.pos[0] === deadPos[0] && p.pos[2] === deadPos[2], 'dead player does not move');
/* look still works while dead (Lead msg 6) */
game.input.mouseDX = 50;
const deadYaw = p.yaw;
CS.player.update(game, 1 / 60);
ok(p.yaw !== deadYaw, 'dead player can still look around');
game.input.mouseDX = 0;

/* frozen: look/scope allowed, actions ignored */
p.alive = true; p.health = 100; p.pos = [0, 0, -27]; p.vel = [0, 0, 0];
game.frozen = true;
game.input.keys = { KeyW: true };
game.input.mouseDX = 80;
const fYaw = p.yaw, fPos = p.pos.slice();
CS.player.update(game, 1 / 60);
game.input.keys = {};
game.input.mouseDX = 0;
ok(p.yaw !== fYaw, 'frozen still allows mouse look');
ok(p.pos[0] === fPos[0] && p.pos[2] === fPos[2], 'frozen blocks movement');
CS.player.equip(game, 'm4a1'); p.drawT = 0;
drain(game);
game.input.mouseDown = true; CS.player.update(game, 1 / 60); game.input.mouseDown = false;
ok(countType(drain(game), 'shot') === 0, 'frozen blocks shooting');
game.frozen = false;

/* resetForRound keepWeapons=true: keeps loadout + remaining ammo */
p.ammo.m4a1.mag = 17; p.ammo.m4a1.reserve = 40;
CS.player.resetForRound(game, { pos: [0, 0, -26], yaw: Math.PI, keepWeapons: true, armor: 73 });
ok(p.loadout.primary === 'm4a1' && p.current === 'primary', 'keepWeapons keeps loadout/current');
ok(p.ammo.m4a1.mag === 17 && p.ammo.m4a1.reserve === 40, 'keepWeapons keeps remaining ammo');
ok(p.health === 100 && p.alive === true, 'reset restores health/alive');
ok(p.armor === 73, 'reset uses opts.armor');
ok(p.pos[0] === 0 && p.pos[2] === -26 && Math.abs(M.angleDiff(p.yaw, Math.PI)) < 1e-9, 'reset uses opts.pos/yaw');
ok(p.vel[0] === 0 && p.vel[2] === 0 && p.pitch === 0, 'reset clears velocity/pitch');
ok(p.reloading === false && p.drawT === 0, 'reset clears reload/draw state');

/* resetForRound keepWeapons=false: back to USP+knife, all ammo full */
CS.player.resetForRound(game, { pos: [0, 0, -27], yaw: Math.PI, keepWeapons: false, armor: 0 });
ok(p.loadout.primary === null && p.loadout.secondary === 'usp' && p.current === 'secondary', 'death reset -> USP+knife');
ok(p.ammo.usp.mag === 12 && p.ammo.usp.reserve === 100, 'USP refilled');
ok(p.ammo.m4a1.mag === 30 && p.ammo.m4a1.reserve === 90, 'all weapon ammo refilled');
ok(p.armor === 0, 'armor reset to 0');

/* ------------------------------ AWP scope ----------------------------- */
section('AWP scope');
CS.player.equip(game, 'awp');
p.drawT = 0;
game.input.rightPressed = true;
CS.player.update(game, 1 / 60);
game.input.rightPressed = false;
ok(p.scoped === true, 'right click scopes AWP');
for (let i = 0; i < 60; i++) CS.player.update(game, 1 / 60);
ok(p.fov < 40, 'scoped fov approaches 35', String(p.fov));
ok(p.spread < 0.002, 'scoped spread is tiny', String(p.spread));
/* scoped movement speed halved */
game.input.keys = { KeyW: true };
for (let i = 0; i < 120; i++) CS.player.update(game, 1 / 60);
game.input.keys = {};
near(p.hspeed, 2.6, 0.35, 'scoped speed halved');
game.input.rightPressed = true; CS.player.update(game, 1 / 60); game.input.rightPressed = false;
ok(p.scoped === false, 'right click again unscopes');
for (let i = 0; i < 60; i++) CS.player.update(game, 1 / 60);
near(p.fov, 90, 1, 'fov returns to 90');
/* AWP one-shot body kill */
tgt = freshTarget('t');
res = CS.weapons.hit(game, tgt, CS.weapons.defs.awp.damage, p, 'awp', 'body', null);
ok(res.killed === true, 'AWP body shot kills unarmored');

/* --------------------------- viewmodel -------------------------------- */
section('viewmodel');
const drawCalls = [];
const stubRenderer = {
  camera: {},
  drawBox(tex, mat, tint, uv) { drawCalls.push({ tex, mat, tint, uv }); }
};
for (const id of ['usp', 'glock', 'm4a1', 'ak47', 'awp', 'knife']) {
  CS.player.equip(game, id);
  p.drawT = 0;
  p.scoped = false;
  drawCalls.length = 0;
  p.renderViewmodel(stubRenderer);
  const n = drawCalls.length;
  ok(n >= 8 && n <= 14, id + ' viewmodel uses 8..14 boxes (' + n + ')');
  const bad = drawCalls.find(c => !c.mat || c.mat.length !== 16 || !Array.from(c.mat).every(Number.isFinite));
  ok(!bad, id + ' viewmodel matrices finite');
  const allWhite = drawCalls.every(c => c.tex === 'white');
  ok(allWhite, id + ' viewmodel uses white texture + tint');
  /* matrices must place geometry in front of the camera (view-space z < 0) */
  const worldM = M.M4.cameraWorld(p.eye(), p.yaw, p.pitch);
  const viewM = M.M4.invert(worldM);
  const zs = drawCalls.map(c => {
    const pos = M.V3.transformMat4([c.mat[12], c.mat[13], c.mat[14], 1], viewM);
    return pos[2];
  });
  ok(zs.every(z => z < -0.02), id + ' viewmodel parts in front of camera');
}
/* scoped AWP hides the viewmodel */
CS.player.equip(game, 'awp'); p.drawT = 0; p.scoped = true;
drawCalls.length = 0; p.renderViewmodel(stubRenderer);
ok(drawCalls.length === 0, 'scoped AWP hides viewmodel');
p.scoped = false;
/* dead player has no viewmodel */
p.alive = false; drawCalls.length = 0; p.renderViewmodel(stubRenderer);
ok(drawCalls.length === 0, 'dead player has no viewmodel');
p.alive = true;

/* --------------------- long-run random input stress ------------------- */
section('300+ frame stress');
p.alive = true; p.health = 100; p.armor = 50; p.pos = [0, 0, -27];
game.frozen = false;
let shots = 0, steps = 0, errors = 0;
for (let i = 0; i < 400; i++) {
  const r = Math.random();
  game.input.keys = {};
  if (r < 0.6) game.input.keys.KeyW = true;
  if (r < 0.2) game.input.keys.KeyA = true;
  if (r > 0.75) game.input.keys.ShiftLeft = true;
  if (r > 0.9) game.input.keys.ControlLeft = true;
  if (i % 37 === 0) game.input.pressed.jump = true;
  if (i % 23 === 0) game.input.pressed.reload = true;
  if (i % 61 === 0) game.input.pressed.slot1 = true;
  if (i % 67 === 0) game.input.pressed.slot2 = true;
  if (i % 71 === 0) game.input.pressed.slot3 = true;
  if (i % 53 === 0) game.input.rightPressed = true;
  game.input.mouseDown = (i % 7) < 3;
  game.input.mouseDX = (Math.random() - 0.5) * 20;
  game.input.mouseDY = (Math.random() - 0.5) * 10;
  game.input.locked = true;
  try {
    CS.player.update(game, 1 / 60);
  } catch (e) {
    errors++;
    console.log('   update threw at frame ' + i + ': ' + e.stack);
    break;
  }
  const evs2 = drain(game);
  shots += countType(evs2, 'shot');
  steps += countType(evs2, 'step');
  game.input.pressed = {};
  game.input.rightPressed = false;
  game.input.mouseDX = 0; game.input.mouseDY = 0;
}
ok(errors === 0, '400 frames random input without exceptions');
ok([p.pos[0], p.pos[1], p.pos[2], p.yaw, p.pitch, p.health, p.fov, p.spread, p.crosshairSpread].every(Number.isFinite), 'state finite after stress');
ok(p.pos[0] >= -30.01 && p.pos[0] <= 30.01 && p.pos[2] >= -32.01 && p.pos[2] <= 32.01, 'still inside bounds');
ok(p.crosshairSpread >= 0 && p.crosshairSpread <= 1, 'crosshairSpread in 0..1');
ok(p.health >= 0 && p.health <= 100, 'health sane');
ok(shots > 3, 'shots were fired during stress (' + shots + ')');
ok(steps > 0, 'footsteps emitted during stress (' + steps + ')');

/* module-level delegation sanity */
section('module delegation');
ok(CS.player.get() === p, 'CS.player.get() returns instance');
CS.player.equip(game, 'usp');
ok(p.currentDef().id === 'usp', 'CS.player.equip drives the instance');
const px = CS.player.crosshairPixels(game);
ok(px >= 4 && px <= 30, 'crosshairPixels in 4..30 (' + px + ')');
ok(Array.isArray(CS.player.eye()) && CS.player.eye().length === 3, 'CS.player.eye() works');

/* ------------------------------- summary ------------------------------ */
console.log('\n==========================================');
console.log('PASSED: ' + passed + '   FAILED: ' + failed);
if (failed) {
  console.log('FAILURES:');
  for (const f of failures) console.log(' - ' + f);
}
console.log('==========================================');
process.exit(failed ? 1 : 0);
