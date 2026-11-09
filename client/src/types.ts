export type User = {
  id: string; username: string; discriminator: string; global_name: string | null; avatar: string | null; bot?: boolean; email?: string
  // v4 (profile fields are filled by GET /users/:id/profile; mfa_enabled only on @me)
  banner?: string | null; accent_color?: number | null; bio?: string; pronouns?: string; mfa_enabled?: boolean; system?: boolean
  instance_admin?: boolean // v6: Cillhub-wide admin (only granted with the server CLI)
  module?: boolean // v8: the bot user of an instance module (MODULE badge instead of APP)
  // v6 customization (user docs shapes; widgets are a Cillhub extra)
  theme_colors?: [number, number] | null; display_name_styles?: NameStyle | null; avatar_decoration_data?: { asset: string; sku_id: string; expires_at?: number | null } | null
  collectibles?: { nameplate?: { asset: string; sku_id: string; label?: string; palette?: string } | null } | null; profile_effect?: { id: string } | null
  primary_guild?: { identity_guild_id?: string | null; identity_enabled?: boolean | null; tag?: string | null; badge?: string | null; badge_type?: number; badge_color_primary?: string | null; badge_color_secondary?: string | null } | null; widgets?: ProfileWidget[]
}
/** font_id / effect_id per user docs (Display Name Font / Effect; fonts 100–102 are Cillhub's bundled ones); colors are 0xRRGGBB integers, [] = no own colour. */
export type NameStyle = { font_id: number; effect_id: number; colors: number[] }
/** Cillhub profile widgets (CONTRACT-v6 section 2), at most 3. */
export type SocialPlatform = 'twitch' | 'youtube' | 'x' | 'instagram' | 'tiktok' | 'steam' | 'faceit'
export type ProfileWidget = { type: 'main_game'; game: string } | { type: 'socials'; links: { platform: SocialPlatform; url: string }[] } | { type: 'rank'; game: string; rank: string }
/** An avatar decoration a server uploaded (CDN /avatar-decoration-presets/<asset>.png). */
export type GuildDecoration = { id: string; name: string; asset: string; guild_id?: string }
/** An own uploaded sound (CDN /user-sounds/<id>). */
export type UserSound = { id: string; name: string }
export type Role = {
  id: string; name: string; color: number; hoist: boolean; position: number; permissions: string; mentionable: boolean; managed?: boolean
  // v6 (permissions.mdx role object): icon CDN /roles/<role_id>/icons/<hash>.png
  colors?: { primary_color: number; secondary_color: number | null; tertiary_color?: number | null }; icon?: string | null; unicode_emoji?: string | null
}
/** Custom guild emoji (emoji.mdx). Unicode emoji have `id: null`. */
export type Emoji = { id: string | null; name: string; animated?: boolean; roles?: string[]; user?: User; available?: boolean; require_colons?: boolean }
/** format_type 1 PNG, 2 APNG, 3 LOTTIE, 4 GIF */
export type Sticker = { id: string; name: string; description?: string | null; tags?: string; format_type: number; guild_id?: string; available?: boolean; user?: User }
export type StickerItem = { id: string; name: string; format_type: number }
export type Sound = { sound_id: string; name: string; volume: number; emoji_id: string | null; emoji_name: string | null; guild_id?: string; available?: boolean; user?: User }
export type Guild = {
  id: string; name: string; icon: string | null; owner_id: string; member_count: number
  roles: Role[]; system_channel_id?: string | null
  // v3
  description?: string | null; features?: string[]; afk_channel_id?: string | null; afk_timeout?: number
  verification_level?: number; rules_channel_id?: string | null; vanity_url_code?: string | null
  emojis?: Emoji[]; stickers?: Sticker[]
  // v6: splash /splashes/<id>/<hash>.png; brand_color_primary '#rrggbb' (discovery profile); entrance_sounds_enabled and greeting_templates are Cillhub extras
  splash?: string | null; brand_color_primary?: string | null; entrance_sounds_enabled?: boolean; greeting_templates?: string[]
  voice_backend?: 'livekit' | 'cillvoice' | null // Cillhub: voice server for new calls, null = instance default
  profile?: GuildIdentity | null
  module_panels?: ModulePanel[] // v8: panels of the modules enabled in this server (READY, GUILD_CREATE, GUILD_MODULE_PANELS_UPDATE)
  guide?: GuildGuide | null // v13: Server guide with checklist and resource pages
}
export type GuildGuideAction = { id: string; title: string; description?: string | null; channel_id: string; icon?: string | null }
export type GuildGuideResource = { id: string; title: string; description?: string | null; channel_id: string; icon?: string | null }
export type GuildGuide = {
  guild_id: string; enabled: boolean; welcome_message?: string | null
  new_member_actions: GuildGuideAction[]; resource_pages: GuildGuideResource[]
}
/** A module's UI panel as guild objects carry it (CONTRACT-v8 §6.2); `url` is root-relative to the server that sent it. */
export type ModulePanel = {
  module_id: string; application_id: string; panel_id: string; slot: 'channel_panel' | 'guild_sidebar' | 'message_accessory'
  title: string; icon: string | null; height: number; url: string
}
/** Server tag as PATCH /guilds/:id/profile takes it (discovery guild profile): badge = index of our built-in badge glyphs. */
export type GuildTag = { tag: string | null; badge: number; badge_color_primary: string; badge_color_secondary: string }
/** The guild object's `profile` (guild identity): badge = uploaded badge hash, badge_type = glyph index. */
export type GuildIdentity = { tag: string; badge: string | null; badge_type: number; badge_color_primary: string | null; badge_color_secondary: string | null }
export type Overwrite = { id: string; type: 0 | 1; allow: string; deny: string }
/** 0 text, 1 DM, 2 voice, 3 group DM, 4 category, 5 announcement, 10/11/12 announcement/public/private thread, 13 stage, 15 forum, 16 media */
export type ChannelType = 0 | 1 | 2 | 3 | 4 | 5 | 10 | 11 | 12 | 13 | 15 | 16
export type ThreadMetadata = { archived: boolean; auto_archive_duration: number; archive_timestamp: string; locked: boolean; invitable?: boolean; create_timestamp?: string | null }
export type ThreadMember = { id?: string; user_id?: string; join_timestamp: string; flags: number; member?: Member }
export type ForumTag = { id: string; name: string; moderated: boolean; emoji_id: string | null; emoji_name: string | null }
export type Channel = {
  id: string; type: ChannelType; guild_id?: string; name?: string; position?: number; parent_id?: string | null
  topic?: string | null; recipients?: User[]; last_message_id: string | null
  permission_overwrites?: Overwrite[]; user_limit?: number
  // v3
  nsfw?: boolean; rate_limit_per_user?: number; flags?: number; owner_id?: string
  thread_metadata?: ThreadMetadata; member?: ThreadMember; member_count?: number; message_count?: number; total_message_sent?: number
  available_tags?: ForumTag[]; applied_tags?: string[]; default_reaction_emoji?: { emoji_id: string | null; emoji_name: string | null } | null
  default_sort_order?: number | null; default_forum_layout?: number; default_auto_archive_duration?: number; default_thread_rate_limit_per_user?: number
  // v4 group DMs (icon: /channel-icons/<id>/<hash>)
  icon?: string | null
  // v5 voice channel status (VOICE_CHANNEL_STATUS_UPDATE)
  status?: string | null
  // v6 (channel docs): emoji shown instead of # and the header accent colour
  icon_emoji?: { id: string | null; name: string | null } | null; theme_color?: number | null
  // v9 ephemeral message TTL & voice quality mode
  message_ttl?: number; quality_mode?: 'speech' | 'hifi'
  // v11 forum accepted solution
  solved_message_id?: string | null
  // v13 media channel layout
  layout_type?: number
}
export type ChannelCanvas = {
  channel_id: string
  content: string
  version: number
  updated_at: string
  updated_by: string | null
}
export type OnboardingOption = {
  id: string
  title: string
  description: string | null
  role_ids: string[]
  channel_ids: string[]
}
export type OnboardingPrompt = {
  id: string
  title: string
  single_select: boolean
  required: boolean
  options: OnboardingOption[]
}
export type GuildOnboarding = {
  guild_id: string
  enabled: boolean
  prompts: OnboardingPrompt[]
}
export type DailyAnalytics = {
  date: string
  messages_sent: number
  voice_minutes: number
  joins: number
  leaves: number
}
export type GuildAnalytics = {
  guild_id: string
  daily: DailyAnalytics[]
}
/** Activity types: 0 Playing, 1 Streaming, 2 Listening, 3 Watching, 4 Custom status, 5 Competing. */
export type Activity = {
  type: number
  name: string
  state?: string | null
  details?: string | null
  url?: string | null
  emoji?: { name: string; id?: string | null; animated?: boolean } | null
  created_at?: number
  timestamps?: { start?: number; end?: number }
  assets?: { large_image?: string; large_text?: string; small_image?: string; small_text?: string }
  party?: { id?: string; size?: [number, number] }
  buttons?: (string | { label: string; url: string })[]
  metadata?: { button_urls?: string[] }
}
export type Presence = { user: { id: string }; status: Status; activities?: Activity[] }
export type StageInstance = { id: string; guild_id: string; channel_id: string; topic: string; privacy_level: number; guild_scheduled_event_id?: string | null }
/** status 1 scheduled, 2 active, 3 completed, 4 canceled; entity_type 1 stage, 2 voice, 3 external */
export type ScheduledEvent = {
  id: string; guild_id: string; channel_id: string | null; creator_id?: string | null; creator?: User; name: string; description?: string | null
  scheduled_start_time: string; scheduled_end_time: string | null; privacy_level: number; status: number; entity_type: number
  entity_metadata: { location?: string } | null; user_count?: number; image?: string | null
}
export type GuildPayload = Guild & {
  channels?: Channel[]; members?: Member[]; presences?: Presence[]; voice_states?: VoiceState[]
  threads?: Channel[]; stage_instances?: StageInstance[]; guild_scheduled_events?: ScheduledEvent[]; soundboard_sounds?: Sound[]
  watch_sessions?: WatchSession[] // v5, optional
}
export type Attachment = {
  id: string; filename: string; size: number; content_type?: string; url: string; proxy_url?: string; width?: number; height?: number
  description?: string | null; duration_secs?: number; waveform?: string; flags?: number
}
export type Reaction = { emoji: { id: string | null; name: string; animated?: boolean }; count: number; me: boolean }
export type EmbedMedia = { url?: string; proxy_url?: string; width?: number; height?: number }
export type Embed = {
  type?: string; title?: string; description?: string; url?: string; timestamp?: string; color?: number
  footer?: { text: string; icon_url?: string; proxy_icon_url?: string }
  image?: EmbedMedia; thumbnail?: EmbedMedia; video?: EmbedMedia
  provider?: { name?: string; url?: string }
  author?: { name: string; url?: string; icon_url?: string; proxy_icon_url?: string }
  fields?: { name: string; value: string; inline?: boolean }[]
}
export type PollMedia = { text?: string; emoji?: { id?: string | null; name?: string | null; animated?: boolean } }
export type Poll = {
  question: PollMedia; answers: { answer_id: number; poll_media: PollMedia }[]; expiry: string | null
  allow_multiselect: boolean; layout_type: number
  results?: { is_finalized: boolean; answer_counts: { id: number; count: number; me_voted: boolean }[] }
  anonymous?: boolean
  allowed_role_ids?: string[]
  correct_answer_id?: number | null
  is_quiz?: boolean
}
export type MessageEdit = {
  content: string
  edited_at: string
}
export type Snippet = {
  id: string
  guild_id: string
  name: string
  content: string
  created_by: string
  created_at: string
}
export type MessageSnapshot = { message: Pick<Message, 'content' | 'timestamp' | 'edited_timestamp' | 'attachments' | 'embeds' | 'mentions' | 'type'> & { flags?: number; sticker_items?: StickerItem[]; mention_roles?: string[] } }
export type Message = {
  id: string; type: number; channel_id: string; guild_id?: string; author: User; content: string
  timestamp: string; edited_timestamp: string | null; mentions: User[]; attachments: Attachment[]; embeds: Embed[]; pinned: boolean
  nonce?: string; reactions?: Reaction[]; mention_everyone?: boolean; mention_roles?: string[]
  /** type 0 default (reply), 1 forward */
  message_reference?: { type?: number; message_id: string; channel_id?: string; guild_id?: string }
  referenced_message?: Message | null
  // v3
  flags?: number; webhook_id?: string; thread?: Channel; poll?: Poll; sticker_items?: StickerItem[]; message_snapshots?: MessageSnapshot[]
  // v4: bots and interactions
  application_id?: string; components?: Component[]
  module_accessory?: { module_id: string; panel_id: string } // v8: a module panel shown under this message
  call?: { participants: string[]; ended_timestamp: string | null }
  e2ee_envelope?: { ciphertext: string; iv: string; sender_key?: string; recipient_key?: string }
  interaction_metadata?: { id: string; type: number; user: User; name?: string; command_type?: number; target_user?: { id: string }; target_message_id?: string }
  interaction?: { id: string; type: number; name: string; user: User }
  // client-only optimistic-send state
  pending?: boolean; failed?: boolean; progress?: number; files?: Draft[]
}
/** A file waiting to be sent, with the per-file options from the composer. */
export type Draft = { file: File; spoiler: boolean; description: string }
export type Member = {
  user: User; nick: string | null; roles: string[]; joined_at: string; mute?: boolean; deaf?: boolean
  communication_disabled_until?: string | null; pending?: boolean
  // v4 server profile: /guilds/<guild_id>/users/<user_id>/avatars|banners/<hash>
  avatar?: string | null; banner?: string | null; bio?: string | null
  display_name_styles?: NameStyle | null // v6 per-server name style
}
export type Invite = {
  code: string; guild: { id: string; name: string; icon: string | null; member_count?: number; splash?: string | null; brand_color_primary?: string | null; description?: string | null }
  channel: { id: string; name: string; type: number }; inviter?: User; uses: number
  approximate_member_count?: number; max_age?: number; max_uses?: number; created_at?: string; expires_at?: string | null
}
export type Status = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline'
/** guild_id is null for DM and group DM calls (CONTRACT-v4 section 1). */
export type VoiceState = {
  guild_id: string | null; channel_id: string | null; user_id: string; session_id: string
  self_mute: boolean; self_deaf: boolean; self_video?: boolean; self_stream?: boolean; mute: boolean; deaf: boolean; member?: Member
  suppress?: boolean; request_to_speak_timestamp?: string | null
}
/** 1 friend, 2 blocked, 3 incoming request, 4 outgoing request */
export type Relationship = { id: string; type: 1 | 2 | 3 | 4; user: User }
export type ReadState = { id: string; last_message_id: string | null; mention_count: number }
export type Ban = { user: User; reason: string | null }
export type AuditLogEntry = {
  id: string; user_id: string | null; target_id: string | null; action_type: number; reason?: string
  changes?: { key: string; old_value?: unknown; new_value?: unknown }[]; options?: Record<string, string>
}
export type AuditLog = { audit_log_entries: AuditLogEntry[]; users: User[]; webhooks?: Webhook[]; threads?: Channel[]; auto_moderation_rules?: AutoModRule[]; guild_scheduled_events?: ScheduledEvent[] }
/** trigger_type 1 KEYWORD, 5 MENTION_SPAM, 6 MEMBER_PROFILE; action type 1 BLOCK_MESSAGE, 2 SEND_ALERT_MESSAGE, 3 TIMEOUT, 4 BLOCK_MEMBER_INTERACTION */
export type AutoModAction = { type: number; metadata?: { channel_id?: string; duration_seconds?: number; custom_message?: string } }
export type AutoModRule = {
  id: string; guild_id: string; name: string; creator_id?: string; event_type: number; trigger_type: number
  trigger_metadata: { keyword_filter?: string[]; regex_patterns?: string[]; allow_list?: string[]; mention_total_limit?: number; mention_raid_protection_enabled?: boolean }
  actions: AutoModAction[]; enabled: boolean; exempt_roles: string[]; exempt_channels: string[]
}
/** type 1 incoming, 2 channel follower */
export type Webhook = { id: string; type: number; guild_id?: string; channel_id: string | null; name: string | null; avatar: string | null; token?: string; url?: string; user?: User; source_guild?: { id: string; name: string }; source_channel?: { id: string; name: string } }
export type WelcomeScreen = {
  description: string | null; welcome_channels: { channel_id: string; description: string; emoji_id: string | null; emoji_name: string | null }[]; enabled?: boolean
  background?: string | null; accent_color?: number | null // v6 Cillhub extras: CDN /welcome-backgrounds/<guild_id>/<hash>
}
export type MemberVerification = { version: string | null; description?: string | null; form_fields: { field_type: string; label: string; values?: string[] | null; required: boolean; response?: unknown }[] }
export type Gif = { id: string; title: string; url: string; src: string; width: number; height: number; preview: string }
/** A favourite GIF (validated in server/src/userdata.js): url = the link that is sent (unique), src = what is shown; 0 = unknown size. */
export type FavoriteGif = { url: string; src: string; width: number; height: number; format: 'gif' | 'mp4' | 'webm' | 'image' }

