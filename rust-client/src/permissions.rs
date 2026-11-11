//! Permission bits and reference computation algorithm (CONTRACT-v2 section 1, CONTRACT-v3 section 0).
//! Direct port of `client/src/permissions.ts`.

use crate::model::{Channel, Guild, Member, Role, ScheduledEvent};

pub mod p {
    pub const CREATE_INSTANT_INVITE: u64 = 1 << 0;
    pub const KICK_MEMBERS: u64 = 1 << 1;
    pub const BAN_MEMBERS: u64 = 1 << 2;
    pub const ADMINISTRATOR: u64 = 1 << 3;
    pub const MANAGE_CHANNELS: u64 = 1 << 4;
    pub const MANAGE_GUILD: u64 = 1 << 5;
    pub const ADD_REACTIONS: u64 = 1 << 6;
    pub const VIEW_AUDIT_LOG: u64 = 1 << 7;
    pub const PRIORITY_SPEAKER: u64 = 1 << 8;
    pub const STREAM: u64 = 1 << 9;
    pub const VIEW_CHANNEL: u64 = 1 << 10;
    pub const SEND_MESSAGES: u64 = 1 << 11;
    pub const MANAGE_MESSAGES: u64 = 1 << 13;
    pub const EMBED_LINKS: u64 = 1 << 14;
    pub const ATTACH_FILES: u64 = 1 << 15;
    pub const READ_MESSAGE_HISTORY: u64 = 1 << 16;
    pub const MENTION_EVERYONE: u64 = 1 << 17;
    pub const USE_EXTERNAL_EMOJIS: u64 = 1 << 18;
    pub const CONNECT: u64 = 1 << 20;
    pub const SPEAK: u64 = 1 << 21;
    pub const MUTE_MEMBERS: u64 = 1 << 22;
    pub const DEAFEN_MEMBERS: u64 = 1 << 23;
    pub const MOVE_MEMBERS: u64 = 1 << 24;
    pub const CHANGE_NICKNAME: u64 = 1 << 26;
    pub const MANAGE_NICKNAMES: u64 = 1 << 27;
    pub const MANAGE_ROLES: u64 = 1 << 28;
    pub const MANAGE_WEBHOOKS: u64 = 1 << 29;
    pub const MANAGE_GUILD_EXPRESSIONS: u64 = 1 << 30;
    pub const USE_APPLICATION_COMMANDS: u64 = 1 << 31;
    pub const REQUEST_TO_SPEAK: u64 = 1 << 32;
    pub const MANAGE_EVENTS: u64 = 1 << 33;
    pub const MANAGE_THREADS: u64 = 1 << 34;
    pub const CREATE_PUBLIC_THREADS: u64 = 1 << 35;
    pub const CREATE_PRIVATE_THREADS: u64 = 1 << 36;
    pub const USE_EXTERNAL_STICKERS: u64 = 1 << 37;
    pub const SEND_MESSAGES_IN_THREADS: u64 = 1 << 38;
    pub const MODERATE_MEMBERS: u64 = 1 << 40;
    pub const USE_SOUNDBOARD: u64 = 1 << 42;
    pub const CREATE_GUILD_EXPRESSIONS: u64 = 1 << 43;
    pub const CREATE_EVENTS: u64 = 1 << 44;
    pub const USE_EXTERNAL_SOUNDS: u64 = 1 << 45;
    pub const SEND_VOICE_MESSAGES: u64 = 1 << 46;
    pub const SEND_POLLS: u64 = 1 << 49;

    pub const ALL: u64 = CREATE_INSTANT_INVITE
        | KICK_MEMBERS
        | BAN_MEMBERS
        | ADMINISTRATOR
        | MANAGE_CHANNELS
        | MANAGE_GUILD
        | ADD_REACTIONS
        | VIEW_AUDIT_LOG
        | PRIORITY_SPEAKER
        | STREAM
        | VIEW_CHANNEL
        | SEND_MESSAGES
        | MANAGE_MESSAGES
        | EMBED_LINKS
        | ATTACH_FILES
        | READ_MESSAGE_HISTORY
        | MENTION_EVERYONE
        | USE_EXTERNAL_EMOJIS
        | CONNECT
        | SPEAK
        | MUTE_MEMBERS
        | DEAFEN_MEMBERS
        | MOVE_MEMBERS
        | CHANGE_NICKNAME
        | MANAGE_NICKNAMES
        | MANAGE_ROLES
        | MANAGE_WEBHOOKS
        | MANAGE_GUILD_EXPRESSIONS
        | USE_APPLICATION_COMMANDS
        | REQUEST_TO_SPEAK
        | MANAGE_EVENTS
        | MANAGE_THREADS
        | CREATE_PUBLIC_THREADS
        | CREATE_PRIVATE_THREADS
        | USE_EXTERNAL_STICKERS
        | SEND_MESSAGES_IN_THREADS
        | MODERATE_MEMBERS
        | USE_SOUNDBOARD
        | CREATE_GUILD_EXPRESSIONS
        | CREATE_EVENTS
        | USE_EXTERNAL_SOUNDS
        | SEND_VOICE_MESSAGES
        | SEND_POLLS;

