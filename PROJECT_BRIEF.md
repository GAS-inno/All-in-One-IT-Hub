# PROJECT BRIEF
> Last Updated: 2026-11-06

## 🎯 Project Goal
Build and maintain **NexIT (All-in-One IT Hub)** — a local-first, single-user IT asset inventory, warranty, user-to-asset, checkout/check-in, and replacement dashboard (vanilla HTML/CSS/JS frontend + Python standard-library backend + SQLite) that lets an IT administrator import Intune device exports and warranty data, search/filter devices, manage custody and replacements, and view fleet KPIs.

## 🧱 Architecture & Tech Stack
- **Language / Runtime:** Python 3.12 (backend, metrics, tests); modern browser JavaScript (ES2020+, optional chaining + nullish coalescing in use, no bundler) and CSS3.
- **Frontend:** Vanilla JS modules registered on a global `App` object (`app.js`); Chart.js 4.4.8 via jsDelivr CDN (UMD); Google Fonts (Syne + Space Mono); plain CSS custom-property theme.
- **Backend:** Python standard library only — `http.server.ThreadingHTTPServer`, `sqlite3`, `json`; no web framework (no Flask/FastAPI/Django).
- **Database:** SQLite at platform data dir: `%LOCALAPPDATA%\NexIT-Asset-Inventory\nexit-assets.db` (Windows), `~/Library/Application Support/NexIT-Asset-Inventory` (macOS), `~/.local/share/NexIT-Asset-Inventory` (Linux). Tables: `inventory_devices`, `warranty_records`, `replacement_history`, `checkout_history`, `users`, `app_metadata`.
- **Key Libraries & Versions:** Python 3.12.3; Chart.js 4.4.8; fonts Syne/Space Mono; no npm packages, no Node.js requirement.
- **Build / Test / Lint:** No build step, no lint config, no package.json. Tests: `python3 -m unittest -v`. JS syntax validated with Python `quickjs`.

## 🏗️ Architecture Overview
Browser SPA (no router library) with module registry → same-origin REST API → ThreadingHTTPServer → SQLite. Frontend modules: `app.js` (App/store/Modal/Toast/FileUpload/DateUtil + registry), `dashboard.js`, `inventory.js`, `users.js`, and `replacement-history.js`. Backend: `server.py` (HTTP + persistence), `dashboard_metrics.py` (aggregation).

```
index.html
 ├─ app.js          # App store/router/UI helpers, module registry
 ├─ dashboard.js    # dashboard module: charts, filters, KPI drilldown
 ├─ inventory.js    # inventory module: search, table, imports, warranty, device actions
 ├─ users.js        # managed staff directory, CSV import, and per-user asset lists
 └─ replacement-history.js  # replacement module: CRUD + CSV transfer

server.py ──► dashboard_metrics.py ──► SQLite
   │            │
   └── REST /api/* ◄──┘

App.store (cache Map + write queues) ──► /api/bootstrap, /api/inventory, /api/warranty, /api/replacement-history, /api/checkout-history, /api/users
```

Data flow: module `render(container, country)` → reads from `App.store` cache → fetch API on dashboard load → render result/charts. KPI click → `GET /api/dashboard/records?metric=…&…` → record indexes → `inventory.showDashboardResults(indexes, label)` sets module state `dashboardRecordIndexes` (a `Set`) → inventory module re-filters to those rows. Client-side module state drives inventory filtering (`duplicatesOnly`, `warrantyStatusFilter`, `dashboardRecordIndexes`, `dashboardFilterLabel`, `selectedDeviceIndexes`, `activeDeviceType`).

