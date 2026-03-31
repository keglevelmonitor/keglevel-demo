/**
 * KegLevel Brain Web — Phase 1 Dashboard
 * Polls /api/state, displays tap cards, simulated pour buttons.
 */

const STORAGE_KEY = 'keglevel_pico_ip';
const STORAGE_KEY_UNITS = 'keglevel_units';
const STORAGE_KEY_CAL_DEDUCT = 'keglevel_cal_deduct';
const LITERS_TO_GAL = 0.264172;
const KG_TO_LB = 2.20462;

/** SRM to hex color map (matches KegLevelPico main_kivy.py) */
const SRM_HEX_MAP = {
  0: '#FFFFFF', 1: '#FFE699', 2: '#FFD878', 3: '#FFCA5A', 4: '#FFBF42', 5: '#FBB123',
  6: '#F8A600', 7: '#F39C00', 8: '#EA8F00', 9: '#E58500', 10: '#DE7C00', 11: '#D77200',
  12: '#CF6900', 13: '#CB6200', 14: '#C35900', 15: '#BB5100', 16: '#B54C00', 17: '#B04500',
  18: '#A63E00', 19: '#A13700', 20: '#9B3200', 21: '#962D00', 22: '#8F2900', 23: '#882300',
  24: '#821E00', 25: '#7B1A00', 26: '#771900', 27: '#701400', 28: '#6A0E00', 29: '#660D00',
  30: '#5E0B00', 31: '#5A0A02', 32: '#600903', 33: '#520907', 34: '#4C0505', 35: '#470606',
  36: '#440607', 37: '#3F0708', 38: '#3B0607', 39: '#3A070B', 40: '#36080A',
};

function getSrmColor(srm) {
  if (srm == null || srm < 0) return '#E5A128'; // default amber
  const val = Math.max(0, Math.min(40, parseInt(srm, 10) || 0));
  return SRM_HEX_MAP[val] || '#E5A128';
}
const POLL_INTERVAL_MS = 1000;
const OFFLINE_AFTER_FAILURES = 3;
const ADJUST_TIMEOUT_MS = 5000;
const ADJUST_RETRIES = 2;

let pollTimer = null;
let connectionState = 'disconnected';
let consecutiveFailures = 0;
let lastData = null;
let simPouringTap = null;
let simPouringClearAt = 0;
let simModeEnabled = true;
let dripInterval = null;
let dripTap = null;
let tempClickCount = 0;
let tempClickWindow = 0;
const RAPID_CLICK_WINDOW_MS = 1500;
const RAPID_CLICK_COUNT = 5;

function getPicoBaseUrl() {
  if (isSelfHosted()) return window.location.origin;
  const ip = document.getElementById('pico-ip').value.trim();
  if (!ip) return null;
  return `http://${ip}`;
}

function isSelfHosted() {
  return true;
}

function saveIp() {
  try {
    const ip = document.getElementById('pico-ip').value.trim();
    if (ip) localStorage.setItem(STORAGE_KEY, ip);
  } catch (_) {}
}

function getUnits() {
  try {
    return localStorage.getItem(STORAGE_KEY_UNITS) || 'metric';
  } catch (_) {
    return 'metric';
  }
}

function setUnits(units) {
  try {
    localStorage.setItem(STORAGE_KEY_UNITS, units);
  } catch (_) {}
}

function formatVolume(liters) {
  const L = parseFloat(liters) || 0;
  if (getUnits() === 'imperial') {
    return (L * LITERS_TO_GAL).toFixed(2) + ' Gal';
  }
  return L.toFixed(2) + ' L';
}

function syncActiveTapsFromData(data) {
  const n = data?.active_taps ?? 5;
  const sel = document.getElementById('active-taps');
  if (sel && n >= 1 && n <= 5) {
    sel.value = String(n);
    sel.disabled = false;
  }
}

function setConnectionState(state) {
  connectionState = state;
  const activeTapsEl = document.getElementById('active-taps');
  if (activeTapsEl) {
    activeTapsEl.disabled = state !== 'connected';
  }
  const el = document.getElementById('status');
  if (el) {
    el.className = 'status ' + state;
    el.textContent = { disconnected: 'Not connected', searching: 'Searching…', connected: 'Connected', offline: 'Offline' }[state] || state;
  }

  const header = document.querySelector('.main-header');
  header.classList.remove('connected', 'offline', 'searching');
  header.classList.add(state);
}

async function fetchState() {
  const base = getPicoBaseUrl();
  if (!base) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${base}/api/state`, { method: 'GET', signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function postAdjust(tapIndex, liters) {
  const base = getPicoBaseUrl();
  if (!base) return false;
  let lastErr = null;
  for (let attempt = 0; attempt <= ADJUST_RETRIES; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ADJUST_TIMEOUT_MS);
      const res = await fetch(`${base}/api/taps/${tapIndex}/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ liters }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.ok) return true;
      lastErr = new Error(res.status);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < ADJUST_RETRIES) await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function getTapDisplayData(i, tap, activeTaps, leakWarnings) {
  const active = i < activeTaps;
  const remaining = parseFloat(tap.remaining_liters ?? 0);
  const maxCapacity = parseFloat(tap.maximum_full_volume_liters ?? 0) || parseFloat(tap.starting_volume_liters ?? 0) || 18.93;
  const percentFull = maxCapacity > 0 ? Math.max(0, Math.min(100, (remaining / maxCapacity) * 100)) : 0;
  const pouring = !!tap.pouring || (i === simPouringTap && Date.now() < simPouringClearAt);
  const hasKeg = !!tap.keg_id;
  const noKeg = !hasKeg;
  const leakWarning = !noKeg && !pouring && leakWarnings && !!leakWarnings[i];
  const abv = parseFloat(tap.abv ?? 0);
  const ibu = tap.ibu != null && tap.ibu !== '' ? parseInt(tap.ibu, 10) : null;
  const statsParts = [];
  if (abv > 0) statsParts.push(`${abv}% ABV`);
  if (ibu != null && ibu !== '') statsParts.push(`${ibu} IBU`);
  return {
    active, percentFull, pouring, hasKeg, noKeg, leakWarning,
    beverageName: tap.beverage_name || (active ? (hasKeg ? 'No beverage' : 'No Keg') : ''),
    tapLabel: tap.tap_label || `Tap ${i + 1}`,
    statsText: hasKeg ? statsParts.join(' \u2022 ') : '',
    statusText: noKeg ? 'Offline' : pouring ? 'Pouring' : leakWarning ? 'Leak?' : 'Idle',
    remainingText: noKeg ? '--' : formatVolume(remaining),
    srmColor: getSrmColor(tap.srm),
    kegLabel: noKeg ? '' : (tap.keg_name || ''),
  };
}

function updateTapCardDOM(card, d) {
  card.className = 'tap-card' + (d.pouring ? ' pouring' : '') + (d.leakWarning ? ' leak' : '') + (d.noKeg ? ' offline' : '');
  card.querySelector('.tap-label').textContent = d.tapLabel;
  card.querySelector('.beverage-name').textContent = d.beverageName;
  card.querySelector('.stats').textContent = d.statsText || '\u00a0';
  const gauge = card.querySelector('.level-gauge');
  gauge.title = `${d.noKeg ? '0' : d.percentFull.toFixed(0)}% remaining`;
  const fill = gauge.querySelector('.level-fill');
  fill.style.height = (d.noKeg ? 0 : d.percentFull) + '%';
  fill.style.background = d.srmColor;
  card.querySelector('.keg-label').textContent = d.kegLabel;
  card.querySelector('.remaining').textContent = d.remainingText;
  const statusEl = card.querySelector('.status');
  const statusClass = d.leakWarning ? 'leak' : d.statusText.toLowerCase();
  statusEl.className = 'status ' + statusClass;
  statusEl.textContent = d.statusText;
  card.querySelectorAll('.pour-btn').forEach((btn) => {
    btn.disabled = !d.active || !d.hasKeg;
  });
}

function renderTapCards(data) {
  const grid = document.getElementById('tap-grid');
  const taps = data.taps || [];
  const activeTaps = data.active_taps ?? 5;
  const leakWarnings = data.leak_warnings || [];
  grid.style.setProperty('--active-taps', String(activeTaps));
  const existing = grid.querySelectorAll('.tap-card');
  const rebuild = existing.length !== activeTaps ||
    grid.dataset.simMode !== String(simModeEnabled);

  if (rebuild) {
    grid.dataset.simMode = String(simModeEnabled);
    grid.innerHTML = '';
    for (let i = 0; i < activeTaps; i++) {
      const d = getTapDisplayData(i, taps[i] || {}, activeTaps, leakWarnings);
      const card = document.createElement('div');
      card.dataset.tapIndex = i;
      const pourHtml = simModeEnabled
        ? `<div class="pour-buttons">
            <button class="pour-btn" data-liters="0.25" ${!d.active || !d.hasKeg ? 'disabled' : ''}>0.25 L</button>
            <button class="pour-btn" data-liters="0.5"  ${!d.active || !d.hasKeg ? 'disabled' : ''}>0.50 L</button>
            <button class="pour-btn drip-btn${dripTap === i ? ' dripping' : ''}" data-tap="${i}" ${!d.active || !d.hasKeg ? 'disabled' : ''}>DRIP</button>
          </div>`
        : '';
      card.innerHTML = `
        <span class="tap-label"></span>
        <span class="beverage-name"></span>
        <span class="stats"></span>
        <div class="level-gauge"><div class="level-fill"></div></div>
        <span class="keg-label"></span>
        <span class="remaining"></span>
        <span class="status"></span>
        ${pourHtml}
      `;
      updateTapCardDOM(card, d);
      grid.appendChild(card);
    }
    return;
  }

  for (let i = 0; i < activeTaps; i++) {
    const d = getTapDisplayData(i, taps[i] || {}, activeTaps, leakWarnings);
    updateTapCardDOM(existing[i], d);
  }
}

function updateHeader(data) {
  const temp = data?.temperature;
  const el = document.getElementById('temp');
  if (!temp || !temp.sensor_available) {
    el.textContent = '';
    return;
  }
  const useMetric = getUnits() === 'metric';
  if (useMetric) {
    const c = typeof temp.celsius === 'number' ? temp.celsius : (temp.fahrenheit - 32) * 5 / 9;
    el.textContent = `${c.toFixed(1)} °C`;
  } else {
    const f = typeof temp.fahrenheit === 'number' ? temp.fahrenheit : (temp.celsius * 9 / 5 + 32);
    el.textContent = `${f.toFixed(1)} °F`;
  }

  document.getElementById('brand').textContent = data?.version ? `KegLevel Brain` : 'KegLevel Brain';
}

