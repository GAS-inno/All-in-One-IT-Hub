'use strict';

const DASHBOARD_FILTERS = [
  { key: 'country', label: 'Country', optionsKey: 'country' },
  { key: 'category', label: 'Category', optionsKey: 'category' },
  { key: 'assetStatus', label: 'Status', optionsKey: 'assetStatus' },
  { key: 'onlineStatus', label: 'Device online status', optionsKey: 'onlineStatus' },
  { key: 'os', label: 'Operating system', optionsKey: 'os' },
  { key: 'manufacturer', label: 'Manufacturer', optionsKey: 'manufacturer' },
  { key: 'warrantyStatus', label: 'Warranty', optionsKey: 'warrantyStatus' }
];

const DASHBOARD_PRIMARY_METRICS = [
  { key: 'totalAssets', label: 'Total assets', note: 'Devices in the current view', tone: 'blue' },
  { key: 'deployedAssets', label: 'Deployed', note: 'Assigned to a user', tone: 'green' },
  { key: 'availableAssets', label: 'Available to deploy', note: 'Deployable and unassigned', tone: 'teal' },
  { key: 'onlineInactive90', label: 'Inactive over 90 days', note: 'Based on last check-in', tone: 'amber' }
];

const DASHBOARD_ATTENTION_METRICS = [
  { key: 'expiredWarranty', label: 'Warranty expired', metric: 'expiredWarranty', tone: 'red' },
  { key: 'warrantyExpiring90Days', label: 'Warranty due within 90 days', metric: 'warrantyExpiring90Days', tone: 'amber' },
  { key: 'missingWarranty', label: 'Missing warranty dates', metric: 'missingWarranty', tone: 'grey' },
  { key: 'missingPrimaryUser', label: 'No assigned user', metric: 'missingPrimaryUser', tone: 'grey' },
  { key: 'duplicateSerialNumbers', label: 'Duplicate serial numbers', metric: 'duplicateSerialNumbers', tone: 'red' },
  { key: 'archivedAssets', label: 'Archived assets', metric: 'archivedAssets', tone: 'grey' }
];

const DASHBOARD_CHARTS = [
  { key: 'assetStatusDistribution', title: 'Status', description: 'Deployment and lifecycle labels', type: 'doughnut' },
  { key: 'onlineStatusDistribution', title: 'Device online status', description: 'Last check-in health', type: 'doughnut' },
  { key: 'warrantyExposure', title: 'Warranty outlook', description: 'Coverage and upcoming renewals', type: 'bar', horizontal: true },
  { key: 'modelDistribution', title: 'Devices by model', description: 'Top 10 models in the current view', type: 'bar', horizontal: true },
  { key: 'assetsByCountry', title: 'Fleet share by country', description: 'Share of devices in the current view', type: 'pie' },
  { key: 'onlineStatusByCountry', title: 'Online status by country', description: 'Compare check-in health across countries', type: 'line' }
];

const DASHBOARD_COLORS = {
  navy: '#183B56', blue: '#3478B8', teal: '#2A9D8F', green: '#438A66', amber: '#D69A32', red: '#C75B5B', grey: '#8996A3',
  series: ['#3478B8', '#438A66', '#D69A32', '#C75B5B', '#8996A3', '#2A9D8F', '#8267A8', '#537D8A']
};

