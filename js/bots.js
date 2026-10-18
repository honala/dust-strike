/* =========================================================================
 * DUST STRIKE — bot AI / box-man models  (CONTRACT.md §11)
 *
 * 5v5: player (CT) + 4 CT bots  vs  5 T bots.
 *   CT teammates : Rex, Nova, Falcon, Echo
 *   T enemies    : Viper, Boris, Kane, Yuri, Stitch
 *
 * Public API (exactly §11):
 *   CS.bots.init(game) -> bots[]        (creates 9 bots, sets game.bots)
 *   CS.bots.spawnRound(game)            (rules calls this on round start)
 *   CS.bots.update(game, dt)
 *   CS.bots.render(game)
 *   bot.rayTest(origin, dir, maxDist)
 *   bot.onKilled(attacker, weaponId, zone)
 * Extra helpers (not in contract, harmless):
 *   CS.bots.list                        (same array as game.bots)
 *   CS.bots.resetStats(game)            (new match: K/D back to 0)
 *   CS.bots.names                       (debug)
 *
 * CONTRACT-GAP notes:
 *  - K/D counters: §12 says rules owns kill bookkeeping for player+bot. bots.js
 *    therefore does NOT increment kills/deaths in onKilled; CS.rules is expected
 *    to do it from the 'kill' event. CS.bots.resetStats() is provided for a new
 *    match.
 *  - Gunshot hearing: §11 asks bots to "hear" shot events, but main only forwards
 *    events to rules/hud/audio. bots.js therefore scans game.events for player
 *    shots (byPlayer:true) and broadcasts bot gunshots through its own internal
 *    hearing system. No changes to main.js are required.
 *  - Freeze during buy/roundEnd: Lead's integration contract sets game.frozen
 *    (true during buy/roundEnd/matchEnd, false during live). update() only
 *    moves/shoots while !game.frozen; as a fallback it also honours
 *    rules.state.phase !== 'live' when game.frozen is absent. If neither field
 *    exists (isolated tests) bots are considered live.
 *  - CT spawn indices: Lead asked CT bots to use world.spawns.ct[0..3] while
 *    CONTRACT §12 puts the player on ct spawn[0]. To avoid a stacked spawn, if
 *    the player starts within 1.2 m of the indexed CT point the bot falls back
 *    to the 5th CT spawn (when one exists).
 *  - Weapon defs: bots read CS.weapons.defs; a local fallback table with the
 *    contract §9 numbers is used only if weapons.js is absent/broken, so bots
 *    never hard-crash during integration.
 *  - CS.weapons.hitscan/hit are reused; tiny local fallbacks exist for the same
 *    reason (integration safety), never used when combat module works.
 *  - nav.findPath returns [[x,z],...]; bots switch waypoints at 0.7 m (task spec,
 *    §11 text says 0.6 — 0.7 used).
 *  - Bots spawn with 100 armor every round (they have no economy; keeps a normal
 *    1v1 slightly player-favoured but a 2-3 bot focus lethal).
 *  - drawBox matrix lifetime: render() reuses a pooled ring of Float32Array
 *    matrices / tint arrays per frame. This relies on renderer.drawBox consuming
 *    the matrix synchronously within beginFrame()..endFrame() (the transparent
 *    queue in §5 is only for beam/sprite). If renderer ever defers box draws past
 *    endFrame, ping bots to switch to per-draw allocation.
 * ========================================================================= */
