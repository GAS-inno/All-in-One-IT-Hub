# Project Brief

> Last updated: 2026-11-12

## Purpose

NexIT is a local IT asset management app for inventory, warranty, staff assignments, checkout/check-in, and device replacement history. It is designed for one local operator and stores data in SQLite.

## Architecture

- Frontend: vanilla JavaScript, HTML, and CSS; no build step. UI typography uses Inter loaded from Google Fonts.
- Theming: CSS custom properties on `:root` with `[data-theme="dark"]` overrides (light/dark), `color-scheme` for native controls/scrollbars, a pre-paint inline `<head>` script in `index.html` to avoid flash, global theme toggle next to **More tools** (persisted in `localStorage`, respects `prefers-color-scheme` on first load), and `nexit:themechange` events so dashboard charts re-read theme tokens.
- Backend: Python standard library (`http.server`, `sqlite3`); no external Python packages.
- Storage: SQLite database at the platform's local application-data directory. `server.py` prints the active path and `/api/health` reports it.
- Dashboard charts use Chart.js from jsDelivr; internet access is needed for those charts. Chart colors/options are derived from theme CSS variables and refreshed on theme toggle.
- Global app shell: **More tools** in the topbar is persistent across pages with fixed actions **Backup Database, Restore Database, Clean Database, Export CSV, Import CSV**; Export/Import use source-aware choosers (Asset Inventory/User list, active/all or existing import flow) and reuse module handlers.
- Start from the project directory with `python3 server.py` (Linux/macOS) or `py server.py` (Windows). The server binds to `127.0.0.1:8000` by default; `NEXIT_HOST` and `NEXIT_PORT` can override the bind for trusted private-network access (e.g. Tailscale). NexIT has no authentication.

## Data ownership and rules

