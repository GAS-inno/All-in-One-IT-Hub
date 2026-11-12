/**
 * NexIT — Core Application
 * app.js
 *
 * Responsibilities:
 *  - Module routing
 *  - Global state (country filter, modal, toast)
 *  - Shared utilities (storage, file upload, date helpers)
 */

'use strict';

/* ============================================================
   GLOBAL STATE
   ============================================================ */
const App = {
  currentModule: 'dashboard',
  countryFilter: 'all',
  fieldOptions: {},

  // Inventory, warranty, replacement, and checkout histories are persisted by the local SQLite API.
  store: {
    databaseKeys: new Set(['inventory', 'warranty', 'replacementHistory', 'checkoutHistory', 'users', 'statusLabels']),
    cache: new Map(),
    writeQueues: new Map(),
    initialized: false,
    get(key) {
      if (this.databaseKeys.has(key)) return this.cache.get(key) || [];
      try { return JSON.parse(localStorage.getItem('nexit_' + key)) || []; }
      catch (error) {
        console.error(`Could not read browser preference ${key}.`, error);
        Toast.show(`Could not read saved ${key} settings.`, 'warning');
        return [];
      }
    },
    set(key, value) {
      if (!this.databaseKeys.has(key)) {
        localStorage.setItem('nexit_' + key, JSON.stringify(value));
        return Promise.resolve();
      }
      if (!this.initialized) throw new Error('SQLite storage is not initialized. Start the app with server.py.');
      const previousValue = this.cache.get(key);
      this.cache.set(key, value);
      const body = JSON.stringify(value);
      const route = {
        inventory: '/api/inventory',
        warranty: '/api/warranty',
        replacementHistory: '/api/replacement-history',
        checkoutHistory: '/api/checkout-history',
        users: '/api/users',
        statusLabels: '/api/status-labels'
      }[key];
      const previousWrite = this.writeQueues.get(key) || Promise.resolve();
      const write = previousWrite.catch(() => {}).then(async () => {
        const response = await fetch(route, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        return result;
      });
      this.writeQueues.set(key, write);
      write.catch((error) => {
        if (this.cache.get(key) === value) {
          if (previousValue === undefined) this.cache.delete(key);
          else this.cache.set(key, previousValue);
        }
        console.error(`Could not save ${key} to SQLite.`, error);
        Toast.show(`Could not save ${key} to SQLite: ${error.message || error}`, 'error', 6000);
      });
      return write;
    },
    async setPrimaryUserCheckin(inventory, checkoutHistory) {
      await Promise.all([
        this.writeQueues.get('inventory') || Promise.resolve(),
        this.writeQueues.get('checkoutHistory') || Promise.resolve()
      ]);
      const response = await fetch('/api/checkin-primary-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventory, checkoutHistory })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      this.cache.set('inventory', inventory);
      this.cache.set('checkoutHistory', checkoutHistory);
      return result;
    },
    async initialize() {
      const readLegacy = (key) => {
        try {
          const value = JSON.parse(localStorage.getItem(`nexit_${key}`) || '[]');
          return Array.isArray(value) ? value : [];
        } catch (error) {
          console.error(`Could not read legacy ${key} data for SQLite migration.`, error);
          Toast.show(`Could not migrate saved ${key} data because its browser value is invalid JSON.`, 'error', 6000);
          return [];
        }
      };
      const response = await fetch('/api/bootstrap', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventory: readLegacy('inventory'), warranty: readLegacy('warranty') })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (!Array.isArray(result.inventory) || !Array.isArray(result.warranty)
        || !Array.isArray(result.replacementHistory) || !Array.isArray(result.checkoutHistory)
        || !Array.isArray(result.users) || !Array.isArray(result.statusLabels)) {
        throw new Error('SQLite server is out of date. Stop it, restart python3 server.py (or py server.py), then reload this page.');
      }
      this.cache.set('inventory', result.inventory);
      this.cache.set('warranty', result.warranty);
      this.cache.set('replacementHistory', result.replacementHistory);
      this.cache.set('checkoutHistory', result.checkoutHistory);
      this.cache.set('users', result.users);
      this.cache.set('statusLabels', result.statusLabels);
      this.fieldOptions = result.fieldOptions || {};
      this.initialized = true;
      if (result.migrated) Toast.show('Existing browser inventory was copied into the local SQLite database.', 'success', 6000);
    },
    async refreshUsers() {
      const response = await fetch('/api/bootstrap', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (Array.isArray(result.users)) this.cache.set('users', result.users);
      if (result.fieldOptions) this.fieldOptions = result.fieldOptions;
      return result.users || [];
    }
  },

// Module registry — each module must export { init, render, onCountryChange? }
  modules: {},

  registerModule(name, mod) {
    this.modules[name] = mod;
  },

  navigateTo(moduleName) {
    if (!this.modules[moduleName]) { console.warn('Module not found:', moduleName); return; }

    const previousModule = this.modules[this.currentModule];
    if (this.currentModule !== moduleName && typeof previousModule?.destroy === 'function') previousModule.destroy();
    this.currentModule = moduleName;

    // Update nav
    const activeDeviceType = moduleName === 'inventory'
      ? this.modules.inventory?.getDeviceType?.() || ''
      : '';
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle(
        'active',
        el.dataset.module === moduleName
          && (el.dataset.deviceType ? el.dataset.deviceType === activeDeviceType : !activeDeviceType)
      );
    });

    // Update topbar title
    const inventoryTypeLabel = moduleName === 'inventory' ? this.modules.inventory?.getDeviceTypeLabel?.() : '';
    const label = inventoryTypeLabel
      ? `Inventory · ${inventoryTypeLabel}`
      : document.querySelector(`[data-module="${moduleName}"]`)?.textContent.trim() || moduleName;
    document.getElementById('topbarTitle').textContent = label;

    // Render module
    const container = document.getElementById('moduleContainer');
    container.innerHTML = '';
    container.style.animation = 'none';
    container.offsetHeight; // reflow
    container.style.animation = '';
    this.modules[moduleName].render(container, this.countryFilter);
  }
};

