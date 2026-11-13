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
  auth: {
    user: null,
    async request(path, options = {}) {
      const response = await fetch(path, { credentials: 'same-origin', ...options });
      const contentType = response.headers.get('Content-Type') || '';
      const payload = contentType.includes('application/json') ? await response.json().catch(() => ({})) : null;
      if (!response.ok) {
        const error = new Error((payload && payload.error) || `HTTP ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    },
    async me() {
      try {
        const result = await fetch('/api/auth/me', { credentials: 'same-origin' });
        const payload = await result.json().catch(() => ({}));
        if (!result.ok || !payload.authenticated) {
          this.user = null;
          return null;
        }
        this.user = payload.user || null;
        return this.user;
      } catch {
        this.user = null;
        return null;
      }
    },
    async login(username, password) {
      const payload = await this.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      this.user = payload.user || null;
      return this.user;
    },
    async logout() {
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      } catch {}
      this.user = null;
    },
    isAdmin() {
      return this.user?.role === 'admin';
    }
  },

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
        const response = await fetch(route, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body });
        const result = await response.json().catch(() => ({}));
        if (response.status === 401) window.dispatchEvent(new CustomEvent('nexit:auth-required'));
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
        credentials: 'same-origin',
        body: JSON.stringify({ inventory, checkoutHistory })
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) window.dispatchEvent(new CustomEvent('nexit:auth-required'));
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
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ inventory: readLegacy('inventory'), warranty: readLegacy('warranty') })
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.dispatchEvent(new CustomEvent('nexit:auth-required'));
        throw new Error(result.error || 'Authentication required.');
      }
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
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({})
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) window.dispatchEvent(new CustomEvent('nexit:auth-required'));
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
    if (moduleName === 'access' && !this.auth.isAdmin()) moduleName = 'dashboard';
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
  today() { return (window.DateUtils || App.dateUtils)?.todayIso?.() || new Date().toISOString().slice(0, 10); },
  format(dateStr) {
    if (!dateStr) return '—';
    const du = window.DateUtils || App.dateUtils;
    if (du?.formatIsoToDisplay) {
      const formatted = du.formatIsoToDisplay(dateStr);
      return formatted || '—';
    }
    return new Date(dateStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  },
  daysBetween(d1, d2) {
    const du = window.DateUtils || App.dateUtils;
    const parse = (v) => (du?.parseDateValue ? du.parseDateValue(v) : new Date(v));
    const a = parse(d1);
    const b = parse(d2);
    if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
    return Math.round((b - a) / 86400000);
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
    const du = window.DateUtils || App.dateUtils;
    const parsed = du?.parseDateValue ? du.parseDateValue(purchaseDate) : new Date(purchaseDate);
    if (!parsed || Number.isNaN(parsed.getTime())) return '—';
    const years = ((new Date() - parsed) / 31536000000).toFixed(1);
    return `${years} yrs`;
  },
  weekLabel() {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay() + 1);
    const end = new Date(start); end.setDate(start.getDate() + 6);
    const du = window.DateUtils || App.dateUtils;
    const fmt = (d) => {
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return du?.formatIsoToDisplay ? du.formatIsoToDisplay(iso) : iso;
    };
    return `Week of ${fmt(start)} – ${fmt(end)}`;
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
  const authOverlay = document.getElementById('authOverlay');
  const loginForm = document.getElementById('loginForm');
  const loginError = document.getElementById('loginError');
  const loginSubmit = document.getElementById('loginSubmit');
  const logoutBtn = document.getElementById('logoutBtn');
  const appShell = document.querySelector('.sidebar, .sidebar-overlay, .main-content');
  const shellNodes = [document.getElementById('sidebar'), document.getElementById('sidebarOverlay'), document.getElementById('mainContent')].filter(Boolean);

  function setShellVisible(visible) {
    shellNodes.forEach(node => { node.hidden = !visible; });
    if (authOverlay) authOverlay.hidden = visible;
  }

  function applyAuthUI() {
    const user = App.auth.user;
    const isAdmin = App.auth.isAdmin();
    const accessNav = document.getElementById('accessNavItem');
    const cleanBtn = document.getElementById('globalCleanDatabaseBtn');
    const restoreBtn = document.getElementById('globalRestoreDatabaseBtn');
    if (accessNav) accessNav.hidden = !isAdmin;
    if (logoutBtn) logoutBtn.hidden = !user;
    if (cleanBtn) cleanBtn.hidden = !isAdmin;
    if (restoreBtn) restoreBtn.hidden = !isAdmin;
    const avatar = document.getElementById('sidebarUserAvatar');
    const name = document.getElementById('sidebarUserName');
    const role = document.getElementById('sidebarUserRole');
    if (user) {
      if (avatar) avatar.textContent = (user.username || 'IT').slice(0, 2).toUpperCase();
      if (name) name.textContent = user.username || 'User';
      if (role) role.textContent = isAdmin ? 'Administrator' : 'Member';
    } else {
      if (avatar) avatar.textContent = 'IT';
      if (name) name.textContent = '—';
      if (role) role.textContent = 'Not signed in';
    }
  }

  async function startAuthenticatedApp() {
    applyAuthUI();
    setShellVisible(true);
    try {
      if (!App.store.initialized) await App.store.initialize();
      App.modules.inventory?.refreshDeviceTypeNavigation?.();
      updateGlobalCountryFlag();
      const target = App.auth.isAdmin() ? App.currentModule : (App.currentModule === 'access' ? 'dashboard' : App.currentModule);
      App.navigateTo(target || 'dashboard');
    } catch (error) {
      console.error('Could not connect to the local SQLite server.', error);
      const safeMessage = String(error.message || error).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
      document.getElementById('moduleContainer').innerHTML = `
        <div class="card dashboard-info-card">
          <div class="card-header"><span class="card-title">Application unavailable</span></div>
          <p>${safeMessage}</p>
          <p>Ensure the NexIT server is running and try again.</p>
        </div>`;
    }
  }

  async function showLogin(message = '') {
    App.auth.user = null;
    App.store.initialized = false;
    App.store.cache.clear();
    applyAuthUI();
    setShellVisible(false);
    if (loginError) loginError.textContent = message;
    document.getElementById('moduleContainer').innerHTML = '';
    loginForm?.reset();
    document.getElementById('loginUsername')?.focus();
  }

  loginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (loginSubmit) loginSubmit.disabled = true;
    if (loginError) loginError.textContent = '';
    try {
      const username = document.getElementById('loginUsername')?.value || '';
      const password = document.getElementById('loginPassword')?.value || '';
      await App.auth.login(username, password);
      await startAuthenticatedApp();
    } catch (error) {
      if (loginError) loginError.textContent = error.message || 'Login failed.';
    } finally {
      if (loginSubmit) loginSubmit.disabled = false;
    }
  });

  logoutBtn?.addEventListener('click', async () => {
    await App.auth.logout();
    await showLogin('You have been signed out.');
  });

  // Intercept 401s from store writes/reads by wrapping fetch usage is complex; handle on init and expose helper.
  window.addEventListener('nexit:auth-required', () => showLogin('Your session expired. Please sign in again.'));

  (async () => {
    const user = await App.auth.me();
    if (user) {
      await startAuthenticatedApp();
    } else {
      await showLogin();
    }
  })();

});

App.registerModule('access', (() => {
  let cachedUsers = [];

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) window.dispatchEvent(new CustomEvent('nexit:auth-required'));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  async function loadUsers() {
    const result = await api('/api/auth/users');
    cachedUsers = Array.isArray(result.users) ? result.users : [];
    return cachedUsers;
  }

  function renderTable(users) {
    const currentId = App.auth.user?.id;
    if (!users.length) return '<p class="muted">No login accounts found.</p>';
    return `<div class="access-table-wrap"><table class="data-table"><thead><tr>
      <th>Username</th><th>Role</th><th>Status</th><th>Last login</th><th>Created</th><th>Actions</th>
    </tr></thead><tbody>${users.map(user => {
      const isSelf = Number(user.id) === Number(currentId);
      const status = user.isActive ? 'Active' : 'Disabled';
      const actions = user.isActive ? `
        <div class="access-inline-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="reset" data-id="${user.id}" data-username="${escapeHtml(user.username)}">Reset password</button>
          <button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${user.id}" data-username="${escapeHtml(user.username)}" ${isSelf ? 'disabled title="You cannot delete your own account."' : ''}>Delete</button>
        </div>` : '<span class="muted">Deleted/disabled</span>';
      return `<tr>
        <td>${escapeHtml(user.username)}${isSelf ? ' <span class="badge">You</span>' : ''}</td>
        <td>${escapeHtml(user.role)}</td>
        <td>${status}</td>
        <td>${escapeHtml(user.lastLoginAt || '—')}</td>
        <td>${escapeHtml(user.createdAt || '—')}</td>
        <td>${actions}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
  }

  let handoffConfigState = null;

  function renderHandoffConfigCard(state) {
    const config = state?.config || { deployment_statuses: [], conditions: [] };
    const depOptions = state?.allowedDeploymentStatuses || [];
    const condOptions = state?.allowedConditions || [];
    if (!state) return '<p class="muted">Loading…</p>';
    return `
      <p class="muted">Controls which assets can be selected as the <strong>new device</strong> in replacement handoff. Assets must be unassigned, not checked out, and match an allowed Deployment Status + Condition.</p>
      <form id="replacementHandoffConfigForm" class="access-form">
        <fieldset>
          <legend>Allowed Deployment Status</legend>
          ${depOptions.map((v) => `<label class="duplicate-choice"><input type="checkbox" name="handoffDeploymentStatus" value="${escapeHtml(v)}" ${(config.deployment_statuses || []).includes(v) ? 'checked' : ''}> ${escapeHtml(v)}</label>`).join('') || '<p class="muted">No options available.</p>'}
        </fieldset>
        <fieldset>
          <legend>Allowed Hardware Health (Condition)</legend>
          ${condOptions.map((opt) => `<label class="duplicate-choice"><input type="checkbox" name="handoffCondition" value="${escapeHtml(opt.value)}" ${(config.conditions || []).includes(opt.value) ? 'checked' : ''}> ${escapeHtml(opt.label || opt.value)}</label>`).join('') || '<p class="muted">No options available.</p>'}
        </fieldset>
        <div class="form-help">Default: In Stock + Working (Good). Excluded states (e.g. Retired, blank, In Use) cannot be selected unless allowed here.</div>
        <button type="submit" class="btn btn-primary">Save handoff settings</button>
      </form>`;
  }

  async function loadHandoffConfig() {
    const result = await api('/api/replacement-handoff-config');
    handoffConfigState = result;
    return result;
  }

  async function render() {
    if (!App.auth.isAdmin()) {
      document.getElementById('moduleContainer').innerHTML = '<div class="card"><p>Administrator access required.</p></div>';
      return;
    }
    const container = document.getElementById('moduleContainer');
    container.innerHTML = `
      <div class="access-admin-grid">
        <section class="card">
          <div class="card-header"><span class="card-title">Create login account</span></div>
          <p class="muted">Admins create internal accounts. No public signup. Members can use all app features except Clean Database and User Management.</p>
          <form id="createAuthUserForm" class="access-form">
            <label>Username<input name="username" type="text" required autocomplete="off" /></label>
            <label>Role<select name="role" required><option value="member">member</option><option value="admin">admin</option></select></label>
            <label>Temporary password<input name="password" type="password" minlength="8" required autocomplete="new-password" /></label>
            <button type="submit" class="btn btn-primary">Create user</button>
          </form>
        </section>
        <section class="card">
          <div class="card-header"><span class="card-title">Replacement handoff settings</span></div>
          <div id="replacementHandoffConfigCard"><p class="muted">Loading…</p></div>
        </section>
        <section class="card">
          <div class="card-header"><span class="card-title">Login accounts</span></div>
          <div id="authUsersTable"></div>
        </section>
      </div>`;
    await Promise.all([refreshUsersTable(), refreshHandoffConfigCard()]);
    bind();
  }

  async function refreshUsersTable() {
    const table = document.getElementById('authUsersTable');
    if (!table) return;
    table.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const users = await loadUsers();
      table.innerHTML = renderTable(users);
    } catch (error) {
      table.innerHTML = `<p class="auth-error">${escapeHtml(error.message || 'Could not load users.')}</p>`;
    }
  }

  async function refreshHandoffConfigCard() {
    const card = document.getElementById('replacementHandoffConfigCard');
    if (!card) return;
    card.innerHTML = '<p class="muted">Loading…</p>';
    try {
      await loadHandoffConfig();
      card.innerHTML = renderHandoffConfigCard(handoffConfigState);
    } catch (error) {
      card.innerHTML = `<p class="auth-error">${escapeHtml(error.message || 'Could not load replacement handoff settings.')}</p>`;
    }
  }

  async function refresh() {
    await Promise.all([refreshUsersTable(), refreshHandoffConfigCard()]);
  }

  function bind() {
    document.getElementById('createAuthUserForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      try {
        await api('/api/auth/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: data.get('username'), role: data.get('role'), password: data.get('password') })
        });
        form.reset();
        Toast.show('Login account created.', 'success');
        await refreshUsersTable();
      } catch (error) {
        Toast.show(error.message || 'Could not create user.', 'error', 6000);
      }
    });

    document.getElementById('replacementHandoffConfigCard')?.addEventListener('submit', async (event) => {
      const form = event.target.closest('#replacementHandoffConfigForm');
      if (!form) return;
      event.preventDefault();
      const deployment_statuses = Array.from(form.querySelectorAll('input[name="handoffDeploymentStatus"]:checked')).map((el) => el.value);
      const conditions = Array.from(form.querySelectorAll('input[name="handoffCondition"]:checked')).map((el) => el.value);
      if (!deployment_statuses.length || !conditions.length) {
        Toast.show('Select at least one allowed Deployment Status and one allowed Condition.', 'error', 5000);
        return;
      }
      try {
        const result = await api('/api/replacement-handoff-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deployment_statuses, conditions })
        });
        handoffConfigState = { ...(handoffConfigState || {}), config: result.config || { deployment_statuses, conditions } };
        Toast.show('Replacement handoff settings saved.', 'success');
        await refreshHandoffConfigCard();
      } catch (error) {
        Toast.show(error.message || 'Could not save replacement handoff settings.', 'error', 6000);
      }
    });

    document.getElementById('authUsersTable')?.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const id = Number(button.dataset.id);
      const username = button.dataset.username || '';
      if (button.dataset.action === 'reset') {
        Modal.open({
          title: `Reset password: ${username}`,
          confirmText: 'Reset password',
          body: `<label class="auth-field"><span>New password (min 8 chars)</span><input id="resetAuthPassword" type="password" minlength="8" autocomplete="new-password" /></label>`,
          onConfirm: async () => {
            const password = document.getElementById('resetAuthPassword')?.value || '';
            if (password.length < 8) { Toast.show('Password must be at least 8 characters.', 'error'); return; }
            try {
              await api('/api/auth/users/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password }) });
              Modal.close();
              Toast.show('Password reset. Existing sessions were revoked.', 'success', 5000);
              await refresh();
            } catch (error) {
              Toast.show(error.message || 'Could not reset password.', 'error', 6000);
            }
          }
        });
        return;
      }
      if (button.dataset.action === 'delete') {
        Modal.open({
          title: `Delete login account: ${username}`,
          confirmText: 'Delete user',
          onOpen: () => { const c = document.getElementById('modalConfirm'); if (c) c.className = 'btn btn-danger'; },
          body: `<p>This will disable the login account for <strong>${escapeHtml(username)}</strong> and revoke active sessions.</p>`,
          onConfirm: async () => {
            try {
              await api('/api/auth/users/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
              Modal.close();
              Toast.show('User disabled.', 'success');
              await refresh();
            } catch (error) {
              Toast.show(error.message || 'Could not delete user.', 'error', 6000);
            }
          }
        });
      }
    });
  }

  return { render, init: render, refresh };
})());