// ---------- v4 ----------
/** A DM / group DM call (CALL_CREATE / CALL_UPDATE). */
export type Call = { channel_id: string; message_id?: string; region?: string; ringing: string[] }

/** Per-guild notification settings (user docs: user_guild_settings). message_notifications: 0 all, 1 mentions, 2 nothing, 3 inherit (overrides). */
export type MuteConfig = { end_time?: string | null; selected_time_window?: number } | null
export type ChannelOverride = { channel_id: string; message_notifications: number; muted: boolean; mute_config: MuteConfig; collapsed?: boolean }
export type UserGuildSettings = {
  guild_id: string | null; message_notifications: number; suppress_everyone: boolean; suppress_roles: boolean; muted: boolean
  mute_config: MuteConfig; mobile_push: boolean; hide_muted_channels: boolean; channel_overrides: ChannelOverride[]; flags?: number; version?: number
}

/** GET/PATCH /users/@me/settings (the API reference names where it has the setting). */
export type GuildFolder = { id: number | null; name: string | null; color: number | null; guild_ids: string[] }
export type CustomStatus = { text: string | null; emoji_id: string | null; emoji_name: string | null; expires_at: string | null }
export type UserSettings = {
  status?: Status; theme?: 'dark' | 'light' | 'ash' | 'onyx'; message_display_compact?: boolean; font_size?: number; zoom?: number
  reduced_motion?: 'auto' | 'on' | 'off'; saturation?: number; render_embeds?: boolean; inline_embed_media?: boolean
  animate_emoji?: boolean | 'always' | 'hover' | 'never'; animate_stickers?: 0 | 1 | 2 | 'always' | 'hover' | 'never'; developer_mode?: boolean; locale?: 'en-US' | 'de'
  timestamp_hour_cycle?: 'auto' | 'h12' | 'h23'; guild_folders?: GuildFolder[]; guild_positions?: string[]; custom_status?: CustomStatus | null
  // v6 (CONTRACT-v6 section 1)
  custom_themes?: CustomTheme[]; active_theme?: string | null; custom_css?: string; custom_css_enabled?: boolean
  chat_font?: ChatFont; chat_line_height?: number; message_spacing?: number; chat_background?: string | null; chat_background_opacity?: number
  default_emoji_skin_tone?: number; show_avatars?: boolean; show_timestamps?: boolean
  sound_settings?: SoundSettings; entrance_sound?: { sound_id: string; guild_id: string | null } | null; keybinds?: Record<string, string | null>
  privacy?: { dm_read_receipts?: boolean }
  favorite_gifs?: FavoriteGif[]
}
/** Colours are '#rrggbb'; gradient = two stops for the app background. */
export type CustomTheme = { id: string; name: string; background: string; surface: string; accent: string; text: string; gradient: [string, string] | null }
export type ChatFont = 'system' | 'inter' | 'jetbrains-mono' | 'opendyslexic'
export type SoundKind = 'message' | 'mention' | 'dm' | 'ring' | 'join' | 'leave' | 'mute' | 'deafen'
/** sound: a built-in set id (the set's tone for that event), 'user:<id>' (an own upload) or null (off); volumes 0–100. A missing event = the Cillhub set. */
export type SoundSettings = { muted: boolean; volume: number; events: Partial<Record<SoundKind, { sound: string | null; volume: number }>> }