/* ============================================================
   MODAL HELPER
   ============================================================ */
const Modal = {
  /**
   * @param {object} opts
   * @param {string}   opts.title
   * @param {string}   opts.body        - HTML string injected into modal body
   * @param {Function} opts.onConfirm   - called when Save/Confirm is clicked
   * @param {Function} [opts.onOpen]    - called synchronously after body is in DOM
   *                                      use this to initialise FileUpload, pickers etc.
   * @param {string}   [opts.confirmText]
   * @param {string}   [opts.size]      - 'lg' for wider modal
   */
  open({ title, body, onConfirm, onOpen, confirmText = 'Save', size }) {
    const modalEl = document.getElementById('globalModal');
    modalEl.style.maxWidth = size === 'lg' ? '720px' : '';

    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = body;

    const confirmBtn = document.getElementById('modalConfirm');
    confirmBtn.textContent = confirmText;
    confirmBtn.className = 'btn btn-primary'; // reset any danger class from previous call

    document.getElementById('modalBackdrop').classList.add('active');

    this._onConfirm = onConfirm;

    // Fire onOpen AFTER body is injected so DOM elements exist
    if (typeof onOpen === 'function') onOpen();
  },
  close() {
    document.getElementById('modalBackdrop').classList.remove('active');
    this._onConfirm = null;
  },
  _onConfirm: null
};

/* ============================================================
   TOAST HELPER
   ============================================================ */
