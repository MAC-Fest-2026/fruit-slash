# Fruit Slash — MAC Fest 2026

A Fruit Ninja-style game you play with your bare hand. The camera watches
your finger, the knife on screen follows it, and fruit flies. No touching,
no controller, no keyboard — just wave and slash. Works on **phone and
desktop**: the layout fits a ~360px-wide phone as well as a laptop screen,
and the camera tracking uses the phone front camera too.

**Play:** https://abybijo.github.io/fruit-slash/ (GitHub Pages, HTTPS)

## Rules

- Slash fruit with your finger: **+1 point** per fruit.
- **Combo:** 2 or more fruits in one swipe earn a bonus — 2 fruits in one
  swipe = 3 points, 3 fruits = 5 points.
- A fruit only counts when your fingertip is moving **fast** — a slow touch
  does nothing (one speed-threshold setting in `js/game.js`).
- A fruit that falls off the bottom unsliced is a **miss**. Three misses
  ends the round.
- Slash a **bomb** and the round ends on the spot. A bomb that falls
  untouched costs nothing.
- No timer — a round ends only by 3 misses or a bomb.
- The day's high score is kept on the stall device (`localStorage`).

## How it works

- Plain HTML + CSS + JavaScript. No framework, no build step, no backend.
- Hand tracking: **MediaPipe HandLandmarker** from `@mediapipe/tasks-vision`
  (version 1.2.3, self-hosted — never the deprecated `@mediapipe/hands`).
  Runs in a **Web Worker** (`js/tracking-worker.js`), `numHands: 1`, video
  mode (`detectForVideo`), GPU delegate with automatic CPU fallback, and a
  main-thread fallback if the worker cannot run. The blade follows
  landmark 8 (index fingertip), smoothed with eased interpolation.
- Camera: `getUserMedia`, 640×480, front camera (`facingMode: 'user'`),
  mirrored. Works with laptop webcams and phone front cameras.
- The model (`hand_landmarker.task`, ~7.5 MB) and the wasm files live in
  `assets/model/` — no CDN at runtime, so the game still works if the fest
  Wi-Fi dies.
- Fruit art is drawn procedurally on canvas (whole fruit + two halves split
  at the slash angle, juice splash particles). The bomb is dark, round, with
  a sparking fuse — unmistakable at a glance.
- Sounds are real clips, all local in `assets/sounds/`: swoosh (fast swipe),
  splat (slice), combo jingle, bomb explosion. No text-to-speech anywhere.
- **No camera?** The start screen offers "Play with mouse / touch" — the
  blade follows the pointer instead. Same rules, same speed threshold.
  This is also how the game is tested without a webcam.

## Files

```
index.html            the whole game page (5 screens + HUD)
css/style.css         responsive styles (phone + desktop, safe-area, dvh)
js/game.js            canvas loop, fruits, physics, scoring, screens
js/tracking.js        camera + HandLandmarker setup (worker / fallback)
js/tracking-worker.js hand tracking inside the Web Worker
assets/model/         hand_landmarker.task + vision_bundle.mjs + wasm/
assets/sounds/        swoosh.mp3, splat.mp3, combo.mp3, bomb.mp3
```

## Run locally

```sh
cd fruit-slash
python3 -m http.server 8000
# open http://localhost:8000
```

Opening the file directly (`file://`) will **not** give camera access — use
localhost or the hosted GitHub Pages link (HTTPS).

## Fest-day setup

- Laptop plugged into power, battery-saver off, browser updated, game page
  open and camera permission already granted before the first student arrives.
- Light falling on the player's hand; a plain wall or backdrop behind the
  player; the camera at about chest height, roughly an arm's length away.
- A marked standing spot on the floor so every player stands where tracking
  works best. On a phone, hold it steady (or prop it) at the same distance.
- One full test round played by a team member at setup, on that machine, in
  that light. If the blade lags on the stall laptop, swap the laptop — do
  not spend fest morning tuning code.

## Tests

```sh
node --check js/game.js && node --check js/tracking.js && node --check js/tracking-worker.js
node ~/workspace/fruit-slash-test.js   # unit harness (game logic + responsive checks)
```

Live hand tracking cannot be tested without a webcam — the stall-laptop test
above is the acceptance test (blade within ~150 ms of the finger).

## Sources

- MediaPipe tasks-vision 1.2.3 (npm) — vision bundle + wasm, self-hosted.
- Hand landmarker model — https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
- Sounds (MyInstants / WavStock): "Fast whoosh", "Cartoon SPLAT",
  "Loud Explosion" (trimmed to 3 s), "Combo Multiplier Rise".
