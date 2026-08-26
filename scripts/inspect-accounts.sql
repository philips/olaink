-- Read-only Ola Ink account/username inspection queries.
-- Run with:
--   sqlite3 -readonly /var/lib/olaink/olaink.sqlite < scripts/inspect-accounts.sql

.headers on
.mode column

-- Accounts with their username assignment, newest first. An account with NULL
-- canonical_username and status is signed in but has not claimed a username.
SELECT
  a.user_id,
  datetime(a.created_at / 1000, 'unixepoch') AS account_created_utc,
  u.canonical_username,
  u.status,
  datetime(u.assigned_at / 1000, 'unixepoch') AS username_assigned_utc
FROM prototype_accounts AS a
LEFT JOIN account_usernames AS u ON u.user_id = a.user_id
ORDER BY a.created_at DESC;

-- Only signed-in accounts that have never claimed a username.
SELECT
  a.user_id,
  datetime(a.created_at / 1000, 'unixepoch') AS created_utc
FROM prototype_accounts AS a
LEFT JOIN account_usernames AS u ON u.user_id = a.user_id
WHERE u.user_id IS NULL
ORDER BY a.created_at DESC;
