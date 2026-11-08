// Support Tickets & ModMail Module for Cillhub
// Manages private support channels, welcome panels with action buttons,
// staff role access, transcripts, and ticket closure.

const VIEW_CHANNEL = 1024;
const SEND_MESSAGES = 2048;
const EMBED_LINKS = 16384;
const ATTACH_FILES = 32768;
const READ_MESSAGE_HISTORY = 65536;
const MANAGE_CHANNELS = 16;

const TICKET_PERMS = VIEW_CHANNEL | SEND_MESSAGES | EMBED_LINKS | ATTACH_FILES | READ_MESSAGE_HISTORY;
const BOT_PERMS = TICKET_PERMS | MANAGE_CHANNELS;

cillhub.on('READY', ({ module, guilds }) => {
  console.info(`Support Tickets & ModMail v${module.version} ready across ${guilds.length} server(s).`);
});

cillhub.on('INTERACTION_CREATE', async (interaction) => {
  try {
    const guildId = interaction.guild_id;
    if (!guildId) return;

    // 1. Application commands (/ticket, /modmail)
    if (interaction.type === 2) {
      const { name, options } = interaction.data;
      if (name === 'ticket') {
        const sub = options?.[0];
        const subName = sub?.name;

        if (subName === 'panel') {
          return handlePostPanel(interaction);
        }
        if (subName === 'open') {
          const subjectOpt = sub.options?.find((o) => o.name === 'subject');
          return handleOpenTicket(interaction, subjectOpt?.value);
        }
        if (subName === 'close') {
          const reasonOpt = sub.options?.find((o) => o.name === 'reason');
          return handleCloseTicket(interaction, reasonOpt?.value);
        }
      }

      if (name === 'modmail') {
        const sub = options?.[0];
        if (sub?.name === 'send') {
          const msgOpt = sub.options?.find((o) => o.name === 'message');
          return handleModmailSend(interaction, msgOpt?.value);
        }
      }
    }

    // 2. Component interactions (buttons)
    if (interaction.type === 3) {
      const customId = interaction.data?.custom_id;
      if (customId === 'ticket_open') {
        return handleOpenTicket(interaction);
      }
      if (customId === 'ticket_close') {
        return handleCloseTicket(interaction);
      }
    }
  } catch (err) {
    console.error('Error handling interaction:', err);
    try {
      await cillhub.interactions.respond(interaction.id, {
        type: 4,
        data: {
          content: `⚠️ An error occurred: ${err.message || 'Operation failed'}`,
          flags: 64, // Ephemeral
        },
      });
    } catch {}
  }
});

/** Posts the public interactive ticket panel with an "Open Support Ticket" button */
async function handlePostPanel(interaction) {
  const member = interaction.member;
  const channelId = interaction.channel_id;

  // Check permissions: MANAGE_CHANNELS (0x10) or ADMINISTRATOR (0x8)
  const perms = BigInt(member?.permissions || '0');
  const isAdminOrStaff = (perms & 0x18n) !== 0n;
  if (!isAdminOrStaff) {
    return cillhub.interactions.respond(interaction.id, {
      type: 4,
      data: {
        content: '⛔ You need Manage Channels permission to deploy the ticket panel.',
        flags: 64,
      },
    });
  }

  await cillhub.messages.send(channelId, {
    embeds: [
      {
        title: '🎫 Support Tickets & ModMail',
        description:
          'Need help, have an inquiry, or want to contact server staff privately?\n\nClick the button below to open a private support ticket channel.',
        color: 0x5865f2,
        footer: { text: 'Support Desk • Staff will be notified upon creation' },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1, // Primary (blurple)
            custom_id: 'ticket_open',
            label: 'Open Support Ticket',
            emoji: { name: '🎫' },
          },
        ],
      },
    ],
  });

  return cillhub.interactions.respond(interaction.id, {
    type: 4,
    data: {
      content: '✅ Support ticket panel deployed successfully.',
      flags: 64,
    },
  });
}

