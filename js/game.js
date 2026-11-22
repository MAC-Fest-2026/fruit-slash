/* Fruit Slash — game logic + browser game (classic script, no imports).
   Pure logic is exported for the Node unit harness (module.exports guard at
   the end); all DOM/canvas code is guarded by `typeof document`. */
(function () {
  'use strict';

  /* ============================== config ============================== */
  // Single speed-threshold setting (PRD §3): the fingertip must move faster
  // than this (canvas px per second, scaled to the smaller screen side)
  // for a swipe to count as a slash. 0.7 = a firm swipe, not a lightning
  // flick — but a slow touch or resting finger (~0-200 px/s) still does
  // nothing. The 200 floor keeps the threshold above a slow drag on the
  // smallest screens while letting phones scale down to ~252 px/s.
  var SLASH_SPEED_FACTOR = 0.7; // x min(canvasWidth, canvasHeight) per second
  var SLASH_CHAIN_WINDOW_MS = 150; // slashes this close together = one swipe
  var MAX_MISSES = 3;
  var HIGH_SCORE_KEY = 'fruitSlashHighScore';
  var GRAVITY_FACTOR = 1.15; // x canvas height, px/s^2 (lowered ~28%: slower arcs, longer hang time)
  var FRUIT_SCALE = 1.45; // fruit + bomb radius multiplier (bigger, juicier targets)

  function slashSpeedThreshold(w, h) {
    // Rounded to whole px/s: 0.7 is not exact in binary, so 0.7*360 would
    // otherwise come out as 251.99999999999997 instead of 252.
    return Math.max(200, Math.round(SLASH_SPEED_FACTOR * Math.min(w, h)));
  }

  /* ============================ fruit types =========================== */
  var FRUIT_TYPES = {
    watermelon: { label: 'Watermelon', r: 46, body: ['#2fae4e', '#0d5c22'], flesh: '#ff4d6d', juice: '#ff4d6d', kind: 'watermelon' },
    orange:     { label: 'Orange',     r: 38, body: ['#ff9f1c', '#e07b00'], flesh: '#ffcf7d', juice: '#ff9f1c', kind: 'orange' },
    apple:      { label: 'Apple',      r: 37, body: ['#ef233c', '#a4161a'], flesh: '#fff3d6', juice: '#ef233c', kind: 'apple' },
    lemon:      { label: 'Lemon',      r: 34, body: ['#ffd60a', '#eab505'], flesh: '#fff3b0', juice: '#ffd60a', kind: 'lemon' },
    kiwi:       { label: 'Kiwi',       r: 33, body: ['#8a5a2b', '#5e3a17'], flesh: '#8ac926', juice: '#8ac926', kind: 'kiwi' }
  };
  var FRUIT_KEYS = ['watermelon', 'orange', 'apple', 'lemon', 'kiwi'];

  /* ============================ pure logic ============================ */
  // One swipe with n fruits: n base points + (n-1) bonus. 2 -> 3, 3 -> 5.
  function comboBonus(chainLength) { return Math.max(0, chainLength - 1); }
  function scoreForSwipe(n) { return n + comboBonus(n); }

  // Difficulty ramp (PRD §3): first 10 s gentle, then faster, bigger groups,
  // more bombs. No timer on the round — it ends only by misses or a bomb.
  // Wave-based spawning: a wave launches several fruits at once, then a
  // short gap (spawnInterval) before the next wave. Waves get bigger and a
  // bit faster the longer the round survives.
  function difficultyAt(t) {
    var gentle = t < 10;
    var since = Math.max(0, t - 10);
    return {
      spawnInterval: gentle ? 1.0 : Math.max(0.8, 1.0 - since * 0.006),
      groupSize: gentle ? 2 : Math.min(6, 2 + Math.floor(since / 15)),
      bombChance: gentle ? 0.05 : Math.min(0.30, 0.05 + since * 0.004),
      launchBoost: 1 + Math.min(0.25, t * 0.003)
    };
  }

  // Plan one wave: how many bodies launch, and how many of them are bombs.
  // Pure (rng injectable) so the harness can test wave composition.
  // - Early waves are 2-3 bodies; later waves grow to 4-6 (see difficultyAt).
  // - Bombs are capped at 2 per wave, and most later waves carry at least
  //   one bomb (a second-chance roll when none was rolled).
  function planWave(t, rng) {
    var d = difficultyAt(t);
    var r = rng || Math.random;
    var total = d.groupSize;
    if (t < 10 && r() < 0.5) total += 1; // early waves vary 2-3
    var bombs = 0;
    for (var i = 0; i < total; i++) {
      if (bombs < 2 && r() < d.bombChance) bombs++;
    }
    if (t >= 20 && bombs === 0 && r() < 0.7) bombs = 1;
    return { total: total, bombs: bombs, fruits: total - bombs };
  }

  // Does the segment (x1,y1)-(x2,y2) pass through the circle? Used so a
  // fast fingertip cannot jump over a fruit between frames.
  function segmentHitsCircle(x1, y1, x2, y2, cx, cy, r) {
    var dx = x2 - x1, dy = y2 - y1;
    var len2 = dx * dx + dy * dy;
    var t = len2 === 0 ? 0 : ((cx - x1) * dx + (cy - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    var px = x1 + t * dx, py = y1 + t * dy;
    var ddx = cx - px, ddy = cy - py;
    return ddx * ddx + ddy * ddy <= r * r;
  }

  function makeFruit(typeKey, x, y, vx, vy, r) {
    return {
      kind: 'fruit', type: typeKey, x: x, y: y, vx: vx, vy: vy,
      r: r, rot: Math.random() * Math.PI * 2,
      vrot: (Math.random() - 0.5) * 5, slashed: false, dead: false
    };
  }
  function makeBomb(x, y, vx, vy, r) {
    return {
      kind: 'bomb', x: x, y: y, vx: vx, vy: vy, r: r,
      rot: Math.random() * Math.PI * 2, vrot: (Math.random() - 0.5) * 2,
      slashed: false, dead: false, fuse: Math.random() * 10
    };
  }
  function updateBody(b, dt, gravity) {
    b.vy += gravity * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.rot += b.vrot * dt;
    if (b.fuse !== undefined) b.fuse += dt;
    return b;
  }
  // A body is a miss when it has fallen off the bottom, still whole.
  function isMissed(b, canvasHeight) {
    return !b.slashed && b.vy > 0 && b.y - b.r > canvasHeight + 40;
  }

  /* ---- round state ---- */
  function newRound() {
    return {
      score: 0, slashed: 0, misses: 0, bestCombo: 0,
      chain: 0, lastSlashAt: -1e9, over: false, reason: null
    };
  }
  // Register one slashed fruit. Returns { points, chain, bonus }.
  function registerSlash(round, nowMs) {
    if (round.over) return { points: 0, chain: 0, bonus: 0 };
    var chain = (nowMs - round.lastSlashAt <= SLASH_CHAIN_WINDOW_MS) ? round.chain + 1 : 1;
    round.lastSlashAt = nowMs;
    round.chain = chain;
    round.slashed += 1;
    var bonus = chain > 1 ? 1 : 0; // each extra fruit in the swipe adds +1
    round.score += 1 + bonus;
    if (chain > round.bestCombo) round.bestCombo = chain;
    return { points: 1 + bonus, chain: chain, bonus: bonus };
  }
  // Register a missed fruit. Returns true when the round is now over.
  function registerMiss(round) {
    if (round.over) return false;
    round.misses += 1;
    round.chain = 0;
    if (round.misses >= MAX_MISSES) { round.over = true; round.reason = 'misses'; return true; }
    return false;
  }
  // Register a slashed bomb. Returns true when the round is now over.
  function registerBomb(round) {
    if (round.over) return false;
    round.over = true; round.reason = 'bomb'; return true;
  }

  /* ---- high score (storage is injectable so tests can pass a fake) ---- */
  function loadHighScore(storage) {
    try {
      var v = parseInt((storage || {}).getItem
        ? storage.getItem(HIGH_SCORE_KEY) : '0', 10);
      return isNaN(v) ? 0 : Math.max(0, v);
    } catch (e) { return 0; }
  }
  // Returns true when the score beat the stored best and was saved.
  function saveHighScore(storage, score) {
    var prev = loadHighScore(storage);
    if (score <= prev) return false;
    try { storage.setItem(HIGH_SCORE_KEY, String(score)); } catch (e) { /* private mode */ }
    return true;
  }

  /* ---- spawn helpers (pure, used by the game loop) ---- */
  function pickSpawn(rng) {
    var roll = (rng || Math.random)();
    return roll;
  }
  function launchVelocity(canvasW, canvasH, x, boost, rng) {
    var rnd = rng || Math.random;
    var vy = -(1.55 + rnd() * 0.3) * canvasH * boost;
    var vx = (canvasW / 2 - x) * (0.1 + rnd() * 0.25) + (rnd() - 0.5) * 80;
    return { vx: vx, vy: vy };
  }

  /* ====================== canvas drawing (fruits) ===================== */
  function fruitScale(w, h) { return Math.min(w, h) / 800 * FRUIT_SCALE; }

  function drawWholeFruit(ctx, typeKey, x, y, r, rot) {
    var t = FRUIT_TYPES[typeKey];
    if (!t) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    var rx = t.kind === 'lemon' ? r * 1.28 : r;
    var ry = t.kind === 'lemon' ? r * 0.82 : r;
    // body
    var g = ctx.createRadialGradient(-rx * 0.35, -ry * 0.4, r * 0.1, 0, 0, r * 1.15);
    g.addColorStop(0, t.body[0]);
    g.addColorStop(1, t.body[1]);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    // details per fruit
    if (t.kind === 'watermelon') {
      ctx.strokeStyle = 'rgba(6, 60, 20, 0.55)';
      ctx.lineWidth = r * 0.09;
      for (var i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(i * rx * 0.32, -ry * 0.92);
        ctx.quadraticCurveTo(i * rx * 0.45, 0, i * rx * 0.32, ry * 0.92);
        ctx.stroke();
      }
    } else if (t.kind === 'orange') {
      ctx.fillStyle = 'rgba(255, 220, 150, 0.5)';
      ctx.beginPath(); ctx.ellipse(0, -ry * 0.72, r * 0.16, r * 0.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#2f7d32'; ctx.lineWidth = r * 0.07;
      ctx.beginPath(); ctx.moveTo(0, -ry); ctx.quadraticCurveTo(r * 0.1, -ry * 1.25, r * 0.3, -ry * 1.2); ctx.stroke();
      ctx.fillStyle = '#43a047';
      ctx.beginPath(); ctx.ellipse(r * 0.34, -ry * 1.12, r * 0.3, r * 0.14, -0.5, 0, Math.PI * 2); ctx.fill();
    } else if (t.kind === 'apple') {
      ctx.strokeStyle = '#6d4c41'; ctx.lineWidth = r * 0.08;
      ctx.beginPath(); ctx.moveTo(0, -ry * 0.9); ctx.quadraticCurveTo(r * 0.08, -ry * 1.2, r * 0.22, -ry * 1.22); ctx.stroke();
      ctx.fillStyle = '#43a047';
      ctx.beginPath(); ctx.ellipse(r * 0.34, -ry * 1.05, r * 0.32, r * 0.15, -0.45, 0, Math.PI * 2); ctx.fill();
    } else if (t.kind === 'lemon') {
      ctx.fillStyle = t.body[1];
      ctx.beginPath(); ctx.ellipse(-rx, 0, r * 0.16, r * 0.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(rx, 0, r * 0.16, r * 0.1, 0, 0, Math.PI * 2); ctx.fill();
    } else if (t.kind === 'kiwi') {
      ctx.strokeStyle = 'rgba(60, 35, 10, 0.5)'; ctx.lineWidth = 1.5;
      for (var k = 0; k < 26; k++) {
        var a = (k / 26) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * rx * 0.82, Math.sin(a) * ry * 0.82);
        ctx.lineTo(Math.cos(a) * rx * 0.98, Math.sin(a) * ry * 0.98);
        ctx.stroke();
      }
    }
    // shine
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.ellipse(-rx * 0.32, -ry * 0.42, rx * 0.3, ry * 0.17, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // One half of a slashed fruit. The flat cut face lies along the slash
  // angle; the round side is rind, the flat side shows the flesh.
  function drawFruitHalf(ctx, typeKey, x, y, r, rot, cutAngle) {
    var t = FRUIT_TYPES[typeKey];
    if (!t) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(cutAngle);
    ctx.rotate(rot * 0.25); // halves tumble gently, cut face stays readable
    // flesh (flat face = the diameter)
    ctx.fillStyle = t.flesh;
    ctx.beginPath();
    ctx.moveTo(-r, 0);
    ctx.arc(0, 0, r, Math.PI, 0, false);
    ctx.closePath();
    ctx.fill();
    // rind around the round side
    ctx.strokeStyle = t.body[1];
    ctx.lineWidth = Math.max(4, r * 0.14);
    ctx.beginPath();
    ctx.arc(0, 0, r - ctx.lineWidth / 2, Math.PI, 0, false);
    ctx.stroke();
    // flesh details
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    if (t.kind === 'watermelon') {
      var seeds = [[-r * 0.5, -r * 0.45], [0, -r * 0.6], [r * 0.5, -r * 0.45], [-r * 0.25, -r * 0.2], [r * 0.28, -r * 0.2]];
      for (var s = 0; s < seeds.length; s++) {
        ctx.beginPath();
        ctx.ellipse(seeds[s][0], seeds[s][1], r * 0.05, r * 0.09, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (t.kind === 'orange' || t.kind === 'lemon') {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = Math.max(2, r * 0.05);
      for (var i = 0; i < 5; i++) {
        var a = Math.PI + (i + 0.5) * (Math.PI / 5);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.14, 0, Math.PI * 2); ctx.fill();
    } else if (t.kind === 'kiwi') {
      ctx.fillStyle = '#f1f8e9';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.34, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1b1b1b';
      for (var q = 0; q < 10; q++) {
        var ang = (q / 10) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(Math.cos(ang) * r * 0.55, Math.sin(ang) * r * 0.55 - r * 0.1, r * 0.045, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (t.kind === 'apple') {
      ctx.fillStyle = '#d7a86e';
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.12);
      ctx.lineTo(-r * 0.16, -r * 0.42); ctx.lineTo(r * 0.02, -r * 0.28);
      ctx.lineTo(r * 0.16, -r * 0.42); ctx.lineTo(0, -r * 0.12);
      ctx.fill();
      ctx.beginPath(); ctx.arc(0, -r * 0.08, r * 0.1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawBomb(ctx, x, y, r, rot, fuseT) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot * 0.2);
    // fuse
    ctx.strokeStyle = '#8d6e63';
    ctx.lineWidth = Math.max(3, r * 0.09);
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.85);
    ctx.quadraticCurveTo(r * 0.35, -r * 1.35, r * 0.62, -r * 1.05);
    ctx.stroke();
    // spark (flickers with time)
    var sp = r * (0.22 + 0.1 * Math.sin(fuseT * 14) + 0.06 * Math.sin(fuseT * 31));
    var sx = r * 0.62, sy = -r * 1.05;
    ctx.fillStyle = '#ffea00';
    ctx.beginPath();
    for (var i = 0; i < 8; i++) {
      var a = (i / 8) * Math.PI * 2 + fuseT;
      var rr = i % 2 === 0 ? sp : sp * 0.45;
      ctx.lineTo(sx + Math.cos(a) * rr, sy + Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ff6d00';
    ctx.beginPath(); ctx.arc(sx, sy, sp * 0.4, 0, Math.PI * 2); ctx.fill();
    // body
    var g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.1);
    g.addColorStop(0, '#4a4a4a');
    g.addColorStop(0.6, '#212121');
    g.addColorStop(1, '#000000');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    // skull-ish warning dot + shine
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath(); ctx.ellipse(-r * 0.32, -r * 0.42, r * 0.28, r * 0.16, -0.6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255, 82, 82, 0.9)';
    ctx.lineWidth = Math.max(2, r * 0.06);
    ctx.beginPath(); ctx.arc(0, r * 0.08, r * 0.34, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ff5252';
    ctx.beginPath(); ctx.arc(-r * 0.12, r * 0.02, r * 0.07, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(r * 0.12, r * 0.02, r * 0.07, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /* ===================== blade trail + particles ====================== */
  function drawBlade(ctx, trail) {
    if (!trail || trail.length < 2) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var i = 1; i < trail.length; i++) {
      var p0 = trail[i - 1], p1 = trail[i];
      var f = i / trail.length; // 0 = tail, 1 = tip
      ctx.strokeStyle = 'rgba(255, 255, 255,' + (0.12 + 0.85 * f) + ')';
      ctx.lineWidth = 2 + 13 * f;
      ctx.shadowColor = 'rgba(120, 220, 255, 0.9)';
      ctx.shadowBlur = 10 * f;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    // blade tip: a small sleek knife pointing along the motion
    var tip = trail[trail.length - 1];
    var prev = trail[trail.length - 2];
    var ang = Math.atan2(tip.y - prev.y, tip.x - prev.x);
    ctx.shadowBlur = 0;
    ctx.translate(tip.x, tip.y);
    ctx.rotate(ang);
    var bg = ctx.createLinearGradient(0, -7, 0, 7);
    bg.addColorStop(0, '#ffffff');
    bg.addColorStop(1, '#90a4ae');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(26, -9, 52, -3);
    ctx.quadraticCurveTo(30, 2, 0, 7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#37474f';
    ctx.fillRect(-14, -4, 14, 8);
    ctx.restore();
  }

  /* ====================== browser game (DOM) ====================== */
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    var $ = function (id) { return document.getElementById(id); };
    var canvas = $('game-canvas');
    var ctx = canvas.getContext('2d');
    var video = $('cam-video');

    var W = 0, H = 0, DPR = 1, S = 1; // CSS-pixel viewport size + fruit scale
    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.round(W * DPR);
      canvas.height = Math.round(H * DPR);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      S = fruitScale(W, H);
    }
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', function () { setTimeout(resize, 120); });
    resize();

    /* ---------- state ---------- */
    var state = 'start'; // start | loading | ready | playing | over
    var mode = 'camera'; // camera | mouse (mouse = pointer fallback, works with touch too)
    var round = newRound();
    var fruits = [], halves = [], particles = [];
    var trail = []; // recent fingertip points {x, y, t}
    var tip = { x: -999, y: -999, px: -999, py: -999, speed: 0, present: false };
    var smooth = { x: 0, y: 0, init: false };
    var lastFrameAt = 0;
    var spawnTimer = 0;
    var roundElapsed = 0;
    var roundStartedAt = 0;
    var highScore = loadHighScore(window.localStorage);
    var tracker = null;
    var trackerWarm = false;
    var readySince = 0;
    var countdown = null; // { step, at }
    var endAt = 0; // when to show the result screen after the round ends
    var endShown = false;
    var boom = null; // { x, y, at } explosion visual
    var ambient = [];
    var soundOn = true;
    var newBest = false;

    function showScreen(name) {
      ['start', 'loading', 'ready', 'result'].forEach(function (n) {
        var el = $('screen-' + n);
        if (el) el.classList.toggle('active', n === name);
      });
      var hud = $('hud');
      if (hud) hud.classList.toggle('active', name === 'ready' || state === 'playing');
    }
    function setStatus(text) { var el = $('loading-status'); if (el) el.textContent = text; }
    function setReadyHint(text) { var el = $('ready-hint'); if (el) el.textContent = text; }

    /* ---------- sounds ---------- */
    var sounds = {};
    function preloadSounds() {
      ['swoosh', 'splat', 'combo', 'bomb'].forEach(function (n) {
        try {
          var a = new Audio('assets/sounds/' + n + '.mp3');
          a.preload = 'auto';
          sounds[n] = a;
        } catch (e) { /* audio unavailable */ }
      });
    }
    function playSound(name, vol) {
      if (!soundOn) return;
      try {
        var a = sounds[name];
        if (!a) return;
        var c = a.cloneNode();
        c.volume = vol == null ? 0.8 : vol;
        var p = c.play();
        if (p && p.catch) p.catch(function () {});
      } catch (e) { /* ignore */ }
    }
    preloadSounds();

    /* ---------- ambient start-screen fruits ---------- */
    function initAmbient() {
      ambient = [];
      for (var i = 0; i < 6; i++) {
        ambient.push({
          type: FRUIT_KEYS[i % FRUIT_KEYS.length],
          x: (0.08 + 0.84 * (i / 6) + (Math.random() - 0.5) * 0.06) * W,
          baseY: H * (0.25 + Math.random() * 0.55),
          phase: Math.random() * Math.PI * 2,
          speed: 0.4 + Math.random() * 0.5,
          r: 30 + Math.random() * 22,
          rot: Math.random() * Math.PI * 2
        });
      }
    }
    initAmbient();

    /* ---------- spawning ---------- */
    function spawnGroup(t) {
      var plan = planWave(t, Math.random);
      // Shuffle bomb/fruit slots so bombs never launch from a fixed spot.
      var kinds = [];
      var i;
      for (i = 0; i < plan.bombs; i++) kinds.push('bomb');
      for (i = 0; i < plan.fruits; i++) kinds.push('fruit');
      for (i = kinds.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = kinds[i]; kinds[i] = kinds[j]; kinds[j] = tmp;
      }
      var d = difficultyAt(t);
      for (i = 0; i < kinds.length; i++) {
        var x = W * (0.1 + Math.random() * 0.8);
        var v = launchVelocity(W, H, x, d.launchBoost, Math.random);
        if (kinds[i] === 'bomb') {
          fruits.push(makeBomb(x, H + 60, v.vx, v.vy, 34 * S + 8));
        } else {
          var key = FRUIT_KEYS[Math.floor(Math.random() * FRUIT_KEYS.length)];
          fruits.push(makeFruit(key, x, H + 60, v.vx, v.vy, FRUIT_TYPES[key].r * S));
        }
      }
    }

    /* ---------- slashing ---------- */
    function slashAt(x1, y1, x2, y2, nowMs) {
      var hitAny = false;
      for (var i = 0; i < fruits.length; i++) {
        var f = fruits[i];
        if (f.slashed || f.dead) continue;
        if (!segmentHitsCircle(x1, y1, x2, y2, f.x, f.y, f.r * 1.08)) continue;
        hitAny = true;
        f.slashed = true;
        f.dead = true;
        if (f.kind === 'bomb') {
          registerBomb(round);
          boom = { x: f.x, y: f.y, at: nowMs };
          playSound('bomb', 1);
          flashScreen();
          endAt = nowMs + 1100; // let the explosion show before the result
          spawnBurst(f.x, f.y, '#ff6d00', 26, 420);
          spawnBurst(f.x, f.y, '#ffd60a', 18, 320);
          spawnBurst(f.x, f.y, '#616161', 14, 220);
        } else {
          var res = registerSlash(round, nowMs);
          playSound('splat', 0.9);
          if (res.chain >= 2) {
            playSound('combo', 0.9);
            showCombo(res.chain);
          }
          splitFruit(f, x2 - x1, y2 - y1);
          spawnBurst(f.x, f.y, FRUIT_TYPES[f.type].juice, 12, 260);
        }
      }
      return hitAny;
    }
    function splitFruit(f, dx, dy) {
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / len, ny = dx / len; // perpendicular to the swipe
      var ang = Math.atan2(dy, dx);
      var push = 130 * S + 60;
      for (var s = -1; s <= 1; s += 2) {
        halves.push({
          type: f.type, x: f.x, y: f.y,
          vx: f.vx * 0.6 + nx * push * s,
          vy: f.vy * 0.6 + ny * push * s - 60,
          r: f.r, rot: f.rot, vrot: s * (3 + Math.random() * 3),
          cutAngle: ang, life: 1
        });
      }
    }
    function spawnBurst(x, y, color, n, speed) {
      for (var i = 0; i < n; i++) {
        var a = Math.random() * Math.PI * 2;
        var v = speed * (0.3 + Math.random() * 0.7);
        particles.push({
          x: x, y: y,
          vx: Math.cos(a) * v, vy: Math.sin(a) * v - 80,
          r: 2 + Math.random() * 5, color: color, life: 1,
          decay: 1.4 + Math.random() * 1.2
        });
      }
    }
    function flashScreen() {
      var el = $('flash');
      if (!el) return;
      el.classList.add('on');
      setTimeout(function () { el.classList.remove('on'); }, 180);
    }
    var comboTimer = null;
    function showCombo(chain) {
      var el = $('combo-pop');
      if (!el) return;
      el.textContent = 'COMBO x' + chain + '  +' + (chain - 1) + ' BONUS';
      el.classList.add('show');
      if (comboTimer) clearTimeout(comboTimer);
      comboTimer = setTimeout(function () { el.classList.remove('show'); }, 900);
    }

    /* ---------- HUD ---------- */
    function updateHUD() {
      var scoreEl = $('hud-score');
      if (scoreEl) scoreEl.textContent = round.score;
      var bestEl = $('hud-best');
      if (bestEl) bestEl.textContent = 'BEST ' + Math.max(highScore, round.score);
      var missEl = $('hud-misses');
      if (missEl) {
        var marks = '';
        for (var i = 0; i < MAX_MISSES; i++) marks += i < round.misses ? '✕' : '○';
        missEl.textContent = marks;
        missEl.classList.toggle('danger', round.misses >= 2);
      }
    }

    /* ---------- fingertip ---------- */
    function readTip(dt) {
      var prevX = tip.x, prevY = tip.y;
      var present = false, tx = 0, ty = 0;
      if (mode === 'camera' && tracker) {
        var nt = tracker.getTip();
        if (nt && nt.present) {
          present = true;
          tx = (1 - nt.x) * W; // mirrored: video x flips on screen
          ty = nt.y * H;
        }
      } else if (mode === 'mouse') {
        if (pointer.present) { present = true; tx = pointer.x; ty = pointer.y; }
      }
      if (present) {
        if (!smooth.init) { smooth.x = tx; smooth.y = ty; smooth.init = true; }
        smooth.x += (tx - smooth.x) * 0.45; // eased interpolation (PRD §5)
        smooth.y += (ty - smooth.y) * 0.45;
        tip.px = tip.x; tip.py = tip.y;
        tip.x = smooth.x; tip.y = smooth.y;
        tip.present = true;
        var d = Math.hypot(tip.x - prevX, tip.y - prevY);
        tip.speed = (prevX < -100 || dt <= 0) ? 0 : d / dt;
        var now = performance.now();
        trail.push({ x: tip.x, y: tip.y, t: now });
        while (trail.length > 14 || (trail.length && now - trail[0].t > 140)) trail.shift();
      } else {
        tip.present = false;
        tip.speed = 0;
        if (trail.length) trail.shift();
      }
      return present;
    }

    /* pointer fallback (mouse + touch — same path, works on phones) */
    var pointer = { x: 0, y: 0, present: false };
    window.addEventListener('pointermove', function (e) {
      pointer.x = e.clientX; pointer.y = e.clientY; pointer.present = true;
    }, { passive: true });
    window.addEventListener('pointerdown', function (e) {
      pointer.x = e.clientX; pointer.y = e.clientY; pointer.present = true;
    }, { passive: true });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    /* ---------- main loop ---------- */
    var wasFast = false;
    function loop(nowMs) {
      requestAnimationFrame(loop);
      var dt = lastFrameAt ? Math.min(0.05, (nowMs - lastFrameAt) / 1000) : 0.016;
      lastFrameAt = nowMs;
      var t = nowMs / 1000;

      ctx.clearRect(0, 0, W, H);
      drawBackground(t);

      if (state === 'start') {
        drawAmbient(t, dt);
      } else if (state === 'loading') {
        // DOM covers the screen; keep the canvas calm.
      } else if (state === 'ready' || state === 'playing' || state === 'over') {
        drawVideoBackground();
        var present = readTip(dt);
        if (state === 'ready') {
          drawTipMarker();
          if (present) {
            if (!readySince) readySince = nowMs;
            var held = nowMs - readySince;
            if (mode === 'mouse') {
              setReadyHint('Blade on your finger — tap START when ready!');
            } else if (held > 400) {
              setReadyHint('Locked on! Get ready…');
              startCountdown(nowMs);
            } else {
              setReadyHint('Hold still — locking onto your hand…');
            }
          } else {
            readySince = 0;
            setReadyHint(mode === 'mouse'
              ? 'Move your mouse or finger — the blade follows it.'
              : 'Raise one hand so the camera can see it.');
          }
        } else if (state === 'playing') {
          roundElapsed = (nowMs - roundStartedAt) / 1000;
          // swipe sound when a fast swipe starts
          var fast = tip.present && tip.speed > slashSpeedThreshold(W, H);
          if (fast && !wasFast) playSound('swoosh', 0.45);
          wasFast = fast;
          // slash check (only while the fingertip is moving fast)
          if (fast && tip.px > -100) slashAt(tip.px, tip.py, tip.x, tip.y, nowMs);
          // spawn (never after the round is over — no new fruit past the end)
          if (!round.over) {
            spawnTimer -= dt;
            if (spawnTimer <= 0) {
              spawnGroup(roundElapsed);
              spawnTimer = difficultyAt(roundElapsed).spawnInterval;
            }
          }
          // physics + misses
          var gravity = GRAVITY_FACTOR * H;
          for (var i = fruits.length - 1; i >= 0; i--) {
            var f = fruits[i];
            updateBody(f, dt, gravity);
            if (isMissed(f, H)) {
              fruits.splice(i, 1);
              if (registerMiss(round)) endAt = nowMs + 700;
              updateHUD();
            } else if (f.dead) {
              fruits.splice(i, 1);
            }
          }
          if (round.over && !endShown && nowMs >= endAt) showResult();
          updateHUD();
        }
        // halves + particles always animate while a round is on screen
        updateHalves(dt);
        updateParticles(dt);
        drawFruits();
        drawHalves();
        drawParticles();
        if (state !== 'start') drawBlade(ctx, trail);
        if (boom) drawBoom(nowMs);
        if (countdown) drawCountdown(nowMs);
      }
    }

    function drawBackground(t) {
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#0b2e1f');
      g.addColorStop(0.55, '#0f3d26');
      g.addColorStop(1, '#071a10');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    function drawAmbient(t, dt) {
      for (var i = 0; i < ambient.length; i++) {
        var a = ambient[i];
        var y = a.baseY + Math.sin(t * a.speed + a.phase) * 26;
        a.rot += dt * 0.2;
        ctx.globalAlpha = 0.85;
        drawWholeFruit(ctx, a.type, a.x, y, a.r * S + 8, a.rot);
      }
      ctx.globalAlpha = 1;
    }
    function drawVideoBackground() {
      if (mode === 'camera' && video && video.readyState >= 2 && video.videoWidth) {
        ctx.save();
        ctx.translate(W, 0);
        ctx.scale(-1, 1); // mirrored so the blade moves the way the hand moves
        ctx.drawImage(video, 0, 0, W, H);
        ctx.restore();
        ctx.fillStyle = 'rgba(4, 20, 12, 0.42)'; // dim so fruits pop
        ctx.fillRect(0, 0, W, H);
      }
    }
    function drawTipMarker() {
      if (!tip.present) return;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = '#7dd8ff';
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 20 * S + 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    function updateHalves(dt) {
      var gravity = GRAVITY_FACTOR * H;
      for (var i = halves.length - 1; i >= 0; i--) {
        var h = halves[i];
        updateBody(h, dt, gravity);
        h.life -= dt * 0.9;
        if (h.y - h.r > H + 80 || h.life <= 0) halves.splice(i, 1);
      }
    }
    function updateParticles(dt) {
      for (var i = particles.length - 1; i >= 0; i--) {
        var p = particles[i];
        p.vy += GRAVITY_FACTOR * H * 0.7 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= p.decay * dt;
        if (p.life <= 0 || p.y > H + 20) particles.splice(i, 1);
      }
    }
    function drawFruits() {
      for (var i = 0; i < fruits.length; i++) {
        var f = fruits[i];
        if (f.kind === 'bomb') drawBomb(ctx, f.x, f.y, f.r, f.rot, f.fuse);
        else drawWholeFruit(ctx, f.type, f.x, f.y, f.r, f.rot);
      }
    }
    function drawHalves() {
      for (var i = 0; i < halves.length; i++) {
        var h = halves[i];
        ctx.globalAlpha = Math.max(0, Math.min(1, h.life));
        drawFruitHalf(ctx, h.type, h.x, h.y, h.r, h.rot, h.cutAngle);
      }
      ctx.globalAlpha = 1;
    }
    function drawParticles() {
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    function drawBoom(nowMs) {
      var age = (nowMs - boom.at) / 1000;
      if (age > 0.7) { boom = null; return; }
      var r = (0.2 + age * 2.4) * Math.min(W, H) * 0.32;
      var g = ctx.createRadialGradient(boom.x, boom.y, 0, boom.x, boom.y, r);
      g.addColorStop(0, 'rgba(255, 240, 120, 0.95)');
      g.addColorStop(0.4, 'rgba(255, 109, 0, 0.75)');
      g.addColorStop(1, 'rgba(255, 60, 0, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(boom.x, boom.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    function drawCountdown(nowMs) {
      var step = Math.floor((nowMs - countdown.at) / 550);
      if (step >= 3) { countdown = null; beginPlay(nowMs); return; }
      var n = 3 - step;
      var el = $('countdown');
      if (el) {
        el.textContent = n;
        el.classList.add('show');
      }
    }
    function startCountdown(nowMs) {
      if (countdown) return;
      state = 'ready';
      countdown = { at: nowMs };
      var el = $('countdown');
      if (el) el.classList.add('show');
    }
    function beginPlay(nowMs) {
      var el = $('countdown');
      if (el) el.classList.remove('show');
      state = 'playing';
      roundStartedAt = nowMs;
      roundElapsed = 0;
      spawnTimer = 0; // first wave launches the instant play begins
      showScreen('game');
      updateHUD();
    }

    /* ---------- screens / flow ---------- */
    function showResult() {
      endShown = true;
      state = 'over';
      var beaten = saveHighScore(window.localStorage, round.score);
      newBest = beaten;
      if (beaten) highScore = round.score;
      var set = function (id, v) { var el = $(id); if (el) el.textContent = v; };
      set('result-score', round.score);
      set('result-slashed', round.slashed);
      set('result-combo', round.bestCombo > 1 ? 'x' + round.bestCombo : '—');
      set('result-best', highScore);
      set('result-reason', round.reason === 'bomb'
        ? 'BOOM! You slashed a bomb.'
        : 'Three fruits got past you.');
      var badge = $('result-badge');
      if (badge) badge.classList.toggle('show', beaten && round.score > 0);
      if (tracker) tracker.pause();
      showScreen('result');
    }

    function startGame(nextMode) {
      mode = nextMode;
      round = newRound();
      fruits = []; halves = []; particles = []; trail = [];
      smooth.init = false;
      tip.x = tip.y = -999; tip.present = false; tip.speed = 0;
      readySince = 0; countdown = null; endShown = false; endAt = 0; boom = null;
      newBest = false; wasFast = false;
      updateHUD();
      if (mode === 'mouse') {
        state = 'ready';
        setReadyHint('Move your mouse or finger — the blade follows it.');
        showScreen('ready');
        var go = $('ready-go');
        if (go) go.style.display = '';
        return;
      }
      // camera mode
      state = 'loading';
      showScreen('loading');
      var errBox = $('loading-error');
      if (errBox) errBox.classList.remove('show');
      setStatus('Asking for the camera…');
      getTracker().then(function (trk) {
        if (state !== 'loading') return; // user left meanwhile
        setStatus('Loading the hand model…');
        return trk.start(video, setStatus);
      }).then(function () {
        if (state !== 'loading') return;
        trackerWarm = true;
        state = 'ready';
        setReadyHint('Raise one hand so the camera can see it.');
        showScreen('ready');
        var go2 = $('ready-go');
        if (go2) go2.style.display = 'none';
      }).catch(function (err) {
        if (state !== 'loading') return;
        state = 'start';
        showScreen('loading');
        setStatus('Camera could not start.');
        var box = $('loading-error');
        var msg = $('loading-error-msg');
        if (msg) {
          msg.textContent = (err && err.name === 'NotAllowedError')
            ? 'Camera permission was denied. Tap the lock / camera icon in the address bar, allow the camera, then try again — or play with mouse / touch instead.'
            : 'No camera was found, or it could not be opened (' + (err && err.message ? err.message : 'unknown error') + '). Check the camera is plugged in and not used by another app — or play with mouse / touch instead.';
        }
        if (box) box.classList.add('show');
      });
    }

    var trackerPromise = null;
    function getTracker() {
      if (trackerPromise) return trackerPromise;
      trackerPromise = new Promise(function (resolve, reject) {
        try {
          var T = window.FruitSlash && window.FruitSlash.Tracker;
          if (!T) throw new Error('Tracker module did not load.');
          tracker = new T();
          resolve(tracker);
        } catch (e) { reject(e); }
      });
      return trackerPromise;
    }

    /* ---------- wiring ---------- */
    function bind(id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); }
    bind('play-btn', function () { startGame('camera'); });
    bind('mouse-btn', function () { startGame('mouse'); });
    bind('retry-btn', function () { startGame('camera'); });
    bind('again-btn', function () { startGame(mode); });
    bind('home-btn', function () {
      state = 'start';
      if (tracker) tracker.pause();
      showScreen('start');
      initAmbient();
    });
    bind('ready-go', function () {
      if (state === 'ready' && mode === 'mouse') startCountdown(performance.now());
    });
    bind('sound-btn', function () {
      soundOn = !soundOn;
      var el = $('sound-btn');
      if (el) el.textContent = soundOn ? 'SOUND: ON' : 'SOUND: OFF';
    });
    bind('sound-btn-2', function () {
      soundOn = !soundOn;
      var el = $('sound-btn-2');
      if (el) el.textContent = soundOn ? 'SOUND: ON' : 'SOUND: OFF';
    });
    var bestEl = $('start-best');
    if (bestEl) bestEl.textContent = highScore > 0 ? "Today's best: " + highScore : 'No scores yet today — be the first!';

    showScreen('start');
    requestAnimationFrame(loop);
  }

  /* ============================ exports ============================= */
  var api = {
    SLASH_SPEED_FACTOR: SLASH_SPEED_FACTOR,
    FRUIT_SCALE: FRUIT_SCALE,
    GRAVITY_FACTOR: GRAVITY_FACTOR,
    SLASH_CHAIN_WINDOW_MS: SLASH_CHAIN_WINDOW_MS,
    MAX_MISSES: MAX_MISSES,
    HIGH_SCORE_KEY: HIGH_SCORE_KEY,
    FRUIT_TYPES: FRUIT_TYPES,
    FRUIT_KEYS: FRUIT_KEYS,
    slashSpeedThreshold: slashSpeedThreshold,
    fruitScale: fruitScale,
    comboBonus: comboBonus,
    scoreForSwipe: scoreForSwipe,
    difficultyAt: difficultyAt,
    planWave: planWave,
    segmentHitsCircle: segmentHitsCircle,
    makeFruit: makeFruit,
    makeBomb: makeBomb,
    updateBody: updateBody,
    isMissed: isMissed,
    newRound: newRound,
    registerSlash: registerSlash,
    registerMiss: registerMiss,
    registerBomb: registerBomb,
    loadHighScore: loadHighScore,
    saveHighScore: saveHighScore,
    launchVelocity: launchVelocity
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FruitSlashGame = api;
})();
