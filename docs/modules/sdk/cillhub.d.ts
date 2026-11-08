// Type declarations for the `cillhub` global that module code sees in the sandbox
// (docs/CONTRACT-v8.md §4). Declarations only: nothing here runs.
//
// Use from plain JavaScript:
//   // @ts-check
//   /// <reference path="./cillhub.d.ts" />
// or list this file in a jsconfig.json next to your index.js.
//
// `cillhub.call(action, args)` is the canonical API. Every wrapper below is provided
// by the sandbox (§4.2) and is the same call with positional arguments.

type Snowflake = string;

// v9 shapes are large; only the fields modules use most are spelled out.
// Settings and storage values are `any`: their shape is whatever your module stores.
interface CillhubUser { id: Snowflake; username: string; global_name?: string | null; avatar?: string | null; bot?: boolean; module?: boolean; [k: string]: unknown }
interface CillhubMember { user?: CillhubUser; nick?: string | null; roles: Snowflake[]; joined_at?: string; permissions?: string; guild_id?: Snowflake; [k: string]: unknown }
interface CillhubEmbed { title?: string; description?: string; url?: string; color?: number; timestamp?: string; fields?: { name: string; value: string; inline?: boolean }[]; footer?: { text: string }; author?: { name: string; url?: string }; image?: { url: string }; thumbnail?: { url: string }; [k: string]: unknown }
interface CillhubMessage { id: Snowflake; channel_id: Snowflake; guild_id?: Snowflake; author: CillhubUser; content: string; embeds: CillhubEmbed[]; components?: unknown[]; [k: string]: unknown }
interface CillhubMessageInput {
  content?: string;
  embeds?: CillhubEmbed[];
  components?: unknown[];
  allowed_mentions?: { parse?: ('users' | 'roles' | 'everyone')[]; users?: Snowflake[]; roles?: Snowflake[]; replied_user?: boolean };
  message_reference?: { message_id: Snowflake; channel_id?: Snowflake; guild_id?: Snowflake };
  /** id of one of the module's `message_accessory` panels (§6) */
  accessory_panel?: string;
  /** 64 = ephemeral, for interaction responses and follow-ups */
  flags?: number;
}
interface CillhubChannel { id: Snowflake; type: number; name?: string; guild_id?: Snowflake; parent_id?: Snowflake | null; [k: string]: unknown }
interface CillhubRole { id: Snowflake; name: string; position: number; permissions: string; managed?: boolean; [k: string]: unknown }
interface CillhubGuild { id: Snowflake; name: string; icon?: string | null; roles?: CillhubRole[]; [k: string]: unknown }
interface CillhubInteraction {
  id: Snowflake; application_id: Snowflake;
  /** 2 command, 3 component, 4 autocomplete, 5 modal submit */
  type: number;
  data?: { name?: string; type?: number; options?: { name: string; type: number; value?: unknown; options?: unknown[] }[]; custom_id?: string; component_type?: number; values?: string[]; target_id?: Snowflake; [k: string]: unknown };
  guild_id?: Snowflake; channel_id?: Snowflake; member?: CillhubMember; user?: CillhubUser; message?: CillhubMessage; locale?: string;
  [k: string]: unknown;
}
/** v4 §6 callback body: types 4, 5, 6, 7, 8, 9 */
interface CillhubInteractionResponse { /** 4, 5, 6, 7, 8 or 9 (number, so plain-JS object literals type-check) */ type: number; data?: CillhubMessageInput & { choices?: { name: string; value: string | number }[]; custom_id?: string; title?: string } }

