use crate::model::{
    parse,
    Activity, Call, Channel, ChannelCanvas, CustomStatus, Emoji, Guild, Member, Message,
    PollAnswerCount, PollResults, Presence, Reaction, ReadState, Ready, Relationship, Role,
    SavedMessage, ScheduledEvent, Sound, StageInstance, Sticker, User, UserGuildSettings,
    UserSettings, VoiceState, WatchSession,
};
use serde_json::Value;
use std::collections::HashMap;

/// Server-backed state. View selection, drafts, and media state belong to the platform UI.
#[derive(Default, Debug, Clone)]
pub struct State {
    pub session_id: Option<String>,
    pub me: Option<User>,
    pub users: HashMap<String, User>,
    pub guilds: HashMap<String, Guild>,
    pub channels: HashMap<String, Channel>,
    pub messages: HashMap<String, Vec<Message>>,
    pub members: HashMap<String, HashMap<String, Member>>,
    pub presences: HashMap<String, Presence>,
    pub voice_states: HashMap<String, VoiceState>,
    pub relationships: HashMap<String, Relationship>,
    pub read_states: HashMap<String, ReadState>,
    pub user_settings: UserSettings,
    pub user_guild_settings: HashMap<String, UserGuildSettings>,
    pub stage_instances: HashMap<String, StageInstance>,
    pub scheduled_events: HashMap<String, Vec<ScheduledEvent>>,
    pub calls: HashMap<String, Call>,
    pub canvases: HashMap<String, ChannelCanvas>,
    pub watch_sessions: HashMap<String, WatchSession>,
    pub saved_messages: Vec<SavedMessage>,
    pub due_reminders: Vec<SavedMessage>,
    pub notes: HashMap<String, String>,
    pub typing: HashMap<String, Vec<(String, u64)>>,
}

