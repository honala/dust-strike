/* =========================================================================
 * tools/bots-balance.js 鈥?quick numeric balance probe (not part of the game)
 *
 * 1v1 sanity check for CONTRACT 搂11: "normal 涓嬬帺瀹跺簲鐣ュ崰浼樹絾琚泦鐏細姝?.
 *   - duel A: one difficulty bot (AK-47) vs an exposed, stationary player
 *     -> measure time-to-kill / shots / hits.
 *   - duel B: same, but the player shoots back with an M4A1-S at 0.1 s cadence
 *     with a plausible ~35% body / 8% head accuracy -> win rate for the player.
 * Prints averages over 30 trials per difficulty.
 * ========================================================================= */
'use strict';

const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
global.window = global;
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', 'math.js'), 'utf8'));
const CS = global.CS;

const DEFS = {
  knife: { id: 'knife', name: 'k', slot: 'knife', damage: 55, headshot: 1.6, rpm: 120, mag: 0, reserve: 0, range: 2, auto: false, reloadTime: 1, drawTime: 0.4 },
  usp: { id: 'usp', name: 'usp', slot: 'secondary', damage: 30, headshot: 3.2, rpm: 350, mag: 12, reserve: 100, range: 55, auto: false, reloadTime: 2.2, drawTime: 0.5 },
  glock: { id: 'glock', name: 'glock', slot: 'secondary', damage: 26, headshot: 3.0, rpm: 400, mag: 20, reserve: 120, range: 60, auto: false, reloadTime: 2.0, drawTime: 0.5 },
  m4a1: { id: 'm4a1', name: 'm4', slot: 'primary', damage: 33, headshot: 3.8, rpm: 600, mag: 30, reserve: 90, range: 80, auto: true, reloadTime: 3.1, drawTime: 0.7 },
  ak47: { id: 'ak47', name: 'ak', slot: 'primary', damage: 36, headshot: 3.9, rpm: 600, mag: 30, reserve: 90, range: 80, auto: true, reloadTime: 2.9, drawTime: 0.7 },
  awp: { id: 'awp', name: 'awp', slot: 'primary', damage: 115, headshot: 1.5, rpm: 41, mag: 10, reserve: 30, range: 120, auto: false, reloadTime: 3.7, drawTime: 0.9 }
};
CS.weapons = {
  defs: DEFS,
  hitscan: function (game, origin, dir, maxDist, shooter) {
    const list = [];
    for (const b of game.bots) if (b.alive && b !== shooter && b.team !== shooter.team) list.push(b);
    if (game.player && game.player.alive && game.player.team !== shooter.team) list.push(game.player);
    let best = null;
    for (const t of list) {
      const r = t.rayTest ? t.rayTest(origin, dir, maxDist) : null;
      if (r && (!best || r.dist < best.dist)) best = { target: t, point: r.point, zone: r.zone, dist: r.dist };
    }
    return best;
  },
  hit: function (game, target, baseDamage, attacker, weaponId, zone) {
    if (!target || !target.alive || !attacker || target.team === attacker.team) return null;
    const d = DEFS[weaponId] || DEFS.ak47;
    let dmg = baseDamage * (zone === 'head' ? d.headshot : zone === 'legs' ? 0.75 : 1);
    if (target.armor > 0) { dmg *= 0.5; target.armor = Math.max(0, target.armor - baseDamage * 0.5); }
    target.health -= dmg;
    if (typeof game.emit === 'function') game.emit({ type: 'damage', target: target, attacker: attacker, amount: dmg, zone: zone, weapon: weaponId });
    if (target.health <= 0) {
      target.health = 0; target.alive = false;
      if (typeof target.onKilled === 'function') target.onKilled(attacker, weaponId, zone);
      return { killed: true };
    }
    return { killed: false };
  }
};
CS.fx = { tracer() {}, muzzle() {}, impact() {}, blood() {}, shell() {} };

const world = {
  spawns: { ct: [{ pos: [0, 0, -2], yaw: 0 }], t: [{ pos: [0, 0, 15], yaw: Math.PI }] },
  zones: {}, sites: {},
  moveEntity: (p, d) => ({ pos: [p[0] + d[0], 0, p[2] + d[2]], onGround: true, hitWall: false }),
  raycast: () => null,
  los: () => true,
  render() {}
};
world.nav = {
  cell: 0.75, isWalkable: () => true,
  findPath: (sx, sz, tx, tz) => [[tx, tz]],
  nearestWalkable: (x, z) => [x, z],
  randomPointInZone: (n) => {
    const z = { siteA: [-16, -6], siteB: [16, -4], mid: [0, 0], tSpawn: [0, 24], ctSpawn: [0, -24], longA: [-22, 10], longB: [22, 10], tunnels: [-8, 12] }[n];
    return z ? z.slice() : [0, 0];
  },
  randomPoint: () => [0, 0]
};
CS.world = world;

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js', 'bots.js'), 'utf8'));

