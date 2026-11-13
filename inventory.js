App.registerModule('inventory', (() => {
  const STORAGE_KEY = 'inventory';
  const WARRANTY_KEY = 'warranty';
  const CHECKOUT_HISTORY_KEY = 'checkoutHistory';
  const DEVICE_TYPES = [
    { value: 'laptop', label: 'Laptop', navLabel: 'Laptop' },
    { value: 'firewall', label: 'Firewall', navLabel: 'Firewall' },
    { value: 'ups', label: 'UPS', navLabel: 'UPS' },
    { value: 'accesspoint', label: 'AccessPoint', navLabel: 'AccessPoint' },
    { value: 'switch', label: 'Switch', navLabel: 'Switches' }
  ];
  const DEVICE_COUNTRIES = {
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
  const FIXED_ASSET_NUMBER_HELP = 'This number is from Finance, SAP book Asset number. If you do not have it, please check with Finance asset manager.';
  const DEFAULT_COLUMNS = [
    'Asset type', 'Fixed Asset Number', 'Device ID', 'Device name', 'deployment_status', 'condition', 'Country', 'Ownership', 'Compliance', 'OS', 'OS version', 'JoinType', 'Managed by',
    'Primary user email address', 'Primary user UPN', 'Last check-in', 'Enrollment date',
    'Model', 'Manufacturer', 'Serial number', 'Primary user display name',
    'Free storage', 'Azure AD registered', 'Intune GroupName', 'Intune Group Tag',
    'WindowsVersion', 'Total storage (GB)', 'Location', 'Device IP', 'Firmware version',
    'UPS Capacity (VA)', 'Battery replacement date', 'Purchase Date', 'Warranty Start Date', 'Warranty End Date', 'Disposal Date', 'Warranty Match Status', 'Age', 'Device Online Status'
  ];
  const CHECKOUT_COLUMNS = ['Expected Return Date'];
  const REPLACEMENT_COLUMNS = [
    'Replacement Status', 'Replaced For Staff Member', 'Replacement Date',
    'Replaced By Device Serial Number', 'Replacement Count', 'old_device_outcome'
  ];
  const DEFAULT_VISIBLE_COLUMNS = [
    'Asset type', 'Fixed Asset Number', 'Device name', 'Deployment Status', 'Hardware Health', 'Country', 'Serial number', 'Manufacturer', 'Model', 'Location',
    'OS version', 'Azure AD registered', 'JoinType', 'Enrollment date', 'Managed by', 'Device IP',
    'Firmware version', 'UPS Capacity (VA)', 'Battery replacement date', 'Compliance',
    'Primary user email address', 'Intune GroupName', 'Intune Group Tag',
    'Last check-in', 'Total storage (GB)', 'Purchase Date', 'Warranty Start Date', 'Warranty End Date', 'Disposal Date', 'Age',
    'Device Online Status', ...CHECKOUT_COLUMNS, ...REPLACEMENT_COLUMNS
  ];
  const LAYOUT_COLUMNS = [
    'Asset type', 'Fixed Asset Number', 'Device ID', 'Device name', 'Deployment Status', 'Hardware Health', 'Country', 'Ownership', 'Compliance', 'OS', 'OS version',
    'Primary user email address', 'Primary user UPN', 'Last check-in', 'Enrollment date',
    'Model', 'Manufacturer', 'Serial number', 'Primary user display name',
    'Free storage', 'Azure AD registered', 'JoinType', 'Managed by', 'Intune GroupName', 'Intune Group Tag',
    'WindowsVersion', 'Total storage (GB)', 'Location', 'Device IP', 'Firmware version',
    'UPS Capacity (VA)', 'Battery replacement date', 'Purchase Date', 'Warranty Start Date', 'Warranty End Date', 'Disposal Date', 'Age', 'Device Online Status',
    ...CHECKOUT_COLUMNS, ...REPLACEMENT_COLUMNS
  ];

  function normalizeHeader(value) {
    return String(value || '').replace(/\uFEFF/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  }

  function getInventoryField(device, field) {
    const aliases = {
      'OS version': ['OS Version'],
      'Azure AD registered': ['Azure AD Registered'],
      JoinType: ['Join Type', 'Join type'],
      'Enrollment date': ['Enrollment Date'],
      'Last check-in': ['Last Check-In', 'Last checkin', 'Last Check In'],
      'Intune GroupName': ['IntuneGroup.GroupName', 'Intune.GroupName', 'IntuneGroup GroupName'],
      'Intune Group Tag': ['IntuneGroup.GroupTag', 'Intune.Group Tag', 'IntuneGroup GroupTag'],
      'Warranty Start Date': ['Warranty start date'],
      'Warranty End Date': ['Warranty end date'],
      'Managed by': ['Managed By'],
      'Device IP': ['Management IP', 'Device IP Address']
    }[field] || [];
    const usable = (value) => value !== undefined && value !== null && String(value).trim() !== '' && !['null', 'undefined'].includes(String(value).trim().toLowerCase());
    if (usable(device?.[field])) return device[field];
    return aliases.map((alias) => device?.[alias]).find(usable) ?? '';
  }

  const IMPORT_SOURCE_VALUES = Symbol('inventoryImportSourceValues');

  function hasImportValue(value) {
    if (value === null || value === undefined) return false;
    const text = String(value).trim();
    return Boolean(text) && !['null', 'undefined'].includes(text.toLowerCase());
  }

  function hasImportedSourceValue(record, ...headers) {
    const sourceValues = record[IMPORT_SOURCE_VALUES];
    if (!(sourceValues instanceof Map)) return false;
    return headers.some((header) => hasImportValue(sourceValues.get(normalizeHeader(header))));
  }

  function readStoredInventoryFlag(key, fallback = false) {
    try {
      const stored = JSON.parse(localStorage.getItem(key) || 'null');
      return typeof stored === 'boolean' ? stored : fallback;
    } catch {
      return fallback;
    }
  }

  function readStoredInventoryEnumFilter(key) {
    try {
      const stored = JSON.parse(localStorage.getItem(key) || 'null');
      return typeof stored === 'string' ? stored : '';
    } catch {
      return '';
    }
  }

  function readStoredInventoryPanelOpen() {
    try {
      const stored = JSON.parse(localStorage.getItem('nexit_inventory_filter_panel_open') || 'null');
      return typeof stored === 'boolean' ? stored : false;
    } catch {
      return false;
    }
  }

  const BLANK_FILTER_VALUE = '__blank__';
  const BLANK_FILTER_LABEL = '(blank)';
  const INVENTORY_FILTER_URL_KEYS = {
    deploymentStatus: 'deploymentStatus',
    condition: 'condition',
    model: 'model',
    manufacturer: 'manufacturer',
    location: 'location',
    replacementStatus: 'replacementStatus',
    replacementCount: 'replacementCount',
    oldDeviceOutcome: 'oldDeviceOutcome',
    duplicatesOnly: 'duplicatesOnly',
    showArchived: 'showArchived',
    warrantyStatus: 'warrantyStatus',
    search: 'q',
  };
  const DEFAULT_FILTER_STATE = {
    duplicatesOnly: false,
    showArchived: false,
    deploymentStatus: '',
    condition: '',
    model: '',
    manufacturer: '',
    location: '',
    replacementStatus: '',
    replacementCount: '',
    oldDeviceOutcome: '',
  };

  function readUrlInventoryFilters() {
    try {
      const params = new URLSearchParams(window.location.search);
      const readBool = (k) => params.get(k) === '1' || params.get(k) === 'true';
      return {
        duplicatesOnly: readBool(INVENTORY_FILTER_URL_KEYS.duplicatesOnly),
        showArchived: readBool(INVENTORY_FILTER_URL_KEYS.showArchived),
        deploymentStatus: params.get(INVENTORY_FILTER_URL_KEYS.deploymentStatus) || '',
        condition: params.get(INVENTORY_FILTER_URL_KEYS.condition) || '',
        model: params.get(INVENTORY_FILTER_URL_KEYS.model) || '',
        manufacturer: params.get(INVENTORY_FILTER_URL_KEYS.manufacturer) || '',
        location: params.get(INVENTORY_FILTER_URL_KEYS.location) || '',
        replacementStatus: params.get(INVENTORY_FILTER_URL_KEYS.replacementStatus) || '',
        replacementCount: params.get(INVENTORY_FILTER_URL_KEYS.replacementCount) || '',
        oldDeviceOutcome: params.get(INVENTORY_FILTER_URL_KEYS.oldDeviceOutcome) || '',
        warrantyStatus: params.get(INVENTORY_FILTER_URL_KEYS.warrantyStatus) || '',
        search: params.get(INVENTORY_FILTER_URL_KEYS.search) || '',
      };
    } catch {
      return { ...DEFAULT_FILTER_STATE, warrantyStatus: '', search: '' };
    }
  }

  const _initialUrlFilters = readUrlInventoryFilters();
  let filterState = {
    ...DEFAULT_FILTER_STATE,
    duplicatesOnly: _initialUrlFilters.duplicatesOnly || readStoredInventoryFlag('nexit_inventory_duplicates_only'),
    showArchived: _initialUrlFilters.showArchived || readStoredInventoryFlag('nexit_inventory_show_archived'),
    deploymentStatus: _initialUrlFilters.deploymentStatus || readStoredInventoryEnumFilter('nexit_inventory_deployment_status'),
    condition: _initialUrlFilters.condition || readStoredInventoryEnumFilter('nexit_inventory_condition'),
    model: _initialUrlFilters.model || '',
    manufacturer: _initialUrlFilters.manufacturer || '',
    location: _initialUrlFilters.location || '',
    replacementStatus: _initialUrlFilters.replacementStatus || '',
    replacementCount: _initialUrlFilters.replacementCount || '',
    oldDeviceOutcome: _initialUrlFilters.oldDeviceOutcome || '',
  };
  let filterPanelOpen = readStoredInventoryPanelOpen();
  let moreFiltersOpen = false;
  const MAX_HISTORY_STATES = 10;
  const MAX_HISTORY_BYTES = 20 * 1024 * 1024;
  let historyState = { undo: [], redo: [] };
  let warrantyStatusFilter = _initialUrlFilters.warrantyStatus || '';
  let dashboardRecordIndexes = null;
  let dashboardFilterLabel = '';
  let selectedDeviceIndexes = new Set();
  let activeDeviceType = '';
  let columnDrawerOpen = false;
  let columnSearchTerm = '';
  let checkoutIndexSource = null;
  let checkoutIndexes = { current: new Map(), assetKeys: new Set() };
  let searchDebounceTimer = null;
  let initialSearchFromUrl = _initialUrlFilters.search || '';

  function syncInventoryFiltersToUrl(searchValueOverride = null) {
    try {
      const url = new URL(window.location.href);
      const params = url.searchParams;
      Object.values(INVENTORY_FILTER_URL_KEYS).forEach((k) => params.delete(k));
      const setIf = (key, val) => { if (val) params.set(key, val); };
      setIf(INVENTORY_FILTER_URL_KEYS.deploymentStatus, filterState.deploymentStatus);
      setIf(INVENTORY_FILTER_URL_KEYS.condition, filterState.condition);
      setIf(INVENTORY_FILTER_URL_KEYS.model, filterState.model);
      setIf(INVENTORY_FILTER_URL_KEYS.manufacturer, filterState.manufacturer);
      setIf(INVENTORY_FILTER_URL_KEYS.location, filterState.location);
      setIf(INVENTORY_FILTER_URL_KEYS.replacementStatus, filterState.replacementStatus);
      setIf(INVENTORY_FILTER_URL_KEYS.replacementCount, filterState.replacementCount);
      setIf(INVENTORY_FILTER_URL_KEYS.oldDeviceOutcome, filterState.oldDeviceOutcome);
      if (filterState.duplicatesOnly) params.set(INVENTORY_FILTER_URL_KEYS.duplicatesOnly, '1');
      if (filterState.showArchived) params.set(INVENTORY_FILTER_URL_KEYS.showArchived, '1');
      setIf(INVENTORY_FILTER_URL_KEYS.warrantyStatus, warrantyStatusFilter);
      const searchVal = searchValueOverride !== null ? searchValueOverride : (document.getElementById('inventorySearch')?.value || initialSearchFromUrl || '');
      setIf(INVENTORY_FILTER_URL_KEYS.search, String(searchVal || '').trim());
      history.replaceState(null, '', `${url.pathname}${params.toString() ? `?${params.toString()}` : ''}${url.hash || ''}`);
    } catch {}
  }

  function persistCoreFilterState() {
    localStorage.setItem('nexit_inventory_duplicates_only', JSON.stringify(!!filterState.duplicatesOnly));
    localStorage.setItem('nexit_inventory_show_archived', JSON.stringify(!!filterState.showArchived));
    localStorage.setItem('nexit_inventory_deployment_status', JSON.stringify(filterState.deploymentStatus || ''));
    localStorage.setItem('nexit_inventory_condition', JSON.stringify(filterState.condition || ''));
  }

  function normalizeDeviceType(value = '') {
    const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    if (!normalized) return 'laptop';
    const type = DEVICE_TYPES.find((item) => item.value === normalized)
      || (normalized === 'switches' ? DEVICE_TYPES.find((item) => item.value === 'switch') : null);
    if (!type) throw new Error(`Unsupported device type "${value}". Choose Laptop, Firewall, UPS, AccessPoint, or Switch.`);
    return type.value;
  }

  function deviceTypeLabel(value) {
    return DEVICE_TYPES.find((item) => item.value === value)?.label || value;
  }

  function resolveDeviceTypeValue(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    const type = DEVICE_TYPES.find((item) => item.value === normalized)
      || (normalized === 'switches' ? DEVICE_TYPES.find((item) => item.value === 'switch') : null);
    return type ? type.value : String(value || '').trim();
  }

  function resolveAssetTypeValue(value) {
    const typed = String(value || '').trim();
    const standardTypes = DEVICE_TYPES.map(({ value }) => value);
    if (typed && standardTypes.includes(typed)) return normalizeDeviceType(typed);
    if (typed) return typed;
    return 'laptop';
  }

  function getCategoryOptions() {
    const standardTypes = DEVICE_TYPES.map(({ value }) => value);
    const customOptions = (App.fieldOptions?.['Asset type'] || []).map((opt) => opt.value);
    return [...new Set([...standardTypes, ...customOptions])];
  }

  function getCountryCodeFromDeviceName(deviceName) {
    const prefix = String(deviceName || '').trim().slice(0, 2).toUpperCase();
    return Object.prototype.hasOwnProperty.call(DEVICE_COUNTRIES, prefix) ? prefix : '';
  }

  function getCountryFromDeviceName(deviceName) {
    return DEVICE_COUNTRIES[getCountryCodeFromDeviceName(deviceName)] || '';
  }

  function getCountryCodeFromValue(value) {
    const normalized = String(value || '').trim();
    const upper = normalized.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(DEVICE_COUNTRIES, upper)) return upper;
    return Object.entries(DEVICE_COUNTRIES).find(([, name]) => name.toLowerCase() === normalized.toLowerCase())?.[0] || '';
  }

  function getDeviceCountryCode(device) {
    return getCountryCodeFromValue(device?.Country) || getCountryCodeFromDeviceName(device?.['Device name']);
  }

  function getDeviceCountryName(device) {
    const code = getDeviceCountryCode(device);
    return DEVICE_COUNTRIES[code] || String(device?.Country || '').trim();
  }

  function getAssetType(record) {
    const category = record['Asset type'];
    if (category) {
      try {
        return normalizeDeviceType(category);
      } catch {
        const customType = String(category || '').trim();
        return customType || 'laptop';
      }
    }
    const legacyType = record['Device type'] || record['Device Type'] || record.Type;
    if (!legacyType) return 'laptop';
    try {
      return normalizeDeviceType(legacyType);
    } catch {
      const customType = String(legacyType || '').trim();
      return customType || 'laptop';
    }
  }

  function updateDeviceTypeNavigation() {
    const navigation = document.getElementById('deviceTypeNav');
    if (!navigation) return;
    const counts = new Map(DEVICE_TYPES.map(({ value }) => [value, 0]));
    getInventory().forEach((device) => {
      const type = getAssetType(device);
      counts.set(type, (counts.get(type) || 0) + 1);
    });
    if (activeDeviceType && counts.get(activeDeviceType) === 0) activeDeviceType = '';
    const categories = [
      ...DEVICE_TYPES.map(({ value, navLabel }) => ({ value, navLabel })),
      ...Array.from(counts.entries())
        .filter(([value]) => value && !DEVICE_TYPES.some((item) => item.value === value) && (counts.get(value) || 0) > 0)
        .map(([value]) => ({ value, navLabel: deviceTypeLabel(value) || value }))
    ];
    navigation.innerHTML = categories
      .filter(({ value }) => (counts.get(value) || 0) > 0)
      .map(({ value, navLabel }) => `<a href="#" class="nav-item device-type-nav-item ${activeDeviceType === value ? 'active' : ''}" data-module="inventory" data-device-type="${value}"><span class="nav-icon">·</span>${navLabel}<span class="nav-badge">${counts.get(value)}</span></a>`)
      .join('');
    document.querySelectorAll('.sidebar-nav .nav-item').forEach((item) => {
      item.classList.toggle(
        'active',
        App.currentModule === item.dataset.module
          && (item.dataset.deviceType ? item.dataset.deviceType === activeDeviceType : !activeDeviceType)
      );
    });
  }

  function getHistoryState() {
    return historyState;
  }

  function trimHistory(states) {
    const kept = [];
    let bytes = 0;
    for (let index = states.length - 1; index >= 0 && kept.length < MAX_HISTORY_STATES; index -= 1) {
      const snapshot = states[index];
      const snapshotBytes = JSON.stringify(snapshot).length * 2;
      if (kept.length && bytes + snapshotBytes > MAX_HISTORY_BYTES) break;
      kept.unshift(snapshot);
      bytes += snapshotBytes;
    }
    return kept;
  }

  function persistHistoryState(state) {
    historyState = {
      undo: trimHistory(state.undo),
      redo: trimHistory(state.redo)
    };
    return true;
  }

  function setInventory(list) {
    const next = Array.isArray(list) ? list.map((device) => ({
      ...device,
      'Asset type': getAssetType(device),
      Country: getDeviceCountryName(device)
    })) : [];
    const previous = App.store.get(STORAGE_KEY);
    App.store.set(STORAGE_KEY, next);
    if (JSON.stringify(previous) === JSON.stringify(next)) return;

    const state = getHistoryState();
    persistHistoryState({
      undo: [...state.undo, previous].slice(-MAX_HISTORY_STATES),
      redo: []
    });
  }

  function restoreInventoryHistory(direction) {
    const state = getHistoryState();
    const source = direction === 'undo' ? state.undo : state.redo;
    const destination = direction === 'undo' ? state.redo : state.undo;
    if (!source.length) return false;

    const current = App.store.get(STORAGE_KEY);
    const target = source[source.length - 1];
    App.store.set(STORAGE_KEY, target);
    const nextState = {
      undo: direction === 'undo' ? source.slice(0, -1) : [...destination, current].slice(-MAX_HISTORY_STATES),
      redo: direction === 'undo' ? [...destination, current].slice(-MAX_HISTORY_STATES) : source.slice(0, -1)
    };
    persistHistoryState(nextState);
    return true;
  }

  function getInventory() {
    const list = App.store.get(STORAGE_KEY);
    return Array.isArray(list) ? list.map((device) => {
      const normalized = { ...device };
      if (normalized['Intune GroupName'] == null || normalized['Intune GroupName'] === '') {
        normalized['Intune GroupName'] = String(normalized['IntuneGroup.GroupName'] || normalized['Intune.GroupName'] || normalized['IntuneGroup GroupName'] || normalized['Intune GroupName'] || '');
      }
      delete normalized['IntuneGroup.GroupName'];
      delete normalized['IntuneGroup.DeviceName'];
      delete normalized['IntuneGroup.SerialNumber'];
      delete normalized['Intune SerialNumber'];
      delete normalized['IntuneGroup.Model'];
      delete normalized['Intune Group Model'];
      delete normalized['IntuneGroup.Manufacturer'];
      delete normalized['Intune Group Manufacturer'];
      return {
        ...normalized,
        'Asset type': getAssetType(normalized),
        Country: getDeviceCountryName(normalized)
      };
    }) : [];
  }

  function getWarrantyData() {
    return App.store.get(WARRANTY_KEY) || [];
  }

  function setWarrantyData(list) {
    App.store.set(WARRANTY_KEY, Array.isArray(list) ? list : []);
  }

  function getCheckoutHistory() {
    const records = App.store.get(CHECKOUT_HISTORY_KEY);
    return Array.isArray(records) ? records : [];
  }

  function getCheckoutIndexes() {
    const events = getCheckoutHistory();
    if (events !== checkoutIndexSource) {
      const current = new Map();
      const assetKeys = new Set();
      const lastEvent = new Map();
      events.forEach((event) => {
        const key = getCheckoutEventAssetKey(event);
        if (!key) return;
        assetKeys.add(key);
        lastEvent.set(key, event);
        if (event['Event type'] === 'checkout') current.set(key, event);
        else current.delete(key);
      });
      checkoutIndexSource = events;
      checkoutIndexes = { current, assetKeys, lastEvent };
    }
    return checkoutIndexes;
  }

  function normalizeAssetIdentifier(value) {
    const identifier = String(value || '').trim().toLowerCase();
    return ['n/a', 'na', 'none', 'null', 'unknown', '-'].includes(identifier) ? '' : identifier;
  }

  function getAssetSerial(record) {
    return [record['Serial number'], record['IntuneGroup.SerialNumber']]
      .map(normalizeSerialKey)
      .find((serial) => serial && normalizeAssetIdentifier(serial)) || '';
  }

  function getAssetKey(device) {
    const serial = getAssetSerial(device);
    if (serial) return `serial:${serial}`;
    const deviceId = normalizeAssetIdentifier(device['Device ID']);
    return deviceId ? `device:${deviceId}` : '';
  }

  function getCheckoutEventAssetKey(event) {
    const serial = getAssetSerial(event);
    if (serial) return `serial:${serial}`;
    const deviceId = normalizeAssetIdentifier(event['Device ID']);
    if (deviceId) return `device:${deviceId}`;
    const legacyKey = String(event['Asset key'] || '').trim().toLowerCase();
    if (!legacyKey || /^device:(n\/a|na|none|null|unknown|-)$/.test(legacyKey)) return '';
    return legacyKey;
  }

  function getCurrentCheckout(device) {
    const assetKey = getAssetKey(device);
    if (!assetKey) return null;
    return getCheckoutIndexes().current.get(assetKey) || null;
  }

  function getPrimaryUser(device) {
    const email = String(device['Primary user email address'] || device['Primary user UPN'] || '').trim();
    const name = String(device['Primary user display name'] || '').trim();
    return email ? { name: name || email, email } : null;
  }

  function isDeviceAssigned(device) {
    return Boolean(getCurrentCheckout(device) || getPrimaryUser(device));
  }

  function getTodayDate() {
    return (window.DateUtils || App.dateUtils)?.todayIso?.() || new Date().toISOString().slice(0, 10);
  }

  function isReturnOverdue(event) {
    return Boolean(event?.['Expected return date'] && event['Expected return date'] < getTodayDate());
  }

  async function downloadDatabaseBackup() {
    try {
      const response = await fetch('/api/backup', { credentials: 'same-origin' });
      if (response.status === 401) { window.dispatchEvent(new CustomEvent('nexit:auth-required')); throw new Error('Authentication required.'); }
      if (response.status === 403) { throw new Error('Administrator access required.'); }
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try { const result = await response.json(); message = result.error || message; } catch {}
        throw new Error(message);
      }
      const blob = await response.blob();
      const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]
        || `nexit-backup-${getTodayDate()}.db`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      Toast.show('Database backup downloaded. Store it somewhere safe.', 'success', 6000);
    } catch (error) {
      Toast.show(`Could not download database backup: ${error.message || error}`, 'error', 7000);
    }
  }

  function confirmDatabaseRestore(file) {
    if (!file) return;
    Modal.open({
      title: 'Restore database backup?',
      confirmText: 'Restore backup',
      onOpen: () => { document.getElementById('modalConfirm').className = 'btn btn-danger'; },
      body: `<p><strong>This replaces all current NexIT data</strong>, including inventory, warranty, replacement history, and checkout/check-in history, with the contents of the selected backup.</p>
        <p>Selected file: <strong>${escapeHtml(file.name)}</strong> (${(file.size / (1024 * 1024)).toFixed(1)} MB)</p>
        <p>Only a validated NexIT SQLite backup will be accepted. After restoring, the app reloads to show the restored records.</p>`,
      onConfirm: async () => {
        const confirmButton = document.getElementById('modalConfirm');
        confirmButton.disabled = true;
        try {
          const response = await fetch('/api/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            credentials: 'same-origin',
            body: await file.arrayBuffer()
          });
          const result = await response.json().catch(() => ({}));
          if (response.status === 401) { window.dispatchEvent(new CustomEvent('nexit:auth-required')); throw new Error('Authentication required.'); }
          if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
          Modal.close();
          Toast.show('Database restored. Reloading NexIT…', 'success', 5000);
          setTimeout(() => window.location.reload(), 500);
        } catch (error) {
          confirmButton.disabled = false;
          Toast.show(`Could not restore database: ${error.message || error}`, 'error', 7000);
        }
      }
    });
  }

  function confirmClearDatabase() {
    Modal.open({
      title: 'Clean database?',
      confirmText: 'Clean database',
      onOpen: () => { document.getElementById('modalConfirm').className = 'btn btn-danger'; },
      body: `<p><strong>This permanently deletes NexIT application data</strong> currently stored in the local SQLite database, including inventory, warranty, replacement history, checkout/check-in history, and staff/user records.</p>
        <p>Login accounts and access sessions are preserved. The app will reload afterwards. Download a backup first if you want to keep a copy.</p>`,
      onConfirm: async () => {
        const confirmButton = document.getElementById('modalConfirm');
        confirmButton.disabled = true;
        try {
          const response = await fetch('/api/clean-database', { method: 'POST', credentials: 'same-origin' });
          const result = await response.json().catch(() => ({}));
          if (response.status === 401) { window.dispatchEvent(new CustomEvent('nexit:auth-required')); throw new Error('Authentication required.'); }
          if (response.status === 403) { throw new Error('Administrator access required.'); }
          if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
          Modal.close();
          Toast.show(`Database cleared. Removed ${result.cleared ?? 0} records. Reloading NexIT…`, 'success', 5000);
          setTimeout(() => window.location.reload(), 500);
        } catch (error) {
          confirmButton.disabled = false;
          Toast.show(`Could not clear database: ${error.message || error}`, 'error', 7000);
        }
      }
    });
  }

  function getVisibleColumns() {
    try {
      const saved = JSON.parse(localStorage.getItem('nexit_inventory_layout') || 'null');
      if (!saved || !Array.isArray(saved.visible) || !saved.visible.length) return DEFAULT_VISIBLE_COLUMNS;
      if (saved.version !== 17) {
        const allowedColumns = [...LAYOUT_COLUMNS];
        const migrated = Array.from(new Set([...saved.visible.filter((col) => col !== 'Active device status'), 'Asset type', 'Fixed Asset Number', 'Deployment Status', 'Condition', 'Country', 'Location', 'OS version', 'Azure AD registered', 'JoinType', 'Enrollment date', 'Managed by', 'Device IP', 'Age', 'Device Online Status', ...CHECKOUT_COLUMNS, ...REPLACEMENT_COLUMNS]))
          .filter((col) => allowedColumns.includes(col));
        saveVisibleColumns(migrated);
        return migrated;
      }
      const allowedColumns = [...LAYOUT_COLUMNS];
      const visible = saved.visible.filter((col) => allowedColumns.includes(col));
      return visible.length ? visible : ['Device name'];
    } catch {
      return DEFAULT_VISIBLE_COLUMNS;
    }
  }

  function saveVisibleColumns(columns) {
    localStorage.setItem('nexit_inventory_layout', JSON.stringify({ visible: columns, version: 17 }));
  }

  function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const cleaned = String(value).replace(/[\s$,]/g, '').replace(/\$/g, '');
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeSerial(value) {
    return String(value || '').trim().toUpperCase();
  }

  function normalizeSerialKey(value) {
    return normalizeSerial(value).replace(/--?\d+$/, '').replace(/\s+/g, '');
  }

  function parseStorageValue(rawValue, sourceUnit = 'bytes') {
    const num = toNumber(rawValue);
    if (num === null) return null;
    const unit = String(sourceUnit || 'bytes').toLowerCase();
    if (unit.includes('byte')) return num / 1073741824;
    if (unit.includes('mb')) return num / 1024;
    if (unit.includes('gb')) return num;
    if (unit.includes('kb')) return num / 1048576;
    return num;
  }

  function getTotalStorageGb(device) {
    const gigabytes = toNumber(device?.['Total storage (GB)']);
    if (gigabytes !== null) return gigabytes;
    return parseStorageValue(device?.['Total storage'] || device?.['Total Storage'], 'bytes');
  }

  function formatGb(value) {
    if (value === null || value === undefined || value === '') return '—';
    return Number(value).toFixed(2);
  }

  // Shared date utilities (date-utils.js): YYYY-MM-DD for storage, UI, and CSV.
  const DATE_UTILS = window.DateUtils || App.dateUtils || {
    parseDateToIso: (v) => ({ iso: String(v || '').trim().match(/^\d{4}-\d{2}-\d{2}$/) ? String(v).trim() : '', error: '' }),
    formatIsoToDisplay: (v) => String(v || ''),
    parseDateValue: () => null,
    excelSerialToIso: () => null,
    todayIso: () => new Date().toISOString().slice(0, 10),
    isPlaceholderDate: (v) => !String(v || '').trim(),
  };

  function formatDisplayDateFromIso(iso) {
    return DATE_UTILS.formatIsoToDisplay(iso);
  }

  function excelSerialToIso(serialText) {
    return DATE_UTILS.excelSerialToIso(serialText);
  }

  function normalizeDateInput(value, { allowAmbiguousSlash = false } = {}) {
    // Strict mode accepts YYYY-MM-DD and Excel serials; rejects ambiguous/unsupported formats.
    return DATE_UTILS.parseDateToIso(value, { strict: !allowAmbiguousSlash, allowExcel: true });
  }

  function parseDateValue(value) {
    return DATE_UTILS.parseDateValue ? DATE_UTILS.parseDateValue(value) : (normalizeDateInput(value).iso ? new Date(`${normalizeDateInput(value).iso}T00:00:00`) : null);
  }

  function getDaysSince(dateValue) {
    const date = parseDateValue(dateValue);
    if (!date) return null;
    return Math.floor((Date.now() - date.getTime()) / 86400000);
  }

  function deriveDeviceOnlineStatus(device) {
    const daysSinceCheckIn = getDaysSince(getInventoryField(device, 'Last check-in'));
    if (daysSinceCheckIn === null) return 'Unknown';
    if (daysSinceCheckIn > 90) return 'Inactive>90days';
    return 'Active';
  }

  function getDeviceOnlineStatus(device) {
    const manualStatus = String(device['Device Online Status'] || '').trim();
    return ['Active', 'Inactive>90days', 'Unknown'].includes(manualStatus)
      ? manualStatus
      : deriveDeviceOnlineStatus(device);
  }

  function isDeviceInactive90Days(device) {
    const daysSinceCheckIn = getDaysSince(getInventoryField(device, 'Last check-in'));
    return daysSinceCheckIn === null || daysSinceCheckIn > 90;
  }

  function dateInputValue(value) {
    const result = normalizeDateInput(value, { allowAmbiguousSlash: false });
    if (result.iso) return result.iso;
    // Legacy/unparseable values: show raw text for visibility but do not coerce to a date.
    const raw = String(value ?? '').trim();
    return (DATE_UTILS.isPlaceholderDate ? DATE_UTILS.isPlaceholderDate(raw) : /^0{1,2}-jan-1900$/i.test(raw)) ? '' : raw;
  }

  function getStatusLabels() {
    const labels = App.store.get('statusLabels');
    return Array.isArray(labels) && labels.length ? labels : [
      { id: 'ready-to-deploy', name: 'Ready to Deploy', type: 'Deployable' },
      { id: 'deployed', name: 'Deployed', type: 'Deployable' },
      { id: 'awaiting-reimaging', name: 'Awaiting Re-Imaging', type: 'Pending' },
      { id: 'in-repair', name: 'In Repair', type: 'Undeployable' },
      { id: 'decommissioned', name: 'Decommissioned', type: 'Archived' },
      { id: 'archived', name: 'Archived', type: 'Archived' }
    ];
  }

  function getStatusLabelType(device) {
    const name = String(device['Status Label'] || '').trim();
    const existing = getStatusLabels().find((label) => label.name.toLowerCase() === name.toLowerCase());
    return existing?.type || (name ? 'Undeployable' : 'Deployable');
  }

  function getStatusLabelName(device) {
    if (device['Status Label']) return device['Status Label'];
    return getCurrentCheckout(device) || getPrimaryUser(device) ? 'Deployed' : 'Ready to Deploy';
  }

  function getMetaStatus(device) {
    const label = getStatusLabelName(device);
    const assigned = Boolean(getCurrentCheckout(device) || getPrimaryUser(device));
    return getStatusLabelType(device) === 'Deployable' && assigned ? 'Deployed' : label;
  }

  function getDeviceDeploymentStatusValue(device) {
    return String(device?.['deployment_status'] || '').trim();
  }

  function getDeviceConditionValue(device) {
    return String(device?.condition || '').trim();
  }

  function getDeviceDispositionMethodValue(device) {
    return String(device?.disposition_method || '').trim();
  }

  function isDeviceArchivedValue(device) {
    return device?.is_archived === true;
  }

  function buildEnumOptionsHtml(enumValues, storedValue, legacySuffix, labels) {
    const values = Array.isArray(enumValues) ? enumValues : [];
    const selected = String(storedValue || '').trim();
    const options = values.map((value) => {
      const label = labels && labels[value] ? labels[value] : value;
      return `<option value="${escapeHtml(value)}" ${selected === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    if (selected && !values.includes(selected)) {
      const label = labels && labels[selected] ? labels[selected] : selected;
      options += `<option value="${escapeHtml(selected)}" selected>${escapeHtml(`${label}${legacySuffix}`)}</option>`;
    }
    return options;
  }

  function resolveStatusLabelName(candidate) {
    const labels = getStatusLabels();
    const name = String(candidate || '').trim();
    const exact = labels.find((label) => String(label.name || '').toLowerCase() === name.toLowerCase());
    if (exact) return exact.name;
    const archivedLabel = labels.find((label) => label.type === 'Archived') || labels.find((label) => label.type === 'Deployable');
    const fallback = archivedLabel || labels[0];
    return fallback ? fallback.name : name;
  }

  function deriveStatusLabel(device) {
    const deploymentStatus = String(device?.['deployment_status'] || '').trim();
    const condition = String(device?.condition || '').trim();
    const archived = device?.is_archived === true;
    const assigned = Boolean(getCurrentCheckout(device) || getPrimaryUser(device));
    const derived = deploymentStatus === 'Disposed' ? 'Disposed'
      : deploymentStatus === 'Retired' ? 'Retired'
      : archived ? 'Archived'
      : deploymentStatus === 'Workshop' ? (condition === 'Needs Repair' ? 'In Repair' : 'Workshop')
      : deploymentStatus === 'In Use' ? (assigned ? 'Deployed' : 'In Use')
      : deploymentStatus === 'In Stock' ? 'Ready to Deploy'
      : (deploymentStatus || getStatusLabelName(device));
    return resolveStatusLabelName(derived);
  }

  function getWarrantyAge(startDateValue) {
    const start = parseDateValue(startDateValue);
    if (!start) return '—';
    const end = new Date();
    const totalMonths = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    const clampedMonths = Math.max(0, totalMonths);
    const years = Math.floor(clampedMonths / 12);
    const months = clampedMonths - years * 12;
    return `${years}y ${months}m`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function coerceRecord(rawRow) {
    // Build case-insensitive lookup map from raw CSV headers
    const ciLookup = new Map();
    Object.entries(rawRow).forEach(([key, value]) => {
      const text = value == null ? '' : String(value).trim();
      ciLookup.set(String(key || '').trim().toLowerCase(), ['null', 'undefined'].includes(text.toLowerCase()) ? '' : text);
    });
    const ciGet = (keys) => {
      for (const k of keys) {
        const v = ciGetRaw(k);
        if (v !== undefined && String(v).trim() !== '') return v;
      }
      return undefined;
    };
    const ciGetRaw = (key) => ciLookup.get(String(key || '').trim().toLowerCase());

    const record = {};
    Object.entries(rawRow).forEach(([key, value]) => {
      const text = value == null ? '' : String(value).trim();
      record[key] = ['null', 'undefined'].includes(text.toLowerCase()) ? '' : text;
    });

    const serialFromRaw = ciGet([
      'Serial number', 'serialNumber', 'Serial Number', 'IntuneGroup.SerialNumber',
      'Intune.SerialNumber', 'serial', 'Serial'
    ]) || '';

    const deviceName = ciGet([
      'Device name', 'Device Name', 'deviceName', 'Device name ', 'device name'
    ]) || 'Unknown Device';

    const deviceId = ciGet([
      'Device ID', 'DeviceId', 'deviceId', 'Device id', 'Device ID '
    ]) || 'N/A';

    const userEmail = ciGet([
      'Primary user email address', 'Primary User Email Address', 'Primary user UPN', 'User Principal Name',
      'Primary user email', 'Email Address', 'Staff Email', 'Email'
    ]) || '';
    const userDisplayName = ciGet([
      'Primary user display name', 'Primary User Display Name'
    ]) || '';
    const groupName = ciGet([
      'Intune GroupName', 'IntuneGroup.GroupName', 'IntuneGroup.Group Name', 'Intune Group GroupName',
      'Intune.GroupName', 'Group Name', 'Intune Group Name'
    ]) || '';
    const groupTag = ciGet([
      'Intune Group Tag', 'IntuneGroup.GroupTag', 'Group tag', 'Group Tag', 'GroupTag', 'Intune.Group Tag',
      'IntuneGroup GroupTag', 'GroupTag'
    ]) || '';
    const model = ciGet([
      'Model', 'Model Name', 'deviceModel', 'Device Model'
    ]) || '';
    const manufacturer = ciGet([
      'Manufacturer', 'Device Manufacturer', 'deviceManufacturer', 'Device Manufacturer Name'
    ]) || '';
    const location = ciGet([
      'Location', 'Office', 'Site', 'Office Location', 'Site Location', 'User Location', 'Staff Location'
    ]) || '';
    let storageGb = null;
    const storageBytesRaw = ciGet(['Total storage', 'Total Storage']);
    if (storageBytesRaw) {
      storageGb = parseStorageValue(storageBytesRaw, 'bytes');
    }
    if (storageGb === null) {
      const storageGbRaw = ciGet(['Total storage (GB)', 'Total Storage (GB)']);
      if (storageGbRaw) {
        storageGb = parseStorageValue(storageGbRaw, 'gb');
      }
    }

    const assetTypeInput = ciGet(['Category', 'Asset type', 'Device type', 'Device Type']);
    const deviceTypeInput = assetTypeInput || ciGet(['Category', 'Device type', 'Device Type']) || record.Type || activeDeviceType;
    let assetType = activeDeviceType || 'laptop';
    if (deviceTypeInput) {
      try {
        assetType = normalizeDeviceType(deviceTypeInput);
      } catch (error) {
        if (assetTypeInput) throw error;
      }
    }

    const deploymentStatus = ciGet([
      'Deployment Status', 'Deployment status', 'deployment_status'
    ]) || '';
    const condition = ciGet([
      'Condition', 'condition'
    ]) || '';

    const normalizeImportDate = (label, rawValue) => {
      const normalized = normalizeDateInput(rawValue, { allowAmbiguousSlash: false });
      if (normalized.error) throw new Error(`${label}: ${normalized.error}`);
      return normalized.iso;
    };

    const coerced = {
      ...record,
      'Asset type': assetType,
      deployment_status: deploymentStatus,
      condition,
      'Device ID': deviceId,
      'Device name': deviceName,
      'Serial number': serialFromRaw,
      'Primary user display name': userDisplayName,
      'Primary user email address': userEmail,
      'Primary user UPN': ciGet(['Primary user UPN', 'Primary User UPN', 'User Principal Name']) || '',
      'Intune GroupName': groupName,
      'Intune Group Tag': groupTag,
      'Model': model,
      'Manufacturer': manufacturer,
      'Location': location,
      'Total storage (GB)': storageGb === null ? '' : Number(storageGb.toFixed(2)),
      'Purchase Date': normalizeImportDate('Purchase Date', ciGet(['Purchase Date', 'Purchase date', 'purchase_date']) || ''),
      'Warranty Start Date': normalizeImportDate('Warranty Start Date', ciGet(['Warranty Start Date', 'Warranty start date']) || ''),
      'Warranty End Date': normalizeImportDate('Warranty End Date', ciGet(['Warranty End Date', 'Warranty end date']) || ''),
      'Disposal Date': normalizeImportDate('Disposal Date', ciGet(['Disposal Date', 'Disposal date', 'disposal_date']) || ''),
      'Warranty Match Status': ciGet(['Warranty Match Status']) || '',
      'Duplicate Serial': record['Duplicate Serial'] === true,
      'Last check-in': ciGet(['Last check-in', 'Last Check-In', 'Last checkin']) || '',
      'Enrollment date': ciGet(['Enrollment date', 'Enrollment Date']) || '',
      'OS version': ciGet(['OS version', 'OS Version']) || '',
      'Azure AD registered': ciGet(['Azure AD registered', 'Azure AD Registered']) || '',
      JoinType: ciGet(['JoinType', 'Join Type', 'Join type']) || '',
      'Managed by': ciGet(['Managed by', 'Managed By']) || '',
      'Device IP': ciGet(['Device IP', 'Management IP', 'Device IP Address']) || ''
    };
    // Remove retired Intune fields and legacy key variants from stored record.
    delete coerced['IntuneGroup.GroupName'];
    delete coerced['IntuneGroup.DeviceName'];
    delete coerced['IntuneGroup.SerialNumber'];
    delete coerced['Intune SerialNumber'];
    delete coerced['IntuneGroup.Model'];
    delete coerced['Intune Group Model'];
    delete coerced['IntuneGroup.Manufacturer'];
    delete coerced['Intune Group Manufacturer'];
    Object.defineProperty(coerced, IMPORT_SOURCE_VALUES, {
      value: new Map(Object.entries(rawRow).map(([key, value]) => [normalizeHeader(key), value == null ? '' : String(value).trim()])),
      enumerable: false
    });
    delete coerced['Total storage'];
    delete coerced['Total Storage'];
    delete coerced['Total Storage (GB)'];
    delete coerced['Deployment Status'];
    delete coerced['Deployment status'];
    delete coerced['Condition'];
    return coerced;
  }

  function parseCsvText(text) {
    const rows = [];
    let current = [];
    let value = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];

      if (char === '"') {
        if (inQuotes && next === '"') {
          value += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        current.push(value);
        value = '';
      } else if ((char === '\n' || char === '\r') && !inQuotes) {
        if (char === '\r' && next === '\n') i += 1;
        current.push(value);
        rows.push(current);
        current = [];
        value = '';
      } else {
        value += char;
      }
    }

    if (value.length || current.length) {
      current.push(value);
      rows.push(current);
    }

    return rows.filter((row) => row.some((cell) => String(cell).trim() !== ''));
  }

  const REMOVED_INVENTORY_IMPORT_HEADERS = new Set([
    'intune group device name', 'intunegroup devicename', 'intune serialnumber', 'intunegroup serialnumber',
    'intune group model', 'intunegroup model', 'intune group manufacturer', 'intunegroup manufacturer'
  ]);

  function getInventoryImportableHeaders() {
    // Same source of truth as template generation, plus legacy/accepted aliases.
    const templateHeaders = INVENTORY_TEMPLATE_COLUMNS.map((column) => column.header);
    const legacyAliases = [
      'Asset type', 'Device type', 'Device Type', 'OS version', 'Group Name', 'IntuneGroup.GroupName',
      'IntuneGroup.GroupTag', 'Group Tag', 'GroupTag', 'Warranty Start date', 'Warranty start date',
      'Warranty End date', 'Warranty end date', 'Primary User UPN', 'User Principal Name', 'Total storage',
      'Enrollment Date', 'Last Check-In'
    ];
    return [...templateHeaders, ...legacyAliases, ...LAYOUT_COLUMNS, ...DEFAULT_COLUMNS];
  }

  function validateInventoryImportColumns(headerRow) {
    const normalizedHeaders = headerRow.map((header) => normalizeHeader(header));
    const databaseColumns = new Set(getInventoryImportableHeaders().map(normalizeHeader));
    const recognized = [];
    const unrecognized = [];
    normalizedHeaders.forEach((header, index) => {
      if (['device online status', 'age', 'actions', 'assigned assets'].includes(header)) {
        unrecognized.push(header);
        return;
      }
      if (REMOVED_INVENTORY_IMPORT_HEADERS.has(header)) {
        unrecognized.push(`${normalizeHeader(headerRow[index])} (removed/ignored)`);
        return;
      }
      if (databaseColumns.has(header) || header === 'category') recognized.push(header);
      else unrecognized.push(header);
    });
    const missingRequired = ['device name', 'serial number'].filter((key) => !normalizedHeaders.includes(key));
    return { recognized, unrecognized, missingRequired };
  }

  function normalizeImportHeader(header) {
    const normalized = normalizeHeader(header);
    const aliases = {
      'intune groupname': 'intunegroup groupname',
      'intune group groupname': 'intunegroup groupname',
      'intune group tag': 'intunegroup grouptag',
      'group tag': 'intunegroup grouptag',
      'primary user upn': 'primary user upn',
      'category': 'asset type',
      'os version': 'os version'
    };
    return aliases[normalized] || normalized;
  }

  function parseInventoryCsv(text) {
    const rows = parseCsvText(text);
    if (rows.length < 2) throw new Error('CSV file is empty or missing a header row.');

    const headerRow = rows[0].map((header) => String(header || '').trim());
    const lookup = {};
    headerRow.forEach((header, index) => {
      lookup[normalizeHeader(header)] = index;
    });

    const required = ['device name', 'serial number'];
    const missing = required.filter((key) => lookup[key] === undefined);
    if (missing.length) {
      throw new Error('Missing required CSV columns: ' + missing.join(', '));
    }

    const records = [];
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row.some((cell) => String(cell || '').trim())) continue;
      const raw = {};
      headerRow.forEach((header, headerIndex) => {
        raw[header] = row[headerIndex] || '';
      });
      records.push(coerceRecord(raw));
    }

    if (!records.length) throw new Error('No valid rows were found in the CSV file.');
    return { rows: records, headers: headerRow, validation: validateInventoryImportColumns(headerRow) };
  }

  const IMPORT_COLUMN_LABELS = {
    'device id': 'Device ID',
    'device name': 'Device name',
    'asset type': 'Asset type',
    'deployment status': 'Deployment Status',
    condition: 'Condition',
    os: 'OS',
    'primary user upn': 'Primary user UPN',
    'intunegroup groupname': 'Intune GroupName',
    'total storage': 'Total storage (GB)',
    'total storage gb': 'Total storage (GB)',
    lob: 'LOB',
    model: 'Model',
    'group tag': 'Group Tag',
    'intunegroup grouptag': 'Group Tag',
    manufacturer: 'Manufacturer',
    'serial number': 'Serial number',
    'os version': 'OS Version',
    'azure ad registered': 'Azure AD registered',
    jointype: 'JoinType',
    'join type': 'JoinType',
    'enrollment date': 'Enrollment date',
    'managed by': 'Managed by',
    'device ip': 'Device IP',
    'management ip': 'Device IP',
    'warranty start date': 'Warranty Start Date',
    'warranty end date': 'Warranty End Date',
    'warranty match status': 'Warranty Match Status',
    'last check in': 'Last check-in'
  };

  function renderImportReport({ title, summaryLines = [], recognizedColumns = [], unrecognizedColumns = [], selectableColumns = null }) {
    const summaryHtml = summaryLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('');
    const recognizedList = selectableColumns
      ? `<ul>${selectableColumns.map(({ key, label }) => `<li><label class="import-column-choice"><input type="checkbox" data-import-column="${escapeHtml(key)}" ${normalizeImportHeader(key) === 'serial number' ? 'checked disabled' : 'checked'}> ${escapeHtml(label)}${normalizeImportHeader(key) === 'serial number' ? ' (required)' : ''}</label></li>`).join('')}</ul>`
      : recognizedColumns.length
      ? `<ul>${recognizedColumns.map((column) => `<li>${escapeHtml(column)}</li>`).join('')}</ul>`
      : `<p>No recognized columns found.</p>`;
    const unrecognizedList = unrecognizedColumns.length
      ? `<ul>${unrecognizedColumns.map((column) => `<li>${escapeHtml(column)}</li>`).join('')}</ul>`
      : `<p>None</p>`;
    return `
      <div class="import-report">
        <div class="import-report-title">${escapeHtml(title)}</div>
        ${summaryHtml}
        <div class="import-report-section"><strong style="color: var(--green);">Recognized columns (will be updated):</strong> ${recognizedList}</div>
        <div class="import-report-section"><strong style="color: var(--red);">Unrecognized columns:</strong> ${unrecognizedList}</div>
      </div>`;
  }

  function selectedImportRecord(record, selectedHeaders) {
    const aliases = {
      'Asset type': ['Asset type', 'Device type', 'Type'],
      'Device name': ['Device name', 'Device Name', 'deviceName'],
      'Serial number': ['Serial number', 'Serial Number', 'serialNumber', 'Serial'],
      'Device ID': ['Device ID', 'DeviceId', 'deviceId', 'Device id'],
      'Primary user email address': ['Primary user email address', 'Primary User Email Address', 'Primary user UPN', 'User Principal Name'],
      'Primary user UPN': ['Primary user UPN', 'Primary User UPN', 'User Principal Name'],
      'Primary user display name': ['Primary user display name', 'Primary User Display Name'],
      'IntuneGroup.GroupName': ['IntuneGroup.GroupName', 'IntuneGroup.Group Name', 'Intune GroupName', 'Intune Group GroupName', 'Group Name'],
      'IntuneGroup.GroupTag': ['IntuneGroup.GroupTag', 'Group tag', 'Group Tag', 'GroupTag'],
      'Total storage (GB)': ['Total storage (GB)', 'Total Storage (GB)', 'Total storage'],
      'Model': ['Model', 'Device Model', 'deviceModel'],
      'Manufacturer': ['Manufacturer', 'Device Manufacturer', 'deviceManufacturer'],
      'Location': ['Location', 'Office', 'Site', 'Office Location', 'Site Location'],
      'IntuneGroup.SerialNumber': ['IntuneGroup.SerialNumber', 'Serial number', 'Serial Number', 'serialNumber', 'Serial']
    };
    const selected = new Set(selectedHeaders.map(normalizeImportHeader));
    const filtered = {};
    Object.entries(record).forEach(([field, value]) => {
      if (field === 'Device Online Status' || field === 'Age' || field === 'Duplicate Serial') return;
      const sourceHeaders = aliases[field] || [field];
      if (sourceHeaders.some((header) => selected.has(normalizeImportHeader(header)))) filtered[field] = value;
    });
    const sourceValues = record[IMPORT_SOURCE_VALUES];
    if (sourceValues instanceof Map) {
      const filteredSourceValues = new Map(Array.from(sourceValues).filter(([header]) => selected.has(normalizeImportHeader(header))));
      Object.defineProperty(filtered, IMPORT_SOURCE_VALUES, { value: filteredSourceValues, enumerable: false });
    }
    return filtered;
  }

  function validateWarrantyImportColumns(headerRow) {
    const normalizedHeaders = headerRow.map((header) => normalizeHeader(header));
    const databaseColumns = ['serial number', 'warranty start date', 'warranty end date', 'warranty match status', 'last check in'];
    const recognized = [];
    const unrecognized = [];
    normalizedHeaders.forEach((header) => {
      if (databaseColumns.includes(header)) recognized.push(header);
      else unrecognized.push(header);
    });
    const missingRequired = ['serial number'].filter((key) => !normalizedHeaders.includes(key));
    return { recognized, unrecognized, missingRequired };
  }

  function parseWarrantyCsv(text) {
    const rows = parseCsvText(text);
    if (rows.length < 2) throw new Error('Warranty CSV file is empty or missing a header row.');

    const headerRow = rows[0].map((header) => String(header || '').trim());
    const lookup = {};
    headerRow.forEach((header, index) => {
      lookup[normalizeHeader(header)] = index;
    });

    const required = ['serial number'];
    const missing = required.filter((key) => lookup[key] === undefined);
    if (missing.length) {
      throw new Error('Missing required warranty columns: Serial number');
    }

    const records = [];
    const seen = new Set();
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row.some((cell) => String(cell || '').trim())) continue;

      const raw = {};
      headerRow.forEach((header, headerIndex) => {
        raw[header] = row[headerIndex] || '';
      });

      const serial = raw['Serial number'] || raw['serialNumber'] || raw['Serial Number'] || raw['serial'] || raw['Serial'] || '';
      const startDate = raw['Warranty Start Date'] || raw['Warranty Start date'] || raw['Warranty start date'] || '';
      const endDate = raw['Warranty End Date'] || raw['Warranty end date'] || raw['Warranty end Date'] || '';
      const serialTrimmed = String(serial || '').trim();

      if (!serialTrimmed) continue;

      const serialKey = normalizeSerialKey(serialTrimmed);
      if (seen.has(serialKey)) {
        continue;
      }
      seen.add(serialKey);

      const ws = normalizeDateInput(startDate, { allowAmbiguousSlash: false });
      if (ws.error) throw new Error(`Warranty Start Date: ${ws.error}`);
      const we = normalizeDateInput(endDate, { allowAmbiguousSlash: false });
      if (we.error) throw new Error(`Warranty End Date: ${we.error}`);
      records.push({
        'Serial number': serialTrimmed,
        'Warranty Start Date': ws.iso,
        'Warranty End Date': we.iso
      });
    }

    if (!records.length) throw new Error('No valid warranty rows were found in the CSV file.');
    return { rows: records, headers: headerRow, validation: validateWarrantyImportColumns(headerRow) };
  }

  function createSampleInventory() {
    return [
      { 'Device ID': 'INT-1001', 'Device name': 'LAP-SG-001', Ownership: 'Corporate', Compliance: 'Compliant', OS: 'Windows 11', 'OS version': '23H2', 'Primary user email address': 'alex.ng@contoso.com', 'Primary user UPN': 'alex.ng@contoso.com', 'Last check-in': '2025-09-20', 'Enrollment date': '2024-01-15', Model: 'Latitude 5440', Manufacturer: 'Dell', 'Serial number': 'SG-1001', 'Primary user display name': 'Alex Ng', 'Total storage': '512000000000', 'Free storage': '82000000000', 'Azure AD registered': 'Yes', 'Intune GroupName': 'Intune-SG', 'Intune Group Tag': 'SG', WindowsVersion: 'Windows 11', 'Total storage (GB)': 476.84, 'Warranty End Date': '2026-08-21', 'Warranty Start Date': '2024-08-21' },
      { 'Device ID': 'INT-1002', 'Device name': 'LAP-SG-002', Ownership: 'Corporate', Compliance: 'Non-Compliant', OS: 'Windows 11', 'OS version': '22H2', 'Primary user email address': 'lamia@contoso.com', 'Primary user UPN': 'lamia@contoso.com', 'Last check-in': '2025-09-18', 'Enrollment date': '2023-12-11', Model: 'EliteBook 840', Manufacturer: 'HP', 'Serial number': 'SG-1002', 'Primary user display name': 'Lamia Ali', 'Total storage': '512000000000', 'Free storage': '120000000000', 'Azure AD registered': 'Yes', 'Intune GroupName': 'Intune-SG', 'Intune Group Tag': 'SG', WindowsVersion: 'Windows 11', 'Total storage (GB)': 476.84, 'Warranty End Date': '2025-10-11', 'Warranty Start Date': '2023-10-11' },
      { 'Device ID': 'INT-1003', 'Device name': 'LAP-MY-001', Ownership: 'BYOD', Compliance: 'Compliant', OS: 'Windows 10', 'OS version': '22H2', 'Primary user email address': 'tina.wong@contoso.com', 'Primary user UPN': 'tina.wong@contoso.com', 'Last check-in': '2025-09-15', 'Enrollment date': '2024-02-10', Model: 'ThinkPad X1 Carbon', Manufacturer: 'Lenovo', 'Serial number': 'MY-1003', 'Primary user display name': 'Tina Wong', 'Total storage': '512000000000', 'Free storage': '300000000000', 'Azure AD registered': 'Yes', 'Intune GroupName': 'Intune-MY', 'Intune Group Tag': 'MY', WindowsVersion: 'Windows 10', 'Total storage (GB)': 476.84, 'Warranty End Date': '2027-02-18', 'Warranty Start Date': '2024-02-18' },
      { 'Device ID': 'INT-1004', 'Device name': 'LAP-TH-001', Ownership: 'Corporate', Compliance: 'Compliant', OS: 'Windows 11', 'OS version': '24H2', 'Primary user email address': 'nattapong.s@contoso.com', 'Primary user UPN': 'nattapong.s@contoso.com', 'Last check-in': '2025-09-07', 'Enrollment date': '2024-03-05', Model: 'XPS 13', Manufacturer: 'Dell', 'Serial number': 'TH-1004', 'Primary user display name': 'Nattapong S.', 'Total storage': '256000000000', 'Free storage': '168000000000', 'Azure AD registered': 'No', 'Intune GroupName': 'Intune-TH', 'Intune Group Tag': 'TH', WindowsVersion: 'Windows 11', 'Total storage (GB)': 238.42, 'Warranty End Date': '2025-11-29', 'Warranty Start Date': '2023-11-29' },
      { 'Device ID': 'INT-1005', 'Device name': 'LAP-PH-001', Ownership: 'Corporate', Compliance: 'Unknown', OS: 'Windows 10', 'OS version': '21H2', 'Primary user email address': 'enrico.delacruz@contoso.com', 'Primary user UPN': 'enrico.delacruz@contoso.com', 'Last check-in': '2025-09-16', 'Enrollment date': '2023-09-12', Model: 'Latitude 5530', Manufacturer: 'Dell', 'Serial number': 'PH-1005', 'Primary user display name': 'Enrico Dela Cruz', 'Total storage': '512000000000', 'Free storage': '210000000000', 'Azure AD registered': 'Yes', 'Intune GroupName': 'Intune-PH', 'Intune Group Tag': 'PH', WindowsVersion: 'Windows 10', 'Total storage (GB)': 476.84, 'Warranty End Date': '2026-01-17', 'Warranty Start Date': '2024-01-17' },
      { 'Device ID': 'INT-1006', 'Device name': 'LAP-SG-003', Ownership: 'Corporate', Compliance: 'Compliant', OS: 'macOS', 'OS version': '14.7', 'Primary user email address': 'karen.li@contoso.com', 'Primary user UPN': 'karen.li@contoso.com', 'Last check-in': '2025-09-21', 'Enrollment date': '2024-04-02', Model: 'MacBook Pro 14', Manufacturer: 'Apple', 'Serial number': 'SG-1006', 'Primary user display name': 'Karen Li', 'Total storage': '1000000000000', 'Free storage': '460000000000', 'Azure AD registered': 'Yes', 'Intune GroupName': 'Intune-SG', 'Intune Group Tag': 'SG', WindowsVersion: 'macOS', 'Total storage (GB)': 931.32, 'Warranty End Date': '2026-03-27', 'Warranty Start Date': '2024-03-27' },
      { 'Device ID': 'INT-1007', 'Device name': 'LAP-MY-002', Ownership: 'Employee Owned', Compliance: 'Compliant', OS: 'Windows 11', 'OS version': '23H2', 'Primary user email address': 'adrian.tan@contoso.com', 'Primary user UPN': 'adrian.tan@contoso.com', 'Last check-in': '2025-09-03', 'Enrollment date': '2023-07-09', Model: 'Surface Laptop 5', Manufacturer: 'Microsoft', 'Serial number': 'MY-1007', 'Primary user display name': 'Adrian Tan', 'Total storage': '512000000000', 'Free storage': '390000000000', 'Azure AD registered': 'Yes', 'Intune GroupName': 'Intune-MY', 'Intune Group Tag': 'MY', WindowsVersion: 'Windows 11', 'Total storage (GB)': 476.84, 'Warranty End Date': '2026-10-07', 'Warranty Start Date': '2024-10-07' },
      { 'Device ID': 'INT-1008', 'Device name': 'LAP-TH-002', Ownership: 'Corporate', Compliance: 'Compliant', OS: 'Windows 11', 'OS version': '23H2', 'Primary user email address': 'saran.chai@contoso.com', 'Primary user UPN': 'saran.chai@contoso.com', 'Last check-in': '2025-09-11', 'Enrollment date': '2024-08-15', Model: 'ThinkPad T14', Manufacturer: 'Lenovo', 'Serial number': 'TH-1008', 'Primary user display name': 'Saran Chai', 'Total storage': '512000000000', 'Free storage': '240000000000', 'Azure AD registered': 'Yes', 'Intune GroupName': 'Intune-TH', 'Intune Group Tag': 'TH', WindowsVersion: 'Windows 11', 'Total storage (GB)': 476.84, 'Warranty End Date': '2028-04-12', 'Warranty Start Date': '2025-04-12' },
      { 'Device ID': 'INT-1009', 'Device name': 'LAP-PH-002', Ownership: 'Corporate', Compliance: 'Non-Compliant', OS: 'Windows 11', 'OS version': '24H2', 'Primary user email address': 'norah.fernandez@contoso.com', 'Primary user UPN': 'norah.fernandez@contoso.com', 'Last check-in': '2025-09-12', 'Enrollment date': '2024-11-18', Model: 'EliteBook 865', Manufacturer: 'HP', 'Serial number': 'PH-1009', 'Primary user display name': 'Norah Fernandez', 'Total storage': '512000000000', 'Free storage': '170000000000', 'Azure AD registered': 'Yes', 'Intune GroupName': 'Intune-PH', 'Intune Group Tag': 'PH', WindowsVersion: 'Windows 11', 'Total storage (GB)': 476.84, 'Warranty End Date': '2026-06-05', 'Warranty Start Date': '2024-06-05' },
      { 'Device ID': 'INT-1010', 'Device name': 'LAP-SG-004', Ownership: 'Corporate', Compliance: 'Compliant', OS: 'Windows 11', 'OS version': '23H2', 'Primary user email address': 'mokhtar.ismail@contoso.com', 'Primary user UPN': 'mokhtar.ismail@contoso.com', 'Last check-in': '2025-09-02', 'Enrollment date': '2023-02-24', Model: 'ZenBook 14', Manufacturer: 'ASUS', 'Serial number': 'SG-1010', 'Primary user display name': 'Mokhtar Ismail', 'Total storage': '1000000000000', 'Free storage': '550000000000', 'Azure AD registered': 'Yes', 'Intune GroupName': 'Intune-SG', 'Intune Group Tag': 'SG', WindowsVersion: 'Windows 11', 'Total storage (GB)': 931.32, 'Warranty End Date': '2025-12-22', 'Warranty Start Date': '2023-12-22' }
    ];
  }

  function escapeCsv(value) {
    const text = value == null ? '' : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportCurrentInventory(includeAllColumns = false) {
    const rows = getInventory();
    const filteredRows = getFilteredRows(rows, App.countryFilter);
    const allColumns = Array.from(new Set([
      ...DEFAULT_COLUMNS.filter((column) => !['deployment_status', 'condition'].includes(column)),
      'Deployment Status',
      'Hardware Health',
      ...rows.flatMap((device) => Object.keys(device)),
      'Purchase Date',
      'Warranty Start Date',
      'Warranty End Date',
      'Disposal Date',
      'Warranty Match Status'
    ]));
    const columns = (includeAllColumns ? allColumns : getVisibleColumns())
      .filter((column) => allColumns.includes(column))
      .filter((column) => normalizeHeader(column) !== normalizeHeader('Total storage'))
      .filter((column) => !['Management IP', 'OS Version', 'Azure AD Registered', 'Join Type', 'Join type', 'Enrollment Date', 'Managed By', 'Device IP Address'].includes(column));

    const csvRows = [columns.map(escapeCsv).join(',')].concat(
      filteredRows.map((device) => columns.map((column) => escapeCsv(column === 'Deployment Status'
        ? getDeviceDeploymentStatusValue(device) || getMetaStatus(device)
        : column === 'Hardware Health'
        ? String(getDeviceConditionValue(device) || '').trim()
        : column === 'Total storage (GB)'
        ? getTotalStorageGb(device)
        : column === 'Age'
        ? getWarrantyAge(getInventoryField(device, 'Warranty Start Date'), getInventoryField(device, 'Warranty End Date'))
        : column === 'Device Online Status'
          ? getDeviceOnlineStatus(device)
          : ['Purchase Date', 'Warranty Start Date', 'Warranty End Date', 'Disposal Date'].includes(column)
            ? (dateInputValue(getInventoryField(device, column)) || '')
            : getInventoryField(device, column))).join(','))
    );

    const blob = new Blob([`\uFEFF${csvRows.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'IT-Asset-Inventory-' + new Date().toISOString().slice(0, 10) + '.csv';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    Toast.show('Inventory export generated.', 'success');
  }

  function promptInventoryExport() {
    Modal.open({
      title: 'Export inventory CSV',
      confirmText: 'Export CSV',
      body: `<p>Choose which columns to include. The current search and filters still determine which devices are exported.</p>
        <label class="duplicate-choice"><input type="radio" name="inventoryExportColumns" value="active" checked> Active columns (currently visible)</label>
        <label class="duplicate-choice"><input type="radio" name="inventoryExportColumns" value="all"> All columns in the inventory</label>`,
      onConfirm: () => {
        const all = document.querySelector('input[name="inventoryExportColumns"]:checked')?.value === 'all';
        Modal.close();
        exportCurrentInventory(all);
      }
    });
  }

  async function importInventoryCsvFile(file, context = {}) {
    if (!file) return;
    const container = context.container || document.getElementById('moduleContainer');
    const country = context.country ?? App.countryFilter;
    try {
      const { rows: imported, validation: inventoryValidation } = parseInventoryCsv(await file.text());
      const duplicateCount = countImportDuplicates(getInventory(), imported);
      let importRows = imported;
      let selectedRecognizedColumns = inventoryValidation.recognized;
      const saveImport = (keepDuplicates) => {
        try {
          const result = applyInventoryImport(importRows, keepDuplicates);
          selectedDeviceIndexes.clear();
          Modal.close();
          if (App.currentModule === 'inventory' && container) render(container, country);
          const parts = [`${result.added} added`, `${result.merged} merged`];
          if (result.duplicatesKept) parts.push(`${result.duplicatesKept} duplicate${result.duplicatesKept === 1 ? '' : 's'} kept`);

          const selectedSet = new Set(selectedRecognizedColumns);
          const ignoredRecognized = inventoryValidation.recognized.filter((col) => !selectedSet.has(col));
          const ignoredAll = [...inventoryValidation.unrecognized, ...ignoredRecognized];
          if (ignoredAll.length) {
            const ignoredLabels = ignoredAll.map((col) => IMPORT_COLUMN_LABELS[col] || col).join(', ');
            console.log(`[CSV Import] Columns present but ignored: ${ignoredLabels}`);
            parts.push(`${ignoredAll.length} column${ignoredAll.length === 1 ? '' : 's'} present but not imported: ${ignoredLabels}`);
          }

          Modal.open({
            title: 'Inventory Import Report',
            body: renderImportReport({
              title: 'Inventory Import Report',
              summaryLines: parts,
              recognizedColumns: selectedRecognizedColumns.map((column) => IMPORT_COLUMN_LABELS[column] || column),
              unrecognizedColumns: inventoryValidation.unrecognized
            }),
            onConfirm: () => Modal.close(),
            confirmText: 'Close',
            size: 'lg'
          });
        } catch (error) {
          Modal.close();
          Toast.show(`CSV import could not be saved: ${error.message || error}`, 'error');
        }
      };
      const reviewDuplicates = () => {
        if (!duplicateCount) {
          saveImport(false);
          return;
        }
        Modal.open({
          title: 'Duplicate serial numbers found',
          confirmText: 'Continue import',
          body: `<p>${duplicateCount} duplicate serial-number record${duplicateCount === 1 ? '' : 's'} found. Choose how to handle them:</p>
            <label class="duplicate-choice"><input type="radio" name="duplicateImportMode" value="merge" checked> Merge into the existing device record</label>
            <label class="duplicate-choice"><input type="radio" name="duplicateImportMode" value="keep"> Keep each as a separate device (append -1, -2, etc.)</label>`,
          onConfirm: () => saveImport(document.querySelector('input[name="duplicateImportMode"]:checked')?.value === 'keep')
        });
      };
      Modal.open({
        title: 'Review inventory CSV columns',
        confirmText: 'Proceed to import',
        body: `<p>All recognized columns are selected by default. Uncheck optional columns you do not want to import.</p>${renderImportReport({
          title: `${imported.length} device row${imported.length === 1 ? '' : 's'} ready for review`,
          selectableColumns: inventoryValidation.recognized.map((column) => ({ key: column, label: IMPORT_COLUMN_LABELS[column] || column })),
          unrecognizedColumns: inventoryValidation.unrecognized
        })}`,
        onConfirm: () => {
          const checked = Array.from(document.querySelectorAll('#modalBody input[data-import-column]:checked'));
          selectedRecognizedColumns = checked.map((input) => input.dataset.importColumn);
          importRows = imported.map((record) => selectedImportRecord(record, selectedRecognizedColumns));
          Modal.close();
          reviewDuplicates();
        },
        size: 'lg'
      });
    } catch (error) {
      Toast.show(error.message || 'CSV import failed.', 'error');
    }
  }

  function downloadCsvTemplateFile(filename, headerRow, sampleRow) {
    const csv = [
      headerRow.map(escapeCsv).join(','),
      sampleRow.map((column) => escapeCsv(column ?? '')).join(',')
    ].join('\r\n');
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // Single source of truth for importable CSV/template columns (programmatic; not hand-maintained per download).
  const INVENTORY_TEMPLATE_COLUMNS = [
    { header: 'Category', example: 'laptop' },
    { header: 'Fixed Asset Number', example: 'FA-000123' },
    { header: 'Device ID', example: 'INT-1001' },
    { header: 'Device name', example: 'LAP-SG-001' },
    { header: 'Serial number', example: 'SG-1001' },
    { header: 'Deployment Status', example: 'In Use' },
    { header: 'Condition', example: 'Good' },
    { header: 'Country', example: 'Singapore' },
    { header: 'Ownership', example: 'Corporate' },
    { header: 'Compliance', example: 'Compliant' },
    { header: 'OS', example: 'Windows 11' },
    { header: 'OS Version', example: '23H2' },
    { header: 'JoinType', example: 'Azure AD joined' },
    { header: 'Managed by', example: 'MDM' },
    { header: 'Primary user email address', example: 'alex.ng@contoso.com' },
    { header: 'Primary user UPN', example: 'alex.ng@contoso.com' },
    { header: 'Primary user display name', example: 'Alex Ng' },
    { header: 'Enrollment date', example: '2024-01-15' },
    { header: 'Last check-in', example: '2026-11-01' },
    { header: 'Model', example: 'Latitude 5440' },
    { header: 'Manufacturer', example: 'Dell' },
    { header: 'Intune GroupName', example: 'SG-Laptops' },
    { header: 'Intune Group Tag', example: 'SG' },
    { header: 'Total storage (GB)', example: '512' },
    { header: 'Free storage', example: '123456789012' },
    { header: 'Location', example: 'Singapore' },
    { header: 'Device IP', example: '10.10.20.31' },
    { header: 'Firmware version', example: '1.12.0' },
    { header: 'UPS Capacity (VA)', example: '' },
    { header: 'Battery replacement date', example: '' },
    { header: 'Purchase Date', example: '2021-12-05' },
    { header: 'Warranty Start Date', example: '2024-01-15' },
    { header: 'Warranty End Date', example: '2027-01-14' },
    { header: 'Disposal Date', example: '' },
    { header: 'Azure AD registered', example: 'YES' }
  ];
  const INVENTORY_TEMPLATE_EXCLUDED = [
    { column: 'Age', reason: 'Computed from Warranty Start Date to today (display-only).' },
    { column: 'Last check-in', reason: 'Included as importable data when available, but treated as device-reported time; not system-generated by this template.' },
    { column: 'Device Online Status', reason: 'Derived/displayed status; managed by the system/UI.' },
    { column: 'Compliance', reason: 'Synced/reported status in managed environments; included for import but often system-managed.' },
    { column: 'ACTIONS', reason: 'UI-only controls, not a data column.' },
    { column: 'Warranty Match Status', reason: 'Computed/system-managed during warranty matching.' },
    { column: 'Duplicate Serial', reason: 'System-managed import/comparison flag.' },
    { column: 'deployment_status', reason: 'Internal storage field; use "Deployment Status" header instead.' },
    { column: 'condition', reason: 'Internal storage field; use "Condition" header instead.' },
    { column: 'Internal IDs/positions', reason: 'Auto/system-managed database identifiers are not import columns.' }
  ];
  // Computed/system-managed columns excluded from Asset Inventory template:
  // - Age: computed from Warranty Start Date to today.
  // - Device Online Status: derived from Last check-in / manual override display logic.
  // - Warranty Match Status: system-managed by warranty matching.
  // - Duplicate Serial: system-managed flag.
  // - ACTIONS: UI-only.
  // - Internal DB identifiers/positions: auto-managed.
  const USER_TEMPLATE_COLUMNS = [
    { header: 'USER ID', example: 'USR-0001' },
    { header: 'NAME', example: 'Alex User' },
    { header: 'STAFF TYPE', example: 'Internal Staff' },
    { header: 'EMAIL', example: 'alex.user@example.com' },
    { header: 'ACCOUNT ACTIVE', example: 'YES' },
    { header: 'COUNTRY', example: 'Singapore' },
    { header: 'LOCATION', example: 'Singapore HQ' }
  ];
  // Computed/system-managed columns excluded from User DB template:
  // - ASSIGNED ASSETS: derived from inventory/checkouts.
  // - Auto primary keys/internal record IDs: system-managed (USER ID may be supplied; if omitted system handling applies).

  function buildInventoryTemplateDefinition() {
    return {
      id: 'inventory',
      label: 'Inventory template',
      filename: 'nexit-csv-template-inventory.csv',
      headerRow: INVENTORY_TEMPLATE_COLUMNS.map((column) => column.header),
      sampleRow: INVENTORY_TEMPLATE_COLUMNS.map((column) => column.example)
    };
  }

  function buildUserTemplateDefinition() {
    return {
      id: 'users',
      label: 'User list template',
      filename: 'nexit-csv-template-users.csv',
      headerRow: USER_TEMPLATE_COLUMNS.map((column) => column.header),
      sampleRow: USER_TEMPLATE_COLUMNS.map((column) => column.example)
    };
  }

  function openCsvTemplateModal() {
    const templates = [buildInventoryTemplateDefinition(), buildUserTemplateDefinition()];
    Modal.open({
      title: 'CSV Template Samples',
      confirmText: 'Download template',
      body: `<div class="csv-templates">
        ${templates.map((template, index) => `<label class="csv-template-option">
          <input type="radio" name="csvTemplateChoice" value="${template.id}" ${index === 0 ? 'checked' : ''} />
          <span class="csv-template-name">${escapeHtml(template.label)}</span>
          <pre class="csv-template-preview">${escapeHtml(template.headerRow.join(','))}\n${escapeHtml(template.sampleRow.map((value) => value ?? '').join(','))}</pre>
        </label>`).join('')}
        <p class="form-help">Headers are generated from the app's column definitions (single source of truth). Dates use YYYY-MM-DD (e.g. 2025-12-05). Booleans use YES/NO. Excel may mangle leading zeros and long numeric strings; import via <strong>Data → From Text/CSV</strong> and set ID/code columns to <strong>Text</strong> (quoting alone does not prevent coercion). UTF-8 with BOM is used for Excel compatibility.</p>
      </div>`,
      onConfirm: () => {
        const selectedId = document.querySelector('input[name="csvTemplateChoice"]:checked')?.value;
        const selected = templates.find((template) => template.id === selectedId) || templates[0];
        downloadCsvTemplateFile(selected.filename, selected.headerRow, selected.sampleRow);
        Modal.close();
        Toast.show(`CSV template (${selected.label}) downloaded.`, 'success');
      }
    });
  }

  function getDeviceSearchText(device) {
    const parts = [];
    Object.keys(device || {}).forEach((key) => {
      const value = device[key];
      if (value === null || value === undefined) return;
      if (typeof value === 'object') {
        Object.keys(value).forEach((nestedKey) => {
          const nestedValue = value[nestedKey];
          if (nestedValue === null || nestedValue === undefined) return;
          const text = String(nestedValue).trim().toLowerCase();
          if (text) parts.push(`${nestedKey} ${text}`.toLowerCase());
        });
        return;
      }
      const text = String(value).trim().toLowerCase();
      if (text) parts.push(`${key} ${text}`.toLowerCase());
    });
    const statusText = `status ${getMetaStatus(device)} label ${getStatusLabelName(device)} ${getStatusLabelType(device)}`.toLowerCase();
    if (statusText.trim()) parts.push(statusText);
    const checkout = getCurrentCheckout(device);
    const primaryUser = getPrimaryUser(device);
    if (checkout || primaryUser) {
      const custodian = checkout || primaryUser;
      const checkedOutText = `checked out ${custodian['Staff name'] || custodian.name} ${custodian['Staff email'] || custodian.email} ${checkout?.['Expected return date'] || ''}`.toLowerCase();
      if (checkedOutText.trim()) parts.push(checkedOutText);
      if (checkout && isReturnOverdue(checkout)) parts.push('overdue');
    } else {
      parts.push('available');
    }
    const result = parts.join(' ');
    return result;
  }

  function replacementSummaryForDevice(device) {
    try {
      const serial = device?.['Serial number'] || device?.['serial_number'] || '';
      const mod = App.modules?.replacements;
      if (mod && typeof mod.summaryForSerial === 'function') return mod.summaryForSerial(serial) || {};
    } catch {}
    return {};
  }

  function getInventoryFilterFieldValue(device, field) {
    const rep = (field === 'replacementStatus' || field === 'replacementCount' || field === 'oldDeviceOutcome') ? replacementSummaryForDevice(device) : null;
    switch (field) {
      case 'deploymentStatus':
        return String(device?.deployment_status ?? device?.['Deployment Status'] ?? '').trim();
      case 'condition':
        return String(device?.condition ?? device?.['Hardware Health'] ?? '').trim();
      case 'model':
        return String(device?.Model ?? device?.['Model'] ?? '').trim();
      case 'manufacturer':
        return String(device?.Manufacturer ?? device?.['Manufacturer'] ?? '').trim();
      case 'location': {
        const users = App.store.get('users') || [];
        const primaryEmail = String(device?.['Primary user email address'] || device?.['Primary user UPN'] || '').trim().toLowerCase();
        const user = primaryEmail ? users.find((u) => String(u?.Email || '').trim().toLowerCase() === primaryEmail) : null;
        return String(user?.Location || device?.Location || device?.['Location'] || '').trim();
      }
      case 'replacementStatus':
        return String(rep?.['Replacement Status'] ?? '').trim();
      case 'replacementCount': {
        const v = rep?.['Replacement Count'];
        if (v === null || v === undefined || String(v).trim() === '') return '';
        return String(v).trim();
      }
      case 'oldDeviceOutcome':
        return String(rep?.['old_device_outcome'] ?? '').trim();
      default:
        return '';
    }
  }

  function matchesInventoryFilterValue(value, selected) {
    if (!selected) return true;
    const normalized = String(value ?? '').trim();
    if (selected === BLANK_FILTER_VALUE) return normalized === '';
    return normalized === String(selected).trim();
  }

  function getDistinctInventoryFilterOptions(rows, field) {
    const values = new Set();
    (rows || []).forEach((device) => {
      const v = getInventoryFilterFieldValue(device, field);
      if (v !== '') values.add(v);
    });
    let list = Array.from(values);
    if (field === 'replacementCount') {
      list.sort((a, b) => {
        const na = Number(a), nb = Number(b);
        const aNum = Number.isFinite(na) && String(na) === String(a).trim();
        const bNum = Number.isFinite(nb) && String(nb) === String(b).trim();
        if (aNum && bNum) return na - nb;
        if (aNum) return -1;
        if (bNum) return 1;
        return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
      });
    } else {
      list.sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
    }
    return [{ value: BLANK_FILTER_VALUE, label: BLANK_FILTER_LABEL }, ...list.map((v) => ({ value: v, label: v }))];
  }

  const INVENTORY_FILTER_FIELDS = [
    { key: 'deploymentStatus', label: 'Deployment Status', more: false },
    { key: 'condition', label: 'Hardware Health', more: false },
    { key: 'model', label: 'Model', more: true },
    { key: 'manufacturer', label: 'Manufacturer', more: true },
    { key: 'location', label: 'Location', more: true },
    { key: 'replacementStatus', label: 'Replacement Status', more: true },
    { key: 'replacementCount', label: 'Replacement Count', more: true },
    { key: 'oldDeviceOutcome', label: 'Old Device Outcome', more: true },
  ];

  function hasActiveInventoryFilters() {
    if (filterState.duplicatesOnly || filterState.showArchived) return true;
    if (warrantyStatusFilter) return true;
    return INVENTORY_FILTER_FIELDS.some(({ key }) => !!filterState[key]);
  }

  function getFilteredRows(rows, countryFilter = App.countryFilter, searchValue = null) {
    if (searchValue === null) {
      const searchBox = document.getElementById('inventorySearch');
      searchValue = (searchBox ? searchBox.value : (initialSearchFromUrl || '')).trim().toLowerCase();
    } else {
      searchValue = String(searchValue || '').trim().toLowerCase();
    }
    const warrantyValue = warrantyStatusFilter;
    const deviceIndexMap = new Map(rows.map((device, index) => [device, index]));
    return rows.filter((device) => {
      const textSearch = getDeviceSearchText(device);
      const matchesSearch = !searchValue || textSearch.includes(searchValue);
      const matchesWarranty = !warrantyValue || (device['Warranty Match Status'] || 'Unmatched') === warrantyValue;
      const matchesCountry = countryFilter === 'all' || getDeviceCountryCode(device) === countryFilter;
      const matchesDashboard = dashboardRecordIndexes === null || dashboardRecordIndexes.has(deviceIndexMap.get(device));
      const matchesDeviceType = !activeDeviceType || getAssetType(device) === activeDeviceType;
      const isArchived = device?.is_archived === true;
      const matchesArchiveView = filterState.showArchived ? isArchived : !isArchived;
      const matchesDuplicates = !filterState.duplicatesOnly || device['Duplicate Serial'] === true;
      if (!(matchesSearch && matchesWarranty && matchesCountry && matchesDashboard && matchesDeviceType && matchesArchiveView && matchesDuplicates)) return false;
      for (const { key } of INVENTORY_FILTER_FIELDS) {
        const selected = filterState[key];
        if (!selected) continue;
        const value = getInventoryFilterFieldValue(device, key);
        if (!matchesInventoryFilterValue(value, selected)) return false;
      }
      return true;
    });
  }

  function clearPrimaryUserAssignment(device) {
    const cleared = { ...device };
    cleared['Primary user display name'] = '';
    cleared['Primary user email address'] = '';
    cleared['Primary user UPN'] = '';
    return cleared;
  }

  function staffSuggestions(users, listId) {
    return `<datalist id="${escapeHtml(listId)}">${users.map((user) => `<option value="${escapeHtml(user.name)}" label="${escapeHtml(user.email || '')}"></option>${user.email ? `<option value="${escapeHtml(user.email)}" label="${escapeHtml(user.name)}"></option>` : ''}`).join('')}</datalist>`;
  }

  function bindStaffAutocomplete(nameInput, emailInput, users) {
    if (!nameInput || !emailInput) return;
    const syncFrom = (value) => {
      const typed = String(value || '').trim().toLowerCase();
      if (!typed) return;
      const match = users.find((user) => user.name.toLowerCase() === typed || user.email.toLowerCase() === typed);
      if (!match) return;
      nameInput.value = match.name;
      emailInput.value = match.email;
    };
    ['input', 'change'].forEach((eventName) => {
      nameInput.addEventListener(eventName, () => syncFrom(nameInput.value));
      emailInput.addEventListener(eventName, () => syncFrom(emailInput.value));
    });
  }

  function openPrimaryUserCheckinModal(container, country, index) {
    const device = getInventory()[index];
    if (!device) return;
    const primaryUser = getPrimaryUser(device);
    const deviceLabel = device['Device name'] || device['Serial number'] || device['Device ID'] || 'device';
    const staffOptions = App.modules.users?.checkoutOptions?.() || [];
    const eventTimeValue = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
    const currentDeploymentStatus = getDeviceDeploymentStatusValue(device) || 'In Stock';
    const currentCondition = getDeviceConditionValue(device) || 'Good';
    Modal.open({
      title: `Check in ${deviceLabel}`,
      confirmText: 'Check in',
      body: `<form id="primaryUserCheckinForm" class="device-form">
        <p>Check in <strong>${escapeHtml(deviceLabel)}</strong> from its current Primary user assignment?</p>
        <div class="form-group form-grid-full">
          <label class="form-label" for="checkinStaffName">Staff name <span class="required">*</span></label>
          <input class="form-control" id="checkinStaffName" name="staffName" required list="primaryCheckinStaffSuggestions" autocomplete="name" value="${escapeHtml(primaryUser?.name || '')}" />
        </div>
        <div class="form-group form-grid-full">
          <label class="form-label" for="checkinStaffEmail">Staff email</label>
          <input class="form-control" id="checkinStaffEmail" name="staffEmail" type="email" list="primaryCheckinStaffSuggestions" autocomplete="email" value="${escapeHtml(primaryUser?.email || '')}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="primaryCheckinDeploymentStatus">Deployment status</label>
          <select class="form-control" id="primaryCheckinDeploymentStatus" name="deployment_status">${buildEnumOptionsHtml(window.DEPLOYMENT_STATUS, currentDeploymentStatus, ' (legacy)')}</select>
        </div>
        <div class="form-group">
          <label class="form-label" for="primaryCheckinCondition">Hardware health</label>
          <select class="form-control" id="primaryCheckinCondition" name="condition">${buildEnumOptionsHtml(window.CONDITION, currentDeploymentStatus === 'Disposed' ? 'End of Life' : currentCondition, ' (legacy)', window.CONDITION_LABELS)}</select>
        </div>
        <div class="form-group">
          <label class="form-label" for="primaryCheckinEventDate">Check-in date <span class="required">*</span></label>
          <input class="form-control" id="primaryCheckinEventDate" name="eventDate" type="date" required value="${getTodayDate()}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="primaryCheckinEventTime">Check-in time</label>
          <input class="form-control" id="primaryCheckinEventTime" name="eventTime" type="time" value="${eventTimeValue}" />
        </div>
        ${staffSuggestions(staffOptions, 'primaryCheckinStaffSuggestions')}
      </form>`,
      onOpen: () => {
        bindStaffAutocomplete(
          document.getElementById('checkinStaffName'),
          document.getElementById('checkinStaffEmail'),
          staffOptions
        );
        const deploymentInput = document.getElementById('primaryCheckinDeploymentStatus');
        const conditionInput = document.getElementById('primaryCheckinCondition');
        const syncCondition = () => {
          const disposed = deploymentInput?.value === 'Disposed';
          if (conditionInput) {
            conditionInput.disabled = disposed;
            if (disposed) conditionInput.value = 'End of Life';
          }
        };
        deploymentInput?.addEventListener('change', syncCondition);
        syncCondition();
      },
      onConfirm: async () => {
        const form = document.getElementById('primaryUserCheckinForm');
        if (!form.reportValidity()) return;
        const values = new FormData(form);
        const deploymentStatus = String(values.get('deployment_status') || currentDeploymentStatus).trim();
        const condition = deploymentStatus === 'Disposed' ? 'End of Life' : String(values.get('condition') || currentCondition).trim();
        const inventory = getInventory().map((row, rowIndex) => {
          if (rowIndex !== index) return row;
          const updated = clearPrimaryUserAssignment(row);
          updated['deployment_status'] = deploymentStatus;
          updated.condition = condition;
          if (deploymentStatus === 'Disposed') updated.disposition_method = updated.disposition_method || '';
          updated['Status Label'] = deriveStatusLabel(updated);
          return updated;
        });
        const event = {
          'Event ID': globalThis.crypto?.randomUUID?.() || `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          'Asset key': getAssetKey(device),
          'Device ID': String(device['Device ID'] || ''),
          'Device name': String(device['Device name'] || ''),
          'Serial number': String(device['Serial number'] || device['IntuneGroup.SerialNumber'] || ''),
          'Event type': 'checkin',
          'Event date': String(values.get('eventDate') || getTodayDate()),
          'Event time': String(values.get('eventTime') || ''),
          'Staff name': String(values.get('staffName') || '').trim(),
          'Staff email': String(values.get('staffEmail') || '').trim(),
          'Staff country': primaryUser?.country || '',
          'Staff location': primaryUser?.location || '',
          'Expected return date': '',
          Notes: ''
        };
        try {
          await App.store.setPrimaryUserCheckin(inventory, [...getCheckoutHistory(), event]);
          Modal.close();
          render(container, country);
          Toast.show('Asset checked in, status updated, and Primary user assignment cleared.', 'success');
        } catch (error) {
          Toast.show(`Could not check in asset: ${error.message || error}`, 'error', 6000);
        }
      }
    });
  }

  function openCheckoutForm(container, country, index, eventType) {
    const device = getInventory()[index];
    if (!device) return;
    const assetKey = getAssetKey(device);
    if (!assetKey) {
      Toast.show('This device needs a Device ID or serial number before it can be checked out.', 'warning');
      return;
    }
    const currentCheckout = getCurrentCheckout(device);
    const primaryUser = getPrimaryUser(device);
    if (eventType === 'checkout' && getStatusLabelType(device) !== 'Deployable') {
      Toast.show(`This asset cannot be checked out while its status is ${getStatusLabelName(device)}.`, 'warning');
      return;
    }
    if (eventType === 'checkout' && currentCheckout) {
      Toast.show('This device is already checked out.', 'warning');
      return;
    }
    if (eventType === 'checkout' && primaryUser) {
      Toast.show(`This device is already assigned to ${primaryUser.name} (${primaryUser.email}).`, 'warning');
      return;
    }
    if (eventType === 'checkin' && !currentCheckout && !primaryUser) {
      Toast.show('This device is not currently checked out.', 'warning');
      return;
    }
    if (eventType === 'checkin' && !currentCheckout && primaryUser) {
      openPrimaryUserCheckinModal(container, country, index);
      return;
    }

    const isCheckout = eventType === 'checkout';
    const deviceLabel = device['Device name'] || device['Serial number'] || device['Device ID'] || 'device';
    const eventTimeValue = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
    const checkoutUsers = App.modules.users?.checkoutOptions?.() || [];
    Modal.open({
      title: isCheckout ? `Check out ${deviceLabel}` : `Check in ${deviceLabel}`,
      confirmText: isCheckout ? 'Save checkout' : 'Save check-in',
      size: 'lg',
      body: `<form id="checkoutEventForm" class="device-form">
        <p class="form-help">${isCheckout ? 'Record who is taking custody of this asset.' : `Record the return of this asset from ${escapeHtml(currentCheckout['Staff name'])}.`}</p>
        ${isCheckout
          ? `<div class="form-group form-grid-full">
               <label class="form-label" for="checkoutStaffName">Staff name <span class="required">*</span></label>
               <input class="form-control" id="checkoutStaffName" name="staffName" required list="checkoutStaffSuggestions" autocomplete="name" placeholder="Search by staff name or email" />
             </div>
             <div class="form-group form-grid-full">
               <label class="form-label" for="checkoutStaffEmail">Staff email</label>
               <input class="form-control" id="checkoutStaffEmail" name="staffEmail" type="email" list="checkoutStaffSuggestions" autocomplete="email" placeholder="Search by email or select a staff name" />
             </div>
             <div class="form-group form-grid-full">
               ${checkoutUsers.length ? '' : '<small class="form-help">Add a user manually or import a CSV from the Users page before checking out an asset.</small>'}
             </div>
             <div class="form-group">
               <label class="form-label" for="eventDate">Checkout date <span class="required">*</span></label>
               <input class="form-control" id="eventDate" name="eventDate" type="date" required value="${getTodayDate()}" />
             </div>
             <div class="form-group">
               <label class="form-label" for="eventTime">Checkout time</label>
               <input class="form-control" id="eventTime" name="eventTime" type="time" value="${eventTimeValue}" />
             </div>
             <div class="form-group">
               <label class="form-label" for="expectedReturnDate">Expected return date</label>
               <input class="form-control" id="expectedReturnDate" name="expectedReturnDate" type="date" min="${getTodayDate()}" />
             </div>
             <div class="form-group form-grid-full">
               <label class="form-label" for="notes">Notes</label>
               <textarea class="form-control" id="notes" name="notes" rows="3" placeholder="Optional handover or return notes"></textarea>
             </div>`
          : `<div class="form-group">
               <label class="form-label" for="staffName">Staff name <span class="required">*</span></label>
               <input class="form-control" id="staffName" name="staffName" required list="checkoutStaffSuggestions" autocomplete="name" value="${escapeHtml(currentCheckout['Staff name'])}" placeholder="Person returning the asset" />
             </div>
             <div class="form-group">
               <label class="form-label" for="staffEmail">Staff email</label>
               <input class="form-control" id="staffEmail" name="staffEmail" type="email" list="checkoutStaffSuggestions" autocomplete="email" value="${escapeHtml(currentCheckout['Staff email'] || '')}" />
             </div>
             <div class="form-group">
               <label class="form-label" for="checkinDeploymentStatus">Deployment status</label>
               <select class="form-control" id="checkinDeploymentStatus" name="deployment_status">${buildEnumOptionsHtml(window.DEPLOYMENT_STATUS, getDeviceDeploymentStatusValue(device) || 'In Stock', ' (legacy)')}</select>
             </div>
             <div class="form-group">
               <label class="form-label" for="checkinCondition">Hardware health</label>
               <select class="form-control" id="checkinCondition" name="condition">${buildEnumOptionsHtml(window.CONDITION, (getDeviceDeploymentStatusValue(device) === 'Disposed' ? 'End of Life' : getDeviceConditionValue(device) || 'Good'), ' (legacy)', window.CONDITION_LABELS)}</select>
             </div>
             <div class="form-group">
               <label class="form-label" for="eventDate">Check-in date <span class="required">*</span></label>
               <input class="form-control" id="eventDate" name="eventDate" type="date" required value="${getTodayDate()}" />
             </div>
             <div class="form-group">
               <label class="form-label" for="eventTime">Check-in time</label>
               <input class="form-control" id="eventTime" name="eventTime" type="time" value="${eventTimeValue}" />
             </div>
             <div class="form-group form-grid-full">
               <label class="form-label" for="notes">Notes</label>
               <textarea class="form-control" id="notes" name="notes" rows="3" placeholder="Optional handover or return notes"></textarea>
             </div>`}
        ${staffSuggestions(checkoutUsers, 'checkoutStaffSuggestions')}
      </form>`,
      onOpen: () => {
        bindStaffAutocomplete(
          document.getElementById(isCheckout ? 'checkoutStaffName' : 'staffName'),
          document.getElementById(isCheckout ? 'checkoutStaffEmail' : 'staffEmail'),
          checkoutUsers
        );
        if (!isCheckout) {
          const deploymentInput = document.getElementById('checkinDeploymentStatus');
          const conditionInput = document.getElementById('checkinCondition');
          const syncCondition = () => {
            const disposed = deploymentInput?.value === 'Disposed';
            if (conditionInput) {
              conditionInput.disabled = disposed;
              if (disposed) conditionInput.value = 'End of Life';
            }
          };
          deploymentInput?.addEventListener('change', syncCondition);
          syncCondition();
        }
      },
      onConfirm: async () => {
        const form = document.getElementById('checkoutEventForm');
        if (!form.reportValidity()) return;
        const values = new FormData(form);
        const eventDate = String(values.get('eventDate') || '');
        const expectedReturnDate = String(values.get('expectedReturnDate') || '');
        const staffName = String(values.get('staffName') || '').trim();
        const staffEmail = String(values.get('staffEmail') || '').trim();
        const selectedUser = isCheckout
          ? checkoutUsers.find((user) => (!staffName || user.name.toLowerCase() === staffName.toLowerCase())
            && (!staffEmail || user.email.toLowerCase() === staffEmail.toLowerCase())
            && (user.name.toLowerCase() === staffName.toLowerCase() || user.email.toLowerCase() === staffEmail.toLowerCase()))
          : null;
        if (isCheckout && !selectedUser) {
          Toast.show('Select a user from the Users list before checking out this asset.', 'error');
          return;
        }
        if (isCheckout && expectedReturnDate && expectedReturnDate < eventDate) {
          Toast.show('Expected return date cannot be before the checkout date.', 'error');
          return;
        }
        const event = {
          'Event ID': globalThis.crypto?.randomUUID?.() || `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          'Asset key': assetKey,
          'Device ID': String(device['Device ID'] || ''),
          'Device name': String(device['Device name'] || ''),
          'Serial number': String(device['Serial number'] || device['IntuneGroup.SerialNumber'] || ''),
          'Event type': eventType,
          'Event date': eventDate,
          'Event time': String(values.get('eventTime') || ''),
          'Staff name': isCheckout ? selectedUser.name : staffName,
          'Staff email': isCheckout ? selectedUser.email : staffEmail,
          'Staff country': isCheckout ? selectedUser.country : '',
          'Staff location': isCheckout ? selectedUser.location : '',
          'Expected return date': isCheckout ? expectedReturnDate : '',
          Notes: String(values.get('notes') || '').trim()
        };
        try {
          if (!isCheckout) {
            const deploymentStatus = String(values.get('deployment_status') || getDeviceDeploymentStatusValue(device) || '').trim();
            const condition = deploymentStatus === 'Disposed' ? 'End of Life' : String(values.get('condition') || getDeviceConditionValue(device) || '').trim();
            const inventory = getInventory();
            const target = inventory[index];
            if (target) {
              target['deployment_status'] = deploymentStatus;
              target.condition = condition;
              if (deploymentStatus === 'Disposed' && !target.disposition_method) target.disposition_method = '';
              target['Status Label'] = deriveStatusLabel(target);
              await App.store.set(STORAGE_KEY, inventory);
            }
          }
          await App.store.set(CHECKOUT_HISTORY_KEY, [...getCheckoutHistory(), event]);
          Modal.close();
          render(container, country);
          Toast.show(isCheckout ? 'Asset checked out and history saved.' : 'Asset checked in, status updated, and history saved.', 'success');
        } catch (error) {
          Toast.show(isCheckout ? `Could not save checkout history: ${error.message || error}` : `Could not save check-in: ${error.message || error}`, 'error', 6000);
        }
      }
    });
  }

  function openCheckoutHistory(device) {
    const assetKey = getAssetKey(device);
    const events = getCheckoutHistory()
      .filter((event) => getCheckoutEventAssetKey(event) === assetKey)
      .slice()
      .reverse();
    const rows = events.map((event) => `<tr>
      <td>${escapeHtml(event['Event type'] === 'checkout' ? 'Checked out' : 'Checked in')}</td>
      <td>${escapeHtml(event['Event date'])}${event['Event time'] ? ` · ${escapeHtml(event['Event time'])}` : ''}</td>
      <td>${escapeHtml(event['Staff name'])}${event['Staff email'] ? `<br><small>${escapeHtml(event['Staff email'])}</small>` : ''}</td>
      <td>${escapeHtml(event['Expected return date'] || '—')}</td>
      <td>${escapeHtml(event.Notes || '—')}</td>
    </tr>`).join('');
    Modal.open({
      title: `Custody history · ${device['Device name'] || device['Serial number'] || 'Asset'}`,
      confirmText: 'Close',
      size: 'lg',
      body: `<div class="inventory-table-wrap checkout-history-wrap"><table class="inventory-table">
        <thead><tr><th>Event</th><th>Date</th><th>Staff</th><th>Expected return</th><th>Notes</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="empty-state">No custody history.</td></tr>'}</tbody>
      </table></div>`
    });
  }

  function renderTableBody(rows, allRows) {
    const visibleColumns = getVisibleColumns();
    const allColumns = getOrderedLayoutColumns();
    if (!rows.length) return `<tr><td colspan="${allColumns.length + 2}" class="empty-state">No matching devices.</td></tr>`;
    return rows.map((device) => {
      const duplicate = device['Duplicate Serial'] === true;
      const index = allRows.indexOf(device);
      const selected = selectedDeviceIndexes.has(index);
      const replacement = App.modules.replacements?.summaryForSerial?.(device['Serial number'] || device['IntuneGroup.SerialNumber']) || {};
      const checkout = getCurrentCheckout(device);
      const primaryUser = getPrimaryUser(device);
      const hasAssignedUser = Boolean(checkout || primaryUser);
      const deployable = getStatusLabelType(device) === 'Deployable';
      const assetKey = getAssetKey(device);
      const hasCheckoutHistory = assetKey && getCheckoutIndexes().assetKeys.has(assetKey);
      const lastEvent = assetKey ? getCheckoutIndexes().lastEvent?.get(assetKey) : null;
      const alreadyCheckedIn = !hasAssignedUser && lastEvent?.['Event type'] === 'checkin';
      const cells = allColumns.map((col) => {
        const value = col === 'Deployment Status'
          ? getDeviceDeploymentStatusValue(device) || getMetaStatus(device)
          : col === 'Hardware Health'
          ? String(getDeviceConditionValue(device) || '').trim()
          : col === 'Total storage (GB)'
          ? getTotalStorageGb(device)
          : col === 'Replacement Status'
          ? getInventoryField(device, col) || replacement[col]
          : REPLACEMENT_COLUMNS.includes(col)
          ? replacement[col]
          : col === 'Custody Status'
          ? hasAssignedUser ? 'Checked out' : assetKey ? 'Available' : 'Untracked'
            : col === 'Current Custodian'
            ? checkout
              ? checkout['Staff name']
              : primaryUser
                ? primaryUser.email && primaryUser.name !== primaryUser.email
                  ? `${primaryUser.name} (${primaryUser.email})`
                  : primaryUser.name || primaryUser.email || ''
                : ''
              : col === 'Expected Return Date'
                ? checkout?.['Expected return date'] || ''
                : col === 'Location'
                ? (() => {
                    const users = App.store.get('users') || [];
                    const userEmail = String(primaryUser?.email || device['Primary user email address'] || '').trim().toLowerCase();
                    if (userEmail) {
                      const user = users.find((u) => String(u.Email || '').trim().toLowerCase() === userEmail);
                      if (user && user.Location) return user.Location;
                    }
                    return getInventoryField(device, col);
                  })()
                : getInventoryField(device, col);
        if (['Purchase Date', 'Warranty Start Date', 'Warranty End Date', 'Disposal Date'].includes(col)) {
          return `<td>${escapeHtml(dateInputValue(value) || '—')}</td>`;
        }
        if (col === 'Custody Status') {
          const badgeClass = hasAssignedUser ? 'badge-blue' : assetKey ? 'badge-green' : 'badge-gray';
          return `<td><span class="badge ${badgeClass}">${escapeHtml(value)}</span></td>`;
        }
        if (col === 'Deployment Status') {
          const status = String(getDeviceDeploymentStatusValue(device) || '').trim();
          const badgeClass = status === 'In Use' ? 'badge-blue' : status === 'In Stock' ? 'badge-green' : status === 'Workshop' ? 'badge-orange' : status === 'Retired' ? 'badge-gray' : status === 'Disposed' ? 'badge-red' : 'badge-gray';
          return `<td><span class="badge ${badgeClass}">${escapeHtml(status || '—')}</span></td>`;
        }
        if (col === 'Hardware Health') {
          const conditionValue = String(getDeviceConditionValue(device) || '').trim();
          const badgeClass = conditionValue === 'Good' ? 'badge-green' : conditionValue === 'Needs Repair' ? 'badge-orange' : conditionValue === 'End of Life' ? 'badge-red' : conditionValue === 'Unknown' ? 'badge-yellow' : 'badge-gray';
          const displayLabel = window.CONDITION_LABELS?.[conditionValue] || conditionValue;
          return `<td><span class="badge ${badgeClass}">${escapeHtml(displayLabel || '—')}</span></td>`;
        }
        if (col === 'Expected Return Date') {
          if (!value) return '<td>—</td>';
          return `<td>${isReturnOverdue(checkout) ? `<span class="badge badge-red">Overdue · ${escapeHtml(value)}</span>` : escapeHtml(value)}</td>`;
        }
        if (col === 'Replacement Status') {
          const status = value || 'Not loaded';
          const badgeClass = status === 'Replaced' ? 'badge-orange' : status === 'Not replaced' ? 'badge-gray' : 'badge-gray';
          return `<td><span class="badge ${badgeClass}">${escapeHtml(status)}</span></td>`;
        }
        if (col === 'old_device_outcome') {
          const outcome = value || '';
          const badgeClass = outcome === 'Disposed' || outcome === 'Retired pending disposal' ? 'badge-red'
            : outcome === 'Sent to workshop for repair' ? 'badge-orange'
              : outcome === 'Awaiting re-imaging' ? 'badge-yellow'
                : outcome === 'Re-issued to another user' ? 'badge-green' : 'badge-gray';
          return `<td>${outcome ? `<span class="badge ${badgeClass}">${escapeHtml(outcome)}</span>` : '—'}</td>`;
        }
        if (col === 'Warranty Match Status') {
          const status = value || 'Unmatched';
          const badgeClass = status === 'Matched' ? 'badge-green' : status === 'Unmatched' ? 'badge-gray' : 'badge-orange';
          return `<td><span class="badge ${badgeClass}">${escapeHtml(status)}</span></td>`;
        }
        if (col === 'Compliance') {
          const status = value || 'Unknown';
          const badgeClass = status === 'Compliant' ? 'badge-green' : status === 'Non-Compliant' ? 'badge-red' : 'badge-gray';
          return `<td><span class="badge ${badgeClass}">${escapeHtml(status)}</span></td>`;
        }
        if (col === 'Device Online Status') {
          const status = getDeviceOnlineStatus(device);
          const badgeClass = status === 'Inactive>90days' ? 'badge-red' : status === 'Unknown' ? 'badge-gray' : 'badge-green';
          return `<td><span class="badge ${badgeClass}">${escapeHtml(status)}</span></td>`;
        }
        if (col === 'Age') {
          const age = getWarrantyAge(getInventoryField(device, 'Warranty Start Date'), getInventoryField(device, 'Warranty End Date'));
          return `<td>${escapeHtml(age)}</td>`;
        }
        if (col === 'Device name') {
          const deviceNameText = escapeHtml(value || '—');
          const inactiveBadge = isDeviceInactive90Days(device) ? `<span class="badge badge-gray">Inactive>90d</span>` : '';
          return `<td>${deviceNameText}${inactiveBadge}</td>`;
        }
        if (col === 'Total storage (GB)') return `<td>${escapeHtml(formatGb(value))}</td>`;
        if (col === 'Asset type') return `<td>${escapeHtml(deviceTypeLabel(getAssetType(device)))}</td>`;
        if (col === 'Serial number' && duplicate) return `<td><span class="duplicate-serial">${escapeHtml(value)}</span></td>`;
        return `<td>${escapeHtml(value || '—')}</td>`;
      }).join('');
      const rowClasses = [duplicate ? 'inventory-duplicate' : '', selected ? 'inventory-selected' : '', device?.is_archived === true ? 'inventory-row-archived' : ''].filter(Boolean).join(' ');
      return `<tr class="${rowClasses}"><td><input type="checkbox" class="device-select-checkbox" data-index="${index}" aria-label="Select ${escapeHtml(device['Device name'] || 'device')}" ${selected ? 'checked' : ''}></td>${cells}<td class="inventory-row-actions"><button class="btn btn-primary btn-sm checkout-device-btn" data-index="${index}" ${hasAssignedUser || !assetKey || !deployable ? 'disabled' : ''}>${hasAssignedUser ? 'Checked out' : 'Checkout'}</button><button class="btn btn-secondary btn-sm checkin-device-btn" data-index="${index}" ${hasAssignedUser ? '' : 'disabled'}${primaryUser && !checkout ? ` title="Check in to clear the Primary user assignment for this device"` : ''}>${alreadyCheckedIn ? 'Checked in' : 'Check in'}</button><button class="btn btn-secondary btn-sm checkout-history-btn" data-index="${index}" ${hasCheckoutHistory ? '' : 'disabled'}>History</button></td></tr>`;
    }).join('');
  }

  function renderLayoutControls() {
    const layout = getVisibleColumns();
    const available = LAYOUT_COLUMNS;
    const activeColumns = layout.filter((column) => available.includes(column));
    const inactiveColumns = available.filter((column) => !layout.includes(column));
    const labelForColumn = (column) => column === 'Intune Group Tag'
      ? 'Intune Group Tag'
      : column === 'Asset type' ? 'Category'
        : column === 'Intune GroupName' ? 'Intune GroupName'
        : column === 'OS version' ? 'OS Version'
        : column;
    const item = (column, visible) => {
      const label = labelForColumn(column);
      const position = activeColumns.indexOf(column) + 1;
      const hiddenBySearch = !label.toLowerCase().includes(columnSearchTerm.trim().toLowerCase());
      return `<div class="column-picker-row" data-column-row data-search="${escapeHtml(label.toLowerCase())}" ${hiddenBySearch ? 'hidden' : ''}>
        <label><input type="checkbox" data-column="${escapeHtml(column)}" ${visible ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>
        ${visible ? `<input class="column-order-input" type="number" min="1" max="${activeColumns.length}" value="${position}" data-column-order="${escapeHtml(column)}" aria-label="Order for ${escapeHtml(label)}">` : ''}
      </div>`;
    };

    const rowsForOptions = getInventory();
    const renderFilterSelect = ({ key, label, more }) => {
      const options = getDistinctInventoryFilterOptions(rowsForOptions, key);
      const selected = String(filterState[key] || '');
      const hasValue = selected !== '';
      const optionsHtml = [`<option value="">All</option>`]
        .concat(options.map((opt) => `<option value="${escapeHtml(opt.value)}" ${selected === opt.value ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`)).join('');
      const showMore = !more || moreFiltersOpen || !!filterState[key];
      return `<div class="inventory-filter-control" data-filter-key="${escapeHtml(key)}" data-more-filter="${more ? '1' : '0'}" ${showMore ? '' : 'hidden'}>
        <label class="duplicate-filter-option" for="inventoryFilter_${escapeHtml(key)}">${escapeHtml(label)}</label>
        <div class="inventory-filter-select-wrap">
          <select id="inventoryFilter_${escapeHtml(key)}" class="form-control" data-inventory-filter="${escapeHtml(key)}" aria-label="${escapeHtml(label)}">${optionsHtml}</select>
          ${hasValue ? `<button type="button" class="btn btn-secondary btn-sm inventory-filter-clear" data-clear-filter="${escapeHtml(key)}" aria-label="Clear ${escapeHtml(label)} filter">×</button>` : ''}
        </div>
      </div>`;
    };

    const moreFilters = INVENTORY_FILTER_FIELDS.filter((f) => f.more);
    const hasMoreActive = moreFilters.some((f) => !!filterState[f.key]);

    return `
      <div class="layout-controls">
        <button class="btn btn-secondary btn-sm" id="inventoryFilterToggle" aria-expanded="${filterPanelOpen}">Filter${hasActiveInventoryFilters() ? ' •' : ''}</button>
        <div class="column-drawer-backdrop ${filterPanelOpen ? 'open' : ''}" id="inventoryFilterBackdrop"></div>
        <aside class="column-drawer inventory-filter-drawer ${filterPanelOpen ? 'open' : ''}" id="inventoryFilterPanel" aria-label="Inventory filters" aria-hidden="${!filterPanelOpen}">
          <div class="column-drawer-header"><div><strong>Filters</strong><small>Refine inventory by status, device, and replacement.</small></div><button type="button" class="btn btn-secondary btn-sm" id="closeInventoryFilter" aria-label="Close filters">×</button></div>
          <label class="duplicate-filter-option"><input type="checkbox" id="inventoryFilterDuplicatesOnly" ${filterState.duplicatesOnly ? 'checked' : ''}> Duplicate Only</label>
          <label class="duplicate-filter-option"><input type="checkbox" id="inventoryFilterShowArchived" ${filterState.showArchived ? 'checked' : ''}> Show Archived</label>
          ${INVENTORY_FILTER_FIELDS.filter((f) => !f.more).map(renderFilterSelect).join('')}
          <button type="button" class="btn btn-secondary btn-sm" id="toggleMoreInventoryFilters" aria-expanded="${moreFiltersOpen || hasMoreActive}">${(moreFiltersOpen || hasMoreActive) ? 'Fewer filters' : 'More filters'}</button>
          ${moreFilters.map(renderFilterSelect).join('')}
          <div class="column-drawer-footer"><button type="button" class="btn btn-secondary btn-sm" id="clearAllInventoryFiltersBtn">Clear all</button><button type="button" class="btn btn-secondary btn-sm" id="resetInventoryFiltersBtn">Reset</button></div>
        </aside>

        <button class="btn btn-secondary btn-sm" id="columnLayoutToggle" aria-expanded="${columnDrawerOpen}">☷ Columns</button>
        <div class="column-drawer-backdrop ${columnDrawerOpen ? 'open' : ''}" id="columnDrawerBackdrop"></div>
        <aside class="column-drawer ${columnDrawerOpen ? 'open' : ''}" id="columnDrawer" aria-label="Column layout" aria-hidden="${!columnDrawerOpen}">
          <div class="column-drawer-header"><div><strong>Column layout</strong><small>Choose visible columns and set their order.</small></div><button type="button" class="btn btn-secondary btn-sm" id="closeColumnDrawer" aria-label="Close column layout">×</button></div>
          <input class="form-control column-search" type="search" id="columnSearch" placeholder="Search columns..." value="${escapeHtml(columnSearchTerm)}" />
          <details class="column-picker-section" data-column-section open>
            <summary>Visible columns <span>${activeColumns.length}</span></summary>
            <div class="column-picker-list">${activeColumns.map((column) => item(column, true)).join('')}</div>
          </details>
          <details class="column-picker-section" data-column-section open>
            <summary>Hidden columns <span>${inactiveColumns.length}</span></summary>
            <div class="column-picker-list">${inactiveColumns.map((column) => item(column, false)).join('') || '<p class="column-picker-empty">All columns are visible.</p>'}</div>
          </details>
          <div class="column-drawer-footer"><button type="button" class="btn btn-secondary btn-sm" id="resetLayoutBtn">Reset defaults</button></div>
        </aside>
      </div>
    `;
  }

  function refreshLayoutControls(container) {
    const controls = container.querySelector('.layout-controls');
    if (!controls) return;
    const template = document.createElement('template');
    template.innerHTML = renderLayoutControls();
    controls.replaceChildren(...template.content.firstElementChild.childNodes);
    bindLayoutControlEvents(container);
  }

  function getOrderedLayoutColumns() {
    const visible = getVisibleColumns();
    return [...visible, ...LAYOUT_COLUMNS.filter((column) => !visible.includes(column))];
  }

  function applyColumnVisibility(container, columns = getVisibleColumns()) {
    const visibleColumns = new Set(columns);
    container.querySelectorAll('col[data-layout-column], .inventory-table [data-layout-column]').forEach((column) => {
      const hidden = !visibleColumns.has(column.dataset.layoutColumn);
      column.hidden = hidden;
      column.classList.toggle('column-hidden', hidden);
    });
  }

  function decorateTableColumns(container) {
    const orderedColumns = getOrderedLayoutColumns();
    const headerCells = container.querySelectorAll('.inventory-table thead tr:first-child > th');
    orderedColumns.forEach((column, index) => {
      headerCells[index + 1]?.setAttribute('data-layout-column', column);
    });

    container.querySelectorAll('.inventory-table tbody tr').forEach((row) => {
      if (row.querySelector('.empty-state')) return;
      orderedColumns.forEach((column, index) => {
        row.children[index + 1]?.setAttribute('data-layout-column', column);
      });
    });

    applyColumnVisibility(container);
  }

  function bindLayoutControlEvents(container) {
    const layoutControls = container.querySelector('.layout-controls');
    if (!layoutControls) return;
    const toggleDrawer = (open) => {
      columnDrawerOpen = open;
      refreshLayoutControls(container);
    };
    layoutControls.querySelector('#columnLayoutToggle').addEventListener('click', () => toggleDrawer(true));
    layoutControls.querySelector('#closeColumnDrawer').addEventListener('click', () => toggleDrawer(false));
    layoutControls.querySelector('#columnDrawerBackdrop').addEventListener('click', () => toggleDrawer(false));
    layoutControls.querySelector('#inventoryFilterToggle').addEventListener('click', () => {
      filterPanelOpen = !filterPanelOpen;
      localStorage.setItem('nexit_inventory_filter_panel_open', JSON.stringify(filterPanelOpen));
      refreshLayoutControls(container);
    });
    layoutControls.querySelector('#closeInventoryFilter').addEventListener('click', () => {
      filterPanelOpen = false;
      localStorage.setItem('nexit_inventory_filter_panel_open', JSON.stringify(filterPanelOpen));
      refreshLayoutControls(container);
    });
    layoutControls.querySelector('#inventoryFilterBackdrop').addEventListener('click', () => {
      filterPanelOpen = false;
      localStorage.setItem('nexit_inventory_filter_panel_open', JSON.stringify(filterPanelOpen));
      refreshLayoutControls(container);
    });
    layoutControls.querySelector('#columnSearch').addEventListener('input', (event) => {
      columnSearchTerm = event.target.value;
      const term = columnSearchTerm.trim().toLowerCase();
      layoutControls.querySelectorAll('[data-column-row]').forEach((row) => {
        row.hidden = !row.dataset.search.includes(term);
      });
      if (term) {
        layoutControls.querySelectorAll('.column-picker-section').forEach((section) => {
          if (section.querySelector('[data-column-row]:not([hidden])')) section.open = true;
        });
      }
    });
    layoutControls.querySelector('#resetLayoutBtn').addEventListener('click', () => {
      saveVisibleColumns(DEFAULT_VISIBLE_COLUMNS);
      render(container, App.countryFilter);
    });
    const applyFilterRender = () => {
      persistCoreFilterState();
      render(container, App.countryFilter);
    };
    layoutControls.querySelector('#inventoryFilterDuplicatesOnly')?.addEventListener('change', (e) => {
      filterState.duplicatesOnly = e.target.checked;
      applyFilterRender();
    });
    layoutControls.querySelector('#inventoryFilterShowArchived')?.addEventListener('change', (e) => {
      filterState.showArchived = e.target.checked;
      applyFilterRender();
    });
    layoutControls.querySelectorAll('[data-inventory-filter]').forEach((select) => {
      select.addEventListener('change', () => {
        const key = select.getAttribute('data-inventory-filter');
        if (!key) return;
        filterState[key] = select.value || '';
        applyFilterRender();
      });
    });
    layoutControls.querySelectorAll('[data-clear-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-clear-filter');
        if (!key) return;
        filterState[key] = '';
        applyFilterRender();
      });
    });
    layoutControls.querySelector('#toggleMoreInventoryFilters')?.addEventListener('click', () => {
      moreFiltersOpen = !moreFiltersOpen;
      refreshLayoutControls(container);
    });
    layoutControls.querySelector('#clearAllInventoryFiltersBtn')?.addEventListener('click', () => {
      clearAllInventoryFilters(container);
      render(container, App.countryFilter);
    });
    layoutControls.querySelector('#resetInventoryFiltersBtn')?.addEventListener('click', () => {
      clearAllInventoryFilters(container);
      render(container, App.countryFilter);
    });
    layoutControls.querySelectorAll('input[data-column]').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const visibleColumns = getVisibleColumns();
        const selected = checkbox.dataset.column;
        const next = checkbox.checked
          ? [...visibleColumns, selected]
          : visibleColumns.filter((column) => column !== selected);
        if (!next.length) next.push('Device name');
        saveVisibleColumns(next);
        render(container, App.countryFilter);
      });
    });
    layoutControls.querySelectorAll('input[data-column-order]').forEach((input) => {
      input.addEventListener('change', () => {
        const visibleColumns = getVisibleColumns();
        const column = input.dataset.columnOrder;
        const oldIndex = visibleColumns.indexOf(column);
        if (oldIndex < 0) return;
        const requested = Math.max(1, Math.min(visibleColumns.length, Number(input.value) || oldIndex + 1)) - 1;
        visibleColumns.splice(oldIndex, 1);
        visibleColumns.splice(requested, 0, column);
        saveVisibleColumns(visibleColumns);
        render(container, App.countryFilter);
      });
    });
  }

  function countImportDuplicates(existing, imported) {
    const counts = new Map();
    existing.forEach((device) => {
      const key = normalizeSerialKey(device['Serial number'] || device['IntuneGroup.SerialNumber']);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });

    let duplicates = 0;
    imported.forEach((device) => {
      const key = normalizeSerialKey(device['Serial number'] || device['IntuneGroup.SerialNumber']);
      if (!key) return;
      const count = counts.get(key) || 0;
      if (count > 0) duplicates += 1;
      counts.set(key, count + 1);
    });
    return duplicates;
  }

  function applyInventoryImport(imported, keepDuplicates) {
    let inventory = getInventory();
    const importedKeys = new Set(imported
      .map((record) => normalizeSerialKey(record['Serial number'] || record['IntuneGroup.SerialNumber']))
      .filter(Boolean));

    if (!keepDuplicates && importedKeys.size) {
      const canonicalByKey = new Map();
      inventory.forEach((device) => {
        const key = normalizeSerialKey(device['Serial number'] || device['IntuneGroup.SerialNumber']);
        if (!importedKeys.has(key)) return;
        const current = canonicalByKey.get(key);
        if (!current || (current['Duplicate Serial'] === true && device['Duplicate Serial'] !== true)) {
          canonicalByKey.set(key, device);
        }
      });
      inventory = inventory.filter((device) => {
        const key = normalizeSerialKey(device['Serial number'] || device['IntuneGroup.SerialNumber']);
        return !importedKeys.has(key) || canonicalByKey.get(key) === device;
      });
      canonicalByKey.forEach((device, key) => {
        const serial = String(device['Serial number'] || device['IntuneGroup.SerialNumber'] || '').replace(/--?\d+$/, '');
        device['Serial number'] = serial;
        device['Duplicate Serial'] = false;
      });
    }

    const bySerial = new Map();
    const occupiedSerials = new Set();
    inventory.forEach((device) => {
      const serial = normalizeSerial(device['Serial number'] || device['IntuneGroup.SerialNumber']);
      const key = normalizeSerialKey(serial);
      if (serial) occupiedSerials.add(serial);
      if (key && (!bySerial.has(key) || (bySerial.get(key)['Duplicate Serial'] === true && device['Duplicate Serial'] !== true))) {
        bySerial.set(key, device);
      }
    });

    let added = 0;
    let merged = 0;
    let duplicatesKept = 0;
    imported.forEach((record) => {
      const sourceSerial = String(record['Serial number'] || record['IntuneGroup.SerialNumber'] || '').trim();
      const key = normalizeSerialKey(sourceSerial);
      const match = key ? bySerial.get(key) : null;

      if (match && !keepDuplicates) {
        const mergedRecord = { ...match };
        Object.entries(record).forEach(([field, value]) => {
          if (field === 'Duplicate Serial' || field === 'Device Online Status' || field === 'Age' || !hasImportValue(value)) return;
          if (field === 'Asset type' && !hasImportedSourceValue(record, 'Asset type', 'Device type', 'Type')) return;
          if (field === 'Device name' && !hasImportedSourceValue(record, 'Device name', 'Device Name', 'deviceName')) return;
          if (field === 'Device ID' && ['n/a', 'na', 'none', 'unknown', '-'].includes(String(value).trim().toLowerCase())) return;
          mergedRecord[field] = value;
        });
        delete mergedRecord['Total storage'];
        delete mergedRecord['Total Storage'];
        Object.assign(match, mergedRecord, { 'Duplicate Serial': false });
        merged += 1;
        return;
      }

      const addedRecord = {
        ...record,
        'Device name': hasImportValue(record['Device name']) ? record['Device name'] : 'Unknown Device',
        'Warranty Match Status': hasImportValue(record['Warranty Match Status']) ? record['Warranty Match Status'] : 'Unmatched',
        'Duplicate Serial': false
      };
      delete addedRecord['Device Online Status'];
      delete addedRecord.Age;
      if (match && keepDuplicates) {
        const baseSerial = sourceSerial.replace(/--?\d+$/, '');
        let suffix = 1;
        let candidate = `${baseSerial}-${suffix}`;
        while (occupiedSerials.has(normalizeSerial(candidate))) {
          suffix += 1;
          candidate = `${baseSerial}-${suffix}`;
        }
        addedRecord['Serial number'] = candidate;
        addedRecord['Duplicate Serial'] = true;
        occupiedSerials.add(normalizeSerial(candidate));
        duplicatesKept += 1;
      } else {
        if (sourceSerial) occupiedSerials.add(normalizeSerial(sourceSerial));
        if (key && !bySerial.has(key)) bySerial.set(key, addedRecord);
        added += 1;
      }
      inventory.push(addedRecord);
    });

    setInventory(inventory);
    return { added, merged, duplicatesKept };
  }

  const EDITABLE_FIELDS = [
    ['Fixed Asset Number', 'Fixed Asset Number'], ['Device ID', 'Device ID'], ['Device name', 'Device name'], ['Serial number', 'Serial number'],
    ['Manufacturer', 'Manufacturer'], ['Model', 'Model'], ['Ownership', 'Ownership'],
    ['Country', 'Country'], ['Location', 'Location'], ['Device IP', 'Device IP'], ['Firmware version', 'Firmware version'],
    ['UPS Capacity (VA)', 'UPS Capacity (VA)'], ['Battery replacement date', 'Battery replacement date'],
    ['Compliance', 'Compliance'], ['OS', 'OS'], ['OS version', 'OS Version'], ['Azure AD registered', 'Azure AD registered'],
    ['JoinType', 'JoinType'], ['Managed by', 'Managed by'],
    ['Primary user display name', 'Primary user display name'], ['Primary user email address', 'Primary user email address'],
    ['Intune GroupName', 'Intune GroupName'], ['Intune Group Tag', 'Intune Group Tag'],
    ['Total storage (GB)', 'Total storage (GB)'], ['Free storage', 'Free storage (bytes)'],
    ['Last check-in', 'Last check-in'], ['Enrollment date', 'Enrollment date'],
    ['Purchase Date', 'Purchase Date'], ['Warranty Start Date', 'Warranty Start Date'], ['Warranty End Date', 'Warranty End Date'], ['Disposal Date', 'Disposal Date'],
    ['Device Online Status', 'Device Online Status']
  ];

  const BULK_EDIT_FIELDS = [
    ['Asset type', 'Device type'],
    ...DEFAULT_COLUMNS.filter((column) => !['Asset type', 'deployment_status', 'condition'].includes(column)).map((column) => [column, column]),
    ...CHECKOUT_COLUMNS.map((column) => [column, column]),
    ...REPLACEMENT_COLUMNS.map((column) => [column, column]),
    ['deployment_status', 'Deployment status'],
    ['condition', 'Hardware Health'],
    ['Staff Member Lifecycle Status', 'Staff Employment Status']
  ];

  function applyBulkEdit(container, country) {
    const indexes = Array.from(selectedDeviceIndexes);
    if (!indexes.length) return;
    const inventory = getInventory();
    const selectedDevices = indexes.map((index) => inventory[index]).filter(Boolean);
    if (!selectedDevices.length) return;
    Modal.open({
      title: `Edit ${indexes.length} selected device${indexes.length === 1 ? '' : 's'}`,
      confirmText: 'Apply changes',
      size: 'lg',
      body: `<p>Current values are shown. For multiple devices, fields with different values are left unchanged unless you edit them.</p><form id="bulkEditForm" class="bulk-edit-form">${BULK_EDIT_FIELDS.map(([key, label]) => {
        const values = selectedDevices.map((device) => String(key === 'Asset type'
          ? getAssetType(device)
          : key === 'Total storage (GB)'
            ? getTotalStorageGb(device) ?? ''
          : key === 'Replacement Status'
            ? getInventoryField(device, key) || App.modules.replacements?.summaryForSerial?.(getInventoryField(device, 'Serial number'))?.['Replacement Status'] || 'Not replaced'
          : key === 'Replaced By Device Serial Number'
            ? getInventoryField(device, key) || App.modules.replacements?.summaryForSerial?.(getInventoryField(device, 'Serial number'))?.['Replaced By Device Serial Number'] || ''
          : key === 'Staff Member Lifecycle Status'
            ? getInventoryField(device, key)
            : key === 'Device Online Status'
              ? getDeviceOnlineStatus(device)
              : key === 'Age'
                ? getWarrantyAge(getInventoryField(device, 'Warranty Start Date'), getInventoryField(device, 'Warranty End Date'))
                : ['Purchase Date', 'Warranty Start Date', 'Warranty End Date', 'Disposal Date'].includes(key)
                  ? dateInputValue(getInventoryField(device, key))
                  : getInventoryField(device, key)));
        const mixed = values.some((value) => value !== values[0]);
        const rawValue = mixed ? '' : values[0];
        const value = !mixed && ['Purchase Date', 'Warranty Start Date', 'Warranty End Date', 'Disposal Date'].includes(key) ? dateInputValue(rawValue) : rawValue;
        const mixedAttributes = mixed ? ' data-mixed="true"' : '';
        const enumOptions = App.fieldOptions?.[key];
        const control = key === 'Replaced By Device Serial Number'
          ? `<div class="inventory-replacement-picker"><input class="form-control" name="value:${escapeHtml(key)}" aria-label="${escapeHtml(label)}" value="${escapeHtml(value)}" data-inventory-device-picker="true" data-initial-value="${escapeHtml(value)}" data-mixed="${mixed}" placeholder="${mixed ? 'Multiple values · choose a device' : 'Search available inventory'}"><div class="replacement-suggestions" data-inventory-device-suggestions role="listbox"></div><span class="replacement-field-message" data-inventory-device-message aria-live="polite"></span></div>`
          : enumOptions
          ? `<select class="form-control" name="value:${escapeHtml(key)}" aria-label="${escapeHtml(label)}"${mixedAttributes}>${mixed ? '<option value="" selected>Multiple values</option>' : '<option value="">Select a value</option>'}${enumOptions.map((option) => `<option value="${escapeHtml(option.value)}" ${value === option.value ? 'selected' : ''}>${escapeHtml(option.value)}${option.legacy ? ' · legacy' : ''}</option>`).join('')}</select>`
          : key === 'Asset type'
          ? `<input class="form-control" name="value:${escapeHtml(key)}" list="bulk-category-datalist" aria-label="${escapeHtml(label)}"${mixedAttributes} value="${escapeHtml(value)}"${mixed ? ' placeholder="Multiple values · type a category"' : ''}><datalist id="bulk-category-datalist">${getCategoryOptions().map((val) => `<option value="${escapeHtml(val)}"></option>`).join('')}</datalist>`
          : key === 'Device Online Status'
            ? `<select class="form-control" name="value:${escapeHtml(key)}" data-online-status="true" aria-label="${escapeHtml(label)}"${mixedAttributes}>${mixed ? '<option value="" selected>Multiple values</option>' : ''}${['Active', 'Inactive>90days', 'Unknown'].map((status) => `<option value="${escapeHtml(status)}" ${value === status ? 'selected' : ''}>${escapeHtml(status)}</option>`).join('')}</select>`
          : key === 'deployment_status'
          ? `<select class="form-control" name="value:${escapeHtml(key)}" aria-label="${escapeHtml(label)}"${mixedAttributes}>${mixed ? '<option value="" selected>Multiple values</option>' : '<option value="">Select a value</option>'}${buildEnumOptionsHtml(window.DEPLOYMENT_STATUS, mixed ? '' : rawValue, ' (legacy)')}</select>`
          : key === 'condition'
          ? `<select class="form-control" name="value:${escapeHtml(key)}" aria-label="${escapeHtml(label)}"${mixedAttributes}>${mixed ? '<option value="" selected>Multiple values</option>' : '<option value="">Select a value</option>'}${buildEnumOptionsHtml(window.CONDITION, mixed ? '' : rawValue, ' (legacy)', window.CONDITION_LABELS)}</select>`
          : `<input class="form-control" name="value:${escapeHtml(key)}" aria-label="${escapeHtml(label)}" value="${escapeHtml(value)}"${key === 'Age' ? ' readonly' : ''}${key === 'Total storage (GB)' ? ' type="number" min="0" step="0.01"' : ''}${mixed ? ' placeholder="Multiple values" data-mixed="true"' : ''}${!mixed && ['Purchase Date', 'Warranty Start Date', 'Warranty End Date', 'Disposal Date'].includes(key) ? ' placeholder="YYYY-MM-DD"' : ''}>`;
        return `<label class="bulk-edit-field"><span>${escapeHtml(label)}</span>${control}</label>`;
      }).join('')}</form>`,
      onOpen: () => {
        document.querySelectorAll('#bulkEditForm [data-inventory-device-picker="true"]').forEach((input) => {
          const suggestions = input.parentElement.querySelector('[data-inventory-device-suggestions]');
          const message = input.parentElement.querySelector('[data-inventory-device-message]');
          let searchTimer = null;
          input.addEventListener('input', () => {
            input.dataset.edited = 'true';
            if (input.value.trim() === input.dataset.initialValue) {
              input.dataset.selectedSerial = input.value.trim();
              suggestions.replaceChildren();
              message.textContent = '';
              return;
            }
            input.dataset.selectedSerial = '';
            clearTimeout(searchTimer);
            const query = input.value.trim();
            suggestions.replaceChildren();
            message.textContent = query ? 'Searching available inventory…' : '';
            if (!query) return;
            searchTimer = setTimeout(async () => {
              try {
                const excluded = selectedDevices.map((device) => getInventoryField(device, 'Serial number') || device['IntuneGroup.SerialNumber']).filter(Boolean).join('|');
                const response = await fetch(`/api/inventory/available-replacements?q=${encodeURIComponent(query)}&exclude=${encodeURIComponent(excluded)}`);
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Inventory search failed.');
                if (input.value.trim() !== query) return;
                const matches = result.devices || [];
                suggestions.innerHTML = matches.map((device) => `<button type="button" class="replacement-suggestion" role="option" data-device-serial="${escapeHtml(device.serial)}"><strong>${escapeHtml(device.serial)}</strong><small>${escapeHtml([device.model, device.country, device.fixedAssetNumber].filter(Boolean).join(' · '))}</small></button>`).join('');
                suggestions.querySelectorAll('[data-device-serial]').forEach((button) => button.addEventListener('click', () => {
                  input.value = button.dataset.deviceSerial;
                  input.dataset.selectedSerial = button.dataset.deviceSerial;
                  input.dataset.edited = 'true';
                  suggestions.replaceChildren();
                  message.textContent = 'Available for handout.';
                }));
                message.textContent = matches.length ? 'Select a device from inventory.' : 'No available replacement new device matches this search.';
              } catch (error) {
                message.textContent = error.message || 'Inventory search failed.';
              }
            }, 250);
          });
        });
        document.querySelectorAll('#bulkEditForm select[data-online-status="true"]').forEach((select) => {
          select.addEventListener('change', () => { select.dataset.edited = 'true'; });
        });
        document.querySelectorAll('#bulkEditForm input[data-mixed="true"]').forEach((input) => {
          input.addEventListener('input', () => {
            input.dataset.edited = 'true';
          });
        });
        document.querySelectorAll('#bulkEditForm select[data-mixed="true"]').forEach((select) => {
          select.addEventListener('change', () => {
            select.dataset.edited = 'true';
          });
        });
      },
      onConfirm: () => {
        const form = document.getElementById('bulkEditForm');
        const formData = new FormData(form);
        const replacementPicker = form.querySelector('[data-inventory-device-picker="true"]');
        if (replacementPicker && replacementPicker.dataset.edited === 'true' && selectedDevices.length > 1) {
          Toast.show('Edit the replacement-device link one device at a time.', 'error');
          replacementPicker.focus();
          return;
        }
        if (replacementPicker && replacementPicker.dataset.edited === 'true'
            && replacementPicker.value.trim() !== replacementPicker.dataset.selectedSerial) {
          Toast.show('Choose an available replacement new device from the inventory suggestions.', 'error');
          replacementPicker.focus();
          return;
        }
        const updatedDevices = [];
        let bulkDateError = '';
        indexes.forEach((index) => {
          if (bulkDateError) return;
          const updated = { ...inventory[index] };
          BULK_EDIT_FIELDS.forEach(([field]) => {
            if (bulkDateError) return;
            const input = form.elements.namedItem(`value:${field}`);
            if (!input) return;
            if (field === 'Device Online Status' && input.dataset.edited !== 'true') return;
            if (field === 'Age') return;
            if (input.dataset.mixed === 'true' && input.dataset.edited !== 'true') return;
            const value = String(formData.get(`value:${field}`) ?? '').trim();
            if (['Purchase Date', 'Warranty Start Date', 'Warranty End Date', 'Disposal Date'].includes(field)) {
              const normalized = normalizeDateInput(value, { allowAmbiguousSlash: false });
              if (normalized.error) { bulkDateError = `${field}: ${normalized.error}`; return; }
              updated[field] = normalized.iso;
              return;
            }
            if (field === 'deployment_status' || field === 'condition') {
              updated[field] = value;
              updated['Status Label'] = deriveStatusLabel(updated);
            } else {
              updated[field] = field === 'Asset type' ? resolveAssetTypeValue(value) : value;
            }
          });
          // Collect new category values from bulk edit and persist to server
          const bulkAssetTypeInput = form.elements.namedItem('value:Asset type');
          if (bulkAssetTypeInput) {
            const v = String(bulkAssetTypeInput.value || '').trim();
            const standardTypes = DEVICE_TYPES.map(({ value }) => value);
            if (v && !standardTypes.includes(v)) {
              fetch('/api/field-options', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fieldName: 'Asset type', value: v })
              }).catch(() => {}); // non-fatal
              fetch('/api/field-options').then(async (resp) => {
                if (resp.ok) {
                  const data = await resp.json();
                  App.fieldOptions = data.options || {};
                }
              }).catch(() => {});
            }
          }
          delete updated['Total storage'];
          delete updated['Total Storage'];
          updatedDevices.push(updated);
          inventory[index] = updated;
        });
        if (bulkDateError) {
          Toast.show(bulkDateError, 'error', 6000);
          return;
        }
        if (updatedDevices.some((device) => !device['Device name'] || !device['Serial number'])) {
          Toast.show('Device name and serial number are required.', 'error');
          return;
        }
        try {
          setInventory(inventory);
          selectedDeviceIndexes.clear();
          Modal.close();
          render(container, country);
          Toast.show(`Updated ${indexes.length} device${indexes.length === 1 ? '' : 's'}.`, 'success');
        } catch (error) {
          Toast.show(`Could not update selected devices: ${error.message || error}`, 'error');
        }
      }
    });
  }

  function deleteSelectedDevices(container, country) {
    const indexes = Array.from(selectedDeviceIndexes).sort((a, b) => b - a);
    if (!indexes.length) return;
    Modal.open({
      title: `Delete ${indexes.length} selected device${indexes.length === 1 ? '' : 's'}`,
      confirmText: 'Delete selected',
      body: `<p>Delete ${indexes.length} selected device${indexes.length === 1 ? '' : 's'}? You can restore this change with Undo.</p>`,
      onOpen: () => { document.getElementById('modalConfirm').className = 'btn btn-danger'; },
      onConfirm: () => {
        const inventory = getInventory();
        indexes.forEach((index) => inventory.splice(index, 1));
        try {
          setInventory(inventory);
          selectedDeviceIndexes.clear();
          Modal.close();
          render(container, country);
          Toast.show(`Deleted ${indexes.length} device${indexes.length === 1 ? '' : 's'}.`, 'success');
        } catch (error) {
          Toast.show(`Could not delete selected devices: ${error.message || error}`, 'error');
        }
      }
    });
  }

  function openDeviceForm(container, country, index = null, defaultType = activeDeviceType || '') {
    if (!window.DEPLOYMENT_STATUS) console.error('constants.js not loaded before inventory.js');
    const inventory = getInventory();
    const device = index === null ? {} : inventory[index];
    const isEditing = index !== null;
    const selectedType = isEditing ? getAssetType(device) : (defaultType ? resolveDeviceTypeValue(defaultType) : '');
    const staffOptions = App.modules.users?.checkoutOptions?.() || [];
    const primaryFields = ['Fixed Asset Number', 'Device ID', 'Device name', 'Serial number', 'Manufacturer', 'Model'];
    const warrantyFields = ['Purchase Date', 'Warranty Start Date', 'Warranty End Date', 'Disposal Date'];
    const renderEditableField = (key) => {
      const [, label] = EDITABLE_FIELDS.find(([field]) => field === key) || [key, key];
      const currentValue = key === 'Device Online Status' ? getDeviceOnlineStatus(device)
        : key === 'Total storage (GB)' ? getTotalStorageGb(device) ?? ''
          : getInventoryField(device, key);
      const value = ['Purchase Date', 'Warranty Start Date', 'Warranty End Date', 'Disposal Date', 'Battery replacement date'].includes(key)
        ? dateInputValue(currentValue)
        : currentValue;
      const required = ['Device name', 'Serial number'].includes(key);
      const control = key === 'Country'
        ? `<select class="form-control" name="Country"><option value="">Select a country</option>${Object.entries(DEVICE_COUNTRIES).map(([code, country]) => `<option value="${escapeHtml(country)}" ${value === country ? 'selected' : ''}>${escapeHtml(country)}</option>`).join('')}</select>`
        : key === 'Device Online Status'
        ? `<select class="form-control" name="${escapeHtml(key)}" data-online-status="true">${['Active', 'Inactive>90days', 'Unknown'].map((status) => `<option value="${escapeHtml(status)}" ${value === status ? 'selected' : ''}>${escapeHtml(status)}</option>`).join('')}</select>`
        : `<input class="form-control" name="${escapeHtml(key)}" value="${escapeHtml(value)}" ${required ? 'required' : ''}${key === 'Total storage (GB)' ? ' type="number" min="0" step="0.01"' : ''}${['Purchase Date', 'Warranty Start Date', 'Warranty End Date', 'Disposal Date', 'Battery replacement date'].includes(key) ? ' placeholder="YYYY-MM-DD"' : ''}>`;
      return `<label class="device-form-field"><span${key === 'Fixed Asset Number' ? ` title="${escapeHtml(FIXED_ASSET_NUMBER_HELP)}"` : ''}>${escapeHtml(label)}${required ? ' <span class="required">*</span>' : ''}</span>${control}</label>`;
    };
    const optionalFields = EDITABLE_FIELDS.filter(([key]) => (
      !primaryFields.includes(key)
      && !['Primary user display name', 'Primary user email address', 'Country', 'Location', ...warrantyFields].includes(key)
    )).map(([key]) => key);
    Modal.open({
      title: isEditing ? 'Edit device' : 'Add device',
      confirmText: isEditing ? 'Save changes' : 'Add device',
      size: 'lg',
      body: `<form id="deviceForm" class="device-form device-form-structured">
        <section class="device-form-panel form-grid-full">
          <header class="device-form-panel-heading"><h3>Asset Details</h3><p>Enter the identifying information and current status.</p></header>
          <div class="device-form-panel-grid">
            <label class="device-form-field"><span>Device type</span><input class="form-control" name="Asset type" list="category-datalist" value="${escapeHtml(selectedType)}"><datalist id="category-datalist">${getCategoryOptions().map((val) => `<option value="${escapeHtml(val)}"></option>`).join('')}</datalist></label>
            ${primaryFields.map(renderEditableField).join('')}
            <label class="device-form-field"><span>Deployment status</span><select class="form-control" name="deployment_status" id="deviceDeploymentStatus">${buildEnumOptionsHtml(window.DEPLOYMENT_STATUS, isEditing ? getDeviceDeploymentStatusValue(device) : 'In Stock', ' (legacy)')}</select></label>
            <label class="device-form-field"><span>Hardware Health</span><select class="form-control" name="condition" id="deviceCondition"${getDeviceDeploymentStatusValue(device) === 'Disposed' ? ' disabled' : ''}>${buildEnumOptionsHtml(window.CONDITION, isEditing ? getDeviceConditionValue(device) : 'Good', ' (legacy)', window.CONDITION_LABELS)}</select></label>
            <div class="device-form-field" id="deviceArchivedField"><span>Archived</span><input type="checkbox" name="is_archived" id="deviceIsArchived" ${isEditing && isDeviceArchivedValue(device) ? 'checked' : ''}></div>
            <div class="device-form-field" id="deviceDispositionMethodField" style="display: none;"><span>Disposition method</span><select class="form-control" name="disposition_method" id="deviceDispositionMethod">${buildEnumOptionsHtml(window.DISPOSITION_METHOD, isEditing ? getDeviceDispositionMethodValue(device) : '', ' (legacy)')}</select></div>
            <div id="deviceConditionWarning" style="display: none;" class="replacement-warning"></div>
            <div id="deviceConditionInfo" style="display: none;" class="badge badge-yellow"></div>
          </div>
        </section>
        <section class="device-form-panel form-grid-full">
          <header class="device-form-panel-heading"><h3>Assignment &amp; Location</h3><p>Optionally record who currently uses the device and where it is kept.</p></header>
          <div class="device-form-panel-grid">
            <label class="device-form-field"><span>Primary user (search by name or email)</span><input class="form-control" id="primaryUserLookup" list="inventoryUserSuggestions" autocomplete="off" value="${escapeHtml(device['Primary user display name'] || '')}" placeholder="Type a user name or email"></label>
            <label class="device-form-field"><span>Primary user email</span><input class="form-control" id="primaryUserEmail" type="email" list="inventoryUserSuggestions" value="${escapeHtml(device['Primary user email address'] || device['Primary user UPN'] || '')}" placeholder="Select a user or enter a new email"></label>
            ${renderEditableField('Country')}
            ${renderEditableField('Location')}
            ${staffSuggestions(staffOptions, 'inventoryUserSuggestions')}
          </div>
        </section>
        <details class="device-form-disclosure form-grid-full">
          <summary>Optional Information</summary>
          <div class="device-form-panel-grid">${optionalFields.map(renderEditableField).join('')}</div>
        </details>
        <details class="device-form-disclosure form-grid-full">
          <summary>Warranty Details</summary>
          <div class="device-form-panel-grid">${warrantyFields.map(renderEditableField).join('')}</div>
        </details>
      </form>`,
      onOpen: () => {
        const lookup = document.getElementById('primaryUserLookup');
        const emailInput = document.getElementById('primaryUserEmail');
        const onlineStatusInput = document.querySelector('#deviceForm select[data-online-status="true"]');
        onlineStatusInput?.addEventListener('change', () => { onlineStatusInput.dataset.edited = 'true'; });
        const deploymentStatusInput = document.getElementById('deviceDeploymentStatus');
        const conditionInput = document.getElementById('deviceCondition');
        const dispositionMethodField = document.getElementById('deviceDispositionMethodField');
        const conditionWarningField = document.getElementById('deviceConditionWarning');
        const conditionInfoField = document.getElementById('deviceConditionInfo');
        const updateStatusConditions = () => {
          const deploymentStatus = String(deploymentStatusInput?.value || '').trim();
          const conditionValue = String(conditionInput?.value || '').trim();
          const locked = deploymentStatus === 'Disposed';
          if (conditionInput) conditionInput.disabled = locked;
          if (conditionInput && locked) conditionInput.value = 'End of Life';
          if (dispositionMethodField) dispositionMethodField.style.display = deploymentStatus === 'Retired' ? '' : 'none';
          const showRepairWarning = conditionValue === 'Needs Repair' && deploymentStatus === 'In Use';
          if (conditionWarningField) conditionWarningField.style.display = showRepairWarning ? '' : 'none';
          if (conditionWarningField && showRepairWarning) conditionWarningField.textContent = `Hardware Health "${conditionValue}" is set while deployment status is "In Use"; schedule the repair before handover.`;
          if (conditionInfoField) conditionInfoField.style.display = conditionValue === 'Unknown' ? '' : 'none';
          if (conditionInfoField) conditionInfoField.innerHTML = conditionValue === 'Unknown' ? '<span class="badge badge-yellow">Hardware Health assessment pending</span>' : '';
        };
        deploymentStatusInput?.addEventListener('change', updateStatusConditions);
        conditionInput?.addEventListener('change', updateStatusConditions);
        updateStatusConditions();
        bindStaffAutocomplete(lookup, emailInput, staffOptions);
        lookup?.addEventListener('input', () => {
          if (lookup.value.trim().includes('@') && !staffOptions.some((user) => user.email.toLowerCase() === lookup.value.trim().toLowerCase())) {
            emailInput.value = lookup.value.trim();
          }
        });
      },
      onConfirm: async () => {
        const form = document.getElementById('deviceForm');
        if (!form.reportValidity()) return;
        const formData = new FormData(form);
        const updated = { ...device };
        const typedAssetType = String(formData.get('Asset type') || '').trim();
        const normalizedTypedAssetType = typedAssetType.toLowerCase().replace(/[\s_-]+/g, '');
        const standardType = DEVICE_TYPES.find((item) => item.value === normalizedTypedAssetType)
          || (normalizedTypedAssetType === 'switches' ? DEVICE_TYPES.find((item) => item.value === 'switch') : null);
        if (standardType) {
          updated['Asset type'] = standardType.value;
        } else if (typedAssetType) {
          updated['Asset type'] = typedAssetType;
          // Persist new category value to server
          fetch('/api/field-options', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fieldName: 'Asset type', value: typedAssetType })
          }).then(async () => {
            // Refresh field options locally so combobox shows new value immediately
            try {
              const resp = await fetch('/api/field-options');
              if (resp.ok) {
                const data = await resp.json();
                App.fieldOptions = data.options || {};
              }
            } catch {}
          }).catch(() => {}); // non-fatal
        } else {
          updated['Asset type'] = 'laptop';
        }
        EDITABLE_FIELDS.forEach(([key]) => {
          if (key !== 'Device Online Status') updated[key] = String(formData.get(key) || '').trim();
        });
        for (const dateKey of ['Purchase Date', 'Warranty Start Date', 'Warranty End Date', 'Disposal Date']) {
          const normalized = normalizeDateInput(updated[dateKey], { allowAmbiguousSlash: false });
          if (normalized.error) {
            Toast.show(`${dateKey}: ${normalized.error}`, 'error', 6000);
            return;
          }
          updated[dateKey] = normalized.iso;
        }
        const onlineStatusInput = form.elements.namedItem('Device Online Status');
        if (onlineStatusInput?.dataset.edited === 'true') {
          updated['Device Online Status'] = String(formData.get('Device Online Status') || '').trim();
        } else if (!['Active', 'Inactive>90days', 'Unknown'].includes(String(device['Device Online Status'] || '').trim())) {
          delete updated['Device Online Status'];
        }
        const typedUser = String(form.querySelector('#primaryUserLookup').value || '').trim();
        const typedEmail = String(form.querySelector('#primaryUserEmail').value || '').trim();
        const selectedUser = staffOptions.find((user) => (!typedUser || user.name.toLowerCase() === typedUser.toLowerCase())
          && (!typedEmail || user.email.toLowerCase() === typedEmail.toLowerCase())
          && (user.name.toLowerCase() === typedUser.toLowerCase() || user.email.toLowerCase() === typedEmail.toLowerCase()));
        updated['Primary user display name'] = selectedUser?.name || (typedUser.includes('@') ? '' : typedUser);
        updated['Primary user email address'] = selectedUser?.email || typedEmail || (typedUser.includes('@') ? typedUser : '');
        updated['Primary user UPN'] = updated['Primary user email address'];
        const deploymentStatus = String(formData.get('deployment_status') || '').trim();
        const condition = String(formData.get('condition') || '').trim();
        const dispositionMethod = String(formData.get('disposition_method') || '').trim();
        const isArchived = formData.get('is_archived') === 'on';
        updated['deployment_status'] = deploymentStatus;
        updated['condition'] = deploymentStatus === 'Disposed' ? 'End of Life' : condition;
        updated['is_archived'] = isArchived;
        updated['disposition_method'] = deploymentStatus === 'Retired' ? dispositionMethod : '';
        updated['Status Label'] = deriveStatusLabel(updated);
        if (!updated['Device name'] || !updated['Serial number']) {
          Toast.show('Device name and serial number are required.', 'error');
          return;
        }
        const newKey = normalizeSerialKey(updated['Serial number']);
        const serialExists = inventory.some((item, itemIndex) => itemIndex !== index && normalizeSerialKey(item['Serial number']) === newKey);
        if (serialExists && (!isEditing || normalizeSerial(device['Serial number']) !== normalizeSerial(updated['Serial number']))) {
          Toast.show('A device with this serial number already exists. Resolve it during CSV import or use a unique serial.', 'error');
          return;
        }
        updated['Duplicate Serial'] = isEditing && normalizeSerial(updated['Serial number']) === normalizeSerial(device['Serial number']) ? device['Duplicate Serial'] === true : false;
        delete updated['Total storage'];
        delete updated['Total Storage'];
        if (isEditing) inventory[index] = updated;
        else inventory.push({ ...updated, 'Warranty Match Status': updated['Warranty Match Status'] || 'Unmatched', 'Duplicate Serial': false });
        try {
          const userName = updated['Primary user display name'];
          const userEmail = updated['Primary user email address'];
          const managedUsers = App.store.get('users') || [];
          const existingUser = managedUsers.find((user) => (userEmail && String(user.Email || '').trim().toLowerCase() === userEmail.toLowerCase()) || (userName && String(user.Name || '').trim().toLowerCase() === userName.toLowerCase()));
          if ((userName || userEmail) && !existingUser && userName) {
            const newUser = {
              UserID: `usr-${globalThis.crypto?.randomUUID?.() || `user-${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
              Name: userName,
              Email: userEmail,
              Country: updated.Country || '',
              Location: updated.Location || ''
            };
            await App.store.set('users', [...managedUsers, newUser]);
          }
          setInventory(inventory);
          await (App.store.writeQueues.get('inventory') || Promise.resolve());
          Modal.close();
          render(container, country);
          Toast.show(isEditing ? 'Device updated.' : 'Device added.', 'success');
        } catch (error) {
          Toast.show(`Could not save inventory: ${error.message || error}`, 'error');
        }
      }
    });
  }

  function deleteDevice(container, country, index) {
    const inventory = getInventory();
    const device = inventory[index];
    if (!device) return;
    Modal.open({
      title: 'Delete device',
      confirmText: 'Delete',
      body: `<p>Delete <strong>${escapeHtml(device['Device name'] || 'this device')}</strong> (${escapeHtml(device['Serial number'] || 'no serial')})? You can restore this change with Undo.</p>`,
      onOpen: () => { document.getElementById('modalConfirm').className = 'btn btn-danger'; },
      onConfirm: () => {
        inventory.splice(index, 1);
        selectedDeviceIndexes.clear();
        try {
          setInventory(inventory);
          Modal.close();
          render(container, country);
          Toast.show('Device deleted.', 'success');
        } catch (error) {
          Toast.show(`Could not save inventory: ${error.message || error}`, 'error');
        }
      }
    });
  }

  function render(container, country = 'all') {
    const previousSearch = container.querySelector('#inventorySearch')?.value || '';
    const rows = getInventory();
    updateDeviceTypeNavigation();
    const history = getHistoryState();
    const searchBox = document.getElementById('inventorySearch');
    const currentSearchValue = (searchBox ? searchBox.value : '').trim().toLowerCase();
    const filteredRows = getFilteredRows(rows, country, currentSearchValue);

    const categoryRows = activeDeviceType ? rows.filter((device) => getAssetType(device) === activeDeviceType) : rows;
    const inventorySummary = activeDeviceType
      ? `${filteredRows.length} matching records · ${categoryRows.length} ${escapeHtml(deviceTypeLabel(activeDeviceType))} devices · ${rows.length} total`
      : `${filteredRows.length} matching records · ${rows.length} total`;
    const overdueCount = rows.filter((device) => isReturnOverdue(getCurrentCheckout(device))).length;
    const inventoryStatus = overdueCount ? ` · ${overdueCount} overdue return${overdueCount === 1 ? '' : 's'}` : '';
    const visibleColumns = getVisibleColumns();
    const orderedColumns = getOrderedLayoutColumns();

    container.innerHTML = `
      <div class="section-header">
        <div>
          <div class="section-title">${activeDeviceType ? `${escapeHtml(deviceTypeLabel(activeDeviceType))} Inventory` : 'Asset Inventory'}</div>
          <div class="section-sub">${inventorySummary}${inventoryStatus} · saved in local SQLite database${dashboardFilterLabel ? ` · Dashboard: ${escapeHtml(dashboardFilterLabel)}` : ''}</div>
        </div>
        <div class="section-actions">
          <button class="btn btn-primary btn-sm" id="addDeviceBtn">+ Add ${activeDeviceType ? escapeHtml(deviceTypeLabel(activeDeviceType)) : 'device'}</button>
          <div class="inventory-action-group" aria-label="Inventory actions">
            <button class="btn btn-secondary btn-sm" id="undoInventoryBtn" ${history.undo.length ? '' : 'disabled'}>Undo</button>
            <button class="btn btn-secondary btn-sm" id="redoInventoryBtn" ${history.redo.length ? '' : 'disabled'}>Redo</button>
          </div>
        </div>
      </div>

      <div class="filter-bar inventory-filters">
        <input id="inventorySearch" class="search-input" placeholder="Search all fields: device, user, serial, warranty, status..." value="${escapeHtml(previousSearch)}" />
      </div>

      <div class="bulk-actions" role="region" aria-label="Selected device actions">
        <span id="selectedDeviceCount">${selectedDeviceIndexes.size} selected</span>
        <button class="btn btn-secondary btn-sm" id="bulkEditBtn" ${selectedDeviceIndexes.size ? '' : 'disabled'}>Edit selected</button>
        <button class="btn btn-danger btn-sm" id="bulkDeleteBtn" ${selectedDeviceIndexes.size ? '' : 'disabled'}>Delete selected</button>
      </div>

      ${renderLayoutControls()}

      <div class="card inventory-table-wrap">
        <table class="inventory-table">
          <colgroup><col />${orderedColumns.map((column) => `<col data-layout-column="${escapeHtml(column)}" ${visibleColumns.includes(column) ? '' : 'class="column-hidden"'} />`).join('')}<col /></colgroup>
          <thead><tr><th><input type="checkbox" id="selectAllDevices" aria-label="Select all visible devices" ${filteredRows.length && filteredRows.every((device) => selectedDeviceIndexes.has(rows.indexOf(device))) ? 'checked' : ''}></th>${orderedColumns.map((col) => `<th data-layout-column="${escapeHtml(col)}"${visibleColumns.includes(col) ? '' : ' class="column-hidden"'}${col === 'Fixed Asset Number' ? ` title="${escapeHtml(FIXED_ASSET_NUMBER_HELP)}"` : ''}>${escapeHtml(col === 'Intune Group Tag' ? 'Intune Group Tag' : col === 'Intune GroupName' ? 'Intune GroupName' : col === 'Asset type' ? 'Category' : col === 'OS version' ? 'OS Version' : col)}</th>`).join('')}<th>Actions</th></tr></thead>
          <tbody>${renderTableBody(filteredRows, rows)}</tbody>
        </table>
      </div>
    `;

    decorateTableColumns(container);

    const searchInput = container.querySelector('#inventorySearch');
    searchInput.addEventListener('input', () => {
      selectedDeviceIndexes.clear();
      const hadFocus = document.activeElement === searchInput;
      const searchValue = String(searchInput.value ?? '');
      const caretPosition = searchInput.selectionStart ?? searchValue.length;
      const caretEnd = searchInput.selectionEnd ?? searchValue.length;
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        syncInventoryFiltersToUrl(searchValue);
        render(container, country);
        if (hadFocus) {
          const updatedSearchBox = container.querySelector('#inventorySearch');
          if (updatedSearchBox) {
            updatedSearchBox.focus();
            updatedSearchBox.setSelectionRange(caretPosition, caretEnd);
          }
        }
      }, 250);
    });
    const updateBulkControls = () => {
      const count = selectedDeviceIndexes.size;
      container.querySelector('#selectedDeviceCount').textContent = `${count} selected`;
      container.querySelector('#bulkEditBtn').disabled = count === 0;
      container.querySelector('#bulkDeleteBtn').disabled = count === 0;
      const visibleIndices = filteredRows.map((device) => rows.indexOf(device));
      const selectAll = container.querySelector('#selectAllDevices');
      selectAll.checked = visibleIndices.length > 0 && visibleIndices.every((index) => selectedDeviceIndexes.has(index));
      selectAll.indeterminate = visibleIndices.some((index) => selectedDeviceIndexes.has(index)) && !selectAll.checked;
    };
    container.querySelector('#selectAllDevices').addEventListener('change', (event) => {
      filteredRows.forEach((device) => {
        const index = rows.indexOf(device);
        if (event.target.checked) selectedDeviceIndexes.add(index);
        else selectedDeviceIndexes.delete(index);
      });
      container.querySelectorAll('.device-select-checkbox').forEach((checkbox) => {
        checkbox.checked = event.target.checked;
        checkbox.closest('tr').classList.toggle('inventory-selected', event.target.checked);
      });
      updateBulkControls();
    });
    container.querySelectorAll('.device-select-checkbox').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const index = Number(checkbox.dataset.index);
        if (checkbox.checked) selectedDeviceIndexes.add(index);
        else selectedDeviceIndexes.delete(index);
        checkbox.closest('tr').classList.toggle('inventory-selected', checkbox.checked);
        updateBulkControls();
      });
    });
    container.querySelector('#bulkEditBtn').addEventListener('click', () => applyBulkEdit(container, country));
    container.querySelector('#bulkDeleteBtn').addEventListener('click', () => deleteSelectedDevices(container, country));
    container.querySelector('#undoInventoryBtn').addEventListener('click', () => {
      try {
        if (restoreInventoryHistory('undo')) {
          selectedDeviceIndexes.clear();
          render(container, country);
          Toast.show('Last inventory change undone.', 'success');
        }
      } catch (error) {
        Toast.show(`Undo failed: ${error.message || error}`, 'error');
      }
    });
    container.querySelector('#redoInventoryBtn').addEventListener('click', () => {
      try {
        if (restoreInventoryHistory('redo')) {
          selectedDeviceIndexes.clear();
          render(container, country);
          Toast.show('Inventory change restored.', 'success');
        }
      } catch (error) {
        Toast.show(`Redo failed: ${error.message || error}`, 'error');
      }
    });
    container.querySelector('#addDeviceBtn').addEventListener('click', () => openDeviceForm(container, country));
    container.querySelectorAll('.checkout-device-btn').forEach((button) => {
      button.addEventListener('click', () => openCheckoutForm(container, country, Number(button.dataset.index), 'checkout'));
    });
    container.querySelectorAll('.checkin-device-btn').forEach((button) => {
      button.addEventListener('click', () => openCheckoutForm(container, country, Number(button.dataset.index), 'checkin'));
    });
    container.querySelectorAll('.checkout-history-btn').forEach((button) => {
      button.addEventListener('click', () => {
        const device = getInventory()[Number(button.dataset.index)];
        if (device) openCheckoutHistory(device);
      });
    });

    bindLayoutControlEvents(container);

    container.querySelectorAll('[data-clear-filter-chip]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-clear-filter-chip');
        if (!key) return;
        filterState[key] = '';
        persistCoreFilterState();
        render(container, country);
      });
    });
    container.querySelector('[data-clear-warranty-chip]')?.addEventListener('click', () => {
      warrantyStatusFilter = '';
      render(container, country);
    });
    container.querySelectorAll('[data-clear-flag-chip]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-clear-flag-chip');
        if (key === 'duplicatesOnly') filterState.duplicatesOnly = false;
        if (key === 'showArchived') filterState.showArchived = false;
        persistCoreFilterState();
        render(container, country);
      });
    });
    container.querySelector('#clearAllInventoryFiltersBtnInline')?.addEventListener('click', () => {
      clearAllInventoryFilters(container);
      render(container, country);
    });
  }

  function clearInventoryFilters(container) {
    const search = container.querySelector('#inventorySearch');
    if (search) search.value = '';
    filterState = { ...DEFAULT_FILTER_STATE };
    localStorage.removeItem('nexit_inventory_duplicates_only');
    localStorage.removeItem('nexit_inventory_show_archived');
    localStorage.removeItem('nexit_inventory_deployment_status');
    localStorage.removeItem('nexit_inventory_condition');
  }

  document.addEventListener('click', (event) => {
    const dropdown = document.querySelector('.inactive-layout-dropdown');
    if (dropdown && dropdown.open && !dropdown.contains(event.target)) dropdown.removeAttribute('open');
  });

  return {
    render,
    parseCsvText,
    openCsvTemplateModal,
    renderImportReport,
    promptInventoryExport,
    exportCurrentInventory,
    importInventoryCsvFile,
    downloadDatabaseBackup,
    confirmDatabaseRestore,
    confirmClearDatabase,
    currentCheckoutFor(device) {
      return getCurrentCheckout(device);
    },
    countryForDevice(device) {
      return getDeviceCountryCode(device);
    },
  getDeviceType() {
    return activeDeviceType;
  },
  getDeviceTypeLabel() {
    return activeDeviceType ? deviceTypeLabel(activeDeviceType) : '';
  },
  refreshDeviceTypeNavigation() {
    updateDeviceTypeNavigation();
  },
  selectDeviceType(deviceType) {
    let nextType = '';
    if (deviceType) {
      try {
        nextType = normalizeDeviceType(deviceType);
      } catch {
        nextType = String(deviceType || '').trim();
      }
    }
    activeDeviceType = nextType;
    filterState = { ...DEFAULT_FILTER_STATE };
    warrantyStatusFilter = '';
    dashboardRecordIndexes = null;
    dashboardFilterLabel = '';
    selectedDeviceIndexes.clear();
    const container = document.getElementById('moduleContainer');
    if (container && App.currentModule === 'inventory') {
      clearInventoryFilters(container);
      render(container, App.countryFilter);
    } else {
      syncInventoryFiltersToUrl('');
    }
  },
  showDashboardResults(indexes, label) {
      const inventoryCount = getInventory().length;
      if (!Array.isArray(indexes) || !indexes.every((index) => Number.isInteger(index) && index >= 0 && index < inventoryCount)) {
        throw new Error('Dashboard returned invalid inventory record indexes.');
      }
      dashboardRecordIndexes = new Set(indexes);
      dashboardFilterLabel = label;
      selectedDeviceIndexes.clear();
      App.navigateTo('inventory');
    },
    showAll() {
      filterState = { ...DEFAULT_FILTER_STATE };
      warrantyStatusFilter = '';
      dashboardRecordIndexes = null;
      dashboardFilterLabel = '';
      activeDeviceType = '';
      selectedDeviceIndexes.clear();
      updateDeviceTypeNavigation();
      const container = document.getElementById('moduleContainer');
      if (container) {
        clearInventoryFilters(container);
        render(container, App.countryFilter);
      } else {
        syncInventoryFiltersToUrl('');
      }
    },
    showDuplicates() {
      dashboardRecordIndexes = null;
      dashboardFilterLabel = '';
      activeDeviceType = '';
      warrantyStatusFilter = '';
      selectedDeviceIndexes.clear();
      filterState = { ...DEFAULT_FILTER_STATE, duplicatesOnly: true };
      persistCoreFilterState();
      const container = document.getElementById('moduleContainer');
      if (container) render(container, App.countryFilter);
      else syncInventoryFiltersToUrl(document.getElementById('inventorySearch')?.value || '');
    },
    showWarrantyMatched() {
      dashboardRecordIndexes = null;
      dashboardFilterLabel = '';
      activeDeviceType = '';
      filterState = { ...DEFAULT_FILTER_STATE };
      warrantyStatusFilter = 'Matched';
      selectedDeviceIndexes.clear();
      persistCoreFilterState();
      const container = document.getElementById('moduleContainer');
      if (container) render(container, App.countryFilter);
      else syncInventoryFiltersToUrl(document.getElementById('inventorySearch')?.value || '');
    },
    onCountryChange(country) {
      const element = document.getElementById('moduleContainer');
      if (element) render(element, country);
    }
  };
})());
