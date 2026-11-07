-- Optional manual equivalent of the indexes created automatically by server.py.
CREATE INDEX IF NOT EXISTS idx_users_name ON users(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_users_email_value ON users(email COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_inventory_device_name ON inventory_devices(device_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_inventory_serial_number ON inventory_devices(serial_number COLLATE NOCASE);
