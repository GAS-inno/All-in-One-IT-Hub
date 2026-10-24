'use strict';

const DASHBOARD_FILTERS = [
  { key: 'country', label: 'Country' },
  { key: 'department', label: 'Department' },
  { key: 'os', label: 'OS' },
  { key: 'status', label: 'Status' },
  { key: 'lifecycle', label: 'Lifecycle' },
  { key: 'warrantyStatus', label: 'Warranty Status' },
  { key: 'plannedAction', label: 'Planned Action' },
  { key: 'model', label: 'Model' }
];

const DASHBOARD_KPIS = [
  ['totalAssets', 'Total Assets', 'blue'], ['activeAssets', 'Active Assets', 'green'],
  ['inactiveAssets', 'Inactive Assets', 'grey'], ['stock', 'Stock', 'blue'],
  ['retired', 'Retired', 'grey'], ['inService', 'In Service', 'green'],
  ['migrationRequired', 'Migration Required', 'amber'], ['refreshReplace', 'Refresh/Replace', 'amber'],
  ['decommissioned', 'Decommissioned', 'red'], ['expiredWarranty', 'Expired Warranty', 'red'],
  ['warrantyExpiring90Days', 'Warranty Expiring within 90 Days', 'amber'], ['missingWarranty', 'Missing Warranty', 'grey'],
  ['win10', 'Win10', 'amber'], ['win11', 'Win11', 'green'], ['unknownOs', 'Unknown OS', 'grey'],
  ['staleActiveDevices', 'Stale Active Devices', 'red'], ['missingPrimaryUser', 'Missing Primary User', 'grey'],
  ['duplicateSerialNumbers', 'Duplicate Serial Numbers', 'red']
];

const DASHBOARD_CHARTS = [
  ['statusByCountry', 'Assets by country and status', 'stacked'],
  ['lifecycleByCountry', 'Lifecycle by country', 'stacked'],
  ['warrantyByCountry', 'Warranty exposure by country', 'stacked'],
  ['osDistribution', 'OS distribution', 'doughnut'],
  ['refreshReplaceByCountry', 'Refresh/Replace by country', 'horizontal'],
  ['ageBands', 'Asset age bands', 'bar']
];