## 📁 Current File State
| Path | Purpose | Key Exports/Functions | Status |
|---|---|---|---|
| `index.html` | Page shell, sidebar nav, global modal/toast containers, script tags with cache versions | — | Stable |
| `app.js` | Core app: module registry/navigation, SQLite-backed store, Modal, Toast, FileUpload, DateUtil, countries, global wiring | `App`, `App.store`, `App.registerModule`, `App.navigateTo`, `Modal`, `Toast`, `App.store.initialize` | Stable |
| `server.py` | Local HTTP server + SQLite API, consistent DB backup and validated restore | `InventoryRequestHandler`, `connect_database`, `database_connection`, `_create_database_backup`, `_validate_database_backup`, `_restore_database_backup`, `main` | Active |
| `dashboard_metrics.py` | Field normalization + aggregates + metric drilldown | `FIELD_ALIASES`, `_text`, `_first`, `_key`, `_serial_key`, `_os`, `_lifecycle`, `_status`, `_warranty_date`, `_warranty_status`, `_action`, `_age_band`, `_dimension_value`, `filter_options`, `_filtered_records`, `matching_record_indexes`, `build_dashboard`, `_is_stale` | Stable |
| `dashboard.js` | Dashboard module UI | module object: `render`, `destroy`, `populateFilters`, `load`, `renderResult`, `drawCharts`, `openMetricRecords`, `updateUrl`, `restoreFilters`, `readFilters`, `showLoading`, `showMessage` | Stable |
| `inventory.js` | Inventory module: search, table, column layout, imports, warranty, checkout/check-in, custody history, and database backup/restore controls | module object: `render`, `currentCheckoutFor`, `countryForDevice`, `selectDeviceType`, `showDashboardResults`, `showAll`, `showDuplicates`, `showWarrantyMatched`, `onCountryChange`, `refreshDeviceTypeNavigation`, `getDeviceType`, `getDeviceTypeLabel`; internals include custody and database backup/restore actions | Active |
| `users.js` | SQLite-backed staff directory with manual add and CSV import, plus assigned-asset profiles; merges saved users with inventory/checkout-derived users for selection | module object: `render`, `checkoutOptions`, `onCountryChange` | Active |
| `replacement-history.js` | Replacement module: CRUD, validation, CSV transfer, and legacy deployment-label migration | module object: `render`, `summaryForSerial`, `getRecords`, `onCountryChange`; internals: `parseReplacementCsv`, `validateRecord`, `filteredRecords`, `applyImport`, `openForm`, `viewRecord`, `deleteRecord`, `latestPerOldDevice` | Active |
| `main.css` | Theme + component styles incl. sticky table/search behavior | — | Stable |
| `test_server.py` | SQLite/API tests | `SQLitePersistenceTests`, `SQLiteApiTests` | Stable |
| `test_dashboard_metrics.py` | Dashboard metric tests | `DashboardMetricTests`, `DashboardApiTests` | Stable |
| `README.md` | Usage docs | — | Stable |
| `start-linux.sh`, `start-windows.bat` | Launchers | — | Stable |

## 🚧 Active Tasks & Blockers
- [x] **2026-11-01:** Removed "All warranties" dropdown; added `Active device status` + `Age` computed columns (layout version 8 with migration).
- [x] **2026-11-01:** Column-layout checkboxes auto-apply on toggle; OK button removed; dropdown closes on outside click.
- [x] **2026-11-01:** Warranty Start/End date pickers + brighter calendar icon; CSS cache-bust bumped to `main.css?v=14`.
- [x] **2026-11-01:** CSV import validation for Inventory + Warranty; report with recognized (green) / unrecognized (red) columns; report persists via `Modal` until closed.
- [x] **2026-11-01:** Universal smart search across all device fields (flattened key/value text including nested objects); caret preserved across re-renders (no reversed typing).
- [x] **2026-11-01:** Sticky table UI: checkbox column frozen horizontally, column header frozen vertically, search bar sticky, table wrapper `max-height: 70vh` as scroll container.
- [x] **2026-11-01:** Removed group/compliance dropdowns and "Clear filters" button from inventory — universal search is now the single filter (kept "Duplicates only" checkbox).
- [x] **2026-11-05:** Added SQLite-backed asset checkout/check-in event history, current-custodian/expected-return columns, overdue-return indicators, and per-asset history view. Inventory imports leave custody events unchanged.
- [x] **2026-11-05:** Added API and persistence validation for ordered custody events; extended tests and user documentation.
- [x] **2026-11-05:** Added consistent SQLite snapshot downloads and validated database restore with safety confirmation, atomic replacement, 512 MB upload limit, and application reload.
- [x] **2026-11-05:** Added backup/restore API tests, including full dataset round-trip and invalid-file preservation; updated user docs.
- [x] **2026-11-05:** Fixed shared checkout state caused by placeholder `N/A` Device IDs; serial numbers now define asset identity, and server validation prevents concurrent checkouts for one serial while allowing one person to hold multiple serials.
- [x] **2026-11-05:** Added a derived Users directory and per-user asset list, and server validation preventing one serial from being assigned to multiple Primary users.
- [x] **2026-11-05:** Renamed handover eligibility choices to Deployable / Un-deployable and migrate legacy labels on load while preserving the existing CSV field key.
- [x] **2026-11-05:** Added a persistent Users list with manual entry, CSV import, country/location fields, SQLite API/storage, and inclusion in database backups.
- [x] **2026-11-05:** Checkout now selects staff from Users; imported Primary user email/UPN marks a device checked out, shows its custodian, and disables Checkout.
- [x] **2026-11-05:** Check in is now enabled for devices with a Primary user assignment; checking in clears the Primary user assignment via `/api/checkin-primary-user` and returns the device to available.
- [x] **2026-11-06:** Added a search box to the Users management list, filtering staff by name or email.
- [x] **2026-11-06:** Removed the per-row Delete button from inventory table rows to prevent accidental deletion.
- [ ] Open tasks: none for this requested change; wait for the user's next feature instruction.
- ⛔ **Known blockers / constraints:** single-user local-only app (binds `127.0.0.1:8000`, no authentication or administrative audit log); requires internet for Chart.js and Google Fonts; operational data (CSV/SQLite) is gitignored; no multi-user sync.