async function pollOnce() {
  const base = getPicoBaseUrl();
  if (!base) return;
  const data = await fetchState();
  if (data) {
    consecutiveFailures = 0;
    lastData = data;
    setConnectionState('connected');
    syncActiveTapsFromData(data);
    renderTapCards(data);
    updateHeader(data);
    updateApModeNotice(data);
    if (dripTap !== null && data.leak_warnings && data.leak_warnings[dripTap]) {
      stopDrip();
    }
  } else {
    consecutiveFailures++;
    if (connectionState === 'connected' && consecutiveFailures >= OFFLINE_AFTER_FAILURES) {
      setConnectionState('offline');
    }
  }
}

function pausePolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function resumePolling() {
  if (connectionState === 'disconnected' || pollTimer) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function startDrip(tapIndex) {
  stopDrip();
  dripTap = tapIndex;
  const sendDrip = async () => {
    const base = getPicoBaseUrl();
    if (!base) return;
    try {
      await fetch(`${base}/api/test/drip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tap: dripTap, pulses: 5 }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (_) {}
  };
  sendDrip();
  dripInterval = setInterval(sendDrip, 3000);
  if (lastData) renderTapCards(lastData);
}

function stopDrip() {
  if (dripInterval) {
    clearInterval(dripInterval);
    dripInterval = null;
  }
  dripTap = null;
  if (lastData) renderTapCards(lastData);
}

function initTapGridDelegation() {
  const grid = document.getElementById('tap-grid');
  if (!grid) return;
  grid.addEventListener('click', async (e) => {
    const dripBtn = e.target.closest('.drip-btn');
    if (dripBtn && !dripBtn.disabled) {
      e.stopPropagation();
      const card = dripBtn.closest('.tap-card');
      const i = card ? parseInt(card.dataset.tapIndex, 10) : 0;
      if (dripTap === i) {
        stopDrip();
      } else {
        startDrip(i);
      }
      return;
    }
    const pourBtn = e.target.closest('.pour-btn');
    if (pourBtn && !pourBtn.disabled) {
      e.stopPropagation();
      const card = pourBtn.closest('.tap-card');
      const i = card ? parseInt(card.dataset.tapIndex, 10) : 0;
      const liters = parseFloat(pourBtn.dataset.liters);
      pourBtn.disabled = true;
      simPouringTap = i;
      simPouringClearAt = Date.now() + 60000;
      if (lastData) renderTapCards(lastData);
      pausePolling();
      const ok = await postAdjust(i, liters);
      await pollOnce();
      if (ok && lastData) {
        simPouringTap = i;
        simPouringClearAt = Date.now() + 1500;
        renderTapCards(lastData);
        setTimeout(() => {
          simPouringTap = null;
          pollOnce();
        }, 1500);
      } else {
        simPouringTap = null;
        if (lastData) renderTapCards(lastData);
      }
      resumePolling();
      pourBtn.disabled = false;
      return;
    }
    const card = e.target.closest('.tap-card');
    if (card && !e.target.closest('.pour-buttons')) {
      const i = parseInt(card.dataset.tapIndex, 10);
      openTapSelector(i);
    }
  });
}

function startPolling() {
  stopPolling();
  consecutiveFailures = 0;
  setConnectionState('searching');
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function stopPolling() {
  pausePolling();
  setConnectionState('disconnected');
  document.getElementById('tap-grid').innerHTML = '';
  document.getElementById('temp').textContent = '';
  const activeTapsEl = document.getElementById('active-taps');
  if (activeTapsEl) activeTapsEl.disabled = true;
}

function onConnect() {
  saveIp();
  const base = getPicoBaseUrl();
  if (!base) {
    alert('Enter a Pico IP address.');
    return;
  }
  startPolling();
}

// ---------------------------------------------------------------------------
// API helpers (inventory)
// ---------------------------------------------------------------------------

async function apiFetch(path, options = {}) {
  const base = getPicoBaseUrl();
  if (!base) return null;
  try {
    const url = `${base}${path}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    const data = JSON.parse(text);
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  } catch (e) {
    console.error('API error:', e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Screen navigation
// ---------------------------------------------------------------------------

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.add('hidden'));
  const screen = document.getElementById(id);
  if (screen) screen.classList.remove('hidden');
}

function setActiveNav(activeId) {
  document.querySelectorAll('.top-nav .nav-btn').forEach((b) => b.classList.remove('active'));
  const btn = document.getElementById(activeId);
  if (btn) btn.classList.add('active');
}

function showSettingsSubActions(ids) {
  const bar = document.getElementById('settings-sub-actions');
  bar.querySelectorAll('.sub-btn').forEach((el) => el.classList.add('hidden'));
  if (!ids || ids.length === 0) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  });
}

function cleanupSettings() {
  calStopPoll();
  if (calState.standby) {
    apiFetch('/api/calibration/standby', { method: 'POST', body: JSON.stringify({ active: false }) }).catch(() => {});
    calState.standby = false;
  }
  calState.lockedTap = -1;
}

function navigateToDashboard() {
  cleanupSettings();
  showScreen('dashboard-screen');
  setActiveNav('btn-nav-taps');
  resumePolling();
}

function navigateToKegs() {
  cleanupSettings();
  showScreen('kegs-screen');
  setActiveNav('btn-nav-kegs');
  resumePolling();
  refreshKegList();
}

function navigateToBeverages() {
  cleanupSettings();
  showScreen('beverages-screen');
  setActiveNav('btn-nav-beverages');
  resumePolling();
  refreshBeverageList();
}

function navigateToSettings() {
  showScreen('settings-screen');
  setActiveNav('btn-nav-settings');
  setActiveSettingsTab('system');
}

// ---------------------------------------------------------------------------
// Settings: ALERTS, UPDATES, ABOUT, CALIBRATION
// ---------------------------------------------------------------------------

const SUB_ACTION_MAP = {
  system: [],
  alerts: ['settings-alerts-test', 'settings-alerts-save'],
  updates: ['settings-check', 'settings-install', 'settings-restart'],
  about: [],
  calibration: ['settings-cal-save', 'settings-cal-reset', 'settings-cal-default'],
};

function setActiveSettingsTab(tabId) {
  document.querySelectorAll('.settings-tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.settings-pane').forEach((p) => p.classList.remove('active'));
  const btn = document.querySelector(`.settings-tab-btn[data-settings-tab="${tabId}"]`);
  const pane = document.getElementById(`settings-${tabId}`);
  if (btn) btn.classList.add('active');
  if (pane) pane.classList.add('active');
  showSettingsSubActions(SUB_ACTION_MAP[tabId] || []);
  if (tabId === 'calibration') {
    pausePolling();
  } else {
    calStopPoll();
    if (connectionState === 'connected') resumePolling();
  }
  initSettingsTab(tabId);
}

function initSettingsTab(tabId) {
  if (tabId === 'system') loadSystemConfig();
  else if (tabId === 'calibration') initCalibrationTab();
}

async function loadSystemConfig() {
  try {
    const cfg = await apiFetch('/api/config');
    const el = document.getElementById('leak-detection');
    if (el && cfg) el.checked = cfg.leak_detection_enabled !== false;
  } catch (_) {}
}

async function loadAlertsConfig() {
  try {
    const cfg = await apiFetch('/api/alerts/config');
    if (!cfg) return;
    document.getElementById('alerts-frequency').value = cfg.push_enabled
      ? (cfg.push_interval || 'daily')
      : 'none';
    document.getElementById('alerts-api-key').value = cfg.mailgun_api_key === '***' ? '' : (cfg.mailgun_api_key || '');
    document.getElementById('alerts-domain').value = cfg.mailgun_domain || '';
    document.getElementById('alerts-from').value = cfg.from_email || '';
    document.getElementById('alerts-to').value = cfg.to_email || '';
    const lowVol = parseFloat(cfg.low_volume_threshold_liters ?? 0);
    const lowTemp = parseFloat(cfg.low_temp_threshold_f ?? 27);
    const highTemp = parseFloat(cfg.high_temp_threshold_f ?? 200);
    document.getElementById('alerts-low-vol').value = lowVol;
    document.getElementById('alerts-low-temp').value = lowTemp;
    document.getElementById('alerts-high-temp').value = highTemp > 61 ? 0 : highTemp;
    updateAlertsSliderLabels();
  } catch (_) {}
}

function updateAlertsSliderLabels() {
  const useMetric = getUnits() === 'metric';
  const lowVol = parseFloat(document.getElementById('alerts-low-vol').value) || 0;
  const lowTemp = parseFloat(document.getElementById('alerts-low-temp').value) || 27;
  const highTemp = parseFloat(document.getElementById('alerts-high-temp').value) || 0;
  document.getElementById('alerts-low-vol-label').textContent = lowVol <= 0 ? '(OFF)' : useMetric ? `(${lowVol.toFixed(2)} L)` : `(${(lowVol * LITERS_TO_GAL).toFixed(2)} Gal)`;
  document.getElementById('alerts-low-temp-label').textContent = lowTemp <= 27 ? '(OFF)' : useMetric ? `(${(lowTemp - 32) * 5 / 9 | 0} °C)` : `(${lowTemp} °F)`;
  document.getElementById('alerts-high-temp-label').textContent = highTemp < 35 ? '(OFF)' : useMetric ? `(${(highTemp - 32) * 5 / 9 | 0} °C)` : `(${highTemp} °F)`;
}

function setBtnSaving(btn, saving) {
  if (!btn) return;
  if (saving) {
    btn.classList.add('btn-saving');
    btn.disabled = true;
    btn.dataset.originalText = btn.textContent;
    btn.textContent = 'Saving…';
  } else {
    btn.classList.remove('btn-saving');
    btn.disabled = false;
    if (btn.dataset.originalText) btn.textContent = btn.dataset.originalText;
  }
}

async function saveAlertsConfig() {
  const btn = document.getElementById('settings-alerts-save');
  try {
    setBtnSaving(btn, true);
    const freq = document.getElementById('alerts-frequency').value;
    const apiKey = document.getElementById('alerts-api-key').value.trim();
    const lowVol = parseFloat(document.getElementById('alerts-low-vol').value) || 0;
    const lowTemp = parseFloat(document.getElementById('alerts-low-temp').value) || 27;
    const highTempRaw = parseFloat(document.getElementById('alerts-high-temp').value) || 0;
    const highTemp = highTempRaw < 35 ? 200 : highTempRaw;
    const conditionalEnabled = lowVol > 0 || lowTemp > 27 || highTempRaw >= 35;
    const payload = {
      push_enabled: freq !== 'none',
      push_interval: freq === 'none' ? 'daily' : freq,
      mailgun_domain: document.getElementById('alerts-domain').value.trim(),
      from_email: document.getElementById('alerts-from').value.trim(),
      to_email: document.getElementById('alerts-to').value.trim(),
      conditional_enabled: conditionalEnabled,
      low_volume_threshold_liters: lowVol,
      low_temp_threshold_f: lowTemp,
      high_temp_threshold_f: highTemp,
    };
    if (apiKey) payload.mailgun_api_key = apiKey;
    else payload.mailgun_api_key = '***';
    await apiFetch('/api/alerts/config', { method: 'PUT', body: JSON.stringify(payload) });
    alert('Alert settings saved.');
  } catch (e) {
    alert('Failed to save: ' + (e.message || e));
  } finally {
    setBtnSaving(btn, false);
  }
}

async function sendTestAlert() {
  const btn = document.getElementById('settings-alerts-test');
  try {
    setBtnSaving(btn, true);
    await apiFetch('/api/alerts/test', { method: 'POST' });
    alert('Test email sent. Check your inbox.');
  } catch (e) {
    alert('Test failed: ' + (e.message || e) + '\n\nCheck Mailgun API key, domain, and email addresses.');
  } finally {
    setBtnSaving(btn, false);
  }
}

let updatesLog = [];
let updatesFirmwareAvailable = null;
let otaInProgress = false;
let _lastWifiMode = 'sta';

function updateApModeNotice(data) {
  const mode = data?.wifi_mode || 'sta';
  _lastWifiMode = mode;
  const isAp = mode === 'ap';
  const updatesNotice = document.getElementById('ap-updates-notice');
  if (updatesNotice) updatesNotice.classList.toggle('hidden', !isAp);
  const alertsNotice = document.getElementById('ap-alerts-notice');
  if (alertsNotice) alertsNotice.classList.toggle('hidden', !isAp);
  const header = document.querySelector('.main-header');
  if (header) header.classList.toggle('standalone', isAp);
  const btnWifi = document.getElementById('btn-enable-wifi');
  const btnStandalone = document.getElementById('btn-enable-standalone');
  if (btnWifi) btnWifi.disabled = !isAp;
  if (btnStandalone) btnStandalone.disabled = isAp;
}

function appendUpdatesLog(msg) {
  updatesLog.push(msg);
  const el = document.getElementById('updates-log');
  if (el) {
    el.textContent = updatesLog.join('\n');
    el.scrollTop = el.scrollHeight;
  }
}

function setOtaProgress(fraction) {
  const bar = document.getElementById('ota-progress-fill');
  if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
}

function setOtaButtonsDisabled(disabled) {
  const check = document.getElementById('settings-check');
  const install = document.getElementById('settings-install');
  if (check) check.disabled = disabled;
  if (install) install.disabled = disabled;
}

async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return null;
}

function parseVersion(str) {
  const m = (str || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : [0, 0, 0];
}

function versionNewer(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

async function loadUpdatesTab() {
  const base = getPicoBaseUrl();
  document.getElementById('updates-version').textContent = 'Firmware: —';
  document.getElementById('updates-log').textContent = '';
  setOtaProgress(0);
  updatesLog = [];
  updatesFirmwareAvailable = null;
  document.getElementById('settings-install').disabled = true;
  if (base) {
    try {
      const v = await apiFetch('/api/version');
      if (v?.version) {
        document.getElementById('updates-version').textContent = `Firmware: ${v.version}`;
        appendUpdatesLog(`Connected. Pico firmware: ${v.version}`);
      }
    } catch (_) {
      appendUpdatesLog('Could not connect to Pico.');
    }
  } else {
    appendUpdatesLog('Enter Pico IP and connect first.');
  }
}

async function checkUpdates() {
  if (otaInProgress) return;
  if (_lastWifiMode === 'ap') {
    appendUpdatesLog('Firmware updates are not available in Standalone mode.');
    return;
  }
  appendUpdatesLog('Checking for updates...');
  const base = getPicoBaseUrl();
  if (!base) {
    appendUpdatesLog('Not connected.');
    return;
  }
  setOtaButtonsDisabled(true);
  try {
    const vRes = await fetch(base + '/api/version', { signal: AbortSignal.timeout(8000) });
    const vData = vRes.ok ? await vRes.json() : null;
    const currentVer = parseVersion(vData?.version);

    const otaBase = 'https://raw.githubusercontent.com/keglevelmonitor/keglevelpico/main/ota';
    const mRes = await fetch(otaBase + '/manifest.json', {
      signal: AbortSignal.timeout(10000),
    });
    if (!mRes.ok) throw new Error('Failed to download manifest (' + mRes.status + ')');
    const manifest = await mRes.json();
    const latestVer = parseVersion(manifest.version);

    if (latestVer && versionNewer(latestVer, currentVer)) {
      updatesFirmwareAvailable = {
        tag: 'firmware-' + manifest.version,
        version: manifest.version,
        manifest,
        bundleUrl: otaBase + '/bundle.json',
      };
      appendUpdatesLog(`Update available: ${updatesFirmwareAvailable.version}`);
      document.getElementById('settings-install').disabled = false;
    } else {
      appendUpdatesLog('Firmware is up to date.');
    }
  } catch (e) {
    appendUpdatesLog('Error: ' + (e.message || e));
  } finally {
    if (!updatesFirmwareAvailable) {
      setOtaButtonsDisabled(false);
      document.getElementById('settings-install').disabled = true;
    } else {
      setOtaButtonsDisabled(false);
    }
  }
}

function sortOtaFiles(files) {
  const order = (p) => {
    if (p === 'server.py') return 0;
    if (p.startsWith('lib/')) return 1;
    if (p.startsWith('www/')) return 2;
    if (p === 'main.py') return 4;
    return 3;
  };
  return [...files].sort((a, b) => order(a.path) - order(b.path));
}

async function installUpdates() {
  if (!updatesFirmwareAvailable || otaInProgress) return;
  const { manifest, bundleUrl, version } = updatesFirmwareAvailable;
  const base = getPicoBaseUrl();
  if (!base) { appendUpdatesLog('Not connected.'); return; }

  otaInProgress = true;
  setOtaButtonsDisabled(true);
  setOtaProgress(0);

  try {
    appendUpdatesLog(`[OTA] Downloading firmware ${version}...`);
    const bRes = await fetch(bundleUrl, {
      signal: AbortSignal.timeout(30000),
    });
    if (!bRes.ok) throw new Error('Failed to download firmware bundle (' + bRes.status + ')');
    const bundleText = await bRes.text();

    if (manifest.bundle_sha256) {
      appendUpdatesLog('[OTA] Verifying firmware integrity...');
      const got = await sha256Hex(bundleText);
      if (got === null) {
        appendUpdatesLog('[OTA] SHA256 verification skipped (requires HTTPS).');
      } else if (got.toLowerCase() !== manifest.bundle_sha256.toLowerCase()) {
        appendUpdatesLog('[OTA] SHA256 mismatch — aborting. No files were changed.');
        appendUpdatesLog(`  Expected: ${manifest.bundle_sha256.slice(0, 16)}...`);
        appendUpdatesLog(`  Got:      ${got.slice(0, 16)}...`);
        return;
      } else {
        appendUpdatesLog('[OTA] Integrity verified.');
      }
    }

    const bundle = JSON.parse(bundleText);
    const allFiles = sortOtaFiles(bundle.files || []);
    if (allFiles.length === 0) {
      appendUpdatesLog('[OTA] Error: firmware bundle contains no files.');
      return;
    }

    let oldHashes = {};
    try {
      const omRes = await fetch(base + '/api/ota/manifest', { signal: AbortSignal.timeout(5000) });
      if (omRes.ok) {
        const oldManifest = await omRes.json();
        for (const f of (oldManifest.files || [])) {
          oldHashes[f.path] = f.sha256;
        }
      }
    } catch (_) { /* first OTA or endpoint missing — push all */ }

    const newHashes = {};
    for (const f of (manifest.files || [])) {
      newHashes[f.path] = f.sha256;
    }

    const files = allFiles.filter(f => {
      const oldHash = oldHashes[f.path];
      const newHash = newHashes[f.path];
      return !oldHash || !newHash || oldHash !== newHash;
    });

    const skipped = allFiles.length - files.length;
    if (skipped > 0) {
      appendUpdatesLog(`[OTA] ${skipped} file(s) unchanged — skipping.`);
    }

    const OTA_CHUNK = 8192;
    appendUpdatesLog(`[OTA] Pushing ${files.length} file(s) to Pico...`);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const isLast = i === files.length - 1;
      const label = `[OTA] Writing ${f.path} (${i + 1}/${files.length})...`;
      appendUpdatesLog(label);
      setOtaProgress((i + 0.5) / files.length);

      const chunks = [];
      if (f.content.length > OTA_CHUNK) {
        for (let off = 0; off < f.content.length; off += OTA_CHUNK) {
          chunks.push(f.content.substring(off, off + OTA_CHUNK));
        }
      } else {
        chunks.push(f.content);
      }

      if (isLast && chunks.length > 0) {
        const lastIdx = chunks.length - 1;
        for (let c = 0; c < lastIdx; c++) {
          const payload = JSON.stringify({
            filename: f.path, content: chunks[c], append: c > 0, reboot: false,
          });
          const res = await fetch(base + '/api/update', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: payload, signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            appendUpdatesLog(`[OTA] Failed on ${f.path}: ${errBody.error || res.statusText}`);
            return;
          }
        }
        try {
          await fetch(base + '/api/ota/manifest', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(manifest), signal: AbortSignal.timeout(5000),
          });
        } catch (_) { /* non-critical */ }
        const payload = JSON.stringify({
          filename: f.path, content: chunks[lastIdx], append: lastIdx > 0, reboot: true,
        });
        const res = await fetch(base + '/api/update', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: payload, signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          appendUpdatesLog(`[OTA] Failed on ${f.path}: ${errBody.error || res.statusText}`);
          return;
        }
      } else {
        for (let c = 0; c < chunks.length; c++) {
          const payload = JSON.stringify({
            filename: f.path, content: chunks[c], append: c > 0, reboot: false,
          });
          const res = await fetch(base + '/api/update', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: payload, signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) {
            const errBody = await res.json().catch(() => ({}));
            const errMsg = errBody.error || res.statusText;
            if (res.status === 409) {
              appendUpdatesLog('[OTA] A pour is in progress. Wait for it to finish and try again.');
            } else {
              appendUpdatesLog(`[OTA] Failed on ${f.path}: ${errMsg}`);
            }
            return;
          }
        }
      }
      setOtaProgress((i + 1) / files.length);
    }

    appendUpdatesLog('[OTA] All files written. Pico is rebooting...');
    await waitForReboot(base, version);

  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      appendUpdatesLog('[OTA] Request timed out. The Pico may be rebooting.');
      await waitForReboot(base, version);
    } else {
      appendUpdatesLog('[OTA] Error: ' + (e.message || e));
    }
  } finally {
    otaInProgress = false;
    setOtaButtonsDisabled(false);
    document.getElementById('settings-install').disabled = true;
  }
}