- `inventory_devices` is the current device record. Inventory imports merge by normalized serial number and preserve saved values for blank or null-like cells.
- `warranty_records` stores warranty source data matched to inventory by serial.
- `users` is the managed staff directory. User IDs are stable keys; names and emails are canonicalized from this table when replacement records are saved. User IDs are imported from a `User ID` CSV column when present; otherwise a generated ID is assigned.
- User records include an `Account Active` value (`YES` or `NO`). A user CSV may supply it directly; when blank or absent, the value defaults to `YES`. Users can set this value in the add and edit forms. There is no automatic email-format classification.
- User records include a `Staff Type` (`External Staff`, `Internal Staff`, or unset) and a `staff_type_source` (`auto` or `manual`). Auto-detection reads the user `Name` for a standalone `EXT` token inside parentheses and defaults to `Internal Staff`; vendor text after the marker is surfaced unnormalized. A source of `manual` permanently overrides auto-detection until `POST /api/users/staff-type/reset` clears it back to `auto` and recomputes. Re-imports preserve manual overrides. The one-time migration `migrations/migrate_add_staff_type.py` backfills both fields with source `auto`. Staff Type can be set manually through the add-user form and the bulk **Edit selected** flow; saving a chosen value marks the override `manual`.
- A device is attached to a directory user only when the asset's Primary user UPN/email matches that user's Email (case-insensitive). Display names come from the user record or the asset's Primary user display name, never from an email address.
- The Users list summary reports the filtered user count, `YES` and `NO` account totals, and assigned serial count.
- `checkout_history` stores ordered checkout/check-in events separately from device records. Normalized serial is the asset key; a non-placeholder Device ID is used only when serial is unavailable.
- Inventory primary-user, checkout, and check-in forms search staff by name or email and fill the linked identity field on selection. Checking in an asset assigned only through its Primary user fields clears that assignment and records a check-in event in `checkout_history`.
- The Add/Edit device form follows a Snipe-IT-style structure: core asset identity and status first, assignment/location next, with technical and warranty details in expandable sections.
- Country is editable in the device form and takes precedence over the country inferred from the device-name prefix; the country filter uses the saved value, with prefix inference as a fallback.
- Inventory JSON has orthogonal `deployment_status`, `condition`, and `is_archived` fields. `migrations/migrate_inventory_status_json.py` maps status labels and assignment/check-in evidence, skips pre-migrated records, writes per-record `migration_log.json`, and stores unknown legacy labels in `migration_errors`.
- Deployment status, condition, disposition method, and badge colours are canonical lists in `constants.py` and `constants.js`. Stored condition values are `Good`, `Needs Repair`, `End of Life`, `Unknown`; display labels are `Working`, `Faulty`, `Beyond Economic Repair`, `Not Assessed` (see `CONDITION_LABELS`). `_validate_device_status` rejects unknown stored values and a non-boolean `is_archived`, requires condition `End of Life` when deployment status is `Disposed`, and allows `disposition_method` only for `Retired`/`Disposed` records with a known method. Keep the two constants files in sync.
- The Inventory **Filter** drawer (Duplicate Only, Show Archived, Deployment Status, Hardware Health) and its open/closed state are browser-local presentation preferences; they are not stored in SQLite.
- `replacement_history` stores replacement events separately from current inventory. Inventory replacement fields are derived from those events.
- `asset_status_labels` stores the configured device status and its characteristic (`Deployable`, `Undeployable`, `Pending`, or `Archived`). The displayed status is derived from the configured label and current assignment. Assigned deployable devices display as `Deployed`.
- `asset_field_options` stores canonical and legacy values for device-level Replacement Status and Staff Employment Status. Canonical values are `Not replaced`, `Replaced`, `Pending replacement`, `In progress` and `Active`, `Leaver`, `Contractor`, `Unknown`, respectively. Employment status belongs to each device.
- Raw Intune `Total storage` may be imported as bytes and converted to `Total storage (GB)`. Only the GB field is retained and presented.
- **Intune GroupName standardization:** the canonical stored/UI/API key is `Intune GroupName` (space). Legacy aliases `IntuneGroup.GroupName`, `Intune.GroupName`, and `IntuneGroup GroupName` are read/migrated for compatibility; the extracted DB column remains `group_name` (kept in sync). Intune Group Tag remains supported (`Intune Group Tag`, with legacy dotted/tag variants normalized).
- **Removed Intune fields (Part 2):** `Intune Group Device Name`/`IntuneGroup.DeviceName`, `Intune SerialNumber`/`IntuneGroup.SerialNumber`, `Intune Group Model`/`IntuneGroup.Model`, and `Intune Group Manufacturer`/`IntuneGroup.Manufacturer` are removed from schema/UI/templates/import/export. These fields were JSON-only (no dedicated columns); imports may flag/ignore legacy headers without crashing, and canonical writes drop them. No in-repo Intune sync writer was present; keep a backup before destructive/cleanup operations.
- **Date standard:** Purchase Date, Warranty Start Date, Warranty End Date, and Disposal Date are stored as ISO `YYYY-MM-DD` (or NULL/blank where empty), displayed/exported as `DD-MMM-YYYY`, and accepted on import as `DD-MMM-YYYY`, `YYYY-MM-DD`, or Excel serials (1899-12-30 epoch). Ambiguous slash dates are rejected; sentinel `00-Jan-1900` is treated as empty. Existing Excel-serial/sentinel warranty data cleanup is a separate, approval-gated migration/report item (row counts must be gathered from the real DB; not executed here).
- **Purchase/Disposal dates (Part 1, Option A):** `inventory_devices` includes nullable `purchase_date` and `disposal_date` (TEXT) near warranty columns via safe table recreate migration; values are also carried in `data_json` as ISO.
- **Templates:** Asset Inventory and User DB CSV templates are generated programmatically from a shared source of truth aligned with importer definitions, UTF-8 with BOM, one example row (DD-MMM-YYYY, YES/NO), and Excel `Data → From Text/CSV` / Text-column guidance. Asset template includes Purchase/Disposal Date and excludes computed/system-managed columns (Age, Device Online Status, Warranty Match Status, Duplicate Serial, UI actions, internal IDs/positions) and the four removed Intune fields. User template headers are `USER ID, NAME, STAFF TYPE, EMAIL, ACCOUNT ACTIVE, COUNTRY, LOCATION` (excludes derived `ASSIGNED ASSETS`).

## Replacement record behavior