impl State {
    pub fn apply(&mut self, name: &str, payload: Value) -> Result<bool, serde_json::Error> {
        match name {
            "READY" => {
                let ready: Ready = parse(payload)?;
                self.session_id = Some(ready.session_id);
                self.me = Some(ready.user.clone());
                self.users.clear();
                self.guilds.clear();
                self.channels.clear();
                self.messages.clear();
                self.members.clear();
                self.presences.clear();
                self.voice_states.clear();
                self.relationships.clear();
                self.read_states.clear();
                self.stage_instances.clear();
                self.scheduled_events.clear();
                self.calls.clear();
                self.watch_sessions.clear();

                self.users.insert(ready.user.id.clone(), ready.user);
                for user in ready.users {
                    self.users.insert(user.id.clone(), user);
                }
                for rel in ready.relationships {
                    if let Some(u) = &rel.user {
                        self.users.insert(u.id.clone(), u.clone());
                    }
                    self.relationships.insert(rel.id.clone(), rel);
                }
                for rs in ready.read_state {
                    self.read_states.insert(rs.id.clone(), rs);
                }
                if let Some(us) = ready.user_settings {
                    self.user_settings = us;
                }
                for ugs in ready.user_guild_settings {
                    self.user_guild_settings
                        .insert(ugs.guild_id.clone().unwrap_or_else(|| "@me".into()), ugs);
                }
                for p in &ready.presences {
                    self.ingest_presence(p);
                }
                for call in ready.calls {
                    self.calls.insert(call.channel_id.clone(), call);
                }
                self.saved_messages = ready.saved_messages;
                for ws in ready.watch_sessions {
                    self.watch_sessions.insert(ws.channel_id.clone(), ws);
                }
                for (uid, note_val) in ready.notes {
                    if let Some(s) = note_val.as_str() {
                        self.notes.insert(uid, s.to_string());
                    }
                }
                for channel in ready.private_channels {
                    for user in &channel.recipients {
                        self.users.insert(user.id.clone(), user.clone());
                    }
                    self.channels.insert(channel.id.clone(), channel);
                }
                for guild in ready.guilds {
                    self.ingest_guild(guild);
                }
            }
            "GUILD_CREATE" | "GUILD_UPDATE" => {
                let payload = if name == "GUILD_UPDATE" {
                    merge_existing(
                        self.guilds
                            .get(payload.get("id").and_then(Value::as_str).unwrap_or("")),
                        payload,
                    )?
                } else {
                    payload
                };
                let guild: Guild = parse(payload)?;
                self.ingest_guild(guild);
            }
            "GUILD_DELETE" => {
                if let Some(id) = payload.get("id").and_then(Value::as_str) {
                    self.guilds.remove(id);
                    self.members.remove(id);
                    self.scheduled_events.remove(id);
                    self.channels.retain(|_, c| c.guild_id.as_deref() != Some(id));
                }
            }
            "GUILD_ROLE_CREATE" | "GUILD_ROLE_UPDATE" => {
                if let (Some(gid), Some(role_val)) = (
                    payload.get("guild_id").and_then(Value::as_str),
                    payload.get("role"),
                ) {
                    if let Ok(role) = parse::<Role>(role_val.clone()) {
                        if let Some(guild) = self.guilds.get_mut(gid) {
                            if let Some(existing) = guild.roles.iter_mut().find(|r| r.id == role.id)
                            {
                                *existing = role;
                            } else {
                                guild.roles.push(role);
                            }
                        }
                    }
                }
            }
            "GUILD_ROLE_DELETE" => {
                if let (Some(gid), Some(rid)) = (
                    payload.get("guild_id").and_then(Value::as_str),
                    payload.get("role_id").and_then(Value::as_str),
                ) {
                    if let Some(guild) = self.guilds.get_mut(gid) {
                        guild.roles.retain(|r| r.id != rid);
                    }
                }
            }
            "GUILD_MEMBER_ADD" | "GUILD_MEMBER_UPDATE" => {
                let member: Member = parse(payload.clone())?;
                if let Some(u) = &member.user {
                    self.users.insert(u.id.clone(), u.clone());
                }
                if let (Some(gid), Some(uid)) = (
                    member
                        .guild_id
                        .as_deref()
                        .or_else(|| payload.get("guild_id").and_then(Value::as_str)),
                    member.resolved_user_id(),
                ) {
                    self.members
                        .entry(gid.to_string())
                        .or_default()
                        .insert(uid.to_string(), member);
                }
            }
            "GUILD_MEMBER_REMOVE" => {
                let gid = payload.get("guild_id").and_then(Value::as_str);
                let uid = payload
                    .get("user")
                    .and_then(|u| u.get("id"))
                    .and_then(Value::as_str)
                    .or_else(|| payload.get("user_id").and_then(Value::as_str));
                if let (Some(gid), Some(uid)) = (gid, uid) {
                    if let Some(map) = self.members.get_mut(gid) {
                        map.remove(uid);
                    }
                }
            }
            "CHANNEL_CREATE" | "CHANNEL_UPDATE" | "THREAD_CREATE" | "THREAD_UPDATE" => {
                let payload = merge_existing(
                    self.channels
                        .get(payload.get("id").and_then(Value::as_str).unwrap_or("")),
                    payload,
                )?;
                let channel: Channel = parse(payload)?;
                for user in &channel.recipients {
                    self.users.insert(user.id.clone(), user.clone());
                }
                if let Some(gid) = &channel.guild_id {
                    if let Some(guild) = self.guilds.get_mut(gid) {
                        let list = if matches!(channel.kind, 10 | 11 | 12) {
                            &mut guild.threads
                        } else {
                            &mut guild.channels
                        };
                        if let Some(existing) = list.iter_mut().find(|c| c.id == channel.id) {
                            *existing = channel.clone();
                        } else {
                            list.push(channel.clone());
                        }
                    }
                }
                self.channels.insert(channel.id.clone(), channel);
            }
            "CHANNEL_DELETE" | "THREAD_DELETE" => {
                if let Some(id) = payload.get("id").and_then(Value::as_str) {
                    if let Some(ch) = self.channels.remove(id) {
                        if let Some(gid) = ch.guild_id {
                            if let Some(guild) = self.guilds.get_mut(&gid) {
                                guild.channels.retain(|c| c.id != id);
                                guild.threads.retain(|c| c.id != id);
                            }
                        }
                    }
                    self.messages.remove(id);
                }
            }
            "THREAD_LIST_SYNC" => {
                if let Some(threads) = payload.get("threads").and_then(Value::as_array) {
                    for t in threads {
                        if let Ok(ch) = parse::<Channel>(t.clone()) {
                            self.channels.insert(ch.id.clone(), ch);
                        }
                    }
                }
            }
            "VOICE_CHANNEL_STATUS_UPDATE" => {
                if let Some(id) = payload.get("id").and_then(Value::as_str) {
                    let status = payload
                        .get("status")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string());
                    if let Some(ch) = self.channels.get_mut(id) {
                        ch.status = status;
                    }
                }
            }
            "MESSAGE_CREATE" => {
                let message: Message = parse(payload)?;
                if let Some(author) = &message.author {
                    self.users.insert(author.id.clone(), author.clone());
                }
                if let Some(ch) = self.channels.get_mut(&message.channel_id) {
                    ch.last_message_id = Some(message.id.clone());
                }
                if let Some(history) = self.messages.get_mut(&message.channel_id) {
                    if !history.iter().any(|m| m.id == message.id) {
                        history.push(message);
                    }
                }
            }
            "MESSAGE_UPDATE" => {
                if let (Some(channel), Some(id)) = (
                    payload.get("channel_id").and_then(Value::as_str),
                    payload.get("id").and_then(Value::as_str),
                ) {
                    if let Some(history) = self.messages.get_mut(channel) {
                        if let Some(old) = history.iter_mut().find(|m| m.id == id) {
                            *old =
                                parse(merge_existing(Some(&*old), payload.clone())?)?;
                        }
                    }
                }
            }
            "MESSAGE_DELETE" => {
                if let (Some(channel), Some(id)) = (
                    payload.get("channel_id").and_then(Value::as_str),
                    payload.get("id").and_then(Value::as_str),
                ) {
                    if let Some(history) = self.messages.get_mut(channel) {
                        history.retain(|m| m.id != id);
                    }
                }
            }
            "MESSAGE_DELETE_BULK" => {
                if let (Some(channel), Some(ids)) = (
                    payload.get("channel_id").and_then(Value::as_str),
                    payload.get("ids").and_then(Value::as_array),
                ) {
                    if let Some(history) = self.messages.get_mut(channel) {
                        history
                            .retain(|m| !ids.iter().any(|id| id.as_str() == Some(m.id.as_str())));
                    }
                }
            }
            "MESSAGE_ACK" => {
                if let Some(cid) = payload.get("channel_id").and_then(Value::as_str) {
                    let mid = payload
                        .get("message_id")
                        .and_then(Value::as_str)
                        .map(|s| s.to_string());
                    let mentions = payload
                        .get("mention_count")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as u32;
                    self.read_states.insert(
                        cid.to_string(),
                        ReadState {
                            id: cid.to_string(),
                            last_message_id: mid,
                            mention_count: mentions,
                        },
                    );
                }
            }
            "MESSAGE_REACTION_ADD" | "MESSAGE_REACTION_REMOVE" => {
                let add = name == "MESSAGE_REACTION_ADD";
                let cid = payload.get("channel_id").and_then(Value::as_str);
                let mid = payload.get("message_id").and_then(Value::as_str);
                let uid = payload.get("user_id").and_then(Value::as_str);
                let emoji = payload
                    .get("emoji")
                    .and_then(|e| parse::<Emoji>(e.clone()).ok());
                let is_me = self.me.as_ref().map(|u| u.id.as_str()) == uid;
                if let (Some(cid), Some(mid), Some(emoji)) = (cid, mid, emoji) {
                    if let Some(history) = self.messages.get_mut(cid) {
                        if let Some(msg) = history.iter_mut().find(|m| m.id == mid) {
                            if let Some(r) = msg.reactions.iter_mut().find(|r| {
                                r.emoji.id == emoji.id && r.emoji.name == emoji.name
                            }) {
                                if add {
                                    r.count += 1;
                                    if is_me {
                                        r.me = true;
                                    }
                                } else {
                                    r.count = r.count.saturating_sub(1);
                                    if is_me {
                                        r.me = false;
                                    }
                                }
                            } else if add {
                                msg.reactions.push(Reaction {
                                    count: 1,
                                    me: is_me,
                                    emoji,
                                });
                            }
                            msg.reactions.retain(|r| r.count > 0);
                        }
                    }
                }
            }
            "MESSAGE_REACTION_REMOVE_ALL" => {
                if let (Some(cid), Some(mid)) = (
                    payload.get("channel_id").and_then(Value::as_str),
                    payload.get("message_id").and_then(Value::as_str),
                ) {
                    if let Some(history) = self.messages.get_mut(cid) {
                        if let Some(msg) = history.iter_mut().find(|m| m.id == mid) {
                            msg.reactions.clear();
                        }
                    }
                }
            }
            "MESSAGE_POLL_VOTE_ADD" | "MESSAGE_POLL_VOTE_REMOVE" => {
                let add = name == "MESSAGE_POLL_VOTE_ADD";
                let cid = payload.get("channel_id").and_then(Value::as_str);
                let mid = payload.get("message_id").and_then(Value::as_str);
                let uid = payload.get("user_id").and_then(Value::as_str);
                let aid = payload.get("answer_id").and_then(Value::as_u64).map(|n| n as u32);
                let is_me = self.me.as_ref().map(|u| u.id.as_str()) == uid;
                if let (Some(cid), Some(mid), Some(aid)) = (cid, mid, aid) {
                    if let Some(history) = self.messages.get_mut(cid) {
                        if let Some(msg) = history.iter_mut().find(|m| m.id == mid) {
                            if let Some(poll) = &mut msg.poll {
                                let results = poll.results.get_or_insert_with(PollResults::default);
                                if let Some(ac) =
                                    results.answer_counts.iter_mut().find(|a| a.id == aid)
                                {
                                    if add {
                                        ac.count += 1;
                                        if is_me {
                                            ac.me_voted = true;
                                        }
                                    } else {
                                        ac.count = ac.count.saturating_sub(1);
                                        if is_me {
                                            ac.me_voted = false;
                                        }
                                    }
                                } else if add {
                                    results.answer_counts.push(PollAnswerCount {
                                        id: aid,
                                        count: 1,
                                        me_voted: is_me,
                                    });
                                }
                            }
                        }
                    }
                }
            }
            "VOICE_STATE_UPDATE" => {
                let vs: VoiceState = parse(payload)?;
                if vs.channel_id.is_some() {
                    self.voice_states.insert(vs.user_id.clone(), vs);
                } else {
                    self.voice_states.remove(&vs.user_id);
                }
            }
            "PRESENCE_UPDATE" => {
                self.ingest_presence(&payload);
            }
            "RELATIONSHIP_ADD" | "RELATIONSHIP_UPDATE" => {
                let rel: Relationship = parse(payload)?;
                if let Some(u) = &rel.user {
                    self.users.insert(u.id.clone(), u.clone());
                }
                self.relationships.insert(rel.id.clone(), rel);
            }
            "RELATIONSHIP_REMOVE" => {
                if let Some(id) = payload.get("id").and_then(Value::as_str) {
                    self.relationships.remove(id);
                }
            }
            "USER_UPDATE" => {
                let payload = merge_existing(
                    self.users
                        .get(payload.get("id").and_then(Value::as_str).unwrap_or("")),
                    payload,
                )?;
                let user: User = parse(payload)?;
                if self.me.as_ref().is_some_and(|me| me.id == user.id) {
                    self.me = Some(user.clone());
                }
                self.users.insert(user.id.clone(), user);
            }
            "USER_SETTINGS_UPDATE" => {
                let merged = merge_existing(Some(&self.user_settings), payload)?;
                let us: UserSettings = parse(merged)?;
                self.user_settings = us;
            }
            "USER_GUILD_SETTINGS_UPDATE" => {
                let ugs: UserGuildSettings = parse(payload)?;
                self.user_guild_settings
                    .insert(ugs.guild_id.clone().unwrap_or_else(|| "@me".into()), ugs);
            }
            "STAGE_INSTANCE_CREATE" | "STAGE_INSTANCE_UPDATE" => {
                let stage: StageInstance = parse(payload)?;
                self.stage_instances.insert(stage.channel_id.clone(), stage);
            }
            "STAGE_INSTANCE_DELETE" => {
                if let Some(cid) = payload.get("channel_id").and_then(Value::as_str) {
                    self.stage_instances.remove(cid);
                }
            }
            "GUILD_SCHEDULED_EVENT_CREATE" | "GUILD_SCHEDULED_EVENT_UPDATE" => {
                let ev: ScheduledEvent = parse(payload)?;
                let list = self
                    .scheduled_events
                    .entry(ev.guild_id.clone())
                    .or_default();
                if let Some(existing) = list.iter_mut().find(|e| e.id == ev.id) {
                    *existing = ev;
                } else {
                    list.push(ev);
                }
            }
            "GUILD_SCHEDULED_EVENT_DELETE" => {
                if let (Some(gid), Some(eid)) = (
                    payload.get("guild_id").and_then(Value::as_str),
                    payload.get("id").and_then(Value::as_str),
                ) {
                    if let Some(list) = self.scheduled_events.get_mut(gid) {
                        list.retain(|e| e.id != eid);
                    }
                }
            }
            "GUILD_EMOJIS_UPDATE" => {
                if let (Some(gid), Some(emojis)) = (
                    payload.get("guild_id").and_then(Value::as_str),
                    payload.get("emojis"),
                ) {
                    if let (Some(guild), Ok(list)) = (
                        self.guilds.get_mut(gid),
                        parse::<Vec<Emoji>>(emojis.clone()),
                    ) {
                        guild.emojis = list;
                    }
                }
            }
            "GUILD_STICKERS_UPDATE" => {
                if let (Some(gid), Some(stickers)) = (
                    payload.get("guild_id").and_then(Value::as_str),
                    payload.get("stickers"),
                ) {
                    if let (Some(guild), Ok(list)) = (
                        self.guilds.get_mut(gid),
                        parse::<Vec<Sticker>>(stickers.clone()),
                    ) {
                        guild.stickers = list;
                    }
                }
            }
            "GUILD_SOUNDBOARD_SOUND_CREATE" | "GUILD_SOUNDBOARD_SOUND_UPDATE" => {
                let sound: Sound = parse(payload)?;
                if let Some(gid) = &sound.guild_id {
                    if let Some(guild) = self.guilds.get_mut(gid) {
                        if let Some(existing) = guild
                            .soundboard_sounds
                            .iter_mut()
                            .find(|s| s.sound_id == sound.sound_id)
                        {
                            *existing = sound;
                        } else {
                            guild.soundboard_sounds.push(sound);
                        }
                    }
                }
            }
            "GUILD_SOUNDBOARD_SOUND_DELETE" => {
                if let (Some(gid), Some(sid)) = (
                    payload.get("guild_id").and_then(Value::as_str),
                    payload.get("sound_id").and_then(Value::as_str),
                ) {
                    if let Some(guild) = self.guilds.get_mut(gid) {
                        guild.soundboard_sounds.retain(|s| s.sound_id != sid);
                    }
                }
            }
            "CALL_CREATE" | "CALL_UPDATE" => {
                let call: Call = parse(payload)?;
                self.calls.insert(call.channel_id.clone(), call);
            }
            "CALL_DELETE" => {
                if let Some(cid) = payload.get("channel_id").and_then(Value::as_str) {
                    self.calls.remove(cid);
                }
            }
            "CHANNEL_CANVAS_UPDATE" => {
                let canvas: ChannelCanvas = parse(payload)?;
                self.canvases.insert(canvas.channel_id.clone(), canvas);
            }
            "WATCH_SESSION_UPDATE" => {
                let ws: WatchSession = parse(payload)?;
                self.watch_sessions.insert(ws.channel_id.clone(), ws);
            }
            "WATCH_SESSION_DELETE" => {
                if let Some(cid) = payload.get("channel_id").and_then(Value::as_str) {
                    self.watch_sessions.remove(cid);
                }
            }
            "SAVED_MESSAGE_CREATE" | "SAVED_MESSAGE_UPDATE" => {
                let sm: SavedMessage = parse(payload)?;
                if let Some(existing) = self
                    .saved_messages
                    .iter_mut()
                    .find(|s| s.message_id == sm.message_id)
                {
                    *existing = sm;
                } else {
                    self.saved_messages.insert(0, sm);
                }
            }
            "SAVED_MESSAGE_DELETE" => {
                if let Some(mid) = payload.get("message_id").and_then(Value::as_str) {
                    self.saved_messages.retain(|s| s.message_id != mid);
                    self.due_reminders.retain(|s| s.message_id != mid);
                }
            }
            "MESSAGE_REMINDER_DUE" => {
                let sm: SavedMessage = parse(payload)?;
                self.due_reminders.push(sm);
            }
            "TYPING_START" => {
                if let (Some(cid), Some(uid)) = (
                    payload.get("channel_id").and_then(Value::as_str),
                    payload.get("user_id").and_then(Value::as_str),
                ) {
                    let ts = payload
                        .get("timestamp")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let entry = self.typing.entry(cid.to_string()).or_default();
                    entry.retain(|(u, _)| u != uid);
                    entry.push((uid.to_string(), ts));
                }
            }
            _ => return Ok(false),
        }
        Ok(true)
    }

    fn ingest_guild(&mut self, guild: Guild) {
        for channel in guild.channels.iter().chain(&guild.threads) {
            let mut ch = channel.clone();
            if ch.guild_id.is_none() {
                ch.guild_id = Some(guild.id.clone());
            }
            self.channels.insert(ch.id.clone(), ch);
        }
        let member_map = self.members.entry(guild.id.clone()).or_default();
        for m in &guild.members {
            if let Some(u) = &m.user {
                self.users.insert(u.id.clone(), u.clone());
            }
            if let Some(uid) = m.resolved_user_id() {
                member_map.insert(uid.to_string(), m.clone());
            }
        }
        for vs in &guild.voice_states {
            if vs.channel_id.is_some() {
                let mut vs = vs.clone();
                if vs.guild_id.is_none() {
                    vs.guild_id = Some(guild.id.clone());
                }
                self.voice_states.insert(vs.user_id.clone(), vs);
            }
        }
        for p in &guild.presences {
            self.ingest_presence(p);
        }
        for stage in &guild.stage_instances {
            self.stage_instances
                .insert(stage.channel_id.clone(), stage.clone());
        }
        if !guild.guild_scheduled_events.is_empty() {
            self.scheduled_events
                .insert(guild.id.clone(), guild.guild_scheduled_events.clone());
        }
        self.guilds.insert(guild.id.clone(), guild);
    }

    fn ingest_presence(&mut self, p: &Value) {
        let uid = p
            .get("user")
            .and_then(|u| u.get("id"))
            .and_then(Value::as_str)
            .or_else(|| p.get("user_id").and_then(Value::as_str));
        let Some(uid) = uid else { return };
        if let Some(user_obj) = p.get("user") {
            if user_obj.get("username").is_some() {
                if let Ok(u) = parse::<User>(user_obj.clone()) {
                    self.users.insert(u.id.clone(), u);
                }
            }
        }
        let status = p
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("online")
            .to_string();
        let custom_status = p
            .get("custom_status")
            .and_then(|cs| parse::<CustomStatus>(cs.clone()).ok());
        let activities = p
            .get("activities")
            .and_then(|a| parse::<Vec<Activity>>(a.clone()).ok())
            .unwrap_or_default();
        self.presences.insert(
            uid.to_string(),
            Presence {
                user_id: uid.to_string(),
                status,
                custom_status,
                activities,
            },
        );
    }

    pub fn set_history(&mut self, channel_id: String, messages: Vec<Message>) {
        for m in &messages {
            if let Some(author) = &m.author {
                self.users.insert(author.id.clone(), author.clone());
            }
        }
        self.messages.insert(channel_id, messages);
    }

    /// Stores a guild's member list from GET /guilds/{id}/members (READY carries none).
    pub fn set_members(&mut self, guild_id: &str, list: Value) -> Result<(), serde_json::Error> {
        let list: Vec<Value> = parse(list)?;
        let map = self.members.entry(guild_id.to_string()).or_default();
        for item in list {
            let member: Member = match parse(item) {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("cillhub: skipped member of {guild_id}: {e}");
                    continue;
                }
            };
            if let Some(u) = &member.user {
                self.users.insert(u.id.clone(), u.clone());
            }
            if let Some(uid) = member.resolved_user_id() {
                map.insert(uid.to_string(), member);
            }
        }
        Ok(())
    }

    pub fn user_status(&self, user_id: &str) -> &str {
        self.presences
            .get(user_id)
            .map(|p| p.status.as_str())
            .unwrap_or("offline")
    }

    pub fn user_game(&self, user_id: &str) -> Option<&Activity> {
        self.presences
            .get(user_id)
            .and_then(|p| p.activities.iter().find(|a| a.kind == 0))
    }

    pub fn is_channel_unread(&self, channel: &Channel) -> bool {
        let Some(last_id) = channel.last_message_id.as_deref() else {
            return false;
        };
        match self.read_states.get(&channel.id) {
            Some(rs) => rs.last_message_id.as_deref() != Some(last_id),
            None => true,
        }
    }

    pub fn channel_mention_count(&self, channel_id: &str) -> u32 {
        self.read_states
            .get(channel_id)
            .map(|rs| rs.mention_count)
            .unwrap_or(0)
    }

    pub fn sorted_guilds(&self) -> Vec<&Guild> {
        let mut list: Vec<&Guild> = self.guilds.values().collect();
        let pos = &self.user_settings.guild_positions;
        list.sort_by(|a, b| {
            let ia = pos.iter().position(|id| id == &a.id).unwrap_or(usize::MAX);
            let ib = pos.iter().position(|id| id == &b.id).unwrap_or(usize::MAX);
            ia.cmp(&ib).then_with(|| a.name.cmp(&b.name))
        });
        list
    }
}

