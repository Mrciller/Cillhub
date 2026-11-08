// Support Ticket Desk: modmail & ticket system with role access, claims, and closure logs.

const ADMIN_OR_MANAGE = 0x8n | 0x20n; // ADMINISTRATOR | MANAGE_GUILD
const CATEGORIES = ['General', 'Bug', 'Moderation', 'Account'];
const MAX_TICKETS = 200;

const storageKey = (guildId) => `tickets:${guildId}`;

async function loadStore(guildId) {
  const store = await cillhub.call('storage.get', { key: storageKey(guildId) });
  if (!store || !Array.isArray(store.tickets)) {
    return { seq: 0, tickets: [] };
  }
  return store;
}

async function saveStore(guildId, store) {
  await cillhub.call('storage.set', { key: storageKey(guildId), value: store });
  try {
    await cillhub.call('ui.publish', { guild_id: guildId, data: { type: 'tickets_updated' } });
  } catch (err) {
    console.warn(`ui.publish failed: ${err.message}`);
  }
}

function isStaff(member, settings) {
  if (!member) return false;
  try {
    const perms = BigInt(member.permissions || '0');
    if ((perms & ADMIN_OR_MANAGE) !== 0n) return true;
  } catch {}
  if (settings?.staff_role && Array.isArray(member.roles) && member.roles.includes(settings.staff_role)) {
    return true;
  }
  return false;
}

cillhub.on('UI_REQUEST', async (req) => {
  const guildId = req.guild_id;
  const data = req.data && typeof req.data === 'object' ? req.data : {};
  const settings = (await cillhub.call('settings.get', { guild_id: guildId })) || {};
  const staff = isStaff(req.member, settings);
  const me = {
    id: req.user.id,
    name: req.user.global_name || req.user.username,
  };

  const store = await loadStore(guildId);

  const getFilteredView = () => {
    const tickets = staff
      ? store.tickets
      : store.tickets.filter((t) => t.user_id === me.id);
    return {
      tickets: tickets.sort((a, b) => b.updated_at - a.updated_at),
      is_staff: staff,
      user_id: me.id,
      categories: CATEGORIES,
    };
  };

  if (data.action === 'list') {
    return getFilteredView();
  }

  if (data.action === 'open') {
    if (store.tickets.length >= MAX_TICKETS) {
      throw new Error(`This server has reached the maximum of ${MAX_TICKETS} tickets. Please close older tickets.`);
    }

    const category = CATEGORIES.includes(data.category) ? data.category : 'General';
    const subject = String(data.subject || '').trim();
    if (!subject || subject.length > 100) {
      throw new Error('Subject must be between 1 and 100 characters.');
    }
    const initialMessage = String(data.message || '').trim();
    if (!initialMessage || initialMessage.length > 2000) {
      throw new Error('Message must be between 1 and 2000 characters.');
    }

    store.seq = (store.seq || 0) + 1;
    const ticketId = `T-${store.seq}`;
    const msgId = await cillhub.call('crypto.random', { bytes: 4 });

    const newTicket = {
      id: ticketId,
      number: store.seq,
      guild_id: guildId,
      user_id: me.id,
      user_name: me.name,
      category,
      subject,
      status: 'open',
      claimed_by: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      closed_at: null,
      closed_by: null,
      close_reason: null,
      messages: [
        {
          id: msgId,
          author_id: me.id,
          author_name: me.name,
          is_staff: false,
          is_system: false,
          content: initialMessage,
          timestamp: Date.now(),
        },
      ],
    };

    store.tickets.unshift(newTicket);
    await saveStore(guildId, store);

    // Optional notification to log channel
    if (settings.log_channel) {
      try {
        await cillhub.call('messages.send', {
          channel_id: settings.log_channel,
          content: `🎫 **Ticket #${newTicket.number} Opened** [${category}]\n**Subject:** ${subject}\n**Author:** <@${me.id}>`,
          allowed_mentions: { parse: [] },
        });
      } catch (err) {
        console.warn(`Failed to post new ticket notification to log_channel: ${err.message}`);
      }
    }

    return getFilteredView();
  }

  const ticket = store.tickets.find((t) => t.id === data.id);
  if (!ticket) throw new Error('Ticket not found.');

  if (data.action === 'reply') {
    if (ticket.status === 'closed') {
      throw new Error('This ticket is closed. It must be reopened before adding replies.');
    }
    if (!staff && ticket.user_id !== me.id) {
      throw new Error('You do not have permission to reply to this ticket.');
    }
    const content = String(data.message || '').trim();
    if (!content || content.length > 2000) {
      throw new Error('Reply message must be between 1 and 2000 characters.');
    }

    const msgId = await cillhub.call('crypto.random', { bytes: 4 });
    ticket.messages.push({
      id: msgId,
      author_id: me.id,
      author_name: me.name,
      is_staff: staff,
      is_system: false,
      content,
      timestamp: Date.now(),
    });
    ticket.updated_at = Date.now();

    await saveStore(guildId, store);
    return getFilteredView();
  }

  if (data.action === 'claim') {
    if (!staff) throw new Error('Only support staff can claim tickets.');
    if (ticket.status === 'closed') throw new Error('Cannot claim a closed ticket.');

    ticket.claimed_by = { id: me.id, name: me.name };
    ticket.status = 'claimed';
    ticket.updated_at = Date.now();

    const msgId = await cillhub.call('crypto.random', { bytes: 4 });
    ticket.messages.push({
      id: msgId,
      author_id: me.id,
      author_name: 'System',
      is_staff: true,
      is_system: true,
      content: `📌 ${me.name} claimed this ticket.`,
      timestamp: Date.now(),
    });

    await saveStore(guildId, store);
    return getFilteredView();
  }

  if (data.action === 'close') {
    if (!staff && ticket.user_id !== me.id) {
      throw new Error('You do not have permission to close this ticket.');
    }
    if (ticket.status === 'closed') return getFilteredView();

    const reason = String(data.reason || 'Resolved').trim().slice(0, 100);
    ticket.status = 'closed';
    ticket.closed_at = Date.now();
    ticket.closed_by = { id: me.id, name: me.name };
    ticket.close_reason = reason;
    ticket.updated_at = Date.now();

    const msgId = await cillhub.call('crypto.random', { bytes: 4 });
    ticket.messages.push({
      id: msgId,
      author_id: me.id,
      author_name: 'System',
      is_staff: staff,
      is_system: true,
      content: `🔒 Ticket closed by ${me.name}: ${reason}`,
      timestamp: Date.now(),
    });

    await saveStore(guildId, store);

    // Summary embed to log_channel if configured
    if (settings.log_channel) {
      try {
        const durationMins = Math.max(1, Math.round((ticket.closed_at - ticket.created_at) / 60000));
        await cillhub.call('messages.send', {
          channel_id: settings.log_channel,
          embeds: [
            {
              title: `🎫 Ticket #${ticket.number} Closed: ${ticket.subject}`,
              color: 0x3dd68c,
              fields: [
                { name: 'Category', value: ticket.category, inline: true },
                { name: 'Author', value: `<@${ticket.user_id}>`, inline: true },
                { name: 'Claimed By', value: ticket.claimed_by ? ticket.claimed_by.name : 'Unassigned', inline: true },
                { name: 'Closed By', value: me.name, inline: true },
                { name: 'Resolution Reason', value: reason, inline: true },
                { name: 'Duration', value: `${durationMins} min(s)`, inline: true },
                { name: 'Total Messages', value: String(ticket.messages.length), inline: true },
              ],
              footer: { text: `Ticket ID: ${ticket.id}` },
              timestamp: new Date().toISOString(),
            },
          ],
        });
      } catch (err) {
        console.warn(`Failed to post ticket close log to ${settings.log_channel}: ${err.message}`);
      }
    }

    return getFilteredView();
  }

  if (data.action === 'reopen') {
    if (!staff) throw new Error('Only support staff can reopen closed tickets.');
    ticket.status = 'open';
    ticket.closed_at = null;
    ticket.closed_by = null;
    ticket.updated_at = Date.now();

    const msgId = await cillhub.call('crypto.random', { bytes: 4 });
    ticket.messages.push({
      id: msgId,
      author_id: me.id,
      author_name: 'System',
      is_staff: true,
      is_system: true,
      content: `🔓 Ticket reopened by ${me.name}.`,
      timestamp: Date.now(),
    });

    await saveStore(guildId, store);
    return getFilteredView();
  }

  throw new Error(`Unknown action: ${data.action}`);
});

