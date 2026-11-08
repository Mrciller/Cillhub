// Panel script: everything goes through CillhubPanel (the postMessage bridge); no network, no storage.
const listEl = document.getElementById('list');
const statusEl = document.getElementById('status');
const field = (id) => document.getElementById(id);
const addButton = field('add-button');
let ctx = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function button(label, onClick, className = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.className = className;
  b.addEventListener('click', onClick);
  return b;
}

function render({ scrims, can_manage }) {
  const fmt = new Intl.DateTimeFormat(ctx.locale, { dateStyle: 'medium', timeStyle: 'short' });
  listEl.replaceChildren();
  if (!scrims.length) {
    const li = document.createElement('li');
    li.textContent = 'No upcoming scrims yet.';
    listEl.append(li);
  }
  for (const s of scrims) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'opponent';
    name.textContent = `vs ${s.opponent}`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${fmt.format(new Date(s.at))} · ${s.players.length}/${s.slots} players`;
    const players = document.createElement('span');
    players.className = 'players';
    players.textContent = s.players.length ? s.players.map((p) => p.name).join(', ') : 'Nobody has joined yet.';

    const actions = document.createElement('div');
    actions.className = 'actions';
    const joined = s.players.some((p) => p.id === ctx.user.id);
    if (joined) actions.append(button('Leave', () => act({ action: 'leave', id: s.id }, 'Left.')));
    else if (s.players.length < s.slots) actions.append(button('Join', () => act({ action: 'join', id: s.id }, 'Joined.'), 'primary'));
    if (s.creator_id === ctx.user.id || can_manage) {
      actions.append(button('Remove', () => act({ action: 'remove', id: s.id }, 'Removed.'), 'danger'));
    }
    // Screen readers hear which scrim a button belongs to.
    for (const b of actions.children) b.setAttribute('aria-label', `${b.textContent} scrim vs ${s.opponent}`);

    li.append(name, meta, players, actions);
    listEl.append(li);
  }
}

async function act(data, doneText) {
  try {
    render(await CillhubPanel.request(data));
    if (doneText) setStatus(doneText); // a background refresh keeps the last message
    return true;
  } catch (err) {
    setStatus(err.message, true);
    return false;
  }
}

const refresh = () => ctx && act({ action: 'list' }, '');

async function add() {
  addButton.disabled = true;
  const ok = await act({
    action: 'add',
    opponent: field('opponent').value,
    at: new Date(field('at').value).getTime(), // datetime-local is the user's local time
    slots: Number(field('slots').value),
  }, 'Scrim added.');
  addButton.disabled = false;
  if (ok) field('opponent').value = '';
}

addButton.addEventListener('click', add);
for (const input of document.querySelectorAll('#add input')) {
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
}

CillhubPanel.onContext((c) => {
  ctx = c;
  document.documentElement.dataset.theme = c.theme;
  document.documentElement.lang = c.locale;
});
CillhubPanel.onEvent((data) => { if (data && data.type === 'changed') refresh(); });
CillhubPanel.ready().then(refresh);
