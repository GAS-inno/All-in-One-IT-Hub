"""Tests for dashboard classification, filtering, and aggregate charts."""

import json
import tempfile
import threading
import unittest
from datetime import date
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen

import server as server_module
from dashboard_metrics import build_dashboard, filter_options, matching_record_indexes
from server import InventoryRequestHandler, ThreadingHTTPServer, _replace_inventory


class DashboardMetricTests(unittest.TestCase):
    def setUp(self) -> None:
        self.today = date(2026, 10, 10)
        self.records = [
            {"Device ID": "A", "Serial number": "SAME", "Intune_Group_APAC_Devices - Copy.Country": "SG", "Intune_Group_APAC_Devices - Copy.Department": "IT", "Windows Version": "win11", "check Active status": "Active", "Remark": "win11 (current)", "warrantyEndDate": "15 Oct 2026", "Age": "2 Years, 1 Month", "Primary user email address": "a@example.com"},
            {"Device ID": "B", "Serial number": "SAME--1", "Intune_Group_APAC_Devices - Copy.Country": "SG", "Intune_Group_APAC_Devices - Copy.Department": "IT", "Windows Version": "0", "check Active status": "NO", "Remark": "Retired / Delete", "warrantyEndDate": "1 Jan 2020", "Age": "6 Years, 2 Months", "Duplicate Serial": True},
            {"Device ID": "C", "Serial number": "THREE", "Intune_Group_APAC_Devices - Copy.Country": "MY", "Intune_Group_APAC_Devices - Copy.Department": "Finance", "Windows Version": "win10", "check Active status": "Active", "Remark": "pc refresh", "warrantyEndDate": "", "Age": "1 Years, 0 Months"},
            {"Device ID": "D", "Serial number": "FOUR", "Intune_Group_APAC_Devices - Copy.Country": "MY", "Intune_Group_APAC_Devices - Copy.Department": "Finance", "Windows Version": None, "check Active status": "Active", "Remark": "OS upgrade win11", "warrantyEndDate": "", "Age": "#VALUE!"},
        ]

    def test_totals_keep_source_rows_and_normalize_unknown_os(self) -> None:
        result = build_dashboard(self.records, today=self.today)
        self.assertEqual(result["sourceRecordCount"], 4)
        self.assertEqual(result["distinctAssetCount"], 3)
        self.assertEqual(result["kpis"]["totalAssets"], 4)
        self.assertEqual(result["kpis"]["unknownOs"], 2)
        self.assertEqual(result["kpis"]["duplicateSerialNumbers"], 1)
        self.assertEqual(result["kpis"]["win10"], 1)
        self.assertEqual(result["kpis"]["win11"], 1)
        self.assertEqual(sum(result["kpis"][key] for key in ("activeAssets", "inactiveAssets", "stock", "retired")), 4)

    def test_filters_update_every_aggregate_and_charts(self) -> None:
        result = build_dashboard(self.records, {"country": "SG", "department": "IT"}, today=self.today)
        self.assertEqual(result["sourceRecordCount"], 2)
        self.assertEqual(result["kpis"]["totalAssets"], 2)
        self.assertEqual(result["kpis"]["expiredWarranty"], 1)
        self.assertEqual(result["kpis"]["warrantyExpiring90Days"], 1)
        self.assertEqual(result["charts"]["statusByCountry"]["labels"], ["SG"])
        self.assertEqual(result["charts"]["ageBands"]["data"][1], 1)

    def test_windows_build_numbers_normalize_into_os_families(self) -> None:
        result = build_dashboard([
            {"Serial number": "OLD", "Windows Version": "0", "OS version": "10.0.19045.7725"},
            {"Serial number": "NEW", "Windows Version": "", "OS version": "10.0.22631.6199"},
        ], today=self.today)
        self.assertEqual(result["kpis"]["win10"], 1)
        self.assertEqual(result["kpis"]["win11"], 1)
        self.assertEqual(result["kpis"]["unknownOs"], 0)

    def test_filter_options_include_unknown_values(self) -> None:
        options = filter_options(self.records, today=self.today)
        self.assertIn("Unknown", options["os"])
        self.assertEqual(set(options["country"]), {"SG", "MY"})

    def test_metric_drilldown_returns_matching_source_record_indexes(self) -> None:
        self.assertEqual(matching_record_indexes(self.records, {}, "activeAssets", self.today), [0, 2, 3])
        self.assertEqual(matching_record_indexes(self.records, {}, "duplicateSerialNumbers", self.today), [0, 1])
        self.assertEqual(matching_record_indexes(self.records, {"country": "SG"}, "win11", self.today), [0])
        with self.assertRaisesRegex(ValueError, "Unknown dashboard metric"):
            matching_record_indexes(self.records, {}, "not-a-metric", self.today)


class DashboardApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_path = server_module.DATABASE_PATH
        server_module.DATABASE_PATH = Path(self.temp_dir.name) / "dashboard.sqlite3"
        with server_module.database_connection() as connection:
            _replace_inventory(connection, [
                {"Device ID": "1", "Serial number": "1", "Intune_Group_APAC_Devices - Copy.Country": "SG", "Windows Version": "win11", "Action performed": "Refresh & Replace"},
                {"Device ID": "2", "Serial number": "2", "Intune_Group_APAC_Devices - Copy.Country": "MY", "Windows Version": "0"},
            ])
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), InventoryRequestHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        server_module.DATABASE_PATH = self.original_path
        self.temp_dir.cleanup()

    def test_bootstrap_and_encoded_dashboard_filters(self) -> None:
        with urlopen(self.base_url + "/api/bootstrap") as response:
            bootstrap = json.loads(response.read())
        self.assertEqual(bootstrap["sourceRecordCount"], 2)
        with urlopen(self.base_url + "/api/dashboard") as response:
            unfiltered = json.loads(response.read())
        self.assertEqual(unfiltered["sourceRecordCount"], 2)
        self.assertEqual(unfiltered["kpis"]["totalAssets"], 2)
        self.assertIn("plannedAction", bootstrap["filterOptions"])
        self.assertIn("warrantyStatus", bootstrap["filterOptions"])
        self.assertIn("SG", bootstrap["filterOptions"]["country"])
        query = urlencode({"country": "SG", "plannedAction": "Refresh & Replace"})
        with urlopen(self.base_url + "/api/dashboard?" + query) as response:
            dashboard = json.loads(response.read())
        self.assertEqual(dashboard["sourceRecordCount"], 1)
        self.assertEqual(dashboard["kpis"]["totalAssets"], 1)

    def test_dashboard_records_endpoint_returns_filtered_source_indexes(self) -> None:
        with server_module.database_connection() as connection:
            _replace_inventory(connection, [
                {"Device ID": "1", "Serial number": "1", "Intune_Group_APAC_Devices - Copy.Country": "SG", "Windows Version": "win11", "check Active status": "Active"},
                {"Device ID": "2", "Serial number": "2", "Intune_Group_APAC_Devices - Copy.Country": "MY", "Windows Version": "0"},
            ])
        query = urlencode({"metric": "unknownOs", "country": "MY"})
        with urlopen(self.base_url + "/api/dashboard/records?" + query) as response:
            result = json.loads(response.read())
        self.assertEqual(result["recordIndexes"], [1])

        with self.assertRaises(HTTPError) as error_context:
            urlopen(self.base_url + "/api/dashboard/records?metric=not-a-metric")
        self.assertEqual(error_context.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
