// v6 customization: settings validation, display name styles, decorations, nameplates, profile themes and widgets, role
// icons and gradient colours, server tags, splash/accent, channel icons, welcome background, greetings, user sounds,
// entrance sounds (LiveKit and cillvoice) and the admin's default voice backend
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startServer, guildWith, bits, png } from './helpers.js';

const uri = (type, b) => `data:${type};base64,${b.toString('base64')}`;
// a minimal Ogg Opus file whose last granule position sets the length (as in stage.test.js)
function ogg(seconds) {
  const head = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead'), Buffer.from([1, 2, 0x38, 0x01]), Buffer.alloc(8)]);
  const last = Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 4]), Buffer.alloc(8), Buffer.alloc(16)]);
  last.writeBigUInt64LE(BigInt(Math.round(seconds * 48000) + 312), 6);
  return Buffer.concat([head, last]);
}
const webp = size => { const b = Buffer.alloc(size); b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8 ', 12); return b; };

// a LiveKit stand-in that answers every call (and the admin health check) with 200
let livekit;
const livekitEnv = () => ({
  LIVEKIT_URL: `http://127.0.0.1:${livekit.address().port}`, LIVEKIT_PUBLIC_URL: 'wss://lk.example/livekit',
  LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'test-secret',
});

let srv, api, g, alice, bob, carol;
before(async () => {
  livekit = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise(r => livekit.listen(0, '127.0.0.1', r));
  srv = await startServer({ env: livekitEnv() });
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']);
  ({ alice, bob, carol } = g.users);
  for (const u of [alice, bob, carol]) u.gw = await srv.gateway(u.token);
});
after(async () => {
  await srv.stop();
  livekit.close();
});

test('settings: themes, custom CSS cap, fonts, sounds, keybinds are validated and synced', async () => {
  const patch = body => api('PATCH', '/users/@me/settings', alice.token, body);
  const theme = { id: 'neon-night', name: 'Neon Night', background: '#0B0C10', surface: '#1f2833', accent: '#66fcf1', text: '#c5c6c7', gradient: ['#0b0c10', '#1f2833'] };
  const ok = await patch({ custom_themes: [theme], active_theme: 'neon-night' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.custom_themes[0].background, '#0b0c10', 'stored lower-case');
  assert.equal((await alice.gw.event('USER_SETTINGS_UPDATE')).custom_themes[0].id, 'neon-night');
  for (const bad of [
    { custom_themes: [{ ...theme, accent: 'red' }] },
    { custom_themes: [{ ...theme, accent: 'url(javascript:alert(1))' }] },
    { custom_themes: [{ ...theme, gradient: ['#000000', '#111111', '#222222'] }] },
    { custom_themes: Array.from({ length: 11 }, (_, i) => ({ ...theme, id: `t${i}` })) },
    { custom_themes: [theme, theme] },
    { custom_themes: [{ name: 'no id', background: '#000000' }] },
    { custom_css: 'a'.repeat(50 * 1024 + 1) },
    { chat_font: 'Comic Sans; } body { display:none' },
    { chat_line_height: 9 },
    { chat_background: 'abcdef' },
    { sound_settings: { events: { mention: { sound: 'ping', volume: 101 } } } },
    { sound_settings: { loud: true } },
    { keybinds: { 'push to talk': 'ctrl+m' } },
    { entrance_sound: { sound_id: '123', guild_id: g.guild.id } },
    { default_emoji_skin_tone: 6 },
  ]) assert.equal((await patch(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  const full = await patch({
    custom_css: 'a'.repeat(50 * 1024), custom_css_enabled: true, chat_font: 'open_dyslexic', chat_line_height: 1.6, message_spacing: 8,
    chat_background_opacity: 40, default_emoji_skin_tone: 3, show_avatars: false, show_timestamps: true,
    sound_settings: { muted: false, volume: 80, events: { mention: { sound: 'blip', volume: 50 }, dm: { sound: null } } },
    keybinds: { push_to_talk: 'ctrl+space', toggle_mute: 'ctrl+shift+m', mark_read: null, 'quick-switcher': 'Ctrl+KeyK' },
  });
  assert.equal(full.status, 200);
  assert.deepEqual(full.body.sound_settings.events.dm, { sound: null, volume: 100 });
  assert.equal((await api('GET', '/users/@me/settings', alice.token)).body.custom_css.length, 50 * 1024);
  const ready = await srv.gateway(alice.token);
  assert.equal(ready.ready.user_settings.keybinds.push_to_talk, 'ctrl+space');
  ready.ws.close();
});

test('chat background and user sounds: uploads are checked and served', async () => {
  const bg = await api('PUT', '/users/@me/chat-background', alice.token, { image: uri('image/png', png(64, 64)) });
  assert.match(bg.body.chat_background, /^[0-9a-f]{32}$/);
  assert.equal((await alice.gw.event('USER_SETTINGS_UPDATE', d => 'chat_background' in d)).chat_background, bg.body.chat_background);
  assert.equal((await fetch(`${srv.origin}/chat-backgrounds/${alice.id}/${bg.body.chat_background}.png`)).headers.get('content-type'), 'image/png');
  assert.equal((await api('PUT', '/users/@me/chat-background', alice.token, { image: 'data:text/html;base64,PGh0bWw+' })).status, 400);
  assert.equal((await api('DELETE', '/users/@me/chat-background', alice.token)).status, 204);
  assert.equal((await fetch(`${srv.origin}/chat-backgrounds/${alice.id}/${bg.body.chat_background}`)).status, 404);

  const up = body => api('POST', '/users/@me/sounds', bob.token, body);
  assert.equal((await up({ name: 'long', sound: uri('audio/ogg', ogg(6)) })).body.errors.sound._errors[0].code, 'SOUND_INVALID');
  assert.equal((await up({ name: 'big', sound: uri('audio/ogg', Buffer.concat([ogg(1), Buffer.alloc(256 * 1024)])) })).status, 400);
  assert.equal((await up({ name: 'fake', sound: uri('audio/ogg', png()) })).status, 400);
  const s = await up({ name: 'horn', sound: uri('audio/ogg', ogg(1.5)), volume: 0.5 });
  assert.deepEqual([s.status, s.body.name, s.body.url], [201, 'horn', `/user-sounds/${s.body.id}`]);
  const file = await fetch(`${srv.origin}${s.body.url}`);
  assert.deepEqual([file.status, file.headers.get('content-type')], [200, 'audio/ogg']);
  assert.equal((await api('GET', '/users/@me/sounds', bob.token)).body.length, 1);
  assert.equal((await api('DELETE', `/users/@me/sounds/${s.body.id}`, alice.token)).status, 404, 'only your own');
});

test('display name styles, decorations, nameplates, profile theme, effect and widgets reach others', async () => {
  const patch = body => api('PATCH', '/users/@me', alice.token, body);
  assert.equal((await patch({ display_name_font_id: 99 })).status, 400);
  assert.equal((await patch({ display_name_effect_id: 2, display_name_colors: [1, 2, 3] })).status, 400);
  assert.equal((await patch({ display_name_colors: [0x1000000] })).status, 400);
  const fontOnly = await patch({ display_name_font_id: 101, display_name_effect_id: 1, display_name_colors: [] });
  assert.deepEqual(fontOnly.body.display_name_styles, { font_id: 101, effect_id: 1, colors: [] }, 'a bundled font without own colours');
  await bob.gw.event('USER_UPDATE', d => d.id === alice.id);
  const styled = await patch({ display_name_font_id: 14, display_name_effect_id: 2, display_name_colors: [0xff0055, 0x5500ff] });
  assert.deepEqual(styled.body.display_name_styles, { font_id: 14, effect_id: 2, colors: [0xff0055, 0x5500ff] });
  const seen = await bob.gw.event('USER_UPDATE', d => d.id === alice.id);
  assert.deepEqual(seen.display_name_styles, styled.body.display_name_styles);
  assert.equal(seen.email, undefined, 'others get the public user');

  assert.equal((await patch({ avatar_decoration_sku_id: 'Bad Name!' })).status, 400);
  assert.equal((await patch({ avatar_decoration_sku_id: '123456' })).status, 400, 'unknown server decoration');
  const deco = await patch({ avatar_decoration_sku_id: 'neon_ring', nameplate_sku_id: 'circuit', nameplate_palette: 'cobalt' });
  assert.deepEqual(deco.body.avatar_decoration_data, { asset: 'neon_ring', sku_id: '0', expires_at: null });
  assert.deepEqual(deco.body.collectibles, { nameplate: { asset: 'circuit', sku_id: '0', label: 'circuit', palette: 'cobalt', expires_at: null } });
  assert.equal((await patch({ nameplate_palette: 'rainbow' })).status, 400);
  const other = await bob.gw.event('USER_UPDATE', d => d.id === alice.id && d.collectibles);
  assert.equal(other.avatar_decoration_data.asset, 'neon_ring');
  // the member list and messages carry it too
  const msg = (await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: 'styled' })).body;
  assert.equal(msg.author.collectibles.nameplate.asset, 'circuit');

  for (const bad of [
    { theme_colors: [1] }, { theme_colors: [1, 'x'] }, { profile_effect_id: 'Confetti!' },
    { widgets: [{ type: 'socials', links: [{ platform: 'twitch', url: 'http://twitch.tv/nightfall' }] }] },
    { widgets: [{ type: 'socials', links: [{ platform: 'twitch', url: 'https://evil.example/twitch.tv' }] }] },
    { widgets: [{ type: 'socials', links: [{ platform: 'steam', url: 'https://user:pw@steamcommunity.com/id/x' }] }] },
    { widgets: [{ type: 'socials', links: [{ platform: 'myspace', url: 'https://myspace.com/x' }] }] },
    { widgets: [{ type: 'socials', links: [{ platform: 'toString', url: 'https://twitch.tv/x' }] }] },
    { widgets: [{ type: 'rank', game: 'CS2' }] },
    { widgets: [{ type: 'main_game', game: 'a' }, { type: 'main_game', game: 'b' }] },
    { widgets: [{ type: 'main_game', game: 'a' }, { type: 'rank', game: 'b', rank: 'c' }, { type: 'socials', links: [{ platform: 'x', url: 'https://x.com/a' }] }, { type: 'main_game', game: 'd' }] },
  ]) assert.equal((await patch(bad)).status, 400, JSON.stringify(bad));
  const profile = await patch({
    theme_colors: [0x0b0c10, 0x66fcf1], profile_effect_id: 'embers',
    widgets: [
      { type: 'main_game', game: 'Counter-Strike 2' },
      { type: 'socials', links: [{ platform: 'twitch', url: 'https://www.twitch.tv/nightfall' }, { platform: 'faceit', url: 'https://faceit.com/en/players/ciller' }] },
      { type: 'rank', game: 'CS2', rank: 'Level 10' },
    ],
  });
  assert.equal(profile.status, 200);
  const p = (await api('GET', `/users/${alice.id}/profile`, bob.token)).body;
  assert.deepEqual(p.user_profile.theme_colors, [0x0b0c10, 0x66fcf1]);
  assert.deepEqual(p.user_profile.profile_effect, { id: 'embers', expires_at: null });
  assert.deepEqual(p.user_profile.widgets.map(w => w.type), ['main_game', 'socials', 'rank']);
  assert.equal(p.user_profile.widgets[1].links[0].url, 'https://www.twitch.tv/nightfall');

  // per-server name style override
  const m = await api('PATCH', `/guilds/${g.guild.id}/members/@me`, bob.token, { display_name_font_id: 8, display_name_effect_id: 3, display_name_colors: [0x00ff00] });
  assert.deepEqual(m.body.display_name_styles, { font_id: 8, effect_id: 3, colors: [0x00ff00] });
  assert.deepEqual((await alice.gw.event('GUILD_MEMBER_UPDATE', d => d.user.id === bob.id)).display_name_styles, m.body.display_name_styles);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/members/@me`, bob.token, { display_name_font_id: null, display_name_effect_id: null, display_name_colors: null })).body.display_name_styles, null);
});

test('server avatar decorations: MANAGE_GUILD_EXPRESSIONS, worn by members, removed with the decoration', async () => {
  const image = uri('image/png', png(128, 128));
  assert.equal((await api('POST', `/guilds/${g.guild.id}/avatar-decorations`, bob.token, { name: 'Gold frame', image })).status, 403);
  assert.equal((await api('POST', `/guilds/${g.guild.id}/avatar-decorations`, alice.token, { name: 'Huge', image: uri('image/webp', webp(512 * 1024 + 1)) })).status, 400);
  assert.equal((await api('POST', `/guilds/${g.guild.id}/avatar-decorations`, alice.token, { name: 'Jpeg', image: uri('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0])) })).status, 400);
  const d = await api('POST', `/guilds/${g.guild.id}/avatar-decorations`, alice.token, { name: 'Gold frame', image });
  assert.equal(d.status, 201);
  assert.equal((await bob.gw.event('GUILD_AVATAR_DECORATIONS_UPDATE')).avatar_decorations[0].id, d.body.id);
  assert.equal((await fetch(`${srv.origin}/avatar-decoration-presets/${d.body.asset}.png`)).headers.get('content-type'), 'image/png');
  const outsider = await srv.register('outsider');
  assert.equal((await api('PATCH', '/users/@me', outsider.token, { avatar_decoration_sku_id: d.body.id })).status, 400, 'members only');
  const worn = await api('PATCH', '/users/@me', bob.token, { avatar_decoration_sku_id: d.body.id });
  assert.deepEqual(worn.body.avatar_decoration_data, { asset: d.body.asset, sku_id: d.body.id, expires_at: null, guild_id: g.guild.id });
  const ready = await srv.gateway(carol.token);
  assert.equal(ready.ready.guilds[0].avatar_decorations.length, 1);
  ready.ws.close();
  assert.equal((await api('DELETE', `/guilds/${g.guild.id}/avatar-decorations/${d.body.id}`, alice.token)).status, 204);
  assert.equal((await alice.gw.event('USER_UPDATE', u => u.id === bob.id && u.avatar_decoration_data === null)).id, bob.id);
  assert.equal((await fetch(`${srv.origin}/avatar-decoration-presets/${d.body.asset}.png`)).status, 404);
});

test('role icons and gradient colours (MANAGE_ROLES), per the docs', async () => {
  const role = (await api('POST', `/guilds/${g.guild.id}/roles`, alice.token, { name: 'Pro', colors: { primary_color: 0xff0000, secondary_color: 0x0000ff }, unicode_emoji: '🏆' })).body;
  assert.deepEqual([role.color, role.colors, role.unicode_emoji, role.icon], [0xff0000, { primary_color: 0xff0000, secondary_color: 0x0000ff, tertiary_color: null }, '🏆', null]);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/roles/${role.id}`, bob.token, { unicode_emoji: '🔥' })).status, 403);
  for (const bad of [{ unicode_emoji: 'abc' }, { unicode_emoji: '🔥🔥🔥 and text' }, { icon: uri('image/png', Buffer.concat([png(), Buffer.alloc(256 * 1024)])) },
    { icon: uri('image/gif', Buffer.from('GIF89a')) }, { colors: { primary_color: -1 } }, { icon: uri('image/png', png()), unicode_emoji: '🔥' }]) {
    assert.equal((await api('PATCH', `/guilds/${g.guild.id}/roles/${role.id}`, alice.token, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  const withIcon = await api('PATCH', `/guilds/${g.guild.id}/roles/${role.id}`, alice.token, { icon: uri('image/png', png(64, 64)) });
  assert.deepEqual([withIcon.body.unicode_emoji, /^[0-9a-f]{32}$/.test(withIcon.body.icon)], [null, true], 'an icon replaces the emoji');
  const event = await bob.gw.event('GUILD_ROLE_UPDATE', d => d.role.id === role.id && d.role.icon);
  assert.equal(event.role.icon, withIcon.body.icon);
  for (const path of [`/role-icons/${role.id}/${withIcon.body.icon}.png`, `/roles/${role.id}/icons/${withIcon.body.icon}.png`]) {
    assert.equal((await fetch(srv.origin + path)).status, 200, path);
  }
  const holo = await api('PATCH', `/guilds/${g.guild.id}/roles/${role.id}`, alice.token, { colors: { primary_color: 1, secondary_color: 2, tertiary_color: 3 } });
  assert.deepEqual(holo.body.colors, { primary_color: 11127295, secondary_color: 16759788, tertiary_color: 16761760 });
  const plain = await api('PATCH', `/guilds/${g.guild.id}/roles/${role.id}`, alice.token, { colors: { primary_color: 0x00ff00, secondary_color: null }, icon: null });
  assert.deepEqual([plain.body.colors.secondary_color, plain.body.colors.tertiary_color, plain.body.icon], [null, null, null]);
  assert.equal((await fetch(`${srv.origin}/role-icons/${role.id}/${withIcon.body.icon}.png`)).status, 404, 'old icon removed');
});

test('server tag: MANAGE_GUILD, tag rules, members show it, it follows tag changes and leaving', async () => {
  const profile = body => api('PATCH', `/guilds/${g.guild.id}/profile`, body.as ?? alice.token, body);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/profile`, bob.token, { tag: 'CILL' })).status, 403);
  for (const tag of ['A', 'TOOLONG', 'C!L', 'a b']) assert.equal((await profile({ tag })).status, 400, tag);
  assert.equal((await profile({ badge: 41 })).status, 400);
  assert.equal((await profile({ brand_color_primary: 'blue' })).status, 400);
  assert.equal((await api('PUT', '/users/@me/clan', bob.token, { identity_guild_id: g.guild.id, identity_enabled: true })).status, 400, 'no tag yet');
  const p = await profile({ tag: 'CILL', badge: 27, badge_color_primary: '#FFD700', badge_color_secondary: '#000000', brand_color_primary: '#5865F2', badge_image: uri('image/png', png(32, 32)) });
  assert.deepEqual([p.body.tag, p.body.badge, p.body.badge_color_primary, p.body.brand_color_primary], ['CILL', 27, '#ffd700', '#5865f2']);
  const gu = await bob.gw.event('GUILD_UPDATE', d => d.profile);
  assert.deepEqual([gu.profile.tag, gu.brand_color_primary], ['CILL', '#5865f2']);
  assert.equal((await fetch(`${srv.origin}/guild-tag-badges/${g.guild.id}/${p.body.badge_hash}.png`)).status, 200);
  assert.equal((await api('GET', `/guilds/${g.guild.id}/profile`, bob.token)).body.tag, 'CILL');

  const outsider = await srv.register('tagless');
  assert.equal((await api('PUT', '/users/@me/clan', outsider.token, { identity_guild_id: g.guild.id, identity_enabled: true })).status, 400, 'members only');
  const me = await api('PUT', '/users/@me/clan', bob.token, { identity_guild_id: g.guild.id, identity_enabled: true });
  assert.deepEqual([me.body.primary_guild.tag, me.body.primary_guild.identity_guild_id, me.body.primary_guild.badge], ['CILL', g.guild.id, p.body.badge_hash]);
  assert.equal((await alice.gw.event('USER_UPDATE', d => d.id === bob.id && d.primary_guild)).primary_guild.tag, 'CILL');
  await profile({ tag: 'CLR' });
  assert.equal((await alice.gw.event('USER_UPDATE', d => d.id === bob.id && d.primary_guild?.tag === 'CLR')).primary_guild.badge_type, 27);
  // leaving the server drops the tag
  const leaver = await srv.register('leaver');
  assert.equal((await api('POST', `/invites/${g.invite.code}`, leaver.token)).status, 200);
  await api('PUT', '/users/@me/clan', leaver.token, { identity_guild_id: g.guild.id });
  assert.equal((await api('GET', '/users/@me', leaver.token)).body.primary_guild.tag, 'CLR');
  await api('DELETE', `/users/@me/guilds/${g.guild.id}`, leaver.token);
  assert.equal((await api('GET', '/users/@me', leaver.token)).body.primary_guild, null);
  assert.equal((await api('PUT', '/users/@me/clan', bob.token, { identity_enabled: false })).body.primary_guild, null);
});

test('server splash, banner, channel icons and accent, welcome background, greeting templates', async () => {
  const splash = await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { splash: uri('image/png', png(960, 540)), banner: uri('image/png', png(960, 540)) });
  assert.match(splash.body.splash, /^[0-9a-f]{32}$/);
  assert.ok(splash.body.features.includes('INVITE_SPLASH'));
  const inv = (await api('GET', `/invites/${g.invite.code}`)).body;
  assert.deepEqual([inv.guild.splash, inv.guild.banner, inv.guild.brand_color_primary], [splash.body.splash, splash.body.banner, '#5865f2']);
  for (const [kind, hash] of [['splashes', splash.body.splash], ['banners', splash.body.banner]]) {
    assert.equal((await fetch(`${srv.origin}/${kind}/${g.guild.id}/${hash}.png`)).status, 200, kind);
  }
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}`, bob.token, { splash: null })).status, 403);

  const ch = c => api('PATCH', `/channels/${g.general.id}`, alice.token, c);
  for (const bad of [{ icon_emoji: { name: 'not an emoji' } }, { icon_emoji: { id: '1', name: '🔥' } }, { icon_emoji: { id: '123' } }, { theme_color: 0x1000000 }, { icon_emoji: 'x' }]) {
    assert.equal((await ch(bad)).status, 400, JSON.stringify(bad));
  }
  const styled = await ch({ icon_emoji: { name: '🎮' }, theme_color: 0x66fcf1 });
  assert.deepEqual([styled.body.icon_emoji, styled.body.theme_color], [{ id: null, name: '🎮' }, 0x66fcf1]);
  assert.deepEqual((await bob.gw.event('CHANNEL_UPDATE', d => d.id === g.general.id && d.icon_emoji)).icon_emoji, { id: null, name: '🎮' });
  assert.equal((await api('PATCH', `/channels/${g.general.id}`, bob.token, { theme_color: 1 })).status, 403);

  const w = await api('PATCH', `/guilds/${g.guild.id}/welcome-screen`, alice.token, { enabled: true, background: uri('image/png', png(800, 400)), accent_color: 0xff8800 });
  assert.deepEqual([/^[0-9a-f]{32}$/.test(w.body.background), w.body.accent_color], [true, 0xff8800]);
  assert.equal((await fetch(`${srv.origin}/welcome-backgrounds/${g.guild.id}/${w.body.background}.png`)).status, 200);

  assert.equal((await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { greeting_templates: Array.from({ length: 11 }, () => 'hi {user}') })).status, 400);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { greeting_templates: [''] })).status, 400);
  const set = await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { greeting_templates: ['Welcome {user}, glhf!'] });
  assert.deepEqual(set.body.greeting_templates, ['Welcome {user}, glhf!']);
  const newbie = await srv.register('newbie');
  await api('POST', `/invites/${g.invite.code}`, newbie.token);
  const join = await alice.gw.event('MESSAGE_CREATE', m => m.type === 7 && m.author.id === newbie.id);
  assert.equal(join.content, 'Welcome {user}, glhf!');
});

