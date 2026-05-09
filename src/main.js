import './style.css'
import { SenseObserver }    from './core/SenseObserver.js'
import { RenderController } from './core/RenderController.js'
import { ChatbotUI }        from './components/ChatbotUI.js'
import { InferenceEngine }  from './core/InferenceEngine.js'
import { EyeTracker }       from './core/EyeTracker.js'
import { DataNormalizer }   from './core/DataNormalizer.js'
import { VIMSPredictor }    from './core/VIMSPredictor.js'
import { DitheringShader }  from './core/DitheringShader.js'
import { WebcamSource }     from './core/WebcamSource.js'
import { LuxSensor }        from './core/LuxSensor.js'
import { GazeTracker }      from './core/GazeTracker.js'
import { OpenVinoBridgeTracker } from './core/OpenVinoBridgeTracker.js'

// ?? V4 Four-Layer Architecture ??????????????????????????
const eyeTracker     = new EyeTracker();
const dataNormalizer = new DataNormalizer();
const vimsPredictor  = new VIMSPredictor();
const ditheringShader = new DitheringShader();

const observer         = new SenseObserver();
const renderController = new RenderController(ditheringShader);
const chatbotUI        = new ChatbotUI();
const inferenceEngine  = new InferenceEngine(
  observer, renderController, chatbotUI,
  eyeTracker, dataNormalizer, vimsPredictor
);

renderController.observer       = observer;
renderController.eyeTracker     = eyeTracker;
renderController.inferenceEngine = inferenceEngine;
inferenceEngine.setProtectionEnabled(false);

chatbotUI.onComplain   = () => inferenceEngine.handleUserComplaint();
chatbotUI.onWeaken     = () => renderController.relaxMask(15); // Rebound with Scenario 5-aware handler below.
chatbotUI.isTheaterMode = () => isTheaterMode;

// ?? Open HP IQ Feedback button ???????????????????????????
const btnOpenChatbot = document.getElementById('btn-open-chatbot');
if (btnOpenChatbot) btnOpenChatbot.addEventListener('click', () => chatbotUI.open());

const elDashPressure = document.getElementById('dash-pressure');
const elVimsPressureValue = document.getElementById('vims-pressure-value');
console.assert(!!elDashPressure, '[MainLoop] Missing #dash-pressure DOM node.');
if (!elDashPressure) console.error('[MainLoop] #dash-pressure not found; VIMS UI cannot render.');
console.assert(!!elDashPressure || !!elVimsPressureValue, '[MainLoop] No pressure DOM target found.');

const gazeIndicator = document.getElementById('gaze-indicator');
const markerToggleBtn = document.getElementById('main-marker-toggle');
// Persisted across reloads — booth presenters tend to keep one preference.
let gazeMarkerVisible = (() => {
  try { return localStorage.getItem('senseease.gazeMarker') !== '0'; } catch { return true; }
})();
function setGazeMarkerVisible(v) {
  gazeMarkerVisible = !!v;
  try { localStorage.setItem('senseease.gazeMarker', v ? '1' : '0'); } catch {}
  if (markerToggleBtn) {
    markerToggleBtn.innerText = gazeMarkerVisible ? 'Hide Gaze Marker' : 'Show Gaze Marker';
    markerToggleBtn.classList.toggle('active', !gazeMarkerVisible);
  }
}
if (markerToggleBtn) {
  markerToggleBtn.addEventListener('click', () => setGazeMarkerVisible(!gazeMarkerVisible));
  setGazeMarkerVisible(gazeMarkerVisible);
}

function runGlobalMainLoop() {
  const pressure = inferenceEngine.getPressure();
  if (Number.isNaN(pressure)) {
    console.error('VIMS Pressure calculated as NaN! Check inputs.');
  }
  const pressureText = (Number.isFinite(pressure) ? pressure : 0).toFixed(2);
  if (elDashPressure) elDashPressure.innerText = pressureText;
  if (elVimsPressureValue) elVimsPressureValue.innerText = pressureText;

  // Auto Demo Mode Badge sync
  const badge = document.getElementById('auto-demo-badge');
  if (inferenceEngine.autoDemoMode && badge) {
    const active = inferenceEngine.isMaskActive;
    badge.innerText = active ? 'NPU Intercept: Active' : 'NPU Intercept: Standby';
    badge.style.background = active ? '#024AD8' : '#E54747';
  }

  // Gaze Indicator sync
  if (gazeIndicator) {
    const showMarker = gazeMarkerVisible
      && eyeTracker.gazeOverride
      && document.getElementById('demo-main')?.classList.contains('active');
    if (showMarker) {
      gazeIndicator.style.display = 'block';
      gazeIndicator.style.left = `${eyeTracker.gazeOverride.x}px`;
      gazeIndicator.style.top = `${eyeTracker.gazeOverride.y}px`;
    } else {
      gazeIndicator.style.display = 'none';
    }
  }

  requestAnimationFrame(runGlobalMainLoop);
}
requestAnimationFrame(runGlobalMainLoop);

// ======================================================
// SPA Routing ??3 Main Tabs
// ======================================================
const mainTabs = document.querySelectorAll('#main-tabs .tab-btn');
const sections = document.querySelectorAll('.spa-section');

mainTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    mainTabs.forEach(t => t.classList.remove('active'));
    sections.forEach(s => s.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.target).classList.add('active');

    if (tab.dataset.target === 'tab-demos') {
      const activeDemo = document.querySelector('#demo-sub-tabs .demo-sub-btn.active');
      if (activeDemo) setDemoTarget(activeDemo.dataset.demo);
    } else {
      renderController.setTargetElement(null);
      observer.setTarget(null);
    }
  });
});

// Demo Sub-tabs
const demoSubTabs = document.querySelectorAll('#demo-sub-tabs .demo-sub-btn');
const demoPanels  = document.querySelectorAll('.demo-panel');

demoSubTabs.forEach(btn => {
  btn.addEventListener('click', () => {
    if (typeof exitTheater === 'function') exitTheater();
    demoSubTabs.forEach(b => b.classList.remove('active'));
    demoPanels.forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.demo).classList.add('active');
    setDemoTarget(btn.dataset.demo);
  });
});

// ======================================================
// NPU Toggle & Auto-Demo (with hardware interrupt)
// ======================================================
const btnManual = document.getElementById('btn-toggle-manual');
const btnAuto   = document.getElementById('btn-toggle-auto');
const badge     = document.getElementById('auto-demo-badge');
let autoDemoTimer = null;

function hardwareInterrupt() {
  clearInterval(autoDemoTimer);
  autoDemoTimer = null;
  inferenceEngine.autoDemoMode = false;
  inferenceEngine.setGlobalOverride(false);
  inferenceEngine.setProtectionEnabled(false);
  renderController.hardReset();
  btnAuto?.classList.remove('active');
  badge?.classList.remove('show');
  btnManual.innerText = 'NPU Protection: OFF';
  btnManual.classList.remove('active');
  hoveredStockIdx = null;
  if (typeof syncScenario2Schedulers === 'function') syncScenario2Schedulers();
  if (typeof updateWatchlistContrast === 'function') updateWatchlistContrast();
}

btnManual.addEventListener('click', () => {
  if (inferenceEngine.isGlobalOverrideOn || inferenceEngine.autoDemoMode || inferenceEngine.isProtectionEnabled()) {
    hardwareInterrupt();
  } else {
    inferenceEngine.setProtectionEnabled(true);
    inferenceEngine.setGlobalOverride(true);
    btnManual.classList.add('active');
    btnManual.innerText = 'NPU Protection: ON';
    if (typeof syncScenario2Schedulers === 'function') syncScenario2Schedulers();
  }
});

btnAuto.addEventListener('click', () => {
  if (inferenceEngine.autoDemoMode) { hardwareInterrupt(); return; }

  inferenceEngine.autoDemoMode = true;
  inferenceEngine.setProtectionEnabled(true);
  inferenceEngine.setGlobalOverride(false); // Let the predictor handle it
  
  btnAuto.classList.add('active');
  btnManual.classList.remove('active');
  btnManual.innerText = 'NPU Protection: OFF';
  badge.classList.add('show');
  badge.innerText = 'NPU Intercept: Standby';
  badge.style.background = '#E54747';
});

// ======================================================
// Scenario 1: Video VIMS Trigger
// ======================================================
const video            = document.getElementById('vims-video');
const videoPlayOverlay = document.getElementById('video-play-overlay');
const iconPlay         = document.getElementById('icon-play');
const iconPause        = document.getElementById('icon-pause');

function syncVideoPlayUI() {
  if (!video) return;
  const playing = !video.paused && !video.ended;
  if (videoPlayOverlay) videoPlayOverlay.classList.toggle('playing', playing);
  if (iconPlay)  iconPlay.style.display  = playing ? 'none' : '';
  if (iconPause) iconPause.style.display = playing ? '' : 'none';
}

if (video) {
  observer.setTarget(video, 'video');
  if (!video.paused) observer.setVideoState(true);
  syncVideoPlayUI();

  video.addEventListener('play',    () => { observer.setTarget(video, 'video'); observer.setVideoState(true);  syncVideoPlayUI(); });
  video.addEventListener('playing', () => { observer.setTarget(video, 'video'); observer.setVideoState(true);  syncVideoPlayUI(); });
  video.addEventListener('pause',   () => {
    observer.setVideoState(false);
    inferenceEngine.pressure = 0;
    observer.setTarget(null);
    renderController.setTargetElement(null);
    setTimeout(() => {
      if (document.getElementById('demo-scen1')?.classList.contains('active')) {
        renderController.setTargetElement(document.getElementById('video-wrapper'));
      }
    }, 50);
    syncVideoPlayUI();
  });
  video.addEventListener('ended',   () => {
    observer.setVideoState(false);
    inferenceEngine.pressure = 0;
    observer.setTarget(null);
    syncVideoPlayUI();
  });
}

if (videoPlayOverlay && video) {
  videoPlayOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    video.paused || video.ended ? video.play() : video.pause();
  });
}

// ======================================================
// Universal Theater Mode (navbar ??Theater button)
// ======================================================
const btnTheater     = document.getElementById('btn-theater-mode');
const cinemaBackdrop = document.getElementById('cinema-backdrop');
let isTheaterMode    = false;
let theaterTarget    = null;

function getTheaterTarget() {
  const activeBtn = document.querySelector('#demo-sub-tabs .demo-sub-btn.active');
  if (!activeBtn) return null;
  const map = {
    'demo-scen1': 'video-wrapper',
    'demo-scen2': 'ticker-box',
    'demo-scen3': 'demo-scen3',
    'demo-scen4': 'office-wrapper',
    'demo-scen5': 'habituation-wrapper',
    'demo-main': 'main-wrapper',
  };
  const id = map[activeBtn.dataset.demo];
  return id ? document.getElementById(id) : null;
}

function enterTheater() {
  theaterTarget = getTheaterTarget();
  if (!theaterTarget) return;
  theaterTarget.classList.add('theater-fullscreen');
  if (cinemaBackdrop) cinemaBackdrop.classList.add('active');
  if (btnTheater) { btnTheater.innerText = 'Exit Theater'; btnTheater.classList.add('active'); }
  isTheaterMode = true;
  window.dispatchEvent(new Event('resize'));
  refreshTheaterGazeBinding();
}
function exitTheater() {
  if (theaterTarget) theaterTarget.classList.remove('theater-fullscreen');
  if (cinemaBackdrop) cinemaBackdrop.classList.remove('active');
  if (btnTheater) { btnTheater.innerText = 'Theater'; btnTheater.classList.remove('active'); }
  isTheaterMode = false;
  theaterTarget = null;
  window.dispatchEvent(new Event('resize'));
  refreshTheaterGazeBinding();
}