interface CillhubHttpRequest { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'; path: string; query: Record<string, string>; headers: Record<string, string>; body: string; body_encoding: 'utf8' | 'base64' }
interface CillhubHttpResponse { status?: number; headers?: Record<string, string>; body?: unknown }
interface CillhubUiRequest {
  panel_id: string; slot: 'channel_panel' | 'guild_sidebar' | 'message_accessory';
  guild_id: Snowflake; channel_id: Snowflake | null; message_id: Snowflake | null;
  user: CillhubUser;
  /** permissions: bitfield as a decimal string, in the channel when given, else in the server */
  member: { roles: Snowflake[]; permissions: string };
  /** from the panel: untrusted, validate it */
  data: any;
}

interface CillhubEvents {
  READY: { module: { id: string; version: string; application_id: Snowflake; permissions: string[] }; guilds: { id: Snowflake; name: string }[] };
  GUILD_CREATE: { id: Snowflake; name: string };
  GUILD_DELETE: { id: Snowflake };
  SETTINGS_UPDATE: { guild_id: Snowflake | null };
  INTERACTION_CREATE: CillhubInteraction;
  MESSAGE_CREATE: CillhubMessage;
  MESSAGE_UPDATE: Partial<CillhubMessage> & { id: Snowflake; channel_id: Snowflake };
  MESSAGE_DELETE: { id: Snowflake; channel_id: Snowflake; guild_id?: Snowflake };
  MESSAGE_DELETE_BULK: { ids: Snowflake[]; channel_id: Snowflake; guild_id?: Snowflake };
  MESSAGE_REACTION_ADD: { user_id: Snowflake; channel_id: Snowflake; message_id: Snowflake; guild_id?: Snowflake; member?: CillhubMember; emoji: { id: Snowflake | null; name: string | null }; [k: string]: unknown };
  MESSAGE_REACTION_REMOVE: { user_id: Snowflake; channel_id: Snowflake; message_id: Snowflake; guild_id?: Snowflake; emoji: { id: Snowflake | null; name: string | null }; [k: string]: unknown };
  GUILD_MEMBER_ADD: CillhubMember & { guild_id: Snowflake; user: CillhubUser };
  GUILD_MEMBER_UPDATE: CillhubMember & { guild_id: Snowflake; user: CillhubUser };
  GUILD_MEMBER_REMOVE: { guild_id: Snowflake; user: CillhubUser };
  VOICE_STATE_UPDATE: { guild_id?: Snowflake; channel_id: Snowflake | null; user_id: Snowflake; member?: CillhubMember; [k: string]: unknown };
  SCHEDULE: { name: string; at: number };
  HTTP_REQUEST: CillhubHttpRequest;
  UI_REQUEST: CillhubUiRequest;
}

interface CillhubEventResults {
  INTERACTION_CREATE: CillhubInteractionResponse | void;
  HTTP_REQUEST: CillhubHttpResponse;
  UI_REQUEST: unknown;
}
type CillhubResult<E extends keyof CillhubEvents> = E extends keyof CillhubEventResults ? CillhubEventResults[E] : void;

type StorageItem = { key: string; value: any };
type ScheduleInfo = { name: string; next_at: number; interval_ms: number | null };
type FetchResult = { status: number; headers: Record<string, string>; body: string };

/** Every action of §4.2: arguments and result. */
interface CillhubActions {
  'guilds.list': [{}, { id: Snowflake; name: string; icon: string | null }[]];
  'guilds.get': [{ guild_id: Snowflake }, CillhubGuild];
  'channels.list': [{ guild_id: Snowflake }, CillhubChannel[]];
  'channels.create': [{ guild_id: Snowflake; name: string; type?: number; parent_id?: Snowflake | null; permission_overwrites?: object[] }, CillhubChannel];
  'channels.delete': [{ channel_id: Snowflake }, CillhubChannel];
  'roles.list': [{ guild_id: Snowflake }, CillhubRole[]];
  'settings.get': [{ guild_id?: Snowflake }, Record<string, any>];
  'messages.list': [{ channel_id: Snowflake; limit?: number; before?: Snowflake; after?: Snowflake; around?: Snowflake }, CillhubMessage[]];
  'messages.get': [{ channel_id: Snowflake; message_id: Snowflake }, CillhubMessage];
  'messages.send': [{ channel_id: Snowflake } & CillhubMessageInput, CillhubMessage];
  'messages.edit': [{ channel_id: Snowflake; message_id: Snowflake; content?: string; embeds?: CillhubEmbed[]; components?: unknown[] }, CillhubMessage];
  'messages.delete': [{ channel_id: Snowflake; message_id: Snowflake }, null];
  'reactions.add': [{ channel_id: Snowflake; message_id: Snowflake; emoji: string }, null];
  'members.get': [{ guild_id: Snowflake; user_id: Snowflake }, CillhubMember];
  'members.list': [{ guild_id: Snowflake; limit?: number; after?: Snowflake }, CillhubMember[]];
  'members.add_role': [{ guild_id: Snowflake; user_id: Snowflake; role_id: Snowflake }, null];
  'members.remove_role': [{ guild_id: Snowflake; user_id: Snowflake; role_id: Snowflake }, null];
  'voice.list': [{ guild_id: Snowflake }, CillhubEvents['VOICE_STATE_UPDATE'][]];
  'interactions.respond': [{ interaction_id: Snowflake; response: CillhubInteractionResponse }, null];
  'interactions.followup': [{ interaction_id: Snowflake; message: CillhubMessageInput }, CillhubMessage];
  'interactions.edit': [{ interaction_id: Snowflake; message_id?: Snowflake | '@original'; message: CillhubMessageInput }, CillhubMessage];
  'storage.get': [{ key: string }, any];
  'storage.set': [{ key: string; value: unknown }, null];
  'storage.delete': [{ key: string }, null];
  'storage.list': [{ prefix?: string; after?: string; limit?: number }, { items: StorageItem[]; next: string | null }];
  'http.fetch': [{ url: string; method?: string; headers?: Record<string, string>; body?: string }, FetchResult];
  'schedule.every': [{ name: string; interval_ms: number }, null];
  'schedule.at': [{ name: string; at: number }, null];
  'schedule.cancel': [{ name: string }, null];
  'schedule.list': [{}, ScheduleInfo[]];
  'ui.publish': [{ guild_id: Snowflake; data: unknown }, null];
  /** encoding defaults to 'hex' */
  'crypto.hmac': [{ algorithm: 'sha256' | 'sha1'; key: string; data: string; encoding?: 'hex' | 'base64' }, string];
  /** encoding defaults to 'hex' */
  'crypto.sha256': [{ data: string; encoding?: 'hex' | 'base64' }, string];
  'crypto.random': [{ bytes: number }, string];
}

/** Rejection of every call. */
interface CillhubError extends Error {
  code: 'PERMISSION_DENIED' | 'NOT_ENABLED' | 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID' | 'RATE_LIMITED' | 'QUOTA_EXCEEDED' | 'FETCH_REFUSED' | 'TIMEOUT' | 'TOO_LARGE' | 'UNAVAILABLE';
  /** FORBIDDEN: REST status and v9 error code */
  status?: number; api_code?: number;
  /** INVALID: REST form errors */
  errors?: unknown;
  /** RATE_LIMITED: seconds */
  retry_after?: number;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface Cillhub {
  /** One handler per event name; a later call replaces it. */
  on<E extends keyof CillhubEvents>(event: E, handler: (payload: CillhubEvents[E]) => CillhubResult<E> | Promise<CillhubResult<E>>): void;
  call<A extends keyof CillhubActions>(action: A, args: CillhubActions[A][0]): Promise<CillhubActions[A][1]>;
  log(level: LogLevel, ...args: unknown[]): void;

  messages: {
    /** = call('messages.send', {channel_id, ...message}) */
    send(channelId: Snowflake, message: CillhubMessageInput): Promise<CillhubMessage>;
    edit(channelId: Snowflake, messageId: Snowflake, message: CillhubMessageInput): Promise<CillhubMessage>;
    delete(channelId: Snowflake, messageId: Snowflake): Promise<null>;
    list(channelId: Snowflake, opts?: { limit?: number; before?: Snowflake; after?: Snowflake; around?: Snowflake }): Promise<CillhubMessage[]>;
    get(channelId: Snowflake, messageId: Snowflake): Promise<CillhubMessage>;
  };
  storage: {
    get(key: string): Promise<any>;
    set(key: string, value: unknown): Promise<null>;
    delete(key: string): Promise<null>;
    list(opts?: { prefix?: string; after?: string; limit?: number }): Promise<{ items: StorageItem[]; next: string | null }>;
  };
  http: { fetch(url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<FetchResult> };
  schedule: {
    /** first fires intervalMs after it was set */
    every(name: string, intervalMs: number): Promise<null>;
    at(name: string, at: number): Promise<null>;
    cancel(name: string): Promise<null>;
    list(): Promise<ScheduleInfo[]>;
  };
  interactions: {
    respond(interactionId: Snowflake, response: CillhubInteractionResponse): Promise<null>;
    followup(interactionId: Snowflake, message: CillhubMessageInput): Promise<CillhubMessage>;
    edit(interactionId: Snowflake, message: CillhubMessageInput, messageId?: Snowflake | '@original'): Promise<CillhubMessage>;
  };
  ui: { publish(guildId: Snowflake, data: unknown): Promise<null> };
  settings: { get(guildId?: Snowflake): Promise<Record<string, any>> };
  crypto: {
    hmac(algorithm: 'sha256' | 'sha1', key: string, data: string, encoding?: 'hex' | 'base64' /* = 'hex' */): Promise<string>;
    sha256(data: string, encoding?: 'hex' | 'base64' /* = 'hex' */): Promise<string>;
    random(bytes: number): Promise<string>;
    /** Constant-time string comparison; synchronous, runs in the sandbox. */
    equal(a: string, b: string): boolean;
  };

  reactions: { add(channelId: Snowflake, messageId: Snowflake, emoji: string): Promise<null> };
  members: {
    get(guildId: Snowflake, userId: Snowflake): Promise<CillhubMember>;
    list(guildId: Snowflake, opts?: { limit?: number; after?: Snowflake }): Promise<CillhubMember[]>;
    /** = call('members.add_role', …) */
    addRole(guildId: Snowflake, userId: Snowflake, roleId: Snowflake): Promise<null>;
    /** = call('members.remove_role', …) */
    removeRole(guildId: Snowflake, userId: Snowflake, roleId: Snowflake): Promise<null>;
  };
  voice: { list(guildId: Snowflake): Promise<CillhubEvents['VOICE_STATE_UPDATE'][]> };
  guilds: { list(): Promise<{ id: Snowflake; name: string; icon: string | null }[]>; get(guildId: Snowflake): Promise<CillhubGuild> };
  channels: {
    list(guildId: Snowflake): Promise<CillhubChannel[]>;
    create(guildId: Snowflake, data: { name: string; type?: number; parent_id?: Snowflake | null; permission_overwrites?: object[] } | string): Promise<CillhubChannel>;
    delete(channelId: Snowflake): Promise<CillhubChannel>;
  };
  roles: { list(guildId: Snowflake): Promise<CillhubRole[]> };
}

declare const cillhub: Cillhub;

/** console.* writes to the module log (§4.4). Merges with lib.dom's Console if that lib is loaded. */
interface Console { log(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void; debug(...args: unknown[]): void }
declare var console: Console;
