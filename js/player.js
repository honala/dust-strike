/* =========================================================================
 * DUST STRIKE — player controller, shooting, recoil, first-person viewmodel
 * Owned by: combat. CONTRACT.md §10 (§4/§14 for globals).
 *
 * CONTRACT-GAP notes (decisions taken where the contract is silent):
 *  - Shooting / mouse-look require game.input.locked (auto mode sets it true).
 *  - game.frozen === true (buy freeze / round end, set by rules) keeps look +
 *    scope, ignores move/jump/fire/reload/switch input (Lead integration msg).
 *  - Dead players keep mouse look but never move/shoot (main.js death camera).
 *  - resetForRound() follows the opts {pos,yaw,keepWeapons,armor} convention.
 *  - K/D is updated by rules.onEvent(kill) only — onKilled() does not touch it.
 *  - CS.audio.play('switch'|'reload_start'|'reload_end') is called directly:
 *    the event catalogue has no events for these sounds.
 *  - If world.moveEntity is missing/broken a simple fallback integrator keeps
 *    the game running (sandbox/nav-less smoke tests).
 *  - player.def, player.spread, player.fov are kept in sync for main/HUD/bots.
 * ========================================================================= */
(function () {
  'use strict';
  var CS = window.CS = window.CS || {};
  var M = CS.math;
  var P = CS.player = CS.player || {};
  if (!M) { P.init = function () { return null; }; return; }
  var V3 = M.V3, M4 = M.M4;
  var TAU = Math.PI * 2, DEG = Math.PI / 180;

  /* ------------------------------- tuning ------------------------------- */
  var RUN_SPEED = 5.2, WALK_SPEED = 2.6, CROUCH_SPEED = 2.0;
  var ACCEL = 11.0;            /* ground acceleration */
  var AIR_ACCEL = 1.7;         /* small air acceleration */
  var FRICTION = 6.5, STOP_SPEED = 1.3;
  var GRAVITY = 16.0, JUMP_VEL = 5.2, MAX_FALL = 40;
  var RADIUS = 0.32;
  var STAND_HEIGHT = 1.8, CROUCH_HEIGHT = 1.2;
  var EYE_STAND = 1.62, EYE_CROUCH = 1.10;
  var PITCH_LIMIT = 1.55;
  var SENS_PER_PIXEL = 0.0022;
  var SPREAD_DISPLAY_MAX = 0.16;   /* inaccuracy (rad) that maps crosshairSpread to 1 */
  var BLOOM_MAX = 0.070;
  var RECOIL_DELAY = 0.16, RECOIL_RECOVER = 4.2;
  var TRACER_COLORS = {
    usp: [1.0, 0.86, 0.52], glock: [1.0, 0.84, 0.46],
    m4a1: [1.0, 0.90, 0.56], ak47: [1.0, 0.78, 0.38], awp: [1.0, 0.92, 0.62]
  };

  var state = null;             /* current player instance for module-level API */
  var warned = {};
  function warnOnce(tag, err) {
    if (warned[tag]) return;
    warned[tag] = true;
    try { if (window.console && console.warn) console.warn('[player] ' + tag + ':', err); } catch (e) {}
  }

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function key(keys, code) { return !!(keys && keys[code]); }
  function pressed(input, name) {
    var pr = input && input.pressed;
    if (!pr) return false;
    if (typeof pr.has === 'function') return pr.has(name);
    return !!pr[name];
  }
  function emit(game, ev) {
    if (!game || !ev) return;
    if (typeof game.emit === 'function') { game.emit(ev); return; }
    if (game.events && typeof game.events.push === 'function') game.events.push(ev);
  }
  function callAudio(name, opts) {
    var a = CS.audio;
    if (!a || typeof a.play !== 'function') return;
    try { a.play(name, opts); } catch (e) { warnOnce('audio.play', e); }
  }
  function callFx(name, args) {
    var fx = CS.fx;
    if (!fx || typeof fx[name] !== 'function') return;
    try { fx[name].apply(fx, args); } catch (e) { warnOnce('fx.' + name, e); }
  }
  function defs() { return (CS.weapons && CS.weapons.defs) || {}; }
  function num(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }

  /* --------------------------------------------------------------------- *
   *  First-person viewmodel geometry (camera-local space, forward = -Z)
   *  Part tuple: [cx,cy,cz, sx,sy,sz, tint, rx?, ry?, rz?]
   * --------------------------------------------------------------------- */
  var COL = {
    metal: [0.330, 0.350, 0.380], metalDark: [0.205, 0.220, 0.245],
    metalLight: [0.500, 0.520, 0.555], steel: [0.700, 0.730, 0.780],
    polymer: [0.255, 0.270, 0.295], polymerDark: [0.170, 0.182, 0.200],
    wood: [0.560, 0.360, 0.195], woodDark: [0.400, 0.255, 0.135],
    olive: [0.450, 0.470, 0.330], oliveDark: [0.340, 0.360, 0.250],
    glove: [0.360, 0.325, 0.275], gloveDark: [0.250, 0.225, 0.190],
    sight: [0.120, 0.130, 0.140], accent: [0.520, 0.540, 0.575]
  };

  /* Root offset of the gun in camera space (x right, y up, -Z forward).
   * Lead integration feedback: x 0.26..0.32, y -0.22..-0.28, z -0.58..-0.68,
   * total screen footprint <= right-bottom ~1/3, never closer than 0.35 m. */
  var VM_VIEW_OFFSET = {
    rifle: [0.340, -0.235, -0.680],
    pistol: [0.315, -0.215, -0.600],
    knife: [0.300, -0.205, -0.620],
    sniper: [0.350, -0.245, -0.740]
  };
  var VM_SCALE = { rifle: 0.85, pistol: 0.92, knife: 0.92, sniper: 0.95 };
  var VM_BASE_YAW = { rifle: 0.090, pistol: 0.115, knife: 0.090, sniper: 0.070 };
  /* slight roll reveals the left side silhouette instead of a flat top slab */
  var VM_BASE_ROLL = { rifle: -0.10, pistol: -0.14, knife: -0.06, sniper: -0.10 };

  function buildRifleParts(id) {
    var wood = (id === 'ak47');
    var fur = wood ? COL.wood : COL.polymer;
    var furDark = wood ? COL.woodDark : COL.polymer;
    var parts = [
      /* receiver + dust cover */
      [0, 0, -0.06, 0.058, 0.082, 0.26, COL.metal],
      /* handguard */
      [0, -0.008, -0.24, 0.052, 0.055, 0.16, fur],
      /* barrel / suppressor (M4A1-S keeps its signature suppressor) */
      (id === 'm4a1')
        ? [0, 0.012, -0.335, 0.040, 0.040, 0.20, COL.polymerDark]
        : [0, 0.012, -0.345, 0.026, 0.026, 0.15, COL.metalDark],
      /* muzzle */
      [0, 0.012, -0.440, 0.034, 0.034, 0.050, COL.metalDark],
      /* magazine (slightly angled) */
      [0, -0.100, -0.020, 0.044, 0.150, 0.085, furDark, -0.20],
      /* pistol grip */
      [0, -0.100, 0.100, 0.044, 0.120, 0.058, COL.polymerDark, 0.28],
      /* stock + butt pad */
      [0, -0.005, 0.170, 0.050, 0.062, 0.160, fur],
      [0, -0.005, 0.255, 0.052, 0.078, 0.022, COL.metalDark],
      /* sights */
      [0, 0.072, 0.020, 0.016, 0.026, 0.030, COL.sight],
      [0, 0.075, -0.300, 0.014, 0.030, 0.022, COL.sight],
      /* supporting left hand on the handguard */
      [-0.004, -0.100, -0.235, 0.062, 0.075, 0.110, COL.glove],
      /* right hand on the grip, forearm going off-screen */
      [0.012, -0.115, 0.100, 0.062, 0.090, 0.100, COL.glove],
      [0.100, -0.170, 0.170, 0.075, 0.075, 0.160, COL.gloveDark]
    ];
    return { parts: parts, muzzle: [0, 0.012, -0.470] };
  }

  function buildSniperParts() {
    var parts = [
      /* receiver + olive furniture */
      [0, 0, -0.05, 0.060, 0.085, 0.30, COL.olive],
      /* long barrel + muzzle brake */
      [0, 0.012, -0.330, 0.028, 0.028, 0.22, COL.metalDark],
      [0, 0.012, -0.450, 0.036, 0.036, 0.060, COL.metalDark],
      /* scope: tube, objective lens, ocular lens, mount */
      [0, 0.085, -0.080, 0.045, 0.045, 0.240, COL.metalDark],
      [0, 0.085, -0.215, 0.055, 0.055, 0.050, COL.steel],
      [0, 0.085, 0.040, 0.052, 0.052, 0.040, COL.steel],
      [0, 0.050, -0.060, 0.020, 0.030, 0.100, COL.metalDark],
      /* bolt handle */
      [0.052, 0.020, 0.020, 0.045, 0.020, 0.030, COL.metalLight],
      /* magazine + grip */
      [0, -0.100, -0.020, 0.050, 0.110, 0.090, COL.metalDark],
      [0, -0.100, 0.100, 0.045, 0.120, 0.060, COL.polymerDark, 0.28],
      /* stock + cheek rest */
      [0, -0.005, 0.200, 0.050, 0.070, 0.180, COL.olive],
      [0, 0.040, 0.140, 0.040, 0.030, 0.120, COL.oliveDark],
      /* hands */
      [0.012, -0.115, 0.105, 0.060, 0.090, 0.100, COL.glove],
      [-0.010, -0.100, -0.220, 0.060, 0.075, 0.100, COL.glove]
    ];
    return { parts: parts, muzzle: [0, 0.012, -0.500] };
  }

  function buildPistolParts(id) {
    var usp = (id === 'usp');
    var parts = [
      /* slide + frame */
      [0, 0.020, -0.060, 0.048, 0.055, 0.200, usp ? COL.metal : COL.polymerDark],
      [0, -0.015, -0.020, 0.044, 0.050, 0.160, COL.polymerDark],
      /* barrel tip */
      [0, 0.020, -0.170, 0.032, 0.032, 0.040, COL.metalDark],
      /* grip + mag base */
      [0, -0.100, 0.055, 0.044, 0.130, 0.062, COL.polymerDark, 0.30],
      [0, -0.165, 0.080, 0.040, 0.020, 0.060, COL.metalDark],
      /* trigger guard */
      [0, -0.052, 0.005, 0.018, 0.020, 0.060, COL.metalDark],
      /* sights */
      [0, 0.055, -0.110, 0.015, 0.020, 0.020, COL.sight],
      [0, 0.055, -0.170, 0.012, 0.018, 0.018, COL.sight],
      /* right hand on grip, left support hand */
      [0.008, -0.085, 0.090, 0.060, 0.095, 0.100, COL.glove],
      [-0.025, -0.090, 0.020, 0.056, 0.075, 0.090, COL.glove],
      [0.085, -0.170, 0.170, 0.070, 0.070, 0.160, COL.gloveDark]
    ];
    if (usp) {
      parts.push([0, 0.020, -0.260, 0.042, 0.042, 0.160, COL.polymerDark]); /* suppressor */
    } else {
      parts.push([0, 0.052, -0.095, 0.040, 0.010, 0.024, COL.accent]);       /* glock slide serration */
    }
    return { parts: parts, muzzle: [0, 0.020, usp ? -0.345 : -0.200] };
  }

  function buildKnifeParts() {
    var parts = [
      [0, 0.030, -0.150, 0.012, 0.055, 0.220, COL.steel],       /* blade */
      [0, 0.030, -0.270, 0.008, 0.035, 0.070, COL.steel],       /* tip */
      [0, 0.058, -0.140, 0.014, 0.014, 0.200, COL.metalLight],  /* blade spine */
      [0, 0.000, -0.035, 0.055, 0.018, 0.030, COL.metalDark],   /* guard */
      [0, -0.005, 0.050, 0.028, 0.032, 0.140, COL.polymerDark], /* handle */
      [0, -0.005, 0.130, 0.034, 0.038, 0.024, COL.metalDark],   /* pommel */
      [0.005, -0.020, 0.060, 0.060, 0.075, 0.100, COL.glove],   /* right hand */
      [0.030, 0.005, 0.040, 0.025, 0.035, 0.060, COL.glove],    /* thumb */
      [0.070, -0.100, 0.160, 0.070, 0.070, 0.160, COL.gloveDark]/* forearm */
    ];
    return { parts: parts, muzzle: [0, 0.030, -0.320] };
  }

  function matPart(p, s) {
    s = s || 1;
    var m = M4.translation(p[0] * s, p[1] * s, p[2] * s);
    var rx = p[7] || 0, ry = p[8] || 0, rz = p[9] || 0;
    if (rx || ry || rz) {
      var r = M4.identity();
      if (ry) r = M4.multiply(r, M4.rotationY(ry));
      if (rx) r = M4.multiply(r, M4.rotationX(rx));
      if (rz) r = M4.multiply(r, M4.rotationZ(rz));
      m = M4.multiply(m, r);
    }
    return M4.multiply(m, M4.scaling(p[3] * s, p[4] * s, p[5] * s));
  }

  var vmCache = {};
  function vmConfig(def) {
    var id = (def && def.id) || 'usp';
    var c = vmCache[id];
    if (c) return c;
    var raw;
    switch (id) {
      case 'knife': raw = buildKnifeParts(); break;
      case 'awp': raw = buildSniperParts(); break;
      case 'usp': case 'glock': raw = buildPistolParts(id); break;
      case 'ak47': case 'm4a1': raw = buildRifleParts(id); break;
      default: raw = buildPistolParts('glock'); break;
    }
    var vm = (def && def.vm) || 'rifle';
    var scale = VM_SCALE[vm] || VM_SCALE.rifle;
    var parts = [];
    for (var i = 0; i < raw.parts.length; i++) {
      var rp = raw.parts[i];
      parts.push({ m: matPart(rp, scale), tint: rp[6] || [1, 1, 1] });
    }
    c = {
      parts: parts,
      muzzle: [raw.muzzle[0] * scale, raw.muzzle[1] * scale, raw.muzzle[2] * scale],
      vm: vm,
      viewOffset: VM_VIEW_OFFSET[vm] || VM_VIEW_OFFSET.rifle,
      baseYaw: VM_BASE_YAW[vm] || 0,
      baseRoll: VM_BASE_ROLL[vm] || 0
    };
    vmCache[id] = c;
    return c;
  }

  /* --------------------------------------------------------------------- *
   *  Player state
   * --------------------------------------------------------------------- */
  function currentDefOf(p) {
    var d = defs();
    var id = p.loadout[p.current] || p.loadout.secondary || 'usp';
    return d[id] || d.usp || d.knife;
  }

  function ensureAmmo(p) {
    var d = defs();
    if (!p.ammo) p.ammo = {};
    for (var id in d) {
      if (!p.ammo[id]) p.ammo[id] = { mag: d[id].mag || 0, reserve: d[id].reserve || 0 };
      /* keep entries sane after loadout changes */
      if (typeof p.ammo[id].mag !== 'number') p.ammo[id].mag = 0;
      if (typeof p.ammo[id].reserve !== 'number') p.ammo[id].reserve = 0;
    }
    return p.ammo;
  }

  function fillAllAmmo(p) {
    var d = defs();
    p.ammo = {};
    for (var id in d) {
      p.ammo[id] = { mag: d[id].mag || 0, reserve: d[id].reserve || 0 };
    }
    return p.ammo;
  }

  function createPlayer(game, pos, yaw) {
    var d = defs();
    var p = {
      /* identity */
      id: 'player', team: 'ct', name: '你', isPlayer: true,
      /* transform */
      pos: pos.slice ? pos.slice() : [pos[0], pos[1], pos[2]],
      vel: [0, 0, 0], yaw: yaw, pitch: 0,
      height: STAND_HEIGHT, eyeHeight: EYE_STAND,
      onGround: true, crouching: false, walking: false,
      /* vitals */
      health: 100, armor: 0, alive: true,
      kills: 0, deaths: 0,
      /* weapons */
      loadout: { primary: null, secondary: 'usp', knife: 'knife' },
      current: 'secondary',
      ammo: {},
      def: null,
      reloading: false, reloadT: 0, reloadWeaponId: null,
      drawT: 0, fireT: 0,
      /* look / recoil / spread */
      scoped: false, fov: (game && game.settings && game.settings.fov) || 90,
      spread: 0.0035, crosshairSpread: 0,
      bloom: 0, burstShots: 0, burstTimer: 99,
      recoilAccum: { up: 0, side: 0 },
      viewKick: 0, vmKick: 0, vmKickSide: 0,
      swayYaw: 0, swayPitch: 0, swayTargetYaw: 0, swayTargetPitch: 0,
      bobT: 0, stepDist: 0,
      /* animation cache */
      vmAnim: null,
      /* misc */
      time: 0,
      prevMouse: false, prevRight: false, prevSpace: false,
      killedBy: null, killedByWeapon: null, deathZone: null,
      hspeed: 0
    };
    fillAllAmmo(p);
    p.def = currentDefOf(p);

    /* --------------------------- public methods ------------------------ */
    p.update = function (g, dt) { update(p, g, dt); };
    p.renderViewmodel = function (renderer) { renderViewmodel(p, renderer); };
    p.rayTest = function (origin, dir, maxDist) { return rayTest(p, origin, dir, maxDist); };
    p.eye = function () { return eye(p); };
    p.currentDef = function () { return p.def || currentDefOf(p); };
    p.equip = function (g, id) { return equip(p, g, id); };
    p.resetForRound = function (g, opts) { resetForRound(p, g, opts); };
    p.onKilled = function (attacker, weaponId, zone) { onKilled(p, attacker, weaponId, zone); };
    p.crosshairPixels = function (g) { return crosshairPixels(p, g); };
    return p;
  }

  /* --------------------------------------------------------------------- *
   *  Eye / rayTest
   * --------------------------------------------------------------------- */
  function eye(p) {
    return [p.pos[0], p.pos[1] + p.eyeHeight, p.pos[2]];
  }

  /* Bot bullets vs player hitboxes. Head sphere + torso box + legs box. */
  function rayTest(p, origin, dir, maxDist) {
    if (!p || !p.alive || !origin || !dir) return null;
    var dl = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    if (!(dl > 1e-6)) return null;
    var d = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
    var md = (typeof maxDist === 'number' && maxDist > 0) ? maxDist : 200;
    var h = p.height || STAND_HEIGHT;
    var px = p.pos[0], py = p.pos[1], pz = p.pos[2];

    var tLegs = M.rayAABB(origin, d,
      [px - 0.21, py + 0.02, pz - 0.16],
      [px + 0.21, py + h * 0.45, pz + 0.16], md);
    var tBody = M.rayAABB(origin, d,
      [px - 0.26, py + h * 0.45, pz - 0.18],
      [px + 0.26, py + h * 0.82, pz + 0.18], md);
    var headC = [px, py + h - 0.16, pz];
    var tHead = M.raySphere(origin, d, headC, 0.16, md);

    var best = -1, zone = null;
    if (tHead >= 0) { best = tHead; zone = 'head'; }
    if (tBody >= 0 && (best < 0 || tBody < best)) { best = tBody; zone = 'body'; }
    if (tLegs >= 0 && (best < 0 || tLegs < best)) { best = tLegs; zone = 'legs'; }
    if (best < 0) return null;
    return {
      dist: best,
      point: [origin[0] + d[0] * best, origin[1] + d[1] * best, origin[2] + d[2] * best],
      zone: zone
    };
  }

  /* --------------------------------------------------------------------- *
   *  Movement helpers
   * --------------------------------------------------------------------- */
  function moveEntity(p, game, delta) {
    var world = (game && game.world) || CS.world;
    var out = null;
    if (world && typeof world.moveEntity === 'function') {
      try { out = world.moveEntity(p.pos, delta, RADIUS, p.height); }
      catch (e) { warnOnce('world.moveEntity', e); out = null; }
    }
    if (!out || !out.pos) {
      /* fallback integrator (node smoke tests / sandboxed worlds) */
      var np = [p.pos[0] + delta[0], p.pos[1] + delta[1], p.pos[2] + delta[2]];
      if (np[1] < 0) { np[1] = 0; }
      np[0] = clamp(np[0], -30, 30);
      np[2] = clamp(np[2], -32, 32);
      out = { pos: np, onGround: np[1] <= 0.0001, hitWall: false, hitCeil: false };
    }
    var rp = out.pos;
    if (!rp || typeof rp[0] !== 'number') rp = p.pos;
    out.pos = [rp[0], rp[1], rp[2]];
    return out;
  }

  function canStand(p, game) {
    var world = (game && game.world) || CS.world;
    if (!world || typeof world.raycast !== 'function') return true;
    var need = (STAND_HEIGHT - p.height) + 0.06;
    if (need < 0.02) return true;
    var o = [p.pos[0], p.pos[1] + p.height - 0.02, p.pos[2]];
    var hit = null;
    try { hit = world.raycast(o, [0, 1, 0], need + 0.08); }
    catch (e) { return true; }
    return !hit || !(hit.dist < need + 0.06);
  }

  /* --------------------------------------------------------------------- *
   *  Input / look / actions
   * --------------------------------------------------------------------- */
  function applyLook(p, game, input, dt) {
    if (!input || !input.locked) return;
    var sensMul = (game && game.settings && typeof game.settings.sensitivity === 'number')
      ? game.settings.sensitivity : 1;
    var sens = SENS_PER_PIXEL * sensMul;
    var dx = clamp(num(input.mouseDX, 0), -300, 300);
    var dy = clamp(num(input.mouseDY, 0), -300, 300);
    if (!dx && !dy) return;
    p.yaw = M.normalizeAngle(p.yaw + dx * sens);
    p.pitch = clamp(p.pitch - dy * sens, -PITCH_LIMIT, PITCH_LIMIT);
    /* weapon lag: mouse right -> gun swings left (+ry), mouse down -> muzzle up (+rx) */
    p.swayTargetYaw = clamp(p.swayTargetYaw + dx * sens * 0.55, -0.09, 0.09);
    p.swayTargetPitch = clamp(p.swayTargetPitch + dy * sens * 0.45, -0.07, 0.07);
  }

  function toggleScope(p, def) {
    if (!def || def.id !== 'awp') return;
    p.scoped = !p.scoped;
    if (p.scoped && p.reloading) { p.reloading = false; p.reloadT = 0; }
  }

  function switchSlot(p, slot) {
    var d = defs();
    var id = p.loadout[slot];
    if (!id || !d[id] || p.current === slot) return false;
    p.current = slot;
    p.def = d[id];
    p.reloading = false; p.reloadT = 0;
    p.scoped = false;
    p.drawT = num(d[id].drawTime, 0.8);
    p.burstShots = 0; p.burstTimer = 99;
    p.bloom = 0;
    callAudio('switch');
    return true;
  }

  function startReload(p, game, def) {
    if (!def || def.slot === 'knife' || p.reloading) return false;
    if (!(def.mag > 0)) return false;
    var am = p.ammo[def.id];
    if (!am || am.mag >= def.mag || am.reserve <= 0) return false;
    if (p.drawT > 0) return false;
    p.reloading = true;
    p.reloadT = num(def.reloadTime, 2.5);
    p.reloadWeaponId = def.id;
    p.scoped = false;
    callAudio('reload_start');
    return true;
  }

  function finishReload(p) {
    var d = defs();
    var id = p.reloadWeaponId || (p.def && p.def.id);
    var def = d[id];
    var am = p.ammo[id];
    p.reloading = false;
    p.reloadT = 0;
    p.reloadWeaponId = null;
    if (def && am) {
      var need = Math.max(0, (def.mag || 0) - am.mag);
      var take = Math.min(need, am.reserve);
      am.mag += take;
      am.reserve -= take;
    }
    p.fireT = Math.max(p.fireT, 0.08);
    callAudio('reload_end');
  }

  function tickTimers(p, game, dt) {
    p.fireT = Math.max(0, p.fireT - dt);
    p.drawT = Math.max(0, p.drawT - dt);
    if (p.reloading) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) finishReload(p);
    }
  }

  function tryFire(p, game, def, fireEdge, fireHeld) {
    if (!def || p.fireT > 0) return false;
    var isKnife = def.slot === 'knife';
    var am = isKnife ? null : p.ammo[def.id];
    var empty = !isKnife && (!am || am.mag <= 0);
    var want = def.auto ? fireHeld : fireEdge;
    if (!want) return false;
    if (empty) {
      if (fireEdge) {
        emit(game, { type: 'empty', weapon: def.id });
        p.fireT = 0.22;
      }
      return false;
    }
    if (!isKnife) am.mag--;
    p.fireT = 60 / Math.max(1, def.rpm || 300);
    doShoot(p, game, def);
    return true;
  }

  function doShoot(p, game, def) {
    if (!CS.weapons || typeof CS.weapons.hitscan !== 'function') return;
    var isKnife = def.slot === 'knife';
    var eyePos = eye(p);
    var spread = computeSpread(p, game, def);
    var fwd = M.cameraForward(p.yaw, p.pitch);
    var right = M.cameraRight(p.yaw);
    var up = M.cameraUp(p.yaw, p.pitch);
    var dir = fwd;
    if (spread > 0.0002) {
      var ang = Math.random() * TAU;
      var r = Math.sqrt(Math.random()) * spread;
      var cx = Math.cos(ang) * r, sy = Math.sin(ang) * r;
      dir = V3.norm([
        fwd[0] + right[0] * cx + up[0] * sy,
        fwd[1] + right[1] * cx + up[1] * sy,
        fwd[2] + right[2] * cx + up[2] * sy
      ]);
    }
    var maxDist = num(def.range, 80);
    var hit = null;
    try { hit = CS.weapons.hitscan(game, eyePos, dir, maxDist, p); }
    catch (e) { warnOnce('hitscan', e); hit = null; }

    var muzzle = muzzleWorld(p, def);
    var end = hit ? hit.point
      : [eyePos[0] + dir[0] * maxDist, eyePos[1] + dir[1] * maxDist, eyePos[2] + dir[2] * maxDist];

    emit(game, {
      type: 'shot', weapon: def.id,
      pos: isKnife ? eyePos : muzzle,
      byPlayer: true, attacker: p
    });

    if (!isKnife) {
      callFx('muzzle', [muzzle, dir, def.id === 'awp' ? 1.4 : 1.0]);
      callFx('tracer', [muzzle, end, TRACER_COLORS[def.id] || [1.0, 0.84, 0.46]]);
      var shellPos = [
        eyePos[0] + right[0] * 0.16 - up[0] * 0.10,
        eyePos[1] + right[1] * 0.16 - up[1] * 0.10,
        eyePos[2] + right[2] * 0.16 - up[2] * 0.10
      ];
      callFx('shell', [shellPos, [
        right[0] * 0.8 + up[0] * 0.55,
        right[1] * 0.8 + up[1] * 0.55,
        right[2] * 0.8 + up[2] * 0.55
      ]]);
    }

    if (hit) {
      if (hit.target) {
        callFx('blood', [hit.point, dir]);
        var res = null;
        try { res = CS.weapons.hit(game, hit.target, def.damage, p, def.id, hit.zone, hit.point); }
        catch (e) { warnOnce('weapons.hit', e); res = null; }
        if (res) {
          emit(game, {
            type: 'hitmarker',
            headshot: hit.zone === 'head',
            kill: !!res.killed
          });
        }
      } else {
        callFx('impact', [hit.point, hit.normal || [0, 1, 0], (hit.box && hit.box.kind) || 'concrete']);
      }
    }

    applyRecoil(p, def);
    p.bloom = Math.min(BLOOM_MAX, p.bloom + num(def.spreadBloom, 0.008));
    p.burstShots++;
    p.burstTimer = 0;
  }

  function applyRecoil(p, def) {
    var rv = (def.recoil && def.recoil.v) || 0;
    var rh = (def.recoil && def.recoil.h) || 0;
    var vArr = def.patternV || [1];
    var hArr = def.patternH || [0];
    var i = Math.min(p.burstShots, vArr.length - 1);
    var j = Math.min(p.burstShots, hArr.length - 1);
    var upRad = rv * (vArr[i] || 1) * DEG;
    var sideRad = (rh * (hArr[j] || 0) + (Math.random() - 0.5) * rh * 0.30) * DEG;
    if (upRad || sideRad) {
      p.pitch = clamp(p.pitch + upRad, -PITCH_LIMIT, PITCH_LIMIT);
      p.yaw = M.normalizeAngle(p.yaw + sideRad);
      p.recoilAccum.up += upRad;
      p.recoilAccum.side += sideRad;
    }
    p.viewKick = Math.min(0.20, p.viewKick + Math.abs(upRad) * 1.6 + 0.004);
    p.vmKick = Math.min(0.34, p.vmKick + ((def.kick || 0.03) * 1.5));
    p.vmKickSide = (Math.random() - 0.5) * (def.kick || 0.03) * 0.6;
  }

  function updateRecoil(p, dt) {
    p.burstTimer += dt;
    if (p.recoilAccum.up !== 0 || p.recoilAccum.side !== 0) {
      if (p.burstTimer > RECOIL_DELAY) {
        var k = Math.min(1, dt * RECOIL_RECOVER);
        var ru = p.recoilAccum.up * k;
        var rs = p.recoilAccum.side * k;
        p.pitch = clamp(p.pitch - ru, -PITCH_LIMIT, PITCH_LIMIT);
        p.yaw = M.normalizeAngle(p.yaw - rs);
        p.recoilAccum.up -= ru;
        p.recoilAccum.side -= rs;
        if (Math.abs(p.recoilAccum.up) < 1e-5) p.recoilAccum.up = 0;
        if (Math.abs(p.recoilAccum.side) < 1e-5) p.recoilAccum.side = 0;
      }
    }
    if (p.burstTimer > 0.42 && p.burstShots !== 0) p.burstShots = 0;
    var decay = Math.exp(-dt * 11);
    p.vmKick *= decay;
    p.vmKickSide *= decay;
    p.viewKick *= Math.exp(-dt * 9);
    if (p.vmKick < 1e-4) p.vmKick = 0;
  }

  function computeSpread(p, game, def) {
    if (!def) return 0.01;
    var sp = def.spread || [0.005, 0.05, 0.15];
    var hs = p.hspeed !== undefined ? p.hspeed : 0;
    var moveFactor = clamp(hs / RUN_SPEED, 0, 1);
    var air = p.onGround ? 0 : 1;
    var s;
    if (p.scoped && def.id === 'awp') {
      s = (sp[0] || 0) * 0.12 + (sp[1] || 0) * 0.35 * moveFactor + (sp[2] || 0) * 0.45 * air + p.bloom * 0.22;
    } else {
      s = (sp[0] || 0) + (sp[1] || 0) * moveFactor + (sp[2] || 0) * air + p.bloom;
      if (p.crouching) s *= 0.68;
    }
    if (def.slot === 'knife') {
      s = 0.02 + moveFactor * 0.14 + air * 0.10;
    }
    s = Math.max(s, 0.0004);
    p.spread = s;
    p.crosshairSpread = clamp(s / SPREAD_DISPLAY_MAX, 0, 1);
    return s;
  }

  function crosshairPixels(p, game) {
    var px = 4 + p.crosshairSpread * 26;
    if (p.scoped) px = 4;
    return Math.round(clamp(px, 4, 30));
  }

  /* --------------------------------------------------------------------- *
   *  Weapon actions (only when canAct)
   * --------------------------------------------------------------------- */
  function handleActions(p, game, def, fireEdge, fireHeld, rightEdge) {
    if (pressed(game.input, 'reload')) startReload(p, game, def);
    if (pressed(game.input, 'slot1')) switchSlot(p, 'primary');
    if (pressed(game.input, 'slot2')) switchSlot(p, 'secondary');
    if (pressed(game.input, 'slot3')) switchSlot(p, 'knife');

    def = p.def || def;
    if (rightEdge && def.id === 'awp') toggleScope(p, def);

    var locked = !!(game.input && game.input.locked);
    if (!locked) return;
    if (p.drawT > 0) return;

    /* firing interrupts a reload if there is ammo (CS-like) */
    if (p.reloading && (fireEdge || (fireHeld && def.auto))) {
      var am = def.slot === 'knife' ? null : p.ammo[def.id];
      if (def.slot === 'knife' || (am && am.mag > 0)) {
        p.reloading = false;
        p.reloadT = 0;
        p.reloadWeaponId = null;
      }
    }
    if (!p.reloading) tryFire(p, game, def, fireEdge, fireHeld);
  }

  /* --------------------------------------------------------------------- *
   *  Main per-frame update
   * --------------------------------------------------------------------- */
  function update(p, game, dt) {
    if (!game) return;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.05) dt = 0.05;
    p.time += dt;

    var input = game.input || {};
    var keys = input.keys || {};

    var frozen = game.frozen === true;
    var hudBlocked = false;
    if (game.hud && typeof game.hud.isBlockingInput === 'function') {
      try { hudBlocked = !!game.hud.isBlockingInput(); } catch (e) {}
    }
    var canAct = p.alive && !frozen && !hudBlocked;

    var def = p.def || currentDefOf(p);
    p.def = def;

    /* fire / right-click edges must be tracked even while frozen/dead */
    var mNow = !!input.mouseDown;
    var fireEdge = pressed(input, 'fire') || (mNow && !p.prevMouse);
    p.prevMouse = mNow;
    var rNow = !!input.rightDown;
    var rightEdge = !!input.rightPressed || (rNow && !p.prevRight);
    p.prevRight = rNow;

    /* look is always allowed while pointer-locked (dead camera handled by main) */
    applyLook(p, game, input, dt);

    tickTimers(p, game, dt);

    if (p.alive) {
      updateMovement(p, game, input, keys, canAct, dt);
    } else {
      p.vel[0] = 0; p.vel[2] = 0;
    }

    if (canAct) handleActions(p, game, def, fireEdge, fireHeldOf(input), rightEdge);

    updateRecoil(p, dt);
    updateDerived(p, game, def, dt);
  }

  function fireHeldOf(input) { return !!(input && input.mouseDown); }

  function updateMovement(p, game, input, keys, canAct, dt) {
    var wishX = 0, wishZ = 0;
    if (canAct) {
      var fX = Math.sin(p.yaw), fZ = -Math.cos(p.yaw);
      var rX = Math.cos(p.yaw), rZ = Math.sin(p.yaw);
      if (key(keys, 'KeyW')) { wishX += fX; wishZ += fZ; }
      if (key(keys, 'KeyS')) { wishX -= fX; wishZ -= fZ; }
      if (key(keys, 'KeyD')) { wishX += rX; wishZ += rZ; }
      if (key(keys, 'KeyA')) { wishX -= rX; wishZ -= rZ; }
      var wl = Math.sqrt(wishX * wishX + wishZ * wishZ);
      if (wl > 1e-4) { wishX /= wl; wishZ /= wl; } else { wishX = 0; wishZ = 0; }
    }
    p.walking = canAct && !!(key(keys, 'ShiftLeft') || key(keys, 'ShiftRight'));

    /* crouch (kept simple: only stand up when there is headroom) */
    var wantCrouch = canAct && !!(key(keys, 'ControlLeft') || key(keys, 'ControlRight') || key(keys, 'KeyC'));
    if (wantCrouch) p.crouching = true;
    else if (p.crouching && canStand(p, game)) p.crouching = false;
    var hTarget = p.crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
    var eTarget = p.crouching ? EYE_CROUCH : EYE_STAND;
    p.height += (hTarget - p.height) * Math.min(1, dt * 12);
    p.eyeHeight += (eTarget - p.eyeHeight) * Math.min(1, dt * 12);

    var speed = p.crouching ? CROUCH_SPEED : (p.walking ? WALK_SPEED : RUN_SPEED);
    if (p.scoped) speed *= 0.5;

    if (p.onGround) {
      var hs0 = Math.sqrt(p.vel[0] * p.vel[0] + p.vel[2] * p.vel[2]);
      if (hs0 > 0.02) {
        var control = Math.max(hs0, STOP_SPEED);
        var drop = control * FRICTION * dt;
        var ns = Math.max(0, hs0 - drop);
        var sc = ns / hs0;
        p.vel[0] *= sc; p.vel[2] *= sc;
      }
      var cur = p.vel[0] * wishX + p.vel[2] * wishZ;
      var add = speed - cur;
      if (add > 0) {
        var acc = Math.min(ACCEL * dt * speed, add);
        p.vel[0] += wishX * acc;
        p.vel[2] += wishZ * acc;
      }
    } else {
      var curA = p.vel[0] * wishX + p.vel[2] * wishZ;
      var addA = speed - curA;
      if (addA > 0) {
        var accA = Math.min(AIR_ACCEL * dt, addA);
        p.vel[0] += wishX * accA;
        p.vel[2] += wishZ * accA;
      }
    }

    /* jump on edge (keyboard and/or main's pressed.jump) */
    var jumpEdge = pressed(input, 'jump') || (key(keys, 'Space') && !p.prevSpace);
    p.prevSpace = !!key(keys, 'Space');
    if (canAct && p.onGround && jumpEdge) {
      p.vel[1] = JUMP_VEL;
      p.onGround = false;
    }

    /* gravity + integrate + collide */
    p.vel[1] -= GRAVITY * dt;
    if (p.vel[1] < -MAX_FALL) p.vel[1] = -MAX_FALL;
    var res = moveEntity(p, game, [p.vel[0] * dt, p.vel[1] * dt, p.vel[2] * dt]);
    p.pos = res.pos;
    p.onGround = !!res.onGround;
    if (p.onGround && p.vel[1] < 0) p.vel[1] = 0;
    if (res.hitCeil && p.vel[1] > 0) p.vel[1] = 0;

    p.hspeed = Math.sqrt(p.vel[0] * p.vel[0] + p.vel[2] * p.vel[2]);

    /* footsteps: one event every ~2 m of ground travel */
    if (p.onGround && p.hspeed > 1.2) {
      p.stepDist += p.hspeed * dt;
      var interval = p.walking ? 2.7 : (p.crouching ? 2.7 : 2.0);
      if (p.stepDist >= interval) {
        p.stepDist = 0;
        emit(game, {
          type: 'step',
          pos: [p.pos[0], p.pos[1], p.pos[2]],
          byPlayer: true,
          volume: p.walking ? 0.30 : (p.crouching ? 0.35 : 0.9)
        });
      }
    } else if (!p.onGround) {
      p.stepDist = 0;
    }
  }

  /* decay bloom / spread / fov / bob / sway, cache the viewmodel pose */
  function updateDerived(p, game, def, dt) {
    if (p.burstTimer > 0.20) p.bloom *= Math.exp(-dt * 6.5);
    else p.bloom = Math.max(0, p.bloom - dt * 0.06);
    if (p.bloom < 0.0006) p.bloom = 0;
    computeSpread(p, game, def);

    var baseFov = (game.settings && typeof game.settings.fov === 'number') ? game.settings.fov : 90;
    var targetFov = (p.scoped && p.alive) ? 35 : baseFov;
    p.fov += (targetFov - p.fov) * Math.min(1, dt * 16);

    if (p.alive && p.onGround) {
      p.bobT += dt * clamp(p.hspeed / RUN_SPEED, 0, 1.15);
    }

    p.swayTargetYaw *= Math.exp(-dt * 7);
    p.swayTargetPitch *= Math.exp(-dt * 7);
    p.swayYaw += (p.swayTargetYaw - p.swayYaw) * Math.min(1, dt * 14);
    p.swayPitch += (p.swayTargetPitch - p.swayPitch) * Math.min(1, dt * 14);

    p.vmAnim = vmAnim(p, def);
  }

  /* --------------------------------------------------------------------- *
   *  Viewmodel animation pose (offsets/rotations in camera-local space)
   * --------------------------------------------------------------------- */
  function vmAnim(p, def) {
    var bobAmt = p.onGround ? clamp(p.hspeed / RUN_SPEED, 0, 1) : 0.22;
    var phase = p.bobT * 14.0;
    var bobX = Math.sin(phase) * 0.013 * bobAmt;
    var bobY = -Math.abs(Math.cos(phase)) * 0.011 * bobAmt;
    var breathY = Math.sin(p.time * 1.55) * 0.0017 + Math.sin(p.time * 0.71) * 0.0012;
    var breathX = Math.sin(p.time * 0.9) * 0.0013;

    var kick = p.vmKick;                 /* recoil translation (m) */
    var kickZ = kick * 0.30;
    var kickY = kick * 0.10;

    var rl = 0;                          /* reload dip 0..1..0 */
    if (p.reloading && def && def.reloadTime > 0) {
      var t = clamp(1 - p.reloadT / def.reloadTime, 0, 1);
      rl = Math.sin(Math.PI * t);
    }
    var dr = 0;                          /* draw raise 1..0 */
    if (p.drawT > 0 && def && def.drawTime > 0) dr = clamp(p.drawT / def.drawTime, 0, 1);
    var drs = dr * dr;

    var x = bobX + breathX + p.swayYaw * 0.05 + kick * 0.010 + p.vmKickSide * 0.10;
    var y = bobY + breathY - rl * 0.16 - drs * 0.30 - kickY;
    /* never let the model creep closer than ~0.35 m to the near plane */
    var z = Math.min(kickZ + rl * 0.030 + drs * 0.030, 0.090);

    var rx = p.swayPitch * 0.9 + p.viewKick * 0.9 + rl * 0.75 + drs * 0.55;
    var ry = p.swayYaw * 0.9 + rl * 0.32;
    var rz = -p.swayYaw * 0.55 + rl * 0.30;
    return { x: x, y: y, z: z, rx: rx, ry: ry, rz: rz };
  }

  function vmBaseMatrix(p, def) {
    var cfg = vmConfig(def);
    var a = p.vmAnim || vmAnim(p, def);
    var cam = M4.cameraWorld(eye(p), p.yaw, p.pitch);
    var off = cfg.viewOffset;
    var root = M4.translation(off[0], off[1], off[2]);
    var rot = M4.multiply(
      M4.rotationY(a.ry + cfg.baseYaw),
      M4.multiply(M4.rotationX(a.rx), M4.rotationZ(a.rz + cfg.baseRoll))
    );
    var anim = M4.multiply(M4.translation(a.x, a.y, a.z), rot);
    return M4.multiply(M4.multiply(cam, root), anim);
  }

  function muzzleWorld(p, def) {
    var cfg = vmConfig(def);
    var base = vmBaseMatrix(p, def);
    var mz = cfg.muzzle;
    return V3.transformMat4([mz[0], mz[1], mz[2], 1], base);
  }

  /* --------------------------------------------------------------------- *
   *  CS.player.renderViewmodel(renderer) — CONTRACT §10
   * --------------------------------------------------------------------- */
  function renderViewmodel(p, renderer) {
    if (!renderer || typeof renderer.drawBox !== 'function') return;
    if (!p || !p.alive) return;
    var def = p.def || currentDefOf(p);
    p.def = def;
    if (p.scoped && def.id === 'awp') return;   /* scoped: HUD/scope hides the gun */
    var cfg = vmConfig(def);
    var base = vmBaseMatrix(p, def);
    for (var i = 0; i < cfg.parts.length; i++) {
      var part = cfg.parts[i];
      var mat = M4.multiply(base, part.m);
      renderer.drawBox('white', mat, part.tint, 1);
    }
  }

  /* --------------------------------------------------------------------- *
   *  Equip / round reset / death
   * --------------------------------------------------------------------- */
  function equip(p, game, weaponId) {
    var d = defs();
    var def = d[weaponId];
    if (!def) return false;
    p.loadout[def.slot] = weaponId;
    p.ammo[weaponId] = { mag: def.mag || 0, reserve: def.reserve || 0 };
    p.current = def.slot;
    p.def = def;
    p.reloading = false; p.reloadT = 0; p.reloadWeaponId = null;
    p.scoped = false;
    p.drawT = num(def.drawTime, 0.8);
    p.fireT = 0;
    p.burstShots = 0; p.burstTimer = 99;
    p.bloom = 0;
    callAudio('switch');
    return true;
  }

  function spawnDefaults(game) {
    var w = (game && game.world) || CS.world;
    if (w && w.spawns && w.spawns.ct && w.spawns.ct.length) {
      var s = w.spawns.ct[0];
      if (s && s.pos) {
        return {
          pos: [num(s.pos[0], 0), num(s.pos[1], 0), num(s.pos[2], -25)],
          yaw: (typeof s.yaw === 'number') ? s.yaw : null
        };
      }
    }
    return { pos: [0, 0, -25], yaw: null };
  }

  function yawTowardCenter(pos) {
    var dx = 0 - pos[0], dz = 0 - pos[2];
    if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return Math.PI;
    return M.normalizeAngle(Math.atan2(dx, -dz));
  }

  function resetForRound(p, game, opts) {
    opts = opts || {};
    var sp = spawnDefaults(game);
    var pos = opts.pos || sp.pos;
    p.pos = [num(pos[0], 0), num(pos[1], 0), num(pos[2], -25)];
    var yaw = opts.yaw;
    if (typeof yaw !== 'number') yaw = (typeof sp.yaw === 'number') ? sp.yaw : yawTowardCenter(p.pos);
    p.yaw = M.normalizeAngle(yaw);
    p.pitch = 0;
    p.vel = [0, 0, 0];
    p.hspeed = 0;

    p.health = 100;
    p.alive = true;
    p.armor = num(opts.armor, 0);
    p.crouching = false; p.walking = false;
    p.height = STAND_HEIGHT; p.eyeHeight = EYE_STAND;
    p.onGround = true;
    p.scoped = false;
    p.fov = (game && game.settings && typeof game.settings.fov === 'number') ? game.settings.fov : 90;

    p.reloading = false; p.reloadT = 0; p.reloadWeaponId = null;
    p.drawT = 0; p.fireT = 0;
    p.spread = 0.0035; p.crosshairSpread = 0; p.bloom = 0;
    p.burstShots = 0; p.burstTimer = 99;
    p.recoilAccum.up = 0; p.recoilAccum.side = 0;
    p.viewKick = 0; p.vmKick = 0; p.vmKickSide = 0;
    p.swayYaw = 0; p.swayPitch = 0; p.swayTargetYaw = 0; p.swayTargetPitch = 0;
    p.bobT = 0; p.stepDist = 0;
    p.killedBy = null; p.killedByWeapon = null; p.deathZone = null;

    if (opts.keepWeapons) {
      if (!p.loadout || typeof p.loadout !== 'object') p.loadout = { primary: null, secondary: 'usp', knife: 'knife' };
      if (!p.loadout.knife) p.loadout.knife = 'knife';
      if (!p.loadout.secondary) p.loadout.secondary = 'usp';
      ensureAmmo(p);
      /* current weapon may no longer exist -> fall back to the best slot */
      var curId = p.loadout[p.current];
      if (!curId || !defs()[curId]) {
        p.current = p.loadout.primary ? 'primary' : (p.loadout.secondary ? 'secondary' : 'knife');
      }
    } else {
      p.loadout = { primary: null, secondary: 'usp', knife: 'knife' };
      p.current = 'secondary';
      fillAllAmmo(p);
    }
    p.def = currentDefOf(p);
    p.vmAnim = vmAnim(p, p.def);
  }

  function onKilled(p, attacker, weaponId, zone) {
    p.alive = false;
    p.health = 0;
    p.vel = [0, 0, 0];
    p.hspeed = 0;
    p.reloading = false; p.reloadT = 0; p.reloadWeaponId = null;
    p.scoped = false;
    p.crouching = false;
    p.bloom = 0;
    p.crosshairSpread = 0;
    p.recoilAccum.up = 0; p.recoilAccum.side = 0;
    p.viewKick = 0; p.vmKick = 0;
    p.killedBy = attacker ? (attacker.name || attacker.id || '敌人') : '环境';
    p.killedByWeapon = weaponId || null;
    p.deathZone = zone || null;
    /* K/D is incremented by rules.onEvent('kill'); do not double-count here. */
  }

  /* --------------------------------------------------------------------- *
   *  Module API (CS.player.*) — also delegated on the instance above
   * --------------------------------------------------------------------- */
  P.init = function (game) {
    game = game || {};
    var sp = spawnDefaults(game);
    var pos = sp.pos;
    var yaw = (typeof sp.yaw === 'number') ? sp.yaw : yawTowardCenter(pos);
    var p = createPlayer(game, pos, yaw);
    state = p;
    game.player = p;
    p.vmAnim = vmAnim(p, p.def);
    return p;
  };

  P.update = function (game, dt) { if (state) update(state, game, dt); };
  P.renderViewmodel = function (renderer) { if (state) renderViewmodel(state, renderer); };
  P.rayTest = function (origin, dir, maxDist) { return state ? rayTest(state, origin, dir, maxDist) : null; };
  P.eye = function () { return state ? eye(state) : [0, EYE_STAND, 0]; };
  P.currentDef = function () { return state ? (state.def || currentDefOf(state)) : ((defs().usp) || (defs().knife)); };
  P.equip = function (game, weaponId) { return state ? equip(state, game, weaponId) : false; };
  P.resetForRound = function (game, opts) { if (state) resetForRound(state, game, opts); };
  P.onKilled = function (attacker, weaponId, zone) { if (state) onKilled(state, attacker, weaponId, zone); };
  P.crosshairPixels = function (game) { return state ? crosshairPixels(state, game) : 4; };
  P.get = function () { return state; };

  /* expose a few tunables for tests/tools */
  P.tuning = {
    runSpeed: RUN_SPEED, walkSpeed: WALK_SPEED, crouchSpeed: CROUCH_SPEED,
    gravity: GRAVITY, jumpVel: JUMP_VEL, radius: RADIUS,
    standHeight: STAND_HEIGHT, crouchHeight: CROUCH_HEIGHT,
    eyeStand: EYE_STAND, eyeCrouch: EYE_CROUCH, sensPerPixel: SENS_PER_PIXEL
  };
})();