const DASHBOARD_COLORS = {
  Navy: '#16324F', Blue: '#2563EB', Green: '#15803D', Amber: '#D97706', Red: '#B91C1C', Grey: '#64748B',
  series: ['#15803D', '#2563EB', '#D97706', '#B91C1C', '#64748B', '#16324F']
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
    container.replaceChildren();

    const page = document.createElement('section');
    page.className = 'enterprise-dashboard';
    page.setAttribute('aria-label', 'IT asset dashboard');

    const header = document.createElement('header');
    header.className = 'dashboard-hero';
    const titleBlock = document.createElement('div');
    const title = document.createElement('h1');
    title.textContent = 'IT Asset Intelligence';
    const subtitle = document.createElement('p');
    subtitle.textContent = 'Enterprise device lifecycle, readiness and warranty overview';
    titleBlock.append(title, subtitle);
    const headerActions = document.createElement('div');
    headerActions.className = 'dashboard-header-actions';
    const refreshLabel = document.createElement('p');
    refreshLabel.className = 'dashboard-refresh-time';
    refreshLabel.setAttribute('aria-live', 'polite');
    refreshLabel.textContent = 'Last refresh: Loading';
    const refresh = document.createElement('button');
    refresh.type = 'button'; refresh.className = 'dashboard-button dashboard-button-light'; refresh.textContent = 'Refresh';
    const clear = document.createElement('button');
    clear.type = 'button'; clear.className = 'dashboard-button dashboard-button-outline'; clear.textContent = 'Clear filters';
    headerActions.append(refreshLabel, refresh, clear);
    header.append(titleBlock, headerActions);

    const summary = document.createElement('div');
    summary.className = 'dashboard-summary';
    summary.setAttribute('aria-live', 'polite');
    const sourceCount = this.summaryItem('Source records', 'dashboard-source-records');
    const distinctCount = this.summaryItem('Distinct assets', 'dashboard-distinct-assets');
    summary.append(sourceCount, distinctCount);

    const filterPanel = document.createElement('section');
    filterPanel.className = 'dashboard-filter-panel';
    filterPanel.setAttribute('aria-label', 'Dashboard filters');
    const filterGrid = document.createElement('div');
    filterGrid.className = 'dashboard-filter-grid';
    for (const filter of DASHBOARD_FILTERS) {
      const label = document.createElement('label');
      label.className = 'dashboard-filter';
      label.htmlFor = `dashboard-filter-${filter.key}`;
      const labelText = document.createElement('span'); labelText.textContent = filter.label;
      const select = document.createElement('select');
      select.id = `dashboard-filter-${filter.key}`;
      select.dataset.filterKey = filter.key;
      select.setAttribute('aria-label', filter.label);
      const allOption = document.createElement('option'); allOption.value = ''; allOption.textContent = `All ${filter.label}`;
      select.append(allOption);
      label.append(labelText, select);
      filterGrid.append(label);
    }
    filterPanel.append(filterGrid);

    const kpiHeading = document.createElement('h2'); kpiHeading.className = 'dashboard-section-title'; kpiHeading.textContent = 'Asset KPIs';
    const kpiGrid = document.createElement('div'); kpiGrid.className = 'dashboard-kpi-grid';
    for (const [key, label, tone] of DASHBOARD_KPIS) {
      const card = document.createElement('button'); card.type = 'button'; card.className = `dashboard-kpi tone-${tone}`; card.dataset.kpi = key;
      card.setAttribute('aria-label', `View inventory records for ${label}`);
      const name = document.createElement('h3'); name.textContent = label;
      const value = document.createElement('p'); value.className = 'dashboard-kpi-value'; value.textContent = '—';
      value.setAttribute('aria-label', `${label}: loading`);
      card.append(name, value); kpiGrid.append(card);
    }

    const chartHeading = document.createElement('h2'); chartHeading.className = 'dashboard-section-title'; chartHeading.textContent = 'Fleet analytics';
    const chartGrid = document.createElement('div'); chartGrid.className = 'dashboard-chart-grid';
    for (const [key, label] of DASHBOARD_CHARTS) {
      const panel = document.createElement('section'); panel.className = 'dashboard-chart-panel';
      const heading = document.createElement('h3'); heading.textContent = label;
      const shell = document.createElement('div'); shell.className = 'dashboard-chart-shell skeleton'; shell.dataset.chartShell = key;
      const canvas = document.createElement('canvas'); canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', label);
      shell.append(canvas); panel.append(heading, shell); chartGrid.append(panel);
    }

    const message = document.createElement('p'); message.className = 'dashboard-message'; message.setAttribute('role', 'status'); message.hidden = true;
    page.append(header, summary, filterPanel, kpiHeading, kpiGrid, chartHeading, chartGrid, message);
    container.append(page);
    this.restoreFilters(filterGrid);
    this.populateFilters(filterGrid, generation);
    this.showLoading(page);

    refresh.addEventListener('click', () => this.load(page, filterGrid, generation), { signal: eventSignal });
    clear.addEventListener('click', () => {
      for (const select of filterGrid.querySelectorAll('select')) select.selectedIndex = 0;
      this.updateUrl(filterGrid);
      this.load(page, filterGrid, generation);
    }, { signal: eventSignal });
    filterGrid.addEventListener('change', () => {
      this.updateUrl(filterGrid);
      this.load(page, filterGrid, generation);
    }, { signal: eventSignal });
    kpiGrid.addEventListener('click', (event) => {
      const card = event.target.closest('[data-kpi]');
      if (card) this.openMetricRecords(card.dataset.kpi, card.querySelector('h3').textContent, filterGrid, page);
    }, { signal: eventSignal });
    const popstate = () => {
      if (generation !== this.renderGeneration) return;
      this.restoreFilters(filterGrid);
      this.load(page, filterGrid, generation);
    };
    window.addEventListener('popstate', popstate, { signal: eventSignal });
    this.load(page, filterGrid, generation);
  },

  summaryItem(label, id) {
    const item = document.createElement('div'); item.className = 'dashboard-summary-item';
    const caption = document.createElement('span'); caption.textContent = label;
    const value = document.createElement('strong'); value.id = id; value.textContent = '—';
    item.append(caption, value); return item;
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
        const values = this.filterOptions[filter.key] || [];
        for (const value of values) {
          if ([...select.options].some((option) => option.value === value)) continue;
          const option = document.createElement('option'); option.value = value; option.textContent = value; select.append(option);
        }
      }
      this.restoreFilters(filterGrid);
    } catch (error) {
      if (generation !== this.renderGeneration) return;
      const message = filterGrid.closest('.enterprise-dashboard')?.querySelector('.dashboard-message');
      if (message) this.showMessage(message, `Filter choices could not be loaded: ${error.message || error}`, true);
    }
  },

  readFilters(filterGrid) {
    return Object.fromEntries([...filterGrid.querySelectorAll('select')].map((select) => [select.dataset.filterKey, select.value]).filter(([, value]) => value));
  },

  updateUrl(filterGrid) {
    const url = new URL(window.location.href);
    for (const filter of DASHBOARD_FILTERS) url.searchParams.delete(filter.key);
    for (const [key, value] of Object.entries(this.readFilters(filterGrid))) url.searchParams.set(key, value);
    history.replaceState(null, '', url);
  },

  restoreFilters(filterGrid) {
    const params = new URLSearchParams(window.location.search);
    for (const filter of DASHBOARD_FILTERS) {
      const value = params.get(filter.key) || '';
      const select = filterGrid.querySelector(`[data-filter-key="${filter.key}"]`);
      if (value && ![...select.options].some((option) => option.value === value)) {
        const option = document.createElement('option'); option.value = value; option.textContent = value; select.append(option);
      }
      if (value) select.value = value;
      else select.selectedIndex = 0;
    }
  },

  showLoading(page) {
    for (const value of page.querySelectorAll('.dashboard-kpi-value')) {
      value.textContent = ' '; value.setAttribute('aria-label', 'Loading');
    }
    for (const shell of page.querySelectorAll('.dashboard-chart-shell')) shell.classList.add('skeleton');
    page.querySelector('.dashboard-message').hidden = true;
  },

  showMessage(element, text, isError) {
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
    page.querySelector('#dashboard-source-records').textContent = formatNumber.format(result.sourceRecordCount || 0);
    page.querySelector('#dashboard-distinct-assets').textContent = formatNumber.format(result.distinctAssetCount || 0);
    const refreshed = result.refreshedAt ? new Date(result.refreshedAt) : new Date();
    page.querySelector('.dashboard-refresh-time').textContent = `Last refresh: ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(refreshed)}`;
    for (const [key, label] of DASHBOARD_KPIS) {
      const value = Number(result.kpis?.[key] || 0);
      const element = page.querySelector(`[data-kpi="${key}"] .dashboard-kpi-value`);
      element.textContent = formatNumber.format(value);
      element.setAttribute('aria-label', `${label}: ${formatNumber.format(value)}`);
    }
    this.drawCharts(page, result.charts || {});
    const message = page.querySelector('.dashboard-message');
    if (result.sourceRecordCount === 0) this.showMessage(message, 'No assets match these filters. Try clearing one or more filters.', false);
    else message.hidden = true;
  },

  drawCharts(page, chartData) {
    for (const [key, title, kind] of DASHBOARD_CHARTS) {
      const shell = page.querySelector(`[data-chart-shell="${key}"]`);
      const canvas = shell.querySelector('canvas');
      shell.classList.remove('skeleton');
      if (typeof Chart === 'undefined') {
        this.showMessage(page.querySelector('.dashboard-message'), 'Charts are unavailable because Chart.js could not be loaded. Check your internet connection and reload.', true);
        continue;
      }
      const existing = this.charts.get(key);
      if (existing) existing.destroy();
      const data = chartData[key] || {};
      const chartColors = DASHBOARD_COLORS.series;
      let config;
      if (kind === 'stacked') {
        config = { type: 'bar', data: { labels: data.labels || [], datasets: (data.datasets || []).map((series, index) => ({ label: series.label, data: series.data, backgroundColor: chartColors[index % chartColors.length], borderWidth: 0 })) }, options: this.chartOptions(true) };
        config.options.scales.x.stacked = true; config.options.scales.y.stacked = true;
      } else if (kind === 'doughnut') {
        config = { type: 'doughnut', data: { labels: data.labels || [], datasets: [{ data: data.data || [], backgroundColor: chartColors, borderWidth: 2, borderColor: '#fff' }] }, options: { ...this.chartOptions(false), cutout: '62%' } };
      } else if (kind === 'horizontal') {
        config = { type: 'bar', data: { labels: data.labels || [], datasets: [{ label: 'Refresh/Replace', data: data.data || [], backgroundColor: DASHBOARD_COLORS.Amber, borderRadius: 4 }] }, options: this.chartOptions(false) };
        config.options.indexAxis = 'y';
      } else {
        config = { type: 'bar', data: { labels: data.labels || [], datasets: [{ label: 'Assets', data: data.data || [], backgroundColor: DASHBOARD_COLORS.Blue, borderRadius: 4 }] }, options: this.chartOptions(false) };
      }
      this.charts.set(key, new Chart(canvas.getContext('2d'), config));
    }
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
      this.showMessage(page.querySelector('.dashboard-message'), `Matching inventory records could not be opened. ${error.message || error}`, true);
    }
  },

  chartOptions(stacked) {
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: true, position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, color: DASHBOARD_COLORS.Grey } }, tooltip: { mode: 'index', intersect: false } },
      scales: { x: { stacked, grid: { display: false }, ticks: { color: DASHBOARD_COLORS.Grey, autoSkip: true, maxRotation: 0 } }, y: { stacked, beginAtZero: true, grid: { color: '#E2E8F0' }, ticks: { color: DASHBOARD_COLORS.Grey, precision: 0 } } }
    };
  },

  destroyCharts() {
    for (const chart of this.charts.values()) chart.destroy();
    this.charts.clear();
  }
});