// VOICE_CHANNEL_EFFECT_SEND with entrance: true reaches everyone in the channel when the user joins
async function entranceFlow(s, a, b, gid, voiceId, soundId, guildIdOfSound, expectEndpoint) {
  const join = (gw, ch = voiceId) => gw.send({ op: 4, d: { guild_id: gid, channel_id: ch, self_mute: false, self_deaf: false } });
  const leave = gw => gw.send({ op: 4, d: { guild_id: gid, channel_id: null, self_mute: false, self_deaf: false } });
  assert.equal((await s.api('PATCH', '/users/@me/settings', b.token, { entrance_sound: { sound_id: soundId, guild_id: guildIdOfSound } })).status, 200);
  join(a.gw);
  assert.equal((await a.gw.event('VOICE_SERVER_UPDATE')).endpoint, expectEndpoint);
  a.gw.frames.length = 0; // earlier joins of the same user would match below
  join(b.gw);
  assert.equal((await b.gw.event('VOICE_SERVER_UPDATE')).endpoint, expectEndpoint);
  // it arrives before the joiner's VOICE_STATE_UPDATE, so clients can play it instead of their join chime
  const first = await a.gw.wait(f => f.t === 'VOICE_CHANNEL_EFFECT_SEND' || (f.t === 'VOICE_STATE_UPDATE' && f.d.user_id === b.id && f.d.channel_id === voiceId));
  assert.equal(first.t, 'VOICE_CHANNEL_EFFECT_SEND');
  const fx = first.d;
  assert.deepEqual([fx.user_id, fx.sound_id, fx.entrance, fx.channel_id], [b.id, soundId, true, voiceId]);
  assert.equal((await b.gw.event('VOICE_CHANNEL_EFFECT_SEND')).user_id, b.id, 'the joiner hears it too');
  leave(b.gw);
  leave(a.gw);
  await a.gw.event('VOICE_STATE_UPDATE', d => d.user_id === a.id && d.channel_id === null);
  return fx;
}

