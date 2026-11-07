# Project Brief

> Last updated: 2026-11-07

## Purpose

NexIT is a local IT asset management app for inventory, warranty, staff assignments, checkout/check-in, and device replacement history. It is designed for one local operator and stores data in SQLite.

## Architecture

- Frontend: vanilla JavaScript, HTML, and CSS; no build step.
- Backend: Python standard library (`http.server`, `sqlite3`); no external Python packages.
- Storage: SQLite database at the platform's local application-data directory. `server.py` prints the active path and `/api/health` reports it.
- Dashboard charts use Chart.js from jsDelivr; internet access is needed for those charts.
- Start from the project directory with `python3 server.py` (Linux/macOS) or `py server.py` (Windows). The server binds to `127.0.0.1:8000`.

## Data ownership and rules

- `inventory_devices` is the current device record. Inventory imports merge by normalized serial number and preserve saved values for blank or null-like cells.
- `warranty_records` stores warranty source data matched to inventory by serial.
- `users` is the managed staff directory. User IDs are stable keys; names and emails are canonicalized from this table when replacement records are saved.
- `checkout_history` stores ordered checkout/check-in events separately from device records. Normalized serial is the asset key; a non-placeholder Device ID is used only when serial is unavailable.
- `replacement_history` stores replacement events separately from current inventory. Inventory replacement fields are derived from those events.
- `asset_status_labels` stores the configured device status and its characteristic (`Deployable`, `Undeployable`, `Pending`, or `Archived`). The displayed status is derived from the configured label and current assignment. Assigned deployable devices display as `Deployed`.
- `asset_field_options` stores canonical and legacy values for device-level Replacement Status and Staff Member Lifecycle Status. Canonical values are `Not replaced`, `Replaced`, `Pending replacement`, `In progress` and `Active`, `Leaver`, `Contractor`, `Unknown`, respectively. Lifecycle status belongs to each device.
- Raw Intune `Total storage` may be imported as bytes and converted to `Total storage (GB)`. Only the GB field is retained and presented.

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
| `index.html` | Page shell, navigation, and script loading |
| `app.js` | App state, API-backed store, navigation, dialogs, shared helpers |
| `inventory.js` | Inventory UI, import/export, device edits, status labels, checkout, backup/restore |
| `users.js` | Staff directory and per-user assigned assets |
| `replacement-history.js` | Replacement history UI, linked autocomplete, CSV transfer |
| `dashboard.js` | Dashboard filters, charts, and inventory drill-through |
| `server.py` | HTTP API, SQLite persistence, validations, backup/restore |
| `dashboard_metrics.py` | Dashboard calculations and filtering |
| `main.css` | Shared styles |

## API areas

- `GET /api/bootstrap` and `POST /api/bootstrap`: load app data and one-time legacy browser data migration.
- `GET /api/users/search`: search managed users.
- `GET /api/inventory/available-replacements`: search devices eligible for handout.
- `GET /api/inventory/assigned-devices`: search active assigned devices, optionally filtered by user ID.
- `POST /api/replacement-history/save`: validate and save a replacement event and its new device assignment atomically.
- `GET /api/dashboard` and `/api/dashboard/records`: dashboard metrics and drill-through rows.
- Dataset APIs: `PUT /api/inventory`, `/api/warranty`, `/api/replacement-history`, `/api/checkout-history`, `/api/users`, and `/api/status-labels`.
- `GET /api/backup` and `POST /api/restore`: consistent SQLite backup and validated restore.

## Maintenance notes

- Keep operational CSV files, exports, and SQLite databases out of version control.
- The app has no authentication, roles, audit log, or multi-user synchronization. Keep it on the local machine; do not expose the server to a shared network without adding appropriate access controls and changing the deployment design.
- Run the Python test suite with `python3 -m unittest -v` (Windows: `py -m unittest -v`).
- When changing UI scripts or styles, update their cache version in `index.html`. Update this brief when a durable data rule, API contract, or major module responsibility changes. Keep user-facing setup and workflow instructions in `README.md`.
