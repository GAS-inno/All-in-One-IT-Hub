App.registerModule('inventory', (() => {
  const STORAGE_KEY = 'inventory';
  const WARRANTY_KEY = 'warranty';
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
    'Asset type', 'Fixed Asset Number', 'Device ID', 'Device name', 'Country', 'Ownership', 'Compliance', 'OS', 'OS version',
    'Primary user email address', 'Primary user UPN', 'Last check-in', 'Enrollment date',
    'Model', 'Manufacturer', 'Serial number', 'Primary user display name', 'Total storage',
    'Free storage', 'Azure AD registered', 'IntuneGroup.GroupName', 'IntuneGroup.DeviceName',
    'IntuneGroup.SerialNumber', 'IntuneGroup.GroupTag', 'IntuneGroup.Model', 'IntuneGroup.Manufacturer',
    'WindowsVersion', 'Total storage (GB)', 'Location', 'Management IP', 'Firmware version',
    'UPS Capacity (VA)', 'Battery replacement date', 'Warranty Start Date', 'Warranty End Date', 'Warranty Match Status', 'Age', 'Active device status'
  ];
  const REPLACEMENT_COLUMNS = [
    'Replacement Status', 'Replaced For Staff Member', 'Replacement Date',
    'Replaced By Device Serial Number', 'Replacement Count', 'Handover Eligibility', 'Lifecycle Status'
  ];
  const DEFAULT_VISIBLE_COLUMNS = [
    'Asset type', 'Fixed Asset Number', 'Device name', 'Country', 'Serial number', 'Manufacturer', 'Model', 'Location',
    'Management IP', 'Firmware version', 'UPS Capacity (VA)', 'Battery replacement date', 'Compliance',
    'Primary user email address', 'IntuneGroup.GroupName', 'IntuneGroup.GroupTag',
    'Last check-in', 'Total storage (GB)', 'Warranty Start Date', 'Warranty End Date', 'Age',
    'Warranty Match Status', 'Active device status', ...REPLACEMENT_COLUMNS
  ];
  const LAYOUT_COLUMNS = [
    'Asset type', 'Fixed Asset Number', 'Device name', 'Country', 'Serial number', 'Manufacturer', 'Model', 'Location',
    'Management IP', 'Firmware version', 'UPS Capacity (VA)', 'Battery replacement date', 'OS', 'Compliance',
    'Primary user email address', 'IntuneGroup.GroupName', 'IntuneGroup.GroupTag', 'Last check-in', 'Active device status',
    'Total storage (GB)', 'Warranty Start Date', 'Warranty End Date', 'Age', 'Warranty Match Status', ...REPLACEMENT_COLUMNS
  ];

  function normalizeHeader(value) {
    return String(value || '').replace(/\uFEFF/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  }

  const MAX_HISTORY_STATES = 10;
  const MAX_HISTORY_BYTES = 20 * 1024 * 1024;
  let historyState = { undo: [], redo: [] };
  let duplicatesOnly = false;
  let warrantyStatusFilter = '';
  let dashboardRecordIndexes = null;
  let dashboardFilterLabel = '';
  let selectedDeviceIndexes = new Set();
  let activeDeviceType = '';

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

  function getCountryCodeFromDeviceName(deviceName) {
    const prefix = String(deviceName || '').trim().slice(0, 2).toUpperCase();
    return Object.prototype.hasOwnProperty.call(DEVICE_COUNTRIES, prefix) ? prefix : '';
  }

  function getCountryFromDeviceName(deviceName) {
    return DEVICE_COUNTRIES[getCountryCodeFromDeviceName(deviceName)] || '';
  }

  function getAssetType(record) {
    const category = record['Asset type'];
    if (category) return normalizeDeviceType(category);
    const legacyType = record['Device type'] || record['Device Type'] || record.Type;
    if (!legacyType) return 'laptop';
    try {
      return normalizeDeviceType(legacyType);
    } catch {
      return 'laptop';
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
    navigation.innerHTML = DEVICE_TYPES
      .filter(({ value }) => counts.get(value) > 0)
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
      Country: getCountryFromDeviceName(device['Device name'])
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
    return Array.isArray(list) ? list.map((device) => ({
      ...device,
      'Asset type': getAssetType(device),
      Country: getCountryFromDeviceName(device['Device name'])
    })) : [];
  }

  function getWarrantyData() {
    return App.store.get(WARRANTY_KEY) || [];
  }

  function setWarrantyData(list) {
    App.store.set(WARRANTY_KEY, Array.isArray(list) ? list : []);
  }

  function getVisibleColumns() {
    try {
      const saved = JSON.parse(localStorage.getItem('nexit_inventory_layout') || 'null');
      if (!saved || !Array.isArray(saved.visible) || !saved.visible.length) return DEFAULT_VISIBLE_COLUMNS;
      if (saved.version !== 8) {
        const allowedColumns = [...DEFAULT_COLUMNS, ...REPLACEMENT_COLUMNS];
        const migrated = Array.from(new Set([...saved.visible, 'Asset type', 'Fixed Asset Number', 'Country', 'Location', 'Age', 'Active device status', ...REPLACEMENT_COLUMNS]))
          .filter((col) => allowedColumns.includes(col));
        saveVisibleColumns(migrated);
        return migrated;
      }
      const allowedColumns = [...DEFAULT_COLUMNS, ...REPLACEMENT_COLUMNS];
      const visible = saved.visible.filter((col) => allowedColumns.includes(col));
      return visible.length ? visible : ['Device name'];
    } catch {
      return DEFAULT_VISIBLE_COLUMNS;
    }
  }

  function saveVisibleColumns(columns) {
    localStorage.setItem('nexit_inventory_layout', JSON.stringify({ visible: columns, version: 8 }));
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
    return normalizeSerial(value).replace(/--\d+$/, '').replace(/\s+/g, '');
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

  function formatGb(value) {
    if (value === null || value === undefined || value === '') return '—';
    return Number(value).toFixed(2);
  }

  function parseDateValue(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function getDaysSince(dateValue) {
    const date = parseDateValue(dateValue);
    if (!date) return null;
    return Math.round((Date.now() - date.getTime()) / 86400000);
  }

  function getActiveDeviceStatus(device) {
    const daysSinceCheckIn = getDaysSince(device['Last check-in']);
    if (daysSinceCheckIn !== null && daysSinceCheckIn > 90) return 'Inactive';
    return 'Active';
  }

  function getWarrantyAge(startDateValue, endDateValue) {
    const start = parseDateValue(startDateValue);
    const end = parseDateValue(endDateValue);
    if (!start || !end) return '—';
    const totalMonths = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
    const years = Math.max(0, Math.floor(totalMonths / 12));
    const months = Math.max(0, totalMonths - years * 12);
    return `${years}y ${months}m`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function coerceRecord(rawRow) {
    const record = {};
    Object.entries(rawRow).forEach(([key, value]) => {
      record[key] = value == null ? '' : String(value).trim();
    });

    const serialFromRaw = [
      record['Serial number'], record['serialNumber'], record['Serial Number'], record['IntuneGroup.SerialNumber'],
      record['serial'], record['Serial']
    ].find((value) => String(value || '').trim()) || '';

    const deviceName = [
      record['Device name'], record['Device Name'], record['deviceName'], record['Device name '], record['device name']
    ].find((value) => String(value || '').trim()) || 'Unknown Device';

    const deviceId = [
      record['Device ID'], record['DeviceId'], record['deviceId'], record['Device id'], record['Device ID ']
    ].find((value) => String(value || '').trim()) || 'N/A';

    const userEmail = record['Primary user email address'] || record['Primary User Email Address'] || record['User Principal Name'] || record['Primary user UPN'] || '';
    const groupName = record['IntuneGroup.GroupName'] || record['IntuneGroup.Group Name'] || record['Group Name'] || '';
    const groupTag = record['IntuneGroup.GroupTag'] || record['Group tag'] || record['Group Tag'] || record['GroupTag'] || '';
    const storageRaw = record['Total storage'] || record['Total Storage'] || '';
    const storageGb = parseStorageValue(storageRaw, 'bytes');
    const assetTypeInput = record['Asset type'];
    const deviceTypeInput = assetTypeInput || record['Device type'] || record['Device Type'] || record.Type || activeDeviceType;
    let assetType = activeDeviceType || 'laptop';
    if (deviceTypeInput) {
      try {
        assetType = normalizeDeviceType(deviceTypeInput);
      } catch (error) {
        if (assetTypeInput) throw error;
      }
    }

    return {
      ...record,
      'Asset type': assetType,
      'Device ID': deviceId,
      'Device name': deviceName,
      'Serial number': serialFromRaw,
      'Primary user email address': userEmail,
      'IntuneGroup.GroupName': groupName,
      'IntuneGroup.GroupTag': groupTag,
      'Total storage': storageRaw,
      'Total storage (GB)': storageGb === null ? '' : Number(storageGb.toFixed(2)),
      'Warranty End Date': record['Warranty End Date'] || record['Warranty end date'] || '',
      'Warranty Start Date': record['Warranty Start Date'] || record['Warranty start date'] || '',
      'Warranty Match Status': record['Warranty Match Status'] || 'Unmatched',
      'Duplicate Serial': record['Duplicate Serial'] === true,
      'Last check-in': record['Last check-in'] || record['Last Check-In'] || record['Last checkin'] || '',
      'Enrollment date': record['Enrollment date'] || record['Enrollment Date'] || '',
      'IntuneGroup.SerialNumber': record['IntuneGroup.SerialNumber'] || serialFromRaw
    };
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

  function validateInventoryImportColumns(headerRow) {
    const normalizedHeaders = headerRow.map((header) => normalizeHeader(header));
    const databaseColumns = ['serial number', 'warranty start date', 'warranty end date', 'warranty match status', 'last check in'];
    const recognized = [];
    const unrecognized = [];
    normalizedHeaders.forEach((header) => {
      if (databaseColumns.includes(header)) recognized.push(header);
      else unrecognized.push(header);
    });
    const missingRequired = ['device name', 'serial number'].filter((key) => !normalizedHeaders.includes(key));
    return { recognized, unrecognized, missingRequired };
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
    'serial number': 'Serial number',
    'warranty start date': 'Warranty Start Date',
    'warranty end date': 'Warranty End Date',
    'warranty match status': 'Warranty Match Status',
    'last check in': 'Last check-in'
  };

  function renderImportReport({ title, summaryLines = [], recognizedColumns = [], unrecognizedColumns = [] }) {
    const summaryHtml = summaryLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('');
    const recognizedList = recognizedColumns.length
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

      records.push({
        'Serial number': serialTrimmed,
        'Warranty Start Date': String(startDate || '').trim(),
        'Warranty End Date': String(endDate || '').trim()
      });
    }

    if (!records.length) throw new Error('No valid warranty rows were found in the CSV file.');
    return { rows: records, headers: headerRow, validation: validateWarrantyImportColumns(headerRow) };
  }

  function createSampleInventory() {
    return [
      { 'Device ID': 'INT-1001', 'Device name': 'LAP-SG-001', Ownership: 'Corporate', Compliance: 'Compliant', OS: 'Windows 11', 'OS version': '23H2', 'Primary user email address': 'alex.ng@contoso.com', 'Primary user UPN': 'alex.ng@contoso.com', 'Last check-in': '2025-09-20', 'Enrollment date': '2024-01-15', Model: 'Latitude 5440', Manufacturer: 'Dell', 'Serial number': 'SG-1001', 'Primary user display name': 'Alex Ng', 'Total storage': '512000000000', 'Free storage': '82000000000', 'Azure AD registered': 'Yes', 'IntuneGroup.GroupName': 'Intune-SG', 'IntuneGroup.DeviceName': 'LAP-SG-001', 'IntuneGroup.SerialNumber': 'SG-1001', 'IntuneGroup.GroupTag': 'SG', 'IntuneGroup.Model': 'Latitude 5440', 'IntuneGroup.Manufacturer': 'Dell', WindowsVersion: 'Windows 11', 'Total storage (GB)': 476.84, 'Warranty End Date': '2026-08-21', 'Warranty Start Date': '2024-08-21' },
      { 'Device ID': 'INT-1002', 'Device name': 'LAP-SG-002', Ownership: 'Corporate', Compliance: 'Non-Compliant', OS: 'Windows 11', 'OS version': '22H2', 'Primary user email address': 'lamia@contoso.com', 'Primary user UPN': 'lamia@contoso.com', 'Last check-in': '2025-09-18', 'Enrollment date': '2023-12-11', Model: 'EliteBook 840', Manufacturer: 'HP', 'Serial number': 'SG-1002', 'Primary user display name': 'Lamia Ali', 'Total storage': '512000000000', 'Free storage': '120000000000', 'Azure AD registered': 'Yes', 'IntuneGroup.GroupName': 'Intune-SG', 'IntuneGroup.DeviceName': 'LAP-SG-002', 'IntuneGroup.SerialNumber': 'SG-1002', 'IntuneGroup.GroupTag': 'SG', 'IntuneGroup.Model': 'EliteBook 840', 'IntuneGroup.Manufacturer': 'HP', WindowsVersion: 'Windows 11', 'Total storage (GB)': 476.84, 'Warranty End Date': '2025-10-11', 'Warranty Start Date': '2023-10-11' },
      { 'Device ID': 'INT-1003', 'Device name': 'LAP-MY-001', Ownership: 'BYOD', Compliance: 'Compliant', OS: 'Windows 10', 'OS version': '22H2', 'Primary user email address': 'tina.wong@contoso.com', 'Primary user UPN': 'tina.wong@contoso.com', 'Last check-in': '2025-09-15', 'Enrollment date': '2024-02-10', Model: 'ThinkPad X1 Carbon', Manufacturer: 'Lenovo', 'Serial number': 'MY-1003', 'Primary user display name': 'Tina Wong', 'Total storage': '512000000000', 'Free storage': '300000000000', 'Azure AD registered': 'Yes', 'IntuneGroup.GroupName': 'Intune-MY', 'IntuneGroup.DeviceName': 'LAP-MY-001', 'IntuneGroup.SerialNumber': 'MY-1003', 'IntuneGroup.GroupTag': 'MY', 'IntuneGroup.Model': 'ThinkPad X1 Carbon', 'IntuneGroup.Manufacturer': 'Lenovo', WindowsVersion: 'Windows 10', 'Total storage (GB)': 476.84, 'Warranty End Date': '2027-02-18', 'Warranty Start Date': '2024-02-18' },
      { 'Device ID': 'INT-1004', 'Device name': 'LAP-TH-001', Ownership: 'Corporate', Compliance: 'Compliant', OS: 'Windows 11', 'OS version': '24H2', 'Primary user email address': 'nattapong.s@contoso.com', 'Primary user UPN': 'nattapong.s@contoso.com', 'Last check-in': '2025-09-07', 'Enrollment date': '2024-03-05', Model: 'XPS 13', Manufacturer: 'Dell', 'Serial number': 'TH-1004', 'Primary user display name': 'Nattapong S.', 'Total storage': '256000000000', 'Free storage': '168000000000', 'Azure AD registered': 'No', 'IntuneGroup.GroupName': 'Intune-TH', 'IntuneGroup.DeviceName': 'LAP-TH-001', 'IntuneGroup.SerialNumber': 'TH-1004', 'IntuneGroup.GroupTag': 'TH', 'IntuneGroup.Model': 'XPS 13', 'IntuneGroup.Manufacturer': 'Dell', WindowsVersion: 'Windows 11', 'Total storage (GB)': 238.42, 'Warranty End Date': '2025-11-29', 'Warranty Start Date': '2023-11-29' },
      { 'Device ID': 'INT-1005', 'Device name': 'LAP-PH-001', Ownership: 'Corporate', Compliance: 'Unknown', OS: 'Windows 10', 'OS version': '21H2', 'Primary user email address': 'enrico.delacruz@contoso.com', 'Primary user UPN': 'enrico.delacruz@contoso.com', 'Last check-in': '2025-09-16', 'Enrollment date': '2023-09-12', Model: 'Latitude 5530', Manufacturer: 'Dell', 'Serial number': 'PH-1005', 'Primary user display name': 'Enrico Dela Cruz', 'Total storage': '512000000000', 'Free storage': '210000000000', 'Azure AD registered': 'Yes', 'IntuneGroup.GroupName': 'Intune-PH', 'IntuneGroup.DeviceName': 'LAP-PH-001', 'IntuneGroup.SerialNumber': 'PH-1005', 'IntuneGroup.GroupTag': 'PH', 'IntuneGroup.Model': 'Latitude 5530', 'IntuneGroup.Manufacturer': 'Dell', WindowsVersion: 'Windows 10', 'Total storage (GB)': 476.84, 'Warranty End Date': '2026-01-17', 'Warranty Start Date': '2024-01-17' },
      { 'Device ID': 'INT-1006', 'Device name': 'LAP-SG-003', Ownership: 'Corporate', Compliance: 'Compliant', OS: 'macOS', 'OS version': '14.7', 'Primary user email address': 'karen.li@contoso.com', 'Primary user UPN': 'karen.li@contoso.com', 'Last check-in': '2025-09-21', 'Enrollment date': '2024-04-02', Model: 'MacBook Pro 14', Manufacturer: 'Apple', 'Serial number': 'SG-1006', 'Primary user display name': 'Karen Li', 'Total storage': '1000000000000', 'Free storage': '460000000000', 'Azure AD registered': 'Yes', 'IntuneGroup.GroupName': 'Intune-SG', 'IntuneGroup.DeviceName': 'LAP-SG-003', 'IntuneGroup.SerialNumber': 'SG-1006', 'IntuneGroup.GroupTag': 'SG', 'IntuneGroup.Model': 'MacBook Pro 14', 'IntuneGroup.Manufacturer': 'Apple', WindowsVersion: 'macOS', 'Total storage (GB)': 931.32, 'Warranty End Date': '2026-03-27', 'Warranty Start Date': '2024-03-27' },
      { 'Device ID': 'INT-1007', 'Device name': 'LAP-MY-002', Ownership: 'Employee Owned', Compliance: 'Compliant', OS: 'Windows 11', 'OS version': '23H2', 'Primary user email address': 'adrian.tan@contoso.com', 'Primary user UPN': 'adrian.tan@contoso.com', 'Last check-in': '2025-09-03', 'Enrollment date': '2023-07-09', Model: 'Surface Laptop 5', Manufacturer: 'Microsoft', 'Serial number': 'MY-1007', 'Primary user display name': 'Adrian Tan', 'Total storage': '512000000000', 'Free storage': '390000000000', 'Azure AD registered': 'Yes', 'IntuneGroup.GroupName': 'Intune-MY', 'IntuneGroup.DeviceName': 'LAP-MY-002', 'IntuneGroup.SerialNumber': 'MY-1007', 'IntuneGroup.GroupTag': 'MY', 'IntuneGroup.Model': 'Surface Laptop 5', 'IntuneGroup.Manufacturer': 'Microsoft', WindowsVersion: 'Windows 11', 'Total storage (GB)': 476.84, 'Warranty End Date': '2026-10-07', 'Warranty Start Date': '2024-10-07' },
      { 'Device ID': 'INT-1008', 'Device name': 'LAP-TH-002', Ownership: 'Corporate', Compliance: 'Compliant', OS: 'Windows 11', 'OS version': '23H2', 'Primary user email address': 'saran.chai@contoso.com', 'Primary user UPN': 'saran.chai@contoso.com', 'Last check-in': '2025-09-11', 'Enrollment date': '2024-08-15', Model: 'ThinkPad T14', Manufacturer: 'Lenovo', 'Serial number': 'TH-1008', 'Primary user display name': 'Saran Chai', 'Total storage': '512000000000', 'Free storage': '240000000000', 'Azure AD registered': 'Yes', 'IntuneGroup.GroupName': 'Intune-TH', 'IntuneGroup.DeviceName': 'LAP-TH-002', 'IntuneGroup.SerialNumber': 'TH-1008', 'IntuneGroup.GroupTag': 'TH', 'IntuneGroup.Model': 'ThinkPad T14', 'IntuneGroup.Manufacturer': 'Lenovo', WindowsVersion: 'Windows 11', 'Total storage (GB)': 476.84, 'Warranty End Date': '2028-04-12', 'Warranty Start Date': '2025-04-12' },
      { 'Device ID': 'INT-1009', 'Device name': 'LAP-PH-002', Ownership: 'Corporate', Compliance: 'Non-Compliant', OS: 'Windows 11', 'OS version': '24H2', 'Primary user email address': 'norah.fernandez@contoso.com', 'Primary user UPN': 'norah.fernandez@contoso.com', 'Last check-in': '2025-09-12', 'Enrollment date': '2024-11-18', Model: 'EliteBook 865', Manufacturer: 'HP', 'Serial number': 'PH-1009', 'Primary user display name': 'Norah Fernandez', 'Total storage': '512000000000', 'Free storage': '170000000000', 'Azure AD registered': 'Yes', 'IntuneGroup.GroupName': 'Intune-PH', 'IntuneGroup.DeviceName': 'LAP-PH-002', 'IntuneGroup.SerialNumber': 'PH-1009', 'IntuneGroup.GroupTag': 'PH', 'IntuneGroup.Model': 'EliteBook 865', 'IntuneGroup.Manufacturer': 'HP', WindowsVersion: 'Windows 11', 'Total storage (GB)': 476.84, 'Warranty End Date': '2026-06-05', 'Warranty Start Date': '2024-06-05' },
      { 'Device ID': 'INT-1010', 'Device name': 'LAP-SG-004', Ownership: 'Corporate', Compliance: 'Compliant', OS: 'Windows 11', 'OS version': '23H2', 'Primary user email address': 'mokhtar.ismail@contoso.com', 'Primary user UPN': 'mokhtar.ismail@contoso.com', 'Last check-in': '2025-09-02', 'Enrollment date': '2023-02-24', Model: 'ZenBook 14', Manufacturer: 'ASUS', 'Serial number': 'SG-1010', 'Primary user display name': 'Mokhtar Ismail', 'Total storage': '1000000000000', 'Free storage': '550000000000', 'Azure AD registered': 'Yes', 'IntuneGroup.GroupName': 'Intune-SG', 'IntuneGroup.DeviceName': 'LAP-SG-004', 'IntuneGroup.SerialNumber': 'SG-1010', 'IntuneGroup.GroupTag': 'SG', 'IntuneGroup.Model': 'ZenBook 14', 'IntuneGroup.Manufacturer': 'ASUS', WindowsVersion: 'Windows 11', 'Total storage (GB)': 931.32, 'Warranty End Date': '2025-12-22', 'Warranty Start Date': '2023-12-22' }
    ];
  }

  function escapeCsv(value) {
    const text = value == null ? '' : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  }

  function exportCurrentInventory() {
    const rows = getInventory();
    const filteredRows = getFilteredRows(rows, App.countryFilter);
    const columns = Array.from(new Set([...(DEFAULT_COLUMNS), ...filteredRows.flatMap((device) => Object.keys(device)), 'Warranty End Date', 'Warranty Start Date', 'Warranty Match Status']));

    const csvRows = [columns.map(escapeCsv).join(',')].concat(
      filteredRows.map((device) => columns.map((column) => escapeCsv(column === 'Age'
        ? getWarrantyAge(device['Warranty Start Date'], device['Warranty End Date'])
        : column === 'Active device status'
          ? getActiveDeviceStatus(device)
          : device[column] ?? '')).join(','))
    );

    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'IT-Asset-Inventory-' + new Date().toISOString().slice(0, 10) + '.csv';
    anchor.click();
    URL.revokeObjectURL(url);
    Toast.show('Inventory export generated.', 'success');
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
          parts.push(`${nestedKey} ${nestedValue}`.toLowerCase());
        });
        return;
      }
      parts.push(`${key} ${value}`.toLowerCase());
    });
    return parts.join(' ');
  }

  function getFilteredRows(rows, countryFilter = App.countryFilter) {
    const searchBox = document.getElementById('inventorySearch');
    const searchValue = (searchBox ? searchBox.value : '').trim().toLowerCase();
    const warrantyValue = warrantyStatusFilter;
    return rows.filter((device) => {
      const textSearch = getDeviceSearchText(device);
      const matchesSearch = !searchValue || textSearch.includes(searchValue);
      const matchesWarranty = !warrantyValue || (device['Warranty Match Status'] || 'Unmatched') === warrantyValue;
      const matchesCountry = countryFilter === 'all' || getCountryCodeFromDeviceName(device['Device name']) === countryFilter;
      const matchesDashboard = dashboardRecordIndexes === null || dashboardRecordIndexes.has(rows.indexOf(device));
      const matchesDeviceType = !activeDeviceType || getAssetType(device) === activeDeviceType;
      return matchesSearch && matchesWarranty && matchesCountry && matchesDashboard && matchesDeviceType && (!duplicatesOnly || device['Duplicate Serial'] === true);
    });
  }

  function renderTableBody(rows, allRows) {
    const visibleColumns = getVisibleColumns();
    const allColumns = LAYOUT_COLUMNS;
    if (!rows.length) return `<tr><td colspan="${allColumns.length + 2}" class="empty-state">No matching devices.</td></tr>`;
    return rows.map((device) => {
      const duplicate = device['Duplicate Serial'] === true;
      const index = allRows.indexOf(device);
      const selected = selectedDeviceIndexes.has(index);
      const replacement = App.modules.replacements?.summaryForSerial?.(device['Serial number'] || device['IntuneGroup.SerialNumber']) || {};
      const cells = allColumns.map((col) => {
        const value = REPLACEMENT_COLUMNS.includes(col) ? replacement[col] : device[col] ?? '';
        if (col === 'Replacement Status') {
          const status = value || 'Not loaded';
          const badgeClass = status === 'Replaced' ? 'badge-orange' : status === 'Not replaced' ? 'badge-gray' : 'badge-gray';
          return `<td><span class="badge ${badgeClass}">${escapeHtml(status)}</span></td>`;
        }
        if (col === 'Handover Eligibility' || col === 'Lifecycle Status') {
          return `<td>${value ? `<span class="badge ${value === 'Recycle' || value === 'Not Eligible for Handover' || value === 'Disposed' ? 'badge-red' : value === 'Pending Assessment' ? 'badge-orange' : 'badge-green'}">${escapeHtml(value)}</span>` : '—'}</td>`;
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
        if (col === 'Active device status') {
          const status = getActiveDeviceStatus(device);
          const badgeClass = status === 'Inactive' ? 'badge-red' : 'badge-green';
          return `<td><span class="badge ${badgeClass}">${escapeHtml(status)}</span></td>`;
        }
        if (col === 'Age') {
          const age = getWarrantyAge(device['Warranty Start Date'], device['Warranty End Date']);
          return `<td>${escapeHtml(age)}</td>`;
        }
        if (col === 'Total storage (GB)') return `<td>${escapeHtml(formatGb(value))}</td>`;
        if (col === 'Asset type') return `<td>${escapeHtml(deviceTypeLabel(getAssetType(device)))}</td>`;
        if (col === 'Serial number' && duplicate) return `<td><span class="duplicate-serial">${escapeHtml(value)}</span></td>`;
        return `<td>${escapeHtml(value || '—')}</td>`;
      }).join('');
      const rowClasses = [duplicate ? 'inventory-duplicate' : '', selected ? 'inventory-selected' : ''].filter(Boolean).join(' ');
      return `<tr class="${rowClasses}"><td><input type="checkbox" class="device-select-checkbox" data-index="${index}" aria-label="Select ${escapeHtml(device['Device name'] || 'device')}" ${selected ? 'checked' : ''}></td>${cells}<td class="inventory-row-actions"><button class="btn btn-secondary btn-sm edit-device-btn" data-index="${index}" aria-label="Edit device">Edit</button><button class="btn btn-danger btn-sm delete-device-btn" data-index="${index}" aria-label="Delete device">Delete</button></td></tr>`;
    }).join('');
  }

  function renderLayoutControls() {
    const layout = getVisibleColumns();
    const available = LAYOUT_COLUMNS;
    const activeColumns = available.filter((column) => layout.includes(column));
    const inactiveColumns = available.filter((column) => !layout.includes(column));
    const labelForColumn = (column) => column === 'IntuneGroup.GroupTag'
      ? 'Group tag'
      : column === 'Asset type' ? 'Device type' : column;

    return `
      <div class="layout-controls">
        <div class="active-layout-columns" aria-label="Visible columns">
          ${activeColumns.map((column) => `
            <label class="active-layout-option">
              <input type="checkbox" data-column="${escapeHtml(column)}" checked />
              <span>${escapeHtml(labelForColumn(column))}</span>
            </label>
          `).join('')}
        </div>
        <details class="inactive-layout-dropdown">
          <summary class="btn btn-secondary btn-sm">More columns${inactiveColumns.length ? ` (${inactiveColumns.length})` : ''}</summary>
          <div class="inactive-layout-menu" aria-label="Hidden columns">
            ${inactiveColumns.map((column) => `
              <label class="inactive-layout-option">
                <input type="checkbox" data-column="${escapeHtml(column)}" />
                <span>${escapeHtml(labelForColumn(column))}</span>
              </label>
            `).join('')}
          </div>
        </details>
        <button class="btn btn-secondary btn-sm" id="resetLayoutBtn">Reset layout</button>
      </div>
    `;
  }

  function refreshLayoutControls(container) {
    const controls = container.querySelector('.layout-controls');
    if (!controls) return;
    const dropdownWasOpen = controls.querySelector('.inactive-layout-dropdown')?.open || false;
    const template = document.createElement('template');
    template.innerHTML = renderLayoutControls();
    controls.replaceChildren(...template.content.firstElementChild.childNodes);
    const dropdown = controls.querySelector('.inactive-layout-dropdown');
    if (dropdown) dropdown.open = dropdownWasOpen;
  }

  function applyColumnVisibility(container) {
    const visibleColumns = new Set(getVisibleColumns());
    container.querySelectorAll('col[data-layout-column]').forEach((column) => {
      column.classList.toggle('column-hidden', !visibleColumns.has(column.dataset.layoutColumn));
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
        const serial = String(device['Serial number'] || device['IntuneGroup.SerialNumber'] || '').replace(/--\d+$/, '');
        device['Serial number'] = serial;
        device['IntuneGroup.SerialNumber'] = serial;
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
        const mergedRecord = { ...match, ...record };
        ['Warranty Start Date', 'Warranty End Date'].forEach((field) => {
          if (!record[field]) mergedRecord[field] = match[field] || '';
        });
        if (!record['Warranty Match Status']) mergedRecord['Warranty Match Status'] = match['Warranty Match Status'] || 'Unmatched';
        Object.assign(match, mergedRecord, { 'Duplicate Serial': false });
        merged += 1;
        return;
      }

      const addedRecord = { ...record, 'Duplicate Serial': false };
      if (match && keepDuplicates) {
        const baseSerial = sourceSerial.replace(/--\d+$/, '');
        let suffix = 1;
        let candidate = `${baseSerial}--${suffix}`;
        while (occupiedSerials.has(normalizeSerial(candidate))) {
          suffix += 1;
          candidate = `${baseSerial}--${suffix}`;
        }
        addedRecord['Serial number'] = candidate;
        addedRecord['IntuneGroup.SerialNumber'] = candidate;
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
    ['Location', 'Location'], ['Management IP', 'Management IP'], ['Firmware version', 'Firmware version'],
    ['UPS Capacity (VA)', 'UPS Capacity (VA)'], ['Battery replacement date', 'Battery replacement date'],
    ['Compliance', 'Compliance'], ['OS', 'OS'], ['OS version', 'OS version'],
    ['Primary user display name', 'Primary user display name'], ['Primary user email address', 'Primary user email address'],
    ['IntuneGroup.GroupName', 'Group name'], ['IntuneGroup.GroupTag', 'Group tag'],
    ['Total storage', 'Total storage (bytes)'], ['Free storage', 'Free storage (bytes)'],
    ['Last check-in', 'Last check-in'], ['Enrollment date', 'Enrollment date'],
    ['Warranty Start Date', 'Warranty Start Date'], ['Warranty End Date', 'Warranty End Date']
  ];

  const BULK_EDIT_FIELDS = [['Asset type', 'Device type'], ...EDITABLE_FIELDS];

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
        const values = selectedDevices.map((device) => String(key === 'Asset type' ? getAssetType(device) : device[key] ?? ''));
        const mixed = values.some((value) => value !== values[0]);
        const value = mixed ? '' : values[0];
        const mixedAttributes = mixed ? ' data-mixed="true"' : '';
        const control = key === 'Asset type'
          ? `<select class="form-control" name="value:${escapeHtml(key)}" aria-label="${escapeHtml(label)}"${mixedAttributes}>${mixed ? '<option value="" selected>Multiple values</option>' : ''}${DEVICE_TYPES.map(({ value: type, label: typeLabel }) => `<option value="${type}" ${value === type ? 'selected' : ''}>${escapeHtml(typeLabel)}</option>`).join('')}</select>`
          : `<input class="form-control" name="value:${escapeHtml(key)}" aria-label="${escapeHtml(label)}" value="${escapeHtml(value)}"${mixed ? ' placeholder="Multiple values" data-mixed="true"' : ''}${!mixed && (key === 'Warranty Start Date' || key === 'Warranty End Date') ? ' type="date"' : ''}>`;
        return `<label class="bulk-edit-field"><span>${escapeHtml(label)}</span>${control}</label>`;
      }).join('')}</form>`,
      onOpen: () => {
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
        const updatedDevices = [];
        indexes.forEach((index) => {
          const updated = { ...inventory[index] };
          BULK_EDIT_FIELDS.forEach(([field]) => {
            const input = form.elements.namedItem(`value:${field}`);
            if (input.dataset.mixed === 'true' && input.dataset.edited !== 'true') return;
            const value = String(formData.get(`value:${field}`) ?? '').trim();
            updated[field] = field === 'Asset type' ? normalizeDeviceType(value) : value;
          });
          updatedDevices.push(updated);
          inventory[index] = updated;
        });
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

  function openDeviceForm(container, country, index = null, defaultType = activeDeviceType || 'laptop') {
    const inventory = getInventory();
    const device = index === null ? {} : inventory[index];
    const isEditing = index !== null;
    const selectedType = isEditing ? getAssetType(device) : normalizeDeviceType(defaultType);
    Modal.open({
      title: isEditing ? 'Edit device' : 'Add device',
      confirmText: isEditing ? 'Save changes' : 'Add device',
      size: 'lg',
      body: `<form id="deviceForm" class="device-form">
        <label class="device-form-field"><span>Device type</span><select class="form-control" name="Asset type">${DEVICE_TYPES.map(({ value, label }) => `<option value="${value}" ${selectedType === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label>
        ${EDITABLE_FIELDS.map(([key, label]) => `<label class="device-form-field"><span${key === 'Fixed Asset Number' ? ` title="${escapeHtml(FIXED_ASSET_NUMBER_HELP)}"` : ''}>${escapeHtml(label)}</span><input class="form-control" name="${escapeHtml(key)}" value="${escapeHtml(device[key] || '')}" ${key === 'Device name' || key === 'Serial number' ? 'required' : ''}${key === 'Warranty Start Date' || key === 'Warranty End Date' ? ' type="date"' : ''}></label>`).join('')}
      </form>`,
      onConfirm: () => {
        const form = document.getElementById('deviceForm');
        const formData = new FormData(form);
        const updated = { ...device };
        updated['Asset type'] = normalizeDeviceType(formData.get('Asset type'));
        EDITABLE_FIELDS.forEach(([key]) => { updated[key] = String(formData.get(key) || '').trim(); });
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
        updated['IntuneGroup.SerialNumber'] = updated['Serial number'];
        const storageGb = parseStorageValue(updated['Total storage'], 'bytes');
        updated['Total storage (GB)'] = storageGb === null ? '' : Number(storageGb.toFixed(2));
        if (isEditing) inventory[index] = updated;
        else inventory.push({ ...updated, 'Warranty Match Status': updated['Warranty Match Status'] || 'Unmatched', 'Duplicate Serial': false });
        try {
          setInventory(inventory);
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
    const filteredRows = getFilteredRows(rows, country);
    const categoryRows = activeDeviceType ? rows.filter((device) => getAssetType(device) === activeDeviceType) : rows;
    const inventorySummary = activeDeviceType
      ? `${filteredRows.length} matching records · ${categoryRows.length} ${escapeHtml(deviceTypeLabel(activeDeviceType))} devices · ${rows.length} total`
      : `${filteredRows.length} matching records · ${rows.length} total`;
    const visibleColumns = getVisibleColumns();

    container.innerHTML = `
      <div class="section-header">
        <div>
          <div class="section-title">${activeDeviceType ? `${escapeHtml(deviceTypeLabel(activeDeviceType))} Inventory` : 'Asset Inventory'}</div>
          <div class="section-sub">${inventorySummary} · saved in local SQLite database${dashboardFilterLabel ? ` · Dashboard: ${escapeHtml(dashboardFilterLabel)}` : ''}</div>
        </div>
        <div class="section-actions">
          <button class="btn btn-secondary btn-sm" id="undoInventoryBtn" ${history.undo.length ? '' : 'disabled'}>Undo</button>
          <button class="btn btn-secondary btn-sm" id="redoInventoryBtn" ${history.redo.length ? '' : 'disabled'}>Redo</button>
          <button class="btn btn-primary btn-sm" id="addDeviceBtn">+ Add ${activeDeviceType ? escapeHtml(deviceTypeLabel(activeDeviceType)) : 'device'}</button>
          <button class="btn btn-secondary btn-sm" id="importInventoryBtn">Import CSV</button>
          <button class="btn btn-secondary btn-sm" id="importWarrantyBtn">Import Warranty</button>
          <button class="btn btn-secondary btn-sm" id="exportInventoryBtn">Export CSV</button>
        </div>
      </div>

      <div class="filter-bar inventory-filters">
        <input id="inventorySearch" class="search-input" placeholder="Search all fields: device, user, serial, warranty, status..." value="${escapeHtml(previousSearch)}" />
        <label class="duplicate-filter-option"><input type="checkbox" id="duplicatesOnlyFilter" ${duplicatesOnly ? 'checked' : ''}> Duplicates only</label>
      </div>

      <div class="bulk-actions" role="region" aria-label="Selected device actions">
        <span id="selectedDeviceCount">${selectedDeviceIndexes.size} selected</span>
        <button class="btn btn-secondary btn-sm" id="bulkEditBtn" ${selectedDeviceIndexes.size ? '' : 'disabled'}>Edit selected</button>
        <button class="btn btn-danger btn-sm" id="bulkDeleteBtn" ${selectedDeviceIndexes.size ? '' : 'disabled'}>Delete selected</button>
      </div>

      ${renderLayoutControls()}

      <input id="inventoryFileInput" type="file" accept=".csv,text/csv" hidden />
      <input id="warrantyFileInput" type="file" accept=".csv,text/csv" hidden />

      <div class="card inventory-table-wrap">
        <table class="inventory-table">
          <colgroup><col />${LAYOUT_COLUMNS.map((column) => `<col data-layout-column="${escapeHtml(column)}" ${visibleColumns.includes(column) ? '' : 'class="column-hidden"'} />`).join('')}<col /></colgroup>
          <thead><tr><th><input type="checkbox" id="selectAllDevices" aria-label="Select all visible devices" ${filteredRows.length && filteredRows.every((device) => selectedDeviceIndexes.has(rows.indexOf(device))) ? 'checked' : ''}></th>${LAYOUT_COLUMNS.map((col) => `<th${col === 'Fixed Asset Number' ? ` title="${escapeHtml(FIXED_ASSET_NUMBER_HELP)}"` : ''}>${escapeHtml(col === 'IntuneGroup.GroupTag' ? 'Group tag' : col === 'Asset type' ? 'Device type' : col)}</th>`).join('')}<th>Actions</th></tr></thead>
          <tbody>${renderTableBody(filteredRows, rows)}</tbody>
        </table>
      </div>
    `;

    const searchBox = container.querySelector('#inventorySearch');
    const duplicatesFilter = container.querySelector('#duplicatesOnlyFilter');
    searchBox.addEventListener('input', () => {
      selectedDeviceIndexes.clear();
      const hadFocus = document.activeElement === searchBox;
      const searchValue = String(searchBox.value ?? '');
      const caretPosition = searchBox.selectionStart ?? searchValue.length;
      const caretEnd = searchBox.selectionEnd ?? searchValue.length;
      render(container, country);
      if (hadFocus) {
        const updatedSearchBox = container.querySelector('#inventorySearch');
        if (updatedSearchBox) {
          updatedSearchBox.focus();
          updatedSearchBox.setSelectionRange(caretPosition, caretEnd);
        }
      }
    });
    duplicatesFilter.addEventListener('change', (event) => {
      selectedDeviceIndexes.clear();
      duplicatesOnly = event.target.checked;
      render(container, country);
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
    container.querySelector('#importInventoryBtn').addEventListener('click', () => {
      const input = document.getElementById('inventoryFileInput');
      input.value = '';
      input.click();
    });
    container.querySelector('#exportInventoryBtn').addEventListener('click', exportCurrentInventory);
    container.querySelectorAll('.edit-device-btn').forEach((button) => {
      button.addEventListener('click', () => openDeviceForm(container, country, Number(button.dataset.index)));
    });
    container.querySelectorAll('.delete-device-btn').forEach((button) => {
      button.addEventListener('click', () => deleteDevice(container, country, Number(button.dataset.index)));
    });

    document.getElementById('inventoryFileInput').onchange = async (event) => {
      const [file] = event.target.files;
      if (!file) return;
      try {
        const { rows: imported, validation: inventoryValidation } = parseInventoryCsv(await file.text());
        const duplicateCount = countImportDuplicates(getInventory(), imported);
        event.target.value = '';
        const saveImport = (keepDuplicates) => {
          try {
            const result = applyInventoryImport(imported, keepDuplicates);
            selectedDeviceIndexes.clear();
            Modal.close();
            render(container, country);
            const parts = [`${result.added} added`, `${result.merged} merged`];
            if (result.duplicatesKept) parts.push(`${result.duplicatesKept} duplicate${result.duplicatesKept === 1 ? '' : 's'} kept`);
            Modal.open({
              title: 'Inventory Import Report',
              body: renderImportReport({
                title: 'Inventory Import Report',
                summaryLines: parts,
                recognizedColumns: inventoryValidation.recognized.map((column) => IMPORT_COLUMN_LABELS[column] || column),
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
        if (duplicateCount) {
          Modal.open({
            title: 'Duplicate serial numbers found',
            confirmText: 'Continue import',
            body: `<p>${duplicateCount} duplicate serial-number record${duplicateCount === 1 ? '' : 's'} found. Choose how to handle them:</p>
              <label class="duplicate-choice"><input type="radio" name="duplicateImportMode" value="merge" checked> Merge into the existing device record</label>
              <label class="duplicate-choice"><input type="radio" name="duplicateImportMode" value="keep"> Keep each as a separate device (append --1, --2, etc.)</label>`,
            onConfirm: () => saveImport(document.querySelector('input[name="duplicateImportMode"]:checked')?.value === 'keep')
          });
        } else {
          saveImport(false);
        }
      } catch (error) {
        event.target.value = '';
        Toast.show(error.message || 'CSV import failed.', 'error');
      }
    };

    document.getElementById('warrantyFileInput').onchange = async (event) => {
      const [file] = event.target.files;
      if (!file) return;
      try {
        const { rows: warrantyRows, validation } = parseWarrantyCsv(await file.text());
        const inventory = getInventory();
        const serialMap = new Map();
        inventory.forEach((device) => {
          const serial = normalizeSerialKey(device['Serial number'] || device['IntuneGroup.SerialNumber']);
          if (serial && !device['Duplicate Serial'] && !serialMap.has(serial)) serialMap.set(serial, device);
          if (!device['Warranty Match Status']) device['Warranty Match Status'] = 'Unmatched';
        });

        const matched = [];
        const unmatched = [];
        const duplicates = [];
        const seen = new Set();
        warrantyRows.forEach((row) => {
          const serial = normalizeSerialKey(row['Serial number']);
          if (!serial) { unmatched.push(row); return; }
          if (seen.has(serial)) { duplicates.push(row); return; }
          seen.add(serial);
          const match = serialMap.get(serial);
          if (match) {
            match['Warranty Start Date'] = row['Warranty Start Date'] || '';
            match['Warranty End Date'] = row['Warranty End Date'] || '';
            match['Warranty Match Status'] = 'Matched';
            matched.push(match);
          } else {
            unmatched.push({ ...row, 'Warranty Match Status': 'Unmatched' });
          }
        });

        setInventory(inventory);
        setWarrantyData(warrantyRows);
        const parts = [`${matched.length} matched`, `${unmatched.length} unmatched`];
        if (duplicates.length) parts.push(`${duplicates.length} duplicate serials skipped`);
        Modal.open({
          title: 'Warranty Import Report',
          body: renderImportReport({
            title: 'Warranty Import Report',
            summaryLines: parts,
            recognizedColumns: validation.recognized.map((column) => IMPORT_COLUMN_LABELS[column] || column),
            unrecognizedColumns: validation.unrecognized
          }),
          onConfirm: () => Modal.close(),
          confirmText: 'Close',
          size: 'lg'
        });
      } catch (error) {
        Toast.show(error.message || 'Warranty import failed.', 'error');
      }
      event.target.value = '';
      render(container, country);
    };

    container.querySelector('#importWarrantyBtn').addEventListener('click', () => {
      document.getElementById('warrantyFileInput').click();
    });
    const layoutControls = container.querySelector('.layout-controls');
    layoutControls.addEventListener('click', (event) => {
      if (!event.target.closest('#resetLayoutBtn')) return;
      saveVisibleColumns(DEFAULT_VISIBLE_COLUMNS);
      applyColumnVisibility(container);
      refreshLayoutControls(container);
    });
    layoutControls.addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-column]');
      if (!checkbox) return;
      const selected = Array.from(layoutControls.querySelectorAll('[data-column]:checked')).map((el) => el.dataset.column);
      saveVisibleColumns(selected.length ? selected : ['Device name']);
      applyColumnVisibility(container);
      refreshLayoutControls(container);
    });
  }

  function clearInventoryFilters(container) {
    const search = container.querySelector('#inventorySearch');
    if (search) search.value = '';
  }

  document.addEventListener('click', (event) => {
    const dropdown = document.querySelector('.inactive-layout-dropdown');
    if (dropdown && dropdown.open && !dropdown.contains(event.target)) dropdown.removeAttribute('open');
  });

  return {
    render,
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
    activeDeviceType = deviceType ? normalizeDeviceType(deviceType) : '';
    duplicatesOnly = false;
    warrantyStatusFilter = '';
    dashboardRecordIndexes = null;
    dashboardFilterLabel = '';
    selectedDeviceIndexes.clear();
    const container = document.getElementById('moduleContainer');
    if (container && App.currentModule === 'inventory') {
      clearInventoryFilters(container);
      render(container, App.countryFilter);
    }
  },
  showDashboardResults(indexes, label) {
      const inventoryCount = getInventory().length;
      if (!Array.isArray(indexes) || !indexes.every((index) => Number.isInteger(index) && index >= 0 && index < inventoryCount)) {
        throw new Error('Dashboard returned invalid inventory record indexes.');
      }
      dashboardRecordIndexes = new Set(indexes);
      dashboardFilterLabel = label;
      duplicatesOnly = false;
      warrantyStatusFilter = '';
      activeDeviceType = '';
      selectedDeviceIndexes.clear();
      App.navigateTo('inventory');
    },
    showAll() {
      duplicatesOnly = false;
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
      }
    },
    showDuplicates() {
      dashboardRecordIndexes = null;
      dashboardFilterLabel = '';
      activeDeviceType = '';
      duplicatesOnly = true;
      warrantyStatusFilter = '';
      selectedDeviceIndexes.clear();
      const container = document.getElementById('moduleContainer');
      if (container) clearInventoryFilters(container);
      render(container, App.countryFilter);
    },
    showWarrantyMatched() {
      dashboardRecordIndexes = null;
      dashboardFilterLabel = '';
      activeDeviceType = '';
      duplicatesOnly = false;
      warrantyStatusFilter = 'Matched';
      selectedDeviceIndexes.clear();
      const container = document.getElementById('moduleContainer');
      if (container) clearInventoryFilters(container);
      render(container, App.countryFilter);
    },
    onCountryChange(country) {
      const element = document.getElementById('moduleContainer');
      if (element) render(element, country);
    }
  };
})());