fn merge_existing<T: serde::Serialize>(
    old: Option<&T>,
    patch: Value,
) -> Result<Value, serde_json::Error> {
    let Some(old) = old else { return Ok(patch) };
    let mut base = serde_json::to_value(old)?;
    if let (Some(base), Some(patch)) = (base.as_object_mut(), patch.as_object()) {
        base.extend(patch.clone());
    }
    Ok(base)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ready_and_message_lifecycle() {
        let mut state = State::default();
        state
            .apply(
                "READY",
                json!({"session_id":"s","user":{"id":"u","username":"Ada"},"guilds":[{"id":"g","name":"Guild","channels":[{"id":"c","type":0,"guild_id":"g"}]}]}),
            )
            .unwrap();
        assert!(state.channels.contains_key("c"));
        state.set_history("c".into(), vec![]);
        state
            .apply(
                "MESSAGE_CREATE",
                json!({"id":"m","channel_id":"c","content":"hello"}),
            )
            .unwrap();
        state
            .apply(
                "MESSAGE_CREATE",
                json!({"id":"m","channel_id":"c","content":"hello"}),
            )
            .unwrap();
        assert_eq!(state.messages["c"].len(), 1);
        state
            .apply(
                "MESSAGE_UPDATE",
                json!({"id":"m","channel_id":"c","edited_timestamp":"now"}),
            )
            .unwrap();
        assert_eq!(state.messages["c"][0].content, "hello");
        assert_eq!(
            state.messages["c"][0].edited_timestamp.as_deref(),
            Some("now")
        );
        state
            .apply("MESSAGE_DELETE", json!({"id":"m","channel_id":"c"}))
            .unwrap();
        assert!(state.messages["c"].is_empty());
    }

    #[test]
    fn ready_from_a_real_hub() {
        let ready: Value = serde_json::from_str(include_str!("fixtures/ready-hub.json")).unwrap();
        let mut state = State::default();
        state.apply("READY", ready).unwrap();
        assert_eq!(state.me.as_ref().unwrap().username, "alex");
        let guild = state.sorted_guilds()[0].clone();
        assert_eq!(guild.name, "Pixel Lounge");
        assert_eq!(guild.roles.len(), 4);
        let names: Vec<_> = state.channels.values().filter_map(|c| c.name.clone()).collect();
        for want in ["general", "dev-talk", "screenshots", "off-topic", "General"] {
            assert!(names.iter().any(|n| n == want), "missing channel {want}");
        }
        let friends: Vec<_> = state.relationships.values().filter(|r| r.kind == 1).collect();
        assert_eq!(friends[0].user.as_ref().unwrap().username, "sam");
        let dm = state.channels.values().find(|c| c.kind == 1).unwrap();
        assert_eq!(dm.display_name(Some("x")), "Sam");
        assert_eq!(state.user_status(&state.me.as_ref().unwrap().id), "online");

        // READY has no members; the client loads them over REST like the web client.
        let gid = guild.id.clone();
        let members = json!([
            {"user": {"id": "1", "username": "alex", "global_name": "Alex", "avatar": null}, "nick": null, "roles": [], "joined_at": "2026-11-10T00:00:00Z", "communication_disabled_until": null},
            {"user": {"id": "2", "username": "sam"}, "nick": null, "roles": [guild.roles[3].id], "joined_at": null},
            {"nick": "broken: no user"}
        ]);
        state.set_members(&gid, members).unwrap();
        assert_eq!(state.members[&gid].len(), 2);
        assert_eq!(state.members[&gid]["2"].roles.len(), 1);
    }

    #[test]
    fn ready_tolerates_odd_shapes() {
        let mut state = State::default();
        state
            .apply(
                "READY",
                json!({
                    "session_id": "s", "user": {"id": "u", "username": "kim"},
                    "user_guild_settings": [{"guild_id": null, "muted": true}, {"guild_id": "g"}],
                    "user_settings": {"animate_emoji": "hover", "custom_themes": [{"id": "t", "name": "Night", "gradient": null}], "theme": "light"},
                    "guilds": [{"id": "g", "name": "Ok", "members": "not a list", "channels": [{"id": "c", "type": 0, "position": null}, {"type": 0}]}, {"name": "no id"}],
                    "read_state": {"entries": [{"id": "c", "last_message_id": null}]},
                    "brand_new_field": {"x": 1}
                }),
            )
            .unwrap();
        assert_eq!(state.guilds.len(), 1);
        assert!(state.channels.contains_key("c"));
        assert!(state.user_guild_settings["@me"].muted);
        assert_eq!(state.user_settings.theme.as_deref(), Some("light"));
        assert_eq!(state.user_settings.custom_themes[0].name, "Night");
        assert!(state.read_states.contains_key("c"));
        // A broken event is an error for the caller to report, not a silent no-op.
        assert!(state.apply("VOICE_STATE_UPDATE", json!({"channel_id": "c"})).is_err());
    }

    #[test]
    fn presence_and_voice_state_updates() {
        let mut state = State::default();
        state
            .apply(
                "PRESENCE_UPDATE",
                json!({
                    "user": {"id": "u1", "username": "jordan"},
                    "status": "online",
                    "activities": [{"type": 0, "name": "League of Legends", "timestamps": {"start": 1000}}]
                }),
            )
            .unwrap();
        assert_eq!(state.user_status("u1"), "online");
        assert_eq!(
            state.user_game("u1").unwrap().name,
            "League of Legends"
        );
        state
            .apply(
                "VOICE_STATE_UPDATE",
                json!({"user_id": "u1", "guild_id": "g", "channel_id": "vc1", "self_mute": true}),
            )
            .unwrap();
        assert!(state.voice_states["u1"].self_mute);
        state
            .apply(
                "VOICE_STATE_UPDATE",
                json!({"user_id": "u1", "guild_id": "g", "channel_id": null}),
            )
            .unwrap();
        assert!(!state.voice_states.contains_key("u1"));
    }
}