function refreshTheaterGazeBinding() {
  const activeDemo = document.querySelector('#demo-sub-tabs .demo-sub-btn.active')?.dataset.demo;
  if (activeDemo) {
    setTimeout(() => setDemoTarget(activeDemo), 60);
    setTimeout(() => setDemoTarget(activeDemo), 180);
  }

  if (webcamMode && gazeTracker) {
    setTimeout(async () => {
      try {
        await gazeTracker.calibrate({ profile: 'quick', preCenterMs: 2200 });
        eyeTracker.clearAiAssistBias();
        gazeLastError = '';
      } catch (e) {
        gazeLastError = formatBootError(e);
      }
      _updateGazeDebugPanel();
    }, 200);
  }
}

if (btnTheater)      btnTheater.addEventListener('click', () => isTheaterMode ? exitTheater() : enterTheater());
if (cinemaBackdrop)  cinemaBackdrop.addEventListener('click', exitTheater);

// Demo 2 is gaze-contingent ??disable circular FOV overlay when on Demo 2
function setDemoTarget(demoId) {
  renderController.radiusOverride = null;
  if (demoId === 'demo-scen1') {
    const scen1Wrapper = document.getElementById('video-wrapper');
    const scen1Video = document.getElementById('vims-video');
    console.assert(!!scen1Wrapper && !!scen1Video, '[setDemoTarget] Scenario 1 target elements missing.');
    renderController.setTargetElement(scen1Wrapper);
    observer.setTarget(scen1Video, 'video');
  } else if (demoId === 'demo-scen2') {
    const tickerBox = document.getElementById('ticker-box');
    console.assert(!!tickerBox, '[setDemoTarget] Scenario 2 ticker-box missing.');
    renderController.setTargetElement(null);
    observer.setTarget(tickerBox, 'container');
  } else if (demoId === 'demo-scen3') {
    const desTarget = document.querySelector('.des-container');
    console.assert(!!desTarget, '[setDemoTarget] Scenario 3 des-container missing.');
    renderController.setTargetElement(null);
    observer.setTarget(desTarget, 'container');
  } else if (demoId === 'demo-scen4') {
    const officeVideoEl = document.getElementById('office-video');
    console.assert(!!officeVideoEl, '[setDemoTarget] Scenario 4 office-video missing.');
    renderController.setTargetElement(null);
    observer.setTarget(officeVideoEl, 'video');
  } else if (demoId === 'demo-scen5') {
    const hv = document.getElementById('habituation-video');
    console.assert(!!hv, '[setDemoTarget] Scenario 5 habituation-video missing.');
    observer.setTarget(hv, 'video');
    observer.setVideoState(!!hv && !hv.paused && !hv.ended);
    if (hv && !hv.paused) {
      renderController.setTargetElement(document.getElementById('habituation-wrapper'));
    } else {
      renderController.setTargetElement(null);
    }
  } else if (demoId === 'demo-main') {
    // Main Scenario: unified VIMS (FOV mask) + Habituation + Circadian DES.
    // Targets the new #main-* panel; hab and circadian engines self-activate
    // on video play via the listeners further down.
    const mv = document.getElementById('main-video');
    const mw = document.getElementById('main-wrapper');
    console.assert(!!mv && !!mw, '[setDemoTarget] Main Scenario elements missing.');
    observer.setTarget(mv, 'video');
    observer.setVideoState(!!mv && !mv.paused && !mv.ended);
    if (mv && !mv.paused) {
      renderController.setTargetElement(mw);
    } else {
      renderController.setTargetElement(null);
    }
  } else {
    renderController.setTargetElement(null); // hidden demos: no circular FOV
    observer.setTarget(null);
  }
}

// ======================================================
// Scenario 2: Dynamic Trading Terminal (40+ stocks)
// ======================================================
const STOCK_DATA = [
  {sym:'NVDA',price:876.50,sector:'SEMI'}, {sym:'AAPL',price:182.40,sector:'TECH'},
  {sym:'TSLA',price:245.80,sector:'EV'},   {sym:'MSFT',price:415.20,sector:'TECH'},
  {sym:'GOOG',price:175.90,sector:'TECH'}, {sym:'AMZN',price:186.70,sector:'ECOM'},
  {sym:'META',price:512.30,sector:'TECH'}, {sym:'AMD', price:162.40,sector:'SEMI'},
  {sym:'INTC',price: 31.20,sector:'SEMI'}, {sym:'COIN',price:225.40,sector:'CRYPTO'},
  {sym:'PLTR',price: 24.80,sector:'AI'},   {sym:'NFLX',price:628.90,sector:'STREAM'},
  {sym:'JPM', price:198.40,sector:'FIN'},  {sym:'GS',  price:462.10,sector:'FIN'},
  {sym:'BAC', price: 37.80,sector:'FIN'},  {sym:'MS',  price:101.20,sector:'FIN'},
  {sym:'UNH', price:520.60,sector:'HLTH'}, {sym:'JNJ', price:147.30,sector:'HLTH'},
  {sym:'PFE', price: 27.90,sector:'HLTH'}, {sym:'ABBV',price:172.50,sector:'HLTH'},
  {sym:'WMT', price:168.20,sector:'CONS'}, {sym:'COST',price:748.90,sector:'CONS'},
  {sym:'HD',  price:354.60,sector:'CONS'}, {sym:'TGT', price:147.80,sector:'CONS'},
  {sym:'XOM', price: 98.40,sector:'ENGY'}, {sym:'CVX', price:154.20,sector:'ENGY'},
  {sym:'COP', price:114.70,sector:'ENGY'}, {sym:'SLB', price: 44.30,sector:'ENGY'},
  {sym:'UBER',price: 76.40,sector:'RIDE'}, {sym:'LYFT',price: 18.20,sector:'RIDE'},
  {sym:'SNAP',price: 15.80,sector:'SOC'},  {sym:'SPOT',price:286.40,sector:'AUD'},
  {sym:'RBLX',price: 41.20,sector:'GAME'}, {sym:'MSTR',price:185.60,sector:'CRYP'},
  {sym:'RIOT',price: 11.40,sector:'MINE'}, {sym:'DIS', price: 96.80,sector:'ENT'},
  {sym:'BABA',price: 84.20,sector:'ECOM'}, {sym:'NIO', price:  6.40,sector:'EV'},
  {sym:'DKNG',price: 42.10,sector:'BET'},  {sym:'MELI',price:1842.0,sector:'ECOM'},
  {sym:'ARM', price:112.30,sector:'SEMI'}, {sym:'SMCI',price:872.50,sector:'SERV'},
];
const BASE_PRICES = STOCK_DATA.map(s => s.price);
let klineFocusIdx   = 0;
let klineData       = [];
let klineDirty      = false;
let hoveredStockIdx = null;
let tickerSpeed     = 1000;
let tickerTimer     = null;
let peripheralTickerTimer = null;
let focusedTickerRaf = null;
let focusedTickerLastTs = 0;
let scenario2Mode = 'normal';

function updateWatchlistContrast() {
  const isDemo2 = document.getElementById('demo-scen2')?.classList.contains('active');
  if (!isDemo2) {
    document.querySelectorAll('.wl-row').forEach(row => { row.style.filter = ''; });
    return;
  }
  const npuOn = inferenceEngine.isProtectionEnabled();
  document.querySelectorAll('.wl-row').forEach((row, i) => {
    row.style.filter = (npuOn && hoveredStockIdx !== null && i !== hoveredStockIdx)
      ? 'contrast(0.5) blur(1.5px)'
      : '';
  });
}

function buildWatchlist() {
  const wl = document.getElementById('watchlist');
  if (!wl) return;
  wl.innerHTML = '<div class="wl-header">WATCHLIST &nbsp;' + STOCK_DATA.length + ' stocks</div>' +
    STOCK_DATA.map((s, i) => `
      <div class="wl-row${i === 0 ? ' active' : ''}" id="wl-${i}" data-idx="${i}">
        <div><span class="wl-sym">${s.sym}</span><span class="wl-sector">${s.sector}</span></div>
        <div>
          <span class="wl-price" id="wl-price-${i}">${s.price.toFixed(2)}</span>
          <span class="wl-chg tick-up" id="wl-chg-${i}">+0.00%</span>
        </div>
      </div>`).join('');
  wl.querySelectorAll('.wl-row').forEach(row => {
    const idx = parseInt(row.dataset.idx);
    row.addEventListener('mouseenter', () => { hoveredStockIdx = idx; updateWatchlistContrast(); syncScenario2Schedulers(); });
    row.addEventListener('mouseleave', () => { hoveredStockIdx = null; updateWatchlistContrast(); syncScenario2Schedulers(); });
    row.addEventListener('click', () => {
      wl.querySelectorAll('.wl-row').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
      klineFocusIdx = idx;
      generateKLineData(idx);
      drawKLine();
      buildOrderBook();
    });
  });
}

function generateKLineData(idx) {
  klineData = [];
  let price = STOCK_DATA[idx].price * 0.96;
  for (let i = 0; i < 22; i++) {
    const open   = price;
    const change = (Math.random() - 0.48) * price * 0.018;
    const close  = open + change;
    const high   = Math.max(open, close) + Math.random() * price * 0.004;
    const low    = Math.min(open, close) - Math.random() * price * 0.004;
    klineData.push({ open, close, high, low });
    price = close;
  }
}

function drawKLine() {
  const canvas = document.getElementById('kline-canvas');
  if (!canvas || !canvas.offsetParent) return;
  const ctx = canvas.getContext('2d');
  const W   = canvas.width  = canvas.clientWidth  || 380;
  const H   = canvas.height = canvas.clientHeight || 160;
  ctx.clearRect(0, 0, W, H);

  // Background grid
  ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) { const y = H / 5 * i; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  for (let i = 1; i < 11; i++) { const x = W / 11 * i; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }

  if (!klineData.length) return;
  const allP  = klineData.flatMap(k => [k.high, k.low]);
  const minP  = Math.min(...allP), maxP = Math.max(...allP);
  const range = maxP - minP || 1;
  const gap   = W / klineData.length;
  const barW  = gap * 0.55;
  const toY   = p => H - ((p - minP) / range) * H * 0.8 - H * 0.08;

  klineData.forEach((k, i) => {
    const x    = i * gap + gap / 2;
    const isUp = k.close >= k.open;
    const col  = isUp ? '#ff4a4a' : '#00e676';
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, toY(k.high)); ctx.lineTo(x, toY(k.low)); ctx.stroke();
    const y1 = toY(Math.max(k.open, k.close));
    const bH = Math.max(Math.abs(toY(k.open) - toY(k.close)), 2);
    if (isUp) ctx.fillRect(x - barW/2, y1, barW, bH);
    else      ctx.strokeRect(x - barW/2, y1, barW, bH);
  });

  // Volume bars
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  klineData.forEach((_, i) => {
    const x = i * gap;
    const h = (Math.random() * 0.4 + 0.15) * H * 0.12;
    ctx.fillRect(x + gap * 0.1, H - h, gap * 0.8, h);
  });
}

