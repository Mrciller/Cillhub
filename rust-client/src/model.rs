use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Fields used by the common shell; `extra` preserves newer server fields.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct User {
    pub id: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub discriminator: Option<String>,
    #[serde(default)]
    pub global_name: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub banner: Option<String>,
    #[serde(default)]
    pub accent_color: Option<u32>,
    #[serde(default)]
    pub bio: Option<String>,
    #[serde(default)]
    pub pronouns: Option<String>,
    #[serde(default)]
    pub bot: bool,
    #[serde(default)]
    pub system: bool,
    #[serde(default)]
    pub mfa_enabled: bool,
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub flags: u64,
    #[serde(default)]
    pub public_flags: u64,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl User {
    pub fn display_name(&self) -> &str {
        self.global_name
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.username)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Overwrite {
    pub id: String,
    #[serde(rename = "type", default)]
    pub kind: u8,
    #[serde(default = "default_zero_str")]
    pub allow: String,
    #[serde(default = "default_zero_str")]
    pub deny: String,
}

fn default_zero_str() -> String {
    "0".to_string()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ThreadMetadata {
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub auto_archive_duration: u32,
    #[serde(default)]
    pub archive_timestamp: Option<String>,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub invitable: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ForumTag {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub moderated: bool,
    #[serde(default)]
    pub emoji_id: Option<String>,
    #[serde(default)]
    pub emoji_name: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Channel {
    pub id: String,
    #[serde(rename = "type", default)]
    pub kind: u8,
    #[serde(default)]
    pub guild_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub position: i32,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub last_message_id: Option<String>,
    #[serde(default)]
    pub rate_limit_per_user: u32,
    #[serde(default)]
    pub nsfw: bool,
    #[serde(default)]
    pub bitrate: Option<u32>,
    #[serde(default)]
    pub user_limit: Option<u32>,
    #[serde(default)]
    pub rtc_region: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub message_count: Option<u32>,
    #[serde(default)]
    pub member_count: Option<u32>,
    #[serde(default)]
    pub permission_overwrites: Vec<Overwrite>,
    #[serde(default)]
    pub recipients: Vec<User>,
    #[serde(default)]
    pub thread_metadata: Option<ThreadMetadata>,
    #[serde(default)]
    pub available_tags: Vec<ForumTag>,
    #[serde(default)]
    pub applied_tags: Vec<String>,
    #[serde(default)]
    pub flags: u32,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Channel {
    pub fn display_name(&self, my_id: Option<&str>) -> String {
        if let Some(name) = self.name.as_deref().filter(|s| !s.is_empty()) {
            return name.to_string();
        }
        if !self.recipients.is_empty() {
            let names: Vec<&str> = self
                .recipients
                .iter()
                .filter(|u| Some(u.id.as_str()) != my_id)
                .map(|u| u.display_name())
                .collect();
            if !names.is_empty() {
                return names.join(", ");
            }
            return self.recipients[0].display_name().to_string();
        }
        "Direct Message".to_string()
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Role {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub color: u32,
    #[serde(default)]
    pub hoist: bool,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub unicode_emoji: Option<String>,
    #[serde(default)]
    pub position: i32,
    #[serde(default = "default_zero_str")]
    pub permissions: String,
    #[serde(default)]
    pub managed: bool,
    #[serde(default)]
    pub mentionable: bool,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Member {
    #[serde(default)]
    pub user: Option<User>,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub guild_id: Option<String>,
    #[serde(default)]
    pub nick: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub banner: Option<String>,
    #[serde(default)]
    pub bio: Option<String>,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub joined_at: String,
    #[serde(default)]
    pub deaf: bool,
    #[serde(default)]
    pub mute: bool,
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub communication_disabled_until: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Member {
    pub fn resolved_user_id(&self) -> Option<&str> {
        self.user
            .as_ref()
            .map(|u| u.id.as_str())
            .or(self.user_id.as_deref())
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Emoji {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub animated: bool,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub user: Option<User>,
    #[serde(default)]
    pub available: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Sticker {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Option<String>,
    #[serde(default)]
    pub format_type: u8,
    #[serde(default)]
    pub guild_id: Option<String>,
    #[serde(default)]
    pub user: Option<User>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Sound {
    #[serde(default)]
    pub sound_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_one_f32")]
    pub volume: f32,
    #[serde(default)]
    pub emoji_id: Option<String>,
    #[serde(default)]
    pub emoji_name: Option<String>,
    #[serde(default)]
    pub guild_id: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
}

fn default_one_f32() -> f32 {
    1.0
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct VoiceState {
    pub user_id: String,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub guild_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub deaf: bool,
    #[serde(default)]
    pub mute: bool,
    #[serde(default)]
    pub self_deaf: bool,
    #[serde(default)]
    pub self_mute: bool,
    #[serde(default)]
    pub self_stream: bool,
    #[serde(default)]
    pub self_video: bool,
    #[serde(default)]
    pub suppress: bool,
    #[serde(default)]
    pub request_to_speak_timestamp: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct StageInstance {
    pub id: String,
    pub guild_id: String,
    pub channel_id: String,
    pub topic: String,
    #[serde(default)]
    pub privacy_level: u8,
    #[serde(default)]
    pub guild_scheduled_event_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ScheduledEvent {
    pub id: String,
    pub guild_id: String,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub creator_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub scheduled_start_time: String,
    #[serde(default)]
    pub scheduled_end_time: Option<String>,
    #[serde(default)]
    pub status: u8,
    #[serde(default)]
    pub entity_type: u8,
    #[serde(default)]
    pub user_count: u32,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ActivityTimestamps {
    #[serde(default)]
    pub start: Option<u64>,
    #[serde(default)]
    pub end: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Activity {
    pub name: String,
    #[serde(rename = "type", default)]
    pub kind: u8,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub details: Option<String>,
    #[serde(default)]
    pub timestamps: Option<ActivityTimestamps>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct CustomStatus {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub emoji_name: Option<String>,
    #[serde(default)]
    pub emoji_id: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Presence {
    pub user_id: String,
    #[serde(default = "default_online_str")]
    pub status: String,
    #[serde(default)]
    pub custom_status: Option<CustomStatus>,
    #[serde(default)]
    pub activities: Vec<Activity>,
}

fn default_online_str() -> String {
    "online".to_string()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Guild {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub banner: Option<String>,
    #[serde(default)]
    pub splash: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub owner_id: String,
    #[serde(default)]
    pub system_channel_id: Option<String>,
    #[serde(default)]
    pub rules_channel_id: Option<String>,
    #[serde(default)]
    pub afk_channel_id: Option<String>,
    #[serde(default)]
    pub afk_timeout: u32,
    #[serde(default)]
    pub verification_level: u8,
    #[serde(default)]
    pub default_message_notifications: u8,
    #[serde(default)]
    pub explicit_content_filter: u8,
    #[serde(default)]
    pub vanity_url_code: Option<String>,
    #[serde(default)]
    pub preferred_locale: Option<String>,
    #[serde(default)]
    pub member_count: u32,
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub roles: Vec<Role>,
    #[serde(default)]
    pub channels: Vec<Channel>,
    #[serde(default)]
    pub threads: Vec<Channel>,
    #[serde(default)]
    pub members: Vec<Member>,
    #[serde(default)]
    pub voice_states: Vec<VoiceState>,
    #[serde(default)]
    pub presences: Vec<Value>,
    #[serde(default)]
    pub emojis: Vec<Emoji>,
    #[serde(default)]
    pub stickers: Vec<Sticker>,
    #[serde(default)]
    pub soundboard_sounds: Vec<Sound>,
    #[serde(default)]
    pub stage_instances: Vec<StageInstance>,
    #[serde(default)]
    pub guild_scheduled_events: Vec<ScheduledEvent>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub size: u64,
    pub url: String,
    #[serde(default)]
    pub proxy_url: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub duration_secs: Option<f32>,
    #[serde(default)]
    pub waveform: Option<String>,
    #[serde(default)]
    pub flags: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Reaction {
    pub count: u32,
    #[serde(default)]
    pub me: bool,
    pub emoji: Emoji,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct PollMedia {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub emoji: Option<Emoji>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct PollAnswer {
    pub answer_id: u32,
    pub poll_media: PollMedia,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct PollAnswerCount {
    pub id: u32,
    pub count: u32,
    #[serde(default)]
    pub me_voted: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct PollResults {
    #[serde(default)]
    pub is_finalized: bool,
    #[serde(default)]
    pub answer_counts: Vec<PollAnswerCount>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Poll {
    pub question: PollMedia,
    #[serde(default)]
    pub answers: Vec<PollAnswer>,
    #[serde(default)]
    pub expiry: Option<String>,
    #[serde(default)]
    pub allow_multiselect: bool,
    #[serde(default)]
    pub layout_type: u8,
    #[serde(default)]
    pub results: Option<PollResults>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct MessageReference {
    #[serde(default)]
    pub r#type: Option<u8>,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub guild_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    #[serde(default)]
    pub guild_id: Option<String>,
    #[serde(rename = "type", default)]
    pub kind: u8,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub author: Option<User>,
    #[serde(default)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub edited_timestamp: Option<String>,
    #[serde(default)]
    pub tts: bool,
    #[serde(default)]
    pub mention_everyone: bool,
    #[serde(default)]
    pub mentions: Vec<User>,
    #[serde(default)]
    pub mention_roles: Vec<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    #[serde(default)]
    pub embeds: Vec<Value>,
    #[serde(default)]
    pub reactions: Vec<Reaction>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub webhook_id: Option<String>,
    #[serde(default)]
    pub message_reference: Option<MessageReference>,
    #[serde(default)]
    pub referenced_message: Option<Box<Message>>,
    #[serde(default)]
    pub thread: Option<Channel>,
    #[serde(default)]
    pub sticker_items: Vec<Sticker>,
    #[serde(default)]
    pub poll: Option<Poll>,
    #[serde(default)]
    pub flags: u32,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Relationship {
    pub id: String,
    #[serde(rename = "type", default)]
    pub kind: u8, // 1=friend, 2=blocked, 3=incoming, 4=outgoing
    #[serde(default)]
    pub user: Option<User>,
    #[serde(default)]
    pub nickname: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ReadState {
    pub id: String,
    #[serde(default)]
    pub last_message_id: Option<String>,
    #[serde(default)]
    pub mention_count: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct GuildFolder {
    #[serde(default)]
    pub id: Option<Value>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<u32>,
    #[serde(default)]
    pub guild_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    pub base: String,
    #[serde(default)]
    pub vars: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct UserSettings {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub custom_status: Option<CustomStatus>,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub message_display_compact: bool,
    #[serde(default)]
    pub developer_mode: bool,
    #[serde(default)]
    pub enable_tts_command: bool,
    #[serde(default)]
    pub animate_emoji: Option<bool>,
    #[serde(default)]
    pub animate_stickers: Option<u8>,
    #[serde(default)]
    pub inline_attachment_media: Option<bool>,
    #[serde(default)]
    pub inline_embed_media: Option<bool>,
    #[serde(default)]
    pub gif_auto_play: Option<bool>,
    #[serde(default)]
    pub render_embeds: Option<bool>,
    #[serde(default)]
    pub render_reactions: Option<bool>,
    #[serde(default)]
    pub convert_emoticons: Option<bool>,
    #[serde(default)]
    pub default_guilds_restricted: bool,
    #[serde(default)]
    pub friend_source_flags: Option<Value>,
    #[serde(default)]
    pub guild_positions: Vec<String>,
    #[serde(default)]
    pub guild_folders: Vec<GuildFolder>,
    #[serde(default)]
    pub custom_themes: Vec<CustomTheme>,
    #[serde(default)]
    pub active_custom_theme_id: Option<String>,
    #[serde(default)]
    pub dyslexic_font: bool,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ChannelOverride {
    pub channel_id: String,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub message_notifications: Option<u8>,
    #[serde(default)]
    pub collapsed: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct UserGuildSettings {
    pub guild_id: String,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub mute_Scheduled_events: bool,
    #[serde(default)]
    pub message_notifications: Option<u8>,
    #[serde(default)]
    pub suppress_everyone: bool,
    #[serde(default)]
    pub suppress_roles: bool,
    #[serde(default)]
    pub hide_muted_channels: bool,
    #[serde(default)]
    pub channel_overrides: Vec<ChannelOverride>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Call {
    pub channel_id: String,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub ringing: Vec<String>,
    #[serde(default)]
    pub voice_states: Vec<VoiceState>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct WatchItem {
    pub id: String,
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub added_by: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct WatchSession {
    pub channel_id: String,
    pub guild_id: String,
    pub host_id: String,
    #[serde(default)]
    pub control: String,
    #[serde(default)]
    pub queue: Vec<WatchItem>,
    #[serde(default)]
    pub current_index: usize,
    #[serde(default)]
    pub playing: bool,
    #[serde(default)]
    pub position_sec: f64,
    #[serde(default)]
    pub speed: f64,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct CanvasNote {
    pub id: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub color: String,
    pub text: String,
    #[serde(default)]
    pub author_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ChannelCanvas {
    pub channel_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub doc: String,
    #[serde(default)]
    pub notes: Vec<CanvasNote>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub updated_by: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct SavedMessage {
    pub message_id: String,
    pub channel_id: String,
    #[serde(default)]
    pub guild_id: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub due_at: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub message: Option<Message>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ScheduledMessage {
    pub id: String,
    pub channel_id: String,
    pub content: String,
    pub send_at: String,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Ready {
    pub session_id: String,
    pub user: User,
    #[serde(default)]
    pub guilds: Vec<Guild>,
    #[serde(default)]
    pub private_channels: Vec<Channel>,
    #[serde(default)]
    pub users: Vec<User>,
    #[serde(default)]
    pub relationships: Vec<Relationship>,
    #[serde(default)]
    pub read_state: Vec<ReadState>,
    #[serde(default)]
    pub user_settings: Option<UserSettings>,
    #[serde(default)]
    pub user_guild_settings: Vec<UserGuildSettings>,
    #[serde(default)]
    pub presences: Vec<Value>,
    #[serde(default)]
    pub calls: Vec<Call>,
    #[serde(default)]
    pub saved_messages: Vec<SavedMessage>,
    #[serde(default)]
    pub watch_sessions: Vec<WatchSession>,
    #[serde(default)]
    pub notes: serde_json::Map<String, Value>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}
