import './style.css'
import { SenseObserver }    from './core/SenseObserver.js'
import { RenderController } from './core/RenderController.js'
import { ChatbotUI }        from './components/ChatbotUI.js'
import { InferenceEngine }  from './core/InferenceEngine.js'
import { EyeTracker }       from './core/EyeTracker.js'
import { DataNormalizer }   from './core/DataNormalizer.js'
import { VIMSPredictor }    from './core/VIMSPredictor.js'
import { DitheringShader }  from './core/DitheringShader.js'

// ── V4 Four-Layer Architecture ──────────────────────────
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

// ── Open HP IQ Feedback button ───────────────────────────
const btnOpenChatbot = document.getElementById('btn-open-chatbot');
if (btnOpenChatbot) btnOpenChatbot.addEventListener('click', () => chatbotUI.open());

const elDashPressure = document.getElementById('dash-pressure');
const elVimsPressureValue = document.getElementById('vims-pressure-value');
console.assert(!!elDashPressure, '[MainLoop] Missing #dash-pressure DOM node.');
if (!elDashPressure) console.error('[MainLoop] #dash-pressure not found; VIMS UI cannot render.');
console.assert(!!elDashPressure || !!elVimsPressureValue, '[MainLoop] No pressure DOM target found.');

function runGlobalMainLoop() {
  const pressure = inferenceEngine.getPressure();
  if (Number.isNaN(pressure)) {
    console.error('VIMS Pressure calculated as NaN! Check inputs.');
  }
  const pressureText = (Number.isFinite(pressure) ? pressure : 0).toFixed(2);
  if (elDashPressure) elDashPressure.innerText = pressureText;
  if (elVimsPressureValue) elVimsPressureValue.innerText = pressureText;
  requestAnimationFrame(runGlobalMainLoop);
}
requestAnimationFrame(runGlobalMainLoop);

// ======================================================
// SPA Routing — 3 Main Tabs
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
  btnAuto.classList.add('active');
  btnManual.classList.remove('active');
  btnManual.innerText = 'NPU Protection: Auto';
  badge.classList.add('show');

  let isOn = false;
  badge.innerText = 'NPU Intercept: Standby';
  badge.style.background = '#E54747';

  autoDemoTimer = setInterval(() => {
    const demosTabActive = document.getElementById('tab-demos')?.classList.contains('active');
    if (!demosTabActive) return;
    isOn = !isOn;
    inferenceEngine.setProtectionEnabled(isOn);
    inferenceEngine.setGlobalOverride(isOn);
    badge.innerText        = isOn ? 'NPU Intercept: Active'   : 'NPU Intercept: Disabled';
    badge.style.background = isOn ? '#024AD8' : '#E54747';
    if (!isOn) hoveredStockIdx = null;
    if (typeof syncScenario2Schedulers === 'function') syncScenario2Schedulers();
    if (typeof updateWatchlistContrast === 'function') updateWatchlistContrast();
  }, 5000);
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
// Universal Theater Mode (navbar ⛶ Theater button)
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
  };
  const id = map[activeBtn.dataset.demo];
  return id ? document.getElementById(id) : null;
}

function enterTheater() {
  theaterTarget = getTheaterTarget();
  if (!theaterTarget) return;
  theaterTarget.classList.add('theater-fullscreen');
  if (cinemaBackdrop) cinemaBackdrop.classList.add('active');
  if (btnTheater) { btnTheater.innerText = '✕ Exit Theater'; btnTheater.classList.add('active'); }
  isTheaterMode = true;
  window.dispatchEvent(new Event('resize'));
}
function exitTheater() {
  if (theaterTarget) theaterTarget.classList.remove('theater-fullscreen');
  if (cinemaBackdrop) cinemaBackdrop.classList.remove('active');
  if (btnTheater) { btnTheater.innerText = '⛶ Theater'; btnTheater.classList.remove('active'); }
  isTheaterMode = false;
  theaterTarget = null;
  window.dispatchEvent(new Event('resize'));
}

if (btnTheater)      btnTheater.addEventListener('click', () => isTheaterMode ? exitTheater() : enterTheater());
if (cinemaBackdrop)  cinemaBackdrop.addEventListener('click', exitTheater);