    pub const READ_ONLY: u64 = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
}

pub const PERMISSION_LIST: &[(&str, u64, &str)] = &[
    ("VIEW_CHANNEL", p::VIEW_CHANNEL, "View Channels"),
    ("SEND_MESSAGES", p::SEND_MESSAGES, "Send Messages"),
    ("READ_MESSAGE_HISTORY", p::READ_MESSAGE_HISTORY, "Read Message History"),
    ("ADD_REACTIONS", p::ADD_REACTIONS, "Add Reactions"),
    ("ATTACH_FILES", p::ATTACH_FILES, "Attach Files"),
    ("EMBED_LINKS", p::EMBED_LINKS, "Embed Links"),
    ("MENTION_EVERYONE", p::MENTION_EVERYONE, "Mention @everyone / Roles"),
    ("SEND_POLLS", p::SEND_POLLS, "Create Polls"),
    ("SEND_VOICE_MESSAGES", p::SEND_VOICE_MESSAGES, "Send Voice Messages"),
    ("MANAGE_MESSAGES", p::MANAGE_MESSAGES, "Manage Messages"),
    ("CREATE_PUBLIC_THREADS", p::CREATE_PUBLIC_THREADS, "Create Public Threads"),
    ("CREATE_PRIVATE_THREADS", p::CREATE_PRIVATE_THREADS, "Create Private Threads"),
    ("SEND_MESSAGES_IN_THREADS", p::SEND_MESSAGES_IN_THREADS, "Send Messages in Threads"),
    ("MANAGE_THREADS", p::MANAGE_THREADS, "Manage Threads"),
    ("CONNECT", p::CONNECT, "Connect to Voice"),
    ("SPEAK", p::SPEAK, "Speak in Voice"),
    ("STREAM", p::STREAM, "Video / Screen Share"),
    ("USE_SOUNDBOARD", p::USE_SOUNDBOARD, "Use Soundboard"),
    ("PRIORITY_SPEAKER", p::PRIORITY_SPEAKER, "Priority Speaker"),
    ("REQUEST_TO_SPEAK", p::REQUEST_TO_SPEAK, "Request to Speak (Stage)"),
    ("MUTE_MEMBERS", p::MUTE_MEMBERS, "Mute Members"),
    ("DEAFEN_MEMBERS", p::DEAFEN_MEMBERS, "Deafen Members"),
    ("MOVE_MEMBERS", p::MOVE_MEMBERS, "Move Members"),
    ("CREATE_INSTANT_INVITE", p::CREATE_INSTANT_INVITE, "Create Invite"),
    ("CHANGE_NICKNAME", p::CHANGE_NICKNAME, "Change Nickname"),
    ("MANAGE_NICKNAMES", p::MANAGE_NICKNAMES, "Manage Nicknames"),
    ("KICK_MEMBERS", p::KICK_MEMBERS, "Kick Members"),
    ("BAN_MEMBERS", p::BAN_MEMBERS, "Ban Members"),
    ("MODERATE_MEMBERS", p::MODERATE_MEMBERS, "Timeout Members"),
    ("MANAGE_CHANNELS", p::MANAGE_CHANNELS, "Manage Channels"),
    ("MANAGE_ROLES", p::MANAGE_ROLES, "Manage Roles"),
    ("MANAGE_GUILD", p::MANAGE_GUILD, "Manage Server"),
    ("MANAGE_WEBHOOKS", p::MANAGE_WEBHOOKS, "Manage Webhooks"),
    ("MANAGE_GUILD_EXPRESSIONS", p::MANAGE_GUILD_EXPRESSIONS, "Manage Expressions"),
    ("CREATE_GUILD_EXPRESSIONS", p::CREATE_GUILD_EXPRESSIONS, "Create Expressions"),
    ("MANAGE_EVENTS", p::MANAGE_EVENTS, "Manage Events"),
    ("CREATE_EVENTS", p::CREATE_EVENTS, "Create Events"),
    ("VIEW_AUDIT_LOG", p::VIEW_AUDIT_LOG, "View Audit Log"),
    ("ADMINISTRATOR", p::ADMINISTRATOR, "Administrator"),
];