function buildOrderBook() {
  const asksEl = document.getElementById('ob-asks');
  const bidsEl = document.getElementById('ob-bids');
  const midEl  = document.getElementById('ob-spread');
  if (!asksEl || !bidsEl) return;
  const price = STOCK_DATA[klineFocusIdx].price;
  let aH = '', bH = '';
  for (let i = 5; i >= 1; i--) {
    const p    = (price + i * price * 0.0008).toFixed(2);
    const sz   = Math.floor(Math.random() * 480 + 60);
    const fill = Math.min(sz / 600 * 100, 100).toFixed(0);
    aH += `<div class="ob-row ask"><span class="ob-price tick-down">${p}</span><span class="ob-size">${sz}</span><div class="ob-fill" style="width:${fill}%;background:rgba(0,230,118,0.1)"></div></div>`;
  }
  for (let i = 1; i <= 5; i++) {
    const p    = (price - i * price * 0.0008).toFixed(2);
    const sz   = Math.floor(Math.random() * 480 + 60);
    const fill = Math.min(sz / 600 * 100, 100).toFixed(0);
    bH += `<div class="ob-row bid"><span class="ob-price tick-up">${p}</span><span class="ob-size">${sz}</span><div class="ob-fill" style="width:${fill}%;background:rgba(255,74,74,0.1)"></div></div>`;
  }
  asksEl.innerHTML = aH;
  bidsEl.innerHTML = bH;
  if (midEl) midEl.innerText = `${price.toFixed(2)}  繚  spread ${(price * 0.0008).toFixed(3)}`;
}

function tickPrices() {
  const isDemo2Active = document.getElementById('demo-scen2')?.classList.contains('active');
  STOCK_DATA.forEach((s, i) => {
    const oldPrice = s.price;
    s.price = Math.max(s.price + (Math.random() - 0.495) * s.price * 0.003, 0.5);
    const pct   = (s.price - BASE_PRICES[i]) / BASE_PRICES[i] * 100;
    const isUp  = s.price >= oldPrice;
    const prEl  = document.getElementById(`wl-price-${i}`);
    const chEl  = document.getElementById(`wl-chg-${i}`);
    if (prEl) {
      prEl.innerText = s.price.toFixed(2);
      // Color-only tick feedback ??CSS transition handles smoothness, zero layout paint
      prEl.style.color = isUp ? '#ff6b6b' : '#4ade80';
      clearTimeout(prEl._t);
      prEl._t = setTimeout(() => { prEl.style.color = ''; }, 420);
    }
    if (chEl) {
      chEl.innerText = `${pct >= 0 ? '+' : '-'} ${Math.abs(pct).toFixed(2)}%`;
      chEl.className = `wl-chg ${pct >= 0 ? 'tick-up' : 'tick-down'}`;
    }
    if (i === klineFocusIdx) {
      const last = klineData[klineData.length - 1];
      if (last) { last.close = s.price; last.high = Math.max(last.high, s.price); last.low = Math.min(last.low, s.price); }
      if (Math.random() > 0.65) {
        klineData.shift();
        klineData.push({ open: s.price, close: s.price, high: s.price, low: s.price });
      }
      klineDirty = true; // rAF loop picks this up; no synchronous canvas paint inside setInterval
      const kpEl = document.getElementById('kline-price');
      const kcEl = document.getElementById('kline-change');
      const ksEl = document.getElementById('kline-symbol');
      const tot  = (s.price - BASE_PRICES[i]) / BASE_PRICES[i] * 100;
      if (kpEl) kpEl.innerText = s.price.toFixed(2);
      if (kcEl) { kcEl.innerText = `${tot >= 0 ? '+' : '-'} ${Math.abs(tot).toFixed(2)}%`; kcEl.className = `kline-chg ${tot >= 0 ? 'tick-up' : 'tick-down'}`; }
      if (ksEl) ksEl.innerText = s.sym;
    }
  });
  buildOrderBook();
  if (isDemo2Active) observer.injectFlow(35);
  updateWatchlistContrast();
}

const watchlistEl = document.getElementById('watchlist');
if (watchlistEl) {
  buildWatchlist();
  generateKLineData(0);
  setTimeout(() => { drawKLine(); buildOrderBook(); }, 120);
  tickerTimer = setInterval(tickPrices, tickerSpeed);
  const klineCanvas = document.getElementById('kline-canvas');
  if (klineCanvas) new ResizeObserver(() => { klineDirty = true; }).observe(klineCanvas.parentElement);

  // Architectural note: K-line canvas renders only when data changes (dirty flag).
  // Decouples canvas paint from the setInterval tick ??smooth 60fps, zero wasted GPU cycles.
  (function klineRenderLoop() {
    if (klineDirty) { drawKLine(); klineDirty = false; }
    requestAnimationFrame(klineRenderLoop);
  })();
}

const tickerSpeedEl    = document.getElementById('ticker-speed');
const tickerSpeedLabel = document.getElementById('ticker-speed-label');
if (tickerSpeedEl) {
  tickerSpeedEl.addEventListener('input', () => {
    tickerSpeed = parseInt(tickerSpeedEl.value, 10);
    if (tickerSpeedLabel) tickerSpeedLabel.innerText = `${tickerSpeed} ms`;
    if (scenario2Mode === 'normal') {
      clearInterval(tickerTimer);
      tickerTimer = setInterval(tickPrices, tickerSpeed);
    }
  });
}

function isScenario2GazeModeActive() {
  const isDemo2 = document.getElementById('demo-scen2')?.classList.contains('active');
  return isDemo2 && inferenceEngine.isProtectionEnabled() && hoveredStockIdx !== null;
}

function tickStockRowByIndex(i, volatilityScale = 1, flash = true) {
  const s = STOCK_DATA[i];
  const oldPrice = s.price;
  s.price = Math.max(s.price + (Math.random() - 0.495) * s.price * 0.003 * volatilityScale, 0.5);
  const pct = (s.price - BASE_PRICES[i]) / BASE_PRICES[i] * 100;
  const isUp = s.price >= oldPrice;

  const prEl = document.getElementById(`wl-price-${i}`);
  const chEl = document.getElementById(`wl-chg-${i}`);
  if (prEl) {
    prEl.innerText = s.price.toFixed(2);
    prEl.style.color = isUp ? '#ff6b6b' : '#4ade80';
    if (flash) {
      clearTimeout(prEl._t);
      prEl._t = setTimeout(() => { prEl.style.color = ''; }, 420);
    }
  }
  if (chEl) {
    chEl.innerText = `${pct >= 0 ? '+' : '-'} ${Math.abs(pct).toFixed(2)}%`;
    chEl.className = `wl-chg ${pct >= 0 ? 'tick-up' : 'tick-down'}`;
  }

  if (i === klineFocusIdx) {
    const last = klineData[klineData.length - 1];
    if (last) {
      last.close = s.price;
      last.high = Math.max(last.high, s.price);
      last.low = Math.min(last.low, s.price);
    }
    if (Math.random() > 0.65) {
      klineData.shift();
      klineData.push({ open: s.price, close: s.price, high: s.price, low: s.price });
    }
    klineDirty = true;

    const kpEl = document.getElementById('kline-price');
    const kcEl = document.getElementById('kline-change');
    const ksEl = document.getElementById('kline-symbol');
    const tot = (s.price - BASE_PRICES[i]) / BASE_PRICES[i] * 100;
    if (kpEl) kpEl.innerText = s.price.toFixed(2);
    if (kcEl) {
      kcEl.innerText = `${tot >= 0 ? '+' : '-'} ${Math.abs(tot).toFixed(2)}%`;
      kcEl.className = `kline-chg ${tot >= 0 ? 'tick-up' : 'tick-down'}`;
    }
    if (ksEl) ksEl.innerText = s.sym;
  }
}

function startScenario2NormalTicker() {
  clearInterval(tickerTimer);
  tickerTimer = setInterval(tickPrices, tickerSpeed);
}

function stopScenario2GazeSchedulers() {
  clearInterval(peripheralTickerTimer);
  peripheralTickerTimer = null;
  if (focusedTickerRaf) cancelAnimationFrame(focusedTickerRaf);
  focusedTickerRaf = null;
  focusedTickerLastTs = 0;
}

function startScenario2GazeSchedulers() {
  stopScenario2GazeSchedulers();

  peripheralTickerTimer = setInterval(() => {
    if (!isScenario2GazeModeActive()) return;
    STOCK_DATA.forEach((_, i) => {
      if (i === hoveredStockIdx) return;
      tickStockRowByIndex(i, 1.1, true);
    });
    buildOrderBook();
    observer.injectFlow(35);
    updateWatchlistContrast();
  }, 200);

  const focusedLoop = (ts) => {
    if (!isScenario2GazeModeActive()) {
      focusedTickerRaf = null;
      return;
    }
    if (!focusedTickerLastTs || ts - focusedTickerLastTs >= 16) {
      tickStockRowByIndex(hoveredStockIdx, 0.35, false);
      buildOrderBook();
      focusedTickerLastTs = ts;
    }
    focusedTickerRaf = requestAnimationFrame(focusedLoop);
  };
  focusedTickerRaf = requestAnimationFrame(focusedLoop);
}

function syncScenario2Schedulers() {
  const nextMode = isScenario2GazeModeActive() ? 'gaze' : 'normal';
  if (nextMode === scenario2Mode) return;
  scenario2Mode = nextMode;

  if (scenario2Mode === 'gaze') {
    clearInterval(tickerTimer);
    startScenario2GazeSchedulers();
  } else {
    stopScenario2GazeSchedulers();
    startScenario2NormalTicker();
  }
}

if (watchlistEl) {
  clearInterval(tickerTimer);
  startScenario2NormalTicker();
  setInterval(() => {
    syncScenario2Schedulers();
    updateWatchlistContrast();
  }, 120);
}

// ======================================================
// Scenario 3: DES ??Window Switch + Ambient Light
// ======================================================
const btnFocus     = document.getElementById('btn-focus-switch');
const btnNormal    = document.getElementById('btn-normal-room');
const btnBright    = document.getElementById('btn-bright-room');
const btnDark      = document.getElementById('btn-dark-room');
const ambientOverlay = document.getElementById('ambient-overlay');
const desContainer = document.querySelector('.des-container');
const winIde       = document.getElementById('win-ide');
const winExcel     = document.getElementById('win-excel');
let isDarkFocus    = true;
let ambientMode    = 'normal';

function triggerDESTransition() {
  const overlay = document.createElement('div');
  overlay.className = 'color-shift-overlay';
  document.body.appendChild(overlay);
  overlay.offsetHeight; // force reflow
  requestAnimationFrame(() => overlay.classList.add('active'));
  // Apply filter transition to both windows
  [winIde, winExcel].forEach(w => {
    if (!w) return;
    w.style.filter = 'brightness(1.25) contrast(1.1)';
    setTimeout(() => { w.style.filter = ''; }, 500);
  });
  setTimeout(() => {
    overlay.classList.remove('active');
    setTimeout(() => overlay.remove(), 600);
  }, 500);
}

if (btnFocus) {
  btnFocus.addEventListener('click', () => {
    isDarkFocus = !isDarkFocus;
    inferenceEngine.evaluateDES(isDarkFocus ? 'dark' : 'light');
    triggerDESTransition();
  });
}

