/* Fruit Slash — hand-tracking Web Worker (module worker).
   Loads the self-hosted @mediapipe/tasks-vision bundle, creates the
   HandLandmarker (numHands: 1, VIDEO mode), and answers detectForVideo
   calls on ImageBitmaps sent from the main thread. The worker never queues
   frames: the main thread only sends a new frame when the worker is idle. */
let landmarker = null;

self.onmessage = async (e) => {
  const d = e.data || {};
  if (d.type === 'init') {
    try {
      const vision = await import('../assets/model/vision_bundle.mjs');
      const fileset = await vision.FilesetResolver.forVisionTasks(d.wasmPath);
      landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: d.modelPath, delegate: d.delegate },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      self.postMessage({ type: 'ready', delegate: d.delegate });
    } catch (err) {
      self.postMessage({ type: 'init-error', error: String((err && err.message) || err), delegate: d.delegate });
    }
    return;
  }
  if (d.type === 'frame') {
    const bitmap = d.bitmap;
    if (!landmarker) { try { bitmap.close(); } catch (err) {} return; }
    try {
      const res = landmarker.detectForVideo(bitmap, d.timestamp);
      const lm = res && res.landmarks && res.landmarks[0];
      if (lm) {
        const tip = lm[8]; // index fingertip
        self.postMessage({ type: 'landmarks', x: tip.x, y: tip.y, timestamp: d.timestamp });
      } else {
        self.postMessage({ type: 'none', timestamp: d.timestamp });
      }
    } catch (err) {
      self.postMessage({ type: 'error', error: String((err && err.message) || err) });
    } finally {
      try { bitmap.close(); } catch (err) {}
    }
  }
};