/** Handles opening a new ticket channel */
async function handleOpenTicket(interaction, customSubject) {
  const guildId = interaction.guild_id;
  const user = interaction.member?.user ?? interaction.user;
  const settings = (await cillhub.settings.get(guildId)) || {};

  // Check if user already has an active ticket to avoid spam
  const userTicketKey = `tickets:user:${guildId}:${user.id}`;
  const existingChannelId = await cillhub.storage.get(userTicketKey);
  if (existingChannelId) {
    const existing = await cillhub.storage.get(`ticket:${existingChannelId}`);
    if (existing && existing.status === 'open') {
      return cillhub.interactions.respond(interaction.id, {
        type: 4,
        data: {
          content: `ℹ️ You already have an open ticket in <#${existingChannelId}>. Please resolve it before opening another.`,
          flags: 64,
        },
      });
    }
  }

  // Increment sequence number
  const counterKey = `tickets:counter:${guildId}`;
  let count = (await cillhub.storage.get(counterKey)) || 0;
  count += 1;
  await cillhub.storage.set(counterKey, count);

  const ticketNumber = String(count).padStart(4, '0');
  const channelName = `ticket-${ticketNumber}`;
  const subject = customSubject || 'General Support Request';

  // Overwrites:
  // 1. @everyone: deny VIEW_CHANNEL
  // 2. Author: allow VIEW_CHANNEL, SEND_MESSAGES, ATTACH_FILES, READ_HISTORY, etc.
  // 3. Support Role (if configured): allow ticket permissions
  const overwrites = [
    {
      id: guildId, // @everyone role ID is the guild ID
      type: 0, // role
      allow: '0',
      deny: String(VIEW_CHANNEL),
    },
    {
      id: user.id,
      type: 1, // member
      allow: String(TICKET_PERMS),
      deny: '0',
    },
  ];

  if (settings.support_role_id) {
    overwrites.push({
      id: String(settings.support_role_id),
      type: 0, // role
      allow: String(TICKET_PERMS),
      deny: '0',
    });
  }

  // Create private ticket channel
  const newChannel = await cillhub.channels.create(guildId, {
    name: channelName,
    type: 0,
    parent_id: settings.ticket_category_id || null,
    topic: `Support Ticket #${ticketNumber} | Author: ${user.global_name || user.username} (${user.id})`,
    permission_overwrites: overwrites,
  });

  // Save ticket record to storage
  const record = {
    ticket_id: count,
    ticket_number: ticketNumber,
    channel_id: newChannel.id,
    guild_id: guildId,
    user_id: user.id,
    user_name: user.global_name || user.username,
    subject,
    status: 'open',
    created_at: new Date().toISOString(),
  };
  await cillhub.storage.set(`ticket:${newChannel.id}`, record);
  await cillhub.storage.set(userTicketKey, newChannel.id);

  // Send initial welcome message with "Close Ticket" button in the newly created channel
  const welcomeText =
    settings.welcome_message ||
    'Thank you for reaching out! A support representative will be with you shortly. Please describe your inquiry in detail.';
  const roleMention = settings.support_role_id ? `<@&${settings.support_role_id}> ` : '';

  await cillhub.messages.send(newChannel.id, {
    content: `${roleMention}<@${user.id}>`,
    embeds: [
      {
        title: `🎫 Ticket #${ticketNumber}: ${subject}`,
        description: welcomeText,
        color: 0x2ecc71,
        fields: [
          {
            name: 'Ticket Creator',
            value: `<@${user.id}> (${user.global_name || user.username})`,
            inline: true,
          },
          {
            name: 'Ticket ID',
            value: `#${ticketNumber}`,
            inline: true,
          },
          {
            name: 'Status',
            value: '🟢 Open',
            inline: true,
          },
        ],
        footer: { text: 'Click "Close Ticket" below when your issue is resolved.' },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 4, // Danger (red)
            custom_id: 'ticket_close',
            label: 'Close Ticket',
            emoji: { name: '🔒' },
          },
        ],
      },
    ],
  });

  // Respond ephemerally to the user
  return cillhub.interactions.respond(interaction.id, {
    type: 4,
    data: {
      content: `🎫 Your ticket has been created: <#${newChannel.id}>`,
      flags: 64,
    },
  });
}

