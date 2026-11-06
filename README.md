# All-in-One IT Hub

A local IT asset inventory and operations dashboard built with HTML, CSS, vanilla JavaScript, Python's standard library, and SQLite. It supports Intune-style inventory CSV import, warranty matching, user-to-asset views, durable asset checkout/check-in history, device replacements, filtering, analytics, and CSV exports.

> **Local-use application:** The server listens on `127.0.0.1` and SQLite is designed for one local app instance/user at a time. This is not a hosted, multi-user service. Do not expose it to the internet or a shared network without adding authentication, authorization, and an appropriate shared database/API.

## Requirements

- Python 3.10 or newer (Python 3.12 recommended)
- A current web browser
- Internet access for the externally hosted Chart.js dashboard charts; the rest of the app runs locally
- No pip packages, Node.js, or separate database server are required

The app uses Python's built-in `http.server` and `sqlite3` modules.

## Quick start

### Linux

1. Install Python 3.10 or newer if it is not already installed.
2. Open a terminal in the folder containing `server.py` and `index.html`.
3. Start the app:

   ```sh
   python3 server.py
   ```

   Or run `sh start-linux.sh`.

4. Open [http://localhost:8000](http://localhost:8000).
5. Keep the terminal open while using the app. Press `Ctrl+C` in that terminal to stop it.

### Windows

1. Install Python 3.10 or newer if it is not already installed.
2. Open the project folder in File Explorer, enter `powershell` in the address bar, and press Enter.
3. Start the app:

   ```powershell
   py server.py
   ```

   If `py` is unavailable, try `python server.py` or double-click `start-windows.bat`.

4. Open [http://localhost:8000](http://localhost:8000).
5. Keep the terminal open while using the app. Press `Ctrl+C` there to stop it.

Do not use `python -m http.server` as the normal startup method; the app needs its own SQLite API as well as static file serving. If port 8000 is already in use, stop the other app using that port before starting this one.

## First run and local data

The server automatically creates `nexit-assets.db` in the operating system's local application-data directory. On first startup, if the database is empty, the app can copy legacy `nexit_inventory` and `nexit_warranty` browser data into SQLite. The original browser values are not deleted.

Database location:

- Linux: `$XDG_DATA_HOME/NexIT-Asset-Inventory/nexit-assets.db`, or `~/.local/share/NexIT-Asset-Inventory/nexit-assets.db`
- Windows: `%LOCALAPPDATA%\NexIT-Asset-Inventory\nexit-assets.db`
- macOS: `~/Library/Application Support/NexIT-Asset-Inventory/nexit-assets.db`

The server prints the active database path when it starts. You can also check `http://localhost:8000/api/health`.

The project intentionally does not include device, warranty, or replacement records. Import your own files after starting the app. The `.gitignore` excludes the `data/` folder, CSV/Excel files, local databases, Python virtual environments, and generated caches to help prevent accidental publication of operational data.

## How to use the app

### Dashboard

Open **Dashboard** to view inventory metrics, filters, and charts. Use the available country, department, OS, status, lifecycle, warranty, planned-action, and model filters. Selecting a KPI opens the matching inventory records. Use **Refresh** to reload analytics and **Clear filters** to reset the dashboard filters.

### Inventory

1. Open **Inventory**.
2. Select **Import CSV** and choose an Intune device export. The required columns are `Device ID`, `Device name`, and `Serial number`.
3. If the import finds serial duplicates, choose whether to merge them with existing records or keep them separately. Kept duplicates are given a suffix and highlighted.
4. Use the universal search box to search across all device fields — device name, user, serial, group, warranty, status, and more. The **Duplicates only** checkbox filters to duplicated serials. Visible-column checkboxes appear in one horizontal row; use **More columns** to enable hidden columns, or **Reset layout** to restore the defaults.
5. Select a device checkbox to highlight its entire row. Use **Select all visible**, **Edit selected**, or **Delete selected** for bulk actions.
6. Use **+ Add device** or **Edit** to manage individual records. The per-row **Delete** action is not shown for Laptop inventory rows to prevent accidental deletions; bulk **Delete selected** remains available for other device types. Inventory changes are saved to SQLite. **Undo** and **Redo** are available for recent inventory changes in the current page session.
7. Select **Export CSV** to download the inventory currently shown by the active search or filters.

The inventory supports Laptop, Firewall, UPS, AccessPoint, and Switch device types in the same SQLite database. Use the device-type links below **Inventory** to filter the list; a link is shown only while at least one device of that type exists. Use **Inventory** to see all types. Existing records without an asset type remain laptops. Use **+ Add device** to choose a type and enter common details such as serial number, manufacturer, model, and location, plus network or UPS fields where relevant. CSV imports can include an `Asset type` column, or a `Device type` column containing one of the supported categories; without one they are treated as the currently selected type, or Laptop when viewing all inventory.

**Fixed Asset Number** is optional. Enter the Finance/SAP book asset number when known. Hover over the column heading or field label for guidance; if the number is unavailable, check with the Finance asset manager. The value is retained in SQLite and included in inventory CSV imports and exports.

**Active device status** and **Age** are computed columns. A device is shown as **Inactive** when its last check-in is more than 90 days old, otherwise **Active**. **Age** shows the warranty span in the format `5y 1m` (derived from the warranty start and end dates).

The inventory table keeps the header, search box, and checkbox column visible while you scroll, so the displayed columns and records remain easy to track.

Replacement fields shown in the table are derived from the separate replacement history and are not written into the source inventory records or inventory CSV export.

Use **Backup Database** to download a consistent SQLite snapshot containing inventory, warranty, replacement, checkout/check-in, and Users data. Choose **Restore Database** and select a NexIT `.db` backup to replace the current database; NexIT validates the file before restoring and reloads the app afterward. Restore replaces all current data, so create and keep a backup before restoring. Database backup uploads are limited to 512 MB.

### Users and assigned assets

Open **Users** to maintain the staff directory used by asset checkout. Choose **+ Add user** to enter a name, optional email, country, and location, or **Import users CSV** to load multiple users. CSV requires a `Name`, `Full Name`, `User Name`, or `Staff Name` column; `Email`, `Country`, and `Location` are optional. Imports merge by email (or by name when email is blank) and update matching users. The list is stored in SQLite and is included in database backups.

The directory also includes users inferred from imported Primary user fields and active checkout records, so existing inventory users remain available for checkout selection. User profiles list each assigned serial number once; one user may have multiple assets. A current checkout takes precedence over the imported Primary user in the directory until the asset is checked in.

The Users list includes a search box that filters the staff directory by name or email address. The filter combines with the country filter and updates the list of users shown.

### Asset checkout and check-in

Use **Checkout** on an inventory row and select the receiving staff member from the Users list. Their name, email, country, and location are taken from the directory; record the checkout date, optional expected return date, and notes. Use **Check in** when it is returned; the return event records who checked it in and when. **History** shows all handovers for that asset, newest first. The table shows whether an asset is available or checked out, its current custodian, and its expected return date. Overdue returns are highlighted and counted above the inventory.

If an inventory row has a **Primary user email address** (or Primary user UPN), it is treated as already assigned: its status shows **Checked out**, the primary user is shown as custodian, and **Checkout** is disabled. **Check in** is enabled for assigned assets; checking in clears the Primary user assignment and returns the device to available. The Primary user email also serves as the current custodian, using the display name when one is recorded. Clear the primary-user fields in **Edit** before checking out an asset that was assigned this way (or check the device in first).

Checkout and check-in events are stored as a separate, ordered history in SQLite and keyed to the normalized serial number. A valid Device ID is used only when a serial number is unavailable; placeholder IDs such as `N/A` are ignored. This prevents unrelated serials from sharing custody status when an import uses a placeholder Device ID. Re-importing or editing inventory does not replace custody records. Checkout status and events are not written into inventory CSV exports. An event remains in SQLite if its inventory row is later removed; restore the inventory record to see the associated device again. The server rejects a second active checkout for a serial until the current checkout is checked in.

Inventory imports are rejected if the same serial is assigned to different Primary users.

### Warranty matching

1. In **Inventory**, select **Import Warranty**.
2. Choose a CSV with a `Serial number` column. `Warranty Start Date` and `Warranty End Date` are optional.
3. The app matches serial numbers without case or whitespace differences and shows the warranty match status in the inventory.

### Device Replacement History

Replacement history tracks an old device being replaced by a new one while keeping both device records distinct.

1. Open **Device Replacement History**.
2. Add a record manually with **+ Add replacement**, or import an existing history CSV.
3. For old and new devices, use the combined input to select an inventory suggestion or enter a serial number manually. Missing inventory matches are allowed and clearly indicated.
4. Enter the staff, date, reason, old-device condition, handover decision, lifecycle status, and optional remarks. The app warns about a previously replaced old serial or a repeated old/new serial pair.
5. View, edit, or delete records from the history table. CSV import offers **Merge** (add new IDs without overwriting existing records) or **Replace** (replace the loaded history after confirmation).
6. Records are saved automatically in SQLite. Use **Export Replacement History CSV** for a backup or to transfer history. **Download Empty Template** creates a CSV with the expected headers.

The Inventory view derives replacement status, replaced-for staff, replacement date, replacement device serial, replacement count, handover eligibility, and lifecycle status by matching old-device serial numbers. For multiple events on one old serial, history is retained, dates and replacement serials are shown, and the latest event supplies the single current eligibility and lifecycle values. A missing device in a newer Intune import does not delete its replacement event.

If you used an earlier CSV-only version of the app, import your existing replacement-history CSV once after upgrading. The imported data will then be stored in SQLite.

## Screenshots

The screenshots below use synthetic example records only; they do not contain operational inventory or staff data.

### Inventory

The inventory table supports row selection, filtering, configurable columns, and replacement-derived status fields. The selected example row is highlighted across the visible columns.

![Inventory table with a selected synthetic device row](docs/screenshots/inventory-guide.png)

### Device Replacement History

Replacement events can be reviewed and filtered in a separate history table. The table scrolls horizontally to show additional device and lifecycle fields.

![Device replacement history with synthetic example data](docs/screenshots/replacement-history-guide.png)

## CSV formats

### Inventory CSV

Required headers:

- `Device name`
- `Serial number`

`Device ID`, `Asset type`, and `Fixed Asset Number` are optional. Add an optional `Asset type` column (recommended) or a `Device type` column containing one of `Laptop`, `Firewall`, `UPS`, `AccessPoint`, or `Switch` to classify each imported record. Other columns, including `Fixed Asset Number`, are retained where provided. The app derives `Total storage (GB)` from raw `Total storage` when available.

After import, a report lists the recognized columns (which were updated, shown in green) and any unrecognized columns (shown in red). The report stays open until you close it.

### Warranty CSV

Required header: `Serial number`.

Optional headers: `Warranty Start Date`, `Warranty End Date`.

### Users CSV

Required header: `Name`, `Full Name`, `User Name`, or `Staff Name`.

Optional headers: `Email` (or `Email Address` / `Staff Email`), `Country`, and `Location` (or `Office` / `Site`). Rows are merged into the saved Users list by email, or by name when no email is provided.

### Replacement history CSV

The replacement CSV contains only replacement-event fields, not a copy of the inventory:

1. Replacement ID
2. Staff Member Name
3. Staff Email
4. Old Device Serial Number
5. New Device Serial Number
6. Replacement Date
7. Replacement Reason
8. Old Device Condition
9. Handover Eligibility (shown as Deployment Status)
10. Lifecycle Status
11. Remarks

The app validates these fields during import and supports commas, quotes, and newlines in remarks. Deployment Status options are **Deployable**, **Un-deployable**, **Pending Assessment**, and **Recycle**. Older `Eligible for Handover` / `Not Eligible for Handover` records are converted to the new labels and saved to SQLite. CSV import/export is for backup and transfer; SQLite is the app's working store.

## Backup and restore

Use **Backup Database** in Inventory to create an online backup without stopping the app. Copy the downloaded file to secure backup storage that is separate from the computer running NexIT; the browser's Downloads folder is not an off-device backup by itself. To restore, use **Restore Database** and select a trusted NexIT backup. Restore replaces the whole active database and reloads the app. The uploaded file must be a readable NexIT SQLite database and no larger than 512 MB.

Backups contain device and staff information; protect them like the active database. For manual recovery, stop NexIT first, then replace `nexit-assets.db` at the database location listed above with a trusted backup and restart the app. CSV exports remain useful for transferring individual datasets, but do not include all application data and history.

## Run tests

From the project folder:

```sh
python3 -m unittest -v
```

On Windows, use:

```powershell
py -m unittest -v
```

The tests use temporary SQLite databases and do not need your local inventory data.

## Project files

- `index.html` — page structure, navigation, and script loading
- `main.css` — shared styling and responsive layouts
- `app.js` — module navigation, SQLite-backed storage, and shared UI helpers
- `dashboard.js`, `dashboard_metrics.py` — dashboard UI and calculations
- `inventory.js` — inventory, CSV import/export, warranty matching, custody, and backup/restore actions
- `replacement-history.js` — replacement history UI, validation, matching, and CSV transfer
- `server.py` — local HTTP server and SQLite API
- `test_server.py`, `test_dashboard_metrics.py` — automated tests
- `start-linux.sh`, `start-windows.bat` — convenience launchers

## Security and deployment notes

- The app has no sign-in, user roles, multi-user synchronization, or audit log.
- The local server binds to `127.0.0.1`. Do not change this or expose the server to a shared network without first implementing appropriate access controls and a production server/database design.
- Keep the SQLite database, exports, and Intune source files private. Never commit real user, device, warranty, or replacement data to a public repository.
- Database backups are user-initiated downloads; there is no automatic or off-device backup service. Establish a regular backup schedule and store copies separately.
- GitHub Pages cannot run this app by itself because inventory and replacement changes require the Python/SQLite API.
- Chart.js is loaded from jsDelivr, so dashboard charts need internet access.
