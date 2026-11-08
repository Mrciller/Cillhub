// Uptime & Latency Monitor UI script
let ctx = null;
let currentEndpoints = [];
let currentIncidents = [];
let canManage = false;

const bannerEl = document.getElementById('status-banner');
const overallTextEl = document.getElementById('overall-status-text');
const lastUpdatedEl = document.getElementById('last-updated-text');
const checkNowBtn = document.getElementById('btn-check-now');
const noticeEl = document.getElementById('notice-msg');
const endpointsListEl = document.getElementById('endpoints-list');
const incidentsListEl = document.getElementById('incidents-list');
const incidentsBadgeEl = document.getElementById('incidents-badge');
const adminHeaderBtns = document.getElementById('admin-header-btns');

// Modals
const modalAdd = document.getElementById('modal-add');
const btnOpenAdd = document.getElementById('btn-open-add');
const btnCloseAdd = document.getElementById('btn-close-add');
const btnCancelAdd = document.getElementById('btn-cancel-add');
const btnSaveAdd = document.getElementById('btn-save-add');
const inputEpName = document.getElementById('input-ep-name');
const inputEpUrl = document.getElementById('input-ep-url');

const modalInc = document.getElementById('modal-incident');
const btnOpenInc = document.getElementById('btn-open-incident');
const btnCloseInc = document.getElementById('btn-close-inc');
const btnCancelInc = document.getElementById('btn-cancel-inc');
const btnSaveInc = document.getElementById('btn-save-inc');
const inputIncTitle = document.getElementById('input-inc-title');
const selectIncStatus = document.getElementById('select-inc-status');
const selectIncEndpoint = document.getElementById('select-inc-endpoint');
const inputIncMsg = document.getElementById('input-inc-msg');

function showNotice(text, isError = false) {
  if (!text) {
    noticeEl.hidden = true;
    noticeEl.textContent = '';
    return;
  }
  noticeEl.hidden = false;
  noticeEl.textContent = text;
  noticeEl.classList.toggle('error', isError);
  if (!isError) {
    setTimeout(() => { noticeEl.hidden = true; }, 5000);
  }
}

function updateBanner(statusText) {
  bannerEl.classList.remove('operational', 'degraded', 'outage');
  const iconEl = bannerEl.querySelector('.banner-icon');

  if (statusText === 'All Systems Operational') {
    bannerEl.classList.add('operational');
    overallTextEl.textContent = 'All Systems Operational';
    iconEl.textContent = '✔';
  } else if (statusText === 'Degraded Performance') {
    bannerEl.classList.add('degraded');
    overallTextEl.textContent = 'Degraded Performance Detected';
    iconEl.textContent = '⚠';
  } else {
    bannerEl.classList.add('outage');
    overallTextEl.textContent = 'Service Disruption / Outage';
    iconEl.textContent = '✕';
  }
  lastUpdatedEl.textContent = `Last checked: ${new Date().toLocaleTimeString()}`;
}

