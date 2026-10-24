"""Focused tests for the SQLite inventory persistence layer and API."""

import json
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
    _read_inventory,
    _read_replacement_history,
    _read_warranty,
    _replace_inventory,
    _replace_replacement_history,
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
            {"Device ID": "B", "Device name": "Copy", "Serial number": "ABC-1--1", "Duplicate Serial": True},
        ]
        _replace_inventory(self.connection, devices)
        self.assertEqual(_read_inventory(self.connection), devices)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM inventory_devices").fetchone()[0], 2)
        self.assertEqual(self.connection.execute("SELECT COUNT(DISTINCT normalized_serial) FROM inventory_devices").fetchone()[0], 1)

    def test_replacing_inventory_removes_old_records(self) -> None:
        _replace_inventory(self.connection, [{"Device name": "Old"}])
        expected = [{"Device name": "New"}]
        _replace_inventory(self.connection, expected)
        self.assertEqual(_read_inventory(self.connection), expected)

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
        self.assertEqual(json.loads(stored_json), record)

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
        self.assertEqual(first["inventory"], legacy["inventory"])
        self.assertEqual(first["warranty"], legacy["warranty"])

        replacement = [{"Device name": "Persisted edit", "Serial number": "OLD-1", "IntuneGroup.GroupTag": "HQ"}]
        status, saved = self.request_json("/api/inventory", "PUT", replacement)
        self.assertEqual(status, 200)
        self.assertEqual(saved["saved"], 1)

        status, second = self.request_json("/api/bootstrap", "POST", {"inventory": [{"Device name": "Must not overwrite"}], "warranty": []})
        self.assertEqual(status, 200)
        self.assertFalse(second["migrated"])
        self.assertEqual(second["inventory"], replacement)
        self.assertTrue((Path(self.temp_dir.name) / "api.sqlite3").is_file())

    def test_api_rejects_non_record_payload(self) -> None:
        status, result = self.request_json("/api/inventory", "PUT", {"not": "an array"})
        self.assertEqual(status, 400)
        self.assertIn("JSON array", result["error"])

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
        self.assertEqual(reloaded["inventory"], inventory)

    def test_replacement_history_api_rejects_case_insensitive_duplicate_ids(self) -> None:
        status, result = self.request_json("/api/replacement-history", "PUT", [
            {"Replacement ID": "REP-1"},
            {"Replacement ID": "rep-1"},
        ])
        self.assertEqual(status, 400)
        self.assertIn("Duplicate Replacement ID", result["error"])


if __name__ == "__main__":
    unittest.main()