const Toast = {
  show(message, type = 'info', duration = 3000) {
    const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${icons[type] || '•'}</span><span>${message}</span>`;
    document.getElementById('toastContainer').appendChild(el);
    setTimeout(() => el.remove(), duration);
  }
};

/* ============================================================
   FILE UPLOAD HELPER
   ============================================================ */
const FileUpload = {
  /**
   * Renders a file attachment UI inside a container element.
   * @param {HTMLElement} container - where to render
   * @param {Array} files - existing files [{name, size, type, dataUrl}]
   * @param {Function} onChange - callback(updatedFiles)
   */
  render(container, files = [], onChange) {
    const id = 'fu_' + Math.random().toString(36).slice(2);
    container.innerHTML = `
      <div class="file-list" id="${id}_list"></div>
      <div class="upload-zone" id="${id}_zone">
        <div class="upload-zone-icon">⬆</div>
        <div class="upload-zone-text">Drop files here or <u>click to browse</u></div>
        <input type="file" id="${id}_input" multiple style="display:none">
      </div>`;

    const list  = container.querySelector(`#${id}_list`);
    const zone  = container.querySelector(`#${id}_zone`);
    const input = container.querySelector(`#${id}_input`);

    const renderList = () => {
      list.innerHTML = files.map((f, i) => `
        <div class="file-item">
          <span class="file-icon">📄</span>
          <span class="file-name">${f.name}</span>
          <span class="file-size">${this.formatSize(f.size)}</span>
          <button class="file-delete" data-idx="${i}">✕</button>
        </div>`).join('');
      list.querySelectorAll('.file-delete').forEach(btn => {
        btn.onclick = () => { files.splice(+btn.dataset.idx, 1); renderList(); onChange(files); };
      });
    };

    const addFiles = (fileList) => {
      Array.from(fileList).forEach(f => {
        const reader = new FileReader();
        reader.onload = e => {
          files.push({ name: f.name, size: f.size, type: f.type, dataUrl: e.target.result });
          renderList(); onChange(files);
        };
        reader.readAsDataURL(f);
      });
    };

    zone.onclick = () => input.click();
    input.onchange = () => addFiles(input.files);
    zone.ondragover = e => { e.preventDefault(); zone.classList.add('drag-over'); };
    zone.ondragleave = () => zone.classList.remove('drag-over');
    zone.ondrop = e => { e.preventDefault(); zone.classList.remove('drag-over'); addFiles(e.dataTransfer.files); };

    renderList();
  },

  formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }
};

/* ============================================================
   DATE HELPERS
   ============================================================ */
const DateUtil = {
  today() { return new Date().toISOString().slice(0, 10); },
  format(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  },
  daysBetween(d1, d2) {
    return Math.round((new Date(d2) - new Date(d1)) / 86400000);
  },
  daysUntil(dateStr) {
    return this.daysBetween(this.today(), dateStr);
  },
  warrantyStatus(endDate) {
    if (!endDate) return { cls: 'badge-gray', text: 'N/A' };
    const days = this.daysUntil(endDate);
    if (days < 0)   return { cls: 'badge-red',    text: 'Expired' };
    if (days < 90)  return { cls: 'badge-orange',  text: `${days}d left` };
    return             { cls: 'badge-green',  text: `${days}d left` };
  },
  laptopAge(purchaseDate) {
    if (!purchaseDate) return '—';
    const years = ((new Date() - new Date(purchaseDate)) / 31536000000).toFixed(1);
    return `${years} yrs`;
  },
  weekLabel() {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay() + 1);
    const end = new Date(start); end.setDate(start.getDate() + 6);
    return `Week of ${start.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} – ${end.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`;
  }
};

/* ============================================================
   SHARED COUNTRIES MAP  (mirrors Intune groups)
   ============================================================ */
const COUNTRIES = {
  all: 'All',
  SG: 'Singapore',
  AU: 'Australia',
  MY: 'Malaysia',
  TH: 'Thailand',
  IN: 'India',
  ID: 'Indonesia',
  VN: 'Vietnam',
  PH: 'Philippines',
  JP: 'Japan',
  US: 'United States'
};

function countryDisplayName(value) {
  if (value == null || value === '' || value === 'all') return 'All Countries';
  const iso = window.CountryFlags?.normalizeToIso2?.(value);
  if (iso && COUNTRIES[iso]) return COUNTRIES[iso];
  return String(value);
}

function renderCountryFlag(value) {
  if (value == null || value === '' || value === 'all') {
    return '<span class="country-flag-placeholder" aria-hidden="true"></span>';
  }
  return window.CountryFlags?.render?.(value, 'country-flag') || '';
}

function updateGlobalCountryFlag() {
  const el = document.getElementById('globalCountryFlag');
  const select = document.getElementById('globalCountryFilter');
  if (!el || !select) return;
  const value = select.value;
  el.innerHTML = value === 'all' ? '' : renderCountryFlag(value || select.options[select.selectedIndex]?.textContent || '');
}

/* ============================================================
   UI HELPERS
   ============================================================ */