function setAmbientMode(mode) {
  ambientMode = mode;
  btnNormal?.classList.toggle('active', mode === 'normal');
  btnBright?.classList.toggle('active', mode === 'bright');
  btnDark?.classList.toggle('active',   mode === 'dark');

  if (desContainer) {
    desContainer.classList.remove('bright-room', 'dark-room');
    if (mode === 'bright') desContainer.classList.add('bright-room');
    else if (mode === 'dark') desContainer.classList.add('dark-room');
    // 'normal': filter: none (no class)
  }
  if (winIde)   winIde.style.filter   = '';
  if (winExcel) winExcel.style.filter = '';
  if (ambientOverlay) ambientOverlay.style.opacity = '0';
}

setAmbientMode('normal');

if (btnNormal) btnNormal.addEventListener('click', () => setAmbientMode('normal'));
if (btnBright) btnBright.addEventListener('click', () => setAmbientMode('bright'));
if (btnDark)   btnDark.addEventListener('click',   () => setAmbientMode('dark'));

// ======================================================
// Webcam Ambient Light Sensing (Demo 3 BenQ ScreenBar analog)
// ======================================================
const btnWebcamSensing = document.getElementById('btn-webcam-sensing');
const ambientLuxEl     = document.getElementById('ambient-lux');
let webcamStream       = null;
let webcamSampleInterval = null;

function initAmbientSensor() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
    clearInterval(webcamSampleInterval);
    webcamSampleInterval = null;
    if (ambientLuxEl) ambientLuxEl.innerText = '--';
    if (btnWebcamSensing) { btnWebcamSensing.innerText = 'Webcam Sensing'; btnWebcamSensing.classList.remove('active'); }
    if (desContainer) desContainer.style.filter = '';
    return;
  }
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 32, height: 32 } })
    .then(stream => {
      webcamStream = stream;
      const camVideo = document.createElement('video');
      camVideo.srcObject = stream;
      camVideo.play();
      const offCanvas = document.createElement('canvas');
      offCanvas.width = offCanvas.height = 32;
      const ctx = offCanvas.getContext('2d');
      if (btnWebcamSensing) { btnWebcamSensing.innerText = '? Sensing...'; btnWebcamSensing.classList.add('active'); }
      webcamSampleInterval = setInterval(() => {
        ctx.drawImage(camVideo, 0, 0, 32, 32);
        const data = ctx.getImageData(0, 0, 32, 32).data;
        let lum = 0;
        for (let i = 0; i < data.length; i += 4) {
          lum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        }
        lum /= (32 * 32);
        const lux = Math.round(lum / 255 * 2000);
        if (ambientLuxEl) ambientLuxEl.innerText = lux + ' lux';
        // BenQ ScreenBar analog: auto-adjust brightness toward 500 lux target
        if (desContainer && ambientMode === 'normal') {
          const adj = lux < 200 ? 1.2 : lux > 800 ? 0.85 : 1.0;
          desContainer.style.filter = `brightness(${adj})`;
        }
      }, 500);
    })
    .catch(() => {
      if (ambientLuxEl) ambientLuxEl.innerText = 'No access';
    });
}

if (btnWebcamSensing) btnWebcamSensing.addEventListener('click', initAmbientSensor);

// ======================================================
// Scenario 4: Prolonged Office Work ??Circadian + Flicker
// ======================================================
const officeVideo        = document.getElementById('office-video');
const officePlayOverlay  = document.getElementById('office-play-overlay');
const officeIconPlay     = document.getElementById('office-icon-play');
const officeIconPause    = document.getElementById('office-icon-pause');
const circadianOverlay   = document.getElementById('circadian-overlay');
const flickerOverlay     = document.getElementById('flicker-overlay');
const circadianBadge     = document.getElementById('circadian-badge');
const circadianProgress  = document.getElementById('circadian-progress');

function syncOfficeUI() {
  if (!officeVideo) return;
  const playing = !officeVideo.paused && !officeVideo.ended;
  if (officePlayOverlay) officePlayOverlay.classList.toggle('playing', playing);
  if (officeIconPlay)  officeIconPlay.style.display  = playing ? 'none' : '';
  if (officeIconPause) officeIconPause.style.display = playing ? '' : 'none';
  if (flickerOverlay)  flickerOverlay.style.opacity  = playing ? '1' : '0';
}

// setCircadianWarmth(warmth01) ??single source of truth for circadian visuals.
// Writes to BOTH the legacy S4 panel (#circadian-overlay/badge/progress, #office-video)
// AND the new Main Scenario panel (#main-circadian-*, #main-video). Hidden panel's
// writes are inert ??keeps the rendering pipeline scenario-agnostic.
// Live circadian state ??read by stats panel for DES-protection detection.
let currentWarmth = 0;

function setCircadianWarmth(warmth01) {
  warmth01 = Math.max(0, Math.min(1, warmth01));
  currentWarmth = warmth01;

  let label;
  if      (warmth01 < 0.15) label = '?? Morning';
  else if (warmth01 < 0.45) label = '?儭?Afternoon';
  else if (warmth01 < 0.75) label = '?? Evening';
  else                      label = '?? Night';

  // Color-temperature hint. warmth=0 (cool daylight) ≈ 6500K,
  // warmth=1 (warm tungsten) ≈ 3000K. Linear K interpolation is rough but
  // matches what monitor blue-light-reduction settings typically expose.
  const kelvin = Math.round(6500 - warmth01 * 3500);
  const tempLabel = `≈ ${kelvin}K`;

  // Overlay: transparent morning ??warm amber-red night
  const r = 255;
  const g = Math.round(220 - warmth01 * 130);  // 220 ??90
  const b = Math.round(100 - warmth01 * 80);   // 100 ??20
  const alpha   = (warmth01 * 0.10).toFixed(3);
  const bg      = `rgba(${r},${g},${b},${alpha})`;
  const opacity = String(Math.min(warmth01 * 0.95, 0.95));
  const widthStr = (warmth01 * 100).toFixed(1) + '%';

  const sepia  = (warmth01 * 0.15).toFixed(3);
  const hueRot = Math.round(warmth01 * -7);
  const brightness = (1 - warmth01 * 0.1).toFixed(3);
  const contrast = (1 - warmth01 * 0.05).toFixed(3);
  const filter = `sepia(${sepia}) hue-rotate(${hueRot}deg) brightness(${brightness}) contrast(${contrast})`;

  // Main Scenario carries a stronger adaptive-visuals layer (v1 "BenQ
  // ScreenBar analog" port + Samsung outdoor-visibility cue):
  //   - dim room  → push brightness up to 1.20, contrast up to 1.18,
  //                 saturate up to 1.10, plus night-sharp text-shadow
  //   - bright room → drop brightness to 0.85 to fight glare, ease contrast
  // The mid-band stays neutral so normal indoor lighting is unchanged.
  const mainBrightness = (0.85 + (1 - warmth01) * 0.0 + warmth01 * 0.35).toFixed(3); // 0.85 → 1.20
  const mainContrast   = (1.00 + warmth01 * 0.18).toFixed(3);
  const mainSaturate   = (1.00 + warmth01 * 0.10).toFixed(3);
  const mainSepia      = (warmth01 * 0.18).toFixed(3);
  const mainHueRot     = Math.round(warmth01 * -8);
  const mainFilter = `sepia(${mainSepia}) hue-rotate(${mainHueRot}deg) brightness(${mainBrightness}) contrast(${mainContrast}) saturate(${mainSaturate})`;

  function _apply(overlayId, badgeId, progressId, videoId) {
    const overlay = document.getElementById(overlayId);
    const badge   = document.getElementById(badgeId);
    const prog    = document.getElementById(progressId);
    const video   = videoId && document.getElementById(videoId);
    if (overlay) {
      overlay.style.background = bg;
      overlay.style.opacity    = opacity;
    }
    if (badge) badge.textContent = label;
    if (prog)  prog.style.width  = widthStr;
    if (video) video.style.filter = filter;
  }

  // Legacy S4 binding
  _apply('circadian-overlay', 'circadian-badge', 'circadian-progress', 'office-video');

  // Main Scenario adaptive visuals — apply the stronger v1-derived filter
  // to #main-video and (when present) the Main Scenario container so
  // brightness/contrast/sharpness actually respond to ambient light.
  const mainOverlay = document.getElementById('main-circadian-overlay');
  const mainBadge   = document.getElementById('main-circadian-badge');
  const mainProg    = document.getElementById('main-circadian-progress');
  const mainVid     = document.getElementById('main-video');
  if (mainOverlay) { mainOverlay.style.background = bg; mainOverlay.style.opacity = opacity; }
  if (mainBadge)  mainBadge.textContent = label;
  if (mainProg)   mainProg.style.width = widthStr;
  if (mainVid)    mainVid.style.filter = mainFilter;

  const colorTempEl = document.getElementById('main-color-temp');
  if (colorTempEl) {
    colorTempEl.textContent = tempLabel;
    // Pill border tint shifts with temperature so the cue is visible at a
    // glance: cool blue → warm amber. Amber chosen to match the night-sharp
    // mode chrome the user already sees.
    const borderHue = Math.round(210 - warmth01 * 180); // 210 (blue) → 30 (amber)
    colorTempEl.style.borderColor = `hsl(${borderHue}, 80%, 50%)`;
    colorTempEl.style.color = `hsl(${borderHue}, 70%, 30%)`;
  }

  // Night-sharpness text enhancement when sufficiently dark
  const scen4Panel = document.getElementById('demo-scen4');
  const mainPanel  = document.getElementById('demo-main');
  if (scen4Panel) scen4Panel.classList.toggle('night-sharp', warmth01 > 0.65);
  if (mainPanel)  mainPanel.classList.toggle('night-sharp', warmth01 > 0.65);
}

// Legacy wrapper ??S4 video-time-driven circadian (linear progress 0?? ??logistic warmth)
function updateCircadian(progress) {
  const warmth = 1 / (1 + Math.exp(-10 * (progress - 0.5)));
  setCircadianWarmth(warmth);
}

// Main Scenario circadian timeline ??simulated 60-second cool?arm?ool loop.
// Drives setCircadianWarmth at RAF cadence. Replaced by real lux input in Phase 5.
const MAIN_CIRCADIAN_DURATION_MS = 60000;
let mainCircadianStart = null;
let mainCircadianRaf   = null;

function startMainCircadianTimeline() {
  // Disabled per user request (Visual tone time demonstration disabled)
  return;
  if (mainCircadianRaf) return;
  mainCircadianStart = performance.now();
  function loop() {
    const elapsed  = performance.now() - mainCircadianStart;
    // Triangle wave 0???? over (2 ? duration) so it cycles cool?arm?ool
    const t        = (elapsed % (2 * MAIN_CIRCADIAN_DURATION_MS)) / MAIN_CIRCADIAN_DURATION_MS;
    const progress = t <= 1 ? t : 2 - t;
    const warmth   = 1 / (1 + Math.exp(-10 * (progress - 0.5)));
    setCircadianWarmth(warmth);
    mainCircadianRaf = requestAnimationFrame(loop);
  }
  mainCircadianRaf = requestAnimationFrame(loop);
}

function stopMainCircadianTimeline() {
  if (mainCircadianRaf) cancelAnimationFrame(mainCircadianRaf);
  mainCircadianRaf = null;
}