## 🧠 Key Decisions & Constraints
- **Zero-config local stack:** Python stdlib + SQLite chosen deliberately → no build step, no dependencies, runs on any Python 3.10+ machine; server binds `127.0.0.1:8000`.
- **SQLite as source of truth:** inventory/warranty/replacement/custody/users data persisted via `PUT /api/{inventory,warranty,replacement-history,checkout-history,users}`; browser cache in `App.store.cache` with write queues; legacy inventory and warranty `localStorage` (`nexit_<key>`) migrated once via `POST /api/bootstrap`.
- **Layout persistence:** `localStorage` key `nexit_inventory_layout` with `{ visible: [...], version: 9 }` (version migration adds custody columns).
- **Sticky behavior:** requires a real scroll container — `position: sticky` does not engage without `overflow` scroll ancestor; solved with `max-height: 70vh` on `.inventory-table-wrap`.
- **Universal search:** client-side substring match over flattened record text (`getDeviceSearchText`); combined with warranty/country/dashboard/device-type/duplicate filters via `getFilteredRows`.
- **Header normalization:** lowercase + strip non-alphanumerics to single spaces (e.g., `Last Check-in` → `last check in`).
- **Serial normalization:** `_serial_key` / `normalizeSerialKey` strip `--N` suffixes and case/whitespace fold for duplicate matching.
- **Custody history:** checkout/check-in events are append-ordered in a dedicated `checkout_history` table and are not stored in inventory rows. A normalized serial is the asset identity; a non-placeholder Device ID is the fallback only when serial is missing. This also re-identifies older events using their stored serial values. Server validation rejects a second active checkout for the same serial but permits multiple serials per staff member.
- **User-to-asset view:** Users are derived from imported Primary user fields and active checkout custodians; a user's profile groups multiple serial-numbered assets, and active custody takes precedence until check-in. Inventory writes reject conflicting Primary user assignments for one normalized serial.
- **Managed users:** `users` is a separate SQLite dataset with `User ID`, `Name`, `Email`, `Country`, and `Location`; `PUT /api/users` replaces the saved directory after validating required names, unique IDs, and unique email addresses. CSV import merges matching people by email or by name when email is blank. Checkout choices combine managed users with users inferred from inventory and existing checkout history.
- **Primary-user checkout rule:** A non-empty `Primary user email address` or `Primary user UPN` is treated as an existing assignment in the inventory UI: status is Checked out, the primary user is shown as custodian, and Checkout is disabled. A primary-user assignment is not a custody-history event; Check in is enabled for assigned assets and clears the Primary user assignment when no checkout event is active. Clear the primary-user fields in Edit (or check the device in first) to make that asset available to check out. The Primary user email serves as the current custodian, using the display name as the label when one is recorded.
- **Deployment labels:** UI values are Deployable / Un-deployable. Legacy handover labels are normalized and persisted on module load; the established `Handover Eligibility` field name remains for CSV compatibility.
- **Database backups:** `GET /api/backup` uses SQLite's online backup API to create a consistent snapshot including saved users; `POST /api/restore` validates SQLite integrity and NexIT tables before atomically replacing the current database. User must store downloaded backups separately; backup is not automatic.