pub fn parse_bits(s: &str) -> u64 {
    s.trim().parse::<u64>().unwrap_or(0)
}

pub fn has(perms: u64, bit: u64) -> bool {
    (perms & bit) == bit
}

pub fn is_thread(channel: &Channel) -> bool {
    matches!(channel.kind, 10 | 11 | 12)
}

pub fn is_voice(channel: &Channel) -> bool {
    matches!(channel.kind, 2 | 13)
}

pub fn is_timed_out(member: Option<&Member>) -> bool {
    let Some(m) = member else { return false };
    let Some(until) = m.communication_disabled_until.as_deref() else {
        return false;
    };
    !until.is_empty() && until > "1970"
}

/// Guild-level permissions of a member (step 1).
pub fn base_perms(guild: &Guild, user_id: &str, member: Option<&Member>) -> u64 {
    if guild.owner_id == user_id {
        return p::ALL;
    }
    let default_perms = guild
        .roles
        .iter()
        .find(|r| r.id == guild.id)
        .map(|r| parse_bits(&r.permissions))
        .unwrap_or(70_356_545);
    let mut base = default_perms;
    if let Some(m) = member {
        for r in &guild.roles {
            if m.roles.contains(&r.id) {
                base |= parse_bits(&r.permissions);
            }
        }
    }
    if has(base, p::ADMINISTRATOR) {
        return p::ALL;
    }
    if is_timed_out(member) || member.is_some_and(|m| m.pending) {
        base & p::READ_ONLY
    } else {
        base
    }
}

/// Channel permissions of a member (steps 2 and 3).
pub fn channel_perms(
    guild: &Guild,
    user_id: &str,
    member: Option<&Member>,
    channel: &Channel,
    parent: Option<&Channel>,
) -> u64 {
    let mut perms = base_perms(guild, user_id, member);
    if perms == p::ALL {
        return p::ALL;
    }
    let thread = is_thread(channel);
    let src = if thread {
        parent.unwrap_or(channel)
    } else {
        channel
    };
    let ows = &src.permission_overwrites;
    if let Some(everyone) = ows.iter().find(|o| o.id == guild.id) {
        perms = (perms & !parse_bits(&everyone.deny)) | parse_bits(&everyone.allow);
    }
    let mut allow = 0u64;
    let mut deny = 0u64;
    if let Some(m) = member {
        for o in ows {
            if o.kind == 0 && o.id != guild.id && m.roles.contains(&o.id) {
                allow |= parse_bits(&o.allow);
                deny |= parse_bits(&o.deny);
            }
        }
    }
    perms = (perms & !deny) | allow;
    if let Some(own) = ows.iter().find(|o| o.kind == 1 && o.id == user_id) {
        perms = (perms & !parse_bits(&own.deny)) | parse_bits(&own.allow);
    }
    if is_timed_out(member) || member.is_some_and(|m| m.pending) {
        perms &= p::READ_ONLY;
    }
    if !has(perms, p::VIEW_CHANNEL) {
        return 0;
    }
    if thread {
        if has(perms, p::SEND_MESSAGES_IN_THREADS) {
            perms |= p::SEND_MESSAGES;
        } else {
            perms &= !p::SEND_MESSAGES;
        }
        if channel
            .thread_metadata
            .as_ref()
            .is_some_and(|tm| tm.locked)
            && !has(perms, p::MANAGE_THREADS)
        {
            perms &= !p::SEND_MESSAGES;
        }
    }
    if !has(perms, p::SEND_MESSAGES) {
        perms &= !(p::MENTION_EVERYONE
            | p::ATTACH_FILES
            | p::EMBED_LINKS
            | p::SEND_VOICE_MESSAGES
            | p::SEND_POLLS);
    }
    if is_voice(src) && !has(perms, p::CONNECT) {
        perms &= !(p::SPEAK
            | p::STREAM
            | p::MUTE_MEMBERS
            | p::DEAFEN_MEMBERS
            | p::MOVE_MEMBERS
            | p::PRIORITY_SPEAKER
            | p::REQUEST_TO_SPEAK
            | p::USE_SOUNDBOARD
            | p::USE_EXTERNAL_SOUNDS);
    }
    perms
}

pub fn rank(guild: &Guild, user_id: &str, member: Option<&Member>) -> i32 {
    if guild.owner_id == user_id {
        return i32::MAX;
    }
    let Some(m) = member else { return 0 };
    guild
        .roles
        .iter()
        .filter(|r| m.roles.contains(&r.id))
        .map(|r| r.position)
        .max()
        .unwrap_or(0)
        .max(0)
}