if (officeVideo) {
  syncOfficeUI();
  officeVideo.addEventListener('play',    () => {
    syncOfficeUI();
    const isDemo4 = document.getElementById('demo-scen4')?.classList.contains('active');
    if (isDemo4) observer.setTarget(officeVideo, 'video');
  });
  officeVideo.addEventListener('playing', () => {
    syncOfficeUI();
    const isDemo4 = document.getElementById('demo-scen4')?.classList.contains('active');
    if (isDemo4) observer.setTarget(officeVideo, 'video');
  });
  officeVideo.addEventListener('pause',   () => {
    syncOfficeUI();
    const isDemo4 = document.getElementById('demo-scen4')?.classList.contains('active');
    if (isDemo4) observer.setTarget(officeVideo, 'video');
  });
  officeVideo.addEventListener('ended',   () => {
    syncOfficeUI();
    const isDemo4 = document.getElementById('demo-scen4')?.classList.contains('active');
    if (isDemo4) observer.setTarget(officeVideo, 'video');
  });

  officeVideo.addEventListener('timeupdate', () => {
    const dur = officeVideo.duration;
    if (!dur || isNaN(dur)) return;
    updateCircadian(officeVideo.currentTime / dur);
  });
}

if (officePlayOverlay && officeVideo) {
  officePlayOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    officeVideo.paused || officeVideo.ended ? officeVideo.play() : officeVideo.pause();
  });
}

// ======================================================
// Scenario 5: Progressive Habituation Engine
// ======================================================
const habVideo          = document.getElementById('habituation-video');
const habPlayOverlay    = document.getElementById('habituation-play-overlay');
const habIconPlay       = document.getElementById('hab-icon-play');
const habIconPause      = document.getElementById('hab-icon-pause');
const habProgressEl     = document.getElementById('habituation-progress');
const habRadiusDisplay  = document.getElementById('habituation-radius-display');
const habStatusEl       = document.getElementById('hab-status');
const habSessionsEl     = document.getElementById('hab-sessions');
const habResetsEl       = document.getElementById('hab-resets');
const habLogEl          = document.getElementById('hab-log');

const HAB_MIN = 15;
const HAB_MAX = 115;
let habRadius    = HAB_MIN;
let habSessions  = 0;
let habResets    = 0;
let habRafId      = null;
let habFrameCount = 0;
let habPenalized  = false;
let habPenaltyTO  = null;
let habWeakenTO   = null;
let habCoolingUntil = 0;

function habLog(msg) {
  const now   = new Date().toLocaleTimeString();
  const color = msg.includes('Reset') || msg.includes('Penalty') ? '#ff4a4a' : '#00e676';
  const text  = `[${now}] ${msg}`;
  function _appendTo(el) {
    if (!el) return;
    const line = document.createElement('div');
    line.style.color = color;
    line.textContent = text;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }
  _appendTo(habLogEl);
  _appendTo(document.getElementById('main-hab-log'));
}

function updateHabUI() {
  const pct        = ((habRadius - HAB_MIN) / (HAB_MAX - HAB_MIN)) * 100;
  const widthStr   = Math.min(100, Math.max(0, pct)).toFixed(1) + '%';
  const radiusText = `Clear FOV: ${habRadius.toFixed(0)}%`;

  // Legacy S5 panel
  if (habProgressEl)    habProgressEl.style.width   = widthStr;
  if (habRadiusDisplay) habRadiusDisplay.innerText  = radiusText;
  if (habSessionsEl)    habSessionsEl.innerText     = habSessions;
  if (habResetsEl)      habResetsEl.innerText       = habResets;

  // Main Scenario panel
  const mProgress = document.getElementById('main-hab-progress');
  const mRadius   = document.getElementById('main-hab-radius');
  const mSessions = document.getElementById('main-hab-sessions');
  const mResets   = document.getElementById('main-hab-resets');
  if (mProgress) mProgress.style.width = widthStr;
  if (mRadius)   mRadius.innerText     = radiusText;
  if (mSessions) mSessions.innerText   = habSessions;
  if (mResets)   mResets.innerText     = habResets;

  renderController.radiusOverride = habRadius;
}

function setHabStatus(text, color) {
  if (habStatusEl) { habStatusEl.innerText = text; habStatusEl.style.color = color; }
  const m = document.getElementById('main-hab-status');
  if (m) { m.innerText = text; m.style.color = color; }
}

function startHabEngine() {
  if (Date.now() < habCoolingUntil) return;
  if (habRafId) return;
  renderController.setNpuState(true);
  setHabStatus('Training', '#00e676');
  habLog(`Engine started ??FOV radius: ${habRadius.toFixed(1)}%`);
  const increment = (HAB_MAX - HAB_MIN) * 0.00005; // ~0.005% of range per frame (~3?? min full range)
  function habLoop() {
    if (!habPenalized) {
      habRadius = Math.min(HAB_MAX, habRadius + increment);
      habFrameCount++;
      if (habFrameCount % 60 === 0) {
        habSessions++;
        updateHabUI();
        if (habRadius >= HAB_MAX) {
          habLog('Full neural adaptation achieved!');
          stopHabEngine();
          return;
        }
      }
    }
    habRafId = requestAnimationFrame(habLoop);
  }
  habRafId = requestAnimationFrame(habLoop);
}

function cancelHabLoop() {
  if (typeof habRafId === 'number') cancelAnimationFrame(habRafId);
  habRafId = null;
}

function stopHabEngine() {
  cancelHabLoop();
  clearTimeout(habWeakenTO);
  habCoolingUntil = 0;
  habFrameCount = 0;
  setHabStatus('Paused', '#60a5fa');
}

function habComplaintPenalty() {
  // Force-stop the rAF loop immediately ??no background expansion during penalty
  cancelHabLoop();
  habFrameCount = 0;
  habRadius     = Math.max(HAB_MIN, habRadius - 15);
  habResets++;
  habPenalized  = true;
  habLog(`??Adaptation Reset ??FOV shrunk to ${habRadius.toFixed(1)}%. Engine locked 8s.`);
  setHabStatus('Locked', '#E54747');
  updateHabUI();
  clearTimeout(habPenaltyTO);
  // Restart engine after penalty window ONLY if the active demo video is still playing
  habPenaltyTO = setTimeout(() => {
    habPenalized = false;
    habLog('Penalty window ended ??resuming expansion.');
    if (_isActiveDemoVideoPlaying()) startHabEngine();
  }, 8000);
}

function habWeakenProtection() {
  cancelHabLoop();
  habPenalized = true;
  habCoolingUntil = Date.now() + 5000;
  clearTimeout(habWeakenTO);

  habRadius = Math.min(HAB_MAX, habRadius + 5);
  updateHabUI();
  habLog(`User tolerance assist: FOV widened +5% to ${habRadius.toFixed(1)}%. Cooldown 5s.`);
  setHabStatus('Cooling (5s)', '#f59e0b');

  habWeakenTO = setTimeout(() => {
    habPenalized = false;
    habLog('Cooldown ended ??resuming gradual expansion.');
    if (_isActiveDemoVideoPlaying()) startHabEngine();
  }, 5000);
}

function syncHabUI() {
  if (!habVideo) return;
  const playing = !habVideo.paused && !habVideo.ended;
  if (habPlayOverlay) habPlayOverlay.classList.toggle('playing', playing);
  if (habIconPlay)    habIconPlay.style.display  = playing ? 'none' : '';
  if (habIconPause)   habIconPause.style.display = playing ? '' : 'none';
}

if (habVideo) {
  syncHabUI();
  habVideo.addEventListener('play', () => {
    syncHabUI();
    observer.setTarget(habVideo, 'video');
    observer.setVideoState(true);
    renderController.setTargetElement(document.getElementById('habituation-wrapper'));
    // Entry loop removed, wait for user to explicitly start habituation
  });
  habVideo.addEventListener('playing', () => {
    syncHabUI();
    observer.setTarget(habVideo, 'video');
    observer.setVideoState(true);
  });
  habVideo.addEventListener('pause', () => {
    syncHabUI();
    observer.setTarget(habVideo, 'video');
    observer.setVideoState(false);
    stopHabEngine();
    clearTimeout(habWeakenTO);
    clearTimeout(habPenaltyTO);
    habPenalized = false;
    habCoolingUntil = 0;
    inferenceEngine.setGlobalOverride(false);
    renderController.radiusOverride = null;
    renderController.setTargetElement(null);
  });
  habVideo.addEventListener('ended', () => {
    syncHabUI();
    observer.setTarget(habVideo, 'video');
    observer.setVideoState(false);
    stopHabEngine();
    clearTimeout(habWeakenTO);
    clearTimeout(habPenaltyTO);
    habPenalized = false;
    habCoolingUntil = 0;
    inferenceEngine.setGlobalOverride(false);
    renderController.radiusOverride = null;
  });
}
if (habPlayOverlay && habVideo) {
  habPlayOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    habVideo.paused || habVideo.ended ? habVideo.play() : habVideo.pause();
  });
}

// Wire chatbot complaint/weaken to the habituation engine for any demo that
// uses the hab engine (Scenario 5 legacy panel + new Main Scenario panel).
function _isHabDemoActive() {
  const d = document.querySelector('.demo-sub-btn.active')?.dataset.demo;
  return d === 'demo-scen5' || d === 'demo-main';
}

chatbotUI.onComplain = () => {
  if (_isHabDemoActive()) habComplaintPenalty();
  else                    inferenceEngine.handleUserComplaint();
};

chatbotUI.onWeaken = () => {
  if (_isHabDemoActive()) habWeakenProtection();
  else                    renderController.relaxMask(15);
};

// ======================================================
// Main Scenario engine ??unified VIMS (FOV mask) + Habituation + Circadian DES.
// Reuses the hab engine (startHabEngine, habRadius, habComplaintPenalty etc.)
// declared above. Adds its own video event listeners and the simulated
// circadian timeline driver (real lux input arrives in Phase 5).
// ======================================================
const mainVideo       = document.getElementById('main-video');
const mainPlayOverlay = document.getElementById('main-play-overlay');
const mainIconPlay    = document.getElementById('main-icon-play');
const mainIconPause   = document.getElementById('main-icon-pause');
const mainWrapper     = document.getElementById('main-wrapper');

function _isActiveDemoVideoPlaying() {
  const d = document.querySelector('.demo-sub-btn.active')?.dataset.demo;
  if (d === 'demo-main'  && mainVideo && !mainVideo.paused && !mainVideo.ended) return true;
  if (d === 'demo-scen5' && habVideo  && !habVideo.paused  && !habVideo.ended)  return true;
  return false;
}

function syncMainUI() {
  if (!mainVideo) return;
  const playing = !mainVideo.paused && !mainVideo.ended;
  if (mainPlayOverlay) mainPlayOverlay.classList.toggle('playing', playing);
  if (mainIconPlay)    mainIconPlay.style.display  = playing ? 'none' : '';
  if (mainIconPause)   mainIconPause.style.display = playing ? '' : 'none';
}

