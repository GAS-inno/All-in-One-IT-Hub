import json
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server as server_module
from server import InventoryRequestHandler, ThreadingHTTPServer, _replace_users, _read_users


class StaffTypePersistenceApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_path = server_module.DATABASE_PATH
        server_module.DATABASE_PATH = Path(self.temp_dir.name) / "staff-type.sqlite3"
        with server_module.database_connection() as connection:
            _replace_users(connection, [
                {"UserID": "U1", "Name": "Alice Example", "Email": "alice@example.com", "Country": "Singapore"},
                {"UserID": "U2", "Name": "Bob (EXT - FPT)", "Email": "bob@example.com", "Country": "Vietnam"},
            ])
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), InventoryRequestHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        server_module.DATABASE_PATH = self.original_path
        self.temp_dir.cleanup()

    def _post_json(self, path, payload):
        req = Request(self.base_url + path, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(req) as resp:
            return resp.status, json.loads(resp.read())

    def _put_json(self, path, payload):
        req = Request(self.base_url + path, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"}, method="PUT")
        with urlopen(req) as resp:
            return resp.status, json.loads(resp.read())

    def _get_json(self, path):
        with urlopen(self.base_url + path) as resp:
            return resp.status, json.loads(resp.read())

    def test_set_valid_staff_type_persists_and_is_returned_on_refresh(self):
        status, result = self._post_json("/api/users/staff-type", {"UserID": "U1", "staffType": "External Staff"})
        self.assertEqual(status, 200)
        self.assertEqual(result["staffType"], "External Staff")
        self.assertEqual(result["staffTypeSource"], "manual")

        # verify DB updated
        with server_module.database_connection() as connection:
            users = _read_users(connection)
        u1 = next(u for u in users if u["UserID"] == "U1")
        self.assertEqual(u1["staff_type"], "External Staff")
        self.assertEqual(u1["staff_type_source"], "manual")

        # "refresh/return to list": bootstrap/users data reflects persisted value
        status, bootstrap = self._post_json("/api/bootstrap", {})
        self.assertEqual(status, 200)
        bu1 = next(u for u in bootstrap["users"] if u["UserID"] == "U1")
        self.assertEqual(bu1["staff_type"], "External Staff")
        self.assertEqual(bu1["staff_type_source"], "manual")

    def test_invalid_staff_type_returns_clear_error(self):
        with self.assertRaises(HTTPError) as ctx:
            self._post_json("/api/users/staff-type", {"UserID": "U1", "staffType": "Contractor"})
        self.assertEqual(ctx.exception.code, 400)
        body = json.loads(ctx.exception.read())
        self.assertIn("External Staff", body["error"])
        self.assertIn("Unclassified", body["error"])

        # DB unchanged
        with server_module.database_connection() as connection:
            users = _read_users(connection)
        u1 = next(u for u in users if u["UserID"] == "U1")
        self.assertNotEqual(u1.get("staff_type"), "Contractor")

    def test_bulk_edit_via_users_replace_persists_staff_type(self):
        # simulate bulk edit: PUT /api/users with updated staff_type/source
        with server_module.database_connection() as connection:
            users = _read_users(connection)
        for u in users:
            if u["UserID"] == "U1":
                u["staff_type"] = "Internal Staff"
                u["staff_type_source"] = "manual"
        status, result = self._put_json("/api/users", users)
        self.assertEqual(status, 200)
        self.assertEqual(result["saved"], 2)

        with server_module.database_connection() as connection:
            users_after = _read_users(connection)
        u1 = next(u for u in users_after if u["UserID"] == "U1")
        self.assertEqual(u1["staff_type"], "Internal Staff")
        self.assertEqual(u1["staff_type_source"], "manual")

        status, bootstrap = self._post_json("/api/bootstrap", {})
        bu1 = next(u for u in bootstrap["users"] if u["UserID"] == "U1")
        self.assertEqual(bu1["staff_type"], "Internal Staff")

    def test_reset_updates_columns_and_data_json_and_persists(self):
        # set manual first
        self._post_json("/api/users/staff-type", {"UserID": "U2", "staffType": "Internal Staff"})
        status, result = self._post_json("/api/users/staff-type/reset", {"UserID": "U2"})
        self.assertEqual(status, 200)
        self.assertEqual(result["staffTypeSource"], "auto")
        # name has EXT marker so should detect External Staff
        self.assertEqual(result["staffType"], "External Staff")

        with server_module.database_connection() as connection:
            row = connection.execute("SELECT staff_type, staff_type_source, data_json FROM users WHERE UserID='U2'").fetchone()
            users = _read_users(connection)
        self.assertEqual(row["staff_type"], "External Staff")
        self.assertEqual(row["staff_type_source"], "auto")
        payload = json.loads(row["data_json"])
        self.assertEqual(payload["staff_type"], "External Staff")
        self.assertEqual(payload["staff_type_source"], "auto")
        u2 = next(u for u in users if u["UserID"] == "U2")
        self.assertEqual(u2["staff_type"], "External Staff")


if __name__ == "__main__":
    unittest.main()
