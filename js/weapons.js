/* =========================================================================
 * DUST STRIKE — weapon definitions, hitscan & unified damage (CONTRACT.md §9)
 * Owned by: combat. Loaded after js/world.js and before js/player.js.
 *
 * CONTRACT-GAP notes (additive fields only; required contract fields unchanged):
 *  - `spread` values are RADIANS of inaccuracy: [standing, moving, airborne].
 *    player.js converts them to the 0..1 `crosshairSpread` for the HUD.
 *  - `spreadBloom` (rad) is added per shot for sustained fire; `patternV` /
 *    `patternH` are recoil-pattern multipliers consumed by player.js.
 *  - `vm` selects the first-person model style in player.js.
 *  - `armorPen` defaults to 0.5 exactly as CONTRACT §9 requires; it is kept in
 *    the defs so it can be tuned later without touching damage code.
 * ========================================================================= */
(function () {
  'use strict';
  var CS = window.CS = window.CS || {};
  var W = CS.weapons = CS.weapons || {};

  /* --------------------------------------------------------------------- *
   *  Weapon table (CONTRACT §9). Prices/numbers may be tuned, fields stay.
   * --------------------------------------------------------------------- */
  var defs = W.defs = {
    knife: {
      id: 'knife', name: '匕首', slot: 'knife', price: 0,
      damage: 55, headshot: 1.6, rpm: 120, mag: 0, reserve: 0, range: 2.0,
      auto: false, reloadTime: 0, drawTime: 0.4,
      kick: 0.05, spread: [0.002, 0.010, 0.040], recoil: { v: 0, h: 0 },
      sound: 'knife_swing', armorPen: 0.5, vm: 'knife',
      spreadBloom: 0, patternV: [1], patternH: [0]
    },
    usp: {
      id: 'usp', name: 'USP-S', slot: 'secondary', price: 200,
      damage: 30, headshot: 3.2, rpm: 350, mag: 12, reserve: 100, range: 55,
      auto: false, reloadTime: 2.2, drawTime: 1.0,
      kick: 0.018, spread: [0.0035, 0.032, 0.16], recoil: { v: 0.70, h: 0.25 },
      sound: 'usp', armorPen: 0.5, vm: 'pistol', spreadBloom: 0.0090,
      patternV: [1.00, 0.95, 0.90, 0.85, 0.80, 0.76, 0.72, 0.70, 0.68, 0.66,
                 0.64, 0.62, 0.60, 0.58, 0.56, 0.55],
      patternH: [0.00, 0.25, -0.10, 0.35, -0.25, 0.45, -0.35, 0.30, -0.20, 0.40,
                 -0.30, 0.20, -0.15, 0.25, -0.20, 0.15]
    },
    glock: {
      id: 'glock', name: 'Glock-18', slot: 'secondary', price: 200,
      damage: 26, headshot: 3.0, rpm: 400, mag: 20, reserve: 120, range: 60,
      auto: false, reloadTime: 2.0, drawTime: 0.9,
      kick: 0.016, spread: [0.005, 0.035, 0.17], recoil: { v: 0.75, h: 0.30 },
      sound: 'glock', armorPen: 0.5, vm: 'pistol', spreadBloom: 0.0100,
      patternV: [1.00, 0.95, 0.90, 0.84, 0.79, 0.75, 0.71, 0.68, 0.66, 0.64,
                 0.62, 0.60, 0.58, 0.56, 0.55, 0.54],
      patternH: [0.00, -0.25, 0.15, -0.35, 0.25, -0.45, 0.35, -0.30, 0.20, -0.40,
                 0.30, -0.20, 0.15, -0.25, 0.20, -0.15]
    },
    m4a1: {
      id: 'm4a1', name: 'M4A1-S', slot: 'primary', price: 2900,
      damage: 33, headshot: 3.8, rpm: 600, mag: 30, reserve: 90, range: 80,
      auto: true, reloadTime: 3.1, drawTime: 1.0,
      kick: 0.030, spread: [0.004, 0.050, 0.170], recoil: { v: 0.90, h: 0.42 },
      sound: 'm4a1', armorPen: 0.5, vm: 'rifle', spreadBloom: 0.0085,
      patternV: [0.30, 0.55, 0.78, 0.92, 1.02, 1.06, 1.04, 1.00, 0.96, 0.92,
                 0.88, 0.84, 0.80, 0.76, 0.72, 0.68, 0.64, 0.60, 0.58, 0.56],
      patternH: [0.00, 0.10, 0.25, 0.45, 0.64, 0.54, 0.24, -0.15, -0.40, -0.55,
                 -0.45, -0.20, 0.10, 0.30, 0.40, 0.25, 0.00, -0.20, -0.30, -0.25]
    },
    ak47: {
      id: 'ak47', name: 'AK-47', slot: 'primary', price: 2700,
      damage: 36, headshot: 3.9, rpm: 600, mag: 30, reserve: 90, range: 80,
      auto: true, reloadTime: 2.9, drawTime: 1.0,
      kick: 0.040, spread: [0.005, 0.055, 0.190], recoil: { v: 1.15, h: 0.55 },
      sound: 'ak47', armorPen: 0.5, vm: 'rifle', spreadBloom: 0.0110,
      patternV: [0.30, 0.55, 0.80, 0.96, 1.06, 1.10, 1.06, 1.00, 0.95, 0.90,
                 0.85, 0.80, 0.75, 0.70, 0.66, 0.62, 0.58, 0.55, 0.52, 0.50],
      patternH: [0.00, 0.15, 0.35, 0.60, 0.85, 0.70, 0.20, -0.30, -0.65, -0.85,
                 -0.70, -0.35, 0.10, 0.45, 0.60, 0.35, 0.00, -0.30, -0.50, -0.40]
    },
    awp: {
      id: 'awp', name: 'AWP', slot: 'primary', price: 4750,
      damage: 115, headshot: 4.0, rpm: 41, mag: 10, reserve: 30, range: 120,
      auto: false, reloadTime: 3.7, drawTime: 1.35,
      kick: 0.120, spread: [0.003, 0.090, 0.260], recoil: { v: 3.00, h: 0.70 },
      sound: 'awp', armorPen: 0.5, vm: 'sniper', spreadBloom: 0.0120,
      /* AWP is single shot: one huge kick, then near-full recovery. */
      patternV: [1.0, 0.85, 0.75, 0.70, 0.70, 0.70],
      patternH: [0.0, 0.30, -0.20, 0.25, -0.20, 0.15]
    }
  };

  /* Defensive console reporting for cross-module failures. */
  var warned = {};
  function warnOnce(tag, err) {
    if (warned[tag]) return;
    warned[tag] = true;
    try { if (window.console && console.warn) console.warn('[weapons] ' + tag + ':', err); } catch (e) {}
  }

  function emit(game, ev) {
    if (!game || !ev) return;
    if (typeof game.emit === 'function') { game.emit(ev); return; }
    if (game.events && typeof game.events.push === 'function') game.events.push(ev);
  }

  /* world.raycast wrapper — never lets a renderer/world bug kill the game loop. */
  function raycastWorld(game, origin, dir, maxDist) {
    var world = (game && game.world) || CS.world;
    if (!world || typeof world.raycast !== 'function') return null;
    try { return world.raycast(origin, dir, maxDist); }
    catch (e) { warnOnce('world.raycast', e); return null; }
  }

  /* --------------------------------------------------------------------- *
   *  CS.weapons.hitscan(game, origin, dir, maxDist, shooter)
   *  -> {target, point, zone, dist}         actor hit (nearest)
   *  -> {target:null, point, normal, dist}  wall hit only
   *  -> null                                nothing within maxDist
   *  Skips the shooter, teammates and dead actors (no friendly fire).
   * --------------------------------------------------------------------- */
  W.hitscan = function (game, origin, dir, maxDist, shooter) {
    if (!origin || !dir) return null;
    var dl = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    if (!(dl > 1e-6)) return null;
    var d = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
    if (!(maxDist > 0)) maxDist = 200;

    var wall = raycastWorld(game, origin, d, maxDist);
    var bestDist = Infinity, bestHit = null, bestActor = null;
    if (wall && typeof wall.dist === 'number' && wall.dist >= 0 && wall.dist <= maxDist) {
      bestDist = wall.dist;
      bestHit = wall;
    }

    var actors = [];
    var player = game && game.player;
    if (player && player !== shooter) actors.push(player);
    var bots = (game && game.bots) || [];
    for (var i = 0; i < bots.length; i++) {
      var b = bots[i];
      if (b && b !== shooter) actors.push(b);
    }

    for (var k = 0; k < actors.length; k++) {
      var a = actors[k];
      if (!a || a.alive === false) continue;
      if (shooter && a.team && shooter.team && a.team === shooter.team) continue;
      if (typeof a.rayTest !== 'function') continue;
      var hit;
      try { hit = a.rayTest(origin, d, maxDist); }
      catch (e) { warnOnce('rayTest', e); continue; }
      if (!hit || typeof hit.dist !== 'number' || !(hit.dist >= 0) || hit.dist > maxDist) continue;
      if (hit.dist < bestDist) {
        bestDist = hit.dist;
        bestHit = hit;
        bestActor = a;
      }
    }

    if (bestActor) {
      return {
        target: bestActor,
        point: bestHit.point || [origin[0] + d[0] * bestDist, origin[1] + d[1] * bestDist, origin[2] + d[2] * bestDist],
        zone: bestHit.zone || 'body',
        dist: bestDist
      };
    }
    if (bestHit) {
      return {
        target: null,
        point: bestHit.point || [origin[0] + d[0] * bestDist, origin[1] + d[1] * bestDist, origin[2] + d[2] * bestDist],
        normal: bestHit.normal || [0, 1, 0],
        dist: bestDist,
        box: bestHit.box || null
      };
    }
    return null;
  };

  /* --------------------------------------------------------------------- *
   *  CS.weapons.hit(game, target, baseDamage, attacker, weaponId, zone, point)
   *  Unified damage entry point (CONTRACT §9):
   *   - no friendly fire / no dead targets
   *   - zone multiplier: head -> def.headshot, legs -> 0.75, else 1
   *   - armor: damage * armorPen(0.5), armor -= baseDamage*0.5
   *   - emits 'damage', then 'kill' + victim.onKilled on death
   *  Returns {damage, killed} (extra convenience for hitmarkers/HUD).
   * --------------------------------------------------------------------- */
  W.hit = function (game, target, baseDamage, attacker, weaponId, zone, point) {
    if (!target || target === attacker) return null;
    if (target.alive === false) return null;
    if (typeof baseDamage !== 'number' || !(baseDamage > 0)) return null;
    if (attacker && target.team && attacker.team && target.team === attacker.team) return null;

    zone = zone || 'body';
    if (typeof target.health !== 'number') target.health = 100;
    if (target.health <= 0) return null;

    var def = defs[weaponId] || null;
    var dmg = baseDamage;
    if (zone === 'head') dmg *= (def && typeof def.headshot === 'number') ? def.headshot : 2.0;
    else if (zone === 'legs') dmg *= 0.75;

    var armor = (typeof target.armor === 'number' && target.armor > 0) ? target.armor : 0;
    if (armor > 0) {
      var pen = (def && typeof def.armorPen === 'number') ? def.armorPen : 0.5;
      dmg *= pen;
      target.armor = Math.max(0, armor - baseDamage * 0.5);   /* CONTRACT §9 */
    }
    if (!(dmg > 0)) return null;
    if (dmg > target.health) dmg = target.health;   /* never report overkill damage */

    target.health = Math.max(0, target.health - dmg);
    var killed = target.health <= 0;
    if (killed) { target.health = 0; target.alive = false; }

    emit(game, {
      type: 'damage', target: target, attacker: attacker,
      amount: Math.round(dmg * 10) / 10, zone: zone,
      point: point || null, weapon: weaponId
    });

    if (killed) {
      emit(game, {
        type: 'kill', killer: attacker, victim: target,
        weapon: weaponId, headshot: zone === 'head'
      });
      if (typeof target.onKilled === 'function') {
        try { target.onKilled(attacker, weaponId, zone); }
        catch (e) { warnOnce('onKilled', e); }
      }
    }
    return { damage: dmg, killed: killed };
  };

  /* Helper used by HUD/audio/bots: resolve a weapon def from an id or entity. */
  W.def = function (id) { return defs[id] || null; };

  W.currentDef = function (player) {
    if (!player) return defs.knife;
    if (typeof player.currentDef === 'function') {
      try { var d = player.currentDef(); if (d) return d; } catch (e) {}
    }
    var id = null;
    if (player.loadout && player.current) id = player.loadout[player.current];
    if (!id && player.def && player.def.id) return player.def;
    return defs[id] || (player.def && player.def.id ? player.def : defs.knife);
  };

  /* ids list for HUD buy menus / bots loadout rolls. */
  W.ids = ['knife', 'usp', 'glock', 'm4a1', 'ak47', 'awp'];
  W.primaryIds = ['m4a1', 'ak47', 'awp'];
  W.secondaryIds = ['usp', 'glock'];
})();