function makePlayer() {
  return {
    team: 'ct', name: 'player', pos: [0, 0, 0], vel: [0, 0, 0], yaw: Math.PI, pitch: 0,
    health: 100, armor: 100, alive: true, kills: 0, deaths: 0,
    eye() { return [this.pos[0], 1.62, this.pos[2]]; },
    rayTest(o, d, m) {
      if (!this.alive) return null;
      const boxes = [
        { min: [-0.16, 1.50, -0.16], max: [0.16, 1.84, 0.16], zone: 'head' },
        { min: [-0.26, 0.82, -0.20], max: [0.26, 1.50, 0.20], zone: 'body' },
        { min: [-0.24, 0.02, -0.18], max: [0.24, 0.82, 0.18], zone: 'legs' }
      ];
      let best = null;
      for (const b of boxes) {
        const t = CS.math.rayAABB(o, d, b.min, b.max, m || 200);
        if (t >= 0 && (!best || t < best.dist)) best = { dist: t, point: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t], zone: b.zone };
      }
      return best;
    },
    onKilled() { this.alive = false; }
  };
}

function makeGame(diff) {
  const g = {
    renderer: { drawBox() {}, drawShadow() {}, camera: { eye: [0, 1.62, 0] } },
    player: makePlayer(),
    bots: [],
    settings: { difficulty: diff, fov: 90 },
    events: [], rules: null, frozen: false, time: 0, frame: 0,
    emit(e) { this.events.push(e); }
  };
  CS.bots.init(g);
  return g;
}

function duel(diff, playerShootsBack, trials) {
  const res = {
    n: trials, playerWins: 0, botWins: 0, ties: 0,
    deaths: 0, tkSum: 0, shotSum: 0, hitSum: 0,
    playerShots: 0, playerHits: 0
  };
  for (let k = 0; k < trials; k++) {
    const g = makeGame(diff);
    const bot = g.bots.find(b => b.team === 't');
    // deactivate everyone else, put the duel bot 15 m in front of the player
    for (const b of g.bots) if (b !== bot) { b.alive = false; b.pos = [50, 0, 50]; }
    bot.pos = [0, 0, 15];
    bot.yaw = 0; // face the player (-Z)
    bot.loadout = { primary: 'ak47', secondary: 'glock', knife: 'knife' };
    bot.ammoPool = { ak47: { mag: 30, reserve: 90 }, glock: { mag: 20, reserve: 120 }, knife: { mag: 0, reserve: 0 } };
    bot.weaponId = 'ak47'; bot.def = DEFS.ak47; bot.ammo = bot.ammoPool.ak47;
    bot.reloading = false; bot.drawT = 0; bot.fireT = 0; bot.burstLeft = 0; bot.burstPause = 0;
    bot.state = 'rotate'; bot.path = null; bot.goal = null; bot.target = null; bot.reactionT = 0;

    const p = g.player;
    let t = 0, playerShots = 0, playerHits = 0, playerFireT = 0.35;
    const dt = 1 / 60;
    let botShots = 0, botHits = 0;
    while (t < 12) {
      t += dt;
      CS.bots.update(g, dt);
      for (const e of g.events) {
        if (e.type === 'shot' && !e.byPlayer) botShots++;
        if (e.type === 'damage' && e.target === p) botHits++;
      }
      g.events.length = 0;
      if (playerShootsBack && p.alive) {
        playerFireT -= dt;
        if (playerFireT <= 0) {
          playerFireT = 0.1;
          playerShots++;
          const dist = CS.math.dist2D(p.pos[0], p.pos[2], bot.pos[0], bot.pos[2]);
          const hitChance = 0.35 * CS.math.clamp(1 - (dist - 12) / 30, 0.5, 1.1);
          if (Math.random() < hitChance) {
            playerHits++;
            const head = Math.random() < 0.08;
            CS.weapons.hit(g, bot, 33, p, 'm4a1', head ? 'head' : 'body', null);
          }
        }
      }
      if (!p.alive || !bot.alive) break;
    }
    res.playerShots += playerShots;
    res.playerHits += playerHits;
    if (!p.alive && !bot.alive) { res.ties++; }
    else if (!p.alive) {
      res.botWins++; res.deaths++;
      res.tkSum += t; res.shotSum += botShots; res.hitSum += botHits;
    } else if (!bot.alive) { res.playerWins++; }
    else { res.ties++; }
  }
  res.winRate = res.playerWins / trials;
  res.killRate = res.deaths / trials;
  res.avgTk = res.deaths ? res.tkSum / res.deaths : NaN;
  res.avgShots = res.deaths ? res.shotSum / res.deaths : NaN;
  res.avgHits = res.deaths ? res.hitSum / res.deaths : NaN;
  res.avgPlayerShots = res.playerShots / trials;
  res.avgPlayerHits = res.playerHits / trials;
  return res;
}

for (const diff of ['easy', 'normal', 'hard']) {
  const a = duel(diff, false, 30);
  const b = duel(diff, true, 30);
  console.log(`${diff.padEnd(6)} exposed: killRate=${(a.killRate * 100).toFixed(0)}% TTK=${a.avgTk.toFixed(2)}s botShots=${a.avgShots.toFixed(1)} botHits=${a.avgHits.toFixed(1)} (${(a.avgHits / a.avgShots * 100).toFixed(0)}%)` +
    ` | duel: playerWin=${(b.winRate * 100).toFixed(0)}% playerShots=${b.avgPlayerShots.toFixed(1)} playerHits=${b.avgPlayerHits.toFixed(1)} botTTK=${b.avgTk.toFixed(2)}s`);
}