function buildCountrySelect(selected = 'all', includeAll = true) {
  const opts = Object.entries(COUNTRIES)
    .filter(([k]) => includeAll || k !== 'all')
    .map(([k, v]) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${v}</option>`)
    .join('');
  return `<select class="form-control" id="countrySelect">${opts}</select>`;
}

function confirmDelete(itemName, onConfirm) {
  Modal.open({
    title: 'Confirm Delete',
    body: `<p style="color:var(--text-secondary)">Are you sure you want to delete <strong>${itemName}</strong>? This cannot be undone.</p>`,
    confirmText: 'Delete',
    onConfirm,
    onOpen: () => { document.getElementById('modalConfirm').className = 'btn btn-danger'; }
  });
}

/* ============================================================
   THEME
   ============================================================ */
const Theme = {
  storageKey: 'nexit-theme',
  getPreferred() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch {}
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  },
  apply(theme, persist = false) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    document.documentElement.style.colorScheme = next;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', next === 'dark' ? 'dark light' : 'light dark');
    if (persist) {
      try { localStorage.setItem(this.storageKey, next); } catch {}
    }
    const toggle = document.getElementById('themeToggle');
    if (toggle) {
      const toLight = next === 'dark';
      toggle.textContent = toLight ? 'Light mode' : 'Dark mode';
      toggle.setAttribute('aria-label', toLight ? 'Switch to light mode' : 'Switch to dark mode');
      toggle.title = toLight ? 'Switch to light mode' : 'Switch to dark mode';
      toggle.setAttribute('aria-pressed', String(next === 'dark'));
    }
    window.dispatchEvent(new CustomEvent('nexit:themechange', { detail: { theme: next } }));
    return next;
  },
  toggle() {
    const current = document.documentElement.getAttribute('data-theme') || this.getPreferred();
    return this.apply(current === 'dark' ? 'light' : 'dark', true);
  }
};

/* ============================================================
   GLOBAL EVENT WIRING
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  // Sidebar nav
  document.querySelector('.sidebar-nav').addEventListener('click', e => {
      const item = e.target.closest('.nav-item');
      if (!item) return;
      e.preventDefault();
      if (item.dataset.deviceType) {
        App.modules.inventory?.selectDeviceType?.(item.dataset.deviceType);
        App.navigateTo('inventory');
      } else if (item.dataset.module) {
        if (item.dataset.module === 'inventory') App.modules.inventory?.selectDeviceType?.('');
        App.navigateTo(item.dataset.module);
      }
      // Close mobile sidebar
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebarOverlay').classList.remove('active');
  });

  // Hamburger
  const hamburger = document.getElementById('hamburger');
  const sidebar   = document.getElementById('sidebar');
  const overlay   = document.getElementById('sidebarOverlay');
  hamburger.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('active');
  });
  overlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
  });

  // Global country filter
  const globalCountryFilter = document.getElementById('globalCountryFilter');
  if (globalCountryFilter) {
    globalCountryFilter.addEventListener('change', e => {
      App.countryFilter = e.target.value;
      updateGlobalCountryFlag();
      const mod = App.modules[App.currentModule];
      if (mod && mod.onCountryChange) {
        mod.onCountryChange(e.target.value);
      } else {
        App.navigateTo(App.currentModule);
      }
    });
    updateGlobalCountryFlag();
  }

  // Modal close
  document.getElementById('modalClose').addEventListener('click', () => Modal.close());
  document.getElementById('modalCancel').addEventListener('click', () => Modal.close());
  document.getElementById('modalConfirm').addEventListener('click', () => {
    if (Modal._onConfirm) Modal._onConfirm();
  });

  // Theme toggle (global, persisted)
  Theme.apply(document.documentElement.getAttribute('data-theme') || Theme.getPreferred(), false);
  document.getElementById('themeToggle')?.addEventListener('click', () => Theme.toggle());
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onSchemeChange = (e) => {
      try {
        if (localStorage.getItem(Theme.storageKey)) return;
      } catch {}
      Theme.apply(e.matches ? 'light' : 'dark', false);
    };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onSchemeChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onSchemeChange);
  }

  // Global "More tools" (persists across route changes)
  const closeGlobalMoreTools = () => {
    const dropdown = document.getElementById('globalMoreTools');
    if (dropdown) dropdown.open = false;
  };

  const promptGlobalExport = () => {
    Modal.open({
      title: 'Export CSV',
      confirmText: 'Next',
      body: `<p>Choose which data to export.</p>
        <label class="duplicate-choice"><input type="radio" name="globalExportSource" value="inventory" checked> Asset Inventory data</label>
        <label class="duplicate-choice"><input type="radio" name="globalExportSource" value="users"> User list data</label>`,
      onConfirm: () => {
        const source = document.querySelector('input[name="globalExportSource"]:checked')?.value || 'inventory';
        Modal.close();
        Modal.open({
          title: source === 'users' ? 'Export users CSV' : 'Export inventory CSV',
          confirmText: 'Export CSV',
          body: `<p>Choose which columns to include.${source === 'inventory' ? ' The current search and filters still determine which devices are exported.' : ' The current search and filters determine which users are exported.'}</p>
            <label class="duplicate-choice"><input type="radio" name="globalExportColumns" value="active" checked> Active columns</label>
            <label class="duplicate-choice"><input type="radio" name="globalExportColumns" value="all"> All columns</label>`,
          onConfirm: () => {
            const all = document.querySelector('input[name="globalExportColumns"]:checked')?.value === 'all';
            Modal.close();
            if (source === 'users') {
              App.modules.users?.exportUsersCsv?.(all);
            } else {
              App.modules.inventory?.exportCurrentInventory?.(all);
            }
          }
        });
      }
    });
  };

  const promptGlobalImport = () => {
    Modal.open({
      title: 'Import CSV',
      confirmText: 'Next',
      body: `<p>Choose which data to import.</p>
        <label class="duplicate-choice"><input type="radio" name="globalImportSource" value="inventory" checked> Asset Inventory data</label>
        <label class="duplicate-choice"><input type="radio" name="globalImportSource" value="users"> User list data</label>`,
      onConfirm: () => {
        const source = document.querySelector('input[name="globalImportSource"]:checked')?.value || 'inventory';
        Modal.close();
        const input = document.getElementById(source === 'users' ? 'globalUsersImportInput' : 'globalInventoryImportInput');
        if (input) {
          input.value = '';
          input.dataset.pending = '1';
          input.click();
        }
      }
    });
  };

  document.getElementById('globalBackupDatabaseBtn')?.addEventListener('click', () => {
    closeGlobalMoreTools();
    App.modules.inventory?.downloadDatabaseBackup?.();
  });
  document.getElementById('globalRestoreDatabaseBtn')?.addEventListener('click', () => {
    closeGlobalMoreTools();
    const input = document.getElementById('globalDatabaseRestoreInput');
    if (input) { input.value = ''; input.click(); }
  });
  document.getElementById('globalCleanDatabaseBtn')?.addEventListener('click', () => {
    closeGlobalMoreTools();
    App.modules.inventory?.confirmClearDatabase?.();
  });
  document.getElementById('globalExportCsvBtn')?.addEventListener('click', () => {
    closeGlobalMoreTools();
    promptGlobalExport();
  });
  document.getElementById('globalImportCsvBtn')?.addEventListener('click', () => {
    closeGlobalMoreTools();
    promptGlobalImport();
  });
  document.getElementById('globalDownloadCsvTemplateBtn')?.addEventListener('click', () => {
    closeGlobalMoreTools();
    App.modules.inventory?.openCsvTemplateModal?.();
  });

  document.getElementById('globalDatabaseRestoreInput')?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) App.modules.inventory?.confirmDatabaseRestore?.(file);
  });
  document.getElementById('globalInventoryImportInput')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await App.modules.inventory?.importInventoryCsvFile?.(file);
  });
  document.getElementById('globalUsersImportInput')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await App.modules.users?.importUsersCsvFile?.(file);
  });

  document.addEventListener('click', (event) => {
    const dropdown = document.getElementById('globalMoreTools');
    if (dropdown && dropdown.open && !dropdown.contains(event.target)) dropdown.open = false;
  });
  // Backdrop clicks intentionally do not dismiss open forms; use the explicit controls above.
  // Load inventory from SQLite before rendering any module.
  App.store.initialize().then(() => {
    App.modules.inventory?.refreshDeviceTypeNavigation?.();
    updateGlobalCountryFlag();
    App.navigateTo('dashboard');
  }).catch((error) => {
    console.error('Could not connect to the local SQLite server.', error);
    const safeMessage = String(error.message || error).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    document.getElementById('moduleContainer').innerHTML = `
      <div class="card dashboard-info-card">
        <div class="card-header"><span class="card-title">SQLite server unavailable</span></div>
        <p>${safeMessage}</p>
        <p>Start the app with <code>python3 server.py</code> on Linux or <code>py server.py</code> on Windows, then reload this page.</p>
      </div>`;
  });

});
