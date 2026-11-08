// Welcome Roles: greets new members and gives them a role (see README.md).

cillhub.on('GUILD_MEMBER_ADD', async (member) => {
  const guildId = member.guild_id;
  const user = member.user;
  if (!user || user.bot) return;

  const s = await cillhub.call('settings.get', { guild_id: guildId });
  if (s.enabled === false) return;
  if (!s.channel && !s.role) {
    console.warn(`Not configured for server ${guildId}: set a channel or a role.`);
    return;
  }

  // Message and role are independent: one failing must not stop the other.
  if (s.channel) {
    try {
      const guild = await cillhub.call('guilds.get', { guild_id: guildId });
      const content = String(s.message || 'Welcome {user} to {server}!')
        // Function replacements, so a '$' in a server name is not read as a pattern.
        .replaceAll('{user}', () => `<@${user.id}>`)
        .replaceAll('{server}', () => guild.name);
      await cillhub.messages.send(s.channel, {
        content,
        // Ping only the new member, even if the template contains @everyone or role mentions.
        allowed_mentions: { parse: [], users: [user.id] },
      });
    } catch (err) {
      console.error(`Welcome message in ${s.channel} failed: ${err.code || ''} ${err.message}`);
    }
  }

  if (s.role) {
    try {
      await cillhub.call('members.add_role', { guild_id: guildId, user_id: user.id, role_id: s.role });
    } catch (err) {
      const hint = err.code === 'FORBIDDEN' ? ' (is the role above the module role?)' : '';
      console.error(`Giving role ${s.role} to ${user.id} failed: ${err.code || ''} ${err.message}${hint}`);
    }
  }
});
