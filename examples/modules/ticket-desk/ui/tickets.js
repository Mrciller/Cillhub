// Support Ticket Desk client script
let ctx = null;
let state = {
  tickets: [],
  is_staff: false,
  user_id: null,
  categories: [],
};
let activeFilter = 'all';
let searchQuery = '';
let selectedTicketId = null;

// DOM Elements
const statusBar = document.getElementById('status-bar');
const roleBadge = document.getElementById('role-badge');
const ticketListEl = document.getElementById('ticket-list');
const searchInput = document.getElementById('search-input');
const newTicketBtn = document.getElementById('new-ticket-btn');

// State Views
const viewEmpty = document.getElementById('view-empty');
const viewCreate = document.getElementById('view-create');
const viewTicket = document.getElementById('view-ticket');

// Create View Elements
const cancelCreateBtn = document.getElementById('cancel-create-btn');
const newCategory = document.getElementById('new-category');
const newSubject = document.getElementById('new-subject');
const newMessage = document.getElementById('new-message');
const submitTicketBtn = document.getElementById('submit-ticket-btn');

// Detail View Elements
const detailId = document.getElementById('detail-id');
const detailCat = document.getElementById('detail-cat');
const detailStatus = document.getElementById('detail-status');
const activeTicketTitle = document.getElementById('active-ticket-title');
const detailMeta = document.getElementById('detail-meta');
const messagesList = document.getElementById('messages-list');
const messagesContainer = document.getElementById('messages-container');
const replyInput = document.getElementById('reply-input');
const sendReplyBtn = document.getElementById('send-reply-btn');
const replyComposer = document.getElementById('reply-composer');

const btnClaim = document.getElementById('btn-claim');
const btnClose = document.getElementById('btn-close');
const btnReopen = document.getElementById('btn-reopen');

function setStatus(text, isError = false) {
  statusBar.textContent = text;
  statusBar.className = isError ? 'status-bar error' : 'status-bar';
  if (text) {
    setTimeout(() => {
      if (statusBar.textContent === text) statusBar.textContent = '';
    }, 4000);
  }
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(ctx ? ctx.locale : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderSidebar() {
  roleBadge.textContent = state.is_staff ? 'Staff' : 'Member';
  roleBadge.className = `badge ${state.is_staff ? 'staff' : ''}`;

  ticketListEl.replaceChildren();

  let filtered = state.tickets || [];

  if (activeFilter !== 'all') {
    filtered = filtered.filter((t) => t.status === activeFilter);
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter((t) =>
      t.subject.toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q) ||
      String(t.number).includes(q) ||
      (t.user_name && t.user_name.toLowerCase().includes(q))
    );
  }

  if (!filtered.length) {
    const li = document.createElement('li');
    li.className = 'empty-item';
    li.textContent = searchQuery ? 'No tickets match search.' : 'No tickets found.';
    ticketListEl.appendChild(li);
    return;
  }

  for (const t of filtered) {
    const li = document.createElement('li');
    li.className = `ticket-item ${t.id === selectedTicketId ? 'selected' : ''}`;
    li.addEventListener('click', () => selectTicket(t.id));

    const topRow = document.createElement('div');
    topRow.className = 'item-top';

    const numSpan = document.createElement('span');
    numSpan.className = 'item-num';
    numSpan.textContent = `#${t.number}`;

    const catBadge = document.createElement('span');
    catBadge.className = 'item-cat';
    catBadge.textContent = t.category;

    const statusDot = document.createElement('span');
    statusDot.className = `item-status ${t.status}`;
    statusDot.textContent = t.status.toUpperCase();

    topRow.append(numSpan, catBadge, statusDot);

    const subjectDiv = document.createElement('div');
    subjectDiv.className = 'item-subject';
    subjectDiv.textContent = t.subject;

    const metaRow = document.createElement('div');
    metaRow.className = 'item-meta';
    metaRow.textContent = `${t.user_name || 'Member'} · ${formatDate(t.updated_at)}`;

    li.append(topRow, subjectDiv, metaRow);
    ticketListEl.appendChild(li);
  }
}

function showView(viewName) {
  viewEmpty.classList.add('hidden');
  viewCreate.classList.add('hidden');
  viewTicket.classList.add('hidden');

  if (viewName === 'create') viewCreate.classList.remove('hidden');
  else if (viewName === 'ticket') viewTicket.classList.remove('hidden');
  else viewEmpty.classList.remove('hidden');
}

function selectTicket(id) {
  selectedTicketId = id;
  const ticket = state.tickets.find((t) => t.id === id);
  if (!ticket) {
    showView('empty');
    renderSidebar();
    return;
  }

  renderSidebar();
  showView('ticket');

  detailId.textContent = `#${ticket.number}`;
  detailCat.textContent = ticket.category;
  detailStatus.textContent = ticket.status.toUpperCase();
  detailStatus.className = `status-badge ${ticket.status}`;
  activeTicketTitle.textContent = ticket.subject;

  const claimInfo = ticket.claimed_by ? ` · Claimed by ${ticket.claimed_by.name}` : '';
  detailMeta.textContent = `Opened by ${ticket.user_name} · ${formatDate(ticket.created_at)}${claimInfo}`;

  // Action buttons visibility
  const isClosed = ticket.status === 'closed';
  const isClaimed = ticket.status === 'claimed';

  btnClaim.classList.toggle('hidden', !state.is_staff || isClosed || isClaimed);
  btnReopen.classList.toggle('hidden', !state.is_staff || !isClosed);
  btnClose.classList.toggle('hidden', isClosed);

  // Messages thread
  messagesList.replaceChildren();
  for (const m of ticket.messages || []) {
    const bubble = document.createElement('div');
    bubble.className = `msg-bubble ${m.is_system ? 'system' : m.is_staff ? 'staff' : 'user'}`;

    if (m.is_system) {
      bubble.textContent = m.content;
    } else {
      const msgHeader = document.createElement('div');
      msgHeader.className = 'msg-header';

      const authorName = document.createElement('span');
      authorName.className = 'msg-author';
      authorName.textContent = m.author_name || 'Member';

      if (m.is_staff) {
        const staffTag = document.createElement('span');
        staffTag.className = 'staff-tag';
        staffTag.textContent = 'STAFF';
        msgHeader.appendChild(staffTag);
      }

      const msgTime = document.createElement('span');
      msgTime.className = 'msg-time';
      msgTime.textContent = formatDate(m.timestamp);

      msgHeader.prepend(authorName);
      msgHeader.appendChild(msgTime);

      const msgBody = document.createElement('div');
      msgBody.className = 'msg-body';
      msgBody.textContent = m.content;

      bubble.append(msgHeader, msgBody);
    }

    messagesList.appendChild(bubble);
  }

  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  // Composer state
  replyComposer.classList.toggle('disabled', isClosed);
  replyInput.disabled = isClosed;
  sendReplyBtn.disabled = isClosed;
  replyInput.placeholder = isClosed ? 'This ticket is closed.' : 'Write a reply...';
}

async function doAction(data, successMsg) {
  try {
    const res = await CillhubPanel.request(data);
    state = res;
    renderSidebar();
    if (selectedTicketId) selectTicket(selectedTicketId);
    if (successMsg) setStatus(successMsg);
    return true;
  } catch (err) {
    setStatus(err.message, true);
    return false;
  }
}

// Search input
searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  renderSidebar();
});