cillhub.on('INTERACTION_CREATE', async (i) => {
  const guildId = i.guild_id;
  if (!guildId) {
    return { type: 4, data: { content: 'Support tickets can only be used in servers.', flags: 64 } };
  }

  if (i.type === 2 && i.data?.name === 'ticket') {
    const opts = {};
    for (const o of i.data.options || []) opts[o.name] = o.value;

    const user = i.member?.user ?? i.user;
    const store = await loadStore(guildId);
    const settings = (await cillhub.call('settings.get', { guild_id: guildId })) || {};

    if (opts.subject && opts.message) {
      store.seq = (store.seq || 0) + 1;
      const ticketId = `T-${store.seq}`;
      const msgId = await cillhub.call('crypto.random', { bytes: 4 });
      const category = CATEGORIES.includes(opts.category) ? opts.category : 'General';
      const subject = String(opts.subject).trim().slice(0, 100);
      const msg = String(opts.message).trim().slice(0, 2000);

      const newTicket = {
        id: ticketId,
        number: store.seq,
        guild_id: guildId,
        user_id: user.id,
        user_name: user.global_name || user.username,
        category,
        subject,
        status: 'open',
        claimed_by: null,
        created_at: Date.now(),
        updated_at: Date.now(),
        closed_at: null,
        closed_by: null,
        close_reason: null,
        messages: [{ id: msgId, author_id: user.id, author_name: user.global_name || user.username, is_staff: false, is_system: false, content: msg, timestamp: Date.now() }],
      };

      store.tickets.unshift(newTicket);
      await saveStore(guildId, store);

      if (settings.log_channel) {
        try {
          await cillhub.call('messages.send', {
            channel_id: settings.log_channel,
            content: `🎫 **Ticket #${newTicket.number} Opened** [${category}]\n**Subject:** ${subject}\n**Author:** <@${user.id}>`,
            allowed_mentions: { parse: [] },
          });
        } catch {}
      }

      return {
        type: 4,
        data: {
          content: `✅ Ticket **#${newTicket.number}** (${category}: "${subject}") opened successfully! Support staff will review it. You can follow and reply in the **Support Tickets** sidebar panel.`,
          flags: 64,
        },
      };
    }

    // No subject/message provided -> show user their tickets summary
    const myTickets = store.tickets.filter((t) => t.user_id === user.id);
    const openCount = myTickets.filter((t) => t.status !== 'closed').length;
    return {
      type: 4,
      data: {
        content: `🎫 **Support Ticket Desk**\nYou have **${openCount}** open ticket(s) (total: ${myTickets.length}).\n\nOpen the **Support Tickets** panel in the server sidebar to view your tickets, send replies, or create a new support ticket!`,
        flags: 64,
      },
    };
  }
});