/** Handles modmail message command */
async function handleModmailSend(interaction, messageContent) {
  const guildId = interaction.guild_id;
  const user = interaction.member?.user ?? interaction.user;

  // Open ticket with ModMail prefix
  const subject = `ModMail: ${messageContent.slice(0, 40)}${messageContent.length > 40 ? '...' : ''}`;
  await handleOpenTicket(interaction, subject);

  // Retrieve the channel that was created
  const userTicketKey = `tickets:user:${guildId}:${user.id}`;
  const channelId = await cillhub.storage.get(userTicketKey);

  if (channelId) {
    // Send user's modmail content into the channel
    await cillhub.messages.send(channelId, {
      embeds: [
        {
          author: {
            name: user.global_name || user.username,
          },
          title: '📩 ModMail Submission',
          description: messageContent,
          color: 0x3498db,
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }
}

/** Handles closing a ticket: generates transcript, archives, and deletes channel */
async function handleCloseTicket(interaction, reason) {
  const channelId = interaction.channel_id;
  const guildId = interaction.guild_id;
  const closer = interaction.member?.user ?? interaction.user;
  const settings = (await cillhub.settings.get(guildId)) || {};

  const record = await cillhub.storage.get(`ticket:${channelId}`);
  if (!record || record.status !== 'open') {
    return cillhub.interactions.respond(interaction.id, {
      type: 4,
      data: {
        content: '⚠️ This channel is not an active support ticket.',
        flags: 64,
      },
    });
  }

  // Acknowledge closing interaction
  await cillhub.interactions.respond(interaction.id, {
    type: 4,
    data: {
      content: '🔒 Closing ticket, archiving transcript, and cleaning up channel...',
      flags: 64,
    },
  });

  // Mark record closed
  record.status = 'closed';
  record.closed_at = new Date().toISOString();
  record.closed_by = closer.id;
  record.close_reason = reason || 'Issue resolved';
  await cillhub.storage.set(`ticket:${channelId}`, record);

  // Clear user's active ticket
  await cillhub.storage.delete(`tickets:user:${guildId}:${record.user_id}`);

  // Fetch channel message history to compile transcript
  let messages = [];
  try {
    const list = await cillhub.messages.list(channelId, { limit: 100 });
    if (Array.isArray(list)) {
      messages = list.slice().reverse(); // Oldest first
    }
  } catch (err) {
    console.warn(`Failed to fetch ticket messages for transcript: ${err.message}`);
  }

  // Generate transcript text
  const header = [
    '================================================================',
    `SUPPORT TICKET TRANSCRIPT — #${record.ticket_number || record.ticket_id}`,
    `Subject:   ${record.subject}`,
    `Author:    ${record.user_name} (${record.user_id})`,
    `Closed By: ${closer.global_name || closer.username} (${closer.id})`,
    `Reason:    ${record.close_reason}`,
    `Created:   ${record.created_at}`,
    `Closed:    ${record.closed_at}`,
    `Messages:  ${messages.length}`,
    '================================================================',
    '',
  ].join('\n');

  const body = messages
    .map((m) => {
      const time = m.timestamp ? new Date(m.timestamp).toISOString() : 'Unknown Time';
      const author = m.author ? m.author.username : 'Unknown';
      const content = m.content || (m.attachments?.length ? `[${m.attachments.length} attachment(s)]` : '[Embed/Empty]');
      return `[${time}] ${author}: ${content}`;
    })
    .join('\n');

  const fullTranscript = `${header}${body}\n\n========================= END TRANSCRIPT =========================`;

  // Post transcript summary & excerpt to transcript_channel_id if configured
  if (settings.transcript_channel_id) {
    try {
      await cillhub.messages.send(settings.transcript_channel_id, {
        embeds: [
          {
            title: `📋 Closed Ticket Transcript: #${record.ticket_number || record.ticket_id}`,
            description: `**Subject:** ${record.subject}\n**Close Reason:** ${record.close_reason}`,
            color: 0x95a5a6,
            fields: [
              { name: 'Author', value: `<@${record.user_id}>`, inline: true },
              { name: 'Closed By', value: `<@${closer.id}>`, inline: true },
              { name: 'Message Count', value: String(messages.length), inline: true },
              { name: 'Opened At', value: record.created_at, inline: true },
              { name: 'Closed At', value: record.closed_at, inline: true },
            ],
            footer: { text: `Ticket ID: #${record.ticket_number || record.ticket_id}` },
          },
        ],
      });

      // Post transcript snippet (capped at 1900 chars)
      const snippet = fullTranscript.length > 1900 ? fullTranscript.slice(0, 1900) + '\n... [truncated]' : fullTranscript;
      await cillhub.messages.send(settings.transcript_channel_id, {
        content: `\`\`\`text\n${snippet}\n\`\`\``,
      });
    } catch (err) {
      console.warn(`Failed to post transcript to ${settings.transcript_channel_id}: ${err.message}`);
    }
  }

  // Delete channel
  try {
    await cillhub.channels.delete(channelId);
  } catch (err) {
    console.error(`Failed to delete channel ${channelId}:`, err);
  }
}
