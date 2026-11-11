App.registerModule('users', (() => {
  let selectedUserKey = '';
  let countryFilter = 'all';
  let userSearch = '';
  let userAssetCountFilter = '';
  let userStaffTypeFilter = 'all';
  let userFilterPanelOpen = false;
  let userFilterUserId = '';
  let userFilterName = '';
  let userFilterEmail = '';
  let userFilterLocation = '';
  let userFilterAccountActive = '';
  let userFilterHasAssets = false;
  let selectedUserIndexes = new Set();
  const COUNTRY_CODES = {
    singapore: 'SG', australia: 'AU', malaysia: 'MY', thailand: 'TH', india: 'IN',
    indonesia: 'ID', vietnam: 'VN', philippines: 'PH', japan: 'JP', 'united states': 'US'
  };
  const USER_IMPORT_COLUMN_LABELS = {
    name: 'Name',
    'full name': 'Full Name',
    'user name': 'User Name',
    'staff name': 'Staff Name',
    userid: 'UserID',
    'user id': 'UserID',
    email: 'Email',
    'email address': 'Email Address',
    'staff email': 'Staff Email',
    'user email': 'User Email',
    'account active': 'Account Active',
    'account status': 'Account Status',
    active: 'Active',
    country: 'Country',
    location: 'Location',
    office: 'Office',
    site: 'Site'
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function normalize(value) {
    return String(value || '').trim().toLowerCase();
  }

  function userKey(email, name) {
    return normalize(email) || normalize(name);
  }

  function accountActiveFromCsv(value) {
    const text = String(value || '').trim().toUpperCase();
    return text === 'YES' || text === 'NO' ? text : 'YES';
  }

  function makeUserId() {
    const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `usr-${suffix}`;
  }

  function detectStaffType(name) {
    const text = String(name || '').trim();
    if (!text) return { staffType: null, vendor: null, suspicious: false };
    const paren = text.match(/\(([^()]*)\)/);
    if (!paren) return { staffType: 'Internal Staff', vendor: null, suspicious: false };
    const group = paren[1];
    const ext = group.match(/(?:^|[^a-z0-9])ext([^a-z0-9]|$)/i);
    if (!ext) return { staffType: 'Internal Staff', vendor: null, suspicious: false };
    const after = group.slice(ext.index + ext[0].length).split('[', 1)[0];
    const vendor = String(after.trim()).split(/[\s\-–—/]+/).filter(Boolean)[0] || null;
    const outside = text.replace(/\([^()]*\)/g, '');
    const suspicious = /(?:^|[^a-z0-9])ext([^a-z0-9]|$)/i.test(outside);
    return { staffType: 'External Staff', vendor, suspicious };
  }

  function storedUsers() {
    const records = App.store.get('users');
    if (!Array.isArray(records)) return [];
    return records.map((record) => {
      if (!record || typeof record !== 'object') return record;
      const normalized = { ...record };
      if ('User ID' in normalized || 'user_id' in normalized) {
        normalized.UserID = normalized.UserID ?? normalized['User ID'] ?? normalized.user_id;
        delete normalized['User ID'];
        delete normalized.user_id;
      }
      return normalized;
    });
  }

  function countryCode(value) {
    const normalized = normalize(value);
    if (/^[a-z]{2}$/.test(normalized)) return normalized.toUpperCase();
    return COUNTRY_CODES[normalized] || '';
  }

  function countryMatches(value) {
    return countryFilter === 'all' || countryCode(value) === countryFilter;
  }

  function serialKey(value) {
    return String(value || '').trim().toUpperCase().replace(/--\d+$/, '').replace(/\s+/g, '');
  }

  function assetSerial(device) {
    return [device['Serial number'], device['IntuneGroup.SerialNumber']]
      .map(serialKey)
      .find((serial) => serial && !['N/A', 'NA', 'NONE', 'NULL', 'UNKNOWN', '-'].includes(serial)) || '';
  }

  function userDetails(device) {
    const checkout = App.modules.inventory?.currentCheckoutFor(device);
    const name = String(checkout?.['Staff name'] || device['Primary user display name'] || '').trim();
    const email = String(
      checkout?.['Staff email']
      || device['Primary user email address']
      || device['Primary user UPN']
      || ''
    ).trim();
    const label = name || email;
    if (!label) return null;
    return {
      name,
      email,
      key: userKey(email, label),
      country: String(device.Country || App.modules.inventory?.countryForDevice?.(device) || ''),
      location: String(device.Location || ''),
      checkout
    };
  }

  function checkoutOptions() {
    const options = new Map();
    const add = (user, fallbackId) => {
      const name = String(user.Name || user.name || user['Staff name'] || '').trim();
      const email = String(user.Email || user.email || user['Staff email'] || '').trim();
      const key = userKey(email, name);
      if (!key || !name) return;
      const existing = options.get(key);
      options.set(key, {
        id: existing?.id || String(user.UserID || fallbackId || `user:${key}`),
        name,
        email: email || existing?.email || '',
        country: String(user.Country || user.country || existing?.country || ''),
        location: String(user.Location || user.location || existing?.location || '')
      });
    };

    storedUsers().forEach((user) => add(user, `user:${userKey(user.Email, user.Name)}`));
    (App.store.get('inventory') || []).forEach((device) => {
      const user = userDetails(device);
      if (user) add(user, `inventory:${user.key}`);
    });
    (App.store.get('checkoutHistory') || []).forEach((event) => {
      add({
        'Staff name': event['Staff name'],
        'Staff email': event['Staff email'],
        Country: event['Staff country'],
        Location: event['Staff location']
      }, `history:${userKey(event['Staff email'], event['Staff name'])}`);
    });
    return [...options.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  function getUsers() {
    const users = new Map();
    storedUsers().forEach((record) => {
      const key = userKey(record.Email, record.Name);
      if (!key || !countryMatches(record.Country)) return;
      users.set(key, {
        key,
        id: String(record.UserID || ''),
        name: String(record.Name || '').trim(),
        email: String(record.Email || '').trim(),
        staffType: String(record.staff_type || '').trim(),
        staffTypeSource: String(record.staff_type_source || '').trim(),
        accountActive: String(record['Account Active'] || 'YES').trim().toUpperCase(),
        country: String(record.Country || ''),
        location: String(record.Location || ''),
        assets: [],
        serials: new Set()
      });
    });

    const inventory = App.store.get('inventory');
    inventory.forEach((device) => {
      const serial = assetSerial(device);
      if (!serial) return;
      const identity = userDetails(device);
      if (!identity) return;
      const key = identity.key;
      const assetCountry = String(device.Country || App.modules.inventory?.countryForDevice?.(device) || '');
      if (!countryMatches(assetCountry)) return;
      let user = users.get(key);
      if (!user) {
        user = {
          key, id: '', name: identity.name, email: identity.email,
          staffType: '', staffTypeSource: 'auto',
          accountActive: 'YES',
          country: identity.country, location: identity.location,
          assets: [], serials: new Set()
        };
        users.set(key, user);
      }

      const deviceOwnerEmail = String(identity.email || '').trim().toLowerCase();
      const userEmailValue = String(user.email || '').trim().toLowerCase();
      const ownsDevice = Boolean(deviceOwnerEmail) && Boolean(userEmailValue) && deviceOwnerEmail === userEmailValue;
      if (!ownsDevice) return;

      if (user.serials.has(serial)) return;
      user.serials.add(serial);
      user.assets.push({
        name: device['Device name'] || 'Unnamed device',
        serial,
        deviceId: device['Device ID'] || '',
        type: device['Asset type'] || device['Device type'] || 'laptop',
        checkout: identity.checkout
      });
      if (!user.country) user.country = identity.country;
      if (!user.location) user.location = identity.location;
    });
    return [...users.values()]
      .map(({ serials, ...user }) => user)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  function renderAssetTable(user) {
    return `<div class="card inventory-table-wrap">
      <table class="inventory-table">
        <thead><tr><th>Device name</th><th>Serial number</th><th>Device ID</th><th>Device type</th><th>Custody status</th></tr></thead>
        <tbody>${user.assets.map((asset) => `<tr>
          <td>${escapeHtml(asset.name)}</td>
          <td>${escapeHtml(asset.serial)}</td>
          <td>${escapeHtml(asset.deviceId || '—')}</td>
          <td>${escapeHtml(asset.type)}</td>
          <td><span class="badge ${asset.checkout ? 'badge-blue' : 'badge-green'}">${asset.checkout ? 'Checked out' : 'Primary user'}</span></td>
        </tr>`).join('') || '<tr><td colspan="5" class="empty-state">No assigned assets.</td></tr>'}</tbody>
      </table>
    </div>`;
  }

  function openUserForm(container) {
    Modal.open({
      title: 'Add user',
      confirmText: 'Add user',
      body: `<form id="userForm" class="device-form">
        <label>Name <span class="required">*</span><input name="name" required autocomplete="name" /></label>
        <label>Email<input name="email" type="email" autocomplete="email" /></label>
        <label>Account Active<select name="accountActive"><option value="YES" selected>YES</option><option value="NO">NO</option></select></label>
        <label>Country<input name="country" placeholder="e.g. Singapore or SG" /></label>
        <label>Location<input name="location" placeholder="Office, site, or department" /></label>
        <label>Staff Type<select name="staffType"><option value="">Auto-detect</option><option value="External Staff">External Staff</option><option value="Internal Staff">Internal Staff</option><option value="Unclassified">Unclassified</option></select></label>
      </form>`,
      onConfirm: async () => {
        const form = document.getElementById('userForm');
        if (!form.reportValidity()) return;
        const values = new FormData(form);
        const record = {
          UserID: makeUserId(),
          Name: String(values.get('name') || '').trim(),
          Email: String(values.get('email') || '').trim(),
          'Account Active': String(values.get('accountActive') || 'YES').trim().toUpperCase(),
          Country: String(values.get('country') || '').trim(),
          Location: String(values.get('location') || '').trim()
        };
        const staffTypeValue = String(values.get('staffType') || '');
        if (staffTypeValue) {
          record.staff_type = staffTypeValue === 'Unclassified' ? null : staffTypeValue;
          record.staff_type_source = 'manual';
        }
        const current = storedUsers();
        const duplicateIndex = current.findIndex((user) => record.Email
          ? normalize(user.Email) === normalize(record.Email)
          : normalize(user.Name) === normalize(record.Name) && !user.Email);
        const mergedUser = duplicateIndex >= 0
          ? {
              ...current[duplicateIndex],
              ...record,
              UserID: current[duplicateIndex].UserID,
              Name: record.Name || current[duplicateIndex].Name,
              Email: record.Email || current[duplicateIndex].Email,
              Country: record.Country || current[duplicateIndex].Country,
              Location: record.Location || current[duplicateIndex].Location
            }
          : record;
        const nextUsers = duplicateIndex >= 0
          ? current.map((user, index) => (index === duplicateIndex ? mergedUser : user))
          : [...current, record];
        try {
          await App.store.set('users', nextUsers);
          Modal.close();
          render(container, countryFilter);
          Toast.show(duplicateIndex >= 0 ? 'User merged into the existing Users list entry.' : 'User added to the Users list.', 'success');
        } catch (error) {
          Toast.show(`Could not save user: ${error.message || error}`, 'error', 6000);
        }
      }
    });
  }

  function parseUserCsv(text) {
    const rows = App.modules.inventory?.parseCsvText?.(text);
    if (!rows || rows.length < 2) throw new Error('User CSV is empty or missing a header row.');
    const headers = rows[0].map((header) => String(header || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
    const nameKeyIndex = headers.findIndex((header) => ['name', 'full name', 'user name', 'staff name'].includes(header));
    const userIdIndex = headers.findIndex((header) => ['userid', 'user id'].includes(header));
    const staffTypeIndex = headers.findIndex((header) => header === 'staff type');
    const indexes = {
      userId: userIdIndex,
      name: nameKeyIndex >= 0 ? nameKeyIndex : userIdIndex,
      staffType: staffTypeIndex,
      email: headers.findIndex((header) => ['email', 'email address', 'staff email', 'user email'].includes(header)),
      accountActive: headers.findIndex((header) => ['account active', 'account status', 'active'].includes(header)),
      country: headers.findIndex((header) => header === 'country'),
      location: headers.findIndex((header) => ['location', 'office', 'site'].includes(header))
    };
    if (indexes.name < 0) throw new Error('User CSV must include a NAME column (or Full Name/User Name/Staff Name).');

    const imported = rows.slice(1).map((row, rowIndex) => {
      const value = (index) => index < 0 ? '' : String(row[index] || '').trim();
      const name = value(indexes.name);
      const email = value(indexes.email);
      if (!name) throw new Error(`User CSV row ${rowIndex + 2} is missing a name.`);
      if (email && (!email.includes('@') || email.startsWith('@') || email.endsWith('@'))) {
        throw new Error(`User CSV row ${rowIndex + 2} has an invalid email address.`);
      }
      const staffTypeRaw = value(indexes.staffType);
      let staff_type = null;
      let staff_type_source = 'auto';
      if (staffTypeRaw) {
        const normalized = staffTypeRaw.toLowerCase();
        if (normalized === 'external staff') { staff_type = 'External Staff'; staff_type_source = 'manual'; }
        else if (normalized === 'internal staff') { staff_type = 'Internal Staff'; staff_type_source = 'manual'; }
        else if (normalized === 'unclassified') { staff_type = null; staff_type_source = 'manual'; }
        else { staff_type = null; staff_type_source = 'auto'; }
      }
      return {
        UserID: value(indexes.userId),
        Name: name,
        Email: email,
        'Account Active': accountActiveFromCsv(value(indexes.accountActive)),
        Country: value(indexes.country),
        Location: value(indexes.location),
        staff_type,
        staff_type_source
      };
    });
    if (!imported.length) throw new Error('User CSV contains no user records.');

    const seen = new Set();
    imported.forEach((user) => {
      const key = userKey(user.Email, user.Name);
      if (seen.has(key)) throw new Error(`User CSV contains a duplicate user: ${user.Email || user.Name}.`);
      seen.add(key);
    });
    return {
      imported,
      headers,
      validation: validateUserImportColumns(headers)
    };
  }

  function validateUserImportColumns(headers) {
    const recognized = [];
    const unrecognized = [];
    const normalizedSet = new Set();
    const knownUserColumns = [
      'name', 'full name', 'user name', 'staff name', 'userid', 'user id',
      'staff type',
      'email', 'email address', 'staff email', 'user email',
      'account active', 'account status', 'active',
      'country', 'location', 'office', 'site'
    ];
    headers.forEach((header) => {
      const normalized = String(header || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!normalized) return;
      normalizedSet.add(normalized);
      if (normalized === 'assigned assets') {
        // Derived column; excluded from import by design.
        if (!unrecognized.includes('assigned assets (derived/ignored)')) unrecognized.push('assigned assets (derived/ignored)');
        return;
      }
      if (knownUserColumns.includes(normalized)) {
        if (!recognized.includes(normalized)) recognized.push(normalized);
      } else if (!unrecognized.includes(normalized)) {
        unrecognized.push(normalized);
      }
    });
    const nameKeys = ['name', 'full name', 'user name', 'staff name', 'userid', 'user id'];
    const userIdKeys = ['userid', 'user id'];
    const missingRequired = [];
    if (!nameKeys.some((key) => normalizedSet.has(key))) missingRequired.push('NAME (or Full Name/User Name/Staff Name)');
    if (!userIdKeys.some((key) => normalizedSet.has(key))) missingRequired.push('USER ID');
    return { recognized, unrecognized, missingRequired };
  }

  function mergeImportedUsers(existing, imported) {
    const merged = existing.map((user) => ({ ...user }));
    imported.forEach((record) => {
      const key = userKey(record.Email, record.Name);
      const existingIndex = merged.findIndex((user) => userKey(user.Email, user.Name) === key);
      if (existingIndex < 0) merged.push(record);
      else merged[existingIndex] = {
        ...merged[existingIndex],
        ...record,
        UserID: merged[existingIndex].UserID,
        Name: record.Name || merged[existingIndex].Name,
        Email: record.Email || merged[existingIndex].Email,
        Country: record.Country || merged[existingIndex].Country,
        Location: record.Location || merged[existingIndex].Location
      };
    });
    return merged;
  }

  function render(container, country = 'all') {
    countryFilter = country;
    const allUsers = getUsers();
    const users = userSearch.trim()
      ? allUsers.filter((user) => {
        const needle = userSearch.trim().toLowerCase();
        const name = String(user.name || '').toLowerCase();
        const email = String(user.email || '').toLowerCase();
        return name.includes(needle) || email.includes(needle);
      })
      : allUsers;
    const parsedAssetCount = Number(userAssetCountFilter);
    let filteredUsers = userAssetCountFilter.trim() === '' || !Number.isFinite(parsedAssetCount)
      ? users
      : users.filter((user) => user.assets.length === parsedAssetCount);
    if (userStaffTypeFilter && userStaffTypeFilter !== 'all') {
      filteredUsers = filteredUsers.filter((user) => {
        const effectiveStaffType = String(user.staffType || '') || null;
        const wanted = userStaffTypeFilter === '' ? null : userStaffTypeFilter;
        const matches = wanted === null ? !effectiveStaffType : effectiveStaffType === wanted;
        return matches;
      });
    }
    if (userFilterUserId.trim()) {
      const needle = userFilterUserId.trim().toLowerCase();
      filteredUsers = filteredUsers.filter((user) => String(user.id || '').toLowerCase().includes(needle));
    }
    if (userFilterName.trim()) {
      const needle = userFilterName.trim().toLowerCase();
      filteredUsers = filteredUsers.filter((user) => String(user.name || '').toLowerCase().includes(needle));
    }
    if (userFilterEmail.trim()) {
      const needle = userFilterEmail.trim().toLowerCase();
      filteredUsers = filteredUsers.filter((user) => String(user.email || '').toLowerCase().includes(needle));
    }
    if (userFilterLocation.trim()) {
      const needle = userFilterLocation.trim().toLowerCase();
      filteredUsers = filteredUsers.filter((user) => String(user.location || '').toLowerCase().includes(needle));
    }
    if (userFilterAccountActive) {
      filteredUsers = filteredUsers.filter((user) => String(user.accountActive || 'YES').toUpperCase() === userFilterAccountActive);
    }
    if (userFilterHasAssets) {
      filteredUsers = filteredUsers.filter((user) => user.assets.length > 0);
    }
    const selected = users.find((user) => user.key === selectedUserKey);
    if (selected) {
      container.innerHTML = `
        <div class="section-header">
          <div>
            <div class="section-title">${escapeHtml(selected.name)}</div>
            <div class="section-sub">${escapeHtml(selected.email || 'User profile')} · ${escapeHtml([selected.country, selected.location].filter(Boolean).join(' · ') || 'No country or location')} · ${selected.assets.length} assigned serial number${selected.assets.length === 1 ? '' : 's'}</div>
          </div>
          <div class="section-actions"><button class="btn btn-secondary btn-sm" id="usersBackBtn">← Users</button></div>
        </div>
        ${renderAssetTable(selected)}
      `;
      container.querySelector('#usersBackBtn').addEventListener('click', () => {
        selectedUserKey = '';
        render(container, countryFilter);
      });
      return;
    }

    selectedUserKey = '';
    selectedUserIndexes.clear();
    const assetCount = filteredUsers.reduce((total, user) => total + user.assets.length, 0);
    const activeAccountCount = filteredUsers.filter((user) => user.accountActive === 'YES').length;
    const inactiveAccountCount = filteredUsers.filter((user) => user.accountActive === 'NO').length;
    const externalStaffCount = filteredUsers.filter((user) => user.staffType === 'External Staff').length;
    const internalStaffCount = filteredUsers.filter((user) => user.staffType === 'Internal Staff').length;
    const unclassifiedStaffCount = filteredUsers.filter((user) => !user.staffType).length;
    container.innerHTML = `
      <div class="section-header">
        <div>
          <div class="section-title">Users</div>
          <div class="section-sub">${filteredUsers.length} users · ${activeAccountCount} active · ${inactiveAccountCount} inactive · ${externalStaffCount} external · ${internalStaffCount} internal · ${unclassifiedStaffCount} unclassified · ${assetCount} assigned serial number${assetCount === 1 ? '' : 's'}</div>
        </div>
        <div class="section-actions">
          <button class="btn btn-primary btn-sm" id="addUserBtn">+ Add user</button>
          <button class="btn btn-secondary btn-sm" id="usersFilterToggle" aria-expanded="${userFilterPanelOpen}">Filter</button>
          <button class="btn btn-secondary btn-sm" id="importUsersBtn">Import users CSV</button>
          <div class="user-selection-actions" aria-label="Selected user actions">
            <button class="btn btn-secondary btn-sm" id="editUsersBtn" ${selectedUserIndexes.size ? '' : 'disabled'}>Edit selected</button>
            <button class="btn btn-danger btn-sm" id="deleteUsersBtn" ${selectedUserIndexes.size ? '' : 'disabled'}>Delete selected</button>
          </div>
        </div>
      </div>
      <div id="userStaffTypeLive" class="sr-only" aria-live="polite"></div>
      <div class="layout-controls">
        <div class="column-drawer-backdrop ${userFilterPanelOpen ? 'open' : ''}" id="usersFilterBackdrop"></div>
        <aside class="column-drawer users-filter-drawer ${userFilterPanelOpen ? 'open' : ''}" id="usersFilterPanel" aria-label="User filters" aria-hidden="${!userFilterPanelOpen}">
          <div class="column-drawer-header"><div><strong>Filters</strong><small>Filter the Users directory by column.</small></div><button type="button" class="btn btn-secondary btn-sm" id="closeUsersFilter" aria-label="Close filters">×</button></div>
          <label class="duplicate-filter-option" for="userFilterUserId">User ID</label>
          <input id="userFilterUserId" class="form-control" type="text" placeholder="Partial user ID..." value="${escapeHtml(userFilterUserId)}" />
          <label class="duplicate-filter-option" for="userFilterName">Name</label>
          <input id="userFilterName" class="form-control" type="text" placeholder="Partial name..." value="${escapeHtml(userFilterName)}" />
          <label class="duplicate-filter-option" for="userFilterEmail">Email</label>
          <input id="userFilterEmail" class="form-control" type="email" placeholder="Partial email..." value="${escapeHtml(userFilterEmail)}" />
          <label class="duplicate-filter-option" for="userFilterStaffType">Staff Type</label>
          <select id="userFilterStaffType" class="form-control" aria-label="Staff Type">
            <option value="all">All staff types</option>
            <option value="External Staff" ${userStaffTypeFilter === 'External Staff' ? 'selected' : ''}>External Staff</option>
            <option value="Internal Staff" ${userStaffTypeFilter === 'Internal Staff' ? 'selected' : ''}>Internal Staff</option>
            <option value="" ${!userStaffTypeFilter || userStaffTypeFilter === '' ? 'selected' : ''}>Unclassified</option>
          </select>
          <label class="duplicate-filter-option" for="userFilterAccountActive">Account Active</label>
          <select id="userFilterAccountActive" class="form-control" aria-label="Account Active">
            <option value="" ${!userFilterAccountActive ? 'selected' : ''}>All</option>
            <option value="YES" ${userFilterAccountActive === 'YES' ? 'selected' : ''}>YES</option>
            <option value="NO" ${userFilterAccountActive === 'NO' ? 'selected' : ''}>NO</option>
          </select>
          <label class="duplicate-filter-option" for="userFilterCountry">Country</label>
          <select id="userFilterCountry" class="form-control" aria-label="Country">
            <option value="all" ${countryFilter === 'all' ? 'selected' : ''}>All</option>
            ${Object.values(COUNTRY_CODES).map((code) => `<option value="${escapeHtml(code)}" ${countryFilter === code ? 'selected' : ''}>${escapeHtml(code)}</option>`).join('')}
          </select>
          <label class="duplicate-filter-option" for="userFilterLocation">Location</label>
          <input id="userFilterLocation" class="form-control" type="text" placeholder="Partial location..." value="${escapeHtml(userFilterLocation)}" />
          <label class="duplicate-filter-option" for="userFilterHasAssets"><input type="checkbox" id="userFilterHasAssets" ${userFilterHasAssets ? 'checked' : ''}> Assigned assets</label>
          <div class="column-drawer-footer"><button type="button" class="btn btn-secondary btn-sm" id="resetUsersFiltersBtn">Reset</button></div>
        </aside>
      </div>
      <div class="filter-bar">
        <input id="usersSearch" class="search-input" placeholder="Search users by name or email..." value="${escapeHtml(userSearch)}" />
        <input id="userAssetCountFilter" class="search-input" type="number" min="0" placeholder="Assigned assets (count)" value="${escapeHtml(userAssetCountFilter)}" />
        <select id="userStaffTypeFilter" class="search-input" aria-label="Filter users by staff type">
          <option value="all">All staff types</option>
          <option value="External Staff">External Staff</option>
          <option value="Internal Staff">Internal Staff</option>
          <option value="">Unclassified</option>
        </select>
      </div>
      <input id="usersFileInput" type="file" accept=".csv,text/csv" hidden />
      <div class="card inventory-table-wrap">
        <table class="inventory-table">
          <thead><tr><th><input type="checkbox" id="selectAllUsers" aria-label="Select all users" /></th><th>User ID</th><th>Name</th><th>Staff Type</th><th>Email</th><th>Account Active</th><th>Country</th><th>Location</th><th>Assigned assets</th><th>Actions</th></tr></thead>
          <tbody>${filteredUsers.length ? filteredUsers.map((user, index) => `<tr>
            <td><input type="checkbox" class="user-select-checkbox" data-user-index="${index}" aria-label="Select user" /></td>
            <td>${escapeHtml(user.id || '—')}</td>
            <td>${escapeHtml(user.name)}</td>
            <td>${escapeHtml(user.staffType || 'Unclassified')}</td>
            <td>${escapeHtml(user.email || '—')}</td>
            <td>${escapeHtml(user.accountActive || 'YES')}</td>
            <td>${escapeHtml(user.country || '—')}</td>
            <td>${escapeHtml(user.location || '—')}</td>
            <td>${user.assets.length}</td>
            <td><button class="btn btn-secondary btn-sm view-user-assets-btn" data-user-index="${index}">View assets</button></td>
          </tr>`).join('') : '<tr><td colspan="10" class="empty-state">No users match your search, staff type, asset count, or this country filter.</td></tr>'}</tbody>
        </table>
      </div>
    `;
    container.querySelector('#addUserBtn').addEventListener('click', () => openUserForm(container));
    const input = container.querySelector('#usersFileInput');
    container.querySelector('#importUsersBtn').addEventListener('click', () => input.click());
    input.addEventListener('change', async (event) => {
      const [file] = event.target.files || [];
      if (!file) return;
      try {
        const parsed = parseUserCsv(await file.text());
        const imported = parsed.imported;
        const validation = parsed.validation;
        if (validation.missingRequired && validation.missingRequired.length) {
          Modal.open({
            title: 'User CSV Import Review',
            confirmText: 'Proceed to import',
            body: `<div class="import-report"><div class="import-report-title">User CSV Import Review</div><div class="import-report-section"><strong style="color: var(--red);">Missing required columns:</strong> <ul>${validation.missingRequired.map((column) => `<li>${escapeHtml(column)}</li>`).join('')}</ul></div></div>`,
            onConfirm: () => {}
          });
          return;
        }
        Modal.open({
          title: 'User CSV Import Review',
          confirmText: 'Proceed to import',
          body: App.modules.inventory?.renderImportReport?.({
            title: 'User CSV Import Review',
            summaryLines: [`${imported.length} user record${imported.length === 1 ? '' : 's'} ready to import.`],
            selectableColumns: validation.recognized.map((column) => ({ key: column, label: USER_IMPORT_COLUMN_LABELS[column] || column })),
            recognizedColumns: validation.recognized,
            unrecognizedColumns: validation.unrecognized
          }) || `<div class="import-report"><div class="import-report-title">User CSV Import Review</div><div class="import-report-section"><strong style="color: var(--green);">Recognized columns (will be imported):</strong> ${validation.recognized.length ? `<ul>${validation.recognized.map((column) => `<li>${escapeHtml(column)}</li>`).join('')}</ul>` : '<p>No recognized columns found.</p>'}</div><div class="import-report-section"><strong style="color: var(--red);">Unrecognized columns:</strong> ${validation.unrecognized.length ? `<ul>${validation.unrecognized.map((column) => `<li>${escapeHtml(column)}</li>`).join('')}</ul>` : '<p>None</p>'}</div></div>`,
          onConfirm: async () => {
            try {
              const existing = storedUsers();
              const merged = mergeImportedUsers(existing, imported);
              const addedCount = imported.filter((record) => !existing.some((user) => userKey(user.Email, user.Name) === userKey(record.Email, record.Name))).length;
              const mergedCount = imported.length - addedCount;
              await App.store.set('users', merged);
              Modal.close();
              render(container, countryFilter);
              Modal.open({
                title: 'User Import Report',
                confirmText: 'Close',
                body: App.modules.inventory?.renderImportReport?.({
                  title: 'User Import Report',
                  summaryLines: [`${addedCount} added`, `${mergedCount} merged`],
                  recognizedColumns: validation.recognized,
                  unrecognizedColumns: validation.unrecognized
                }),
                onConfirm: () => Modal.close(),
                confirmText: 'Close'
              });
              Toast.show(`${addedCount} user${addedCount === 1 ? '' : 's'} imported.`, 'success');
            } catch (error) {
              Toast.show(`User CSV import failed: ${error.message || error}`, 'error', 6000);
            }
          }
        });
      } catch (error) {
        Toast.show(`User CSV import failed: ${error.message || error}`, 'error', 6000);
      } finally {
        event.target.value = '';
      }
    });
    const usersSearchInput = container.querySelector('#usersSearch');
    usersSearchInput.addEventListener('input', (event) => {
      userSearch = String(event.target.value || '');
      const hadFocus = document.activeElement === usersSearchInput;
      const caretPosition = usersSearchInput.selectionStart ?? userSearch.length;
      const caretEnd = usersSearchInput.selectionEnd ?? caretPosition;
      render(container, countryFilter);
      if (hadFocus) {
        const updatedSearchBox = container.querySelector('#usersSearch');
        if (updatedSearchBox) {
          updatedSearchBox.focus();
          updatedSearchBox.setSelectionRange(caretPosition, caretEnd);
        }
      }
    });
    const userAssetCountFilterInput = container.querySelector('#userAssetCountFilter');
    userAssetCountFilterInput.addEventListener('change', (event) => {
      userAssetCountFilter = String(event.target.value || '');
      render(container, countryFilter);
    });
    const userStaffTypeFilterSelect = container.querySelector('#userStaffTypeFilter');
    if (userStaffTypeFilterSelect) {
      userStaffTypeFilterSelect.addEventListener('change', (event) => {
        userStaffTypeFilter = String(event.target.value || 'all');
        render(container, countryFilter);
      });
    }
    const usersFilterToggle = container.querySelector('#usersFilterToggle');
    if (usersFilterToggle) {
      usersFilterToggle.addEventListener('click', () => {
        userFilterPanelOpen = !userFilterPanelOpen;
        render(container, countryFilter);
      });
    }
    const closeUsersFilter = container.querySelector('#closeUsersFilter');
    if (closeUsersFilter) {
      closeUsersFilter.addEventListener('click', () => {
        userFilterPanelOpen = false;
        render(container, countryFilter);
      });
    }
    const usersFilterBackdrop = container.querySelector('#usersFilterBackdrop');
    if (usersFilterBackdrop) {
      usersFilterBackdrop.addEventListener('click', () => {
        userFilterPanelOpen = false;
        render(container, countryFilter);
      });
    }
    const userFilterUserIdInput = container.querySelector('#userFilterUserId');
    if (userFilterUserIdInput) {
      userFilterUserIdInput.addEventListener('input', (event) => {
        userFilterUserId = String(event.target.value || '');
        render(container, countryFilter);
      });
    }
    const userFilterNameInput = container.querySelector('#userFilterName');
    if (userFilterNameInput) {
      userFilterNameInput.addEventListener('input', (event) => {
        userFilterName = String(event.target.value || '');
        render(container, countryFilter);
      });
    }
    const userFilterEmailInput = container.querySelector('#userFilterEmail');
    if (userFilterEmailInput) {
      userFilterEmailInput.addEventListener('input', (event) => {
        userFilterEmail = String(event.target.value || '');
        render(container, countryFilter);
      });
    }
    const userFilterStaffTypeSelectDrawer = container.querySelector('#userFilterStaffType');
    if (userFilterStaffTypeSelectDrawer) {
      userFilterStaffTypeSelectDrawer.addEventListener('change', (event) => {
        userStaffTypeFilter = String(event.target.value || 'all');
        render(container, countryFilter);
      });
    }
    const userFilterAccountActiveSelect = container.querySelector('#userFilterAccountActive');
    if (userFilterAccountActiveSelect) {
      userFilterAccountActiveSelect.addEventListener('change', (event) => {
        userFilterAccountActive = String(event.target.value || '');
        render(container, countryFilter);
      });
    }
    const userFilterCountrySelect = container.querySelector('#userFilterCountry');
    if (userFilterCountrySelect) {
      userFilterCountrySelect.addEventListener('change', (event) => {
        countryFilter = String(event.target.value || 'all');
        selectedUserKey = '';
        selectedUserIndexes.clear();
        render(container, countryFilter);
      });
    }
    const userFilterLocationInput = container.querySelector('#userFilterLocation');
    if (userFilterLocationInput) {
      userFilterLocationInput.addEventListener('input', (event) => {
        userFilterLocation = String(event.target.value || '');
        render(container, countryFilter);
      });
    }
    const userFilterHasAssetsCheckbox = container.querySelector('#userFilterHasAssets');
    if (userFilterHasAssetsCheckbox) {
      userFilterHasAssetsCheckbox.addEventListener('change', (event) => {
        userFilterHasAssets = Boolean(event.target.checked);
        render(container, countryFilter);
      });
    }
    const resetUsersFiltersBtn = container.querySelector('#resetUsersFiltersBtn');
    if (resetUsersFiltersBtn) {
      resetUsersFiltersBtn.addEventListener('click', () => {
        userFilterUserId = '';
        userFilterName = '';
        userFilterEmail = '';
        userFilterLocation = '';
        userFilterAccountActive = '';
        userFilterHasAssets = false;
        userStaffTypeFilter = 'all';
        userAssetCountFilter = '';
        userFilterPanelOpen = false;
        render(container, countryFilter);
      });
    }

    container.querySelectorAll('.user-select-checkbox').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const index = Number(checkbox.dataset.userIndex);
        if (checkbox.checked) selectedUserIndexes.add(index);
        else selectedUserIndexes.delete(index);
        const deleteSelectedBtn = container.querySelector('#deleteUsersBtn');
        const editSelectedBtn = container.querySelector('#editUsersBtn');
        const enabled = selectedUserIndexes.size > 0;
        if (deleteSelectedBtn) deleteSelectedBtn.disabled = !enabled;
        if (editSelectedBtn) editSelectedBtn.disabled = !enabled;
      });
    });
    document.getElementById('selectAllUsers').addEventListener('change', (event) => {
      const checked = event.target.checked;
      filteredUsers.forEach((user, index) => {
        if (checked) selectedUserIndexes.add(index);
        else selectedUserIndexes.delete(index);
        const rowCheckbox = container.querySelector(`.user-select-checkbox[data-user-index="${index}"]`);
        if (rowCheckbox) rowCheckbox.checked = checked;
      });
      const deleteSelectedBtn = container.querySelector('#deleteUsersBtn');
      const editSelectedBtn = container.querySelector('#editUsersBtn');
      const enabled = selectedUserIndexes.size > 0;
      if (deleteSelectedBtn) deleteSelectedBtn.disabled = !enabled;
      if (editSelectedBtn) editSelectedBtn.disabled = !enabled;
    });
    container.querySelectorAll('.view-user-assets-btn').forEach((button) => {
      button.addEventListener('click', () => {
        selectedUserKey = filteredUsers[Number(button.dataset.userIndex)].key;
        render(container, countryFilter);
      });
    });
    container.querySelector('#editUsersBtn').addEventListener('click', () => {
      const toEdit = Array.from(selectedUserIndexes).map((index) => filteredUsers[index]).filter(Boolean);
      if (!toEdit.length) return;
      const first = toEdit[0];
      Modal.open({
        title: `Edit ${toEdit.length} user${toEdit.length === 1 ? '' : 's'}`,
        confirmText: 'Save changes',
        body: `<form id="userEditForm" class="device-form">
          <label>Name <span class="required">*</span><input name="name" required value="${escapeHtml(first.name)}" /></label>
          <label>Email<input name="email" type="email" value="${escapeHtml(first.email || '')}" /></label>
          <label>Account Active<select name="accountActive"><option value="YES" ${first.accountActive === 'YES' ? 'selected' : ''}>YES</option><option value="NO" ${first.accountActive === 'NO' ? 'selected' : ''}>NO</option></select></label>
          <label>Country<input name="country" value="${escapeHtml(first.country || '')}" /></label>
          <label>Location<input name="location" value="${escapeHtml(first.location || '')}" /></label>
          <label>Staff Type<select name="staffType">
            <option value="">Auto-detect</option>
            <option value="External Staff" ${first.staffTypeSource === 'manual' && first.staffType === 'External Staff' ? 'selected' : ''}>External Staff</option>
            <option value="Internal Staff" ${first.staffTypeSource === 'manual' && first.staffType === 'Internal Staff' ? 'selected' : ''}>Internal Staff</option>
            <option value="Unclassified" ${first.staffTypeSource === 'manual' && !first.staffType ? 'selected' : ''}>Unclassified</option>
          </select></label>
        </form>`,
        onConfirm: async () => {
          const form = document.getElementById('userEditForm');
          if (!form.reportValidity()) return;
          const values = new FormData(form);
          const staffTypeValue = String(values.get('staffType') || '');
          const staffTypeSource = staffTypeValue ? 'manual' : 'auto';
          const updated = {
            Name: String(values.get('name') || '').trim(),
            Email: String(values.get('email') || '').trim(),
            'Account Active': String(values.get('accountActive') || 'YES').trim().toUpperCase(),
            Country: String(values.get('country') || '').trim(),
            Location: String(values.get('location') || '').trim(),
            staff_type: staffTypeValue ? (staffTypeValue === 'Unclassified' ? null : staffTypeValue) : null,
            staff_type_source: staffTypeSource,
            recompute_staff_type: staffTypeSource === 'auto'
          };
          const editTargets = toEdit.map((item) => ({
            id: item.id,
            oldEmail: normalize(item.email),
            oldName: normalize(item.name)
          }));
          const isTargetUser = (user) => editTargets.some((target) => (
            (target.id && String(user.UserID || '') === target.id)
            || (target.oldEmail && normalize(user.Email) === target.oldEmail)
            || (!target.oldEmail && target.oldName && normalize(user.Name) === target.oldName)
          ));
          const nextUsers = storedUsers().map((user) => {
            if (!isTargetUser(user)) return user;
            return {
              ...user,
              ...updated,
              // Keep both key styles so server-side replace is unambiguous.
              staffType: updated.staff_type,
              staffTypeSource: updated.staff_type_source,
              UserID: user.UserID
            };
          });
          const inventory = App.store.get('inventory') || [];
          const nextInventory = inventory.map((device) => {
            const email = normalize(device['Primary user email address'] || device['Primary user UPN']);
            const name = normalize(device['Primary user display name']);
            const target = editTargets.find((item) => (
              (item.oldEmail && email === item.oldEmail)
              || (!item.oldEmail && item.oldName && name === item.oldName)
            ));
            if (!target) return device;
            return {
              ...device,
              'Primary user display name': updated.Name,
              'Primary user email address': updated.Email,
              'Primary user UPN': updated.Email,
              Country: updated.Country,
              Location: updated.Location
            };
          });
          const checkoutHistory = App.store.get('checkoutHistory') || [];
          const nextCheckoutHistory = checkoutHistory.map((event) => {
            const email = normalize(event['Staff email']);
            const name = normalize(event['Staff name']);
            const target = editTargets.find((item) => (
              (item.oldEmail && email === item.oldEmail)
              || (!item.oldEmail && item.oldName && name === item.oldName)
            ));
            return target ? {
              ...event,
              'Staff name': updated.Name,
              'Staff email': updated.Email,
              'Staff country': updated.Country,
              'Staff location': updated.Location
            } : event;
          });
          try {
            if (JSON.stringify(nextInventory) !== JSON.stringify(inventory)) {
              await App.store.set('inventory', nextInventory);
            }
            if (JSON.stringify(nextCheckoutHistory) !== JSON.stringify(checkoutHistory)) {
              await App.store.set('checkoutHistory', nextCheckoutHistory);
            }
            await App.store.set('users', nextUsers);
            // Refresh from server so the table reflects the authoritative persisted value.
            if (typeof App.store.refreshUsers === 'function') {
              await App.store.refreshUsers();
            }
            Modal.close();
            render(container, countryFilter);
            Toast.show(`Updated ${toEdit.length} user${toEdit.length === 1 ? '' : 's'}.`, 'success');
          } catch (error) {
            Toast.show(`Could not save user: ${error.message || error}`, 'error', 6000);
          }
        }
      });
    });
    container.querySelector('#deleteUsersBtn').addEventListener('click', () => {
      const toDelete = Array.from(selectedUserIndexes).map((index) => filteredUsers[index]).filter(Boolean);
      if (!toDelete.length) return;
      Modal.open({
        title: `Delete ${toDelete.length} user${toDelete.length === 1 ? '' : 's'}`,
        confirmText: 'Delete',
        onOpen: () => { document.getElementById('modalConfirm').className = 'btn btn-danger'; },
        body: `<p>Delete ${toDelete.length} user${toDelete.length === 1 ? '' : 's'} from the Users list?</p>`,
        onConfirm: async () => {
          try {
            const remaining = storedUsers().filter((user) => !toDelete.some((target) => userKey(user.Email, user.Name) === target.key));
            await App.store.set('users', remaining);
            const inventory = App.store.get('inventory');
            if (Array.isArray(inventory)) {
              const clearedInventory = inventory.map((device) => {
                const email = String(device['Primary user email address'] || device['Primary user UPN'] || '').trim().toLowerCase();
                const name = String(device['Primary user display name'] || '').trim().toLowerCase();
                if (!toDelete.some((target) => userKey(email, name) === target.key)) return device;
                const cleared = { ...device };
                cleared['Primary user display name'] = '';
                cleared['Primary user email address'] = '';
                cleared['Primary user UPN'] = '';
                return cleared;
              });
              await App.store.set('inventory', clearedInventory);
            }
            selectedUserIndexes.clear();
            Modal.close();
            render(container, countryFilter);
            Toast.show(`Deleted ${toDelete.length} user${toDelete.length === 1 ? '' : 's'}.`, 'success');
          } catch (error) {
            Toast.show(`Could not delete user: ${error.message || error}`, 'error', 6000);
          }
        }
      });
    });
  }

  return {
    render,
    checkoutOptions,
    onCountryChange(country) {
      countryFilter = country;
      selectedUserKey = '';
      render(document.getElementById('moduleContainer'), country);
    }
  };
})());