// Filter Tabs
for (const f of ['all', 'open', 'claimed', 'closed']) {
  const tabBtn = document.getElementById(`tab-${f}`);
  if (tabBtn) {
    tabBtn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
      tabBtn.classList.add('active');
      activeFilter = f;
      renderSidebar();
    });
  }
}

// Navigation / New Ticket View Toggle
newTicketBtn.addEventListener('click', () => {
  selectedTicketId = null;
  renderSidebar();
  showView('create');
  newSubject.focus();
});

cancelCreateBtn.addEventListener('click', () => {
  showView('empty');
});

// Submit Ticket
submitTicketBtn.addEventListener('click', async () => {
  const subject = newSubject.value.trim();
  const message = newMessage.value.trim();
  const category = newCategory.value;

  if (!subject) {
    setStatus('Please enter a ticket subject.', true);
    newSubject.focus();
    return;
  }
  if (!message) {
    setStatus('Please describe your issue.', true);
    newMessage.focus();
    return;
  }

  submitTicketBtn.disabled = true;
  const ok = await doAction(
    { action: 'open', subject, message, category },
    'Ticket submitted successfully!'
  );
  submitTicketBtn.disabled = false;

  if (ok) {
    newSubject.value = '';
    newMessage.value = '';
    // Select newest ticket (first item)
    if (state.tickets.length) {
      selectTicket(state.tickets[0].id);
    }
  }
});

// Send Reply
async function sendReply() {
  const text = replyInput.value.trim();
  if (!text || !selectedTicketId) return;

  sendReplyBtn.disabled = true;
  const ok = await doAction({ action: 'reply', id: selectedTicketId, message: text });
  sendReplyBtn.disabled = false;

  if (ok) {
    replyInput.value = '';
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

sendReplyBtn.addEventListener('click', sendReply);
replyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendReply();
  }
});

// Ticket Actions: Claim, Close, Reopen
btnClaim.addEventListener('click', () => {
  if (selectedTicketId) doAction({ action: 'claim', id: selectedTicketId }, 'Ticket claimed.');
});

btnClose.addEventListener('click', () => {
  if (!selectedTicketId) return;
  doAction({ action: 'close', id: selectedTicketId, reason: 'Resolved' }, 'Ticket closed.');
});

btnReopen.addEventListener('click', () => {
  if (selectedTicketId) doAction({ action: 'reopen', id: selectedTicketId }, 'Ticket reopened.');
});

// Bridge events
CillhubPanel.onContext((c) => {
  ctx = c;
  document.documentElement.dataset.theme = c.theme;
  document.documentElement.lang = c.locale;
});

CillhubPanel.onEvent((data) => {
  if (data && data.type === 'tickets_updated') {
    CillhubPanel.request({ action: 'list' }).then((res) => {
      state = res;
      renderSidebar();
      if (selectedTicketId) selectTicket(selectedTicketId);
    });
  }
});

CillhubPanel.ready().then(() => {
  doAction({ action: 'list' });
});