if (mainVideo) {
  syncMainUI();

  mainVideo.addEventListener('play', () => {
    syncMainUI();
    observer.setTarget(mainVideo, 'video');
    observer.setVideoState(true);
    renderController.setTargetElement(mainWrapper);
    // Simulated circadian only when webcam mode is off ??lux sensor owns warmth otherwise.
    if (!webcamMode) startMainCircadianTimeline();

    // Removed entryLoop and startHabEngine, user must manually click Start Neural Adaptation
  });

  const btnStartHab = document.getElementById('btn-start-hab');
  if (btnStartHab) {
    let entryRafId = null; // Track entry animation

    btnStartHab.addEventListener('click', () => {
      // If running (or animating in), stop it
      if (habRafId || entryRafId) {
        if (entryRafId) {
          cancelAnimationFrame(entryRafId);
          entryRafId = null;
        }
        stopHabEngine();
        inferenceEngine.setGlobalOverride(false);
        renderController.radiusOverride = null;
        btnStartHab.innerText = '??Start Neural Adaptation';
        btnStartHab.classList.remove('active');
        return;
      }

      // Otherwise, start it
      btnStartHab.innerText = '??Stop Neural Adaptation';
      btnStartHab.classList.add('active');
      if (mainVideo.paused || mainVideo.ended) mainVideo.play();
      
      inferenceEngine.setGlobalOverride(true);
      // Smooth radius entry: ease from full-clear (100) ??habRadius over ~3s
      const entryFrom   = 100;
      const entryTarget = habRadius;
      const entryFrames = 180;
      let   entryF      = 0;
      renderController.radiusOverride = entryFrom;

      function entryLoop() {
        entryF++;
        const t     = Math.min(entryF / entryFrames, 1);
        const eased = 1 - Math.pow(1 - t, 2);
        renderController.radiusOverride = entryFrom - (entryFrom - entryTarget) * eased;
        if (t < 1) {
          entryRafId = requestAnimationFrame(entryLoop);
        } else {
          entryRafId = null;
          renderController.radiusOverride = entryTarget;
          startHabEngine();
        }
      }
      entryRafId = requestAnimationFrame(entryLoop);
    });
  }

  mainVideo.addEventListener('playing', () => {
    syncMainUI();
    observer.setTarget(mainVideo, 'video');
    observer.setVideoState(true);
  });

  mainVideo.addEventListener('pause', () => {
    syncMainUI();
    observer.setVideoState(false);
    stopHabEngine();
    stopMainCircadianTimeline();
    clearTimeout(habWeakenTO);
    clearTimeout(habPenaltyTO);
    habPenalized = false;
    habCoolingUntil = 0;
    inferenceEngine.setGlobalOverride(false);
    renderController.radiusOverride = null;
    renderController.setTargetElement(null);
  });

  mainVideo.addEventListener('ended', () => {
    syncMainUI();
    observer.setVideoState(false);
    stopHabEngine();
    stopMainCircadianTimeline();
    clearTimeout(habWeakenTO);
    clearTimeout(habPenaltyTO);
    habPenalized = false;
    habCoolingUntil = 0;
    inferenceEngine.setGlobalOverride(false);
    renderController.radiusOverride = null;
  });
}

if (mainPlayOverlay && mainVideo) {
  mainPlayOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    mainVideo.paused || mainVideo.ended ? mainVideo.play() : mainVideo.pause();
  });
}

// ----- Webcam Mode: shared MediaStream + LuxSensor + MediaPipe GazeTracker ---
const webcamSource = new WebcamSource();
let webcamMode = false;
let luxSensor = null;
let gazeTracker = null;
let gazeLastError = '';
let gazeCalibrated = false;
const luxChip = document.getElementById('main-lux-chip');
const webcamToggleBtn = document.getElementById('main-webcam-toggle');
const backendToggleBtn = document.getElementById('main-backend-toggle');
const recalibrateBtn = document.getElementById('main-recalibrate-btn');
const debugToggleBtn = document.getElementById('main-debug-toggle');
let gazeDebugPanel = null;
let gazeDebugVisible = false;
let gazeBackend = localStorage.getItem('senseease_gaze_backend') || 'mediapipe';

function setLuxChip(text) { if (luxChip) luxChip.innerText = text; }

function formatBootError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || String(err);
  if (err instanceof Event) {
    const src = err?.target?.src || err?.currentTarget?.src || 'unknown src';
    return `Event error (${src})`;
  }
  try { return JSON.stringify(err); } catch { return String(err); }
}

function setRecalibrateButtonState({ enabled = true, busy = false } = {}) {
  if (!recalibrateBtn) return;
  if (!enabled) {
    recalibrateBtn.style.display = 'none';
    return;
  }
  recalibrateBtn.style.display = '';
  recalibrateBtn.disabled = !!busy;
  recalibrateBtn.innerText = busy ? 'Quick center lock + calibrating...' : 'Recalibrate (Quick center)';
}

function setBackendButtonState() {
  if (!backendToggleBtn) return;
  const label = gazeBackend === 'openvino-bridge' ? 'OpenVINO Bridge' : 'MediaPipe';
  backendToggleBtn.innerText = `Backend: ${label}`;
  backendToggleBtn.classList.toggle('active', gazeBackend === 'openvino-bridge');
}

// ---------------------------------------------------------------------------
// Backend status pill — visible-to-audience indicator of which inference
// path is actually returning gaze samples. Colour-coded by device:
//   green=NPU, cyan=GPU, amber=CPU(OpenVINO), orange=OpenCV, blue=MediaPipe,
//   red=fallback (bridge requested but unreachable).
// ---------------------------------------------------------------------------
const backendPill = document.getElementById('main-backend-pill');
const backendPillLabel = document.getElementById('main-backend-pill-label');
const backendPillLatency = document.getElementById('main-backend-pill-latency');
const bridgeHintEl = document.getElementById('main-bridge-hint');
const gazeHintEl = document.getElementById('main-gaze-hint');

function setBackendPill({ state, label, latencyMs, visible = true }) {
  if (!backendPill) return;
  backendPill.style.display = visible ? '' : 'none';
  if (visible && state) backendPill.setAttribute('data-state', state);
  if (backendPillLabel && label) backendPillLabel.textContent = label;
  if (backendPillLatency) {
    if (Number.isFinite(latencyMs) && latencyMs > 0) {
      backendPillLatency.textContent = `· ${latencyMs.toFixed(1)} ms`;
    } else {
      backendPillLatency.textContent = '';
    }
  }
}

function setBridgeHint(text) {
  if (bridgeHintEl) bridgeHintEl.textContent = text || '';
}

function showGazeHint(on) {
  if (gazeHintEl) gazeHintEl.style.display = on ? '' : 'none';
}

// Resolve a (state, label) tuple from the live tracker diagnostics.
function _pillStateFromTracker() {
  if (!gazeTracker) return { state: 'idle', label: 'Backend: idle' };
  const diag = gazeTracker.getDiagnostics ? gazeTracker.getDiagnostics() : null;
  if (gazeBackend === 'openvino-bridge') {
    const remote = diag?.remote || {};
    const inferenceMs = diag?.inferenceMs;
    if (remote.backend === 'openvino') {
      const dev = (remote.device || 'CPU').toUpperCase();
      const state = dev === 'NPU' ? 'npu' : dev === 'GPU' ? 'gpu' : 'cpu';
      const baseName = dev === 'NPU' ? 'Intel NPU'
                     : dev === 'GPU' ? 'Intel GPU (iGPU)'
                     : 'Intel CPU (OpenVINO)';
      const precision = remote.precision && remote.precision !== '?'
        ? ` · ${remote.precision}`
        : '';
      return { state, label: `${baseName}${precision}`, latencyMs: inferenceMs };
    }
    if (remote.backend === 'opencv') {
      return { state: 'opencv', label: 'OpenCV (no AI accel)', latencyMs: inferenceMs };
    }
    return { state: 'mediapipe', label: 'Bridge connecting...' };
  }
  // MediaPipe (in-browser) — surface which delegate the runtime accepted so
  // booth visitors can see when the GPU path is active vs the CPU fallback.
  const delegate = (diag?.delegate || '').toUpperCase();
  const latencyMs = diag?.inferenceMs;
  if (delegate === 'GPU') {
    return { state: 'gpu', label: 'MediaPipe · GPU (WebGL)', latencyMs };
  }
  if (delegate === 'CPU') {
    return { state: 'mediapipe', label: 'MediaPipe · CPU (in-browser)', latencyMs };
  }
  return { state: 'mediapipe', label: 'MediaPipe (in-browser)' };
}

function refreshBackendPill() {
  if (!webcamMode) {
    setBackendPill({ visible: false });
    return;
  }
  const s = _pillStateFromTracker();
  setBackendPill({ ...s, visible: true });
}

// Live "gaze lost" watcher. EyeTracker.getDiagnostics().mode flips to 'lost'
// when no fresh gaze sample has arrived for >450ms. We surface that to the
// user with a red hint + auto-restore when samples resume — by far the
// commonest field issue (face out of frame, glare, looking away).
const gazeLostEl = document.getElementById('main-gaze-lost');
function refreshGazeLostState() {
  if (!webcamMode || !gazeTracker || !eyeTracker?.getDiagnostics) {
    if (gazeLostEl) gazeLostEl.style.display = 'none';
    return;
  }
  const d = eyeTracker.getDiagnostics();
  // Show "lost" if EyeTracker hasn't seen a sample in >1s. The 450ms internal
  // 'lost' threshold can flicker with brief blinks, so we use a more forgiving
  // 1s window for the user-visible warning.
  const isLost = Number.isFinite(d.staleMs) ? d.staleMs > 1000 : true;
  if (gazeLostEl) {
    gazeLostEl.style.display = isLost ? '' : 'none';
    if (isLost) {
      // Classify *why* gaze is lost so the CTA matches the actual problem.
      // - sampleHz still high but stale → MediaPipe is running, face left frame
      // - quality persistently low → lighting / face occlusion
      // - delegate=='none' → tracker never finished loading
      const tDiag = gazeTracker.getDiagnostics ? gazeTracker.getDiagnostics() : {};
      const delegate = (tDiag.delegate || '').toLowerCase();
      let cta = 'Gaze tracking lost — recalibrate';
      if (delegate === 'none' || tDiag.loadState === 'error') {
        cta = 'Tracker not ready — toggle Webcam Mode off and on';
      } else if (Number.isFinite(d.quality) && d.quality < 0.25) {
        cta = 'Light too low or face occluded — brighten room, remove glasses if dark';
      } else if (Number.isFinite(d.sampleHz) && d.sampleHz > 20) {
        cta = 'Face out of frame — center yourself ~50cm from camera';
      } else {
        cta = 'No gaze samples — click Recalibrate (Shift+Click for full)';
      }
      gazeLostEl.dataset.reason = cta;
      // The element's text content drives the visible message; safe to set
      // unconditionally since we only run this when isLost.
      const msgEl = gazeLostEl.querySelector('[data-role="msg"]') || gazeLostEl;
      msgEl.textContent = cta;
    }
  }
  if (gazeHintEl) gazeHintEl.style.display = isLost ? 'none' : '';
}

// Refresh the pill + gaze-lost state at 4 Hz — fast enough for the lost
// warning to feel responsive without thrashing the DOM. Animation/colours
// are CSS-driven.
setInterval(() => {
  refreshBackendPill();
  refreshGazeLostState();
}, 250);

function setDebugButtonState({ enabled = false } = {}) {
  if (!debugToggleBtn) return;
  debugToggleBtn.style.display = enabled ? '' : 'none';
  debugToggleBtn.innerText = gazeDebugVisible ? 'Hide Debug' : 'Show Debug';
  debugToggleBtn.classList.toggle('active', gazeDebugVisible);
}

function createGazeTracker() {
  const onGaze = (gx, gy, meta = {}) => {
    eyeTracker.setGazeSample(gx, gy, {
      quality: meta.quality,
      ts: meta.ts,
      source: meta.source || gazeBackend,
    });
  };
  if (gazeBackend === 'openvino-bridge') {
    return new OpenVinoBridgeTracker(webcamSource, onGaze, {
      wsUrl: 'ws://127.0.0.1:8765',
      sendHz: 12,
    });
  }
  return new GazeTracker(webcamSource, onGaze);
}

