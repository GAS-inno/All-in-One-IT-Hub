#!/usr/bin/env python3
"""Restore the live NexIT SQLite DB users/inventory from the pre-deletion backup."""

import sqlite3
from pathlib import Path

BACKUP = Path("/home/gasaw/.local/share/NexIT-Asset-Inventory/nexit-assets.before-users-align-20261109T095703Z.db")
LIVE = Path("/home/gasaw/.local/share/NexIT-Asset-Inventory/nexit-assets.db")


def main() -> None:
    source = sqlite3.connect(f"file:{BACKUP}?mode=ro", uri=True)
    target = sqlite3.connect(LIVE)
    source.backup(target)
    target.close()
    source.close()
    check = sqlite3.connect(LIVE)
    users = check.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    inventory = check.execute("SELECT COUNT(*) FROM inventory_devices").fetchone()[0]
    check.close()
    print(f"Restored users={users} inventory={inventory}")


if __name__ == "__main__":
    main()