function renderSparkline(history) {
  if (!history || history.length < 2) return '';
  const latencies = history.map(h => h.latency || 0);
  const min = Math.min(...latencies);
  const max = Math.max(...latencies, min + 1);
  const w = 300;
  const h = 34;
  const pts = latencies.map((val, idx) => {
    const x = (idx / (latencies.length - 1)) * w;
    const y = h - ((val - min) / (max - min)) * (h - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polyPts = `0,${h} ${pts.join(' ')} ${w},${h}`;
  return `
    <div class="sparkline-container" title="30-sample latency sparkline (${min}ms - ${max}ms)">
      <svg class="sparkline-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <polygon fill="var(--accent-glow)" points="${polyPts}" />
        <polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${pts.join(' ')}" />
      </svg>
    </div>
  `;
}

function render() {
  adminHeaderBtns.hidden = !canManage;

  // Populate endpoint dropdown in incident modal
  selectIncEndpoint.replaceChildren();
  const defOpt = document.createElement('option');
  defOpt.value = '';
  defOpt.textContent = 'All / General Infrastructure';
  selectIncEndpoint.append(defOpt);
  for (const ep of currentEndpoints) {
    const opt = document.createElement('option');
    opt.value = ep.id;
    opt.textContent = ep.name;
    selectIncEndpoint.append(opt);
  }

  // Render Service Cards
  endpointsListEl.replaceChildren();
  if (currentEndpoints.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-incidents';
    empty.textContent = 'No endpoints currently monitored.';
    endpointsListEl.append(empty);
  } else {
    for (const ep of currentEndpoints) {
      const card = document.createElement('div');
      card.className = 'service-card';

      // Header
      const header = document.createElement('div');
      header.className = 'service-header';

      const info = document.createElement('div');
      info.className = 'service-info';
      const nameEl = document.createElement('span');
      nameEl.className = 'service-name';
      nameEl.textContent = ep.name;
      const urlEl = document.createElement('span');
      urlEl.className = 'service-url';
      urlEl.textContent = ep.url;
      info.append(nameEl, urlEl);

      const stPill = document.createElement('div');
      const stClass = (ep.current_status || 'UP').toLowerCase();
      stPill.className = `status-pill ${stClass}`;
      const dot = document.createElement('span');
      dot.className = 'dot';
      stPill.append(dot, document.createTextNode(` ${ep.current_status || 'UP'}`));

      header.append(info, stPill);

      // Stats
      const statsGrid = document.createElement('div');
      statsGrid.className = 'service-stats-grid';
      const latestLatency = ep.history && ep.history.length > 0 ? ep.history[ep.history.length - 1].latency : ep.avg_latency;

      statsGrid.innerHTML = `
        <div class="stat-item">
          <span class="stat-label">Response Time</span>
          <span class="stat-val">${latestLatency} ms</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Uptime (30 checks)</span>
          <span class="stat-val">${ep.uptime_pct}%</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">p95 Latency</span>
          <span class="stat-val">${ep.p95_latency} ms</span>
        </div>
      `;

      // 30-sample Rolling Timeline
      const timelineSec = document.createElement('div');
      timelineSec.className = 'timeline-section';

      const labels = document.createElement('div');
      labels.className = 'timeline-labels';
      labels.innerHTML = `<span>30 checks ago</span><span>Overall: <strong>${ep.uptime_pct}%</strong></span><span>Now</span>`;

      const bars = document.createElement('div');
      bars.className = 'bars-container';
      bars.setAttribute('role', 'group');
      bars.setAttribute('aria-label', `30-check uptime history for ${ep.name}`);

      const samples = ep.history || [];
      for (const s of samples) {
        const bar = document.createElement('div');
        const sClass = (s.status || 'UP').toLowerCase();
        bar.className = `timeline-bar ${sClass}`;
        const timeStr = new Date(s.timestamp).toLocaleTimeString();
        bar.title = `${timeStr} — ${s.status} (${s.latency}ms, HTTP ${s.code || 'timeout'})`;
        bar.setAttribute('aria-label', bar.title);
        bars.append(bar);
      }
      timelineSec.append(labels, bars);

      // Sparkline
      const sparkContainer = document.createElement('div');
      sparkContainer.innerHTML = renderSparkline(samples);

      card.append(header, statsGrid, timelineSec, sparkContainer);

      if (canManage) {
        const adminBar = document.createElement('div');
        adminBar.style.display = 'flex';
        adminBar.style.justifyContent = 'flex-end';
        adminBar.style.marginTop = '4px';

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn small danger';
        delBtn.textContent = 'Remove';
        delBtn.addEventListener('click', () => deleteEndpoint(ep.id, ep.name));
        adminBar.append(delBtn);
        card.append(adminBar);
      }

      endpointsListEl.append(card);
    }
  }

  // Render Incidents
  const activeCount = currentIncidents.filter(i => i.status !== 'Resolved').length;
  incidentsBadgeEl.textContent = `${activeCount} Active`;

  incidentsListEl.replaceChildren();
  if (currentIncidents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-incidents';
    empty.textContent = 'No incidents reported. All systems healthy.';
    incidentsListEl.append(empty);
  } else {
    for (const inc of currentIncidents) {
      const incCard = document.createElement('div');
      incCard.className = `incident-card ${inc.status === 'Resolved' ? 'resolved' : ''}`;

      const incH = document.createElement('div');
      incH.className = 'incident-header';

      const title = document.createElement('span');
      title.className = 'incident-title';
      title.textContent = inc.title;

      const meta = document.createElement('span');
      meta.className = 'incident-meta';
      meta.textContent = `${new Date(inc.opened_at).toLocaleDateString()} ${new Date(inc.opened_at).toLocaleTimeString()}`;

      incH.append(title, meta);

      const updatesBox = document.createElement('div');
      updatesBox.className = 'incident-updates';

      const updates = inc.updates || [];
      for (const u of updates) {
        const uDiv = document.createElement('div');
        uDiv.className = 'update-entry';
        const uTime = new Date(u.time).toLocaleTimeString();
        uDiv.innerHTML = `<span class="update-status-tag">${u.status}</span> <span class="update-time">(${uTime})</span>: ${u.message}`;
        updatesBox.append(uDiv);
      }

      incCard.append(incH, updatesBox);
      incidentsListEl.append(incCard);
    }
  }
}

async function loadData() {
  try {
    const res = await CillhubPanel.request({ action: 'list' });
    currentEndpoints = res.endpoints || [];
    currentIncidents = res.incidents || [];
    canManage = !!res.can_manage;
    updateBanner(res.system_status || 'All Systems Operational');
    render();
  } catch (err) {
    showNotice(err.message || 'Failed to load status', true);
  }
}

async function triggerHealthCheck() {
  try {
    checkNowBtn.disabled = true;
    showNotice('Checking endpoints...');
    const res = await CillhubPanel.request({ action: 'check_now' });
    currentEndpoints = res.endpoints || [];
    currentIncidents = res.incidents || [];
    canManage = !!res.can_manage;
    updateBanner(res.system_status || 'All Systems Operational');
    render();
    showNotice(res.notice || 'Health checks complete.');
  } catch (err) {
    showNotice(err.message || 'Health check failed', true);
  } finally {
    checkNowBtn.disabled = false;
  }
}

async function deleteEndpoint(id, name) {
  try {
    showNotice(`Removing ${name}...`);
    const res = await CillhubPanel.request({ action: 'delete_endpoint', id });
    currentEndpoints = res.endpoints || [];
    currentIncidents = res.incidents || [];
    canManage = !!res.can_manage;
    updateBanner(res.system_status || 'All Systems Operational');
    render();
    showNotice(res.notice || 'Endpoint removed.');
  } catch (err) {
    showNotice(err.message || 'Failed to remove endpoint', true);
  }
}

async function saveNewEndpoint() {
  const name = inputEpName.value.trim();
  const url = inputEpUrl.value.trim();
  if (!name || !url) {
    showNotice('Please fill out both Name and URL.', true);
    return;
  }
  btnSaveAdd.disabled = true;
  try {
    const res = await CillhubPanel.request({ action: 'add_endpoint', name, url });
    currentEndpoints = res.endpoints || [];
    currentIncidents = res.incidents || [];
    canManage = !!res.can_manage;
    updateBanner(res.system_status || 'All Systems Operational');
    render();
    modalAdd.hidden = true;
    inputEpName.value = '';
    inputEpUrl.value = '';
    showNotice(res.notice || 'Endpoint added successfully.');
  } catch (err) {
    showNotice(err.message || 'Failed to add endpoint', true);
  } finally {
    btnSaveAdd.disabled = false;
  }
}

async function saveNewIncident() {
  const title = inputIncTitle.value.trim();
  const status = selectIncStatus.value;
  const endpoint_id = selectIncEndpoint.value || null;
  const message = inputIncMsg.value.trim();

  if (!title || !message) {
    showNotice('Please provide both Title and Status Message.', true);
    return;
  }

  btnSaveInc.disabled = true;
  try {
    const res = await CillhubPanel.request({
      action: 'post_incident',
      title,
      status,
      endpoint_id,
      message
    });
    currentEndpoints = res.endpoints || [];
    currentIncidents = res.incidents || [];
    canManage = !!res.can_manage;
    updateBanner(res.system_status || 'All Systems Operational');
    render();
    modalInc.hidden = true;
    inputIncTitle.value = '';
    inputIncMsg.value = '';
    showNotice(res.notice || 'Incident published.');
  } catch (err) {
    showNotice(err.message || 'Failed to post incident', true);
  } finally {
    btnSaveInc.disabled = false;
  }
}

// Event Listeners
checkNowBtn.addEventListener('click', triggerHealthCheck);

btnOpenAdd?.addEventListener('click', () => { modalAdd.hidden = false; inputEpName.focus(); });
btnCloseAdd?.addEventListener('click', () => { modalAdd.hidden = true; });
btnCancelAdd?.addEventListener('click', () => { modalAdd.hidden = true; });
btnSaveAdd?.addEventListener('click', saveNewEndpoint);

btnOpenInc?.addEventListener('click', () => { modalInc.hidden = false; inputIncTitle.focus(); });
btnCloseInc?.addEventListener('click', () => { modalInc.hidden = true; });
btnCancelInc?.addEventListener('click', () => { modalInc.hidden = true; });
btnSaveInc?.addEventListener('click', saveNewIncident);

CillhubPanel.onContext((c) => {
  ctx = c;
  document.documentElement.dataset.theme = c.theme;
  document.documentElement.lang = c.locale;
});

CillhubPanel.onEvent((evt) => {
  if (evt?.type === 'status_changed') {
    loadData();
  }
});

CillhubPanel.ready().then(loadData);