// Demo 2 is gaze-contingent — disable circular FOV overlay when on Demo 2
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
  if (midEl) midEl.innerText = `${price.toFixed(2)}  ·  spread ${(price * 0.0008).toFixed(3)}`;
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
      // Color-only tick feedback — CSS transition handles smoothness, zero layout paint
      prEl.style.color = isUp ? '#ff6b6b' : '#4ade80';
      clearTimeout(prEl._t);
      prEl._t = setTimeout(() => { prEl.style.color = ''; }, 420);
    }
    if (chEl) {
      chEl.innerText = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(2)}%`;
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
      if (kcEl) { kcEl.innerText = `${tot >= 0 ? '▲' : '▼'} ${Math.abs(tot).toFixed(2)}%`; kcEl.className = `kline-chg ${tot >= 0 ? 'tick-up' : 'tick-down'}`; }
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
  // Decouples canvas paint from the setInterval tick — smooth 60fps, zero wasted GPU cycles.
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
// Scenario 3: DES — Window Switch + Ambient Light
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
    if (ambientLuxEl) ambientLuxEl.innerText = '—';
    if (btnWebcamSensing) { btnWebcamSensing.innerText = '💡 Webcam Sensing'; btnWebcamSensing.classList.remove('active'); }
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
      if (btnWebcamSensing) { btnWebcamSensing.innerText = '🔴 Sensing...'; btnWebcamSensing.classList.add('active'); }
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
// Scenario 4: Prolonged Office Work — Circadian + Flicker
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

// setCircadianWarmth(warmth01) — single source of truth for circadian visuals.
// Writes to BOTH the legacy S4 panel (#circadian-overlay/badge/progress, #office-video)
// AND the new Main Scenario panel (#main-circadian-*, #main-video). Hidden panel's
// writes are inert — keeps the rendering pipeline scenario-agnostic.
function setCircadianWarmth(warmth01) {
  warmth01 = Math.max(0, Math.min(1, warmth01));

  let label;
  if      (warmth01 < 0.15) label = '🌅 Morning';
  else if (warmth01 < 0.45) label = '☀️ Afternoon';
  else if (warmth01 < 0.75) label = '🌇 Evening';
  else                      label = '🌙 Night';

  // Overlay: transparent morning → warm amber-red night
  const r = 255;
  const g = Math.round(220 - warmth01 * 130);  // 220 → 90
  const b = Math.round(100 - warmth01 * 80);   // 100 → 20
  const alpha   = (warmth01 * 0.18).toFixed(3);
  const bg      = `rgba(${r},${g},${b},${alpha})`;
  const opacity = String(Math.min(warmth01 * 0.95, 0.95));
  const widthStr = (warmth01 * 100).toFixed(1) + '%';

  const sepia  = (warmth01 * 0.3).toFixed(3);
  const hueRot = Math.round(warmth01 * -14);
  const filter = `sepia(${sepia}) hue-rotate(${hueRot}deg)`;

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
  // Main Scenario binding
  _apply('main-circadian-overlay', 'main-circadian-badge', 'main-circadian-progress', 'main-video');

  // Night-sharpness text enhancement when sufficiently dark
  const scen4Panel = document.getElementById('demo-scen4');
  const mainPanel  = document.getElementById('demo-main');
  if (scen4Panel) scen4Panel.classList.toggle('night-sharp', warmth01 > 0.65);
  if (mainPanel)  mainPanel.classList.toggle('night-sharp', warmth01 > 0.65);
}

// Legacy wrapper — S4 video-time-driven circadian (linear progress 0→1 → logistic warmth)
function updateCircadian(progress) {
  const warmth = 1 / (1 + Math.exp(-10 * (progress - 0.5)));
  setCircadianWarmth(warmth);
}

// Main Scenario circadian timeline — simulated 60-second cool→warm→cool loop.
// Drives setCircadianWarmth at RAF cadence. Replaced by real lux input in Phase 5.
const MAIN_CIRCADIAN_DURATION_MS = 60000;
let mainCircadianStart = null;
let mainCircadianRaf   = null;

function startMainCircadianTimeline() {
  if (mainCircadianRaf) return;
  mainCircadianStart = performance.now();
  function loop() {
    const elapsed  = performance.now() - mainCircadianStart;
    // Triangle wave 0→1→0 over (2 × duration) so it cycles cool→warm→cool
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
  setHabStatus('Training ▶', '#00e676');
  habLog(`Engine started — FOV radius: ${habRadius.toFixed(1)}%`);
  const increment = (HAB_MAX - HAB_MIN) * 0.00005; // ~0.005% of range per frame (~3–4 min full range)
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
  setHabStatus('Paused ⏸', '#60a5fa');
}

function habComplaintPenalty() {
  // Force-stop the rAF loop immediately — no background expansion during penalty
  cancelHabLoop();
  habFrameCount = 0;
  habRadius     = Math.max(HAB_MIN, habRadius - 15);
  habResets++;
  habPenalized  = true;
  habLog(`⚠ Adaptation Reset — FOV shrunk to ${habRadius.toFixed(1)}%. Engine locked 8s.`);
  setHabStatus('Locked ⛔', '#E54747');
  updateHabUI();
  clearTimeout(habPenaltyTO);
  // Restart engine after penalty window ONLY if the active demo video is still playing
  habPenaltyTO = setTimeout(() => {
    habPenalized = false;
    habLog('Penalty window ended — resuming expansion.');
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
    habLog('Cooldown ended — resuming gradual expansion.');
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
    inferenceEngine.setGlobalOverride(true);

    // Smooth entry: ease from 100 → habRadius over ~3 seconds (180 frames)
    const entryFrom   = 100;
    const entryTarget = habRadius;
    const entryFrames = 180;
    let   entryF      = 0;
    renderController.radiusOverride = entryFrom;

    function entryLoop() {
      entryF++;
      const t     = Math.min(entryF / entryFrames, 1);
      const eased = 1 - Math.pow(1 - t, 2); // ease-out quad
      renderController.radiusOverride = entryFrom - (entryFrom - entryTarget) * eased;
      if (t < 1) {
        requestAnimationFrame(entryLoop);
      } else {
        renderController.radiusOverride = entryTarget;
        startHabEngine();
      }
    }
    requestAnimationFrame(entryLoop);
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
// Main Scenario engine — unified VIMS (FOV mask) + Habituation + Circadian DES.
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
    inferenceEngine.setGlobalOverride(true);
    startMainCircadianTimeline();

    // Smooth radius entry: ease from full-clear (100) → habRadius over ~3s
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
        requestAnimationFrame(entryLoop);
      } else {
        renderController.radiusOverride = entryTarget;
        startHabEngine();
      }
    }
    requestAnimationFrame(entryLoop);
  });

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

// ======================================================
// Statistics Dashboard — Chart.js charts
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

function updateCharts() {
  // Update session summary metrics
  const flow     = inferenceEngine.observer.opticalFlow;
  const pressure = inferenceEngine.pressure;
  if (flow     > statPeakFlow)     { statPeakFlow     = flow;     }
  if (pressure > statPeakPressure) { statPeakPressure = pressure; }
  const maskNow = inferenceEngine.isMaskActive || inferenceEngine.isGlobalOverrideOn;
  if (maskNow && !statWasMaskActive) statIntercepts++;
  statWasMaskActive = maskNow;

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

  if (!vimsChartProtected || !vimsChartBaseline || !desChart) return;

  // DES fatigue: baseline +1/s, with protection +0.3/s
  const desOn = document.querySelector('.des-container.bright-room, .des-container.dark-room') !== null
    || renderController.npuActive;
  desFatigueRaw += 1;
  desFatigue    += desOn ? 0.3 : 1;

  const rawFlow = inferenceEngine.observer.opticalFlow;
  const weight = inferenceEngine.passiveFlowWeight * 0.05;
  if (rawFlow < inferenceEngine.noiseGateThreshold) {
    baselinePressure = Math.max(0, baselinePressure * 0.965);
  } else {
    baselinePressure = Math.max(0, (baselinePressure * 0.98) + (rawFlow * weight));
  }

  if (elLiveProtectedFlow) elLiveProtectedFlow.innerText = inferenceEngine.flowHistory.length
    ? inferenceEngine.flowHistory[inferenceEngine.flowHistory.length - 1].toFixed(1)
    : '0.0';
  if (elLiveProtectedPressure) elLiveProtectedPressure.innerText = pressure.toFixed(1);
  if (elLiveBaselineFlow) elLiveBaselineFlow.innerText = rawFlow.toFixed(1);
  if (elLiveBaselinePressure) elLiveBaselinePressure.innerText = baselinePressure.toFixed(1);

  const labels = inferenceEngine.timeHistory.map(t => `${t}s`);
  baselineFlowHistory.push(parseFloat(rawFlow.toFixed(1)));
  baselinePressureHistory.push(parseFloat(baselinePressure.toFixed(1)));
  if (baselineFlowHistory.length > 120) baselineFlowHistory.shift();
  if (baselinePressureHistory.length > 120) baselinePressureHistory.shift();

  vimsChartProtected.data.labels = labels;
  vimsChartProtected.data.datasets[0].data = inferenceEngine.flowHistory;
  vimsChartProtected.data.datasets[1].data = inferenceEngine.pressureHistory;
  vimsChartProtected.update('none');

  vimsChartBaseline.data.labels = labels;
  vimsChartBaseline.data.datasets[0].data = baselineFlowHistory;
  vimsChartBaseline.data.datasets[1].data = baselinePressureHistory;
  vimsChartBaseline.update('none');

  // DES chart: rolling window matching timeHistory length
  const len = inferenceEngine.timeHistory.length;
  desProtectionHistory.push({ raw: desFatigueRaw, prot: desFatigue });
  if (desProtectionHistory.length > 120) desProtectionHistory.shift();
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

// Update charts every second
setInterval(() => {
  if (chartsInited) updateCharts();
}, 1000);
