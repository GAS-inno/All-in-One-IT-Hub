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

Open **Dashboard** for a business overview of the same inventory shown in **Inventory**. The headline cards summarize total, deployed, available-to-deploy, and inactive-over-90-days devices. The attention section highlights warranty dates, missing assignments, duplicate serials, and archived assets. Charts break down inventory status, online status, warranty outlook, device models, fleet share by country, and online health by country. Filter by country, category, inventory status, online status, operating system, manufacturer, or warranty; all counts and charts update together. Select a metric to open its matching devices in Inventory.

### Inventory

1. Open **Inventory**.
2. Select **Import CSV** and choose an Intune device export. `Device name` and `Serial number` are required; `Device ID` is optional.
3. If the import finds serial duplicates, choose whether to merge them with existing records or keep them separately. Kept duplicates are given a suffix and highlighted.
4. Use the universal search box to search across all device fields — device name, user, serial, group, warranty, status, and more. The **Duplicates only** checkbox filters to duplicated serials. Open **Columns** to search fields, show or hide them, and set their order; **Reset defaults** restores the default layout.
5. Select a device checkbox to highlight its entire row. Use **Select all visible**, **Edit selected**, or **Delete selected** for bulk actions.
6. Use **+ Add device** or **Edit** to manage individual records. The per-row **Delete** action has been removed from inventory table rows to prevent accidental deletions. The per-row **Edit** action has been removed as well; select devices with checkboxes and use **Edit selected** for bulk updates. Inventory changes are saved to SQLite. **Undo** and **Redo** are available for recent inventory changes in the current page session. Use bulk **Delete selected** with care for selected devices.
7. Select **Export CSV** and choose **Active columns** (the columns currently visible) or **All columns**. The active search and filters determine which device rows are exported.

Forms for adding or editing devices and users stay open when you click outside the dialog. Close them with the **×** button, **Cancel**, or the form's apply/save action.

When merging an import, NexIT matches each row to the existing device by normalized serial number. A populated CSV value updates that field; blank cells and `Null`/`undefined` values leave the saved field unchanged.

The inventory supports Laptop, Firewall, UPS, AccessPoint, and Switch device types in the same SQLite database. Use the device-type links below **Inventory** to filter the list; a link is shown only while at least one device of that type exists. Use **Inventory** to see all types. Existing records without an asset type remain laptops. Use **+ Add device** to choose a type and enter common details such as serial number, manufacturer, model, and location, plus network or UPS fields where relevant. CSV imports can include an `Asset type` column, or a `Device type` column containing one of the supported categories; without one they are treated as the currently selected type, or Laptop when viewing all inventory.

The sidebar **Download CSV Template** item opens a template-samples modal with a preview of each template (laptop inventory and user list) before downloading it.

**Fixed Asset Number** is optional. Enter the Finance/SAP book asset number when known. Hover over the column heading or field label for guidance; if the number is unavailable, check with the Finance asset manager. The value is retained in SQLite and included in inventory CSV imports and exports.

**Device Online Status** is based on the last check-in: **Inactive>90days** if it was over 90 days ago, **Active** if it was within 90 days, and **Unknown** if the date is empty or invalid. Admins can set an explicit status in the device edit form; CSV imports ignore this field. **Age** shows the warranty span in the format `5y 1m` (derived from the warranty start and end dates).

Warranty start and end dates use `dd-MMM-yyyy` in both the inventory table and edit forms. **Age** in **Edit selected** mirrors the value calculated for the inventory table and is read-only.

The inventory table keeps the header, search box, and checkbox column visible while you scroll, so the displayed columns and records remain easy to track. The device type column is labeled **Category**, and the Intune group name column is labeled **INTUNE.GROUPNAME**. Custody Status, Current Custodian, and Warranty Match Status are not shown as inventory columns; checkout and check-in details remain available through **History**.

The inventory includes OS Version, Azure AD registered, JoinType, Enrollment date, and Managed by. The Management IP field is displayed as **Device IP**; older records using Management IP continue to display under the new name.

Replacement fields shown in the table are derived from the separate replacement history and are not written into the source inventory records or inventory CSV export.

In **Edit selected**, Replacement Status uses **Not replaced**, **Replaced**, **Pending replacement**, or **In progress**. Staff Member Lifecycle Status uses **Active**, **Leaver**, **Contractor**, or **Unknown**. Existing values outside these lists remain selectable with a **legacy** marker until changed.

Use **Backup Database** to download a consistent SQLite snapshot containing inventory, warranty, replacement, checkout/check-in, and Users data. Choose **Restore Database** and select a NexIT `.db` backup to replace the current database; NexIT validates the file before restoring and reloads the app afterward. Restore replaces all current data, so create and keep a backup before restoring. Database backup uploads are limited to 512 MB.

### Users and assigned assets

Open **Users** to maintain the staff directory used by asset checkout. Choose **+ Add user** to enter a name, optional email, Account Active status, country, and location, or **Import users CSV** to load multiple users. CSV requires a `Name`, `Full Name`, `User Name`, or `Staff Name` column; `Email`, `Country`, and `Location` are optional. Imports merge by email (or by name when email is blank) and update matching users. The list is stored in SQLite and is included in database backups.

