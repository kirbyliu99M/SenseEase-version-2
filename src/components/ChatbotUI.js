export class ChatbotUI {
  constructor() {
    this.ui = document.createElement('div');
    this.ui.id = 'hp-iq-chatbot';
    this.onComplain = null;
    this.onWeaken   = null;
    this.isCollapsed  = false;
    this.hasWarned    = false;
    this.cooldownUntil = 0;
    this.isTheaterMode = null; // injectable: () => boolean

    this.buildUI();
    document.body.appendChild(this.ui);
  }

  buildUI() {
    this.ui.innerHTML = `
      <div class="chat-header" id="chat-header-toggle">
        <span>HP IQ Feedback</span>
        <div class="chat-header-actions">
          <span id="hp-iq-level" style="font-size:0.75em;color:#000;padding:2px 6px;border-radius:4px;display:none;"></span>
          <span class="chat-collapse-btn" title="Minimize">▼</span>
          <span class="chat-close-btn"    title="Close">✕</span>
        </div>
      </div>
      <div class="chat-body" id="chat-body"></div>
      <div class="chat-input">
        <button id="btn-complain">I feel dizzy / nauseous</button>
        <button id="btn-weaken">Protection too strong — reduce</button>
      </div>
    `;

    // Collapse on header click (but not on the close button)
    this.ui.querySelector('#chat-header-toggle').addEventListener('click', () => {
      this.toggleCollapse();
    });

    // Close (X): hide + set cooldown (30s normal, 60s in theater mode)
    this.ui.querySelector('.chat-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.ui.classList.remove('visible');
      const inTheater = this.isTheaterMode ? this.isTheaterMode() : false;
      this.cooldownUntil = Date.now() + (inTheater ? 60000 : 30000);
    });

    this.ui.querySelector('#btn-complain').addEventListener('click', (e) => {
      e.stopPropagation();
      this.addMessage('User: I feel dizzy / nauseous.', 'user');
      this.addMessage('System: FOV restriction tightened. Pressure threshold lowered.', 'sys');
      if (this.onComplain) this.onComplain();
    });

    this.ui.querySelector('#btn-weaken').addEventListener('click', (e) => {
      e.stopPropagation();
      this.addMessage('User: Protection too strong — please reduce.', 'user');
      this.addMessage('System: FOV radius widened. Intervention intensity reduced.', 'sys');
      if (this.onWeaken) this.onWeaken();
    });
  }

  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
    this.ui.classList.toggle('collapsed', this.isCollapsed);
  }

  /** Show the chatbot panel (called by "Open HP IQ Feedback" button) */
  open() {
    this.ui.classList.add('visible');
    if (this.isCollapsed) this.toggleCollapse(); // auto-expand if minimized
  }

  addMessage(msg, type) {
    const body = this.ui.querySelector('#chat-body');
    const el   = document.createElement('div');
    el.className  = `msg ${type}`;
    el.innerText  = msg;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
  }

  showWarning() {
    if (Date.now() < this.cooldownUntil) return;
    this.open();
    if (!this.hasWarned) {
      this.addMessage('System: High-motion content detected. Need comfort assistance?', 'sys');
      this.hasWarned = true;
    }
  }

  setLevel(level) {
    const badge = this.ui.querySelector('#hp-iq-level');
    if (!badge) return;
    badge.style.display = 'inline-block';
    const colors = ['#00ff88','#aaff00','#ffff00','#ffaa00','#ff4444'];
    badge.innerText       = `Level: ${level}`;
    badge.style.background = colors[level - 1] || colors[0];
  }
}