test('entrance sounds with LiveKit: soundboard or own sound, USE_SOUNDBOARD and the server switch apply', async () => {
  const sound = (await api('POST', `/guilds/${g.guild.id}/soundboard-sounds`, alice.token, { name: 'airhorn', sound: uri('audio/ogg', ogg(1)) })).body;
  const fx = await entranceFlow(srv, alice, bob, g.guild.id, g.voice.id, sound.sound_id, g.guild.id, 'wss://lk.example/livekit');
  assert.equal(fx.sound_url, `/soundboard-sounds/${sound.sound_id}`);
  const own = (await api('POST', '/users/@me/sounds', bob.token, { name: 'mine', sound: uri('audio/ogg', ogg(2)) })).body;
  assert.equal((await entranceFlow(srv, alice, bob, g.guild.id, g.voice.id, own.id, null, 'wss://lk.example/livekit')).sound_url, own.url);

  const join = (gw, ch) => gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: ch, self_mute: false, self_deaf: false } });
  // without USE_SOUNDBOARD in the channel: silence
  await api('PUT', `/channels/${g.voice.id}/permissions/${bob.id}`, alice.token, { type: 1, deny: bits(42) });
  join(alice.gw, g.voice.id);
  join(bob.gw, g.voice.id);
  await bob.gw.event('VOICE_SERVER_UPDATE');
  assert.ok(await alice.gw.none(f => f.t === 'VOICE_CHANNEL_EFFECT_SEND', 400));
  join(bob.gw, null);
  await api('DELETE', `/channels/${g.voice.id}/permissions/${bob.id}`, alice.token);
  // the server can turn entrance sounds off
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { entrance_sounds_enabled: false })).body.entrance_sounds_enabled, false);
  join(bob.gw, g.voice.id);
  await bob.gw.event('VOICE_SERVER_UPDATE');
  assert.ok(await alice.gw.none(f => f.t === 'VOICE_CHANNEL_EFFECT_SEND', 400));
  join(bob.gw, null);
  join(alice.gw, null);
  await api('PATCH', `/guilds/${g.guild.id}`, alice.token, { entrance_sounds_enabled: true });
  // deleting the sound clears the setting
  await api('DELETE', `/users/@me/sounds/${own.id}`, bob.token);
  assert.equal((await api('GET', '/users/@me/settings', bob.token)).body.entrance_sound, null);
});