Each Users record has an **Account Active** value of **YES** or **NO**, which can be set when adding or editing users. CSV imports classify addresses whose local part begins with a 24-character or longer hexadecimal prefix as **NO** (for example, an exported object ID concatenated with a username); other imported email formats are marked **YES**. Users inferred from inventory primary-user fields use the same email rule. This is a format-based classification, not a live directory account check.

The directory also includes users inferred from imported Primary user fields and active checkout records, so existing inventory users remain available for checkout selection. User profiles list each assigned serial number once; one user may have multiple assets. A current checkout takes precedence over the imported Primary user in the directory until the asset is checked in.

The Users list includes a search box that filters the staff directory by name or email address. The filter combines with the country filter and updates the list of users shown. Use the **Assigned assets (count)** filter to show only users with a specific number of assigned assets. The per-row **Delete** action has been removed; use **Delete selected** with row checkboxes for bulk deletion. Deleting a user clears the Primary user assignment on their assigned devices. Adding a user with an email that already exists merges into the existing user record instead of creating a duplicate. The Users table also supports **Edit selected** with row checkboxes; selecting one or more users and choosing **Edit selected** opens an edit form for their name, email, Account Active status, country, and location.

When adding or editing a laptop, use the **Primary user** field to search managed users by name or email. Selecting a match fills in the email; entering a new name and optional email adds that person to the Users directory when the laptop is saved.

### Asset status labels

Each asset has a **Status** label with one of four characteristics: **Deployable**, **Undeployable**, **Pending**, or **Archived**. Manage the label names and characteristics with **Manage status labels** in Inventory. Deployable assets can be checked out; Undeployable and Pending assets cannot. Archived assets are hidden from the normal inventory and appear in **Archived view**. Starter labels are Ready to Deploy, Deployed, Awaiting Re-Imaging, In Repair, Decommissioned, and Archived. Decommissioned is an Archived label. Status labels are stored in SQLite and included in database backups.

The **Status** column shows **Deployed** whenever an asset with a Deployable label is assigned to a user, including a Primary user assignment or active checkout. Its configured status label stays intact; when the asset is no longer assigned, Status returns to that label.

### Asset checkout and check-in

Use **Checkout** on an inventory row and select the receiving staff member from the Users list. Their name, email, country, and location are taken from the directory; record the checkout date and time, optional expected return date, and notes. Use **Check in** when it is returned; the return event records who checked it in and when, including the check-in time. The checkout and check-in forms use the standard styled form controls for a clean, consistent dialog layout. **History** shows all handovers for that asset, newest first. Action buttons show **Checked out** while assigned and **Checked in** after a recorded return. Overdue returns are highlighted and counted above the inventory.

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
3. Choose the staff member by searching either name or email. The form links both fields and loads that staff member's active assigned devices. If there are several, select the old device explicitly. If there are none, leave **Old Device** blank for a new assignment.
4. You can also search for an old device directly. The form fills its linked staff details; entering a serial without selecting a result is not accepted. The server checks that the old device exists, is active, and belongs to the selected staff member.
5. Search for the new replacement device in available inventory. The result shows serial, model, country, and fixed asset number. On save, the server rechecks availability and assigns the device to the selected staff member in the same SQLite transaction as the history record.
6. Enter the date, reason, old-device condition, lifecycle status, and optional remarks. The app warns about a previously replaced old serial or a repeated old/new serial pair. View, edit, or delete records from the history table.
7. CSV import offers **Merge** (add new IDs without overwriting existing records) or **Replace** (replace the loaded history after confirmation). Use **Export Replacement History CSV** to transfer history or **Download Empty Template** for the expected headers.

The Inventory view derives replacement details from replacement history by matching old-device serial numbers. Replacement history is separate from the current device record; removing a device from a later inventory import does not remove its replacement event.

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

`Device ID`, `Asset type`, and `Fixed Asset Number` are optional. Add an optional `Asset type` column (recommended) or a `Device type` column containing one of `Laptop`, `Firewall`, `UPS`, `AccessPoint`, or `Switch` to classify each imported record. Other columns, including `Fixed Asset Number`, are retained where provided. The `Total storage` CSV header is accepted as an import source and converted from bytes to `Total storage (GB)`; only the GB field is shown and exported.

Import first opens a column review listing recognized and unrecognized headers. Recognized columns are selected by default; uncheck optional columns you do not want to import. **Serial number** is required and remains selected. If you leave the selection unchanged, all recognized data is imported. No data is saved until you choose **Proceed to import**. If duplicate serial numbers are found, a second dialog lets you merge into the existing device or keep separate devices with `-1`, `-2`, and later suffixes. Cancel either dialog to stop without importing. After saving, a report summarizes the result.

Headers are matched case-insensitively and tolerate punctuation and spacing differences. Common Intune headers include `Device ID`, `Device name`, `OS`, `OS version`, `Serial number`, `Primary user UPN`, `Intune GroupName`, `Total storage (GB)`, `Last Check-In`, `LOB`, `Model`, `Group Tag`, `Manufacturer`, and the warranty date fields.

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
9. Lifecycle Status
10. Remarks

The app validates these fields during import and supports commas, quotes, and newlines in remarks. CSV import/export is for transfer; SQLite is the app's working store. The add/edit form behavior is described under **Device Replacement History** above.

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
