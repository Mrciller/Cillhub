import { get, all, run } from '../db.js';
import { snowflake } from '../snowflake.js';
import { HttpError, str, invalid, notFound } from '../errors.js';
import { P } from '../permissions.js';
import { loadGuild } from './guilds.js';

const NAME_REGEX = /^[a-z0-9_-]{1,32}$/;

function listSnippets(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  return {
    snippets: all('SELECT * FROM guild_snippets WHERE guild_id = ? ORDER BY name ASC', g.id),
  };
}

function createSnippet(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const count = get('SELECT COUNT(*) AS n FROM guild_snippets WHERE guild_id = ?', g.id).n;
  if (count >= 50) throw new HttpError(400, 50035, 'Maximum of 50 snippets reached for this guild');

  const rawName = str(ctx.body ?? {}, 'name', 1, 32).toLowerCase();
  if (!NAME_REGEX.test(rawName)) throw invalid('name', 'SNIPPET_NAME_INVALID', 'Name must be 1-32 alphanumeric characters, dashes or underscores.');
  if (get('SELECT 1 FROM guild_snippets WHERE guild_id = ? AND name = ?', g.id, rawName)) {
    throw new HttpError(400, 50035, 'A snippet with this name already exists');
  }

  const content = str(ctx.body ?? {}, 'content', 1, 2000);
  const id = snowflake();
  const now = new Date().toISOString();
  run('INSERT INTO guild_snippets (id, guild_id, name, content, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, g.id, rawName, content, ctx.user.id, now);

  ctx.status = 201;
  return get('SELECT * FROM guild_snippets WHERE id = ?', id);
}

function updateSnippet(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const sn = get('SELECT * FROM guild_snippets WHERE id = ? AND guild_id = ?', ctx.params.sid, g.id);
  if (!sn) throw notFound(10015, 'Snippet');

  let name = sn.name;
  let content = sn.content;
  const body = ctx.body ?? {};

  if (body.name !== undefined) {
    name = str(body, 'name', 1, 32).toLowerCase();
    if (!NAME_REGEX.test(name)) throw invalid('name', 'SNIPPET_NAME_INVALID', 'Name must be 1-32 alphanumeric characters, dashes or underscores.');
    if (name !== sn.name && get('SELECT 1 FROM guild_snippets WHERE guild_id = ? AND name = ?', g.id, name)) {
      throw new HttpError(400, 50035, 'A snippet with this name already exists');
    }
  }

  if (body.content !== undefined) {
    content = str(body, 'content', 1, 2000);
  }

  run('UPDATE guild_snippets SET name = ?, content = ? WHERE id = ?', name, content, sn.id);
  return get('SELECT * FROM guild_snippets WHERE id = ?', sn.id);
}

function deleteSnippet(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const sn = get('SELECT * FROM guild_snippets WHERE id = ? AND guild_id = ?', ctx.params.sid, g.id);
  if (!sn) throw notFound(10015, 'Snippet');
  run('DELETE FROM guild_snippets WHERE id = ?', sn.id);
  ctx.status = 204;
}

export default [
  ['GET', '/guilds/:id/snippets', listSnippets],
  ['POST', '/guilds/:id/snippets', createSnippet],
  ['PATCH', '/guilds/:id/snippets/:sid', updateSnippet],
  ['DELETE', '/guilds/:id/snippets/:sid', deleteSnippet],
];
