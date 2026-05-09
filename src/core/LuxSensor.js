// LuxSensor — environment-light source for the Main Scenario circadian overlay.
// Prefers the browser AmbientLightSensor API (hardware sensor, low power).
// Falls back to webcam frame luminance sampling when sensor unavailable.
//
// Output: warmth01 in [0, 1] passed to onWarmthChange(). 1 = dim room (deep
// warm shift desired), 0 = bright room (cool overlay).
export class LuxSensor {
  constructor(webcamSource, onWarmthChange) {
    this.webcam = webcamSource;
    this.onWarmthChange = onWarmthChange;
    this._sensor = null;
    this._unsubFrame = null;
    this._canvas = null;
    this._ctx = null;
    this._sourceLabel = 'simulated';
    this._lastLux = null;       // raw sensor reading
    this._lastLuma = null;      // raw webcam-sampled luminance (0-255)
  }

  async start() {
    // Path 1 — hardware sensor (Chrome desktop with --enable-generic-sensor-extra-classes
    // or Android Chrome). Requires HTTPS or localhost.
    //
    // The constructor + .start() can succeed even when no real sensor is
    // wired up (Chrome ships the API with the flag enabled, but the OS may
    // not surface a device). Symptom: 'reading' never fires, illuminance
    // stays undefined, but our code thought the sensor was live → warmth
    // never updated. Probe with a 2 s timeout and abandon to webcam fallback
    // if no reading arrives.
    if (typeof window !== 'undefined' && 'AmbientLightSensor' in window) {
      const sensorWorks = await this._tryAmbientLightSensor(2000);
      if (sensorWorks) {
        this._sourceLabel = 'AmbientLightSensor';
        return this._sourceLabel;
      }
      // Probe failed — clean up half-initialized state and fall through.
      if (this._sensor) {
        try { this._sensor.stop(); } catch {}
        this._sensor = null;
      }
      console.info('[LuxSensor] AmbientLightSensor present but silent — falling back to webcam frame luminance');
    }

    // Path 2 — webcam frame luminance sampling (universal fallback).
    if (this.webcam && this.webcam.isActive()) {
      // 32×32 downscaled sample is plenty for an average; cheap and stable.
      this._canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(32, 32)
        : Object.assign(document.createElement('canvas'), { width: 32, height: 32 });
      this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });

      this._unsubFrame = this.webcam.onFrame((video) => {
        if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
        try {
          this._ctx.drawImage(video, 0, 0, 32, 32);
          const data = this._ctx.getImageData(0, 0, 32, 32).data;
          let sum = 0;
          for (let i = 0; i < data.length; i += 4) {
            // Rec.709 luminance — matches human perception of brightness.
            sum += 0.2126 * data[i] + 0.7152 * data[i+1] + 0.0722 * data[i+2];
          }
          const avgLuma = sum / (data.length / 4);  // 0-255
          this._lastLuma = avgLuma;
          // Map 0-200 luma → 1.0 (very dim) - 0.0 (well-lit). >200 caps at 0.
          const warmth = 1 - Math.min(1, avgLuma / 200);
          this.onWarmthChange(warmth);
        } catch (e) {
          console.error('[LuxSensor] frame sample failed:', e);
        }
      }, 500);

      this._sourceLabel = 'webcam fallback';
      return this._sourceLabel;
    }

    // Neither path available — caller should keep the simulated timeline running.
    this._sourceLabel = 'simulated';
    return this._sourceLabel;
  }

  // Returns true iff the sensor produced at least one reading within
  // probeMs. Wires up the long-lived 'reading' handler on success; cleans
  // up on failure. Real-world Chrome behavior on machines without an
  // ambient light sensor: constructor + start() succeed silently, no
  // events ever fire — hence the explicit probe.
  async _tryAmbientLightSensor(probeMs) {
    try {
      this._sensor = new window.AmbientLightSensor({ frequency: 2 });
    } catch (e) {
      console.warn('[LuxSensor] AmbientLightSensor constructor failed:', e?.message);
      return false;
    }

    let firstReadingResolve;
    const firstReading = new Promise((r) => { firstReadingResolve = r; });
    let resolved = false;
    const onReading = () => {
      const lux = this._sensor.illuminance;
      if (!Number.isFinite(lux)) return;
      this._lastLux = lux;
      const warmth = 1 - Math.min(1, lux / 1000);
      this.onWarmthChange(warmth);
      if (!resolved) { resolved = true; firstReadingResolve(true); }
    };
    const onError = (e) => {
      console.warn('[LuxSensor] AmbientLightSensor error:', e?.error?.message || e);
      if (!resolved) { resolved = true; firstReadingResolve(false); }
    };

    this._sensor.addEventListener('reading', onReading);
    this._sensor.addEventListener('error', onError);
    try { this._sensor.start(); }
    catch (e) {
      console.warn('[LuxSensor] AmbientLightSensor.start() failed:', e?.message);
      return false;
    }

    // Wait up to probeMs for the first reading.
    const ok = await Promise.race([
      firstReading,
      new Promise((r) => setTimeout(() => r(false), probeMs)),
    ]);
    return ok;
  }

  stop() {
    if (this._sensor) {
      try { this._sensor.stop(); } catch {}
      this._sensor = null;
    }
    if (this._unsubFrame) { this._unsubFrame(); this._unsubFrame = null; }
    this._canvas = null;
    this._ctx = null;
  }

  get sourceLabel() { return this._sourceLabel; }
  get lastReading() {
    if (this._sourceLabel === 'AmbientLightSensor' && this._lastLux !== null) {
      return `${this._lastLux.toFixed(0)} lx`;
    }
    if (this._sourceLabel === 'webcam fallback' && this._lastLuma !== null) {
      return `${this._lastLuma.toFixed(0)}/255 luma`;
    }
    return null;
  }
}