test('default voice backend: admin switches new calls to cillvoice; a running call keeps LiveKit; entrance sounds on cillvoice', async () => {
  const s = await startServer({ env: { ...livekitEnv(), CILLVOICE_UDP_PORT: '3362', CILLVOICE_PUBLIC_IP: '127.0.0.1' } });
  try {
    const vg = await guildWith(s, ['vadmin', 'vbob', 'vcarol']);
    const { vadmin, vbob, vcarol } = vg.users;
    for (const u of [vadmin, vbob, vcarol]) u.gw = await s.gateway(u.token);
    // vadmin becomes an instance admin (CLI) with 2FA
    execFileSync(process.execPath, ['src/admin-cli.js', 'grant', 'vadmin'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: s.dataDir }, stdio: 'ignore' });
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const key = Buffer.from('48656c6c6f21deadbeef48656c6c6f21deadbeef', 'hex');
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
    const h = createHmac('sha1', key).update(msg).digest();
    const code = String((h.readUInt32BE(h[19] & 0xf) & 0x7fffffff) % 1_000_000).padStart(6, '0');
    assert.equal((await s.api('POST', '/users/@me/mfa/totp/enable', vadmin.token, { password: 'hunter2hunter2', secret, code })).status, 200);
    const settings = (await s.api('GET', '/admin/settings', vadmin.token)).body;
    assert.deepEqual(settings.voice, { configured: ['livekit', 'cillvoice'], default: 'livekit' });
    assert.equal((await s.api('GET', '/admin/overview', vadmin.token)).body.voice.backends.livekit.reachable, true);

    const join = (gw, ch) => gw.send({ op: 4, d: { guild_id: vg.guild.id, channel_id: ch, self_mute: false, self_deaf: false } });
    join(vbob.gw, vg.voice.id);
    assert.equal((await vbob.gw.event('VOICE_SERVER_UPDATE')).endpoint, 'wss://lk.example/livekit');
    assert.equal((await s.api('PATCH', '/admin/settings', vadmin.token, { voice_backend: 'cillvoice' })).body.voice.default, 'cillvoice');
    join(vcarol.gw, vg.voice.id);
    assert.equal((await vcarol.gw.event('VOICE_SERVER_UPDATE')).endpoint, 'wss://lk.example/livekit', 'the running call keeps its backend');
    join(vbob.gw, null);
    join(vcarol.gw, null);
    await vbob.gw.event('VOICE_STATE_UPDATE', d => d.user_id === vcarol.id && d.channel_id === null);

    const sound = (await s.api('POST', `/guilds/${vg.guild.id}/soundboard-sounds`, vadmin.token, { name: 'gong', sound: uri('audio/ogg', ogg(1)) })).body;
    await entranceFlow(s, vbob, vcarol, vg.guild.id, vg.voice.id, sound.sound_id, vg.guild.id, 'cillvoice');
  } finally {
    await s.stop();
  }
});