async function waitForReboot(base, expectedVersion) {
  appendUpdatesLog('[OTA] Waiting for Pico to come back online...');
  const maxAttempts = 10;
  const delayMs = 3000;
  await new Promise(r => setTimeout(r, 4000));
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(base + '/api/version', { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        const newVer = data.version || '?';
        document.getElementById('updates-version').textContent = `Firmware: ${newVer}`;
        appendUpdatesLog(`[OTA] Pico is back online. Firmware: ${newVer}`);
        if (expectedVersion && newVer === expectedVersion) {
          appendUpdatesLog('[OTA] Update complete!');
        } else {
          appendUpdatesLog(`[OTA] Version mismatch: expected ${expectedVersion}, got ${newVer}.`);
        }
        updatesFirmwareAvailable = null;
        return;
      }
    } catch (_) { /* still rebooting */ }
    if (i < maxAttempts - 1) {
      appendUpdatesLog(`[OTA] Retrying... (${i + 2}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  appendUpdatesLog('[OTA] Pico did not respond after reboot. Check it manually.');
}

function reloadPage() {
  window.location.href = window.location.pathname + '?_=' + Date.now();
}

// ---------------------------------------------------------------------------
// Calibration — refactored single-source-of-truth module
// ---------------------------------------------------------------------------

const calState = {
  standby: false,
  selectedTap: -1,
  lockedTap: -1,
  wrongPourTap: -1,
  pulses: 0,
  currentK: 2900,
  pourKFactor: null,
  simLock: false,
  continuousTap: -1,
  continuousAbort: false,
  deductInventory: true,
  pollTimer: null,
};

const DEFAULT_K = 2900;
let _calPolling = false;

function calLoadDeduct() {
  try {
    const v = localStorage.getItem(STORAGE_KEY_CAL_DEDUCT);
    return v === null ? true : v === 'true';
  } catch (_) {
    return true;
  }
}
function calSaveDeduct(v) {
  try {
    localStorage.setItem(STORAGE_KEY_CAL_DEDUCT, v ? 'true' : 'false');
  } catch (_) {}
}

function calGetVolLiters() {
  const val = parseFloat(document.getElementById('cal-vol-slider')?.value) || 0;
  return val / 1000;
}

function calSetReady() {
  calState.selectedTap = -1;
  calState.lockedTap = -1;
  calState.wrongPourTap = -1;
  calState.pulses = 0;
  calState.simLock = false;
  calState.continuousTap = -1;
  calState.continuousAbort = true;
  calState.currentK = DEFAULT_K;
  calState.pourKFactor = null;
  calSetMeasuredVolumeDefault();
  calRender();
}

function calSetMeasuredVolumeDefault() {
  const el = document.getElementById('cal-vol-slider');
  if (el) {
    el.min = 0;
    el.max = 1000;
    el.step = 10;
    el.value = 500;
  }
  calUpdateVolumeDisplay();
}

function calUpdateVolumeDisplay() {
  const val = parseFloat(document.getElementById('cal-vol-slider')?.value) || 0;
  const el = document.getElementById('cal-vol-display');
  if (el) el.textContent = `${val} mL`;
}

function calRender() {
  const s = calState;
  const activeTaps = lastData?.active_taps ?? 5;

  document.querySelectorAll('.cal-tap-btn').forEach((b) => {
    const i = parseInt(b.dataset.tapIndex, 10);
    b.classList.remove('active', 'pouring', 'wrong-pour');
    if (s.lockedTap >= 0) {
      if (i === s.lockedTap) b.classList.add('active');
    } else if (s.selectedTap >= 0 && i === s.selectedTap) {
      b.classList.add('active');
    }
    if (s.continuousTap === i) b.classList.add('pouring');
    if (s.wrongPourTap === i) b.classList.add('wrong-pour');
  });

  document.getElementById('cal-pulses').textContent = String(s.pulses);
  document.getElementById('cal-current-k').textContent =
    (s.selectedTap >= 0 || s.lockedTap >= 0) && s.currentK != null
      ? String(Math.round(s.currentK))
      : '—';

  const volL = calGetVolLiters();
  const newK = volL > 0 && s.pulses > 0 ? Math.max(100, Math.round(s.pulses / volL)) : DEFAULT_K;
  const kInput = document.getElementById('cal-k-input');
  const calTap = s.lockedTap >= 0 ? s.lockedTap : s.selectedTap;
  if (kInput && document.activeElement !== kInput) {
    if (s.lockedTap >= 0) {
      kInput.value = newK;
    } else if (s.selectedTap >= 0 && s.currentK != null) {
      kInput.value = Math.round(s.currentK);
    } else {
      kInput.value = '';
    }
    kInput.disabled = calTap < 0;
  }

  const instructions = document.getElementById('cal-instructions');
  if (s.lockedTap >= 0) {
    instructions.textContent = `Tap ${s.lockedTap + 1} locked. SAVE the calibration, RESET the pulses to zero, or SET the calibration factor to the default.`;
  } else if (s.continuousTap >= 0) {
    instructions.textContent = 'Pouring…';
  } else if (s.wrongPourTap >= 0) {
    instructions.textContent = 'Pour only from the selected tap, or select a different tap.';
  } else if (s.selectedTap >= 0) {
    instructions.textContent = 'Pour from the selected tap to calibrate, or enter a K-factor and SAVE.';
  } else {
    instructions.textContent = 'Select a tap for calibration. Pour only from that tap.';
  }

  document.getElementById('settings-cal-default').disabled = calTap < 0;
  document.getElementById('settings-cal-save').disabled = calTap < 0;
}

function initCalibrationTab() {
  const activeTaps = lastData?.active_taps ?? 5;
  const container = document.getElementById('cal-tap-buttons');
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < activeTaps; i++) {
    const col = document.createElement('div');
    col.className = 'cal-tap-column';
    col.dataset.tapIndex = i;
    const tapBtn = document.createElement('button');
    tapBtn.type = 'button';
    tapBtn.className = 'cal-tap-btn';
    tapBtn.textContent = `TAP ${i + 1}`;
    tapBtn.dataset.tapIndex = i;
    col.appendChild(tapBtn);
    const simDiv = document.createElement('div');
    simDiv.className = 'cal-sim-buttons' + (simModeEnabled ? '' : ' hidden');
    const pintLiters = 0.5;
    const pintBtn = document.createElement('button');
    pintBtn.type = 'button';
    pintBtn.className = 'cal-pour-btn cal-pour-pint';
    pintBtn.textContent = 'PINT (0.5 L)';
    pintBtn.dataset.liters = pintLiters;
    pintBtn.dataset.tapIndex = i;
    const contBtn = document.createElement('button');
    contBtn.type = 'button';
    contBtn.className = 'cal-pour-btn cal-pour-continuous';
    contBtn.textContent = 'CONTINUOUS';
    contBtn.dataset.tapIndex = i;
    simDiv.appendChild(pintBtn);
    simDiv.appendChild(contBtn);
    col.appendChild(simDiv);
    container.appendChild(col);
  }

  if (!calState.standby) {
    document.getElementById('cal-instructions').textContent = 'Entering standby...';
    calStartStandby();
  }
  calState.deductInventory = calLoadDeduct();
  const deductEl = document.getElementById('cal-deduct-inventory');
  if (deductEl) deductEl.checked = calState.deductInventory;
  if (calState.selectedTap < 0 && calState.lockedTap < 0) {
    calSetReady();
  } else {
    calRender();
  }
}

async function calSelectTap(i) {
  if (calState.lockedTap >= 0) return;
  calState.selectedTap = i;
  calState.wrongPourTap = -1;
  calState.currentK = null;
  calState.pourKFactor = null;
  calSetMeasuredVolumeDefault();
  calRender();

  try {
    const cfg = await apiFetch('/api/config');
    const kf = cfg?.k_factors || [DEFAULT_K, DEFAULT_K, DEFAULT_K, DEFAULT_K, DEFAULT_K];
    const k = kf[i] ?? DEFAULT_K;
    calState.currentK = k;
    calState.pourKFactor = k;
  } catch (_) {
    calState.currentK = DEFAULT_K;
    calState.pourKFactor = DEFAULT_K;
  }
  calRender();
}

async function calPour(tapIndex, liters, continuous) {
  const ti = typeof tapIndex === 'number' ? tapIndex : parseInt(tapIndex, 10) || 0;

  if (ti !== calState.selectedTap) {
    calState.wrongPourTap = ti;
    calRender();
    return;
  }

  const base = getPicoBaseUrl();
  if (!base) {
    alert('Connect to Pico first (enter IP and click Connect).');
    return;
  }

  const currentK = calState.pourKFactor ?? calState.currentK ?? DEFAULT_K;
  if (calState.pourKFactor == null && calState.currentK == null) {
    alert('Tap data is still loading. Wait a moment and try again.');
    return;
  }
  calState.simLock = true;
  if (!continuous) {
    calState.pulses = Math.round(liters * currentK);
    calState.lockedTap = ti;
    calRender();
  }

  const btn = document.querySelector(`.cal-tap-btn[data-tap-index="${ti}"]`);
  if (btn && continuous) btn.classList.add('pouring');

  try {
    if (continuous) {
      if (calState.continuousTap === ti) {
        calState.continuousAbort = true;
        calState.continuousTap = -1;
        if (btn) btn.classList.remove('pouring');
        calState.simLock = false;
        calRender();
        return;
      }
      calState.continuousTap = ti;
      calState.continuousAbort = false;
      let totalLiters = 0;
      const perStep = liters / 15;
      for (let j = 0; j < 15; j++) {
        if (calState.continuousAbort) break;
        const ok = await postAdjust(ti, perStep);
        if (!ok) throw new Error('Adjust failed');
        totalLiters += perStep;
        calState.pulses = Math.round(totalLiters * currentK);
        calRender();
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (btn) btn.classList.remove('pouring');
      calState.continuousTap = -1;
      if (totalLiters > 0) {
        calState.pulses = Math.round(totalLiters * currentK);
        calState.lockedTap = ti;
      }
    } else {
      const ok = await postAdjust(ti, liters);
      if (!ok) throw new Error('Adjust failed');
    }
  } catch (e) {
    calState.simLock = false;
    calState.lockedTap = -1;
    calState.pulses = 0;
    calState.continuousTap = -1;
    if (btn) btn.classList.remove('pouring');
    alert('Simulated pour failed: ' + (e?.message || e));
    calRender();
    return;
  }

  if (btn && !continuous) setTimeout(() => btn.classList.remove('pouring'), 600);
  calRender();
}

function updateCalSimButtonsVisibility() {
  document.querySelectorAll('.cal-sim-buttons').forEach((el) => {
    el.classList.toggle('hidden', !simModeEnabled);
  });
}

async function calStartStandby() {
  try {
    await apiFetch('/api/calibration/standby', { method: 'POST', body: JSON.stringify({ active: true }) });
    calState.standby = true;
    document.getElementById('cal-instructions').textContent = 'Select a tap for calibration. Pour only from that tap.';
    calStartPoll();
  } catch (e) {
    document.getElementById('cal-instructions').textContent = 'Failed to start standby: ' + (e?.message || e);
  }
}

function calStartPoll() {
  if (calState.pollTimer) return;
  calState.pollTimer = setInterval(calPollTick, 500);
}

function calStopPoll() {
  if (calState.pollTimer) {
    clearInterval(calState.pollTimer);
    calState.pollTimer = null;
  }
}

async function calPollTick() {
  if (_calPolling) return;
  _calPolling = true;
  try {
    if (calState.simLock) {
      calRender();
      return;
    }
    const data = await fetchState();
    if (calState.simLock) {
      calRender();
      return;
    }
    if (!data?.calibration) return;
    const c = data.calibration;
    calState.pulses = c.pulses ?? 0;
    const locked = c.locked_tap ?? -1;

    if (locked >= 0 && calState.lockedTap !== locked) {
      if (locked === calState.selectedTap) {
        calState.lockedTap = locked;
        try {
          const cfg = await apiFetch('/api/config');
          const kf = cfg?.k_factors || [DEFAULT_K, DEFAULT_K, DEFAULT_K, DEFAULT_K, DEFAULT_K];
          calState.currentK = kf[locked] ?? DEFAULT_K;
        } catch (_) {}
      } else {
        await apiFetch('/api/calibration/reset', { method: 'POST' });
        calState.pulses = 0;
        calState.wrongPourTap = locked;
        calState.lockedTap = -1;
      }
    } else if (locked < 0) {
      calState.wrongPourTap = -1;
    }
    calRender();
  } catch (_) {
  } finally {
    _calPolling = false;
  }
}

async function resetCalibration() {
  try {
    await apiFetch('/api/calibration/reset', { method: 'POST' });
  } catch (_) {}
  calSetReady();
}

async function setCalToDefault() {
  const calTap = calState.lockedTap >= 0 ? calState.lockedTap : calState.selectedTap;
  if (calTap < 0) return;
  try {
    const cfg = await apiFetch('/api/config');
    const kf = [...(cfg?.k_factors || [DEFAULT_K, DEFAULT_K, DEFAULT_K, DEFAULT_K, DEFAULT_K])];
    kf[calTap] = DEFAULT_K;
    await apiFetch('/api/config', { method: 'PUT', body: JSON.stringify({ k_factors: kf }) });
    await apiFetch('/api/calibration/reset', { method: 'POST' });
    calSetReady();
  } catch (e) {
    alert('Failed to set default: ' + (e?.message || e));
  }
}

async function saveCalibration() {
  const calTap = calState.lockedTap >= 0 ? calState.lockedTap : calState.selectedTap;
  if (calTap < 0) return;
  const btn = document.getElementById('settings-cal-save');
  try {
    setBtnSaving(btn, true);
    calState.simLock = false;
    const kVal = Math.max(100, parseInt(document.getElementById('cal-k-input')?.value, 10) || DEFAULT_K);
    const cfg = await apiFetch('/api/config');
    const kf = [...(cfg?.k_factors || [DEFAULT_K, DEFAULT_K, DEFAULT_K, DEFAULT_K, DEFAULT_K])];
    kf[calTap] = kVal;
    await apiFetch('/api/config', { method: 'PUT', body: JSON.stringify({ k_factors: kf }) });
    calState.deductInventory = document.getElementById('cal-deduct-inventory')?.checked ?? true;
    calSaveDeduct(calState.deductInventory);
    await apiFetch('/api/calibration/reset', { method: 'POST' });
    calSetReady();
    initCalibrationTab();
  } catch (e) {
    alert('Failed to save: ' + (e?.message || e));
  } finally {
    setBtnSaving(btn, false);
  }
}

// ---------------------------------------------------------------------------
// Inventory: Kegs & Beverages
// ---------------------------------------------------------------------------


async function refreshKegList() {
  const list = document.getElementById('keg-list');
  if (!list) return;
  try {
    const [kegs, beverages] = await Promise.all([
      apiFetch('/api/kegs'),
      apiFetch('/api/beverages'),
    ]);
    const bevMap = {};
    (beverages || []).forEach((b) => { bevMap[b.id] = b.name; });
    kegs.sort((a, b) => (a.title || a.name || '').localeCompare(b.title || b.name || ''));
    list.innerHTML = kegs.map((k) => {
      const contents = k.beverage_id ? (bevMap[k.beverage_id] || k.beverage_name || '—') : '—';
      const tapIdx = parseInt(k.tap_index, 10);
      const tapLabel = tapIdx >= 0 && tapIdx <= 4 ? `Tap ${tapIdx + 1}` : '—';
      return `
        <div class="list-row list-row-keg" data-keg-id="${k.id}">
          <span class="row-name">${escapeHtml(k.title || k.name || 'Unknown')}</span>
          <span class="row-meta">${escapeHtml(contents)}</span>
          <span class="row-meta">${escapeHtml(tapLabel)}</span>
          <div class="row-actions">
            <button class="btn-edit" data-keg-id="${k.id}">Edit</button>
            <button class="btn-delete" data-keg-id="${k.id}">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    list.innerHTML = `<p class="list-error">Failed to load kegs: ${e.message}</p>`;
  }
}

async function refreshBeverageList() {
  const list = document.getElementById('beverage-list');
  if (!list) return;
  try {
    const beverages = await apiFetch('/api/beverages');
    (beverages || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    list.innerHTML = (beverages || []).map((b) => {
      const abv = b.abv != null && b.abv !== '' ? b.abv : '—';
      const ibu = b.ibu != null && b.ibu !== '' ? b.ibu : '—';
      const srm = b.srm != null ? b.srm : '—';
      return `
        <div class="list-row list-row-bev" data-bev-id="${b.id}">
          <span class="row-name">${escapeHtml(b.name || 'Unknown')}</span>
          <span class="row-meta">${abv}</span>
          <span class="row-meta">${ibu}</span>
          <span class="row-meta">${srm}</span>
          <div class="row-actions">
            <button class="btn-edit" data-bev-id="${b.id}">Edit</button>
            <button class="btn-delete" data-bev-id="${b.id}">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    list.innerHTML = `<p class="list-error">Failed to load beverages: ${e.message}</p>`;
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s ?? '');
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Keg modal
// ---------------------------------------------------------------------------

const DENSITY_SG = 1.014;

function updateKegVolumeAtFill() {
  const imperial = getUnits() === 'imperial';
  const tareRaw = parseFloat(document.getElementById('keg-tare').value) || 0;
  const totalRaw = parseFloat(document.getElementById('keg-total-weight').value) || 0;
  const tare = imperial ? tareRaw / KG_TO_LB : tareRaw;
  const total = imperial ? totalRaw / KG_TO_LB : totalRaw;
  const liquidKg = Math.max(0, total - tare);
  const volLiters = liquidKg / DENSITY_SG;
  document.getElementById('keg-volume-at-fill').textContent = formatVolume(volLiters);
}

async function openKegEdit(kegId) {
  const modal = document.getElementById('modal-keg');
  const title = document.getElementById('modal-keg-title');
  const form = document.getElementById('form-keg');
  const idInput = document.getElementById('keg-id');
  const beverageSelect = document.getElementById('keg-beverage');
  const maxCapInput = document.getElementById('keg-max-capacity');
  const tareInput = document.getElementById('keg-tare');
  const totalInput = document.getElementById('keg-total-weight');
  const tapSelect = document.getElementById('keg-tap');

  modal.classList.remove('hidden');
  setModalLoading(modal, true);
  title.textContent = kegId ? 'Edit Keg' : 'Add Keg';

  try {
  const [beverages, kegs, kegData] = await Promise.all([
    apiFetch('/api/beverages'),
    apiFetch('/api/kegs'),
    kegId ? apiFetch(`/api/kegs/${kegId}`) : Promise.resolve(null),
  ]);
  beverageSelect.innerHTML = '<option value="">— None —</option>' +
    (beverages || []).map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');

  const tapByKeg = {};
  (kegs || []).forEach((k) => {
    const ti = parseInt(k.tap_index, 10);
    if (ti >= 0 && ti <= 4) tapByKeg[ti] = k;
  });
  tapSelect.innerHTML =
    '<option value="-1">Unassigned</option>' +
    [0, 1, 2, 3, 4]
      .map((i) => {
        const occupant = tapByKeg[i];
        const inUseByOther = occupant && occupant.id !== kegId;
        const label = `Tap ${i + 1}` + (inUseByOther ? ` (${occupant.title || occupant.name || 'in use'})` : '');
        return `<option value="${i}"${inUseByOther ? ' disabled' : ''}>${escapeHtml(label)}</option>`;
      })
      .join('');

  const nameReadonly = document.getElementById('keg-name-readonly');
  const useImperial = getUnits() === 'imperial';
  const capUnitSpan = document.getElementById('max-cap-unit');
  if (capUnitSpan) capUnitSpan.textContent = useImperial ? 'Gal' : 'L';
  const tareUnitSpan = document.getElementById('tare-unit');
  const totalWeightUnitSpan = document.getElementById('total-weight-unit');
  const wLabel = useImperial ? 'lb' : 'kg';
  if (tareUnitSpan) tareUnitSpan.textContent = wLabel;
  if (totalWeightUnitSpan) totalWeightUnitSpan.textContent = wLabel;
  if (kegId && kegData) {
    const keg = kegData;
    idInput.value = keg.id;
    nameReadonly.textContent = keg.name || keg.title || 'Unknown';
    beverageSelect.value = keg.beverage_id || '';
    let maxCapL = keg.maximum_full_volume_liters ?? 19;
    let tare = keg.tare_weight_kg ?? 4.5;
    let total = keg.starting_total_weight_kg ?? keg.tare_weight_kg;
    if (total == null || total === 0) {
      total = (keg.starting_volume_liters ?? 18.9) * DENSITY_SG + tare;
    }
    maxCapInput.value = useImperial
      ? (maxCapL * LITERS_TO_GAL).toFixed(2)
      : roundToOneDecimal(maxCapL);
    tareInput.value = useImperial
      ? (tare * KG_TO_LB).toFixed(1)
      : roundToOneDecimal(tare);
    totalInput.value = useImperial
      ? (total * KG_TO_LB).toFixed(1)
      : roundToOneDecimal(total);
    tapSelect.value = String(keg.tap_index ?? -1);
  } else {
    idInput.value = '';
    form.reset();
    nameReadonly.textContent = '';
    beverageSelect.value = '';
    maxCapInput.value = useImperial ? (19 * LITERS_TO_GAL).toFixed(2) : '19';
    tareInput.value = useImperial ? (4.5 * KG_TO_LB).toFixed(1) : '4.5';
    totalInput.value = useImperial ? (23.5 * KG_TO_LB).toFixed(1) : '23.5';
    tapSelect.value = '-1';
  }
  updateKegVolumeAtFill();
  } finally {
    setModalLoading(modal, false);
  }
}

function setModalLoading(modal, loading) {
  if (!modal) return;
  const content = modal.querySelector('.modal-content');
  if (content) content.classList.toggle('modal-loading', !!loading);
}

function closeKegModal() {
  document.getElementById('modal-keg').classList.add('hidden');
}

function roundToOneDecimal(val) {
  const n = parseFloat(val);
  if (Number.isNaN(n)) return '18.9';
  return (Math.round(n * 10) / 10).toFixed(1);
}

async function saveKeg(e) {
  e.preventDefault();
  const saveBtn = document.getElementById('form-keg')?.querySelector('.btn-save');
  setBtnSaving(saveBtn, true);
  const idInput = document.getElementById('keg-id');
  const kegId = idInput.value;
  const nameReadonly = document.getElementById('keg-name-readonly');
  const kegName = nameReadonly.textContent.trim() || 'New Keg';
  const beverageSelect = document.getElementById('keg-beverage');
  const imperial = getUnits() === 'imperial';
  const maxCapRaw = parseFloat(document.getElementById('keg-max-capacity').value) || 19;
  const maxCap = imperial ? maxCapRaw / LITERS_TO_GAL : maxCapRaw;
  const tareRaw = parseFloat(roundToOneDecimal(document.getElementById('keg-tare').value)) || 4.5;
  const totalRaw = parseFloat(roundToOneDecimal(document.getElementById('keg-total-weight').value)) || 23.5;
  const tare = imperial ? tareRaw / KG_TO_LB : tareRaw;
  const total = imperial ? totalRaw / KG_TO_LB : totalRaw;
  const tapSelect = document.getElementById('keg-tap');

  const beverageId = beverageSelect.value || '';
  const beverages = await apiFetch('/api/beverages');
  const bev = (beverages || []).find((b) => b.id === beverageId);
  const beverageName = bev ? bev.name : '';
  const style = bev ? (bev.style || '') : '';
  const abv = bev && bev.abv != null && bev.abv !== '' ? parseFloat(bev.abv) : 0;

  const liquidKg = Math.max(0, total - tare);
  const startingVolumeLiters = liquidKg / DENSITY_SG;

  const payload = {
    beverage_id: beverageId,
    beverage_name: beverageName,
    style,
    abv,
    maximum_full_volume_liters: parseFloat(maxCap) || 19,
    tare_weight_kg: tare,
    starting_total_weight_kg: total,
    starting_volume_liters: startingVolumeLiters,
  };
  if (!kegId) {
    payload.name = kegName || 'New Keg';
    payload.title = kegName || 'New Keg';
  }

  let created = null;
  try {
    if (kegId) {
      await apiFetch(`/api/kegs/${kegId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      created = await apiFetch('/api/kegs', { method: 'POST', body: JSON.stringify(payload) });
      payload.id = created.id;
    }
    const newTapIdx = parseInt(tapSelect.value, 10);
    const currentKeg = kegId ? await apiFetch(`/api/kegs/${kegId}`) : { tap_index: -1 };
    const oldTapIdx = parseInt(currentKeg.tap_index, 10) || -1;

    const resolvedKegId = kegId || (created && created.id);
    if (newTapIdx >= 0 && newTapIdx <= 4 && resolvedKegId) {
      await apiFetch(`/api/taps/${newTapIdx}`, {
        method: 'PUT',
        body: JSON.stringify({ keg_id: resolvedKegId }),
      });
    } else if (oldTapIdx >= 0 && oldTapIdx <= 4) {
      await apiFetch(`/api/taps/${oldTapIdx}`, {
        method: 'PUT',
        body: JSON.stringify({ keg_id: '' }),
      });
    }
    closeKegModal();
    refreshKegList();
    if (lastData) { lastData = null; pollOnce(); }
  } catch (err) {
    alert('Failed to save keg: ' + err.message);
  } finally {
    setBtnSaving(saveBtn, false);
  }
}

// ---------------------------------------------------------------------------
// Beverage modal
// ---------------------------------------------------------------------------

function updateBeverageSrmSwatch() {
  const srmInput = document.getElementById('bev-srm');
  const swatch = document.getElementById('bev-srm-swatch');
  if (!srmInput || !swatch) return;
  const srm = parseInt(srmInput.value, 10);
  const hex = getSrmColor(Number.isNaN(srm) ? null : srm);
  swatch.style.background = hex;
}

async function openBeverageEdit(bevId) {
  const modal = document.getElementById('modal-beverage');
  const title = document.getElementById('modal-beverage-title');
  const form = document.getElementById('form-beverage');
  const idInput = document.getElementById('bev-id');
  const nameInput = document.getElementById('bev-name');
  const abvInput = document.getElementById('bev-abv');
  const ibuInput = document.getElementById('bev-ibu');
  const srmInput = document.getElementById('bev-srm');

  modal.classList.remove('hidden');
  setModalLoading(modal, true);
  title.textContent = bevId ? 'Edit Beverage' : 'Add Beverage';

  try {
    if (bevId) {
      const bev = await apiFetch(`/api/beverages/${bevId}`);
      idInput.value = bev.id;
      nameInput.value = bev.name || '';
      abvInput.value = bev.abv != null && bev.abv !== '' ? bev.abv : '';
      ibuInput.value = bev.ibu != null && bev.ibu !== '' ? bev.ibu : '';
      srmInput.value = bev.srm != null && bev.srm !== '' ? bev.srm : '';
    } else {
      idInput.value = '';
      form.reset();
      nameInput.value = '';
      abvInput.value = '';
      ibuInput.value = '';
      srmInput.value = '';
    }
    updateBeverageSrmSwatch();
  } finally {
    setModalLoading(modal, false);
  }
}

function closeBeverageModal() {
  document.getElementById('modal-beverage').classList.add('hidden');
}

async function saveBeverage(e) {
  e.preventDefault();
  const saveBtn = document.getElementById('form-beverage')?.querySelector('.btn-save');
  setBtnSaving(saveBtn, true);
  const idInput = document.getElementById('bev-id');
  const nameInput = document.getElementById('bev-name');
  const abvInput = document.getElementById('bev-abv');
  const ibuInput = document.getElementById('bev-ibu');
  const srmInput = document.getElementById('bev-srm');

  const srmVal = srmInput.value ? parseInt(srmInput.value, 10) : null;
  const payload = {
    name: nameInput.value.trim() || 'New Beverage',
    style: '',
    abv: abvInput.value ? parseFloat(abvInput.value) : '',
    ibu: ibuInput.value ? parseInt(ibuInput.value, 10) : '',
    srm: srmVal != null && !Number.isNaN(srmVal) ? srmVal : null,
  };

  try {
    if (idInput.value) {
      await apiFetch(`/api/beverages/${idInput.value}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await apiFetch('/api/beverages', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeBeverageModal();
    refreshBeverageList();
    refreshKegList();
    if (lastData) { lastData = null; pollOnce(); }
  } catch (err) {
    alert('Failed to save beverage: ' + err.message);
  } finally {
    setBtnSaving(saveBtn, false);
  }
}

// ---------------------------------------------------------------------------
// Tap selector (Select Keg for Tap)
// ---------------------------------------------------------------------------

const KEG_KICKED_ID = '_keg_kicked_calibrate';
const KEG_MARK_EMPTY_ID = '_keg_mark_empty';
const TAP_OFFLINE_ID = '_tap_offline';

let tapSelectorTapIndex = null;

async function openTapSelector(tapIndex) {
  tapSelectorTapIndex = tapIndex;
  const modal = document.getElementById('modal-tap-select');
  const title = document.getElementById('tap-select-title');
  const list = document.getElementById('tap-select-list');

  modal.classList.remove('hidden');
  setModalLoading(modal, true);
  title.textContent = `Select Keg for Tap ${tapIndex + 1}`;
  list.innerHTML = '<p class="tap-select-loading">Loading…</p>';

  try {
  const [state, taps, kegs, beverages] = await Promise.all([
    apiFetch('/api/state'),
    apiFetch('/api/taps'),
    apiFetch('/api/kegs'),
    apiFetch('/api/beverages'),
  ]);

  const tapState = state?.taps?.[tapIndex] || {};
  const currentKegId = tapState.keg_id || taps?.[tapIndex]?.keg_id || '';

  const rows = [];

  if (currentKegId) {
    rows.push({ id: KEG_KICKED_ID, text: '[ Keg Kicked - Calibrate ]', system: true });
    rows.push({ id: KEG_MARK_EMPTY_ID, text: '[ Keg Kicked - Mark Empty ]', system: true });
  }
  rows.push({ id: TAP_OFFLINE_ID, text: '[ Tap Offline ]', system: true });

  const bevMap = {};
  (beverages || []).forEach((b) => { bevMap[b.id] = b.name; });

  (kegs || [])
    .sort((a, b) => (a.title || a.name || '').localeCompare(b.title || b.name || ''))
    .forEach((keg) => {
      const rawIdx = parseInt(keg.tap_index, 10);
      const kegTapIdx = Number.isNaN(rawIdx) ? -1 : rawIdx;
      const unassigned = kegTapIdx === -1;
      const onThisTap = kegTapIdx === tapIndex;
      if (unassigned || onThisTap) {
        const bName = keg.beverage_id ? (bevMap[keg.beverage_id] || keg.beverage_name || '—') : '—';
        let rem;
        if (onThisTap && state?.taps?.[tapIndex]) {
          rem = parseFloat(state.taps[tapIndex].remaining_liters ?? 0);
        } else {
          const start = parseFloat(keg.starting_volume_liters ?? 0);
          const disp = parseFloat(keg.current_dispensed_liters ?? 0);
          rem = start - disp;
        }
        rows.push({ id: keg.id, text: `${keg.title || keg.name} (${bName}) - ${formatVolume(rem)}`, system: false });
      }
    });

  list.innerHTML = rows
    .map(
      (r) =>
        `<button type="button" class="tap-select-row ${r.system ? 'tap-select-system' : ''}" data-id="${r.id}">${escapeHtml(r.text)}</button>`
    )
    .join('');
  } finally {
    setModalLoading(modal, false);
  }
}

function closeTapSelector() {
  document.getElementById('modal-tap-select').classList.add('hidden');
  tapSelectorTapIndex = null;
}

async function selectKegForTap(tapIndex, kegId, modal) {
  if (kegId === KEG_KICKED_ID) {
    modal.classList.add('hidden');
    openCalibrateModal(tapIndex);
    return;
  }
  if (kegId === KEG_MARK_EMPTY_ID) {
    modal.classList.add('hidden');
    openMarkEmptyModal(tapIndex);
    return;
  }
  if (kegId === TAP_OFFLINE_ID) {
    modal.classList.add('hidden');
    await assignKegToTap(tapIndex, '');
    pollOnce();
    return;
  }

  modal.classList.add('hidden');
  await assignKegToTap(tapIndex, kegId);
  pollOnce();
}

async function assignKegToTap(tapIndex, kegId) {
  try {
    await apiFetch(`/api/taps/${tapIndex}`, {
      method: 'PUT',
      body: JSON.stringify({ keg_id: kegId || '' }),
    });
    if (lastData) { lastData = null; pollOnce(); }
  } catch (e) {
    alert('Failed to assign: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Calibrate (Keg Kicked)
// ---------------------------------------------------------------------------

let calibrateTapIndex = null;
let calibrateKegId = null;

async function openCalibrateModal(tapIndex) {
  calibrateTapIndex = tapIndex;
  const modal = document.getElementById('modal-calibrate');
  modal.classList.remove('hidden');
  setModalLoading(modal, true);
  document.getElementById('calibrate-title').textContent = 'Loading…';

  try {
    const [state, config, kegs] = await Promise.all([
      apiFetch('/api/state'),
      apiFetch('/api/config'),
      apiFetch('/api/kegs'),
    ]);

    const tapData = state?.taps?.[tapIndex] || {};
    const kegId = tapData.keg_id;
    const keg = (kegs || []).find((k) => k.id === kegId);
    if (!keg) {
      modal.classList.add('hidden');
      alert('No keg assigned to this tap.');
      return;
    }

    calibrateKegId = kegId;
    const startVol = parseFloat(keg.starting_volume_liters ?? keg.calculated_starting_volume_liters ?? 0);
    const lifetimePulses = tapData.lifetime_pulses ?? 0;
    const kFactors = config?.k_factors ?? [2900, 2900, 2900, 2900, 2900];
    const oldK = kFactors[tapIndex] ?? 2900;
    const newK = startVol > 0 && lifetimePulses > 0 ? lifetimePulses / startVol : 0;

    document.getElementById('calibrate-title').textContent = `Calibration Data for ${keg.title || keg.name}`;
    document.getElementById('cal-start-vol').textContent = formatVolume(startVol);
    document.getElementById('cal-total-pulses').textContent = String(lifetimePulses);
    document.getElementById('cal-old-k').textContent = oldK.toFixed(2);
    document.getElementById('cal-new-k').textContent = newK.toFixed(2);
    document.getElementById('cal-confirm-chk').checked = false;

    const saveBtn = document.getElementById('cal-save');
    saveBtn.disabled = !(newK > 0);
  } catch (e) {
    modal.classList.add('hidden');
    alert('Failed to load calibration data: ' + e.message);
  } finally {
    setModalLoading(modal, false);
  }
}

async function commitCalibration() {
  if (!document.getElementById('cal-confirm-chk').checked) {
    alert('Please confirm the keg is empty.');
    return;
  }
  const newK = parseFloat(document.getElementById('cal-new-k').textContent);
  if (!newK || newK <= 0) return;

  try {
    const config = await apiFetch('/api/config');
    const kFactors = [...(config?.k_factors ?? [2900, 2900, 2900, 2900, 2900])];
    kFactors[calibrateTapIndex] = newK;
    await apiFetch('/api/config', { method: 'PUT', body: JSON.stringify({ k_factors: kFactors }) });

    await assignKegToTap(calibrateTapIndex, '');
    await zeroKegOnPico(calibrateKegId);

    document.getElementById('modal-calibrate').classList.add('hidden');
    if (lastData) { lastData = null; pollOnce(); }
  } catch (e) {
    alert('Failed to save calibration: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Mark Empty
// ---------------------------------------------------------------------------

let markEmptyTapIndex = null;
let markEmptyKegId = null;

async function openMarkEmptyModal(tapIndex) {
  markEmptyTapIndex = tapIndex;
  const modal = document.getElementById('modal-mark-empty');
  modal.classList.remove('hidden');
  setModalLoading(modal, true);
  document.getElementById('mark-empty-keg-name').textContent = 'Loading…';

  try {
    const [state, kegs] = await Promise.all([
      apiFetch('/api/state'),
      apiFetch('/api/kegs'),
    ]);
    const tapData = state?.taps?.[tapIndex] || {};
    const kegId = tapData.keg_id;
    const keg = (kegs || []).find((k) => k.id === kegId);
    if (!keg) {
      alert('No keg assigned to this tap.');
      return;
    }

    markEmptyKegId = kegId;
    document.getElementById('mark-empty-keg-name').textContent = keg.title || keg.name;
  } catch (e) {
    modal.classList.add('hidden');
    alert('Failed to load: ' + e.message);
  } finally {
    setModalLoading(modal, false);
  }
}

async function commitMarkEmpty() {
  try {
    await assignKegToTap(markEmptyTapIndex, '');
    await zeroKegOnPico(markEmptyKegId);
    document.getElementById('modal-mark-empty').classList.add('hidden');
    if (lastData) { lastData = null; pollOnce(); }
  } catch (e) {
    alert('Failed to mark empty: ' + e.message);
  }
}

async function zeroKegOnPico(kegId) {
  await apiFetch(`/api/kegs/${kegId}`, {
    method: 'PUT',
    body: JSON.stringify({
      beverage_id: '',
      beverage_name: '',
      fill_date: '',
      current_dispensed_liters: 0,
      total_dispensed_pulses: 0,
      starting_total_weight_kg: 0,
      starting_volume_liters: 0,
    }),
  });
}

// ---------------------------------------------------------------------------
// Delete confirmation
// ---------------------------------------------------------------------------

let pendingDelete = null;

function confirmDeleteKeg(kegId) {
  pendingDelete = { type: 'keg', id: kegId };
  document.getElementById('modal-confirm-text').textContent =
    `Delete keg "${kegId}"? Any tap assignment will be removed.`;
  document.getElementById('modal-confirm').classList.remove('hidden');
}

async function confirmDeleteBeverage(bevId) {
  try {
    const [kegs, beverages] = await Promise.all([
      apiFetch('/api/kegs'),
      apiFetch('/api/beverages'),
    ]);
    const bev = (beverages || []).find(b => b.id === bevId);
    const bevName = bev ? bev.name : bevId;
    const assignedKegs = (kegs || []).filter(k => k.beverage_id === bevId);
    if (assignedKegs.length > 0) {
      const kegNames = assignedKegs.map(k => k.title || k.name || k.id).join(', ');
      document.getElementById('bev-in-use-text').textContent =
        `${bevName} is currently assigned to ${kegNames}. Remove the beverage from ${assignedKegs.length > 1 ? 'those kegs' : 'that keg'} first, or assign a different beverage to ${assignedKegs.length > 1 ? 'them' : 'it'}.`;
      document.getElementById('modal-bev-in-use').classList.remove('hidden');
      return;
    }
    pendingDelete = { type: 'beverage', id: bevId };
    document.getElementById('modal-confirm-text').textContent =
      `Delete beverage "${bevName}"?`;
    document.getElementById('modal-confirm').classList.remove('hidden');
  } catch (_) {
    pendingDelete = { type: 'beverage', id: bevId };
    document.getElementById('modal-confirm-text').textContent =
      `Delete beverage "${bevId}"?`;
    document.getElementById('modal-confirm').classList.remove('hidden');
  }
}

function closeConfirmModal() {
  document.getElementById('modal-confirm').classList.add('hidden');
  pendingDelete = null;
}

async function doConfirmDelete() {
  if (!pendingDelete) return;
  const btn = document.getElementById('btn-confirm-delete');
  try {
    setBtnSaving(btn, true);
    if (pendingDelete.type === 'keg') {
      await apiFetch(`/api/kegs/${pendingDelete.id}`, { method: 'DELETE' });
      refreshKegList();
    } else {
      await apiFetch(`/api/beverages/${pendingDelete.id}`, { method: 'DELETE' });
      refreshBeverageList();
    }
    closeConfirmModal();
    if (lastData) { lastData = null; pollOnce(); }
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  } finally {
    setBtnSaving(btn, false);
  }
}

// ---------------------------------------------------------------------------
// Inventory event listeners
// ---------------------------------------------------------------------------

function initInventory() {
  document.getElementById('keg-list')?.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.btn-delete[data-keg-id]');
    if (delBtn) { confirmDeleteKeg(delBtn.dataset.kegId); return; }
    const row = e.target.closest('.list-row-keg[data-keg-id]');
    if (row) openKegEdit(row.dataset.kegId);
  });
  document.getElementById('beverage-list')?.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.btn-delete[data-bev-id]');
    if (delBtn) { confirmDeleteBeverage(delBtn.dataset.bevId); return; }
    const row = e.target.closest('.list-row-bev[data-bev-id]');
    if (row) openBeverageEdit(row.dataset.bevId);
  });

  document.getElementById('btn-add-keg').addEventListener('click', () => openKegEdit(null));
  document.getElementById('btn-add-beverage').addEventListener('click', () => openBeverageEdit(null));

  document.getElementById('form-keg').addEventListener('submit', saveKeg);
  ['keg-max-capacity', 'keg-tare', 'keg-total-weight'].forEach((id) => {
    const input = document.getElementById(id);
    input.addEventListener('input', () => {
      const val = input.value;
      if (val.includes('.')) {
        const parts = val.split('.');
        if (parts[1] && parts[1].length > 1) {
          input.value = parts[0] + '.' + parts[1].slice(0, 1);
        }
      }
      updateKegVolumeAtFill();
    });
    input.addEventListener('blur', () => {
      input.value = roundToOneDecimal(input.value);
      updateKegVolumeAtFill();
    });
  });
  document.getElementById('modal-keg').querySelectorAll('.btn-cancel').forEach((b) => {
    b.addEventListener('click', closeKegModal);
  });

  document.getElementById('form-beverage').addEventListener('submit', saveBeverage);
  document.getElementById('bev-srm').addEventListener('input', updateBeverageSrmSwatch);
  document.getElementById('modal-beverage').querySelectorAll('.btn-cancel').forEach((b) => {
    b.addEventListener('click', closeBeverageModal);
  });

  document.getElementById('btn-confirm-delete').addEventListener('click', doConfirmDelete);
  document.getElementById('modal-confirm').querySelectorAll('.btn-cancel').forEach((b) => {
    b.addEventListener('click', closeConfirmModal);
  });
  document.getElementById('btn-bev-in-use-ok').addEventListener('click', () => {
    document.getElementById('modal-bev-in-use').classList.add('hidden');
  });


  document.getElementById('tap-select-cancel').addEventListener('click', closeTapSelector);
  document.getElementById('tap-select-list').addEventListener('click', (e) => {
    const row = e.target.closest('.tap-select-row');
    if (row && tapSelectorTapIndex !== null) {
      selectKegForTap(tapSelectorTapIndex, row.dataset.id, document.getElementById('modal-tap-select'));
    }
  });


  document.getElementById('mark-empty-cancel').addEventListener('click', () => {
    document.getElementById('modal-mark-empty').classList.add('hidden');
    openTapSelector(markEmptyTapIndex);
  });
  document.getElementById('mark-empty-confirm').addEventListener('click', commitMarkEmpty);
}

async function putConfig(payload) {
  const base = getPicoBaseUrl();
  if (!base) return false;
  try {
    const res = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initTapGridDelegation();

  document.getElementById('btn-batchflow').addEventListener('click', () => {
    window.open('batchflow.html', '_blank');
  });

  document.getElementById('pico-ip').value = window.location.hostname;
  onConnect();

  const unitsEl = document.getElementById('units');
  const u = getUnits();
  if (unitsEl) {
    unitsEl.value = u;
    unitsEl.addEventListener('change', () => {
      setUnits(unitsEl.value);
      if (lastData) {
        renderTapCards(lastData);
        updateHeader(lastData);
      }
      updateAlertsSliderLabels();
      const imp = unitsEl.value === 'imperial';
      const capUnitSpan = document.getElementById('max-cap-unit');
      if (capUnitSpan) capUnitSpan.textContent = imp ? 'Gal' : 'L';
      const tareUnitSpan = document.getElementById('tare-unit');
      const totalWeightUnitSpan = document.getElementById('total-weight-unit');
      if (tareUnitSpan) tareUnitSpan.textContent = imp ? 'lb' : 'kg';
      if (totalWeightUnitSpan) totalWeightUnitSpan.textContent = imp ? 'lb' : 'kg';
    });
  }
  const leakDetEl = document.getElementById('leak-detection');
  if (leakDetEl) {
    leakDetEl.addEventListener('change', async () => {
      await putConfig({ leak_detection_enabled: leakDetEl.checked });
    });
  }
  const activeTapsEl = document.getElementById('active-taps');
  if (activeTapsEl) {
    activeTapsEl.disabled = true;
    activeTapsEl.addEventListener('change', async () => {
      const n = parseInt(activeTapsEl.value, 10);
      if (connectionState === 'connected' && n >= 1 && n <= 5) {
        const ok = await putConfig({ active_taps: n });
        if (ok && lastData) {
          lastData.active_taps = n;
          renderTapCards(lastData);
        }
      }
    });
  }
  const tempEl = document.getElementById('temp');
  if (tempEl) {
    tempEl.addEventListener('click', () => {
      const now = Date.now();
      if (now - tempClickWindow > RAPID_CLICK_WINDOW_MS) {
        tempClickCount = 0;
        tempClickWindow = now;
      }
      tempClickCount++;
      if (tempClickCount >= RAPID_CLICK_COUNT) {
        simModeEnabled = !simModeEnabled;
        tempClickCount = 0;
        if (lastData) renderTapCards(lastData);
        updateCalSimButtonsVisibility();
      }
    });
  }
  document.getElementById('btn-nav-taps').addEventListener('click', navigateToDashboard);
  document.getElementById('btn-nav-kegs').addEventListener('click', navigateToKegs);
  document.getElementById('btn-nav-beverages').addEventListener('click', navigateToBeverages);
  document.getElementById('btn-nav-settings').addEventListener('click', navigateToSettings);
  document.querySelectorAll('.settings-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => setActiveSettingsTab(btn.dataset.settingsTab));
  });

  document.querySelector('.help-btn').addEventListener('click', () => {
    let anchor = 'toc';
    const activeNav = document.querySelector('.top-nav .nav-btn.active');
    if (activeNav) {
      const id = activeNav.id;
      if (id === 'btn-nav-taps') anchor = 'taps';
      else if (id === 'btn-nav-kegs') anchor = 'kegs';
      else if (id === 'btn-nav-beverages') anchor = 'beverages';
      else if (id === 'btn-nav-settings') {
        const tab = document.querySelector('.settings-tab-btn.active');
        const t = tab ? tab.dataset.settingsTab : '';
        if (t === 'system') anchor = 'system';
        else if (t === 'alerts') anchor = 'notifications';
        else if (t === 'updates') anchor = 'updates';
        else if (t === 'about') anchor = 'about';
        else if (t === 'calibration') anchor = 'calibration';
        else anchor = 'system';
      }
    }
    window.open('help.html#' + anchor, '_blank');
  });

  document.getElementById('settings-cal-default').addEventListener('click', setCalToDefault);
  document.getElementById('settings-cal-reset').addEventListener('click', resetCalibration);
  document.getElementById('settings-cal-save').addEventListener('click', saveCalibration);
  document.getElementById('cal-tap-buttons')?.addEventListener('click', (e) => {
    const tapBtn = e.target.closest('.cal-tap-btn');
    const pourBtn = e.target.closest('.cal-pour-btn');
    if (tapBtn) {
      calSelectTap(parseInt(tapBtn.dataset.tapIndex, 10));
      return;
    }
    if (pourBtn) {
      const ti = parseInt(pourBtn.dataset.tapIndex, 10);
      const liters = pourBtn.classList.contains('cal-pour-continuous') ? 0.25 : parseFloat(pourBtn.dataset.liters) || 0.5;
      const continuous = pourBtn.classList.contains('cal-pour-continuous');
      calPour(ti, liters, continuous);
    }
  });
  document.getElementById('cal-vol-slider').addEventListener('input', () => {
    calUpdateVolumeDisplay();
    calRender();
  });
  document.getElementById('cal-vol-minus').addEventListener('click', () => {
    const el = document.getElementById('cal-vol-slider');
    el.value = Math.max(0, (parseFloat(el.value) || 0) - 10);
    calUpdateVolumeDisplay();
    calRender();
  });
  document.getElementById('cal-vol-plus').addEventListener('click', () => {
    const el = document.getElementById('cal-vol-slider');
    el.value = Math.min(1000, (parseFloat(el.value) || 0) + 10);
    calUpdateVolumeDisplay();
    calRender();
  });
  document.getElementById('cal-cancel').addEventListener('click', () => {
    document.getElementById('modal-calibrate').classList.add('hidden');
    openTapSelector(calibrateTapIndex);
  });
  document.getElementById('cal-save').addEventListener('click', commitCalibration);

  const splashModal = document.getElementById('modal-demo-splash');
  if (splashModal && !sessionStorage.getItem('keglevel_demo_splash_seen')) {
    splashModal.classList.remove('hidden');
    document.getElementById('btn-splash-dismiss').addEventListener('click', () => {
      splashModal.classList.add('hidden');
      sessionStorage.setItem('keglevel_demo_splash_seen', '1');
    });
  } else if (splashModal) {
    splashModal.classList.add('hidden');
  }

  initInventory();
});
