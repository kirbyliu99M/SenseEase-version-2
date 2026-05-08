export class SenseObserver {
  constructor() {
    this.opticalFlow = 0;
    this.listeners = [];
    this.lastScrollY = window.scrollY;
    this.lastTime = performance.now();
    this.isVideoPlaying = false;
    this.hasIntent = false;
    this.intentTimeout = null;
    this.flowDirectionX = 0;
    this.onDashboardUpdate = null;

    this.strongIntentUntil = 0;
    this.lastIntentSource = 'none';
    this.lastPointerSpeed = 0;
    this.isUserActing = false;
    this.userActingTimeout = null;

    this.targetElement = null;
    this.targetType = 'none';
    this.targetMutationObserver = null;
    this.targetMutationCount = 0;
    this.lastVideoTime = 0;

    this.init();
    this.loop();
  }

  // Returns true only when the Live Demos tab is the active SPA section.
  _demosTabActive() {
    return !!document.getElementById('tab-demos')?.classList.contains('active');
  }

  setTarget(element, type = 'auto') {
    const valid = element === null || element instanceof Element;
    console.assert(valid, '[SenseObserver] setTarget received non-element target.');
    if (!valid) {
      console.error('[SenseObserver] Invalid target passed to setTarget:', element);
      return;
    }

    if (this.targetMutationObserver) {
      this.targetMutationObserver.disconnect();
      this.targetMutationObserver = null;
    }

    this.targetElement = element;
    this.targetMutationCount = 0;
    this.lastVideoTime = 0;

    if (!element) {
      this.targetType = 'none';
      return;
    }

    if (type !== 'auto') {
      this.targetType = type;
    } else {
      const tag = element.tagName?.toLowerCase();
      if (tag === 'video') this.targetType = 'video';
      else if (tag === 'canvas') this.targetType = 'canvas';
      else this.targetType = 'container';
    }

    if (this.targetType === 'canvas' || this.targetType === 'container') {
      this.targetMutationObserver = new MutationObserver((mutations) => {
        this.targetMutationCount += mutations.length;
      });
      this.targetMutationObserver.observe(element, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    }

    console.assert(!!this.targetType, '[SenseObserver] targetType failed to initialize.');
  }

  _isTargetVisible() {
    if (!this.targetElement) return false;
    const rect = this.targetElement.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  _estimateTargetFlow() {
    if (!this.targetElement || !this._isTargetVisible()) return 0;

    if (this.targetType === 'video') {
      const v = this.targetElement;
      const isVideo = v instanceof HTMLVideoElement;
      if (!isVideo) return 0;
      if (v.paused || v.ended || v.readyState < 2) return 0;

      const nowVideoT = v.currentTime || 0;
      const deltaVideo = Math.max(0, nowVideoT - this.lastVideoTime);
      this.lastVideoTime = nowVideoT;
      const motionBoost = Math.min(20, deltaVideo * 600);
      return Math.min(100, 72 + motionBoost);
    }

    if (this.targetType === 'canvas' || this.targetType === 'container') {
      const m = this.targetMutationCount;
      this.targetMutationCount = 0;
      return Math.min(80, 6 + m * 4);
    }

    return 0;
  }

  init() {
    // Hardware-intent events.
    const intentEvents = ['mousedown', 'keydown', 'wheel', 'touchmove'];
    intentEvents.forEach(evt => {
      window.addEventListener(evt, (e) => {
        const holdMs = evt === 'wheel' ? 280 : 500;
        this.registerIntent(evt, holdMs);
        if (evt === 'mousedown' || evt === 'wheel') this.markUserActing();
        if (evt === 'wheel' && this._demosTabActive()) {
          const deltaY = Math.abs(e.deltaY);
          this.updateFlow(this.opticalFlow + Math.min(deltaY * 0.04, 20));
        }
      }, { passive: true });
    });

    let lastX = 0;
    let lastY = 0;
    let lastT = performance.now();
    window.addEventListener('mousemove', (e) => {
      if (!this._demosTabActive() || this.isVideoPlaying) return;

      this.registerIntent('pointer', 220);
      this.markUserActing();
      const now = performance.now();
      const dt = now - lastT;
      if (dt > 0 && dt < 150) {
        const dist = Math.sqrt((e.clientX - lastX) ** 2 + (e.clientY - lastY) ** 2);
        const vel = dist / dt * 9;
        this.lastPointerSpeed = vel;
        if (vel > 14) {
          this.updateFlow(Math.min(this.opticalFlow + vel * 0.08, 35));
        }
      }

      lastX = e.clientX;
      lastY = e.clientY;
      lastT = now;
    }, { passive: true });

    window.addEventListener('scroll', () => {
      if (!this._demosTabActive()) return;
      const now = performance.now();
      const deltaY = Math.abs(window.scrollY - this.lastScrollY);
      const dt = now - this.lastTime;
      if (dt > 0) {
        const speed = deltaY / dt;
        this.updateFlow(Math.min(speed * 20, 80));
        this.registerIntent('scroll', 420);
      }
      this.lastScrollY = window.scrollY;
      this.lastTime = now;
    });

    setInterval(() => {
      if (this._demosTabActive() && this.targetElement) {
        const targetFlow = this._estimateTargetFlow();
        this.opticalFlow += (targetFlow - this.opticalFlow) * 0.12;
        this.opticalFlow = Math.max(0, Math.min(150, this.opticalFlow));
        this.notifyListeners();
      } else if (this.opticalFlow > 0) {
        this.opticalFlow = Math.max(0, this.opticalFlow - 8);
        this.notifyListeners();
      }
    }, 100);
  }

  loop() {
    if (this.onDashboardUpdate) this.onDashboardUpdate();
    requestAnimationFrame(() => this.loop());
  }

  registerIntent(source = 'generic', holdMs = 500) {
    const now = performance.now();
    this.hasIntent = true;
    this.lastIntentSource = source;
    this.strongIntentUntil = Math.max(this.strongIntentUntil, now + holdMs);

    if (this.intentTimeout) clearTimeout(this.intentTimeout);
    this.intentTimeout = setTimeout(() => {
      this.hasIntent = false;
    }, 500);
  }

  markUserActing() {
    this.isUserActing = true;
    if (this.userActingTimeout) clearTimeout(this.userActingTimeout);
    this.userActingTimeout = setTimeout(() => {
      this.isUserActing = false;
    }, 200);
  }

  setVideoState(isPlaying) {
    this.isVideoPlaying = isPlaying;
    if (!isPlaying) {
      this.flowDirectionX = 0;
      this.opticalFlow = 0;
      this.notifyListeners();
      return;
    }

    this.flowDirectionX = 1;
    this.updateFlow(80);
  }

  updateFlow(baseValue) {
    if (this.isUserActing) {
      this.opticalFlow = 0;
      this.notifyListeners();
      return 0;
    }
    let v = baseValue;
    if (this.isVideoPlaying) v = Math.max(v, 80);
    v = Math.min(v, 150);
    if (!this.isVideoPlaying) {
      this.opticalFlow = v;
      this.notifyListeners();
    }
    return this.opticalFlow;
  }

  injectFlow(value) {
    if (this.isUserActing) {
      this.opticalFlow = 0;
      this.notifyListeners();
      return 0;
    }
    if (!this._demosTabActive() || this.isVideoPlaying) return 0;
    this.opticalFlow = Math.min(Math.max(this.opticalFlow, value * 0.5) + value * 0.08, 80);
    this.notifyListeners();
    return this.opticalFlow;
  }

  isStrongEfferenceActive() {
    return performance.now() <= this.strongIntentUntil;
  }

  subscribe(cb) {
    this.listeners.push(cb);
  }

  notifyListeners() {
    const flowForInference = this.isUserActing ? 0 : this.opticalFlow;
    const meta = {
      strongEfference: this.isStrongEfferenceActive(),
      intentSource: this.lastIntentSource,
      pointerSpeed: this.lastPointerSpeed,
      isUserActing: this.isUserActing,
      targetType: this.targetType,
    };
    this.listeners.forEach(cb => cb(flowForInference, this.hasIntent, this.flowDirectionX, meta));
  }
}