async function startMediaPipeGaze() {
  eyeTracker.setActiveBackend(gazeBackend);
  const tracker = createGazeTracker();
  await tracker.start();

  let calibrationError = '';
  if (!gazeCalibrated) {
    try {
      if (gazeBackend === 'openvino-bridge') {
        await tracker.calibrate({ preCenterMs: 1600 });
      } else {
        await tracker.calibrate({ profile: 'quick', preCenterMs: 2600 });
      }
      eyeTracker.clearAiAssistBias();
      gazeCalibrated = true;
    } catch (e) {
      calibrationError = formatBootError(e);
    }
  }
  return { tracker, calibrationError };
}

// Refresh the lux chip text every second (shows source + latest reading).
setInterval(() => {
  if (!webcamMode) return;
  if (luxSensor && luxSensor.sourceLabel !== 'simulated') {
    const reading = luxSensor.lastReading;
    setLuxChip(reading ? `Ambient: ${reading} (${luxSensor.sourceLabel})` : `Ambient: ${luxSensor.sourceLabel}`);
  } else {
    setLuxChip('Ambient: webcam ready');
  }
}, 1000);

function _setWebcamBtnState(text, { active = false, busy = false } = {}) {
  if (!webcamToggleBtn) return;
  webcamToggleBtn.disabled = busy;
  webcamToggleBtn.innerText = text;
  webcamToggleBtn.classList.toggle('active', active);
}

async function enableWebcamMode() {
  if (webcamMode) return;
  _setWebcamBtnState('Requesting Camera...', { busy: true });

  const isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!window.isSecureContext && !isLocalHost) {
    setLuxChip('Ambient: insecure context (use https/localhost)');
    _setWebcamBtnState('Enable Webcam Mode');
    return;
  }

  try {
    await webcamSource.start({ previewElementId: 'main-webcam-preview-large' });
  } catch (e) {
    console.warn('[Main] Webcam start failed:', e?.message || e);
    _setWebcamBtnState('Enable Webcam Mode');
    setLuxChip('Ambient: camera denied');
    return;
  }
  _setWebcamBtnState('Initialising gaze...', { busy: true, active: true });

  webcamMode = true;
  eyeTracker.disableMouse = true;
  eyeTracker.clearGazeSample();
  gazeLastError = '';

  // Lux sensor takes over circadian warmth ??pause the simulated timeline.
  stopMainCircadianTimeline();

  luxSensor = new LuxSensor(webcamSource, (warmth) => setCircadianWarmth(warmth));
  await luxSensor.start();
  setLuxChip(`Ambient: ${luxSensor.sourceLabel}`);

  try {
    const started = await startMediaPipeGaze();
    gazeTracker = started.tracker;
    gazeLastError = started.calibrationError || '';
    if (gazeLastError) {
      console.warn('[Main] Gaze tracker active with calibration warning:', gazeLastError);
    } else {
      console.info(`[Main] Gaze tracker backend active: ${gazeBackend}`);
    }
  } catch (e) {
    const firstErr = formatBootError(e);
    if (gazeBackend === 'openvino-bridge') {
      console.warn('[Main] OpenVINO bridge failed, fallback to mediapipe:', firstErr);
      gazeBackend = 'mediapipe';
      localStorage.setItem('senseease_gaze_backend', gazeBackend);
      setBackendButtonState();
      try {
        const started = await startMediaPipeGaze();
        gazeTracker = started.tracker;
        gazeLastError = `OpenVINO bridge unavailable; fallback to MediaPipe (${firstErr})`;
      } catch (fallbackErr) {
        gazeTracker = null;
        gazeLastError = formatBootError(fallbackErr);
        eyeTracker.clearGazeSample();
      }
    } else {
      gazeTracker = null;
      gazeLastError = firstErr;
      eyeTracker.clearGazeSample();
      console.warn('[Main] mediapipe gaze backend failed:', gazeLastError);
    }
  }

  _ensureGazeDebugPanel();
  _updateGazeDebugPanel();
  setRecalibrateButtonState({ enabled: !!gazeTracker, busy: false });
  setDebugButtonState({ enabled: true });
  if (markerToggleBtn) markerToggleBtn.style.display = '';
  setBackendButtonState();
  refreshBackendPill();
  showGazeHint(!!gazeTracker && !gazeLastError);

  const tray = document.getElementById('main-webcam-tray');
  if (tray) tray.style.display = '';

  _setWebcamBtnState('Disable Webcam Mode', { active: true });
}

function disableWebcamMode() {
  if (!webcamMode) return;
  webcamMode = false;
  eyeTracker.disableMouse = false;

  if (gazeTracker) { gazeTracker.stop(); gazeTracker = null; }
  gazeLastError = '';
  eyeTracker.setActiveBackend('none');
  eyeTracker.clearGazeSample();
  if (luxSensor) { luxSensor.stop(); luxSensor = null; }
  webcamSource.stop();

  // Resume simulated circadian if the demo video is still running.
  if (mainVideo && !mainVideo.paused && !mainVideo.ended) {
    startMainCircadianTimeline();
  }

  setLuxChip('Ambient: simulated');
  _removeGazeDebugPanel();
  setRecalibrateButtonState({ enabled: false });
  setDebugButtonState({ enabled: false });
  if (markerToggleBtn) markerToggleBtn.style.display = 'none';
  setBackendButtonState();
  setBackendPill({ visible: false });
  showGazeHint(false);
  if (gazeLostEl) gazeLostEl.style.display = 'none';
  const tray = document.getElementById('main-webcam-tray');
  if (tray) tray.style.display = 'none';
  _setWebcamBtnState('Enable Webcam Mode');
}

if (recalibrateBtn) {
  recalibrateBtn.title = 'Click: 800ms drift fix · Shift+Click: full re-calibrate';
  recalibrateBtn.addEventListener('click', async (ev) => {
    if (!gazeTracker || !webcamMode) return;
    setRecalibrateButtonState({ enabled: true, busy: true });
    try {
      // Plain click = micro (drift fix). Shift+Click = full quadratic remap.
      // Most field issues are drift, so micro is the fast default.
      if (ev.shiftKey) {
        if (gazeBackend === 'openvino-bridge') {
          await gazeTracker.calibrate({ preCenterMs: 1600 });
        } else {
          await gazeTracker.calibrate({ profile: 'quick', preCenterMs: 2600 });
        }
      } else if (typeof gazeTracker.microRecalibrate === 'function') {
        await gazeTracker.microRecalibrate({ windowMs: 800 });
      } else {
        await gazeTracker.calibrate({ profile: 'quick', preCenterMs: 2600 });
      }
      eyeTracker.clearAiAssistBias();
      gazeCalibrated = true;
      gazeLastError = '';
    } catch (e) {
      gazeLastError = formatBootError(e);
      console.warn('[Main] Recalibration failed:', gazeLastError);
    }
    _updateGazeDebugPanel();
    setRecalibrateButtonState({ enabled: true, busy: false });
  });
}

if (webcamToggleBtn) {
  webcamToggleBtn.addEventListener('click', () => {
    webcamMode ? disableWebcamMode() : enableWebcamMode();
  });
}

if (backendToggleBtn) {
  setBackendButtonState();
  backendToggleBtn.addEventListener('click', async () => {
    const next = gazeBackend === 'mediapipe' ? 'openvino-bridge' : 'mediapipe';
    // Health-check guard: don't let the user switch to a bridge that's
    // demonstrably offline. The previous flow committed the toggle then
    // discovered the bridge was unreachable during the slow boot path,
    // by which time MediaPipe had already torn itself down. We block the
    // switch with a targeted hint instead.
    if (next === 'openvino-bridge' && !_bridgeAvailable) {
      setBridgeHint('OpenVINO Bridge unreachable — start tools/openvino_bridge_server.py first, then click here to retry.');
      return;
    }
    gazeBackend = next;
    localStorage.setItem('senseease_gaze_backend', gazeBackend);
    setBackendButtonState();

    if (!webcamMode) return;
    disableWebcamMode();
    gazeCalibrated = false;
    await enableWebcamMode();
  });
}

// On page load, sanity-check the persisted backend choice. If the user last
// session selected the bridge but it's not currently running, silently
// downgrade to mediapipe so they don't hit a stale-state error on first
// Webcam Mode click. The probe runs ~3-9s after page load via probeBridge();
// this guard runs synchronously to prevent the boot path from racing.
if (gazeBackend === 'openvino-bridge') {
  // Defer the actual decision until probe completes; mark provisional.
  setTimeout(() => {
    if (!_bridgeAvailable && gazeBackend === 'openvino-bridge') {
      console.info('[Main] Persisted bridge unavailable, falling back to MediaPipe');
      gazeBackend = 'mediapipe';
      localStorage.setItem('senseease_gaze_backend', gazeBackend);
      setBackendButtonState();
    }
  }, 11000); // after the 3-pass probe (max ~9.5s) has had a chance to resolve
}

// Auto-probe the OpenVINO bridge. Lightweight (one WS open + close, ~1.5s
// timeout). Surfaces availability so the user knows whether toggling
// Backend will yield NPU acceleration. Re-runs every 12s while the page
// is visible so users who start the server in a separate terminal *after*
// loading the page see the hint update without refresh — clickable for
// instant retry.
let _bridgeAvailable = false;
let _bridgeHumanLabel = null;

function _formatBridgeHuman(hello) {
  const dev = (hello.device || 'CPU').toUpperCase();
  return hello.backend === 'openvino'
    ? (dev === 'NPU' ? 'Intel NPU' : dev === 'GPU' ? 'Intel GPU (iGPU)' : `OpenVINO ${dev}`)
    : (hello.backend === 'opencv' ? 'OpenCV (no AI accel)' : hello.backend || 'unknown');
}

async function probeBridge({ silent = false } = {}) {
  if (typeof OpenVinoBridgeTracker?.probe !== 'function') return;
  if (!silent) setBridgeHint('Probing OpenVINO bridge…');
  // Three-pass exponential probe (1.5s → 3s → 5s). The single 1.5s window
  // routinely missed cold-boot servers where OpenVINO model compile takes
  // 5-15s. Each pass is independent so a fast-start server still resolves
  // immediately on attempt 1.
  const timeouts = [1500, 3000, 5000];
  let lastErr = null;
  for (let i = 0; i < timeouts.length; i += 1) {
    try {
      if (!silent && i > 0) setBridgeHint(`Probing OpenVINO bridge… (retry ${i + 1}/3)`);
      const hello = await OpenVinoBridgeTracker.probe('ws://127.0.0.1:8765', timeouts[i]);
      _bridgeAvailable = true;
      _bridgeHumanLabel = _formatBridgeHuman(hello);
      if (gazeBackend === 'mediapipe') {
        setBridgeHint(`✓ OpenVINO Bridge ready on ${_bridgeHumanLabel}. Click "Backend: OpenVINO Bridge" to switch.`);
      } else {
        setBridgeHint(`✓ OpenVINO Bridge live on ${_bridgeHumanLabel}.`);
      }
      console.info(`[Main] Bridge probe OK on attempt ${i + 1}: backend=${hello.backend} device=${hello.device}`);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  _bridgeAvailable = false;
  _bridgeHumanLabel = null;
  if (!silent) {
    setBridgeHint('OpenVINO Bridge offline — using in-browser MediaPipe. Run tools/openvino_bridge_server.py for Intel NPU acceleration. (Click to retry)');
  }
  console.info('[Main] Bridge probe failed after 3 attempts:', lastErr?.message || lastErr);
}

// Initial probe on page load.
probeBridge();

// Re-probe every 12s while the document is visible so the hint refreshes
// when the user starts the bridge in a separate terminal post-load.
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  probeBridge({ silent: _bridgeAvailable });
}, 12000);

