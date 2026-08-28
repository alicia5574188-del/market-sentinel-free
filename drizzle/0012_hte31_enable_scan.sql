-- HTE 3.1 Clean is a fresh simulation runtime and should begin scanning immediately.
-- This is a one-time bootstrap only; later user changes to scan_enabled remain respected.
UPDATE app_settings
SET scan_enabled = 1
WHERE id = 1;