## 🔌 Interfaces & Contracts
- **HTTP API:** `GET /api/health`; `GET /api/backup` (SQLite attachment); `POST /api/restore` (SQLite file upload, max 512 MB); `POST /api/bootstrap`; `GET /api/dashboard`; `GET /api/dashboard/records`; `PUT /api/inventory`; `PUT /api/warranty`; `PUT /api/replacement-history`; `PUT /api/checkout-history`; `PUT /api/users`; anything else → `404 {"error": ...}`.
- **Query params:** `/api/dashboard` accepts `country, department, os, status, lifecycle, warrantyStatus, plannedAction, model`; `/api/dashboard/records` adds `metric` (e.g. `duplicateSerialNumbers`, `activeAssets`, `expiredWarranty`, `warrantyExpiring90Days`, `missingWarranty`, `win10`, `win11`, `unknownOs`, `staleActiveDevices`, `missingPrimaryUser`, `inService`, `migrationRequired`, `refreshReplace`, `decommissioned`, `stock`, `retired`, `inactiveAssets`, `totalAssets`).
- **Response shapes:** health → `{"status","database"}`; bootstrap POST → inventory, warranty, replacementHistory, checkoutHistory, users, migrated; bootstrap GET → `{"filterOptions":{...},"sourceRecordCount","replacementRecordCount","checkoutEventCount"}`; dashboard → `{"refreshedAt","sourceRecordCount","distinctAssetCount","filters","kpis","charts"}`; records → `{"recordIndexes":[int]}`; PUT → `{"saved":count}`.
- **Module contract:** `App.registerModule(name, module)`; modules expose `render(container, country?)` plus optional `destroy?`, `onCountryChange?(country)`, `getDeviceType?()`, `getDeviceTypeLabel?()`, `refreshDeviceTypeNavigation?()`, `selectDeviceType?(t)`, `showDashboardResults?(indexes,label)`, etc.
- **Data shapes:** inventory records are flat mixed-case key objects (e.g. `Device name`, `Serial number`, `IntuneGroup.GroupName`, `Manufacturer`, `Model`, `Compliance`, `Warranty Start Date`, `Warranty End Date`, `Warranty Match Status`, `Duplicate Serial`, `Last check-in`, `Enrollment date`, `Total storage`, `Total storage (GB)`, `Primary user email address`, `Primary user UPN`, `Primary user display name`, `Azure AD registered`, `Ownership`, `Location`, `Management IP`, `Firmware version`, `UPS Capacity (VA)`, `Battery replacement date`, `IntuneGroup.*`, `WindowsVersion`, `OS`, `OS version`, computed `Asset type`, `Country`); managed user records store `User ID`, `Name`, `Email`, `Country`, and `Location`; replacement records use `REPLACEMENT_COLUMNS`; checkout events store `Event ID`, `Asset key`, `Device ID`, `Device name`, `Serial number`, `Event type`, `Event date`, `Staff name`, `Staff email`, `Staff country`, `Staff location`, `Expected return date`, and `Notes`.

## 🔄 Update Protocol
When modifying this codebase, future agents should:
1. Update the relevant row in **📁 Current File State** (Purpose / Key Exports / Functions / Status).
2. Check off completed tasks and add new decisions to **🚧 Active Tasks & Blockers** / **🧠 Key Decisions**.
3. Add new architectural decisions to **🧠 Key Decisions & Constraints**.
4. Update **🔌 Interfaces & Contracts** when endpoints, module contracts, or data shapes change.
5. Bump the stylesheet/script cache versions (`main.css?v=…`, `app.js?v=…`, etc.) in `index.html` after CSS/JS edits.
6. Run `python3 -m unittest -v` before committing; validate JS syntax with Python `quickjs` when Node.js is unavailable.
7. Bump **Last Updated** at the top of this file.
