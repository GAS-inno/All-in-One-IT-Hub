"""Sanity tests for device status validation."""

import unittest

from constants import DEPLOYMENT_STATUS
from server import _validate_device_status


class TestStatusValidation(unittest.TestCase):
    def test_valid_deployment_status_values_pass(self):
        cases = {
            "In Use": "Good",
            "In Stock": "Good",
            "Workshop": "Good",
            "Retired": None,
            "Disposed": "End of Life",
        }
        for status in DEPLOYMENT_STATUS:
            with self.subTest(deployment_status=status):
                condition = cases[status]
                record = {"deployment_status": status}
                if condition is not None:
                    record["condition"] = condition
                _validate_device_status(record)

    def test_unknown_deployment_status_raises(self):
        with self.assertRaises(ValueError):
            _validate_device_status({"deployment_status": "Bogus"})

    def test_disposed_requires_end_of_life_condition(self):
        with self.assertRaises(ValueError):
            _validate_device_status({"deployment_status": "Disposed", "condition": "Good"})

    def test_is_archived_string_raises(self):
        with self.assertRaises(ValueError):
            _validate_device_status({"is_archived": "yes"})


if __name__ == "__main__":
    unittest.main()
