let selected = null;
const share = document.getElementById('share');
window.picker.onSources(({ sources, audioSupported }) => {
  document.getElementById('audio-wrap').hidden = !audioSupported;
  for (const s of sources) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'src';
    btn.setAttribute('aria-pressed', 'false');
    const img = document.createElement('img');
    img.src = s.thumbnail; img.alt = '';
    const name = document.createElement('span');
    name.textContent = s.name;
    btn.append(img, name);
    btn.addEventListener('click', () => {
      document.querySelectorAll('.src').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      selected = s.id;
      share.disabled = false;
    });
    btn.addEventListener('dblclick', () => share.click());
    document.getElementById(s.id.startsWith('screen:') ? 'screens' : 'windows').append(btn);
  }
  for (const id of ['screens', 'windows']) {
    const grid = document.getElementById(id);
    if (!grid.children.length) grid.hidden = document.getElementById(`h-${id}`).hidden = true;
  }
  document.querySelector('.src')?.focus();
});
share.addEventListener('click', () => selected && window.picker.choose(selected, document.getElementById('audio').checked));
document.getElementById('cancel').addEventListener('click', () => window.picker.choose(null, false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.picker.choose(null, false); });