- Staff Name and Staff Email search the Users directory. Picking either links the values and loads that person's active assigned devices.
- Old Device search covers active assigned inventory (`Deployed`, `In Use`, `Active`, `Checked out`, `Assigned`, `In Service`, or a current checkout). Search can start from the staff member or the device.
- Multiple active devices require an explicit old-device choice. If the staff member has no active assigned device, Old Device may be blank for a new assignment.
- Directly typed old serials must be selected from results. On save, the server verifies that a non-empty old serial exists, is active, and belongs to the selected staff member. It also prevents a blank old serial when that staff member still has an active assigned device.
- The new replacement device must be available for handout. The server rechecks its eligibility and updates its assignment in the same SQLite transaction as the replacement event.
- Staff and device autocomplete requests are debounced by 250 ms. Manual edits are preserved and do not silently get replaced by edits to linked fields.

## Main files

| File | Responsibility |
|---|---|
| `index.html` | Page shell, navigation, global More tools/theme toggle, pre-paint theme bootstrap, and script loading |
| `app.js` | App state, API-backed store, navigation, dialogs, shared helpers, global More tools routing, theme persistence/toggle |
| `constants.js`, `constants.py` | Shared deployment status, condition, disposition-method, and badge-colour lists (kept in sync) |
| `inventory.js` | Inventory UI, filter drawer, import/export flows, structured device forms, staff autocomplete, checkout/check-in history, status labels, reusable backup/restore/clean handlers |
| `users.js` | Staff directory, user CSV import/export flows, and per-user assigned assets |
| `replacement-history.js` | Replacement history UI, linked autocomplete, CSV transfer |
| `dashboard.js` | Dashboard filters, charts, inventory drill-through; derives chart colors/options from theme tokens and refreshes on `nexit:themechange` |
| `server.py` | HTTP API, SQLite persistence, status-field validations, backup/restore |
| `dashboard_metrics.py` | Dashboard calculations and filtering |
| `migrations/migrate_inventory_status_json.py` | One-time, idempotent status/condition/archive migration and logging |
| `test_server.py`, `test_dashboard_metrics.py`, `test_status_validation.py` | Automated tests |
| `main.css` | Shared styles and theme tokens (`:root` light/dark variables, `color-scheme`, component/surface styling) |

## API areas

- `GET /api/bootstrap` and `POST /api/bootstrap`: load app data and one-time legacy browser data migration.
- `GET /api/users/search`: search managed users.
- `GET /api/inventory/available-replacements`: search devices eligible for handout.
- `GET /api/inventory/assigned-devices`: search active assigned devices, optionally filtered by user ID.
- `POST /api/checkin-primary-user`: clear a Primary user assignment and append a check-in event.
- `GET /api/field-options` and `POST /api/field-options`: read and add canonical/legacy field values.
- `GET /api/health`: report the active SQLite database path and health.
- `POST /api/replacement-history/save`: validate and save a replacement event and its new device assignment atomically.
- `GET /api/dashboard` and `/api/dashboard/records`: dashboard metrics and drill-through rows.
- Dataset APIs: `PUT /api/inventory` (validates deployment status, condition, disposition method, and `is_archived`), `/api/warranty`, `/api/replacement-history`, `/api/checkout-history`, `/api/users`, `/api/status-labels`, `POST /api/users/staff-type` (set a single user's staff type as a manual override with server-side validation and commit), and `POST /api/users/staff-type/reset` (clear a manual staff-type override and recompute from the user name).
- `GET /api/backup` and `POST /api/restore`: consistent SQLite backup and validated restore.

## Maintenance notes

- Keep operational CSV files, exports, and SQLite databases out of version control.
- Keep `constants.js` and `constants.py` in sync whenever deployment status, condition, disposition method, or badge colours change.
- The app has no authentication, roles, audit log, or multi-user synchronization. Keep it on the local machine by default. `NEXIT_HOST`/`NEXIT_PORT` may override the bind for trusted private-network access (for example, Tailscale), but do not expose the server to the internet or untrusted networks without adding appropriate access controls and changing the deployment design.
- UI/theming: preserve token-driven styling (`main.css` `:root` + `[data-theme="dark"]`, `color-scheme`) and theme-aware chart rendering (`dashboard.js` reads CSS vars and refreshes on `nexit:themechange`) to avoid stale colors/flashes; keep global shell controls (More tools, theme toggle) in `index.html`/`app.js`.
- Run the Python test suite with `python3 -m unittest -v` (Windows: `py -m unittest -v`).
- When changing UI scripts or styles, update their cache version in `index.html`. Update this brief when a durable data rule, API contract, shell behavior, or major module responsibility changes. Keep user-facing setup and workflow instructions in `README.md`.
