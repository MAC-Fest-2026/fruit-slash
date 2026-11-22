/* Fruit Slash — hand tracking (module script, no static imports).
   MediaPipe HandLandmarker from @mediapipe/tasks-vision ONLY — never the
   deprecated @mediapipe/hands. The model + wasm are self-hosted in
   assets/model/ (no CDN at runtime).
   Runs in a Web Worker (js/tracking-worker.js), numHands: 1, video mode
   with detectForVideo, GPU delegate with automatic CPU fallback.
   If the worker cannot run, it falls back to the same landmarker on the
   main thread. Hands game.js one thing per frame: the index fingertip
   (landmark 8), normalised video coordinates. */
(function () {
  'use strict';

  var MODEL_PATH = new URL('assets/model/hand_landmarker.task', document.baseURI).href;
  var WASM_PATH = new URL('assets/model/wasm/', document.baseURI).href;
  var WORKER_URL = new URL('js/tracking-worker.js', document.baseURI).href;
  // Perf: the worker gets at most one frame per 66 ms (~15 fps) and the
  // frame is downscaled to 320x240 first — a quarter of the pixels to copy,
  // transfer and run inference on. The main-thread fallback runs at most
  // one inference per 100 ms: a phone-CPU detectForVideo can block the
  // main thread 100-200 ms, which froze the whole page every frame.
  var DETECT_W = 320, DETECT_H = 240;
  var WORKER_SUBMIT_MIN_MS = 66; // ~15 fps
  var MAIN_DETECT_MIN_MS = 100; // 10 fps

  function Tracker() {
    this.video = null;
    this.stream = null;
    this.worker = null;
    this.engine = 'none'; // 'worker' | 'main'
    this.workerBusy = false;
    this.workerReady = false;
    this.lastWorkerSubmit = 0; // throttle: at most ~15 fps to the worker
    this.lastMainDetect = 0; // throttle: at most 10 fps on the main thread
    this.smallCanvas = null; // 320x240 downscale target for worker frames
    this.smallCtx = null;
    this.landmarker = null; // main-thread fallback engine
    this.tip = { x: 0.5, y: 0.5, present: false, at: 0 };
    this.running = false;
    this.rafId = 0;
    this.lastTs = 0;
    this.onStatus = null;
  }

  Tracker.prototype.start = function (videoEl, onStatus) {
    var self = this;
    this.video = videoEl;
    this.onStatus = onStatus || function () {};
    if (this.running) return Promise.resolve();
    this.running = true;
    return this.openCamera()
      .then(function () { return self.initEngine(); })
      .then(function () {
        self.loop();
      });
  };

  Tracker.prototype.openCamera = function () {
    var self = this;
    if (this.stream) return Promise.resolve();
    // 640x480, front camera — works on laptop webcams and phone front
    // cameras alike (getUserMedia + facingMode:'user').
    var constraints = {
      audio: false,
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user'
      }
    };
    return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      self.stream = stream;
      self.video.srcObject = stream;
      self.video.muted = true;
      return self.video.play();
    });
  };

  Tracker.prototype.initEngine = function () {
    var self = this;
    this.onStatus('Loading the hand model…');
    return this.initWorker('GPU')
      .catch(function () { return self.initWorker('CPU'); })
      .catch(function () { return self.initMainThread('GPU'); })
      .catch(function () { return self.initMainThread('CPU'); });
  };

  /* ---- worker engine ---- */
  Tracker.prototype.initWorker = function (delegate) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var worker;
      try {
        worker = new Worker(WORKER_URL, { type: 'module' });
      } catch (e) { reject(e); return; }
      var settled = false;
      var timeout = setTimeout(function () {
        if (!settled) { settled = true; try { worker.terminate(); } catch (e) {} reject(new Error('worker init timed out')); }
      }, 20000);
      worker.onmessage = function (e) {
        var d = e.data || {};
        if (d.type === 'ready') {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          self.worker = worker;
          self.engine = 'worker';
          self.workerReady = true;
          self.workerDelegate = d.delegate;
          resolve();
        } else if (d.type === 'init-error') {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          try { worker.terminate(); } catch (err) {}
          reject(new Error('worker init failed (' + delegate + '): ' + (d.error || 'unknown')));
        } else if (d.type === 'landmarks') {
          self.workerBusy = false;
          self.tip = { x: d.x, y: d.y, present: true, at: d.timestamp };
        } else if (d.type === 'none') {
          self.workerBusy = false;
          self.tip.present = false;
        } else if (d.type === 'error') {
          self.workerBusy = false;
        }
      };
      worker.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { worker.terminate(); } catch (e) {}
        reject(new Error('worker error (' + delegate + ')'));
      };
      worker.postMessage({ type: 'init', wasmPath: WASM_PATH, modelPath: MODEL_PATH, delegate: delegate });
    });
  };

  /* ---- main-thread fallback engine ---- */
  Tracker.prototype.initMainThread = function (delegate) {
    var self = this;
    return import('../assets/model/vision_bundle.mjs').then(function (vision) {
      return vision.FilesetResolver.forVisionTasks(WASM_PATH).then(function (fileset) {
        return vision.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate: delegate },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5
        });
      });
    }).then(function (landmarker) {
      self.landmarker = landmarker;
      self.engine = 'main';
      self.workerReady = false;
    });
  };

  /* ---- frame loop: submit the newest frame, never queue ---- */
  Tracker.prototype.loop = function () {
    var self = this;
    if (!this.running) return;
    this.rafId = requestAnimationFrame(function () { self.loop(); });
    var video = this.video;
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    var nowMs = performance.now();
    var ts = Math.round(nowMs * 1000);
    if (ts <= this.lastTs) ts = this.lastTs + 1;
    this.lastTs = ts;
    if (this.engine === 'worker') {
      if (this.workerBusy || !this.workerReady) return; // skip stale frame
      if (nowMs - this.lastWorkerSubmit < WORKER_SUBMIT_MIN_MS) return; // ~15 fps cap
      this.lastWorkerSubmit = nowMs;
      this.workerBusy = true;
      if (!this.smallCanvas) {
        this.smallCanvas = document.createElement('canvas');
        this.smallCanvas.width = DETECT_W;
        this.smallCanvas.height = DETECT_H;
        this.smallCtx = this.smallCanvas.getContext('2d');
      }
      try {
        this.smallCtx.drawImage(video, 0, 0, DETECT_W, DETECT_H);
      } catch (e) { this.workerBusy = false; return; }
      createImageBitmap(this.smallCanvas).then(function (bitmap) {
        if (!self.running) { bitmap.close(); self.workerBusy = false; return; }
        try {
          self.worker.postMessage({ type: 'frame', bitmap: bitmap, timestamp: ts }, [bitmap]);
        } catch (e) {
          bitmap.close();
          self.workerBusy = false;
        }
      }).catch(function () { self.workerBusy = false; });
    } else if (this.engine === 'main' && this.landmarker) {
      // Never every frame: one synchronous detectForVideo on a phone CPU
      // blocks the main thread 100-200 ms. At most one per 100 ms; the
      // game's eased tip interpolation covers the gaps.
      if (nowMs - this.lastMainDetect < MAIN_DETECT_MIN_MS) return;
      this.lastMainDetect = nowMs;
      try {
        var res = this.landmarker.detectForVideo(video, ts);
        var lm = res && res.landmarks && res.landmarks[0];
        if (lm) {
          var tip = lm[8];
          this.tip = { x: tip.x, y: tip.y, present: true, at: ts };
        } else {
          this.tip.present = false;
        }
      } catch (e) { /* a bad frame must never kill the loop */ }
    }
  };

  Tracker.prototype.getTip = function () {
    // Hide a stale detection: if nothing arrived for 600 ms, the hand is gone.
    if (this.tip.present && performance.now() * 1000 - this.tip.at > 600000) {
      this.tip.present = false;
    }
    return this.tip;
  };

  Tracker.prototype.pause = function () {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.tip.present = false;
  };

  Tracker.prototype.resume = function () {
    if (this.running || !this.stream) return;
    this.running = true;
    this.loop();
  };

  Tracker.prototype.stop = function () {
    this.pause();
    if (this.worker) { try { this.worker.terminate(); } catch (e) {} this.worker = null; }
    if (this.landmarker) { try { this.landmarker.close(); } catch (e) {} this.landmarker = null; }
    if (this.stream) {
      this.stream.getTracks().forEach(function (tr) { try { tr.stop(); } catch (e) {} });
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
    this.engine = 'none';
  };

  window.FruitSlash = window.FruitSlash || {};
  window.FruitSlash.Tracker = Tracker;
})();
