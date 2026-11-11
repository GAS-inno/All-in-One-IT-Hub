import json
import tempfile
import unittest
from pathlib import Path

import server as server_module
from server import (
    _read_inventory,
    _read_warranty,
    _replace_inventory,
    _replace_warranty,
    connect_database,
)


class InventorySchemaAndDateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "t.sqlite3"
        self.original_database_path = server_module.DATABASE_PATH
        server_module.DATABASE_PATH = self.db_path
        self.connection = connect_database(self.db_path)

    def tearDown(self) -> None:
        self.connection.close()
        server_module.DATABASE_PATH = self.original_database_path
        self.temp_dir.cleanup()

    def test_purchase_disposal_round_trip_and_date_normalization(self) -> None:
        records = [{
            "Device name": "Laptop A",
            "Serial number": "SN-A",
            "Purchase Date": "05-Dec-2021",
            "Warranty Start Date": "2021-12-05",
            "Warranty End Date": "44535",  # Excel serial -> 2021-12-05
            "Disposal Date": "00-Jan-1900",
        }]
        _replace_inventory(self.connection, records)
        stored = _read_inventory(self.connection)[0]
        self.assertEqual(stored["Purchase Date"], "2021-12-05")
        self.assertEqual(stored["Warranty Start Date"], "2021-12-05")
        self.assertEqual(stored["Warranty End Date"], "2021-12-05")
        self.assertEqual(stored.get("Disposal Date"), "")

        columns = {row["name"] for row in self.connection.execute("PRAGMA table_info(inventory_devices)")}
        self.assertIn("purchase_date", columns)
        self.assertIn("disposal_date", columns)
        row = self.connection.execute(
            "SELECT purchase_date, warranty_start_date, warranty_end_date, disposal_date FROM inventory_devices"
        ).fetchone()
        self.assertEqual(row["purchase_date"], "2021-12-05")
        self.assertEqual(row["warranty_start_date"], "2021-12-05")
        self.assertEqual(row["warranty_end_date"], "2021-12-05")
        self.assertIsNone(row["disposal_date"])

    def test_rejects_ambiguous_date(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            _replace_inventory(self.connection, [{
                "Device name": "Laptop B",
                "Serial number": "SN-B",
                "Warranty Start Date": "01/02/2024",
            }])
        self.assertIn("Ambiguous date", str(ctx.exception))

    def test_removed_intune_fields_dropped_and_groupname_standardized(self) -> None:
        record = {
            "Device name": "Laptop C",
            "Serial number": "SN-C",
            "IntuneGroup.GroupName": "Legacy Group",
            "IntuneGroup.DeviceName": "Should drop",
            "IntuneGroup.SerialNumber": "SHOULD-NOT-WIN",
            "IntuneGroup.Model": "Drop model",
            "IntuneGroup.Manufacturer": "Drop mfg",
            "Intune Group Tag": "SG",
        }
        _replace_inventory(self.connection, [record])
        stored = _read_inventory(self.connection)[0]
        self.assertEqual(stored["Intune GroupName"], "Legacy Group")
        self.assertNotIn("IntuneGroup.GroupName", stored)
        self.assertNotIn("IntuneGroup.DeviceName", stored)
        self.assertNotIn("IntuneGroup.SerialNumber", stored)
        self.assertNotIn("Intune SerialNumber", stored)
        self.assertNotIn("IntuneGroup.Model", stored)
        self.assertNotIn("Intune Group Model", stored)
        self.assertNotIn("IntuneGroup.Manufacturer", stored)
        self.assertNotIn("Intune Group Manufacturer", stored)
        self.assertEqual(stored["Serial number"], "SN-C")
        self.assertEqual(self.connection.execute("SELECT group_name FROM inventory_devices").fetchone()["group_name"], "Legacy Group")

    def test_warranty_dates_normalized(self) -> None:
        _replace_warranty(self.connection, [{
            "Serial number": "sn-w",
            "Warranty Start Date": "15-Jan-2024",
            "Warranty End Date": "45306",  # 2024-01-15 in Excel 1900 system
        }])
        stored = _read_warranty(self.connection)[0]
        self.assertEqual(stored["Warranty Start Date"], "2024-01-15")
        self.assertEqual(stored["Warranty End Date"], "2024-01-15")
        row = self.connection.execute(
            "SELECT warranty_start_date, warranty_end_date FROM warranty_records"
        ).fetchone()
        self.assertEqual(row["warranty_start_date"], "2024-01-15")
        self.assertEqual(row["warranty_end_date"], "2024-01-15")


class TemplateSourceOfTruthTests(unittest.TestCase):
    def test_inventory_template_and_user_template_defined_programmatically(self) -> None:
        root = Path(__file__).resolve().parent
        inventory_js = (root / "inventory.js").read_text(encoding="utf-8")
        users_js = (root / "users.js").read_text(encoding="utf-8")

        # Inventory template is built from shared column definitions and includes required fields.
        self.assertIn("const INVENTORY_TEMPLATE_COLUMNS = [", inventory_js)
        self.assertIn("{ header: 'Purchase Date', example: '05-Dec-2021' }", inventory_js)
        self.assertIn("{ header: 'Disposal Date', example: '' }", inventory_js)
        self.assertIn("function buildInventoryTemplateDefinition()", inventory_js)
        self.assertIn("headerRow: INVENTORY_TEMPLATE_COLUMNS.map((column) => column.header)", inventory_js)
        self.assertNotIn("{ header: 'Intune Group DeviceName'", inventory_js)
        self.assertNotIn("{ header: 'Intune SerialNumber'", inventory_js)
        self.assertNotIn("{ header: 'Intune Group Model'", inventory_js)
        self.assertNotIn("{ header: 'Intune Group Manufacturer'", inventory_js)
        self.assertIn("Data → From Text/CSV", inventory_js)
        self.assertIn("UTF-8 with BOM", inventory_js)

        # User template headers as specified.
        self.assertIn("const USER_TEMPLATE_COLUMNS = [", inventory_js)
        self.assertIn("{ header: 'USER ID', example: 'USR-0001' }", inventory_js)
        self.assertIn("{ header: 'NAME', example: 'Alex User' }", inventory_js)
        self.assertIn("{ header: 'STAFF TYPE', example: 'Internal Staff' }", inventory_js)
        self.assertIn("{ header: 'EMAIL', example: 'alex.user@example.com' }", inventory_js)
        self.assertIn("{ header: 'ACCOUNT ACTIVE', example: 'YES' }", inventory_js)
        self.assertIn("{ header: 'COUNTRY', example: 'Singapore' }", inventory_js)
        self.assertIn("{ header: 'LOCATION', example: 'Singapore HQ' }", inventory_js)
        # ASSIGNED ASSETS must be excluded (derived) - not a template header.
        self.assertNotIn("{ header: 'ASSIGNED ASSETS'", inventory_js)
        self.assertIn("ASSIGNED ASSETS: derived from inventory/checkouts", inventory_js)

        # User CSV import recognizes STAFF TYPE header.
        self.assertIn("['userid', 'user id']", users_js)
        self.assertIn("header === 'staff type'", users_js)
        self.assertIn("account active", users_js)

    def test_removed_intune_import_headers_marked_ignored(self) -> None:
        root = Path(__file__).resolve().parent
        inventory_js = (root / "inventory.js").read_text(encoding="utf-8")
        self.assertIn("REMOVED_INVENTORY_IMPORT_HEADERS", inventory_js)
        self.assertIn("'intune group device name'", inventory_js)
        self.assertIn("'intune serialnumber'", inventory_js)
        self.assertIn("'intune group model'", inventory_js)
        self.assertIn("'intune group manufacturer'", inventory_js)
        self.assertIn("(removed/ignored)", inventory_js)


if __name__ == "__main__":
    unittest.main()