pub fn outranks(
    guild: &Guild,
    me_id: &str,
    me: Option<&Member>,
    target_id: &str,
    target: Option<&Member>,
) -> bool {
    target_id != guild.owner_id
        && target_id != me_id
        && rank(guild, me_id, me) > rank(guild, target_id, target)
}

pub fn can_timeout(
    guild: &Guild,
    me_id: &str,
    me: Option<&Member>,
    target_id: &str,
    target: Option<&Member>,
) -> bool {
    if !has(base_perms(guild, me_id, me), p::MODERATE_MEMBERS) {
        return false;
    }
    if !outranks(guild, me_id, me, target_id, target) {
        return false;
    }
    let cleared = target.map(|t| {
        let mut clone = t.clone();
        clone.communication_disabled_until = None;
        clone
    });
    base_perms(guild, target_id, cleared.as_ref()) != p::ALL
}

pub fn can_manage_role(guild: &Guild, me_id: &str, me: Option<&Member>, role: &Role) -> bool {
    rank(guild, me_id, me) > role.position
}

pub fn sorted_roles(guild: &Guild) -> Vec<Role> {
    let mut roles = guild.roles.clone();
    roles.sort_by(|a, b| b.position.cmp(&a.position).then_with(|| a.id.cmp(&b.id)));
    roles
}

pub fn bypasses_slowmode(perms: u64) -> bool {
    has(perms, p::MANAGE_MESSAGES) || has(perms, p::MANAGE_CHANNELS)
}

pub fn is_stage_moderator(perms: u64) -> bool {
    has(perms, p::MUTE_MEMBERS) && has(perms, p::MOVE_MEMBERS)
}

pub fn can_manage_event(perms: u64, event: &ScheduledEvent, me_id: &str) -> bool {
    has(perms, p::MANAGE_EVENTS)
        || (has(perms, p::CREATE_EVENTS) && event.creator_id.as_deref() == Some(me_id))
}

pub fn can_watch(perms: u64) -> bool {
    has(perms, p::CONNECT) && has(perms, p::STREAM)
}

pub fn can_control_watch(host_id: &str, control: &str, me_id: Option<&str>) -> bool {
    me_id.is_some_and(|me| host_id == me || control == "everyone")
}

pub fn can_manage_watch(perms: u64, host_id: &str, me_id: Option<&str>) -> bool {
    me_id.is_some_and(|me| host_id == me) || has(perms, p::MOVE_MEMBERS)
}

pub fn can_set_voice_status(perms: u64, connected: bool) -> bool {
    has(perms, p::MANAGE_CHANNELS) || (connected && has(perms, p::SEND_MESSAGES))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Overwrite;

    #[test]
    fn permission_hierarchy_and_overwrites() {
        let g = Guild {
            id: "g".into(),
            name: "Arena".into(),
            owner_id: "o".into(),
            roles: vec![
                Role {
                    id: "g".into(),
                    name: "@everyone".into(),
                    position: 0,
                    permissions: (p::VIEW_CHANNEL
                        | p::SEND_MESSAGES
                        | p::ATTACH_FILES
                        | p::SEND_MESSAGES_IN_THREADS)
                        .to_string(),
                    ..Default::default()
                },
                Role {
                    id: "r".into(),
                    name: "Staff".into(),
                    position: 1,
                    permissions: p::KICK_MEMBERS.to_string(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let m = Member {
            roles: vec!["r".into()],
            ..Default::default()
        };
        let ch = Channel {
            id: "c".into(),
            kind: 0,
            permission_overwrites: vec![
                Overwrite {
                    id: "g".into(),
                    kind: 0,
                    allow: "0".into(),
                    deny: (p::VIEW_CHANNEL | p::SEND_MESSAGES).to_string(),
                },
                Overwrite {
                    id: "r".into(),
                    kind: 0,
                    allow: p::VIEW_CHANNEL.to_string(),
                    deny: "0".into(),
                },
            ],
            ..Default::default()
        };
        assert_eq!(
            channel_perms(&g, "u", Some(&m), &ch, None),
            p::VIEW_CHANNEL | p::KICK_MEMBERS | p::SEND_MESSAGES_IN_THREADS
        );
        assert_eq!(channel_perms(&g, "x", None, &ch, None), 0);
        assert_eq!(channel_perms(&g, "o", None, &ch, None), p::ALL);
        assert!(outranks(&g, "u", Some(&m), "x", None));
        assert!(!outranks(&g, "u", Some(&m), "o", None));
        let thread = Channel {
            id: "t".into(),
            kind: 11,
            parent_id: Some("c".into()),
            ..Default::default()
        };
        assert!(has(
            channel_perms(&g, "u", Some(&m), &thread, Some(&ch)),
            p::SEND_MESSAGES
        ));
    }
}
