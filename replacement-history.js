/* Replacement events are stored in SQLite; CSV import/export remains available. */
App.registerModule('replacements', (() => {
  const COLUMNS = [
    'Replacement ID',
    'Staff Member Name',
    'Staff Email',
    'Old Device Serial Number',
    'New Device Serial Number',
    'Replacement Date',
    'Replacement Reason',
    'Old Device Condition',
    'Handover Eligibility',
    'Lifecycle Status',
    'Remarks'
  ];
  const REASONS = ['Out of Warranty (OOW)', 'Hardware Failure', 'Damaged Device', 'Performance Issue', 'Upgrade or Refresh', 'Other'];
  const CONDITIONS = ['Working', 'Faulty', 'Damaged', 'Not Assessed'];
  const ELIGIBILITY = ['Eligible for Handover', 'Not Eligible for Handover', 'Pending Assessment', 'Recycle'];
  const LIFECYCLE = ['In Use', 'Available for Handover', 'Pending Assessment', 'Recycle', 'Disposed'];
  let records = [];
  let loaded = false;
  let search = '';
  let reasonFilter = '';
  let eligibilityFilter = '';
  let lifecycleFilter = '';
  let dateFrom = '';
  let dateTo = '';
  let sortBy = 'date';
  let sortDirection = 'desc';

  function initializeRecords() {
    if (loaded || !App.store.initialized) return;
    records = App.store.get('replacementHistory');
    loaded = true;
  }

  async function persistRecords(nextRecords) {
    try {
      await App.store.set('replacementHistory', nextRecords);
      records = nextRecords;
      loaded = true;
      return true;
    } catch {
      return false;
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function serialKey(value) {
    return String(value || '').trim().toUpperCase();
  }

  function localToday() {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function inventoryRows() {
    const value = App.store.get('inventory');
    return Array.isArray(value) ? value : [];
  }

  function inventoryDevice(serial) {
    const key = serialKey(serial);
    return inventoryRows().find((device) => serialKey(device['Serial number'] || device['IntuneGroup.SerialNumber']) === key);
  }

  function inventoryDeviceName(serial) {
    const device = inventoryDevice(serial);
    return device ? (device['Device name'] || device['IntuneGroup.DeviceName'] || 'Unnamed device') : '';
  }

  function csvCell(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = '';
    let quoted = false;
    const source = String(text || '').replace(/^\uFEFF/, '');
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];
      if (char === '"') {
        if (quoted && next === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (char === ',' && !quoted) {
        row.push(value);
        value = '';
      } else if ((char === '\r' || char === '\n') && !quoted) {
        if (char === '\r' && next === '\n') index += 1;
        row.push(value);
        if (row.some((cell) => cell.trim())) rows.push(row);
        row = [];
        value = '';
      } else {
        value += char;
      }
    }
    if (quoted) throw new Error('CSV contains an unclosed quotation mark.');
    if (value.length || row.length) {
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
    }
    return rows;
  }

  function normalizeHeader(value) {
    return String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function validateRecord(record) {
    const normalized = {
      ...record,
      'Replacement ID': String(record['Replacement ID'] || '').trim(),
      'Staff Member Name': String(record['Staff Member Name'] || '').trim(),
      'Staff Email': String(record['Staff Email'] || '').trim(),
      'Old Device Serial Number': String(record['Old Device Serial Number'] || '').trim(),
      'New Device Serial Number': String(record['New Device Serial Number'] || '').trim(),
      'Replacement Date': String(record['Replacement Date'] || '').trim(),
      'Replacement Reason': String(record['Replacement Reason'] || '').trim(),
      'Old Device Condition': String(record['Old Device Condition'] || '').trim(),
      'Handover Eligibility': String(record['Handover Eligibility'] || '').trim(),
      'Lifecycle Status': String(record['Lifecycle Status'] || '').trim(),
      Remarks: String(record.Remarks || '').trim()
    };
    const errors = [];
    if (!normalized['Replacement ID']) errors.push('Replacement ID is required.');
    if (!normalized['Staff Member Name']) errors.push('Staff Member Name is required.');
    if (!normalized['Old Device Serial Number']) errors.push('Old Device Serial Number is required.');
    if (!normalized['New Device Serial Number']) errors.push('New Device Serial Number is required.');
    if (serialKey(normalized['Old Device Serial Number']) === serialKey(normalized['New Device Serial Number'])) {
      errors.push('Old and new device serial numbers must be different.');
    }
    if (!validDate(normalized['Replacement Date'])) errors.push('Replacement Date must be a valid YYYY-MM-DD date.');
    if (!REASONS.includes(normalized['Replacement Reason'])) errors.push('Select a valid Replacement Reason.');
    if (!CONDITIONS.includes(normalized['Old Device Condition'])) errors.push('Select a valid Old Device Condition.');
    if (!ELIGIBILITY.includes(normalized['Handover Eligibility'])) errors.push('Select a valid Handover Eligibility.');
    if (!LIFECYCLE.includes(normalized['Lifecycle Status'])) errors.push('Select a valid Lifecycle Status.');
    return { record: normalized, errors };
  }

  function parseReplacementCsv(text) {
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('CSV must contain a header row.');
    const headerPositions = new Map();
    rows[0].forEach((header, index) => headerPositions.set(normalizeHeader(header), index));
    const required = COLUMNS.filter((column) => !['Staff Email', 'Remarks'].includes(column));
    const missing = required.filter((column) => !headerPositions.has(normalizeHeader(column)));
    if (missing.length) throw new Error(`Missing required CSV columns: ${missing.join(', ')}.`);

    const imported = [];
    const ids = new Set();
    const errors = [];
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const values = rows[rowIndex];
      const raw = {};
      COLUMNS.forEach((column) => {
        const position = headerPositions.get(normalizeHeader(column));
        raw[column] = position === undefined ? '' : (values[position] || '');
      });
      const result = validateRecord(raw);
      result.errors.forEach((error) => errors.push(`Row ${rowIndex + 1}: ${error}`));
      const idKey = result.record['Replacement ID'].toUpperCase();
      if (idKey && ids.has(idKey)) errors.push(`Row ${rowIndex + 1}: duplicate Replacement ID "${result.record['Replacement ID']}".`);
      ids.add(idKey);
      imported.push(result.record);
    }
    if (errors.length) throw new Error(`Import was not applied. ${errors.slice(0, 8).join(' ')}${errors.length > 8 ? ` And ${errors.length - 8} more issue(s).` : ''}`);
    return imported;
  }

  function downloadCsv(rows, filename) {
    const csv = [COLUMNS.map(csvCell).join(',')]
      .concat(rows.map((record) => COLUMNS.map((column) => csvCell(record[column])).join(',')))
      .join('\r\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function newId() {
    let id;
    const ids = new Set(records.map((record) => record['Replacement ID'].toUpperCase()));
    do {
      const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
      id = `REP-${Date.now()}-${suffix}`;
    } while (ids.has(id.toUpperCase()));
    return id;
  }

  function latestPerOldDevice() {
    const latest = new Map();
    records.forEach((record) => {
      const key = serialKey(record['Old Device Serial Number']);
      if (!key) return;
      const previous = latest.get(key);
      if (!previous || record['Replacement Date'] > previous['Replacement Date']
        || (record['Replacement Date'] === previous['Replacement Date'] && record['Replacement ID'] > previous['Replacement ID'])) {
        latest.set(key, record);
      }
    });
    return latest;
  }

  function summaryForSerial(serial) {
    initializeRecords();
    if (!loaded) {
      return {
        'Replacement Status': 'Not loaded',
        'Replaced For Staff Member': '',
        'Replacement Date': '',
        'Replaced By Device Serial Number': '',
        'Replacement Count': '',
        'Handover Eligibility': '',
        'Lifecycle Status': ''
      };
    }
    const matches = records.filter((record) => serialKey(record['Old Device Serial Number']) === serialKey(serial))
      .sort((a, b) => a['Replacement Date'].localeCompare(b['Replacement Date']));
    const latest = matches[matches.length - 1];
    return {
      'Replacement Status': matches.length ? 'Replaced' : 'Not replaced',
      'Replaced For Staff Member': [...new Set(matches.map((record) => record['Staff Member Name']))].join(', '),
      'Replacement Date': matches.map((record) => record['Replacement Date']).join(', '),
      'Replaced By Device Serial Number': matches.map((record) => record['New Device Serial Number']).join(' → '),
      'Replacement Count': matches.length,
      'Handover Eligibility': latest?.['Handover Eligibility'] || '',
      'Lifecycle Status': latest?.['Lifecycle Status'] || ''
    };
  }

  function renderStats() {
    const current = latestPerOldDevice();
    let eligible = 0;
    let notEligible = 0;
    let recycle = 0;
    let pending = 0;
    current.forEach((record) => {
      if (record['Handover Eligibility'] === 'Eligible for Handover') eligible += 1;
      if (record['Handover Eligibility'] === 'Not Eligible for Handover') notEligible += 1;
      if (record['Lifecycle Status'] === 'Recycle') recycle += 1;
      if (record['Handover Eligibility'] === 'Pending Assessment' || record['Lifecycle Status'] === 'Pending Assessment') pending += 1;
    });
    const values = [
      ['Total replacement records', records.length],
      ['Unique old devices replaced', current.size],
      ['Eligible for handover', eligible],
      ['Not eligible for handover', notEligible],
      ['Marked for recycling', recycle],
      ['Pending assessment', pending]
    ];
    return `<div class="stats-grid replacement-stats">${values.map(([label, value]) => `
      <div class="stat-card"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${value}</div></div>
    `).join('')}</div>`;
  }

  function statusBadge(value) {
    const color = value === 'Recycle' || value === 'Not Eligible for Handover' || value === 'Disposed' ? 'badge-red'
      : value === 'Pending Assessment' ? 'badge-orange'
        : value === 'Eligible for Handover' || value === 'Available for Handover' || value === 'In Use' ? 'badge-green' : 'badge-gray';
    return `<span class="badge ${color}">${escapeHtml(value || '—')}</span>`;
  }

  function filteredRecords() {
    const query = search.trim().toLowerCase();
    return records.filter((record) => {
      const matchesQuery = !query || [
        record['Replacement ID'], record['Staff Member Name'], record['Staff Email'],
        record['Old Device Serial Number'], record['New Device Serial Number']
      ].some((value) => String(value || '').toLowerCase().includes(query));
      return matchesQuery
        && (!reasonFilter || record['Replacement Reason'] === reasonFilter)
        && (!eligibilityFilter || record['Handover Eligibility'] === eligibilityFilter)
        && (!lifecycleFilter || record['Lifecycle Status'] === lifecycleFilter)
        && (!dateFrom || record['Replacement Date'] >= dateFrom)
        && (!dateTo || record['Replacement Date'] <= dateTo);
    }).sort((a, b) => {
      const left = sortBy === 'staff' ? a['Staff Member Name'].toLowerCase()
        : sortBy === 'serial' ? serialKey(a['Old Device Serial Number']) : a['Replacement Date'];
      const right = sortBy === 'staff' ? b['Staff Member Name'].toLowerCase()
        : sortBy === 'serial' ? serialKey(b['Old Device Serial Number']) : b['Replacement Date'];
      const compared = left.localeCompare(right) || a['Replacement ID'].localeCompare(b['Replacement ID']);
      return sortDirection === 'asc' ? compared : -compared;
    });
  }

  function renderRows(rows) {
    if (!loaded) return '<tr><td colspan="14" class="empty-state">No replacement history loaded. Add a record or import a replacement history CSV.</td></tr>';
    if (!rows.length) return '<tr><td colspan="14" class="empty-state">No replacement records match these filters.</td></tr>';
    return rows.map((record) => {
      const oldName = inventoryDeviceName(record['Old Device Serial Number']);
      const newName = inventoryDeviceName(record['New Device Serial Number']);
      const id = escapeHtml(record['Replacement ID']);
      return `<tr>
        <td>${id}</td>
        <td>${escapeHtml(record['Staff Member Name'])}</td>
        <td>${escapeHtml(record['Staff Email'] || '—')}</td>
        <td>${escapeHtml(record['Old Device Serial Number'])}</td>
        <td>${oldName ? escapeHtml(oldName) : '<span class="replacement-missing">Not found in current inventory</span>'}</td>
        <td>${escapeHtml(record['New Device Serial Number'])}</td>
        <td>${newName ? escapeHtml(newName) : '<span class="replacement-missing">Not found in current inventory</span>'}</td>
        <td>${escapeHtml(record['Replacement Date'])}</td>
        <td>${escapeHtml(record['Replacement Reason'])}</td>
        <td>${escapeHtml(record['Old Device Condition'])}</td>
        <td>${statusBadge(record['Handover Eligibility'])}</td>
        <td>${statusBadge(record['Lifecycle Status'])}</td>
        <td class="replacement-remarks">${escapeHtml(record.Remarks || '—')}</td>
        <td class="replacement-actions">
          <button class="btn btn-secondary btn-sm view-replacement-btn" data-id="${id}">View</button>
          <button class="btn btn-secondary btn-sm edit-replacement-btn" data-id="${id}">Edit</button>
          <button class="btn btn-danger btn-sm delete-replacement-btn" data-id="${id}">Delete</button>
        </td>
      </tr>`;
    }).join('');
  }

  function selectOptions(values, selected, placeholder) {
    return `<option value="">${escapeHtml(placeholder)}</option>${values.map((value) => `<option value="${escapeHtml(value)}" ${selected === value ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}`;
  }

  function deviceOptions(listId) {
    const devices = inventoryRows()
      .filter((device) => device['Serial number'] || device['IntuneGroup.SerialNumber'])
      .map((device) => ({
        serial: String(device['Serial number'] || device['IntuneGroup.SerialNumber']).trim(),
        name: String(device['Device name'] || device['IntuneGroup.DeviceName'] || 'Unnamed device')
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.serial.localeCompare(b.serial));
    const seenSerials = new Set();
    const options = [];
    devices.forEach((device) => {
      const key = serialKey(device.serial);
      if (!key || seenSerials.has(key)) return;
      seenSerials.add(key);
      options.push(`<option value="${escapeHtml(device.serial)}" label="${escapeHtml(`${device.name} — ${device.serial}`)}"></option>`);
    });
    return `<datalist id="${escapeHtml(listId)}">${options.join('')}</datalist>`;
  }

  function openForm(id = '') {
    const existing = id ? records.find((record) => record['Replacement ID'] === id) : null;
    if (id && !existing) return;
    const record = existing || {
      'Replacement ID': newId(),
      'Staff Member Name': '',
      'Staff Email': '',
      'Old Device Serial Number': '',
      'New Device Serial Number': '',
      'Replacement Date': localToday(),
      'Replacement Reason': '',
      'Old Device Condition': '',
      'Handover Eligibility': '',
      'Lifecycle Status': '',
      Remarks: ''
    };
    Modal.open({
      title: existing ? 'Edit replacement record' : 'Add replacement record',
      confirmText: existing ? 'Save changes' : 'Add record',
      size: 'lg',
      body: `<form id="replacementForm" class="replacement-form">
        <div class="replacement-form-grid">
          <label class="device-form-field">Staff Member Name *
            <input class="form-control" name="Staff Member Name" required value="${escapeHtml(record['Staff Member Name'])}">
          </label>
          <label class="device-form-field">Staff Email
            <input class="form-control" type="email" name="Staff Email" value="${escapeHtml(record['Staff Email'])}">
          </label>
          <label class="device-form-field">Old Device (name — serial number) *
            <input class="form-control" id="oldSerialInput" name="Old Device Serial Number" list="oldDeviceOptions" autocomplete="off" required value="${escapeHtml(record['Old Device Serial Number'])}" placeholder="Choose a device or enter a serial number">
            ${deviceOptions('oldDeviceOptions')}
          </label>
          <label class="device-form-field">New Device (name — serial number) *
            <input class="form-control" id="newSerialInput" name="New Device Serial Number" list="newDeviceOptions" autocomplete="off" required value="${escapeHtml(record['New Device Serial Number'])}" placeholder="Choose a device or enter a serial number">
            ${deviceOptions('newDeviceOptions')}
          </label>
          <label class="device-form-field">Replacement Date *
            <input class="form-control" type="date" name="Replacement Date" required value="${escapeHtml(record['Replacement Date'])}">
          </label>
          <label class="device-form-field">Replacement Reason *
            <select class="form-control" name="Replacement Reason" required>${selectOptions(REASONS, record['Replacement Reason'], 'Select reason')}</select>
          </label>
          <label class="device-form-field">Old Device Condition *
            <select class="form-control" name="Old Device Condition" required>${selectOptions(CONDITIONS, record['Old Device Condition'], 'Select condition')}</select>
          </label>
          <label class="device-form-field">Handover Eligibility *
            <select class="form-control" name="Handover Eligibility" required>${selectOptions(ELIGIBILITY, record['Handover Eligibility'], 'Select eligibility')}</select>
          </label>
          <label class="device-form-field">Lifecycle Status *
            <select class="form-control" name="Lifecycle Status" required>${selectOptions(LIFECYCLE, record['Lifecycle Status'], 'Select status')}</select>
          </label>
          <label class="device-form-field replacement-remarks-field">Remarks
            <textarea class="form-control" name="Remarks">${escapeHtml(record.Remarks)}</textarea>
          </label>
        </div>
        <p id="replacementSerialWarning" class="replacement-warning" aria-live="polite"></p>
        <p class="replacement-form-note">Serial numbers not found in the current inventory can still be recorded.</p>
      </form>`,
      onOpen: () => {
        const form = document.getElementById('replacementForm');
        const oldSerial = form.elements.namedItem('Old Device Serial Number');
        const newSerial = form.elements.namedItem('New Device Serial Number');
        const staffName = form.elements.namedItem('Staff Member Name');
        const staffEmail = form.elements.namedItem('Staff Email');
        const warning = document.getElementById('replacementSerialWarning');
        const prefillStaff = () => {
          const device = inventoryDevice(oldSerial.value);
          if (!device) return;
          if (!staffName.value.trim()) staffName.value = device['Primary user display name'] || '';
          if (!staffEmail.value.trim()) staffEmail.value = device['Primary user email address'] || device['Primary user UPN'] || '';
        };
        const updateWarning = () => {
          const missing = [];
          if (oldSerial.value.trim() && !inventoryDevice(oldSerial.value)) missing.push(`Old device ${oldSerial.value.trim()} is not found in the current inventory.`);
          if (newSerial.value.trim() && !inventoryDevice(newSerial.value)) missing.push(`New device ${newSerial.value.trim()} is not found in the current inventory.`);
          warning.textContent = missing.join(' ');
        };
        oldSerial.addEventListener('change', () => {
          prefillStaff();
          updateWarning();
        });
        oldSerial.addEventListener('input', () => { prefillStaff(); updateWarning(); });
        newSerial.addEventListener('input', updateWarning);
        updateWarning();
      },
      onConfirm: async () => {
        const form = document.getElementById('replacementForm');
        const data = new FormData(form);
        const candidate = {};
        COLUMNS.forEach((column) => {
          candidate[column] = column === 'Replacement ID' ? record[column] : data.get(column);
        });
        const checked = validateRecord(candidate);
        if (checked.errors.length) {
          Toast.show(checked.errors[0], 'error', 5000);
          return;
        }
        const updated = checked.record;
        const otherRecords = records.filter((item) => item['Replacement ID'] !== record['Replacement ID']);
        const duplicatePair = otherRecords.some((item) =>
          serialKey(item['Old Device Serial Number']) === serialKey(updated['Old Device Serial Number'])
          && serialKey(item['New Device Serial Number']) === serialKey(updated['New Device Serial Number']));
        const alreadyReplaced = otherRecords.some((item) =>
          serialKey(item['Old Device Serial Number']) === serialKey(updated['Old Device Serial Number']));
        const warnings = [];
        if (alreadyReplaced) warnings.push('This old device already has another replacement event.');
        if (duplicatePair) warnings.push('This old/new serial-number pair already exists.');
        if (warnings.length && !window.confirm(`${warnings.join('\n')}\n\nSave this record anyway?`)) return;

        const nextRecords = existing
          ? records.map((item) => item['Replacement ID'] === record['Replacement ID'] ? updated : item)
          : [...records, updated];
        if (!await persistRecords(nextRecords)) return;
        Modal.close();
        render(document.getElementById('moduleContainer'));
        Toast.show(existing ? 'Replacement record updated and saved to SQLite.' : 'Replacement record added and saved to SQLite.', 'success', 5000);
      }
    });
  }

  function viewRecord(id) {
    const record = records.find((item) => item['Replacement ID'] === id);
    if (!record) return;
    const details = [
      ...COLUMNS.filter((column) => column !== 'Remarks').map((column) => [column, record[column] || '—']),
      ['Old Device Name', inventoryDeviceName(record['Old Device Serial Number']) || 'Not found in current inventory'],
      ['New Device Name', inventoryDeviceName(record['New Device Serial Number']) || 'Not found in current inventory'],
      ['Remarks', record.Remarks || '—']
    ];
    Modal.open({
      title: `Replacement ${record['Replacement ID']}`,
      confirmText: 'Close',
      body: `<dl class="replacement-details">${details.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`,
      onConfirm: () => Modal.close()
    });
  }

  function deleteRecord(id) {
    const record = records.find((item) => item['Replacement ID'] === id);
    if (!record) return;
    Modal.open({
      title: 'Delete replacement record',
      confirmText: 'Delete',
      body: `<p>Delete replacement record <strong>${escapeHtml(record['Replacement ID'])}</strong> for ${escapeHtml(record['Staff Member Name'])}? This removes it from the local SQLite database.</p>`,
      onOpen: () => { document.getElementById('modalConfirm').className = 'btn btn-danger'; },
      onConfirm: async () => {
        const nextRecords = records.filter((item) => item['Replacement ID'] !== id);
        if (!await persistRecords(nextRecords)) return;
        Modal.close();
        render(document.getElementById('moduleContainer'));
        Toast.show('Replacement record deleted from SQLite.', 'success', 5000);
      }
    });
  }

  async function applyImport(imported, mode) {
    let nextRecords;
    if (mode === 'replace') {
      nextRecords = imported;
    } else {
      const existingById = new Map(records.map((record) => [record['Replacement ID'].toUpperCase(), record]));
      const additions = [];
      for (const record of imported) {
        const existing = existingById.get(record['Replacement ID'].toUpperCase());
        if (!existing) additions.push(record);
        else if (JSON.stringify(existing) !== JSON.stringify(record)) {
          throw new Error(`Replacement ID ${record['Replacement ID']} already exists with different data. Choose Replace or resolve the ID conflict first.`);
        }
      }
      nextRecords = [...records, ...additions];
      const skipped = imported.length - additions.length;
      if (skipped) Toast.show(`${skipped} identical record(s) already existed and were not duplicated.`, 'info', 5000);
    }
    if (!await persistRecords(nextRecords)) return;
    Modal.close();
    render(document.getElementById('moduleContainer'));
    Toast.show(`Imported ${imported.length} replacement record(s) using ${mode} mode and saved them to SQLite.`, 'success', 6000);
  }

  function render(container) {
    if (!container) return;
    initializeRecords();
    const rows = filteredRecords();
    container.innerHTML = `
      <div class="section-header">
        <div>
          <div class="section-title">Device Replacement History</div>
          <div class="section-sub">${records.length} replacement record(s) saved in the local SQLite database.</div>
        </div>
        <div class="section-actions replacement-toolbar">
          <button class="btn btn-primary btn-sm" id="addReplacementBtn">+ Add replacement</button>
          <button class="btn btn-secondary btn-sm" id="importReplacementBtn">Import Replacement History CSV</button>
          <button class="btn btn-secondary btn-sm" id="exportReplacementBtn">Export Replacement History CSV</button>
          <button class="btn btn-secondary btn-sm" id="templateReplacementBtn">Download Empty Template</button>
          <input id="replacementFileInput" type="file" accept=".csv,text/csv" hidden>
        </div>
      </div>
      ${records.length ? renderStats() : '<div class="card replacement-notice">No replacement history exists yet. Add a record or import a replacement history CSV to get started.</div>'}
      <div class="card replacement-workflow-note">Replacement events are saved automatically to this app’s local SQLite database and are independent of Intune inventory imports. Export CSV for backup or transfer to another app installation.</div>
      <div class="filter-bar replacement-filters">
        <input id="replacementSearch" class="search-input" placeholder="Search ID, staff, email, or serial..." value="${escapeHtml(search)}">
        <select id="replacementReasonFilter" class="form-control replacement-filter">${selectOptions(REASONS, reasonFilter, 'All reasons')}</select>
        <select id="replacementEligibilityFilter" class="form-control replacement-filter">${selectOptions(ELIGIBILITY, eligibilityFilter, 'All eligibility')}</select>
        <select id="replacementLifecycleFilter" class="form-control replacement-filter">${selectOptions(LIFECYCLE, lifecycleFilter, 'All lifecycle')}</select>
        <label class="replacement-date-filter">From <input id="replacementDateFrom" type="date" class="form-control" value="${escapeHtml(dateFrom)}"></label>
        <label class="replacement-date-filter">To <input id="replacementDateTo" type="date" class="form-control" value="${escapeHtml(dateTo)}"></label>
        <select id="replacementSort" class="form-control replacement-filter">
          <option value="date" ${sortBy === 'date' ? 'selected' : ''}>Sort: replacement date</option>
          <option value="staff" ${sortBy === 'staff' ? 'selected' : ''}>Sort: staff name</option>
          <option value="serial" ${sortBy === 'serial' ? 'selected' : ''}>Sort: old serial</option>
        </select>
        <button class="btn btn-secondary btn-sm" id="replacementSortDirection">${sortDirection === 'asc' ? 'Oldest / A–Z' : 'Newest / Z–A'}</button>
        <button class="btn btn-secondary btn-sm" id="clearReplacementFilters">Clear filters</button>
      </div>
      <div class="card replacement-table-wrap">
        <table class="replacement-table">
          <thead><tr>
            <th>Replacement ID</th><th>Staff Member Name</th><th>Staff Email</th>
            <th>Old Device Serial Number</th><th>Old Device Name</th>
            <th>New Device Serial Number</th><th>New Device Name</th><th>Replacement Date</th>
            <th>Replacement Reason</th><th>Old Device Condition</th><th>Handover Eligibility</th>
            <th>Lifecycle Status</th><th>Remarks</th><th>Actions</th>
          </tr></thead>
          <tbody>${renderRows(rows)}</tbody>
        </table>
      </div>`;

    container.querySelector('#addReplacementBtn').addEventListener('click', () => openForm());
    container.querySelector('#importReplacementBtn').addEventListener('click', () => container.querySelector('#replacementFileInput').click());
    container.querySelector('#exportReplacementBtn').addEventListener('click', () => {
      downloadCsv(records, 'device-replacement-history.csv');
      Toast.show(`Exported ${records.length} replacement record(s).`, 'success');
    });
    container.querySelector('#templateReplacementBtn').addEventListener('click', () => {
      downloadCsv([], 'device-replacement-history-template.csv');
      Toast.show('Empty replacement history template downloaded.', 'success');
    });
    container.querySelector('#replacementSearch').addEventListener('input', (event) => {
      search = event.target.value;
      const caret = event.target.selectionStart;
      render(container);
      const nextSearch = container.querySelector('#replacementSearch');
      nextSearch.focus();
      nextSearch.setSelectionRange(caret, caret);
    });
    container.querySelector('#replacementReasonFilter').addEventListener('change', (event) => { reasonFilter = event.target.value; render(container); });
    container.querySelector('#replacementEligibilityFilter').addEventListener('change', (event) => { eligibilityFilter = event.target.value; render(container); });
    container.querySelector('#replacementLifecycleFilter').addEventListener('change', (event) => { lifecycleFilter = event.target.value; render(container); });
    container.querySelector('#replacementDateFrom').addEventListener('change', (event) => { dateFrom = event.target.value; render(container); });
    container.querySelector('#replacementDateTo').addEventListener('change', (event) => { dateTo = event.target.value; render(container); });
    container.querySelector('#replacementSort').addEventListener('change', (event) => { sortBy = event.target.value; render(container); });
    container.querySelector('#replacementSortDirection').addEventListener('click', () => { sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'; render(container); });
    container.querySelector('#clearReplacementFilters').addEventListener('click', () => {
      search = '';
      reasonFilter = '';
      eligibilityFilter = '';
      lifecycleFilter = '';
      dateFrom = '';
      dateTo = '';
      render(container);
    });
    container.querySelectorAll('.view-replacement-btn').forEach((button) => button.addEventListener('click', () => viewRecord(button.dataset.id)));
    container.querySelectorAll('.edit-replacement-btn').forEach((button) => button.addEventListener('click', () => openForm(button.dataset.id)));
    container.querySelectorAll('.delete-replacement-btn').forEach((button) => button.addEventListener('click', () => deleteRecord(button.dataset.id)));
    container.querySelector('#replacementFileInput').addEventListener('change', async (event) => {
      const [file] = event.target.files;
      if (!file) return;
      try {
        const imported = parseReplacementCsv(await file.text());
        Modal.open({
          title: 'Import replacement history',
          confirmText: 'Import CSV',
          body: `<p>Found ${imported.length} valid record(s). Choose how to apply them:</p>
            <label class="duplicate-choice"><input type="radio" name="replacementImportMode" value="merge" checked> Merge by Replacement ID; keep existing records and add new IDs</label>
            <label class="duplicate-choice"><input type="radio" name="replacementImportMode" value="replace"> Replace all currently loaded history</label>`,
          onConfirm: async () => {
            const mode = document.querySelector('input[name="replacementImportMode"]:checked')?.value;
            if (mode !== 'merge' && mode !== 'replace') {
              Toast.show('Choose whether to merge or replace the loaded history.', 'error');
              return;
            }
            if (mode === 'replace' && records.length && !window.confirm('Replace the currently loaded replacement history with this CSV?')) return;
            const baseline = mode === 'merge' ? records : [];
            const baselineIds = new Map(baseline.map((record) => [record['Replacement ID'].toUpperCase(), record]));
            const recordsToCheck = mode === 'merge'
              ? imported.filter((record) => !baselineIds.has(record['Replacement ID'].toUpperCase()))
              : imported;
            const seenOld = new Set(baseline.map((record) => serialKey(record['Old Device Serial Number'])));
            const seenPairs = new Set(baseline.map((record) => `${serialKey(record['Old Device Serial Number'])}\u0000${serialKey(record['New Device Serial Number'])}`));
            let repeatedOld = 0;
            let repeatedPair = 0;
            recordsToCheck.forEach((record) => {
              const oldSerial = serialKey(record['Old Device Serial Number']);
              const pair = `${oldSerial}\u0000${serialKey(record['New Device Serial Number'])}`;
              if (seenOld.has(oldSerial)) repeatedOld += 1;
              if (seenPairs.has(pair)) repeatedPair += 1;
              seenOld.add(oldSerial);
              seenPairs.add(pair);
            });
            const importWarnings = [];
            if (repeatedOld) importWarnings.push(`${repeatedOld} event(s) use an old device that already has a replacement event`);
            if (repeatedPair) importWarnings.push(`${repeatedPair} event(s) repeat an old/new serial-number pair`);
            if (importWarnings.length && !window.confirm(`${importWarnings.join('\n')}.\n\nImport these records anyway?`)) return;
            try {
              await applyImport(imported, mode);
            } catch (error) {
              Toast.show(escapeHtml(error.message || 'Replacement history import failed.'), 'error', 7000);
            }
          }
        });
      } catch (error) {
        Toast.show(escapeHtml(error.message || 'Replacement history import failed.'), 'error', 7000);
      } finally {
        event.target.value = '';
      }
    });
  }

  return {
    render,
    summaryForSerial,
    getRecords() { return records.map((record) => ({ ...record })); },
    onCountryChange() {}
  };
})());