export type UserConnection = {
  id: string; user_id?: string; type: string; name: string; verified: boolean; show_on_profile: boolean
  metadata?: Record<string, any> | null; created_at?: string
}

export type Profile = {
  user: User; user_profile?: { bio?: string; pronouns?: string; banner?: string | null; accent_color?: number | null; theme_colors?: [number, number] | null; profile_effect?: { id: string } | null; widgets?: ProfileWidget[] }
  guild_member?: Member; guild_member_profile?: { guild_id?: string; bio?: string; pronouns?: string; banner?: string | null }
  mutual_guilds?: { id: string; nick: string | null }[]; mutual_friends?: User[]; mutual_friends_count?: number
  premium_since?: string | null; application?: { id: string; flags?: number }
  connected_accounts?: UserConnection[]
}

export type AuthSession = { id_hash: string; approx_last_used_time: string; client_info: { os: string | null; platform: string | null; location: string | null }; current?: boolean }

/** flags: 1 << 13 GATEWAY_PRESENCE_LIMITED, 1 << 15 GATEWAY_GUILD_MEMBERS_LIMITED, 1 << 19 GATEWAY_MESSAGE_CONTENT_LIMITED */
export type Application = {
  id: string; name: string; description: string; icon: string | null; flags?: number; bot?: User & { token?: string }; bot_public?: boolean
  interactions_endpoint_url?: string | null; verify_key?: string; owner?: User
}