(function () {
  'use strict';

  var CS = window.CS = window.CS || {};
  var M = CS.math;
  if (!M) {
    // math.js is a hard dependency (load order is guaranteed in index.html).
    if (window.console) console.warn('[bots] CS.math missing — bots disabled');
    return;
  }

  var bots = CS.bots = CS.bots || {};
  var PI = Math.PI, TAU = PI * 2;
  var clamp = M.clamp, lerp = M.lerp, rand = M.rand, randInt = M.randInt, choice = M.choice;
  var dist2D = M.dist2D, normAng = M.normalizeAngle, angDiff = M.angleDiff, moveAngle = M.moveAngle;
  var approach = M.approach, M4 = M.M4, V3 = M.V3;

  /* ----------------------------- constants ------------------------------ */
  var RADIUS = 0.32;       // collision radius
  var HEIGHT = 1.8;        // standing height
  var EYE = 1.62;          // eye height
  var SIGHT_RANGE = 45;    // max sight distance (m)
  var FOV = 65 * PI / 180; // horizontal half-FOV
  var STEP_STRIDE = 2.4;   // metres per footstep event
  var GRAVITY = 16;

  var RUN_SPEED = { easy: 4.0, normal: 4.5, hard: 4.9 }; // m/s out of combat

  // §11 difficulty table (reaction seconds, aim error radians, burst shots...)
  var DIFFICULTY = {
    easy: {
      reaction: 0.40, aimErr: 0.060, burst: [2, 4], burstPause: [0.40, 0.85],
      turn: 5.5, speedMul: 0.94, lead: 0.35, strafe: 0.55
    },
    normal: {
      reaction: 0.26, aimErr: 0.040, burst: [3, 6], burstPause: [0.30, 0.62],
      turn: 8.5, speedMul: 1.0, lead: 0.6, strafe: 0.85
    },
    hard: {
      reaction: 0.16, aimErr: 0.020, burst: [4, 8], burstPause: [0.20, 0.45],
      turn: 12.0, speedMul: 1.06, lead: 0.95, strafe: 1.0
    }
  };
  var curDiff = DIFFICULTY.normal;   // resolved every update from settings.difficulty
  var curDiffName = 'normal';

  var CT_NAMES = ['Rex', 'Nova', 'Falcon', 'Echo'];
  var T_NAMES = ['Viper', 'Boris', 'Kane', 'Yuri', 'Stitch'];

  // §9 weapon table fallback (only used if CS.weapons.defs is missing).
  var FALLBACK_DEFS = {
    knife: { id: 'knife', name: '匕首', slot: 'knife', price: 0, damage: 55, headshot: 1.6, rpm: 120, mag: 0, reserve: 0, range: 2.0, auto: false, reloadTime: 1.0, drawTime: 0.4, kick: 0.1, spread: [0, 0, 0], recoil: { v: 0, h: 0 }, sound: 'knife_swing' },
    usp: { id: 'usp', name: 'USP-S', slot: 'secondary', price: 200, damage: 30, headshot: 3.2, rpm: 350, mag: 12, reserve: 100, range: 55, auto: false, reloadTime: 2.2, drawTime: 0.5, kick: 0.9, spread: [0.006, 0.02, 0.1], recoil: { v: 1.1, h: 0.4 }, sound: 'usp' },
    glock: { id: 'glock', name: 'Glock-18', slot: 'secondary', price: 200, damage: 26, headshot: 3.0, rpm: 400, mag: 20, reserve: 120, range: 60, auto: false, reloadTime: 2.0, drawTime: 0.5, kick: 0.8, spread: [0.007, 0.02, 0.1], recoil: { v: 1.0, h: 0.4 }, sound: 'glock' },
    m4a1: { id: 'm4a1', name: 'M4A1-S', slot: 'primary', price: 2900, damage: 33, headshot: 3.8, rpm: 600, mag: 30, reserve: 90, range: 80, auto: true, reloadTime: 3.1, drawTime: 0.7, kick: 0.5, spread: [0.004, 0.02, 0.12], recoil: { v: 0.8, h: 0.35 }, sound: 'm4a1' },
    ak47: { id: 'ak47', name: 'AK-47', slot: 'primary', price: 2700, damage: 36, headshot: 3.9, rpm: 600, mag: 30, reserve: 90, range: 80, auto: true, reloadTime: 2.9, drawTime: 0.7, kick: 0.6, spread: [0.005, 0.022, 0.13], recoil: { v: 1.0, h: 0.45 }, sound: 'ak47' },
    awp: { id: 'awp', name: 'AWP', slot: 'primary', price: 4750, damage: 115, headshot: 1.5, rpm: 41, mag: 10, reserve: 30, range: 120, auto: false, reloadTime: 3.7, drawTime: 0.9, kick: 1.8, spread: [0.001, 0.05, 0.2], recoil: { v: 2.2, h: 0.6 }, sound: 'awp' }
  };

  // Fallback zone points (contract §8 map coordinates) if world/nav is absent.
  var FALLBACK_ZONES = {
    tSpawn: [0, 26], ctSpawn: [0, -26], mid: [0, 0],
    siteA: [-17, -6], siteB: [17, -4], longA: [-24, 10], longB: [24, 10], tunnels: [-8, 14]
  };

  /* ------------------------- team colour palettes ----------------------- */
  var CT_PALETTE = {
    uniform: [0.20, 0.24, 0.31], uniformDark: [0.14, 0.17, 0.22],
    vest: [0.11, 0.14, 0.19], head: [0.13, 0.16, 0.21], skin: [0.74, 0.58, 0.46],
    glove: [0.09, 0.10, 0.12], boot: [0.09, 0.09, 0.11], accent: [0.34, 0.55, 0.86]
  };
  var T_PALETTE = {
    uniform: [0.52, 0.41, 0.24], uniformDark: [0.39, 0.31, 0.19],
    vest: [0.29, 0.23, 0.14], head: [0.48, 0.17, 0.13], skin: [0.71, 0.53, 0.40],
    glove: [0.12, 0.10, 0.08], boot: [0.12, 0.09, 0.07], accent: [0.80, 0.26, 0.16]
  };
  var GUN_METAL = [0.13, 0.13, 0.15];
  var GUN_METAL_LIGHT = [0.20, 0.20, 0.23];
  var GUN_WOOD = [0.36, 0.22, 0.11];
  var GUN_AWP = [0.22, 0.25, 0.18];
  var KNIFE_BLADE = [0.62, 0.64, 0.68];

  /* ---------------------------- module state ---------------------------- */
  var LIST = [];                       // all bots, same reference as game.bots
  var roundPlan = null;                // per-round team plan
  var lastEventRef = null;             // last processed game.events entry
  var warned = {};                     // one-time warning guards

  // matrix / tint pools for render (see CONTRACT-GAP about drawBox lifetime)
  var MAT_POOL = null, MAT_IDX = 0;
  var TINT_POOL = null, TINT_IDX = 0;
  var MAT_POOL_LEN = 400;
  var RB = [0, 0, 0, 0, 0, 0, 0, 0, 0]; // scratch rotation basis reused per bot

  function warnOnce(key, msg) {
    if (warned[key]) return;
    warned[key] = true;
    if (window.console) console.warn('[bots] ' + msg);
  }

  function emit(game, ev) {
    if (game && typeof game.emit === 'function') {
      try { game.emit(ev); } catch (e) { warnOnce('emit', 'game.emit threw: ' + e); }
    }
  }

  function safeFx(name) {
    var F = CS.fx;
    if (!F) return;
    var fn = F[name];
    if (typeof fn !== 'function') return;
    var args = Array.prototype.slice.call(arguments, 1);
    try { fn.apply(F, args); } catch (e) { warnOnce('fx-' + name, 'CS.fx.' + name + ' threw: ' + e); }
  }

  function enemyEye(unit) {
    if (unit && typeof unit.eye === 'function') {
      try { return unit.eye(); } catch (e) { /* fall through */ }
    }
    var p = unit.pos || [0, 0, 0];
    return [p[0], p[1] + EYE, p[2]];
  }

  function botEye(bot) { return [bot.pos[0], bot.pos[1] + EYE, bot.pos[2]]; }

  function horizontalLen(dx, dz) { return Math.sqrt(dx * dx + dz * dz); }

  /* pseudo-gaussian, roughly [-2.5,2.5] with unit standard deviation */
  function gauss() {
    var v = (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 0.57735;
    return v < -2.5 ? -2.5 : (v > 2.5 ? 2.5 : v);
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0;
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function weaponDef(id) {
    var W = CS.weapons;
    if (W && W.defs && W.defs[id]) return W.defs[id];
    if (!W || !W.defs) warnOnce('defs', 'CS.weapons.defs missing — using built-in fallback weapon table');
    return FALLBACK_DEFS[id] || FALLBACK_DEFS.ak47;
  }

  function defAmmo(d) {
    return { mag: (d && d.mag) || 0, reserve: (d && d.reserve) || 0 };
  }

  function isLive(game) {
    if (!game) return false;
    // Lead integration: game.frozen true during buy / roundEnd / matchEnd
    if (typeof game.frozen === 'boolean') return !game.frozen;
    var rules = game.rules;
    if (!rules || !rules.state) return true; // isolated test / early integration
    var phase = rules.state.phase;
    return !phase || phase === 'live';
  }

  function readDifficulty(game) {
    var name = 'normal';
    try {
      if (game && game.settings && game.settings.difficulty) name = game.settings.difficulty;
    } catch (e) { /* ignore */ }
    if (!DIFFICULTY[name]) name = 'normal';
    if (name !== curDiffName) curDiffName = name;
    curDiff = DIFFICULTY[name];
    return curDiff;
  }

  /* ===================================================================== *
   *  BOT CREATION
   * ===================================================================== */
  function makeColors(team, index) {
    var pal = team === 'ct' ? CT_PALETTE : T_PALETTE;
    var c = {};
    var jitter = (index % 3) * 0.035 - 0.035;
    for (var k in pal) {
      if (!Object.prototype.hasOwnProperty.call(pal, k)) continue;
      var src = pal[k];
      c[k] = [clamp(src[0] + jitter, 0, 1), clamp(src[1] + jitter, 0, 1), clamp(src[2] + jitter, 0, 1)];
    }
    // per-bot skin variation
    var sk = rand(-0.05, 0.05);
    c.skin = [clamp(c.skin[0] + sk, 0, 1), clamp(c.skin[1] + sk * 0.9, 0, 1), clamp(c.skin[2] + sk * 0.8, 0, 1)];
    return c;
  }

  function createBot(id, name, team, teamIndex) {
    var b = {
      id: id,
      name: name,
      team: team,               // 'ct' | 't'
      teamIndex: teamIndex,     // index inside its team (0..4)
      pos: [0, 0, 0],           // feet position
      vel: [0, 0, 0],
      yaw: team === 't' ? PI : 0,
      pitch: 0,

      health: 100,
      maxHealth: 100,
      armor: 100,
      alive: true,
      onGround: true,

      def: FALLBACK_DEFS.usp,   // current weapon definition
      weaponId: 'usp',
      loadout: { primary: null, secondary: 'usp', knife: 'knife' },
      ammo: { mag: 12, reserve: 100 }, // current weapon ammo (also ref'd by ammoPool)
      ammoPool: {},
      reloading: false,
      reloadT: 0,
      drawT: 0,

      state: 'spawn',           // spawn|rotate|engage|hunt|death
      path: null,               // [[x,z],...]
      pathIdx: 0,
      repathT: 0,
      target: null,             // current visible enemy unit
      lastSeen: null,           // [x,y,z] where an enemy was last seen
      lastSeenT: 0,
      targetVisible: false,
      reactionT: 0,

      kills: 0,
      deaths: 0,
      skill: 0.6,               // 0..1, adds per-bot variance

      route: [],
      routeIdx: 0,
      goal: null,               // [x,z] current nav goal
      homeZone: 'mid',
      site: 'A',
      holdT: 0,
      arrived: false,
      scanT: 0,
      lookYaw: 0,
      investigate: null,

      heardPos: null,
      heardT: 0,
      alertT: 0,

      fireT: 0,
      burstLeft: 0,
      burstPause: 0,
      recoil: 0,
      aimReady: false,
      headAimBias: rand(0.05, 0.25), // chance to aim at head instead of chest

      strafeT: 0,
      strafeDir: Math.random() < 0.5 ? 1 : -1,

      moveSpeed: 0,
      walkPhase: rand(0, TAU),
      animT: rand(0, 10),
      stepAcc: 0,
      stuckT: 0,
      stuckAcc: 0,
      stuckMoved: 0,
      stuckCount: 0,
      wallT: 0,

      deathT: 0,
      deathDir: Math.random() < 0.5 ? 1 : -1,
      deathYawOff: rand(-0.6, 0.6),
      deathFall: 0,
      killer: null,

      colors: makeColors(team, teamIndex),
      _rb: new Float32Array(9)
    };

    b.eye = function () { return [b.pos[0], b.pos[1] + EYE, b.pos[2]]; };
    b.rayTest = function (origin, dir, maxDist) { return rayTestBot(b, origin, dir, maxDist); };
    b.onKilled = function (attacker, weaponId, zone) { onBotKilled(b, attacker, weaponId, zone); };
    b.currentDef = function () { return b.def; };
    return b;
  }

  /* ===================================================================== *
   *  PUBLIC: init / spawnRound
   * ===================================================================== */
  bots.init = function (game) {
    if (!game) {
      warnOnce('init', 'init(game) called without game');
      return [];
    }
    LIST.length = 0;
    var id = 1;
    for (var i = 0; i < CT_NAMES.length; i++) LIST.push(createBot(id++, CT_NAMES[i], 'ct', i));
    for (var j = 0; j < T_NAMES.length; j++) LIST.push(createBot(id++, T_NAMES[j], 't', j));
    bots.list = LIST;
    bots.names = { ct: CT_NAMES.slice(), t: T_NAMES.slice() };
    game.bots = LIST;
    bots.spawnRound(game); // place at spawns immediately (safe: rules may call it again)
    return LIST;
  };

  bots.resetStats = function (game) {
    for (var i = 0; i < LIST.length; i++) {
      LIST[i].kills = 0;
      LIST[i].deaths = 0;
    }
  };

  function teamLists() {
    var ct = [], t = [];
    for (var i = 0; i < LIST.length; i++) {
      if (LIST[i].team === 'ct') ct.push(LIST[i]); else t.push(LIST[i]);
    }
    return { ct: ct, t: t };
  }

  function zonePoint(game, name) {
    var w = CS.world;
    var nav = w && w.nav;
    if (nav && typeof nav.randomPointInZone === 'function') {
      try {
        var p = nav.randomPointInZone(name);
        if (p && p.length >= 2 && isFinite(p[0]) && isFinite(p[1])) return [p[0], p[1]];
      } catch (e) { warnOnce('zone-' + name, 'nav.randomPointInZone threw'); }
    }
    if (w && w.zones && w.zones[name] && w.zones[name].points && w.zones[name].points.length) {
      var pt = choice(w.zones[name].points);
      if (pt && pt.length >= 2) return [pt[0], pt[1]];
    }
    if (w && w.sites) {
      if (name === 'siteA' && w.sites.A && w.sites.A.center) return [w.sites.A.center[0], w.sites.A.center[1]];
      if (name === 'siteB' && w.sites.B && w.sites.B.center) return [w.sites.B.center[0], w.sites.B.center[1]];
    }
    var fb = FALLBACK_ZONES[name];
    if (fb) return [fb[0] + rand(-2, 2), fb[1] + rand(-2, 2)];
    return [0, 0];
  }

  function spawnFor(game, team, teamIndex) {
    var w = CS.world;
    var arr = w && w.spawns && w.spawns[team];
    if (arr && arr.length) {
      var s = arr[teamIndex % arr.length];
      if (s && s.pos && s.pos.length >= 3) {
        var yaw = (typeof s.yaw === 'number') ? s.yaw : null;
        return { pos: [s.pos[0], s.pos[1] || 0, s.pos[2]], yaw: yaw };
      }
    }
    // fallback spawn rows (should never be used once world.js is ready)
    var z = team === 'ct' ? -26 : 26;
    var x = -6 + (teamIndex % 5) * 3;
    return { pos: [x, 0, z + (teamIndex * 0.15)], yaw: null };
  }

  function faceYawFrom(x, z, tx, tz) {
    return Math.atan2(tx - x, -(tz - z));
  }

  function resetBotForRound(game, bot, spawn) {
    bot.pos = [spawn.pos[0], spawn.pos[1] || 0, spawn.pos[2]];
    bot.vel = [0, 0, 0];
    bot.yaw = (spawn.yaw !== null && spawn.yaw !== undefined) ? spawn.yaw : faceYawFrom(bot.pos[0], bot.pos[2], 0, 0);
    bot.pitch = 0;
    bot.aimYaw = bot.yaw;
    bot.health = bot.maxHealth = 100;
    bot.armor = 100;
    bot.alive = true;
    bot.onGround = true;
    bot.reloading = false;
    bot.reloadT = 0;
    bot.drawT = 0;
    bot.fireT = rand(0.1, 0.5);
    bot.burstLeft = 0;
    bot.burstPause = 0;
    bot.recoil = 0;
    bot.reactionT = 0;
    bot.state = 'spawn';
    bot.path = null;
    bot.pathIdx = 0;
    bot.repathT = 0;
    bot.target = null;
    bot.lastSeen = null;
    bot.lastSeenT = 0;
    bot.targetVisible = false;
    bot.route = [];
    bot.routeIdx = 0;
    bot.goal = null;
    bot.holdT = 0;
    bot.arrived = false;
    bot.scanT = rand(0, 4);
    bot.investigate = null;
    bot.heardPos = null;
    bot.heardT = 0;
    bot.alertT = 0;
    bot.moveSpeed = 0;
    bot.walkPhase = rand(0, TAU);
    bot.stepAcc = 0;
    bot.stuckT = 0; bot.stuckAcc = 0; bot.stuckMoved = 0; bot.stuckCount = 0; bot.wallT = 0;
    bot.deathT = 0;
    bot.deathFall = 0;
    bot.deathDir = Math.random() < 0.5 ? 1 : -1;
    bot.deathYawOff = rand(-0.6, 0.6);
    bot.killer = null;
    bot.aimReady = false;
    bot.skill = clamp(0.38 + (curDiffName === 'easy' ? 0 : curDiffName === 'hard' ? 0.36 : 0.18) + rand(-0.09, 0.09), 0.15, 0.95);
  }

  function pickWeaponId(game, bot, tBots) {
    var secondary = bot.team === 't' ? 'glock' : 'usp';
    var primary = bot.team === 't' ? 'ak47' : 'm4a1';
    var r = Math.random();
    // at most one AWP per team
    var awpTaken = false;
    for (var i = 0; i < LIST.length; i++) {
      if (LIST[i] !== bot && LIST[i].team === bot.team && LIST[i].loadout && LIST[i].loadout.primary === 'awp') awpTaken = true;
    }
    if (r < 0.13 && !awpTaken) return 'awp';
    if (r > 0.94) return secondary; // occasional pistol-only "eco" bot
    return primary;
  }

  function equip(bot, id) {
    var d = weaponDef(id);
    bot.weaponId = id;
    bot.def = d;
    if (!bot.ammoPool[id]) bot.ammoPool[id] = defAmmo(d);
    bot.ammo = bot.ammoPool[id];
    bot.reloading = false;
    bot.reloadT = 0;
    bot.burstLeft = 0;
    bot.burstPause = 0;
    bot.fireT = 0;
    bot.drawT = (d && d.drawTime) || 0.5;
  }

  function setupWeapons(game, bot) {
    var secondary = bot.team === 't' ? 'glock' : 'usp';
    var primary = bot.team === 't' ? 'ak47' : 'm4a1';
    var id = pickWeaponId(game, bot, null);
    bot.ammoPool = {
      secondary: defAmmo(weaponDef(secondary)),
      knife: { mag: 0, reserve: 0 }
    };
    if (id === 'awp') {
      bot.loadout = { primary: 'awp', secondary: secondary, knife: 'knife' };
      bot.ammoPool.awp = defAmmo(weaponDef('awp'));
    } else if (id === primary) {
      bot.loadout = { primary: primary, secondary: secondary, knife: 'knife' };
      bot.ammoPool[primary] = defAmmo(weaponDef(primary));
    } else {
      bot.loadout = { primary: null, secondary: secondary, knife: 'knife' };
    }
    equip(bot, id);
    bot.reloading = false;
    bot.drawT = 0;    // bots don't play the draw animation on spawn
    bot.fireT = rand(0.15, 0.6);
  }

  function planRound(game) {
    var tl = teamLists();
    roundPlan = {
      site: Math.random() < 0.5 ? 'A' : 'B',
      tMid: {},
      ctRoles: {}
    };
    if (tl.t.length) {
      var order = [];
      for (var i = 0; i < tl.t.length; i++) order.push(i);
      shuffle(order);
      var midCount = tl.t.length >= 3 ? 2 : 1;
      for (var k = 0; k < order.length; k++) roundPlan.tMid[order[k]] = k < midCount;
    }
    var ctRoles = Math.random() < 0.5 ? ['A', 'A', 'B', 'mid'] : ['A', 'B', 'B', 'mid'];
    shuffle(ctRoles);
    for (var c = 0; c < tl.ct.length; c++) roundPlan.ctRoles[c] = ctRoles[c % ctRoles.length];
  }

  function assignRoutes(game) {
    var tl = teamLists();
    var plan = roundPlan;
    var tSiteZone = plan.site === 'A' ? 'siteA' : 'siteB';
    var tLongZone = plan.site === 'A' ? 'longA' : 'longB';

    for (var i = 0; i < tl.t.length; i++) {
      var b = tl.t[i];
      b.site = plan.site;
      var route = [];
      if (plan.tMid[i]) {
        route.push(zonePoint(game, 'mid'));
        route.push(zonePoint(game, tSiteZone));
      } else {
        if (i % 3 === 2) route.push(zonePoint(game, tSiteZone)); // direct push
        else {
          route.push(zonePoint(game, tLongZone));
          route.push(zonePoint(game, tSiteZone));
        }
      }
      b.route = route;
      b.routeIdx = 0;
      b.homeZone = tSiteZone;
    }

    for (var j = 0; j < tl.ct.length; j++) {
      var cb = tl.ct[j];
      var role = plan.ctRoles[j] || 'mid';
      if (role === 'A') { cb.homeZone = 'siteA'; cb.site = 'A'; }
      else if (role === 'B') { cb.homeZone = 'siteB'; cb.site = 'B'; }
      else { cb.homeZone = 'mid'; cb.site = plan.site; }
      cb.route = [zonePoint(game, cb.homeZone)];
      cb.routeIdx = 0;
    }
  }

  bots.spawnRound = function (game) {
    if (!game) return;
    if (!LIST.length) {
      warnOnce('spawn-nolist', 'spawnRound() before init()');
      return;
    }
    if (game.bots !== LIST) game.bots = LIST;
    readDifficulty(game);
    planRound(game);
    var tl = teamLists();
    // Lead integration: CT bots take ct spawns 0..3, T bots t spawns 0..4.
    // (CONTRACT §12 also puts the player on ct spawn[0]; if the player is
    // already standing there, reuse the 5th CT spawn for that bot.)
    var player = game.player;
    var ctSpawnList = (CS.world && CS.world.spawns && CS.world.spawns.ct) || null;
    var ctSpawnCount = ctSpawnList ? ctSpawnList.length : 0;
    for (var i = 0; i < tl.ct.length; i++) {
      var b = tl.ct[i];
      var ctIdx = i;
      var sp = spawnFor(game, 'ct', ctIdx);
      if (player && player.pos && ctSpawnCount > tl.ct.length) {
        var pd = dist2D(sp.pos[0], sp.pos[2], player.pos[0], player.pos[2]);
        if (pd < 1.2) sp = spawnFor(game, 'ct', ctSpawnCount - 1);
      }
      resetBotForRound(game, b, sp);
      setupWeapons(game, b);
    }
    var tSpawnIdx = 0;
    for (var j = 0; j < tl.t.length; j++) {
      var tb = tl.t[j];
      resetBotForRound(game, tb, spawnFor(game, 't', tSpawnIdx++));
      setupWeapons(game, tb);
    }
    assignRoutes(game);
  };

  /* ===================================================================== *
   *  KILL / DEATH
   * ===================================================================== */
  function onBotKilled(bot, attacker, weaponId, zone) {
    if (!bot.alive) return;
    bot.alive = false;
    bot.health = 0;
    bot.state = 'death';
    bot.deathT = 0;
    bot.deathFall = 0;
    bot.deathDir = Math.random() < 0.5 ? 1 : -1;
    bot.vel[0] = bot.vel[1] = bot.vel[2] = 0;
    bot.target = null;
    bot.targetVisible = false;
    bot.path = null;
    bot.goal = null;
    bot.reloading = false;
    bot.reloadT = 0;
    bot.fireT = 0;
    bot.killer = attacker ? (attacker.name || '?') : null;
    // K/D counters are owned by CS.rules (§12 kill handler) — not touched here.
  }

  /* ===================================================================== *
   *  RAY TEST (used by CS.weapons.hitscan for player/bot bullets)
   * ===================================================================== */
  function rayTestBot(bot, origin, dir, maxDist) {
    if (!bot || !bot.alive) return null;
    if (!origin || !dir) return null;
    var maxD = (typeof maxDist === 'number' && maxDist > 0) ? maxDist : 200;
    var x = bot.pos[0], y = bot.pos[1], z = bot.pos[2];
    var best = null;
    var boxes = [
      { min: [x - 0.16, y + 1.50, z - 0.16], max: [x + 0.16, y + 1.84, z + 0.16], zone: 'head' },
      { min: [x - 0.26, y + 0.82, z - 0.20], max: [x + 0.26, y + 1.50, z + 0.20], zone: 'body' },
      { min: [x - 0.24, y + 0.02, z - 0.18], max: [x + 0.24, y + 0.82, z + 0.18], zone: 'legs' }
    ];
    for (var i = 0; i < boxes.length; i++) {
      var t = M.rayAABB(origin, dir, boxes[i].min, boxes[i].max, maxD);
      if (t >= 0 && t <= maxD && (!best || t < best.dist)) {
        best = {
          dist: t,
          point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
          zone: boxes[i].zone
        };
      }
    }
    return best;
  }

  /* ===================================================================== *
   *  HEARING (gunshots)
   * ===================================================================== */
  function broadcastHearing(game, shooterTeam, pos, radius) {
    if (!pos) return;
    for (var i = 0; i < LIST.length; i++) {
      var b = LIST[i];
      if (!b.alive || b.team === shooterTeam) continue;
      if (b.state === 'engage' || b.state === 'death') continue;
      var dx = b.pos[0] - pos[0], dz = b.pos[2] - pos[2];
      var d = horizontalLen(dx, dz);
      if (d > radius) continue;
      // farther shots are less likely to be noticed
      if (d > 12 && Math.random() > 0.75) continue;
      b.heardPos = [pos[0], pos[2]];
      b.heardT = 3.4;
      b.alertT = Math.max(b.alertT, 1.2);
      if (b.state === 'rotate') {
        setState(game, b, 'hunt');
        b.investigate = [pos[0], pos[2]];
        b.goal = [pos[0], pos[2]];
        b.path = null;
        b.repathT = 0;
      }
    }
  }

  function processPlayerShots(game) {
    var evs = game && game.events;
    if (!evs || !evs.length) { lastEventRef = null; return; }
    var start = 0;
    if (lastEventRef) {
      var idx = -1;
      for (var k = evs.length - 1; k >= 0; k--) { if (evs[k] === lastEventRef) { idx = k; break; } }
      if (idx >= 0) start = idx + 1;
    }
    var player = game.player;
    for (var i = start; i < evs.length; i++) {
      var e = evs[i];
      if (!e || e.type !== 'shot' || !e.byPlayer) continue;
      var pos = e.pos;
      if (!pos && player && player.pos) pos = [player.pos[0], player.pos[1] + EYE, player.pos[2]];
      broadcastHearing(game, 'ct', pos, 34);
    }
    lastEventRef = evs[evs.length - 1];
  }

  /* ===================================================================== *
   *  PERCEPTION
   * ===================================================================== */
  var enemyCache = { ct: [], t: [] };

  function buildEnemyCache(game) {
    enemyCache.ct.length = 0;
    enemyCache.t.length = 0;
    for (var i = 0; i < LIST.length; i++) {
      var b = LIST[i];
      if (!b.alive) continue;
      if (b.team === 't') enemyCache.ct.push(b);       // enemies of CT
      else enemyCache.t.push(b);                        // enemies of T
    }
    var p = game.player;
    if (p && p.alive) enemyCache.t.push(p);             // player is CT
  }

  function enemiesOf(team) { return team === 'ct' ? enemyCache.ct : enemyCache.t; }

  function los(game, a, b) {
    var w = CS.world;
    if (w && typeof w.los === 'function') {
      try { return !!w.los(a, b); } catch (e) { warnOnce('los', 'world.los threw: ' + e); }
    }
    return true;
  }

  function perceive(game, bot, dt) {
    if (bot.alertT > 0) bot.alertT -= dt;
    bot.sightTimer = (bot.sightTimer || 0) - dt;
    if (bot.sightTimer > 0) return;
    bot.sightTimer = 0.09 + Math.random() * 0.06;

    var enemies = enemiesOf(bot.team);
    var myEye = botEye(bot);
    var best = null, bestScore = 1e9;
    var fovLimit = FOV + (bot.state === 'engage' ? 0.7 : 0) + (bot.alertT > 0 ? 1.1 : 0);

    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (!e || !e.alive) continue;
      var dx = e.pos[0] - bot.pos[0], dz = e.pos[2] - bot.pos[2];
      var d = horizontalLen(dx, dz);
      if (d > SIGHT_RANGE) continue;
      var wantYaw = Math.atan2(dx, -dz);
      if (Math.abs(angDiff(bot.yaw, wantYaw)) > fovLimit) continue;
      var eEye = enemyEye(e);
      if (!los(game, myEye, eEye)) continue;
      var score = d - (bot.target === e ? 6 : 0) - (bot.lastSeen && dist2D(bot.lastSeen[0], bot.lastSeen[2], e.pos[0], e.pos[2]) < 3 ? 2 : 0);
      if (score < bestScore) { bestScore = score; best = e; }
    }

    if (best) {
      if (bot.target !== best) {
        var db = curDiff;
        // fresh acquisition costs reaction time (unless we already had someone)
        bot.reactionT = Math.max(bot.reactionT, db.reaction * rand(0.8, 1.25) * (1.3 - bot.skill * 0.5));
        bot.burstLeft = 0;
        bot.burstPause = 0;
        bot.fireT = Math.max(bot.fireT, 0.05);
      }
      bot.target = best;
      bot.lastSeenT = 0;
      if (bot.state !== 'engage') {
        setState(game, bot, 'engage');
        bot.lastSeenT = 0;
      }
    } else if (bot.state === 'engage' && bot.target) {
      // lose the target if we have not seen it for a while (per-frame LOS handles short gaps)
      if (!bot.target.alive) { bot.target = null; }
    }
  }

  /* ===================================================================== *
   *  STATE HELPERS / NAVIGATION
   * ===================================================================== */
  function setState(game, bot, state) {
    if (bot.state === state) return;
    bot.state = state;
    bot.path = null;
    bot.pathIdx = 0;
    bot.repathT = 0;
    bot.stuckT = 0; bot.stuckAcc = 0; bot.stuckMoved = 0; bot.wallT = 0;
    bot.goal = null;
    bot.holdT = 0;
    bot.arrived = false;
    if (state === 'engage') {
      bot.lastSeenT = 0;
    } else if (state === 'death') {
      bot.vel[0] = bot.vel[1] = bot.vel[2] = 0;
    }
  }

  function findPathTo(game, sx, sz, tx, tz) {
    var w = CS.world;
    var nav = w && w.nav;
    if (nav && typeof nav.findPath === 'function') {
      try {
        var p = nav.findPath(sx, sz, tx, tz);
        if (p && p.length) return p;
      } catch (e) { warnOnce('findPath', 'nav.findPath threw: ' + e); }
    }
    return [[tx, tz]];
  }

  function applyMovement(game, bot, dt, desiredVX, desiredVZ, dtScale) {
    if (!dt || dt <= 0) return;
    var ox = bot.pos[0], oz = bot.pos[2];
    var wanted = horizontalLen(desiredVX, desiredVZ);
    // exponential-ish approach of horizontal velocity
    var k = 1 - Math.exp(-11 * dt);
    bot.vel[0] += (desiredVX - bot.vel[0]) * k;
    bot.vel[2] += (desiredVZ - bot.vel[2]) * k;
    bot.vel[1] -= GRAVITY * dt;
    if (bot.vel[1] < -25) bot.vel[1] = -25;

    var delta = [bot.vel[0] * dt, bot.vel[1] * dt, bot.vel[2] * dt];
    var res = null;
    var w = CS.world;
    if (w && typeof w.moveEntity === 'function') {
      try { res = w.moveEntity(bot.pos, delta, RADIUS, HEIGHT); } catch (e) { warnOnce('moveEntity', 'world.moveEntity threw: ' + e); }
    }
    if (res && res.pos) {
      bot.pos = [res.pos[0], res.pos[1], res.pos[2]];
      bot.onGround = !!res.onGround;
      if (res.onGround) bot.vel[1] = 0;
      if (res.hitWall) bot.wallT += dt; else bot.wallT = 0;
    } else {
      bot.pos[0] += delta[0];
      bot.pos[1] = Math.max(0, bot.pos[1] + delta[1]);
      bot.pos[2] += delta[2];
      if (bot.pos[1] <= 0.0001) { bot.pos[1] = 0; bot.vel[1] = 0; bot.onGround = true; }
      bot.wallT = 0;
    }
    if (bot.pos[1] < -2) { bot.pos[1] = 0; bot.vel[1] = 0; } // safety: never fall out of the map

    var moved = dist2D(ox, oz, bot.pos[0], bot.pos[2]);
    bot.moveSpeed = moved / dt;
    bot.walkPhase += bot.moveSpeed * dt * 2.55;

    // footstep events
    if (moved > 0.0005) {
      bot.stepAcc += moved;
      if (bot.stepAcc >= STEP_STRIDE) {
        bot.stepAcc = 0;
        emit(game, { type: 'step', pos: [bot.pos[0], bot.pos[1], bot.pos[2]], byPlayer: false });
      }
    }

    // stuck / wall detection (repath at most once per second)
    bot.stuckT += dt;
    bot.stuckAcc += wanted * dt;
    bot.stuckMoved += moved;
    if (bot.wallT > 0.55) {
      bot.wallT = 0;
      bot.path = null;
      bot.repathT = 0;
    }
    if (bot.stuckT >= 1.0) {
      if (bot.stuckAcc > 0.9 && bot.stuckMoved < 0.25) {
        bot.stuckCount++;
        bot.path = null;
        bot.pathIdx = 0;
        bot.repathT = 0;
        if (bot.goal && bot.stuckCount < 4) {
          bot.goal[0] += rand(-1.6, 1.6);
          bot.goal[1] += rand(-1.6, 1.6);
        }
        if (bot.stuckCount >= 3) {
          // give up on this goal; states will pick another one
          bot.goal = null;
          bot.holdT = 0;
          bot.arrived = true;
          bot.stuckCount = 0;
        }
      } else if (bot.stuckMoved > 0.4) {
        bot.stuckCount = 0;
      }
      bot.stuckT = 0; bot.stuckAcc = 0; bot.stuckMoved = 0;
    }
  }

  function navigateTo(game, bot, dt, tx, tz, speed) {
    bot.repathT -= dt;
    var dGoal = dist2D(bot.pos[0], bot.pos[2], tx, tz);
    if (dGoal < 0.7) {
      bot.path = null;
      bot.pathIdx = 0;
      return true;
    }
    if (!bot.path || bot.pathIdx >= bot.path.length) {
      if (bot.repathT <= 0) {
        bot.path = findPathTo(game, bot.pos[0], bot.pos[2], tx, tz);
        bot.pathIdx = 0;
        bot.repathT = rand(2.2, 3.8);
      } else {
        bot.path = [[tx, tz]];
        bot.pathIdx = 0;
      }
    }
    // advance waypoints (0.7 m switch threshold)
    var guard = 0;
    while (bot.path && bot.pathIdx < bot.path.length && guard++ < 64) {
      var wpt = bot.path[bot.pathIdx];
      if (!wpt || wpt.length < 2) { bot.pathIdx++; continue; }
      if (dist2D(bot.pos[0], bot.pos[2], wpt[0], wpt[1]) < 0.7) bot.pathIdx++;
      else break;
    }
    if (!bot.path || bot.pathIdx >= bot.path.length) {
      bot.path = null;
      return true;
    }
    var wp = bot.path[bot.pathIdx];
    var dx = wp[0] - bot.pos[0], dz = wp[1] - bot.pos[2];
    var len = horizontalLen(dx, dz) || 1;
    applyMovement(game, bot, dt, dx / len * speed, dz / len * speed);
    var moveYaw = Math.atan2(dx, -dz);
    bot.yaw = moveAngle(bot.yaw, moveYaw, 6.5 * dt);
    return false;
  }

  function botRunSpeed(bot) {
    var db = curDiff;
    return (RUN_SPEED[curDiffName] || RUN_SPEED.normal) * db.speedMul * (0.9 + bot.skill * 0.2);
  }

  function botCombatSpeed(bot) {
    return botRunSpeed(bot) * 0.56;
  }

  /* where a holding bot should look, per zone (covers the usual entrances) */
  var HOLD_LOOK = {
    ct: {
      siteA: [[-25, 7], [-7, 3], [0, -3]],
      siteB: [[25, 7], [7, 3], [0, -3]],
      mid: [[-7, 10], [7, 10], [0, 14]],
      ctSpawn: [[0, -12]]
    },
    t: {
      A: [[-9, -15], [0, -22], [-17, -18], [-26, 2]],
      B: [[9, -15], [0, -22], [17, -18], [26, 2]]
    }
  };

  function setLookDirection(game, bot) {
    var pts;
    if (bot.team === 'ct') {
      pts = HOLD_LOOK.ct[bot.homeZone] || HOLD_LOOK.ct.ctSpawn;
    } else {
      pts = HOLD_LOOK.t[bot.site === 'B' ? 'B' : 'A'];
    }
    var idx = (bot.teamIndex + (Math.random() < 0.35 ? 1 : 0)) % pts.length;
    var p = pts[idx];
    bot.lookYaw = faceYawFrom(bot.pos[0], bot.pos[2], p[0] + rand(-1.2, 1.2), p[1] + rand(-1.2, 1.2));
  }

  function patrolPoint(game, bot) {
    var p;
    if (bot.team === 't') {
      var r = Math.random();
      if (r < 0.42) p = zonePoint(game, bot.homeZone);
      else if (r < 0.72) p = zonePoint(game, 'mid');
      else p = zonePoint(game, 'ctSpawn');
    } else {
      var r2 = Math.random();
      if (r2 < 0.62) p = zonePoint(game, bot.homeZone);
      else if (r2 < 0.84) p = zonePoint(game, 'mid');
      else p = zonePoint(game, bot.homeZone === 'siteA' ? 'siteB' : 'siteA');
    }
    if (dist2D(bot.pos[0], bot.pos[2], p[0], p[1]) < 2.5) {
      p[0] += rand(-4, 4);
      p[1] += rand(-4, 4);
    }
    return p;
  }

  function pickRotateGoal(game, bot) {
    if (bot.route && bot.routeIdx < bot.route.length) {
      bot.goal = bot.route[bot.routeIdx++];
      return true;
    }
    bot.route = null;
    bot.goal = patrolPoint(game, bot);
    return true;
  }

  /* ===================================================================== *
   *  WEAPON / SHOOTING
   * ===================================================================== */
  function startReload(bot) {
    if (bot.reloading) return;
    var d = bot.def;
    if (!d || d.slot === 'knife') return;
    if (!bot.ammo || bot.ammo.reserve <= 0 || bot.ammo.mag >= (d.mag || 0)) return;
    bot.reloading = true;
    bot.reloadT = d.reloadTime || 2.5;
    bot.burstLeft = 0;
    bot.burstPause = 0;
  }

  function finishReload(bot) {
    var d = bot.def;
    if (d && bot.ammo) {
      var need = (d.mag || 0) - bot.ammo.mag;
      var take = Math.min(need, bot.ammo.reserve || 0);
      if (take > 0) {
        bot.ammo.mag += take;
        bot.ammo.reserve -= take;
      }
    }
    bot.reloading = false;
    bot.reloadT = 0;
    bot.burstLeft = 0;
    bot.burstPause = 0;
  }

  function switchFallback(game, bot) {
    var lo = bot.loadout || {};
    var order = [lo.secondary, lo.primary, 'knife'];
    for (var i = 0; i < order.length; i++) {
      var id = order[i];
      if (!id || id === bot.weaponId) continue;
      var pool = bot.ammoPool[id];
      if (id === 'knife' || (pool && (pool.mag > 0 || pool.reserve > 0))) {
        equip(bot, id);
        if (pool) bot.ammo = pool;
        return;
      }
    }
    if (bot.weaponId !== 'knife') equip(bot, 'knife');
  }

  function updateWeapon(game, bot, dt) {
    if (bot.fireT > 0) bot.fireT -= dt;
    if (bot.drawT > 0) bot.drawT -= dt;
    if (bot.burstPause > 0) bot.burstPause -= dt;
    if (bot.reactionT > 0) bot.reactionT = Math.max(0, bot.reactionT - dt);
    if (bot.recoil > 0) bot.recoil = Math.max(0, bot.recoil - dt * 1.7);
    if (bot.reloading) {
      bot.reloadT -= dt;
      if (bot.reloadT <= 0) finishReload(bot);
      return;
    }
    var d = bot.def;
    if (!d || d.slot === 'knife') return;
    var mag = bot.ammo ? bot.ammo.mag : 0;
    if (mag <= 0) {
      if (bot.ammo.reserve > 0) startReload(bot);
      else switchFallback(game, bot);
    } else if (mag < (d.mag || 0) * 0.4 && bot.ammo.reserve > 0 &&
      (!bot.target || !bot.targetVisible)) {
      startReload(bot); // safe reload while not in a firefight
    }
  }

  function currentAimError(bot, dist) {
    var db = curDiff;
    var e = db.aimErr * (1.5 - bot.skill);          // per-bot competence
    var mov = clamp(bot.moveSpeed / 4.5, 0, 1);
    e *= 1 + mov * 0.75 + bot.recoil * 0.5;
    e *= 1 + clamp((dist || 0) / 60, 0, 1) * 0.35;   // slightly worse at range
    return e;
  }

  function fallbackHitscan(game, origin, dir, maxDist, shooter) {
    var wall = null;
    var w = CS.world;
    if (w && typeof w.raycast === 'function') {
      try { wall = w.raycast(origin, dir, maxDist); } catch (e) { wall = null; }
    }
    var wallDist = (wall && typeof wall.dist === 'number') ? wall.dist : maxDist;
    var best = null;
    var enemies = enemiesOf(shooter.team);
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (!e || !e.alive || e === shooter || e.team === shooter.team) continue;
      var r = null;
      if (typeof e.rayTest === 'function') {
        try { r = e.rayTest(origin, dir, Math.min(maxDist, wallDist)); } catch (err) { r = null; }
      } else {
        // unit without rayTest: simple capsule-ish fallback
        var p = e.pos;
        var t = M.raySphere(origin, dir, [p[0], p[1] + 1.0, p[2]], 0.45, Math.min(maxDist, wallDist));
        if (t >= 0) r = { dist: t, point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t], zone: 'body' };
      }
      if (r && (!best || r.dist < best.dist)) best = { target: e, point: r.point, zone: r.zone, dist: r.dist };
    }
    if (best) return best;
    if (wall && wall.dist <= maxDist) {
      return { target: null, point: wall.point, normal: wall.normal, dist: wall.dist };
    }
    return null;
  }

  function fallbackHit(game, target, baseDamage, attacker, weaponId, zone, point) {
    if (!target || !target.alive || !attacker || target.team === attacker.team) return;
    var d = weaponDef(weaponId);
    var dmg = baseDamage * (zone === 'head' ? (d.headshot || 3.8) : zone === 'legs' ? 0.75 : 1);
    if (target.armor > 0) {
      dmg *= 0.5;
      target.armor = Math.max(0, target.armor - baseDamage * 0.5);
    }
    target.health -= dmg;
    emit(game, { type: 'damage', target: target, attacker: attacker, amount: dmg, zone: zone, point: point, weapon: weaponId });
    if (target.health <= 0) {
      target.health = 0;
      target.alive = false;
      emit(game, { type: 'kill', killer: attacker, victim: target, weapon: weaponId, headshot: zone === 'head' });
      if (typeof target.onKilled === 'function') {
        try { target.onKilled(attacker, weaponId, zone); } catch (e) { warnOnce('onKilled', 'onKilled threw: ' + e); }
      }
    }
  }

  function doHitscan(game, origin, dir, maxDist, shooter) {
    var W = CS.weapons;
    if (W && typeof W.hitscan === 'function') {
      try {
        var r = W.hitscan(game, origin, dir, maxDist, shooter);
        if (r !== undefined) return r;
      } catch (e) { warnOnce('hitscan', 'CS.weapons.hitscan threw: ' + e); }
    }
    return fallbackHitscan(game, origin, dir, maxDist, shooter);
  }

  function doHit(game, target, baseDamage, attacker, weaponId, zone, point) {
    var W = CS.weapons;
    if (W && typeof W.hit === 'function') {
      try { W.hit(game, target, baseDamage, attacker, weaponId, zone, point); return; } catch (e) { warnOnce('hit', 'CS.weapons.hit threw: ' + e); }
    }
    fallbackHit(game, target, baseDamage, attacker, weaponId, zone, point);
  }

  function muzzlePos(bot) {
    var eye = botEye(bot);
    var fwd = [Math.sin(bot.yaw) * Math.cos(bot.pitch), Math.sin(bot.pitch), -Math.cos(bot.yaw) * Math.cos(bot.pitch)];
    var right = [Math.cos(bot.yaw), 0, Math.sin(bot.yaw)];
    return [
      eye[0] + fwd[0] * 0.55 + right[0] * 0.16,
      eye[1] + fwd[1] * 0.55 - 0.10,
      eye[2] + fwd[2] * 0.55 + right[2] * 0.16
    ];
  }

  function fireShot(game, bot) {
    var d = bot.def;
    if (!d) return;
    if (!bot.ammo) bot.ammo = { mag: 0, reserve: 0 };
    var dist = 0;
    if (bot.target && bot.target.pos) {
      dist = dist2D(bot.pos[0], bot.pos[2], bot.target.pos[0], bot.target.pos[2]);
    }
    var err = currentAimError(bot, dist);
    var yaw = bot.yaw + gauss() * err;
    var pitch = bot.pitch + gauss() * err * 0.65;
    pitch = clamp(pitch, -1.25, 1.25);
    var dir = M.cameraForward(yaw, pitch);
    var origin = botEye(bot);
    var muzzle = muzzlePos(bot);
    var maxD = d.range || 80;

    var res = doHitscan(game, origin, dir, maxD, bot);
    var endPoint;
    if (res && res.point) {
      endPoint = res.point;
      if (res.target) {
        safeFx('blood', res.point, dir);
        doHit(game, res.target, d.damage, bot, d.id, res.zone, res.point);
      } else {
        safeFx('impact', res.point, res.normal || [0, 1, 0], 'wall');
      }
    } else {
      var far = Math.min(maxD, 60);
      endPoint = [origin[0] + dir[0] * far, origin[1] + dir[1] * far, origin[2] + dir[2] * far];
    }
    safeFx('tracer', muzzle, endPoint, [1.0, 0.86, 0.5]);
    safeFx('muzzle', muzzle, dir, 1);
    if (Math.random() < 0.55) safeFx('shell', muzzle, [Math.cos(bot.yaw), 0.4, Math.sin(bot.yaw)]);

    if (d.slot !== 'knife') bot.ammo.mag = Math.max(0, bot.ammo.mag - 1);
    bot.recoil = Math.min(1.4, bot.recoil + 0.2);
    emit(game, { type: 'shot', weapon: d.id, pos: muzzle, byPlayer: false, attacker: bot });
    broadcastHearing(game, bot.team, muzzle, 36);
  }

  function tryFire(game, bot) {
    var d = bot.def;
    if (!d) return;
    if (bot.reloading || bot.drawT > 0 || bot.fireT > 0 || bot.burstPause > 0) return;
    if (d.slot === 'knife') {
      if (!bot.target || !bot.target.pos) return;
      var kd = dist2D(bot.pos[0], bot.pos[2], bot.target.pos[0], bot.target.pos[2]);
      if (kd > 1.9) return;
    } else if (!bot.ammo || bot.ammo.mag <= 0) {
      return;
    }
    if (!bot.aimReady) return;
    if (bot.reactionT > 0) return;

    if (bot.burstLeft <= 0) {
      if (d.auto) bot.burstLeft = randInt(curDiff.burst[0], curDiff.burst[1] + 1);
      else bot.burstLeft = 1;
    }
    fireShot(game, bot);
    bot.burstLeft--;
    var interval = 60 / (d.rpm || 600);
    if (!d.auto) interval += rand(0.1, 0.35);
    bot.fireT = interval;
    if (bot.burstLeft <= 0) {
      bot.burstPause = rand(curDiff.burstPause[0], curDiff.burstPause[1]);
    }
  }

  function weaponRangePref(d) {
    if (!d) return [8, 24];
    if (d.id === 'awp') return [16, 42];
    if (d.slot === 'secondary') return [6, 16];
    if (d.id === 'knife') return [0, 1.6];
    return [8, 24];
  }

  /* ===================================================================== *
   *  STATE UPDATES
   * ===================================================================== */
  function updateRotate(game, bot, dt) {
    if (bot.holdT > 0) {
      bot.holdT -= dt;
      bot.scanT += dt;
      var want = bot.lookYaw + Math.sin(bot.scanT * 0.65) * 0.38;
      bot.yaw = moveAngle(bot.yaw, want, 2.6 * dt);
      bot.pitch = approach(bot.pitch, 0, 4, dt);
      applyMovement(game, bot, dt, 0, 0);
      if (bot.holdT <= 0) { bot.arrived = false; bot.goal = null; }
      return;
    }
    if (!bot.goal) {
      pickRotateGoal(game, bot);
      bot.arrived = false;
    }
    if (!bot.goal) return;
    var speed = botRunSpeed(bot);
    // slow down when close to the objective to "clear angles"
    var dGoal = dist2D(bot.pos[0], bot.pos[2], bot.goal[0], bot.goal[1]);
    if (dGoal < 7) speed *= 0.62;
    var arrived = navigateTo(game, bot, dt, bot.goal[0], bot.goal[1], speed);
    if (arrived) {
      bot.holdT = bot.team === 'ct' ? rand(2.2, 5.2) : rand(1.6, 3.8);
      bot.scanT = rand(0, 3);
      setLookDirection(game, bot);
      bot.path = null;
      bot.arrived = true;
    }
  }

  function updateHunt(game, bot, dt) {
    if (bot.heardT > 0) bot.heardT -= dt;
    if (bot.holdT > 0) {
      bot.holdT -= dt;
      bot.scanT += dt;
      var want = bot.lookYaw + Math.sin(bot.scanT * 1.35) * 0.85;
      bot.yaw = moveAngle(bot.yaw, want, 3.4 * dt);
      bot.pitch = approach(bot.pitch, 0, 4, dt);
      applyMovement(game, bot, dt, 0, 0);
      if (bot.holdT <= 0) {
        bot.investigate = null;
        bot.lastSeen = null;
        bot.heardPos = null;
        setState(game, bot, 'rotate');
      }
      return;
    }
    if (!bot.investigate) {
      if (bot.lastSeen) bot.investigate = [bot.lastSeen[0], bot.lastSeen[2]];
      else if (bot.heardPos) bot.investigate = [bot.heardPos[0], bot.heardPos[1]];
      else {
        setState(game, bot, 'rotate');
        return;
      }
      bot.goal = [bot.investigate[0], bot.investigate[1]];
      bot.path = null;
      bot.repathT = 0;
    }
    if (!bot.goal) bot.goal = [bot.investigate[0], bot.investigate[1]];
    var arrived = navigateTo(game, bot, dt, bot.goal[0], bot.goal[1], botRunSpeed(bot) * 0.96);
    if (arrived) {
      bot.holdT = rand(1.2, 2.8);
      bot.scanT = 0;
      bot.lookYaw = bot.yaw;
      bot.path = null;
    }
  }

  function updateEngage(game, bot, dt, enemies) {
    var t = bot.target;
    if (!t || !t.alive) {
      bot.target = null;
      setState(game, bot, 'hunt');
      return;
    }
    var dx = t.pos[0] - bot.pos[0], dz = t.pos[2] - bot.pos[2];
    var dist = horizontalLen(dx, dz);

    // per-frame LOS on the engaged target (cheap: one los call)
    var myEye = botEye(bot);
    var eEye = enemyEye(t);
    var visible = los(game, myEye, eEye);
    bot.targetVisible = visible;
    if (visible) {
      bot.lastSeenT = 0;
      bot.lastSeen = [t.pos[0], t.pos[1] + 1.5, t.pos[2]];
    } else {
      bot.lastSeenT += dt;
      if (bot.lastSeenT > 1.7) {
        bot.target = null;
        setState(game, bot, 'hunt');
        bot.investigate = bot.lastSeen ? [bot.lastSeen[0], bot.lastSeen[2]] : null;
        return;
      }
    }

    // ----- aiming -----
    var aimHead = Math.random() < 0.08 + bot.headAimBias;
    var aimY = t.pos[1] + (aimHead ? 1.62 : 1.18);
    var lead = clamp(dist / 240, 0, 0.22) * curDiff.lead;
    var aimX = t.pos[0], aimZ = t.pos[2];
    if (t.vel) {
      aimX += t.vel[0] * lead;
      aimZ += t.vel[2] * lead;
    }
    var wantYaw = Math.atan2(aimX - bot.pos[0], -(aimZ - bot.pos[2]));
    var wantPitch = Math.atan2(aimY - myEye[1], horizontalLen(aimX - bot.pos[0], aimZ - bot.pos[2]) || 1);
    var turnRate = curDiff.turn * (0.8 + bot.skill * 0.55);
    bot.yaw = moveAngle(bot.yaw, wantYaw, turnRate * dt);
    bot.pitch = approach(bot.pitch, wantPitch, 12, dt);
    bot.pitch = clamp(bot.pitch, -1.2, 1.2);
    bot.aimReady = Math.abs(angDiff(bot.yaw, wantYaw)) < 0.23 && Math.abs(bot.pitch - wantPitch) < 0.17;

    // ----- movement: keep preferred range + strafe -----
    var speed = botCombatSpeed(bot);
    var pref = weaponRangePref(bot.def);
    var toward = 0;
    if (dist < pref[0] - 1.5) toward = -1;
    else if (dist > pref[1]) toward = 1;
    // low health: back off while reloading/heavy fire
    if (bot.health < 32 && (bot.reloading || bot.ammo.mag <= 0)) toward = -1;
    if (bot.def && bot.def.slot === 'knife') toward = 1;

    var fwdX = Math.sin(bot.yaw), fwdZ = -Math.cos(bot.yaw);
    var rightX = Math.cos(bot.yaw), rightZ = Math.sin(bot.yaw);
    bot.strafeT -= dt;
    if (bot.strafeT <= 0) {
      bot.strafeT = rand(0.55, 1.5);
      bot.strafeDir = Math.random() < 0.5 ? -1 : 1;
    }
    var strafeAmt = speed * 0.85 * curDiff.strafe;
    // counter-strafe while shooting: CS bots stop moving to land their burst
    var firing = bot.fireT > 0 || bot.burstLeft > 0 || bot.burstPause > 0;
    var moveMul = firing ? 0.3 : 1;
    var mvx = fwdX * speed * toward * moveMul + rightX * bot.strafeDir * strafeAmt * moveMul;
    var mvz = fwdZ * speed * toward * moveMul + rightZ * bot.strafeDir * strafeAmt * moveMul;
    if (!visible) {
      // move toward last known position instead of strafing blankly
      var ls = bot.lastSeen || [t.pos[0], t.pos[1], t.pos[2]];
      var ldx = ls[0] - bot.pos[0], ldz = ls[2] - bot.pos[2];
      var ll = horizontalLen(ldx, ldz) || 1;
      mvx = ldx / ll * speed * 0.9 + rightX * bot.strafeDir * strafeAmt * 0.4;
      mvz = ldz / ll * speed * 0.9 + rightZ * bot.strafeDir * strafeAmt * 0.4;
    }
    applyMovement(game, bot, dt, mvx, mvz);

    // ----- trigger -----
    if (visible) tryFire(game, bot);
  }

  function updateBot(game, bot, dt, live) {
    var db = curDiff;
    bot.animT += dt;

    if (!bot.alive) {
      if (bot.deathT < 12) bot.deathT += dt;
      // corpse settle: fall angle progresses in render()
      return;
    }

    // weapon timers always tick (reload can finish while frozen)
    updateWeapon(game, bot, dt);

    readDifficulty(game);

    if (!live) {
      // frozen during buy / roundEnd: idle breathing only
      bot.moveSpeed = 0;
      bot.scanT += dt;
      bot.yaw = moveAngle(bot.yaw, bot.yaw + Math.sin(bot.scanT * 0.5) * 0.02, 0.4 * dt);
      return;
    }

    if (bot.state === 'spawn') {
      setState(game, bot, 'rotate');
    }

    perceive(game, bot, dt);

    switch (bot.state) {
      case 'engage':
        updateEngage(game, bot, dt);
        break;
      case 'hunt':
        updateHunt(game, bot, dt);
        break;
      case 'death':
        break;
      default:
        updateRotate(game, bot, dt);
        break;
    }
  }

  /* ===================================================================== *
   *  BOT-BOT SEPARATION
   * ===================================================================== */
  function pushEntity(game, bot, dx, dz) {
    var w = CS.world;
    if (w && typeof w.moveEntity === 'function') {
      try {
        var r = w.moveEntity(bot.pos, [dx, 0, dz], RADIUS, HEIGHT);
        if (r && r.pos) bot.pos = [r.pos[0], r.pos[1], r.pos[2]];
        return;
      } catch (e) { /* fall through */ }
    }
    bot.pos[0] += dx;
    bot.pos[2] += dz;
  }

  function separateBots(game) {
    var minD = 0.68;
    for (var i = 0; i < LIST.length; i++) {
      var a = LIST[i];
      if (!a.alive) continue;
      for (var j = i + 1; j < LIST.length; j++) {
        var b = LIST[j];
        if (!b.alive) continue;
        var dx = b.pos[0] - a.pos[0], dz = b.pos[2] - a.pos[2];
        var d = horizontalLen(dx, dz);
        if (d < 1e-5) { dx = 0.01; dz = 0; d = 0.01; }
        if (d < minD) {
          var push = (minD - d) * 0.5;
          var ux = dx / d, uz = dz / d;
          pushEntity(game, a, -ux * push * 0.7, -uz * push * 0.7);
          pushEntity(game, b, ux * push * 0.7, uz * push * 0.7);
        }
      }
      // don't stand inside the player
      var p = game.player;
      if (p && p.alive && p.pos && a.team === 't') {
        var pdx = a.pos[0] - p.pos[0], pdz = a.pos[2] - p.pos[2];
        var pd = horizontalLen(pdx, pdz);
        if (pd < 0.72 && pd > 1e-5) {
          pushEntity(game, a, pdx / pd * (0.72 - pd) * 0.6, pdz / pd * (0.72 - pd) * 0.6);
        }
      }
    }
  }

  /* ===================================================================== *
   *  UPDATE
   * ===================================================================== */
  bots.update = function (game, dt) {
    if (!game || !LIST.length) return;
    dt = (typeof dt === 'number' && isFinite(dt)) ? dt : 0.016;
    if (dt <= 0) return;
    if (dt > 0.05) dt = 0.05; // keep AI stable on frame spikes

    readDifficulty(game);
    processPlayerShots(game);
    buildEnemyCache(game);
    var live = isLive(game);
    for (var i = 0; i < LIST.length; i++) {
      try {
        updateBot(game, LIST[i], dt, live);
      } catch (e) {
        // one broken bot must never take down the frame
        warnOnce('update-' + LIST[i].name, 'bot update threw for ' + LIST[i].name + ': ' + (e && e.message));
      }
    }
    separateBots(game);
  };

  /* ===================================================================== *
   *  RENDER — layered box humanoids
   * ===================================================================== */
  function nextMat() {
    if (!MAT_POOL) {
      MAT_POOL = new Array(MAT_POOL_LEN);
      for (var i = 0; i < MAT_POOL_LEN; i++) MAT_POOL[i] = new Float32Array(16);
    }
    var m = MAT_POOL[MAT_IDX];
    MAT_IDX = (MAT_IDX + 1) % MAT_POOL_LEN;
    return m;
  }

  function nextTint(r, g, b) {
    if (!TINT_POOL) {
      TINT_POOL = new Array(MAT_POOL_LEN);
      for (var i = 0; i < MAT_POOL_LEN; i++) TINT_POOL[i] = [1, 1, 1];
    }
    var t = TINT_POOL[TINT_IDX];
    TINT_IDX = (TINT_IDX + 1) % MAT_POOL_LEN;
    t[0] = r; t[1] = g; t[2] = b;
    return t;
  }

  /* Compute the bot's base rotation (Ry(-yaw) * Rx(fall) * Rz(roll)) into RB. */
  function computeRb(bot) {
    var yaw = -bot.yaw + (bot.alive ? 0 : bot.deathYawOff);
    var cy = Math.cos(yaw), sy = Math.sin(yaw);
    var fall = bot.alive ? 0 : bot.deathFall;
    if (!fall) {
      RB[0] = cy; RB[1] = 0; RB[2] = sy;
      RB[3] = 0; RB[4] = 1; RB[5] = 0;
      RB[6] = -sy; RB[7] = 0; RB[8] = cy;
    } else {
      var cf = Math.cos(fall), sf = Math.sin(fall);
      var roll = (bot.alive ? 0 : bot.deathDir * 0.26);
      var cr = Math.cos(roll), sr = Math.sin(roll);
      /* R = Ry(theta) * Rx(fall) * Rz(roll)  (row-major result) */
      RB[0] = cy * cr + sy * sf * sr;
      RB[1] = -cy * sr + sy * sf * cr;
      RB[2] = sy * cf;
      RB[3] = cf * sr;
      RB[4] = cf * cr;
      RB[5] = -sf;
      RB[6] = -sy * cr + cy * sf * sr;
      RB[7] = sy * sr + cy * sf * cr;
      RB[8] = cy * cf;
    }
  }

  /*
   * Emit one box for a bot.
   * coordinates are body-local: +x right, +y up, -z forward.
   * (lx,ly,lz) = box centre at rest, (px,py,pz) = rotation pivot, rx = local X rotation.
   */
  function emitBox(r, bot, baseY, lx, ly, lz, px, py, pz, rx, sx, sy, sz, col, mul) {
    var x, y, z;
    var c, s;
    var c1x, c1y, c1z, c2x, c2y, c2z;
    var a00 = RB[0], a01 = RB[1], a02 = RB[2];
    var a10 = RB[3], a11 = RB[4], a12 = RB[5];
    var a20 = RB[6], a21 = RB[7], a22 = RB[8];
    if (rx) {
      c = Math.cos(rx); s = Math.sin(rx);
      var ox = lx - px, oy = ly - py, oz = lz - pz;
      var ry = c * oy - s * oz;
      var rz = s * oy + c * oz;
      x = px + ox; y = py + ry; z = pz + rz;
      // Rpart = Rb * Rx ; columns 1/2 of Rx are (0,c,s) and (0,-s,c)
      c1x = c * a01 + s * a02; c1y = c * a11 + s * a12; c1z = c * a21 + s * a22;
      c2x = -s * a01 + c * a02; c2y = -s * a11 + c * a12; c2z = -s * a21 + c * a22;
    } else {
      x = lx; y = ly; z = lz;
      c1x = a01; c1y = a11; c1z = a21;
      c2x = a02; c2y = a12; c2z = a22;
    }
    var wx = bot.pos[0] + a00 * x + a01 * y + a02 * z;
    var wy = baseY + a10 * x + a11 * y + a12 * z;
    var wz = bot.pos[2] + a20 * x + a21 * y + a22 * z;

    var m = nextMat();
    m[0] = a00 * sx; m[1] = a10 * sx; m[2] = a20 * sx; m[3] = 0;
    m[4] = c1x * sy; m[5] = c1y * sy; m[6] = c1z * sy; m[7] = 0;
    m[8] = c2x * sz; m[9] = c2y * sz; m[10] = c2z * sz; m[11] = 0;
    m[12] = wx; m[13] = wy; m[14] = wz; m[15] = 1;

    r.drawBox('white', m, nextTint(col[0] * mul, col[1] * mul, col[2] * mul), 1);
  }

  function drawGun(r, bot, baseY, c, mul, simple) {
    var def = bot.def || {};
    var id = def.id || bot.weaponId || 'ak47';
    var gx = 0.10;
    if (id === 'knife') {
      emitBox(r, bot, baseY, gx, 1.20, -0.16, 0, 0, 0, 0, 0.045, 0.05, 0.14, GUN_WOOD, mul);
      emitBox(r, bot, baseY, gx, 1.215, -0.34, 0, 0, 0, 0, 0.022, 0.075, 0.26, KNIFE_BLADE, mul);
      return;
    }
    if (id === 'awp') {
      emitBox(r, bot, baseY, gx, 1.24, -0.26, 0, 0, 0, 0, 0.085, 0.12, 0.56, GUN_AWP, mul);
      emitBox(r, bot, baseY, gx, 1.255, -0.72, 0, 0, 0, 0, 0.04, 0.04, 0.44, GUN_METAL, mul);
      if (!simple) {
        emitBox(r, bot, baseY, gx, 1.33, -0.22, 0, 0, 0, 0, 0.07, 0.075, 0.24, GUN_METAL, mul);
        emitBox(r, bot, baseY, gx, 1.12, -0.16, 0, 0, 0, 0, 0.055, 0.12, 0.11, GUN_METAL_LIGHT, mul);
      }
      emitBox(r, bot, baseY, gx, 1.195, 0.12, 0, 0, 0, 0, 0.07, 0.12, 0.26, GUN_AWP, mul);
      return;
    }
    if (def.slot === 'secondary') {
      emitBox(r, bot, baseY, gx, 1.215, -0.20, 0, 0, 0, 0, 0.055, 0.075, 0.26, GUN_METAL, mul);
      emitBox(r, bot, baseY, gx, 1.245, -0.34, 0, 0, 0, 0, 0.035, 0.035, 0.10, GUN_METAL_LIGHT, mul);
      emitBox(r, bot, baseY, gx, 1.13, -0.11, 0, 0, 0, 0, 0.05, 0.14, 0.085, bot.colors.glove, mul);
      return;
    }
    // rifles (ak47 / m4a1)
    var wood = (id === 'ak47');
    emitBox(r, bot, baseY, gx, 1.235, -0.19, 0, 0, 0, 0, 0.075, 0.115, 0.40, GUN_METAL, mul);
    emitBox(r, bot, baseY, gx, 1.245, -0.52, 0, 0, 0, 0, 0.035, 0.035, 0.32, GUN_METAL, mul);
    emitBox(r, bot, baseY, gx, 1.215, 0.08, 0, 0, 0, 0, 0.06, 0.085, 0.22, wood ? GUN_WOOD : GUN_METAL_LIGHT, mul);
    if (!simple) {
      emitBox(r, bot, baseY, gx, 1.225, -0.42, 0, 0, 0, 0, 0.065, 0.075, 0.18, wood ? GUN_WOOD : GUN_METAL_LIGHT, mul);
      emitBox(r, bot, baseY, gx, 1.30, -0.26, 0, 0, 0, 0, 0.03, 0.035, 0.10, GUN_METAL, mul);
      emitBox(r, bot, baseY, gx, 1.125, -0.13, 0, 0, 0, 0, 0.055, 0.16, 0.10, GUN_METAL_LIGHT, mul);
    }
  }

  function drawBot(game, r, bot, camPos) {
    var isDead = !bot.alive;
    if (isDead && bot.deathT > 8.2) return;
    var camDist = dist2D(camPos[0], camPos[2], bot.pos[0], bot.pos[2]);
    if (isDead) {
      bot.deathFall = clamp(bot.deathT / 0.62, 0, 1);
      bot.deathFall = M.smoothstep(bot.deathFall) * 1.46;
    }
    var simple = camDist > 36;
    var mul = isDead ? clamp(0.34 + 0.66 * (1 - clamp((bot.deathT - 4.6) / 3.6, 0, 1)), 0, 1) : 1;
    var c = bot.colors;
    var baseY = bot.pos[1] + (isDead ? 0.03 : 0);
    var moving = bot.alive ? clamp(bot.moveSpeed / 4.3, 0, 1) : 0;
    var bob = bot.alive ? Math.sin(bot.animT * 1.9) * 0.008 + Math.abs(Math.sin(bot.walkPhase)) * moving * 0.03 : 0;
    var legAmp = (0.06 + moving * 0.55);
    var swing = bot.alive ? Math.sin(bot.walkPhase) * legAmp : 0;
    var kneeL = bot.alive ? 0.12 + Math.max(0, -swing) * 1.15 : 0;
    var kneeR = bot.alive ? 0.12 + Math.max(0, swing) * 1.15 : 0;
    var armSwing = bot.alive ? Math.sin(bot.walkPhase + PI) * moving * 0.16 : 0;

    computeRb(bot);

    // ground shadow
    if (typeof r.drawShadow === 'function') {
      try { r.drawShadow([bot.pos[0], bot.pos[1] + 0.01, bot.pos[2]], isDead ? 0.75 : 0.55, isDead ? 0.16 : 0.34); } catch (e) { warnOnce('shadow', 'drawShadow threw'); }
    }

    /* ---- head / neck ---- */
    emitBox(r, bot, baseY, 0, 1.675 + bob, 0, 0, 0, 0, 0, 0.23, 0.24, 0.23, c.skin, mul);
    if (!simple) {
      emitBox(r, bot, baseY, 0, 1.655 + bob, -0.115, 0, 0, 0, 0, 0.15, 0.075, 0.035, [0.05, 0.06, 0.07], mul);
      emitBox(r, bot, baseY, 0, 1.535 + bob, 0, 0, 0, 0, 0, 0.12, 0.095, 0.12, c.skin, mul);
    }
    // team-coloured cap / bandana
    emitBox(r, bot, baseY, 0, 1.80 + bob, 0.005, 0, 0, 0, 0, 0.26, 0.085, 0.26, c.head, mul);

    /* ---- torso ---- */
    emitBox(r, bot, baseY, 0, 1.29 + bob, 0, 0, 0, 0, 0, 0.44, 0.46, 0.26, c.uniform, mul);
    if (!simple) {
      emitBox(r, bot, baseY, 0, 1.30 + bob, 0, 0, 0, 0, 0, 0.46, 0.30, 0.285, c.vest, mul);
      emitBox(r, bot, baseY, 0.19, 1.40 + bob, 0.02, 0, 0, 0, 0, 0.09, 0.09, 0.10, c.accent, mul); // teammate marker patch
    }
    emitBox(r, bot, baseY, 0, 1.015 + bob * 0.5, 0, 0, 0, 0, 0, 0.38, 0.18, 0.24, c.uniformDark, mul);

    /* ---- legs (thigh -> knee -> shin -> foot) ---- */
    var hipY = 0.93;
    var hipX = 0.105;
    // left leg (x +)
    var thL_y = hipY - 0.21 * Math.cos(swing);
    var thL_z = -0.21 * Math.sin(swing);
    emitBox(r, bot, baseY, hipX, thL_y, thL_z, hipX, hipY, 0, swing, 0.155, 0.42, 0.175, c.uniformDark, mul);
    if (!simple) {
      var knL_y = hipY - 0.42 * Math.cos(swing);
      var knL_z = -0.42 * Math.sin(swing);
      var shRotL = swing - kneeL;
      emitBox(r, bot, baseY, hipX, knL_y - 0.19 * Math.cos(shRotL), knL_z - 0.19 * Math.sin(shRotL), hipX, knL_y, knL_z, shRotL, 0.145, 0.38, 0.16, c.uniform, mul);
      var anL_y = knL_y - 0.38 * Math.cos(shRotL);
      var anL_z = knL_z - 0.38 * Math.sin(shRotL);
      emitBox(r, bot, baseY, hipX, anL_y - 0.04 * Math.cos(shRotL) - 0.055 * Math.sin(shRotL), anL_z - 0.04 * Math.sin(shRotL) + 0.055 * Math.cos(shRotL), hipX, anL_y, anL_z, shRotL, 0.16, 0.12, 0.27, c.boot, mul);
    }
    // right leg (x -), opposite phase
    var swR = -swing;
    var thR_y = hipY - 0.21 * Math.cos(swR);
    var thR_z = -0.21 * Math.sin(swR);
    emitBox(r, bot, baseY, -hipX, thR_y, thR_z, -hipX, hipY, 0, swR, 0.155, 0.42, 0.175, c.uniformDark, mul);
    if (!simple) {
      var knR_y = hipY - 0.42 * Math.cos(swR);
      var knR_z = -0.42 * Math.sin(swR);
      var shRotR = swR - kneeR;
      emitBox(r, bot, baseY, -hipX, knR_y - 0.19 * Math.cos(shRotR), knR_z - 0.19 * Math.sin(shRotR), -hipX, knR_y, knR_z, shRotR, 0.145, 0.38, 0.16, c.uniform, mul);
      var anR_y = knR_y - 0.38 * Math.cos(shRotR);
      var anR_z = knR_z - 0.38 * Math.sin(shRotR);
      emitBox(r, bot, baseY, -hipX, anR_y - 0.04 * Math.cos(shRotR) - 0.055 * Math.sin(shRotR), anR_z - 0.04 * Math.sin(shRotR) + 0.055 * Math.cos(shRotR), -hipX, anR_y, anR_z, shRotR, 0.16, 0.12, 0.27, c.boot, mul);
    }

    /* ---- arms ---- */
    var shY = 1.46;
    emitBox(r, bot, baseY, 0.27, 1.31, 0, 0.27, shY, 0, 0.55 + armSwing, 0.13, 0.30, 0.14, c.uniform, mul);
    emitBox(r, bot, baseY, -0.27, 1.31, 0, -0.27, shY, 0, 0.65 - armSwing, 0.13, 0.30, 0.14, c.uniform, mul);
    if (!simple) {
      emitBox(r, bot, baseY, 0.17, 1.215, -0.20, 0, 0, 0, 0, 0.10, 0.115, 0.30, c.uniform, mul);
      emitBox(r, bot, baseY, -0.05, 1.235, -0.26, 0, 0, 0, 0, 0.10, 0.115, 0.32, c.uniform, mul);
      emitBox(r, bot, baseY, 0.105, 1.165, -0.08, 0, 0, 0, 0, 0.10, 0.10, 0.10, c.glove, mul);
      emitBox(r, bot, baseY, 0.045, 1.225, -0.36, 0, 0, 0, 0, 0.10, 0.10, 0.10, c.glove, mul);
    }

    /* ---- weapon ---- */
    drawGun(r, bot, baseY, c, mul, simple);
  }

  bots.render = function (game) {
    if (!game) return;
    var r = game.renderer;
    if (!r || typeof r.drawBox !== 'function') return;
    MAT_IDX = 0;
    TINT_IDX = 0;
    var camPos = null;
    if (r.camera && r.camera.eye) camPos = r.camera.eye;
    else if (game.player && game.player.pos) camPos = [game.player.pos[0], game.player.pos[1] + 1.62, game.player.pos[2]];
    else camPos = [0, 0, 0];
    for (var i = 0; i < LIST.length; i++) {
      try {
        drawBot(game, r, LIST[i], camPos);
      } catch (e) {
        warnOnce('render-' + LIST[i].name, 'bot render threw for ' + LIST[i].name + ': ' + (e && e.message));
      }
    }
  };

  /* debug helper: counts bots per state (for lead's integration checks) */
  bots.debugState = function () {
    var out = { total: LIST.length, alive: 0, states: {} };
    for (var i = 0; i < LIST.length; i++) {
      var b = LIST[i];
      if (b.alive) out.alive++;
      out.states[b.state] = (out.states[b.state] || 0) + 1;
    }
    return out;
  };
})();
