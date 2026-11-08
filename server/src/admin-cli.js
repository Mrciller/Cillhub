// The only way to make someone an instance administrator (v6): run on the host, e.g.
//   node src/admin-cli.js grant Ciller          (inside the container: docker exec cillcord node src/admin-cli.js grant Ciller)
//   node src/admin-cli.js revoke someone@example.com
//   node src/admin-cli.js list
// It opens DATA_DIR/cillcord.sqlite directly; the server re-reads the flag on every admin request, so no restart is needed.
import { get, all, run } from './db.js';
import { adminAudit } from './instance.js';

const [cmd, who] = process.argv.slice(2);
const find = login => get(`SELECT * FROM users WHERE ${login.includes('@') ? 'email' : 'username'} = ? AND deleted = 0 AND system = 0`, login);

function main() {
  if (cmd === 'list') {
    const admins = all('SELECT id, username, email, mfa_secret IS NOT NULL AS mfa FROM users WHERE instance_admin = 1 AND deleted = 0');
    if (!admins.length) console.log('No instance administrators.');
    for (const a of admins) console.log(`${a.username}\t${a.email}\t${a.id}\t2FA ${a.mfa ? 'on' : 'OFF (admin routes refused until enabled)'}`);
    return 0;
  }
  if ((cmd !== 'grant' && cmd !== 'revoke') || !who) {
    console.error('usage: node src/admin-cli.js grant|revoke <email|username>\n       node src/admin-cli.js list');
    return 2;
  }
  const u = find(who);
  if (!u) { console.error(`No account "${who}".`); return 1; }
  if (u.bot) { console.error('Bots cannot be instance administrators.'); return 1; }
  run('UPDATE users SET instance_admin = ? WHERE id = ?', cmd === 'grant' ? 1 : 0, u.id);
  adminAudit({ action: `cli.${cmd}`, targetType: 'user', targetId: u.id, details: { username: u.username } });
  console.log(`${cmd === 'grant' ? 'Granted' : 'Revoked'} instance administration for ${u.username} (${u.id}).`);
  if (cmd === 'grant' && !u.mfa_secret) console.log('Note: admin routes stay refused until this account enables two-factor authentication.');
  return 0;
}

process.exitCode = main();