/** Application commands (interactions/application-commands.mdx). type 1 CHAT_INPUT, 2 USER, 3 MESSAGE. */
export type CommandChoice = { name: string; value: string | number }
export type CommandOption = {
  type: number; name: string; description: string; required?: boolean; choices?: CommandChoice[]; options?: CommandOption[]
  channel_types?: number[]; min_value?: number; max_value?: number; min_length?: number; max_length?: number; autocomplete?: boolean
}
export type AppCommand = {
  id: string; type?: number; application_id: string; guild_id?: string; name: string; description: string; options?: CommandOption[]
  default_member_permissions?: string | null; dm_permission?: boolean; contexts?: number[] | null; version: string
}
export type CommandIndex = { applications: { id: string; name: string; description: string; icon: string | null; bot_id?: string; bot?: User }[]; application_commands: AppCommand[]; version?: string }

/** Message components (components/*.mdx): 1 action row, 2 button, 3 string select, 4 text input, 5 user, 6 role, 7 mentionable, 8 channel select, 18 label. */
export type SelectOption = { label: string; value: string; description?: string; emoji?: { id?: string | null; name?: string | null; animated?: boolean }; default?: boolean }
export type Component = {
  type: number; id?: number; custom_id?: string; components?: Component[]; component?: Component
  style?: number; label?: string; emoji?: { id?: string | null; name?: string | null; animated?: boolean }; url?: string; disabled?: boolean; sku_id?: string
  options?: SelectOption[]; placeholder?: string; min_values?: number; max_values?: number; channel_types?: number[]; default_values?: { id: string; type: string }[]
  min_length?: number; max_length?: number; required?: boolean; value?: string; description?: string
}

