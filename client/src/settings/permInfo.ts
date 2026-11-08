import { P, type PermName } from '../permissions'

/** `text`/`voice`/`stage` mark permissions that make sense as overwrites on those channel kinds (forum and announcement count as text). */
export type PermInfo = { name: PermName; label: string; note: string; text?: boolean; voice?: boolean }
export const PERM_GROUPS: { title: string; perms: PermInfo[] }[] = [
  { title: 'General Server Permissions', perms: [
    { name: 'VIEW_CHANNEL', label: 'View Channels', note: 'Allows members to view channels by default (excluding private channels).', text: true, voice: true },
    { name: 'MANAGE_CHANNELS', label: 'Manage Channels', note: 'Allows members to create, edit, or delete channels.', text: true, voice: true },
    { name: 'MANAGE_ROLES', label: 'Manage Roles', note: 'Allows members to create new roles and edit or delete roles lower than their highest role.', text: true, voice: true },
    { name: 'CREATE_GUILD_EXPRESSIONS', label: 'Create Expressions', note: 'Allows members to add custom emoji, stickers, and sounds, and edit or remove the ones they added.' },
    { name: 'MANAGE_GUILD_EXPRESSIONS', label: 'Manage Expressions', note: 'Allows members to edit or remove custom emoji, stickers, and sounds.' },
    { name: 'VIEW_AUDIT_LOG', label: 'View Audit Log', note: "Allows members to view a record of who made which changes in this server." },
    { name: 'MANAGE_WEBHOOKS', label: 'Manage Webhooks', note: 'Allows members to create, edit, or delete webhooks, which can post messages from other apps or sites.', text: true },
    { name: 'MANAGE_GUILD', label: 'Manage Server', note: "Allows members to change this server's name, icon and settings, AutoMod rules, and to see and remove invites." },
  ] },
  { title: 'Membership Permissions', perms: [
    { name: 'CREATE_INSTANT_INVITE', label: 'Create Invite', note: 'Allows members to invite new people to this server.', text: true, voice: true },
    { name: 'CHANGE_NICKNAME', label: 'Change Nickname', note: 'Allows members to change their own nickname.' },
    { name: 'MANAGE_NICKNAMES', label: 'Manage Nicknames', note: 'Allows members to change the nicknames of other members.' },
    { name: 'KICK_MEMBERS', label: 'Kick Members', note: 'Allows members to remove other members from this server.' },
    { name: 'BAN_MEMBERS', label: 'Ban Members', note: 'Allows members to permanently ban other members from this server.' },
    { name: 'MODERATE_MEMBERS', label: 'Timeout Members', note: 'Allows members to time out other members: they cannot send or react to messages, or speak in voice, for a while.' },
  ] },
  { title: 'Text Channel Permissions', perms: [
    { name: 'SEND_MESSAGES', label: 'Send Messages and Create Posts', note: 'Allows members to send messages in text channels and create posts in forum channels.', text: true, voice: true },
    { name: 'SEND_MESSAGES_IN_THREADS', label: 'Send Messages in Threads and Posts', note: 'Allows members to send messages in threads and forum posts.', text: true },
    { name: 'CREATE_PUBLIC_THREADS', label: 'Create Public Threads', note: 'Allows members to create threads that everyone in a channel can view.', text: true },
    { name: 'CREATE_PRIVATE_THREADS', label: 'Create Private Threads', note: 'Allows members to create invite-only threads.', text: true },
    { name: 'EMBED_LINKS', label: 'Embed Links', note: 'Allows links that members share to show embedded content.', text: true, voice: true },
    { name: 'ATTACH_FILES', label: 'Attach Files', note: 'Allows members to upload files or media.', text: true, voice: true },
    { name: 'ADD_REACTIONS', label: 'Add Reactions', note: 'Allows members to add new emoji reactions to a message.', text: true, voice: true },
    { name: 'USE_EXTERNAL_EMOJIS', label: 'Use External Emoji', note: 'Allows members to use emoji from other servers.', text: true, voice: true },
    { name: 'USE_EXTERNAL_STICKERS', label: 'Use External Stickers', note: 'Allows members to use stickers from other servers.', text: true, voice: true },
    { name: 'MENTION_EVERYONE', label: 'Mention @everyone, @here, and All Roles', note: 'Allows members to notify everyone and to mention roles that are not mentionable.', text: true, voice: true },
    { name: 'MANAGE_MESSAGES', label: 'Manage Messages', note: 'Allows members to delete and pin messages by other members, remove embeds, and skip slowmode.', text: true, voice: true },
    { name: 'MANAGE_THREADS', label: 'Manage Threads and Posts', note: 'Allows members to rename, delete, archive, lock and pin threads and posts, and to view all private threads.', text: true },
    { name: 'READ_MESSAGE_HISTORY', label: 'Read Message History', note: 'Allows members to read previous messages sent in channels.', text: true, voice: true },
    { name: 'SEND_VOICE_MESSAGES', label: 'Send Voice Messages', note: 'Allows members to send voice messages.', text: true, voice: true },
    { name: 'SEND_POLLS', label: 'Create Polls', note: 'Allows members to create polls.', text: true, voice: true },
    { name: 'USE_APPLICATION_COMMANDS', label: 'Use Application Commands', note: 'Allows members to use commands from applications.', text: true, voice: true },
  ] },
  { title: 'Voice Channel Permissions', perms: [
    { name: 'CONNECT', label: 'Connect', note: 'Allows members to join voice channels and hear others.', voice: true },
    { name: 'SPEAK', label: 'Speak', note: 'Allows members to talk in voice channels.', voice: true },
    { name: 'STREAM', label: 'Video', note: 'Allows members to share their camera and screen.', voice: true },
    { name: 'USE_SOUNDBOARD', label: 'Use Soundboard', note: 'Allows members to play sounds from the server soundboard.', voice: true },
    { name: 'USE_EXTERNAL_SOUNDS', label: 'Use External Sounds', note: 'Allows members to use sounds from other servers.', voice: true },
    { name: 'PRIORITY_SPEAKER', label: 'Priority Speaker', note: 'Allows members to be more easily heard in voice channels.', voice: true },
    { name: 'REQUEST_TO_SPEAK', label: 'Request to Speak', note: 'Allows members to request to speak in stage channels.', voice: true },
    { name: 'MUTE_MEMBERS', label: 'Mute Members', note: 'Allows members to mute other members in voice channels for everyone, and to moderate stages.', voice: true },
    { name: 'DEAFEN_MEMBERS', label: 'Deafen Members', note: 'Allows members to deafen other members in voice channels.', voice: true },
    { name: 'MOVE_MEMBERS', label: 'Move Members', note: 'Allows members to disconnect or move other members between voice channels.', voice: true },
  ] },
  { title: 'Events Permissions', perms: [
    { name: 'CREATE_EVENTS', label: 'Create Events', note: 'Allows members to create events, and edit and cancel the ones they created.', voice: true },
    { name: 'MANAGE_EVENTS', label: 'Manage Events', note: 'Allows members to edit and cancel all events.', voice: true },
  ] },
  { title: 'Advanced Permissions', perms: [
    { name: 'ADMINISTRATOR', label: 'Administrator', note: 'Members with this permission have every permission and bypass channel-specific permissions. This is a dangerous permission to grant.' },
  ] },
]
export const bit = (name: PermName) => P[name]
