"""Focused tests for the SQLite inventory persistence layer and API."""

import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import server as server_module
from server import (
    InventoryRequestHandler,
    ThreadingHTTPServer,
    _detect_staff_type,
    _read_inventory,
    _read_checkout_history,
    _read_replacement_history,
    _read_users,
    _read_warranty,
    _replace_checkout_history,
    _replace_inventory,
    _replace_replacement_history,
    _replace_users,
    _replace_warranty,
    connect_database,
)


class SQLitePersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "test.sqlite3"
        self.connection = connect_database(self.database_path)

    def tearDown(self) -> None:
        self.connection.close()
        self.temp_dir.cleanup()

    def test_inventory_records_round_trip_in_order_with_duplicates(self) -> None:
        devices = [
            {"Device ID": "A", "Device name": "Original", "Serial number": "ABC-1", "Duplicate Serial": False, "Extra": "preserved"},
            {"Device ID": "B", "Device name": "Copy", "Serial number": "ABC-1--1", "Duplicate Serial": True, "Asset type": "firewall"},
        ]
        _replace_inventory(self.connection, devices)
        stored = _read_inventory(self.connection)
        self.assertEqual(len(stored), 2)
        self.assertEqual(stored[0]["Device ID"], "A")
        self.assertEqual(stored[0]["Extra"], "preserved")
        self.assertEqual(stored[0]["Serial number"], "ABC-1")
        self.assertEqual(stored[0]["Intune GroupName"], "")
        self.assertEqual(stored[1]["Device ID"], "B")
        self.assertEqual(stored[1]["Asset type"], "firewall")
        self.assertEqual(stored[1]["Serial number"], "ABC-1--1")
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM inventory_devices").fetchone()[0], 2)
        self.assertEqual(self.connection.execute("SELECT COUNT(DISTINCT normalized_serial) FROM inventory_devices").fetchone()[0], 1)
        self.assertEqual(
            [row[0] for row in self.connection.execute("SELECT device_type FROM inventory_devices ORDER BY position")],
            ["laptop", "firewall"],
        )

    def test_inventory_rejects_unsupported_device_type(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unsupported device type"):
            _replace_inventory(self.connection, [{"Asset type": "router"}])

    def test_inventory_ignores_non_category_source_device_type(self) -> None:
        _replace_inventory(self.connection, [{"Device type": "Windows", "Device name": "Legacy field"}])
        self.assertEqual(
            self.connection.execute("SELECT device_type FROM inventory_devices").fetchone()[0],
            "laptop",
        )

    def test_inventory_allows_multiple_serials_per_primary_user(self) -> None:
        devices = [
            {"Device name": "Laptop 1", "Serial number": "SN-1", "Primary user display name": "Alex User", "Primary user email address": "alex@example.com"},
            {"Device name": "Laptop 2", "Serial number": "SN-2", "Primary user display name": "Alex User", "Primary user email address": "alex@example.com"},
        ]
        _replace_inventory(self.connection, devices)
        stored = _read_inventory(self.connection)
        self.assertEqual(len(stored), 2)
        for expected, actual in zip(devices, stored):
            for key, value in expected.items():
                self.assertEqual(actual[key], value)
            self.assertEqual(actual.get("Intune GroupName"), "")

    def test_inventory_rejects_serial_assigned_to_multiple_primary_users(self) -> None:
        with self.assertRaisesRegex(ValueError, "only one primary user"):
            _replace_inventory(self.connection, [
                {"Device name": "Laptop 1", "Serial number": "SN-1", "Primary user display name": "Alex User", "Primary user email address": "alex@example.com"},
                {"Device name": "Laptop 2", "Serial number": "SN-1--1", "Primary user display name": "Sam User", "Primary user email address": "sam@example.com"},
            ])

    def test_existing_inventory_schema_migrates_without_losing_records(self) -> None:
        self.connection.close()
        legacy_path = Path(self.temp_dir.name) / "legacy.sqlite3"
        with sqlite3.connect(legacy_path) as legacy:
            legacy.execute(
                """CREATE TABLE inventory_devices (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, position INTEGER NOT NULL,
                    device_id TEXT NOT NULL DEFAULT '', device_name TEXT NOT NULL DEFAULT '',
                    serial_number TEXT NOT NULL DEFAULT '', normalized_serial TEXT NOT NULL DEFAULT '',
                    group_name TEXT NOT NULL DEFAULT '', group_tag TEXT NOT NULL DEFAULT '',
                    manufacturer TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
                    compliance TEXT NOT NULL DEFAULT '', warranty_start_date TEXT NOT NULL DEFAULT '',
                    warranty_end_date TEXT NOT NULL DEFAULT '', duplicate_serial INTEGER NOT NULL DEFAULT 0,
                    data_json TEXT NOT NULL)"""
            )
            legacy.execute(
                "INSERT INTO inventory_devices(position, data_json) VALUES(0, ?)",
                ('{"Device name":"Existing laptop"}',),
            )
        migrated = connect_database(legacy_path)
        try:
            row = migrated.execute(
                "SELECT device_type, data_json FROM inventory_devices"
            ).fetchone()
            self.assertEqual(row["device_type"], "laptop")
            self.assertEqual(json.loads(row["data_json"])["Device name"], "Existing laptop")
        finally:
            migrated.close()

    def test_replacing_inventory_removes_old_records(self) -> None:
        _replace_inventory(self.connection, [{"Device name": "Old"}])
        _replace_inventory(self.connection, [{"Device name": "New"}])
        stored = _read_inventory(self.connection)
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored[0]["Device name"], "New")
        self.assertEqual(stored[0]["Intune GroupName"], "")

    def test_warranty_normalizes_serial_and_keeps_latest_record(self) -> None:
        records = [
            {"Serial number": "AB-2", "Warranty End Date": "2026-01-01"},
            {"Serial number": "ab-2", "Warranty End Date": "2027-01-01"},
        ]
        _replace_warranty(self.connection, records)
        self.assertEqual(_read_warranty(self.connection), [records[-1]])
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM warranty_records").fetchone()[0], 1)

    def test_json_column_preserves_unicode_source_fields(self) -> None:
        record = {"Device name": "Café laptop"}
        _replace_inventory(self.connection, [record])
        stored_json = self.connection.execute("SELECT data_json FROM inventory_devices").fetchone()[0]
        self.assertIn("Café", stored_json)
        payload = json.loads(stored_json)
        self.assertEqual(payload["Device name"], "Café laptop")
        self.assertEqual(payload.get("Intune GroupName"), "")

    def test_replacement_history_round_trips_in_order(self) -> None:
        records = [
            {"Replacement ID": "REP-001", "Old Device Serial Number": "OLD-1", "New Device Serial Number": "NEW-1", "Remarks": "First"},
            {"Replacement ID": "REP-002", "Old Device Serial Number": "NEW-1", "New Device Serial Number": "NEW-2", "Remarks": "Second"},
        ]
        _replace_replacement_history(self.connection, records)
        self.assertEqual(_read_replacement_history(self.connection), records)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM replacement_history").fetchone()[0], 2)

    def test_duplicate_replacement_ids_do_not_replace_existing_history(self) -> None:
        existing = [{"Replacement ID": "REP-001", "Old Device Serial Number": "OLD-1"}]
        _replace_replacement_history(self.connection, existing)
        with self.assertRaisesRegex(ValueError, "Duplicate Replacement ID"):
            _replace_replacement_history(self.connection, [
                {"Replacement ID": "REP-002"},
                {"Replacement ID": "rep-002"},
            ])
        self.assertEqual(_read_replacement_history(self.connection), existing)

    def test_checkout_history_round_trips_in_order(self) -> None:
        records = [
            {
                "Event ID": "evt-001", "Asset key": "device:intune-1", "Event type": "checkout",
                "Event date": "2026-11-01", "Staff name": "Alex User", "Expected return date": "2026-11-20",
            },
            {
                "Event ID": "evt-002", "Asset key": "device:intune-1", "Event type": "checkin",
                "Event date": "2026-11-15", "Staff name": "Alex User", "Expected return date": "",
            },
        ]
        _replace_checkout_history(self.connection, records)
        self.assertEqual(_read_checkout_history(self.connection), records)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM checkout_history").fetchone()[0], 2)

    def test_invalid_checkout_history_does_not_replace_saved_events(self) -> None:
        existing = [{
            "Event ID": "evt-001", "Asset key": "device:intune-1", "Event type": "checkout",
            "Event date": "2026-11-01", "Staff name": "Alex User",
        }]
        _replace_checkout_history(self.connection, existing)
        with self.assertRaisesRegex(ValueError, "Duplicate checkout event ID"):
            _replace_checkout_history(self.connection, [
                *existing,
                {**existing[0], "Event ID": "EVT-001"},
            ])
        self.assertEqual(_read_checkout_history(self.connection), existing)
        with self.assertRaisesRegex(ValueError, "Expected return date cannot be before"):
            _replace_checkout_history(self.connection, [{
                **existing[0], "Event ID": "evt-002", "Expected return date": "2026-10-31",
            }])
        self.assertEqual(_read_checkout_history(self.connection), existing)

    def test_checkout_history_allows_one_user_multiple_serials(self) -> None:
        records = [
            {
                "Event ID": "evt-001", "Asset key": "device:n/a", "Device ID": "N/A",
                "Serial number": "SN-1", "Event type": "checkout", "Event date": "2026-11-01",
                "Staff name": "Alex User",
            },
            {
                "Event ID": "evt-002", "Asset key": "device:n/a", "Device ID": "N/A",
                "Serial number": "SN-2", "Event type": "checkout", "Event date": "2026-11-01",
                "Staff name": "Alex User",
            },
        ]
        _replace_checkout_history(self.connection, records)
        self.assertEqual(_read_checkout_history(self.connection), records)

    def test_users_round_trip_with_country_and_location(self) -> None:
        users = [
            {"UserID": "USER-1", "Name": "Alex User", "Email": "alex@example.com", "Country": "Singapore", "Location": "HQ", "staff_type": "Internal Staff", "staff_type_source": "auto"},
            {"UserID": "USER-2", "Name": "Sam User", "Email": "", "Country": "Australia", "Location": "Sydney", "staff_type": "Internal Staff", "staff_type_source": "auto"},
        ]
        _replace_users(self.connection, users)
        self.assertEqual(_read_users(self.connection), users)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM users").fetchone()[0], 2)

    def test_users_detect_internal_staff_by_default_and_external_on_ext_marker(self) -> None:
        self.assertEqual(_detect_staff_type("Chris MURPHY")[0], "Internal Staff")
        self.assertEqual(_detect_staff_type("Harkirat SINGH (EXT - FPT)")[0], "External Staff")
        self.assertEqual(_detect_staff_type("Kosmas EVGENIDIS (Ext-FPT)")[0], "External Staff")
        self.assertEqual(_detect_staff_type("Nam Truong (EXT-CSS)")[0], "External Staff")
        self.assertEqual(_detect_staff_type("Phillip PLANT (EXT-Genpact)")[0], "External Staff")
        self.assertEqual(_detect_staff_type("Anita IOPEX (EXT - IOPEX)")[0], "External Staff")

    def test_detect_staff_type_ignores_non_ext_stand_alone_words(self) -> None:
        for name in ["External Systems", "Extra Talent", "Exposure Group", "Ex staffing"]:
            self.assertEqual(_detect_staff_type(name)[0], "Internal Staff", name)

    def test_users_manual_override_wins_over_auto_detection_and_survives_reimport(self) -> None:
        base = {"UserID": "USER-1", "Name": "Alex User", "Email": "alex@example.com", "staff_type": None, "staff_type_source": "auto"}
        _replace_users(self.connection, [{**base, "staff_type": "Internal Staff"}])
        self.assertEqual(_read_users(self.connection)[0]["staff_type"], "Internal Staff")

        manual = {**base, "staff_type": "External Staff", "staff_type_source": "manual"}
        _replace_users(self.connection, [manual])
        self.assertEqual(_read_users(self.connection)[0]["staff_type"], "External Staff")
        self.assertEqual(_read_users(self.connection)[0]["staff_type_source"], "manual")

        # A simulated re-import of the overridden user must not overwrite the manual value.
        _replace_users(self.connection, [{**base, "staff_type": "External Staff", "staff_type_source": "manual"}])
        stored = _read_users(self.connection)[0]
        self.assertEqual(stored["staff_type"], "External Staff")
        self.assertEqual(stored["staff_type_source"], "manual")

        # An incoming auto row for an overridden user must keep the manual value.
        _replace_users(self.connection, [{**base, "staff_type": None, "staff_type_source": "auto"}])
        stored = _read_users(self.connection)[0]
        self.assertEqual(stored["staff_type"], "External Staff")
        self.assertEqual(stored["staff_type_source"], "manual")

    def test_users_auto_detection_recomputes_from_name(self) -> None:
        _replace_users(self.connection, [{"UserID": "USER-1", "Name": "Pat (EXT - FPT)", "Email": "pat@example.com"}])
        stored = _read_users(self.connection)[0]
        self.assertEqual(stored["staff_type"], "External Staff")
        self.assertEqual(stored["staff_type_source"], "auto")

    def test_users_reject_missing_name_and_duplicate_email(self) -> None:
        with self.assertRaisesRegex(ValueError, "User ID and Name"):
            _replace_users(self.connection, [{"UserID": "USER-1", "Name": ""}])
        with self.assertRaisesRegex(ValueError, "Duplicate user email"):
            _replace_users(self.connection, [
                {"UserID": "USER-1", "Name": "Alex", "Email": "alex@example.com"},
                {"UserID": "USER-2", "Name": "Alex 2", "Email": "ALEX@example.com"},
            ])

    def test_checkout_history_rejects_multiple_active_staff_for_one_serial(self) -> None:
        with self.assertRaisesRegex(ValueError, "already checked out"):
            _replace_checkout_history(self.connection, [
                {
                    "Event ID": "evt-001", "Asset key": "device:first", "Device ID": "first",
                    "Serial number": "SN-1", "Event type": "checkout", "Event date": "2026-11-01",
                    "Staff name": "Alex User",
                },
                {
                    "Event ID": "evt-002", "Asset key": "device:second", "Device ID": "second",
                    "Serial number": "SN-1--1", "Event type": "checkout", "Event date": "2026-11-02",
                    "Staff name": "Sam User",
                },
            ])


class SQLiteApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_database_path = server_module.DATABASE_PATH
        server_module.DATABASE_PATH = Path(self.temp_dir.name) / "api.sqlite3"
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), InventoryRequestHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        server_module.DATABASE_PATH = self.original_database_path
        self.temp_dir.cleanup()

    def request_json(self, path: str, method: str, payload: object) -> tuple[int, dict[str, object]]:
        request = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method=method,
        )
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def request_bytes(self, path: str, method: str, payload: bytes) -> tuple[int, dict[str, object]]:
        request = urllib.request.Request(
            self.base_url + path,
            data=payload,
            headers={"Content-Type": "application/octet-stream"},
            method=method,
        )
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_health_reports_database_path(self) -> None:
        with urllib.request.urlopen(self.base_url + "/api/health") as response:
            result = json.loads(response.read())
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["database"], str(server_module.DATABASE_PATH))

    def test_bootstrap_migrates_once_and_api_writes_persist(self) -> None:
        legacy = {
            "inventory": [{"Device name": "Migrated", "Serial number": "OLD-1"}],
            "warranty": [{"Serial number": "OLD-1", "Warranty End Date": "2027-01-01"}],
        }
        status, first = self.request_json("/api/bootstrap", "POST", legacy)
        self.assertEqual(status, 200)
        self.assertTrue(first["migrated"])
        self.assertEqual(len(first["inventory"]), 1)
        self.assertEqual(first["inventory"][0]["Device name"], "Migrated")
        self.assertEqual(first["inventory"][0]["Serial number"], "OLD-1")
        self.assertEqual(first["inventory"][0].get("Intune GroupName"), "")
        self.assertEqual(len(first["warranty"]), 1)
        self.assertEqual(first["warranty"][0]["Serial number"], "OLD-1")
        self.assertEqual(first["warranty"][0]["Warranty End Date"], "2027-01-01")

        replacement = [{"Device name": "Persisted edit", "Serial number": "OLD-1", "IntuneGroup.GroupTag": "HQ"}]
        status, saved = self.request_json("/api/inventory", "PUT", replacement)
        self.assertEqual(status, 200)
        self.assertEqual(saved["saved"], 1)

        status, second = self.request_json("/api/bootstrap", "POST", {"inventory": [{"Device name": "Must not overwrite"}], "warranty": []})
        self.assertEqual(status, 200)
        self.assertFalse(second["migrated"])
        self.assertEqual(len(second["inventory"]), 1)
        self.assertEqual(second["inventory"][0]["Device name"], "Persisted edit")
        self.assertEqual(second["inventory"][0]["Serial number"], "OLD-1")
        self.assertEqual(second["inventory"][0].get("Intune GroupName"), "")
        self.assertEqual(second["inventory"][0].get("Intune Group Tag"), "HQ")
        self.assertTrue((Path(self.temp_dir.name) / "api.sqlite3").is_file())

    def test_api_rejects_non_record_payload(self) -> None:
        status, result = self.request_json("/api/inventory", "PUT", {"not": "an array"})
        self.assertEqual(status, 400)
        self.assertIn("JSON array", result["error"])

    def test_inventory_api_rejects_conflicting_primary_user_for_serial(self) -> None:
        original = [{
            "Device name": "Laptop 1", "Serial number": "SN-1",
            "Primary user display name": "Alex User", "Primary user email address": "alex@example.com",
        }]
        status, _ = self.request_json("/api/inventory", "PUT", original)
        self.assertEqual(status, 200)

        status, result = self.request_json("/api/inventory", "PUT", [
            *original,
            {
                "Device name": "Laptop copy", "Serial number": "SN-1--1",
                "Primary user display name": "Sam User", "Primary user email address": "sam@example.com",
            },
        ])
        self.assertEqual(status, 400)
        self.assertIn("only one primary user", result["error"])

        status, data = self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})
        self.assertEqual(status, 200)
        self.assertEqual(len(data["inventory"]), 1)
        self.assertEqual(data["inventory"][0]["Serial number"], "SN-1")
        self.assertEqual(data["inventory"][0]["Primary user display name"], "Alex User")
        self.assertEqual(data["inventory"][0].get("Intune GroupName"), "")

    def test_replacement_history_persists_through_inventory_import(self) -> None:
        records = [{
            "Replacement ID": "REP-0001",
            "Staff Member Name": "JohnDoe",
            "Old Device Serial Number": "ST11234",
            "New Device Serial Number": "ST5678",
            "Replacement Date": "2026-10-24",
        }]
        status, bootstrap = self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})
        self.assertEqual(status, 200)
        self.assertEqual(bootstrap["replacementHistory"], [])

        status, saved = self.request_json("/api/replacement-history", "PUT", records)
        self.assertEqual(status, 200)
        self.assertEqual(saved["saved"], 1)
        inventory = [{"Device name": "New device", "Serial number": "ST5678"}]
        status, inventory_saved = self.request_json("/api/inventory", "PUT", inventory)
        self.assertEqual(status, 200)

        status, reloaded = self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})
        self.assertEqual(status, 200)
        self.assertEqual(reloaded["replacementHistory"], records)
        self.assertEqual(len(reloaded["inventory"]), 1)
        self.assertEqual(reloaded["inventory"][0]["Device name"], "New device")
        self.assertEqual(reloaded["inventory"][0]["Serial number"], "ST5678")
        self.assertEqual(reloaded["inventory"][0].get("Intune GroupName"), "")

    def test_checkout_history_persists_through_inventory_import(self) -> None:
        status, bootstrap = self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})
        self.assertEqual(status, 200)
        self.assertEqual(bootstrap["checkoutHistory"], [])

        events = [{
            "Event ID": "evt-001", "Asset key": "device:intune-1", "Device ID": "intune-1",
            "Device name": "Laptop 1", "Serial number": "SN-1", "Event type": "checkout",
            "Event date": "2026-11-01", "Staff name": "Alex User", "Staff email": "alex@example.com",
            "Expected return date": "2026-11-20", "Notes": "Temporary loan",
        }]
        status, saved = self.request_json("/api/checkout-history", "PUT", events)
        self.assertEqual(status, 200)
        self.assertEqual(saved["saved"], 1)

        inventory = [{"Device ID": "intune-1", "Device name": "Updated by Intune", "Serial number": "SN-1"}]
        status, inventory_saved = self.request_json("/api/inventory", "PUT", inventory)
        self.assertEqual(status, 200)
        self.assertEqual(inventory_saved["saved"], 1)

        status, reloaded = self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})
        self.assertEqual(status, 200)
        self.assertEqual(reloaded["checkoutHistory"], events)
        self.assertEqual(len(reloaded["inventory"]), 1)
        self.assertEqual(reloaded["inventory"][0]["Device name"], "Updated by Intune")
        self.assertEqual(reloaded["inventory"][0]["Serial number"], "SN-1")
        self.assertEqual(reloaded["inventory"][0].get("Intune GroupName"), "")

    def test_users_api_round_trip(self) -> None:
        users = [{
            "UserID": "USER-1", "Name": "Alex User", "Email": "alex@example.com",
            "Country": "Singapore", "Location": "HQ", "staff_type": "Internal Staff", "staff_type_source": "auto",
        }]
        status, bootstrap = self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})
        self.assertEqual(status, 200)
        self.assertEqual(bootstrap["users"], [])
        status, saved = self.request_json("/api/users", "PUT", users)
        self.assertEqual(status, 200)
        self.assertEqual(saved["saved"], 1)
        status, reloaded = self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})
        self.assertEqual(status, 200)
        self.assertEqual(reloaded["users"], users)

    def test_users_api_rejects_duplicate_emails_without_replacing_existing(self) -> None:
        existing = [{"UserID": "USER-1", "Name": "Existing", "Email": "existing@example.com", "staff_type": "Internal Staff", "staff_type_source": "auto"}]
        self.assertEqual(self.request_json("/api/users", "PUT", existing)[0], 200)
        status, result = self.request_json("/api/users", "PUT", [
            {"UserID": "USER-2", "Name": "Alex", "Email": "same@example.com"},
            {"UserID": "USER-3", "Name": "Sam", "Email": "SAME@example.com"},
        ])
        self.assertEqual(status, 400)
        self.assertIn("Duplicate user email", result["error"])
        self.assertEqual(self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})[1]["users"], existing)

    def test_users_staff_type_reset_endpoint_clears_manual_override(self) -> None:
        status, saved = self.request_json("/api/users", "PUT", [{
            "UserID": "USER-1", "Name": "Pat (EXT - FPT)", "Email": "pat@example.com",
            "staff_type": "External Staff", "staff_type_source": "manual",
        }])
        self.assertEqual(status, 200)
        self.assertEqual(saved["saved"], 1)

        status, result = self.request_json("/api/users/staff-type/reset", "POST", {"UserID": "USER-1"})
        self.assertEqual(status, 200)
        self.assertEqual(result["staffTypeSource"], "auto")
        self.assertEqual(result["staffType"], "External Staff")

        status, bootstrap = self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})
        self.assertEqual(status, 200)
        self.assertEqual(bootstrap["users"][0]["staff_type_source"], "auto")

    def test_users_staff_type_reset_endpoint_rejects_unknown_user(self) -> None:
        status, result = self.request_json("/api/users/staff-type/reset", "POST", {"UserID": "NOPE-1"})
        self.assertEqual(status, 404)
        self.assertIn("User not found", result["error"])

    def test_status_labels_api_round_trip_and_characteristic_validation(self) -> None:
        labels = [
            {"id": "ready", "name": "Ready to Deploy", "type": "Deployable"},
            {"id": "archive", "name": "Archived", "type": "Archived"},
        ]
        status, bootstrap = self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})
        self.assertEqual(status, 200)
        self.assertTrue(bootstrap["statusLabels"])
        status, saved = self.request_json("/api/status-labels", "PUT", labels)
        self.assertEqual(status, 200)
        self.assertEqual(saved["saved"], 2)
        self.assertEqual(self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})[1]["statusLabels"], labels)
        status, result = self.request_json("/api/status-labels", "PUT", [
            {"id": "bad", "name": "Invalid", "type": "Assignable"},
        ])
        self.assertEqual(status, 400)
        self.assertIn("valid characteristic", result["error"])
        self.assertEqual(self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})[1]["statusLabels"], labels)

    def test_checkout_history_api_rejects_invalid_record(self) -> None:
        status, result = self.request_json("/api/checkout-history", "PUT", [{
            "Event ID": "evt-001", "Asset key": "device:intune-1", "Event type": "checkout",
            "Event date": "11/01/2026", "Staff name": "Alex User",
        }])
        self.assertEqual(status, 400)
        self.assertIn("YYYY-MM-DD", result["error"])

    def test_backup_download_and_restore_round_trip_all_records(self) -> None:
        self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})
        inventory = [{"Device ID": "DEVICE-1", "Device name": "Backup laptop", "Serial number": "SN-1"}]
        warranty = [{"Serial number": "SN-1", "Warranty End Date": "2027-01-01"}]
        replacements = [{"Replacement ID": "REP-1", "Old Device Serial Number": "SN-0"}]
        checkouts = [{
            "Event ID": "EVT-1", "Asset key": "device:device-1", "Event type": "checkout",
            "Event date": "2026-11-01", "Staff name": "Alex User",
        }]
        users = [{
            "UserID": "USER-1", "Name": "Alex User", "Email": "alex@example.com",
            "Country": "Singapore", "Location": "HQ", "staff_type": "Internal Staff", "staff_type_source": "auto",
        }]
        status_labels = [{"id": "ready", "name": "Ready to Deploy", "type": "Deployable"}]
        for path, records in (
            ("/api/inventory", inventory),
            ("/api/warranty", warranty),
            ("/api/replacement-history", replacements),
            ("/api/checkout-history", checkouts),
            ("/api/users", users),
            ("/api/status-labels", status_labels),
        ):
            status, result = self.request_json(path, "PUT", records)
            self.assertEqual(status, 200, result)

        with urllib.request.urlopen(self.base_url + "/api/backup") as response:
            backup = response.read()
            self.assertEqual(response.status, 200)
            self.assertIn("attachment;", response.headers["Content-Disposition"])
        self.assertTrue(backup.startswith(b"SQLite format 3"))

        status, result = self.request_json("/api/inventory", "PUT", [{"Device name": "Changed"}])
        self.assertEqual(status, 200)
        status, restored = self.request_bytes("/api/restore", "POST", backup)
        self.assertEqual(status, 200, restored)
        self.assertTrue(restored["restored"])

        status, data = self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})
        self.assertEqual(status, 200)
        self.assertEqual(len(data["inventory"]), 1)
        self.assertEqual(data["inventory"][0]["Device ID"], "DEVICE-1")
        self.assertEqual(data["inventory"][0]["Device name"], "Backup laptop")
        self.assertEqual(data["inventory"][0]["Serial number"], "SN-1")
        self.assertEqual(data["inventory"][0].get("Intune GroupName"), "")
        self.assertEqual(len(data["warranty"]), 1)
        self.assertEqual(data["warranty"][0]["Serial number"], "SN-1")
        self.assertEqual(data["warranty"][0]["Warranty End Date"], "2027-01-01")
        self.assertEqual(data["replacementHistory"], replacements)
        self.assertEqual(data["checkoutHistory"], checkouts)
        self.assertEqual(data["users"], users)
        self.assertEqual(data["statusLabels"], status_labels)

    def test_invalid_backup_restore_preserves_current_database(self) -> None:
        inventory = [{"Device name": "Keep this record", "Serial number": "SN-KEEP"}]
        status, result = self.request_json("/api/inventory", "PUT", inventory)
        self.assertEqual(status, 200)

        status, result = self.request_bytes("/api/restore", "POST", b"not a sqlite database")
        self.assertEqual(status, 400)
        self.assertIn("SQLite", result["error"])

        status, data = self.request_json("/api/bootstrap", "POST", {"inventory": [], "warranty": []})
        self.assertEqual(status, 200)
        self.assertEqual(len(data["inventory"]), 1)
        self.assertEqual(data["inventory"][0]["Device name"], "Keep this record")
        self.assertEqual(data["inventory"][0]["Serial number"], "SN-KEEP")
        self.assertEqual(data["inventory"][0].get("Intune GroupName"), "")

    def test_replacement_history_api_rejects_case_insensitive_duplicate_ids(self) -> None:
        status, result = self.request_json("/api/replacement-history", "PUT", [
            {"Replacement ID": "REP-1"},
            {"Replacement ID": "rep-1"},
        ])
        self.assertEqual(status, 400)
        self.assertIn("Duplicate Replacement ID", result["error"])


if __name__ == "__main__":
    unittest.main()
