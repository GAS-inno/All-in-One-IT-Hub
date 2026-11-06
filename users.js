App.registerModule('users', (() => {
  let selectedUserKey = '';
  let countryFilter = 'all';
  let userSearch = '';
  let userAssetCountFilter = '';
  let selectedUserIndexes = new Set();
  const COUNTRY_CODES = {
    singapore: 'SG', australia: 'AU', malaysia: 'MY', thailand: 'TH', india: 'IN',
    indonesia: 'ID', vietnam: 'VN', philippines: 'PH', japan: 'JP', 'united states': 'US'
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

  function makeUserId() {
    return globalThis.crypto?.randomUUID?.() || `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function storedUsers() {
    const records = App.store.get('users');
    return Array.isArray(records) ? records : [];
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
      name: label,
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
        id: existing?.id || String(user['User ID'] || user.id || fallbackId || `user:${key}`),
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
        id: String(record['User ID'] || ''),
        name: String(record.Name || '').trim(),
        email: String(record.Email || '').trim(),
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
          country: identity.country, location: identity.location,
          assets: [], serials: new Set()
        };
        users.set(key, user);
      }
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
        <label>Country<input name="country" placeholder="e.g. Singapore or SG" /></label>
        <label>Location<input name="location" placeholder="Office, site, or department" /></label>
      </form>`,
      onConfirm: async () => {
        const form = document.getElementById('userForm');
        if (!form.reportValidity()) return;
        const values = new FormData(form);
        const record = {
          'User ID': makeUserId(),
          Name: String(values.get('name') || '').trim(),
          Email: String(values.get('email') || '').trim(),
          Country: String(values.get('country') || '').trim(),
          Location: String(values.get('location') || '').trim()
        };
        const current = storedUsers();
        const duplicateIndex = current.findIndex((user) => record.Email
          ? normalize(user.Email) === normalize(record.Email)
          : normalize(user.Name) === normalize(record.Name) && !user.Email);
        const mergedUser = duplicateIndex >= 0
          ? {
              ...current[duplicateIndex],
              ...record,
              'User ID': current[duplicateIndex]['User ID'],
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
    const headers = rows[0].map((header) => String(header || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' '));
    const indexes = {
      name: headers.findIndex((header) => ['name', 'full name', 'user name', 'staff name'].includes(header)),
      email: headers.findIndex((header) => ['email', 'email address', 'staff email', 'user email'].includes(header)),
      country: headers.findIndex((header) => header === 'country'),
      location: headers.findIndex((header) => ['location', 'office', 'site'].includes(header))
    };
    if (indexes.name < 0) throw new Error('User CSV must include a Name, Full Name, User Name, or Staff Name column.');

    const imported = rows.slice(1).map((row, rowIndex) => {
      const value = (index) => index < 0 ? '' : String(row[index] || '').trim();
      const name = value(indexes.name);
      const email = value(indexes.email);
      if (!name) throw new Error(`User CSV row ${rowIndex + 2} is missing a name.`);
      if (email && (!email.includes('@') || email.startsWith('@') || email.endsWith('@'))) {
        throw new Error(`User CSV row ${rowIndex + 2} has an invalid email address.`);
      }
      return {
        'User ID': makeUserId(),
        Name: name,
        Email: email,
        Country: value(indexes.country),
        Location: value(indexes.location)
      };
    });
    if (!imported.length) throw new Error('User CSV contains no user records.');

    const seen = new Set();
    imported.forEach((user) => {
      const key = userKey(user.Email, user.Name);
      if (seen.has(key)) throw new Error(`User CSV contains a duplicate user: ${user.Email || user.Name}.`);
      seen.add(key);
    });
    return imported;
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
        'User ID': merged[existingIndex]['User ID'],
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
    const filteredUsers = userAssetCountFilter.trim() === '' || !Number.isFinite(parsedAssetCount)
      ? users
      : users.filter((user) => user.assets.length === parsedAssetCount);
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
    container.innerHTML = `
      <div class="section-header">
        <div>
          <div class="section-title">Users</div>
          <div class="section-sub">${filteredUsers.length} user${filteredUsers.length === 1 ? '' : 's'} · ${assetCount} assigned serial number${assetCount === 1 ? '' : 's'}</div>
        </div>
        <div class="section-actions">
          <button class="btn btn-secondary btn-sm" id="addUserBtn">+ Add user</button>
          <button class="btn btn-primary btn-sm" id="importUsersBtn">Import users CSV</button>
          <button class="btn btn-danger btn-sm" id="deleteUsersBtn" ${selectedUserIndexes.size ? '' : 'disabled'}>Delete selected</button>
        </div>
      </div>
      <div class="filter-bar">
        <input id="usersSearch" class="search-input" placeholder="Search users by name or email..." value="${escapeHtml(userSearch)}" />
        <input id="userAssetCountFilter" class="search-input" type="number" min="0" placeholder="Assigned assets (count)" value="${escapeHtml(userAssetCountFilter)}" />
      </div>
      <input id="usersFileInput" type="file" accept=".csv,text/csv" hidden />
      <div class="card inventory-table-wrap">
        <table class="inventory-table">
          <thead><tr><th><input type="checkbox" id="selectAllUsers" aria-label="Select all users" /></th><th>User</th><th>Email</th><th>Country</th><th>Location</th><th>Assigned assets</th><th>Actions</th></tr></thead>
          <tbody>${filteredUsers.length ? filteredUsers.map((user, index) => `<tr>
            <td><input type="checkbox" class="user-select-checkbox" data-user-index="${index}" aria-label="Select user" /></td>
            <td>${escapeHtml(user.name)}</td>
            <td>${escapeHtml(user.email || '—')}</td>
            <td>${escapeHtml(user.country || '—')}</td>
            <td>${escapeHtml(user.location || '—')}</td>
            <td>${user.assets.length}</td>
            <td><button class="btn btn-secondary btn-sm view-user-assets-btn" data-user-index="${index}">View assets</button></td>
          </tr>`).join('') : '<tr><td colspan="7" class="empty-state">No users match your search, asset count, or this country filter.</td></tr>'}</tbody>
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
        const imported = parseUserCsv(await file.text());
        const next = mergeImportedUsers(storedUsers(), imported);
        await App.store.set('users', next);
        render(container, countryFilter);
        Toast.show(`${imported.length} user record${imported.length === 1 ? '' : 's'} imported.`, 'success');
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
    container.querySelectorAll('.user-select-checkbox').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const index = Number(checkbox.dataset.userIndex);
        if (checkbox.checked) selectedUserIndexes.add(index);
        else selectedUserIndexes.delete(index);
        const deleteSelectedBtn = container.querySelector('#deleteUsersBtn');
        if (deleteSelectedBtn) deleteSelectedBtn.disabled = selectedUserIndexes.size === 0;
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
      if (deleteSelectedBtn) deleteSelectedBtn.disabled = selectedUserIndexes.size === 0;
    });
    container.querySelectorAll('.view-user-assets-btn').forEach((button) => {
      button.addEventListener('click', () => {
        selectedUserKey = filteredUsers[Number(button.dataset.userIndex)].key;
        render(container, countryFilter);
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
