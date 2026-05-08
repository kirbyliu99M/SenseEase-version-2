// WebcamSource — owns the single shared MediaStream for the Main Scenario.
// Multiple consumers (LuxSensor, GazeTracker) attach via onFrame() instead of
// each calling getUserMedia separately, so the user only sees one camera prompt.
export class WebcamSource {
  constructor() {
    this.stream = null;
    this.videoElement = null;
    this._subscribers = [];
    this._loopRaf = null;
    this._previewElement = null;
  }

  async start({ previewElementId = 'main-webcam-preview' } = {}) {
    if (this.stream) return this.stream;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('getUserMedia not supported in this browser');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
      audio: false,
    });

    // Two video elements: one visible preview tile, one hidden offscreen for frame sampling.
    this._previewElement = document.getElementById(previewElementId);
    if (this._previewElement) {
      this._previewElement.srcObject = this.stream;
      this._previewElement.style.display = '';
      try { await this._previewElement.play(); } catch { /* autoplay policy: silent */ }
    }

    this.videoElement = document.createElement('video');
    this.videoElement.muted = true;
    this.videoElement.playsInline = true;
    this.videoElement.srcObject = this.stream;
    try { await this.videoElement.play(); } catch { /* silent */ }

    this._startLoop();
    return this.stream;
  }

  stop() {
    if (this._loopRaf) cancelAnimationFrame(this._loopRaf);
    this._loopRaf = null;

    if (this.stream) {
      this.stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      this.stream = null;
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement = null;
    }

    if (this._previewElement) {
      this._previewElement.srcObject = null;
      this._previewElement.style.display = 'none';
    }

    this._subscribers = [];
  }

  isActive() {
    return !!this.stream;
  }

  // Subscribe to receive the live video element at a fixed cadence.
  // Returns an unsubscribe function.
  onFrame(callback, intervalMs = 100) {
    const sub = { callback, intervalMs, lastFire: 0 };
    this._subscribers.push(sub);
    return () => {
      this._subscribers = this._subscribers.filter(s => s !== sub);
    };
  }

  _startLoop() {
    const tick = () => {
      const now = performance.now();
      for (const sub of this._subscribers) {
        if (now - sub.lastFire >= sub.intervalMs) {
          sub.lastFire = now;
          try { sub.callback(this.videoElement, now); }
          catch (e) { console.error('[WebcamSource] subscriber error:', e); }
        }
      }
      this._loopRaf = requestAnimationFrame(tick);
    };
    this._loopRaf = requestAnimationFrame(tick);
  }
}