// ---------- v5 ----------
/** Watch Together (CONTRACT-v5 section 1). started_at: server time (ISO or ms) when playback last (re)started at `position` seconds. */
export type WatchVideo = { video_id: string; title: string; added_by: string }
export type WatchSession = {
  channel_id: string; guild_id?: string; host_id: string; queue: WatchVideo[]; control: 'host' | 'everyone'
  current: { video_id: string; title?: string; started_at: string | number; position: number; playing: boolean; rate: number } | null
}
/** A message scheduled with "Send later". */
export type ScheduledMessage = { id: string; channel_id: string; guild_id?: string | null; content: string; send_at: string }
export type SavedMessageFolder = {
  id: string; user_id: string; name: string; color?: string | null; icon?: string | null; created_at: string
}
/** Saved message with a reminder (user docs: GET /users/@me/saved-messages). */
export type SavedMessage = {
  message: Message | null
  save_data: { channel_id: string; message_id: string; guild_id?: string; saved_at: string; due_at: string | null; notes?: string; folder_id?: string | null; tags?: string[]; author_summary?: string; message_summary?: string }
  folder_id?: string | null
  tags?: string[]
}
/** guild-template.mdx; serialized_source_guild uses integer placeholder ids. */
export type GuildTemplate = {
  code: string; name: string; description: string | null; usage_count: number; creator_id: string; creator?: User
  created_at: string; updated_at: string; source_guild_id: string; serialized_source_guild: GuildSnapshot; is_dirty: boolean | null
  external?: boolean // fetched from another app's template link
}
export type SnapshotRole = { id: number; name: string; permissions: string; color: number; hoist: boolean; mentionable: boolean }
export type SnapshotChannel = {
  id: number; type: number; name: string; position: number; topic?: string | null; nsfw?: boolean; rate_limit_per_user?: number; user_limit?: number; bitrate?: number
  parent_id: number | null; permission_overwrites: { id: number; type: 0; allow: string; deny: string }[]
  available_tags?: { name: string; moderated: boolean; emoji_id: string | null; emoji_name: string | null }[]; default_reaction_emoji?: Channel['default_reaction_emoji']
}
export type GuildSnapshot = {
  name: string; description: string | null; verification_level: number; default_message_notifications: number; explicit_content_filter: number
  preferred_locale: string; afk_timeout: number; afk_channel_id: number | null; system_channel_id: number | null; system_channel_flags: number
  roles: SnapshotRole[]; channels: SnapshotChannel[]; icon_hash?: string | null
  emojis?: { name: string; animated: boolean; roles: number[]; image: string }[] // Cillhub addition (data URIs)
}
