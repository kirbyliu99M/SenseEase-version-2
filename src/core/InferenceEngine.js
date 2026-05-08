export class InferenceEngine {
  constructor(observer, renderController, chatbotUI, eyeTracker, dataNormalizer, vimsPredictor) {
    this.observer = observer;
    this.render = renderController;
    this.chatbot = chatbotUI;
    this.eyeTracker = eyeTracker;
    this.dataNormalizer = dataNormalizer;
    this.vimsPredictor = vimsPredictor;
    this.threshold = 100;
    this.pressure = 0.0;
    this.isMaskActive = false;
    this.lastComplainTime = performance.now();
    this.isGlobalOverrideOn = false;
    this.protectionEnabled = false;
    this.lastBgTheme = null;
    this.npuLoad = 5;
    this.noiseGateThreshold = 18;
    this.activeIntentWeight = 0.01;
    this.passiveFlowWeight = 1.5;
    this.lastRawFlow = 0;
    this.lastEffectiveFlow = 0;
    this.flowHistory = [];
    this.pressureHistory = [];
    this.timeHistory = [];
    this.statsStart = performance.now();
    this.init();
  }
  init() {
    this.observer.subscribe((flow, hasIntent, directionX, meta = {}) => {
      this.evaluateVIMS(flow, hasIntent, directionX, meta);
    });
    this.observer.onDashboardUpdate = () => {
      this.updateDashboard();
      if (this.eyeTracker && this.dataNormalizer && this.vimsPredictor) {
        const raw = this.eyeTracker.extractFeatures(this.render.mouseX, this.render.mouseY);
        const norm = this.dataNormalizer.normalize(raw);
        this.vimsPredictor.predict(norm);
      }
    };
    setInterval(() => {
      if (this.isGlobalOverrideOn || !this.protectionEnabled) return;
      const timeSinceComplain = performance.now() - this.lastComplainTime;
      if (this.isMaskActive && timeSinceComplain > 120000) {
        this.render.relaxMask(1);
      }
    }, 1000);
    setInterval(() => {
      if (!this.protectionEnabled) {
        this.npuLoad = 3 + Math.random() * 4;
      } else if (this.isMaskActive || this.isGlobalOverrideOn) {
        this.npuLoad = 80 + Math.random() * 15;
      } else {
        this.npuLoad = 8 + Math.random() * 12;
      }
    }, 500);
    setInterval(() => {
      const t = ((performance.now() - this.statsStart) / 1000).toFixed(1);
      const rawFlow = this.sanitizeFlow(this.observer.opticalFlow);
      const flowForStats = this.protectionEnabled ? (rawFlow * 0.2) : rawFlow;
      this.timeHistory.push(Number(t));
      this.flowHistory.push(parseFloat(flowForStats.toFixed(1)));
      this.pressureHistory.push(parseFloat(this.getPressure().toFixed(1)));
      if (this.timeHistory.length > 120) {
        this.timeHistory.shift();
        this.flowHistory.shift();
        this.pressureHistory.shift();
      }
    }, 1000);
  }
  getPressure() {
    const safe = this.sanitizePressure(this.pressure);
    if (Number.isNaN(this.pressure)) {
      console.error('VIMS Pressure calculated as NaN! Check inputs.');
    }
    return safe;
  }
  sanitizePressure(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      console.error('VIMS Pressure calculated as NaN! Check inputs.');
      return 0;
    }
    return Math.max(0, n);
  }
  sanitizeFlow(flow) {
    const n = Number(flow);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  isProtectionEnabled() {
    return this.protectionEnabled;
  }
  setProtectionEnabled(isEnabled) {
    this.protectionEnabled = !!isEnabled;
    if (!this.protectionEnabled) {
      this.isGlobalOverrideOn = false;
      if (this.isMaskActive) this.removeMask();
      this.render.setNpuState(false);
      return;
    }
    this.render.setNpuState(this.isGlobalOverrideOn || this.isMaskActive);
  }
  evaluateVIMS(flow, hasIntent, directionX, meta = {}) {
    if (!this.protectionEnabled) {
      if (this.isMaskActive) this.removeMask();
      this.render.setNpuState(false);
    }
    const demosActive = !!document.getElementById('tab-demos')?.classList.contains('active');
    if (!demosActive) {
      if (this.pressure > 0) this.pressure = Math.max(0, this.pressure * 0.95);
      if (this.isMaskActive && !this.isGlobalOverrideOn) this.removeMask();
      return;
    }
    const validFlow = this.sanitizeFlow(flow ?? 0);
    console.assert(Number.isFinite(validFlow), '[InferenceEngine] validFlow is not finite.');
    this.pressure = this.sanitizePressure(this.pressure);
    const maskAttenuation = this.isMaskActive ? 0.2 : 1.0;
    const effectiveFlow = validFlow * maskAttenuation;
    this.lastRawFlow = validFlow;
    this.lastEffectiveFlow = effectiveFlow;
    if (validFlow < this.noiseGateThreshold) {
      if (this.pressure > 0) this.pressure = Math.max(0, this.pressure * 0.965);
      return;
    }
    const strongEfference = !!meta.isUserActing || !!meta.strongEfference || !!hasIntent;
    const recoveryBias = this.isMaskActive ? 0.5 : 0.0;
    if (strongEfference) {
      const newPressure = (this.pressure * 0.98) - recoveryBias;
      this.pressure = Number.isNaN(newPressure) ? 0 : this.sanitizePressure(newPressure);
      return;
    }
    const baseWeight = this.passiveFlowWeight * 0.05;
    const newPressure = (this.pressure * 0.98) + (effectiveFlow * baseWeight) - recoveryBias;
    this.pressure = Number.isNaN(newPressure) ? 0 : this.sanitizePressure(newPressure);
    if (this.protectionEnabled && (this.isGlobalOverrideOn || this.pressure >= this.threshold) && !this.isMaskActive) {
      this.triggerMask(directionX);
      if (!this.isGlobalOverrideOn) this.chatbot.showWarning();
    } else if (this.protectionEnabled && this.pressure < 20 && this.isMaskActive && !this.isGlobalOverrideOn) {
      this.removeMask();
    }
  }
  triggerMask(directionX) {
    if (!this.protectionEnabled) return;
    this.isMaskActive = true;
    this.render.triggerFOVMask(directionX);
  }
  removeMask() {
    this.isMaskActive = false;
    this.render.removeFOVMask();
  }
  handleUserComplaint() {
    this.threshold = Math.max(50, this.threshold - 20);
    this.lastComplainTime = performance.now();
    this.render.tightenMask();
  }
  evaluateDES(newTheme) {
    if (this.lastBgTheme && this.lastBgTheme !== newTheme) {
      this.render.triggerColorShift();
    }
    this.lastBgTheme = newTheme;
  }
  setGlobalOverride(isOn) {
    if (isOn && !this.protectionEnabled) this.protectionEnabled = true;
    this.isGlobalOverrideOn = isOn && this.protectionEnabled;
    if (!this.protectionEnabled) {
      this.removeMask();
      this.render.setNpuState(false);
      return;
    }
    if (this.isGlobalOverrideOn) {
      this.triggerMask(0);
    } else {
      this.removeMask();
    }
    this.render.setNpuState(this.isGlobalOverrideOn || this.isMaskActive);
  }
  updateDashboard() {
    const elLoad = document.getElementById('dash-npu');
    const elFlow = document.getElementById('dash-flow');
    const elGpu = document.getElementById('dash-gpu');
    if (elLoad) elLoad.innerText = this.npuLoad.toFixed(1) + '%';
    if (elFlow) {
      const shownFlow = this.protectionEnabled ? this.lastEffectiveFlow : this.lastRawFlow;
      elFlow.innerText = Math.max(0, shownFlow).toFixed(1);
    }
    if (elGpu && this.render.shader && this.render.shader.isValid) {
      elGpu.innerText = this.render.shader.gpuTimeMs.toFixed(2) + ' ms';
    } else if (elGpu) {
      elGpu.innerText = 'Fallback';
    }
    if (this.chatbot && this.render) {
      const radius = this.render.currentRadiusInner || 130;
      let level = 1;
      if (radius <= 35) level = 5;
      else if (radius <= 55) level = 4;
      else if (radius <= 80) level = 3;
      else if (radius <= 110) level = 2;
      if (this.render.currentIntensity < 0.05) level = 1;
      this.chatbot.setLevel(level);
    }
  }
}