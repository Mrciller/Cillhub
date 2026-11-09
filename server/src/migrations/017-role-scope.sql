-- security: member_roles rows whose role belongs to another guild (anti-raid quarantine role was not validated)
DELETE FROM member_roles WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = member_roles.role_id AND r.guild_id = member_roles.guild_id);