App.registerModule('dashboard', {
  charts: new Map(),
  requestController: null,
  renderController: null,
  renderGeneration: 0,
  filterOptions: {},

  destroy() {
    this.requestController?.abort();
    this.renderController?.abort();
    this.destroyCharts();
  },

  render(container) {
    this.destroyCharts();
    this.requestController?.abort();
    this.renderController?.abort();
    this.renderController = new AbortController();
    const eventSignal = this.renderController.signal;
    const generation = ++this.renderGeneration;
    const page = document.createElement('section');
    page.className = 'enterprise-dashboard';
    page.setAttribute('aria-label', 'IT asset overview');
    page.innerHTML = `
      <header class="dashboard-hero">
        <div class="dashboard-title-block">
          <p class="dashboard-eyebrow">FLEET OVERVIEW</p>
          <h1>Asset overview</h1>
          <p class="dashboard-subtitle">A clear view of device ownership, availability, health, and warranty.</p>
        </div>
        <div class="dashboard-header-actions">
          <p class="dashboard-refresh-time" aria-live="polite">Last updated: Loading</p>
          <button type="button" class="dashboard-button dashboard-button-light" data-dashboard-refresh>Refresh</button>
        </div>
      </header>

      <section class="dashboard-filter-panel" aria-label="Filter the dashboard">
        <div class="dashboard-panel-heading">
          <div><h2>Filter results</h2><p>Choose a value to focus the overview. Counts and charts update together.</p></div>
          <button type="button" class="dashboard-clear-button" data-dashboard-clear>Clear filters</button>
        </div>
        <div class="dashboard-filter-grid" data-dashboard-filters></div>
      </section>

      <div class="dashboard-summary" aria-live="polite">
        <div class="dashboard-summary-item"><span>Assets in this view</span><strong data-summary-assets>—</strong></div>
        <div class="dashboard-summary-item"><span>Unique devices</span><strong data-summary-unique>—</strong></div>
      </div>

      <section aria-labelledby="dashboard-fleet-heading">
        <div class="dashboard-section-heading"><div><h2 id="dashboard-fleet-heading">Fleet at a glance</h2><p>Click a number to open the matching devices in Inventory.</p></div></div>
        <div class="dashboard-kpi-grid" data-primary-metrics></div>
      </section>

      <section aria-labelledby="dashboard-attention-heading">
        <div class="dashboard-section-heading"><div><h2 id="dashboard-attention-heading">Needs attention</h2><p>Review warranty, assignment, data quality, and archived assets.</p></div></div>
        <div class="dashboard-attention-grid" data-attention-metrics></div>
      </section>

      <section aria-labelledby="dashboard-breakdown-heading">
        <div class="dashboard-section-heading"><div><h2 id="dashboard-breakdown-heading">Asset breakdown</h2><p>Use these summaries to understand the shape and readiness of the fleet.</p></div></div>
        <div class="dashboard-chart-grid" data-dashboard-charts></div>
      </section>
      <p class="dashboard-message" role="status" aria-live="polite" hidden></p>`;

    const filterGrid = page.querySelector('[data-dashboard-filters]');
    for (const filter of DASHBOARD_FILTERS) {
      const label = document.createElement('label');
      label.className = 'dashboard-filter';
      label.htmlFor = `dashboard-filter-${filter.key}`;
      const caption = document.createElement('span');
      caption.textContent = filter.label;
      const select = document.createElement('select');
      select.id = `dashboard-filter-${filter.key}`;
      select.dataset.filterKey = filter.key;
      select.setAttribute('aria-label', filter.label);
      const allOption = document.createElement('option');
      allOption.value = '';
      allOption.textContent = `All ${filter.label.toLowerCase()}`;
      select.append(allOption);
      label.append(caption, select);
      filterGrid.append(label);
    }

    const primaryGrid = page.querySelector('[data-primary-metrics]');
    for (const metric of DASHBOARD_PRIMARY_METRICS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `dashboard-kpi tone-${metric.tone}`;
      card.dataset.metric = metric.key;
      card.setAttribute('aria-label', `Open inventory for ${metric.label}`);
      card.innerHTML = `<span class="dashboard-kpi-label">${metric.label}</span><strong class="dashboard-kpi-value">—</strong><span class="dashboard-kpi-note">${metric.note}</span>`;
      primaryGrid.append(card);
    }

    const attentionGrid = page.querySelector('[data-attention-metrics]');
    for (const metric of DASHBOARD_ATTENTION_METRICS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `dashboard-attention-card tone-${metric.tone}`;
      card.dataset.metric = metric.metric;
      card.innerHTML = `<span class="dashboard-attention-value">—</span><span class="dashboard-attention-label">${metric.label}</span><span class="dashboard-attention-link">View devices <span aria-hidden="true">›</span></span>`;
      card.setAttribute('aria-label', `View inventory devices: ${metric.label}`);
      attentionGrid.append(card);
    }

    const chartGrid = page.querySelector('[data-dashboard-charts]');
    for (const chart of DASHBOARD_CHARTS) {
      const panel = document.createElement('article');
      panel.className = 'dashboard-chart-panel';
      panel.innerHTML = `<div class="dashboard-chart-heading"><div><h3>${chart.title}</h3><p>${chart.description}</p></div></div><div class="dashboard-chart-shell skeleton" data-chart-shell="${chart.key}"><canvas role="img" aria-label="${chart.title}"></canvas></div>`;
      chartGrid.append(panel);
    }

    container.replaceChildren(page);
    this.restoreFilters(filterGrid);
    this.populateFilters(filterGrid, generation);
    this.showLoading(page);

    page.querySelector('[data-dashboard-refresh]').addEventListener('click', () => this.load(page, filterGrid, generation), { signal: eventSignal });
    page.querySelector('[data-dashboard-clear]').addEventListener('click', () => {
      for (const select of filterGrid.querySelectorAll('select')) select.value = '';
      this.updateUrl(filterGrid);
      this.load(page, filterGrid, generation);
    }, { signal: eventSignal });
    filterGrid.addEventListener('change', () => {
      this.updateUrl(filterGrid);
      this.load(page, filterGrid, generation);
    }, { signal: eventSignal });
    page.addEventListener('click', (event) => {
      const card = event.target.closest('[data-metric]');
      if (card) this.openMetricRecords(card.dataset.metric, card.querySelector('.dashboard-kpi-label, .dashboard-attention-label')?.textContent || 'Matching assets', filterGrid, page);
    }, { signal: eventSignal });
    window.addEventListener('popstate', () => {
      if (generation !== this.renderGeneration) return;
      this.restoreFilters(filterGrid);
      this.load(page, filterGrid, generation);
    }, { signal: eventSignal });
    this.load(page, filterGrid, generation);
  },

  async populateFilters(filterGrid, generation) {
    try {
      const response = await fetch('/api/bootstrap');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (generation !== this.renderGeneration) return;
      this.filterOptions = result.filterOptions || {};
      for (const filter of DASHBOARD_FILTERS) {
        const select = filterGrid.querySelector(`[data-filter-key="${filter.key}"]`);
        for (const value of this.filterOptions[filter.optionsKey] || []) {
          if ([...select.options].some((option) => option.value === value)) continue;
          const option = document.createElement('option');
          option.value = value;
          option.textContent = value;
          select.append(option);
        }
      }
      this.restoreFilters(filterGrid);
    } catch (error) {
      if (generation !== this.renderGeneration) return;
      this.showMessage(filterGrid.closest('.enterprise-dashboard').querySelector('.dashboard-message'), `Filter choices could not be loaded: ${error.message || error}`, true);
    }
  },

  readFilters(filterGrid) {
    return Object.fromEntries([...filterGrid.querySelectorAll('select')]
      .map((select) => [select.dataset.filterKey, select.value])
      .filter(([, value]) => value));
  },

  updateUrl(filterGrid) {
    const url = new URL(window.location.href);
    for (const filter of DASHBOARD_FILTERS) url.searchParams.delete(filter.key);
    for (const key of ['department', 'status', 'lifecycle', 'plannedAction', 'model']) url.searchParams.delete(key);
    for (const [key, value] of Object.entries(this.readFilters(filterGrid))) url.searchParams.set(key, value);
    history.replaceState(null, '', url);
  },

  restoreFilters(filterGrid) {
    const params = new URLSearchParams(window.location.search);
    for (const filter of DASHBOARD_FILTERS) {
      const value = params.get(filter.key) || '';
      const select = filterGrid.querySelector(`[data-filter-key="${filter.key}"]`);
      if (value && ![...select.options].some((option) => option.value === value)) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        select.append(option);
      }
      select.value = value;
    }
  },

  showLoading(page) {
    for (const value of page.querySelectorAll('.dashboard-kpi-value, .dashboard-attention-value')) value.textContent = '—';
    for (const shell of page.querySelectorAll('.dashboard-chart-shell')) shell.classList.add('skeleton');
    page.querySelector('.dashboard-message').hidden = true;
  },

  showMessage(element, text, isError = false) {
    element.textContent = text;
    element.classList.toggle('is-error', Boolean(isError));
    element.hidden = false;
  },

  async load(page, filterGrid, generation) {
    if (generation !== this.renderGeneration) return;
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    this.showLoading(page);
    const query = new URLSearchParams(this.readFilters(filterGrid));
    try {
      const response = await fetch(`/api/dashboard?${query.toString()}`, { signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (generation !== this.renderGeneration || controller.signal.aborted) return;
      this.renderResult(page, result);
    } catch (error) {
      if (error.name === 'AbortError' || generation !== this.renderGeneration) return;
      this.showMessage(page.querySelector('.dashboard-message'), `Dashboard data could not be loaded. ${error.message || error}`, true);
      for (const shell of page.querySelectorAll('.dashboard-chart-shell')) shell.classList.remove('skeleton');
    }
  },

  renderResult(page, result) {
    const formatNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
    const kpis = result.kpis || {};
    page.querySelector('[data-summary-assets]').textContent = formatNumber.format(result.sourceRecordCount || 0);
    page.querySelector('[data-summary-unique]').textContent = formatNumber.format(result.distinctAssetCount || 0);
    const refreshed = result.refreshedAt ? new Date(result.refreshedAt) : new Date();
    page.querySelector('.dashboard-refresh-time').textContent = `Last updated: ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(refreshed)}`;
    for (const metric of DASHBOARD_PRIMARY_METRICS) {
      page.querySelector(`[data-metric="${metric.key}"] .dashboard-kpi-value`).textContent = formatNumber.format(Number(kpis[metric.key] || 0));
    }
    for (const metric of DASHBOARD_ATTENTION_METRICS) {
      page.querySelector(`[data-metric="${metric.metric}"] .dashboard-attention-value`).textContent = formatNumber.format(Number(kpis[metric.key] || 0));
    }
    this.drawCharts(page, result.charts || {});
    const message = page.querySelector('.dashboard-message');
    if (result.sourceRecordCount === 0) this.showMessage(message, 'No devices match these filters. Clear one or more filters to see the full inventory.', false);
    else message.hidden = true;
  },

  drawCharts(page, chartData) {
    for (const definition of DASHBOARD_CHARTS) {
      const shell = page.querySelector(`[data-chart-shell="${definition.key}"]`);
      shell.classList.remove('skeleton');
      if (typeof Chart === 'undefined') {
        this.showMessage(page.querySelector('.dashboard-message'), 'Charts could not be loaded. Check your internet connection and refresh the dashboard.', true);
        continue;
      }
      this.charts.get(definition.key)?.destroy();
      if (!Object.prototype.hasOwnProperty.call(chartData, definition.key)) {
        shell.innerHTML = '<p class="dashboard-chart-empty">Chart data is unavailable. Restart NexIT and reload the dashboard to update its analytics.</p>';
        this.showMessage(page.querySelector('.dashboard-message'), 'Dashboard charts could not load their data. Restart NexIT, then reload this page.', true);
        continue;
      }
      const data = chartData[definition.key] || { labels: [], data: [] };
      if (!data.labels?.length) {
        shell.innerHTML = '<p class="dashboard-chart-empty">No devices match this chart.</p>';
        continue;
      }
      const chartColors = (data.labels || []).map((label, index) => this.colorForLabel(label, index));
      const config = definition.type === 'doughnut' || definition.type === 'pie'
        ? {
          type: definition.type,
          data: { labels: data.labels || [], datasets: [{ data: data.data || [], backgroundColor: chartColors, borderColor: '#fff', borderWidth: 3, hoverOffset: 3 }] },
          options: { ...this.chartOptions(false), ...(definition.type === 'doughnut' ? { cutout: '66%' } : {}), plugins: { ...this.chartOptions(false).plugins, legend: { position: 'bottom', labels: { usePointStyle: true, padding: 16, boxWidth: 9 } } } }
        }
        : definition.type === 'line'
        ? {
          type: 'line',
          data: {
            labels: data.labels || [],
            datasets: (data.datasets || []).map((series, index) => ({
              label: series.label,
              data: series.data || [],
              borderColor: this.colorForLabel(series.label, index),
              backgroundColor: this.colorForLabel(series.label, index),
              pointRadius: 3,
              pointHoverRadius: 5,
              borderWidth: 2,
              tension: 0.25,
              fill: false
            }))
          },
          options: { ...this.chartOptions(false), interaction: { mode: 'index', intersect: false } }
        }
        : {
          type: 'bar',
          data: { labels: data.labels || [], datasets: [{ data: data.data || [], backgroundColor: chartColors, borderRadius: 5, maxBarThickness: 30 }] },
          options: { ...this.chartOptions(false), indexAxis: definition.horizontal ? 'y' : 'x', plugins: { ...this.chartOptions(false).plugins, legend: { display: false } } }
        };
      this.charts.set(definition.key, new Chart(shell.querySelector('canvas').getContext('2d'), config));
    }
  },

  colorForLabel(label, index) {
    const value = String(label || '').toLowerCase();
    if (value.includes('inactive') || value.includes('expired') || value.includes('repair')) return DASHBOARD_COLORS.red;
    if (value.includes('expir') || value.includes('pending') || value.includes('awaiting')) return DASHBOARD_COLORS.amber;
    if (value.includes('unknown') || value.includes('missing') || value.includes('archived') || value.includes('decommission')) return DASHBOARD_COLORS.grey;
    if (value.includes('active') || value.includes('deployed') || value.includes('covered') || value.includes('ready')) return DASHBOARD_COLORS.green;
    return DASHBOARD_COLORS.series[index % DASHBOARD_COLORS.series.length];
  },

  async openMetricRecords(metric, label, filterGrid, page) {
    try {
      const query = new URLSearchParams({ ...this.readFilters(filterGrid), metric });
      const response = await fetch(`/api/dashboard/records?${query.toString()}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (!Array.isArray(result.recordIndexes) || !Array.isArray(App.store.get('inventory'))) {
        throw new Error('The server returned inventory matches in an unexpected format.');
      }
      App.modules.inventory.showDashboardResults(result.recordIndexes, label);
    } catch (error) {
      this.showMessage(page.querySelector('.dashboard-message'), `Matching devices could not be opened. ${error.message || error}`, true);
    }
  },

  chartOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { usePointStyle: true, padding: 16, color: '#536273', boxWidth: 9 } },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { beginAtZero: true, grid: { display: false }, ticks: { color: '#687786', precision: 0 } },
        y: { beginAtZero: true, grid: { color: '#E8EDF1' }, ticks: { color: '#687786', precision: 0 } }
      }
    };
  },

  destroyCharts() {
    for (const chart of this.charts.values()) chart.destroy();
    this.charts.clear();
  }
});
