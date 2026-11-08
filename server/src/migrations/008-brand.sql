-- brand pass: the product is now Cillhub. Renames the built-in names; usernames only while they are still the old
-- defaults and the new name is free (usernames compare case-insensitively). A changed instance name stays as it is.

UPDATE users SET global_name = 'Cillhub' WHERE global_name = 'Cillcord' AND id IN (SELECT id FROM applications WHERE builtin = 1);
UPDATE applications SET name = 'Cillhub' WHERE name = 'Cillcord' AND builtin = 1;
UPDATE users SET global_name = 'Cillhub System' WHERE global_name = 'Cillcord System' AND system = 1;

-- bot: cillcord -> cillhub, fallback cillcord_<hex> -> cillhub_<hex>; system: cillcord-system[-N] -> cillhub-system[-N]
UPDATE users SET username = 'cillhub' || substr(username, 9)
  WHERE ((id IN (SELECT id FROM applications WHERE builtin = 1) AND (username = 'cillcord' OR username GLOB 'cillcord_[0-9a-f][0-9a-f][0-9a-f][0-9a-f]'))
      OR (system = 1 AND (username = 'cillcord-system' OR username GLOB 'cillcord-system-[0-9]*')))
    AND NOT EXISTS (SELECT 1 FROM users o WHERE o.username = 'cillhub' || substr(users.username, 9));

UPDATE instance_settings SET value = '"Cillhub"' WHERE key = 'instance_name' AND value = '"Cillcord"';