// Click the bridge hint to force a re-probe.
if (bridgeHintEl) {
  bridgeHintEl.style.cursor = 'pointer';
  bridgeHintEl.title = 'Click to re-probe the OpenVINO bridge';
  bridgeHintEl.addEventListener('click', () => probeBridge());
}

if (debugToggleBtn) {
  debugToggleBtn.addEventListener('click', () => {
    gazeDebugVisible = !gazeDebugVisible;
    if (gazeDebugPanel) gazeDebugPanel.style.display = gazeDebugVisible ? 'block' : 'none';
    setDebugButtonState({ enabled: webcamMode });
  });
}

function _ensureGazeDebugPanel() {
  if (gazeDebugPanel) return;
  const panel = document.createElement('div');
  panel.id = 'gaze-debug-panel';
  Object.assign(panel.style, {
    position: 'fixed',
    right: '12px',
    bottom: '12px',
    zIndex: '100001',
    minWidth: '230px',
    maxWidth: '320px',
    background: 'rgba(8, 12, 24, 0.86)',
    color: '#dbeafe',
    border: '1px solid rgba(148,163,184,0.35)',
    borderRadius: '10px',
    padding: '10px 12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
    lineHeight: '1.45',
    pointerEvents: 'none',
    whiteSpace: 'pre-line',
  });
  document.body.appendChild(panel);
  gazeDebugPanel = panel;
  gazeDebugPanel.style.display = gazeDebugVisible ? 'block' : 'none';
}

function _removeGazeDebugPanel() {
  if (!gazeDebugPanel) return;
  gazeDebugPanel.remove();
  gazeDebugPanel = null;
}

function _updateGazeDebugPanel() {
  if (!gazeDebugPanel || !webcamMode) return;
  const d = eyeTracker.getDiagnostics ? eyeTracker.getDiagnostics() : null;
  const tDiag = gazeTracker?.getDiagnostics ? gazeTracker.getDiagnostics() : null;
  const trackerLoad = tDiag?.loadState || (gazeTracker ? 'n/a' : 'none');
  const mappingMode = tDiag?.mappingMode || 'n/a';
  const c = tDiag?.calibration;
  const calText = c
    ? `${c.grade || 'n/a'} (rmse ${Number.isFinite(c.rmsePx) ? c.rmsePx.toFixed(0) : 'inf'}px, n=${c.samples ?? 0}, ${c.passed ? 'pass' : 'fail'})`
    : 'none';

  gazeDebugPanel.textContent = [
    '[Gaze Debug]',
    `backend: ${gazeBackend}`,
    `tracker: ${gazeTracker ? 'active' : 'none'}`,
    `load: ${trackerLoad}`,
    `mapping: ${mappingMode}`,
    `mode: ${d?.mode || 'n/a'}`,
    `quality: ${Number.isFinite(d?.quality) ? d.quality.toFixed(2) : 'n/a'}`,
    `fps: ${Number.isFinite(d?.sampleHz) ? d.sampleHz.toFixed(1) : 'n/a'}`,
    `stale: ${Number.isFinite(d?.staleMs) ? `${d.staleMs.toFixed(0)}ms` : 'n/a'}`,
    `zone: ${Number.isFinite(d?.zone) ? d.zone : 'n/a'}`,
    `rej jumps: ${d?.rejectedJumps ?? 0}`,
    `calibration: ${calText}`,
  ].join('\n');
}

setInterval(() => {
  if (webcamMode) _updateGazeDebugPanel();
}, 250);

// ======================================================
// Statistics Dashboard ??Chart.js charts
// ======================================================
let vimsChartProtected = null;
let vimsChartBaseline = null;
let desChart  = null;
let desFatigue      = 0;   // with protection
let desFatigueRaw   = 0;   // without protection
let statIntercepts   = 0;
let statPeakFlow     = 0;
let statPeakPressure = 0;
let statWasMaskActive = false;
let warmShiftSeconds = 0;            // cumulative seconds spent in warm-shift DES protection
const statsSessionStart = Date.now();
let desProtectionHistory = []; // parallel bool array: was DES protection on at each second?
let baselinePressure = 0;
let baselineFlowHistory = [];
let baselinePressureHistory = [];

function initCharts() {
  const vimsProtectedCtx = document.getElementById('chart-vims-protected');
  const vimsBaselineCtx = document.getElementById('chart-vims-baseline');
  const desCtx  = document.getElementById('chart-des');
  if (!vimsProtectedCtx || !vimsBaselineCtx || !desCtx || typeof Chart === 'undefined') return;

  const sharedOptions = {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(0,0,0,0.75)' } },
    scales: {
      x: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: '#6b7280', font: { size: 10 }, maxTicksLimit: 10 } },
      y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { color: '#6b7280', font: { size: 10 } }, beginAtZero: true },
    },
  };

  vimsChartProtected = new Chart(vimsProtectedCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Effective Flow', data: [], borderColor: '#9ca3af', borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: false },
        { label: 'VIMS Pressure', data: [], borderColor: '#024AD8', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: { target: 'origin', above: 'rgba(2,74,216,0.07)' } },
      ],
    },
    options: { ...sharedOptions, scales: { ...sharedOptions.scales, y: { ...sharedOptions.scales.y, max: 200 } } },
  });

  vimsChartBaseline = new Chart(vimsBaselineCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Raw Flow', data: [], borderColor: '#9ca3af', borderWidth: 1.5, pointRadius: 0, tension: 0.3, fill: false },
        { label: 'Projected Pressure (No NPU)', data: [], borderColor: '#E54747', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: { target: 'origin', above: 'rgba(229,71,71,0.07)' } },
      ],
    },
    options: { ...sharedOptions, scales: { ...sharedOptions.scales, y: { ...sharedOptions.scales.y, max: 200 } } },
  });

  desChart = new Chart(desCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Without SenseEase', data: [], borderColor: '#E54747', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false },
        { label: 'With Protection',   data: [], borderColor: '#00e676', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false },
      ],
    },
    options: sharedOptions,
  });
}

function updateStatsData() {
  // Update session summary metrics
  const flow     = inferenceEngine.observer.opticalFlow;
  const pressure = inferenceEngine.pressure;
  if (flow     > statPeakFlow)     { statPeakFlow     = flow;     }
  if (pressure > statPeakPressure) { statPeakPressure = pressure; }
  const maskNow = inferenceEngine.isMaskActive || inferenceEngine.isGlobalOverrideOn;
  if (maskNow && !statWasMaskActive) statIntercepts++;
  statWasMaskActive = maskNow;

  // DES protection is active when:
  const desOn = currentWarmth > 0.4
    || document.querySelector('.des-container.bright-room, .des-container.dark-room') !== null
    || renderController.npuActive;
  desFatigueRaw += 1;
  desFatigue    += desOn ? 0.3 : 1;
  if (currentWarmth > 0.4) warmShiftSeconds += 1;

  const rawFlow = inferenceEngine.observer.opticalFlow;
  const weight = inferenceEngine.passiveFlowWeight * 0.05;
  if (rawFlow < inferenceEngine.noiseGateThreshold) {
    baselinePressure = Math.max(0, baselinePressure * 0.965);
  } else {
    baselinePressure = Math.max(0, (baselinePressure * 0.98) + (rawFlow * weight));
  }

  baselineFlowHistory.push(parseFloat(rawFlow.toFixed(1)));
  baselinePressureHistory.push(parseFloat(baselinePressure.toFixed(1)));
  if (baselineFlowHistory.length > 120) baselineFlowHistory.shift();
  if (baselinePressureHistory.length > 120) baselinePressureHistory.shift();

  desProtectionHistory.push({ raw: desFatigueRaw, prot: desFatigue });
  if (desProtectionHistory.length > 120) desProtectionHistory.shift();
}

function updateCharts() {
  if (!vimsChartProtected || !vimsChartBaseline || !desChart) return;

  const uptime = Math.floor((Date.now() - statsSessionStart) / 1000);
  const uptimeStr = uptime >= 60 ? `${Math.floor(uptime/60)}m ${uptime%60}s` : `${uptime}s`;
  const elUp = document.getElementById('stat-uptime');
  const elIF = document.getElementById('stat-intercepts');
  const elPF = document.getElementById('stat-peak-flow');
  const elPP = document.getElementById('stat-peak-pressure');
  const elLiveProtectedFlow = document.getElementById('stat-live-protected-flow');
  const elLiveProtectedPressure = document.getElementById('stat-live-protected-pressure');
  const elLiveBaselineFlow = document.getElementById('stat-live-baseline-flow');
  const elLiveBaselinePressure = document.getElementById('stat-live-baseline-pressure');
  if (elUp) elUp.innerText = uptimeStr;
  if (elIF) elIF.innerText = statIntercepts;
  if (elPF) elPF.innerText = statPeakFlow.toFixed(1);
  if (elPP) elPP.innerText = statPeakPressure.toFixed(1);
  const elWS = document.getElementById('stat-warm-shift');
  if (elWS) {
    elWS.innerText = warmShiftSeconds >= 60
      ? `${Math.floor(warmShiftSeconds/60)}m ${warmShiftSeconds%60}s`
      : `${warmShiftSeconds}s`;
  }

  const rawFlow = inferenceEngine.observer.opticalFlow;
  const pressure = inferenceEngine.pressure;
  
  if (elLiveProtectedFlow) elLiveProtectedFlow.innerText = inferenceEngine.flowHistory.length
    ? inferenceEngine.flowHistory[inferenceEngine.flowHistory.length - 1].toFixed(1)
    : '0.0';
  if (elLiveProtectedPressure) elLiveProtectedPressure.innerText = pressure.toFixed(1);
  if (elLiveBaselineFlow) elLiveBaselineFlow.innerText = rawFlow.toFixed(1);
  if (elLiveBaselinePressure) elLiveBaselinePressure.innerText = baselinePressure.toFixed(1);

  const labels = inferenceEngine.timeHistory.map(t => `${t}s`);

  vimsChartProtected.data.labels = labels;
  vimsChartProtected.data.datasets[0].data = inferenceEngine.flowHistory;
  vimsChartProtected.data.datasets[1].data = inferenceEngine.pressureHistory;
  vimsChartProtected.update('none');

  vimsChartBaseline.data.labels = labels;
  vimsChartBaseline.data.datasets[0].data = baselineFlowHistory;
  vimsChartBaseline.data.datasets[1].data = baselinePressureHistory;
  vimsChartBaseline.update('none');

  // DES chart: rolling window matching timeHistory length
  desChart.data.labels              = inferenceEngine.timeHistory.map(t => `${t}s`);
  desChart.data.datasets[0].data    = desProtectionHistory.map(d => d.raw);
  desChart.data.datasets[1].data    = desProtectionHistory.map(d => d.prot);
  desChart.update('none');
}

// Initialize charts once (lazy: when the stats tab first becomes visible)
let chartsInited = false;
document.getElementById('tab-stats') && (() => {
  const statsTabBtn = document.querySelector('[data-target="tab-stats"]');
  if (statsTabBtn) {
    statsTabBtn.addEventListener('click', () => {
      if (!chartsInited) { initCharts(); chartsInited = true; }
    });
  }
})();

// Data collection runs every second regardless of tab
setInterval(() => {
  updateStatsData();
  if (chartsInited) updateCharts();
}, 1000);


