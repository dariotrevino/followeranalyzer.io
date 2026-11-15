let followersData = null;
let followingData = null;
let ghostList = [];
let reverseList = [];
let mutualList = [];

// Saving is opt-in. Nothing is written to localStorage unless the visitor
// ticks "Remember this analysis", and unticking deletes the saved copy.
const STORAGE_KEY = 'fa_last_analysis_v1';
const REMEMBER_KEY = 'fa_remember_v1';
const STORAGE_MAX_BYTES = 2.5 * 1024 * 1024;

// Follower / following totals for the analysis on screen. Kept separately
// because a large saved analysis does not include the two full lists.
let totals = { following: null, followers: null };

const uploadFile = document.getElementById('uploadFile');
const uploadZone = document.getElementById('uploadZone');
const followersStatus = document.getElementById('followersStatus');
const followingStatus = document.getElementById('followingStatus');
const uploadStatus = document.getElementById('uploadStatus');
const analyzeBtn = document.getElementById('analyzeBtn');
const rememberToggle = document.getElementById('rememberToggle');
const rememberHint = document.getElementById('rememberHint');
const REMEMBER_HINT_OFF = rememberHint.textContent;
const REMEMBER_HINT_ON = 'Saved in this browser only. Untick to delete the saved copy.';
const REMEMBER_HINT_FAILED = 'This browser would not save it (storage is full or blocked).';


// ── Untrusted input ────────────────────────────────────────────────────────
//
// Everything in an export file (and anything read back from localStorage) is
// treated as untrusted. Usernames must look like real Instagram usernames
// before they are kept, and all text is escaped before it goes into the page.

// Instagram usernames: letters, digits, periods and underscores, up to 30 chars.
const USERNAME_RE = /^[a-z0-9._]{1,30}$/;

// instagram.com path segments that are pages, not profiles.
const NOT_PROFILES = new Set(['_u', 'p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'direct', 'tv']);

// Returns a clean lowercase username, or null if the value is not one.
function cleanUsername(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase();
  return USERNAME_RE.test(name) && !NOT_PROFILES.has(name) ? name : null;
}

// Pulls the username out of a profile link (handles the /_u/ form too).
function usernameFromHref(href) {
  if (typeof href !== 'string') return null;
  const m = href.match(/instagram\.com\/_u\/([^/?#\s]+)/) || href.match(/instagram\.com\/([^/?#\s]+)/);
  return m ? cleanUsername(m[1]) : null;
}

// The only shape a user record is allowed to have. The profile link is always
// rebuilt from the validated username, never copied from the file.
function makeUser(username, date) {
  return {
    username,
    href: 'https://www.instagram.com/' + username,
    date: typeof date === 'string' ? date.trim().slice(0, 40) : ''
  };
}

// Re-validates a list that came from somewhere we do not control.
function sanitizeUsers(list) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(list)) return out;
  for (const u of list) {
    const name = cleanUsername(u && u.username);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(makeUser(name, u.date));
  }
  return out;
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}


// ── Parsers ────────────────────────────────────────────────────────────────

// HTML export: followers use /instagram.com/username, following uses /instagram.com/_u/username
function parseHTML(htmlText) {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  const users = [];
  const seen = new Set();

  doc.querySelectorAll('a[href*="instagram.com/"]').forEach(link => {
    const username = usernameFromHref(link.getAttribute('href'));
    if (!username || seen.has(username)) return;
    seen.add(username);

    // Date is in the next sibling div
    let dateText = '';
    const parent = link.closest('div');
    if (parent) {
      const sib = parent.nextElementSibling;
      if (sib && sib.tagName === 'DIV') dateText = sib.textContent;
    }

    users.push(makeUser(username, dateText));
  });

  return users;
}

// JSON export:
//   followers_1.json  →  array of { title, string_list_data: [{value, href, timestamp}] }
//   following.json    →  { relationships_following: [ { title, string_list_data: [{href, timestamp}] } ] }
//
// Key difference: following entries have the username in `title` and in the `href`,
// but NOT in string_list_data[].value (that field is absent). Followers have it in value.
function parseJSON(jsonText) {
  const users = [];
  const seen = new Set();

  let data;
  try { data = JSON.parse(jsonText); } catch { return users; }

  const processItem = item => {
    const list = item?.string_list_data;
    const entry = Array.isArray(list) ? list[0] : null;

    // First field that holds a valid username wins: title (following),
    // then value (followers), then the profile link as a last resort.
    const username = cleanUsername(item?.title) || cleanUsername(entry?.value) || usernameFromHref(entry?.href);

    if (!username || seen.has(username)) return;
    seen.add(username);

    let dateText = '';
    const stamp = Number(entry?.timestamp);
    if (Number.isFinite(stamp) && stamp > 0) {
      const d = new Date(stamp * 1000);
      if (!isNaN(d)) dateText = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }
    users.push(makeUser(username, dateText));
  };

  // Followers: top-level array
  if (Array.isArray(data)) data.forEach(processItem);

  // Following: object with relationships_following key
  if (Array.isArray(data?.relationships_following)) data.relationships_following.forEach(processItem);

  return users;
}

function parseFile(text, filename) {
  const isJSON = filename.toLowerCase().endsWith('.json');
  return isJSON ? parseJSON(text) : parseHTML(text);
}


// ── File helpers ───────────────────────────────────────────────────────────

function readFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = () => rej(new Error('read error'));
    r.readAsText(file);
  });
}

function readFileAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = () => rej(new Error('read error'));
    r.readAsArrayBuffer(file);
  });
}

function basename(path) {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

function classifyPath(path) {
  const name = basename(path).toLowerCase();
  if (!/\.(json|html?)$/i.test(name)) return null;
  if (/^following(\.(json|html?))?$/.test(name) || name.startsWith('following.') || name === 'following') {
    return 'following';
  }
  if (/^followers(_\d+)?(\.(json|html?))?$/.test(name) || name.startsWith('followers')) {
    return 'followers';
  }
  return null;
}

function mergeUsers(existing, incoming) {
  const seen = new Set((existing || []).map(u => u.username));
  const out = existing ? existing.slice() : [];
  for (const u of incoming) {
    if (!seen.has(u.username)) { seen.add(u.username); out.push(u); }
  }
  return out;
}

function updateZoneUI() {
  followersStatus.classList.remove('error', 'warn');
  followingStatus.classList.remove('error', 'warn');
  uploadStatus.classList.remove('error', 'warn');
  followersStatus.textContent = followersData ? ('✓ ' + followersData.length + ' followers loaded') : '';
  followingStatus.textContent = followingData ? ('✓ ' + followingData.length + ' following loaded') : '';
  uploadZone.classList.remove('loaded', 'partial');
  if (followersData && followingData) {
    uploadZone.classList.add('loaded');
    uploadStatus.textContent = 'Ready to analyze';
  } else if (followersData || followingData) {
    uploadZone.classList.add('partial');
    uploadStatus.textContent = 'Still need ' + (!followersData ? 'followers' : 'following') + ' file(s)';
    uploadStatus.classList.add('warn');
  } else {
    uploadStatus.textContent = '';
  }
  analyzeBtn.disabled = !(followersData && followingData);
}

function setFollowers(users) {
  if (!users || users.length === 0) {
    followersStatus.textContent = '✗ No followers found — is this the right file?';
    followersStatus.classList.add('error');
    return false;
  }
  followersData = users;
  return true;
}

function setFollowing(users) {
  if (!users || users.length === 0) {
    followingStatus.textContent = '✗ No following found — is this the right file?';
    followingStatus.classList.add('error');
    return false;
  }
  followingData = users;
  return true;
}


async function handleZip(file) {
  const ZipLib = window['JSZip'];
  if (!ZipLib) {
    uploadStatus.textContent = '✗ ZIP support failed to load. Try dropping unzipped JSON/HTML files.';
    uploadStatus.classList.add('error');
    return;
  }
  uploadStatus.classList.remove('error');
  uploadStatus.textContent = 'Reading ZIP…';
  try {
    const buf = await readFileAsArrayBuffer(file);
    const zip = await ZipLib.loadAsync(buf);
    const followerEntries = [];
    const followingEntries = [];

    zip.forEach((relativePath, entry) => {
      if (entry.dir) return;
      const kind = classifyPath(relativePath);
      if (kind === 'followers') followerEntries.push(entry);
      else if (kind === 'following') followingEntries.push(entry);
    });

    const preferConn = entries => {
      const preferred = entries.filter(e => /followers_and_following/i.test(e.name));
      return preferred.length ? preferred : entries;
    };

    const folFiles = preferConn(followerEntries);
    const fingFiles = preferConn(followingEntries);

    let allFollowers = [];
    for (const entry of folFiles) {
      const text = await entry.async('string');
      allFollowers = mergeUsers(allFollowers, parseFile(text, entry.name));
    }
    let allFollowing = [];
    for (const entry of fingFiles) {
      const text = await entry.async('string');
      allFollowing = mergeUsers(allFollowing, parseFile(text, entry.name));
    }

    if (allFollowers.length) setFollowers(allFollowers);
    if (allFollowing.length) setFollowing(allFollowing);

    if (!allFollowers.length && !allFollowing.length) {
      uploadStatus.textContent = '✗ No followers/following files found in ZIP';
      uploadStatus.classList.add('error');
    } else {
      const bits = [];
      if (folFiles.length) bits.push(folFiles.length + ' followers file(s)');
      if (fingFiles.length) bits.push(fingFiles.length + ' following file(s)');
      uploadStatus.textContent = '✓ ZIP imported (' + bits.join(', ') + ')';
    }
  } catch (err) {
    uploadStatus.textContent = '✗ Could not read ZIP — try unzipping and dropping the files';
    uploadStatus.classList.add('error');
  }
  updateZoneUI();
}

async function handleLooseFiles(files) {
  uploadStatus.classList.remove('error');
  const followerFiles = [];
  const followingFiles = [];
  const unknown = [];
  const zips = [];

  for (const f of files) {
    if (/\.zip$/i.test(f.name)) { zips.push(f); continue; }
    const kind = classifyPath(f.name);
    if (kind === 'followers') followerFiles.push(f);
    else if (kind === 'following') followingFiles.push(f);
    else if (/\.(json|html?)$/i.test(f.name)) unknown.push(f);
  }

  for (const z of zips) await handleZip(z);

  if (followerFiles.length) {
    try {
      let all = followersData || [];
      for (const file of followerFiles) {
        all = mergeUsers(all, parseFile(await readFile(file), file.name));
      }
      setFollowers(all);
    } catch {
      followersStatus.textContent = '✗ Error reading followers file';
      followersStatus.classList.add('error');
    }
  }

  if (followingFiles.length) {
    try {
      let all = followingData || [];
      for (const file of followingFiles) {
        all = mergeUsers(all, parseFile(await readFile(file), file.name));
      }
      setFollowing(all);
    } catch {
      followingStatus.textContent = '✗ Error reading following file';
      followingStatus.classList.add('error');
    }
  }

  for (const file of unknown) {
    try {
      const text = await readFile(file);
      const users = parseFile(text, file.name);
      if (!users.length) continue;
      if (!followersData) setFollowers(users);
      else if (!followingData) setFollowing(users);
      else followersData = mergeUsers(followersData, users);
      uploadStatus.textContent = 'Routed ' + file.name + ' by content (filename unclear)';
      uploadStatus.classList.add('warn');
    } catch {}
  }
  updateZoneUI();
}

async function handleIncomingFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  await handleLooseFiles(files);
}

uploadFile.addEventListener('change', () => {
  if (uploadFile.files.length) handleIncomingFiles(uploadFile.files);
});
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  handleIncomingFiles(e.dataTransfer.files);
});

document.getElementById('skipToUpload').addEventListener('click', () => {
  document.getElementById('exportGuide').open = false;
  uploadZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
  uploadZone.classList.add('drag-over');
  setTimeout(() => uploadZone.classList.remove('drag-over'), 800);
});


function runAnalysis(options) {
  options = options || {};
  if (!followersData || !followingData) return;

  const followerSet  = new Set(followersData.map(u => u.username));
  const followingSet = new Set(followingData.map(u => u.username));

  ghostList   = followingData.filter(u => !followerSet.has(u.username));
  reverseList = followersData.filter(u => !followingSet.has(u.username));
  mutualList  = followingData.filter(u => followerSet.has(u.username));

  document.getElementById('statGhosts').textContent    = ghostList.length;
  document.getElementById('statReverse').textContent   = reverseList.length;
  document.getElementById('statMutuals').textContent   = mutualList.length;
  document.getElementById('statFollowing').textContent = followingData.length;
  document.getElementById('statFollowers').textContent = followersData.length;
  totals = { following: followingData.length, followers: followersData.length };

  resetLookup();
  document.getElementById('results').style.display = 'block';
  renderList(ghostList,   'listGhosts',  'ghost');
  renderList(reverseList, 'listReverse', 'reverse');
  renderList(mutualList,  'listMutuals', 'mutual');
  document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (!options.fromRestore) {
    syncSavedAnalysis();
    setTimeout(() => document.getElementById('coffeeBanner').classList.add('visible'), 1200);
  }
}

analyzeBtn.addEventListener('click', () => runAnalysis());

// Writes the analysis on screen to localStorage. Returns true if it was saved.
// Only call this through syncSavedAnalysis(), which checks the opt-in first.
function saveLastAnalysis() {
  try {
    const slim = {
      savedAt: Date.now(),
      counts: {
        ghosts: ghostList.length,
        reverse: reverseList.length,
        mutuals: mutualList.length,
        following: totals.following,
        followers: totals.followers
      },
      ghosts: ghostList,
      reverse: reverseList,
      mutuals: mutualList
    };
    const full = (followingData && followersData)
      ? Object.assign({}, slim, { following: followingData, followers: followersData })
      : slim;

    // Very large accounts: drop the two full lists and keep the three results.
    let raw = JSON.stringify(full);
    if (raw.length > STORAGE_MAX_BYTES) raw = JSON.stringify(slim);
    if (raw.length > STORAGE_MAX_BYTES) return false;

    localStorage.setItem(STORAGE_KEY, raw);
    return true;
  } catch { return false; }
}

function rememberEnabled() {
  try { return localStorage.getItem(REMEMBER_KEY) === '1'; } catch { return false; }
}

function setRemember(on) {
  try {
    if (on) localStorage.setItem(REMEMBER_KEY, '1');
    else localStorage.removeItem(REMEMBER_KEY);
  } catch {}
  rememberToggle.checked = on;
  rememberHint.textContent = on ? REMEMBER_HINT_ON : REMEMBER_HINT_OFF;
}

function forgetSavedAnalysis() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

// Makes storage match the checkbox: save the analysis on screen if the
// visitor opted in, otherwise make sure nothing is stored.
function syncSavedAnalysis() {
  if (!rememberToggle.checked) { forgetSavedAnalysis(); return; }
  if (!saveLastAnalysis()) {
    setRemember(false);
    forgetSavedAnalysis();
    rememberHint.textContent = REMEMBER_HINT_FAILED;
  }
}

rememberToggle.addEventListener('change', () => {
  setRemember(rememberToggle.checked);
  syncSavedAnalysis();
});

function loadSavedAnalysis() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

// "Dismiss & clear": delete the saved copy and turn remembering back off, so
// the next analysis in this browser is not saved without a fresh opt-in.
function clearSavedAnalysis() {
  forgetSavedAnalysis();
  setRemember(false);
  document.getElementById('restoreBanner').classList.remove('visible');
}

function offerRestore() {
  const saved = loadSavedAnalysis();
  if (!saved || !Array.isArray(saved.ghosts) || !Array.isArray(saved.reverse)) return;
  const banner = document.getElementById('restoreBanner');
  const when = saved.savedAt ? new Date(saved.savedAt) : null;
  const whenStr = when ? when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const c = saved.counts || {};
  document.getElementById('restoreMeta').textContent =
    ' ' + (c.ghosts != null ? c.ghosts : saved.ghosts.length) + ' not following back · ' +
    (c.mutuals != null ? c.mutuals : (saved.mutuals || []).length) + ' mutuals' +
    (whenStr ? (' · saved ' + whenStr) : '');
  banner.classList.add('visible');

  document.getElementById('restoreBtn').onclick = () => {
    // Saved data is re-validated exactly like a freshly dropped file.
    ghostList = sanitizeUsers(saved.ghosts);
    reverseList = sanitizeUsers(saved.reverse);
    mutualList = sanitizeUsers(saved.mutuals);
    followingData = Array.isArray(saved.following) ? sanitizeUsers(saved.following) : null;
    followersData = Array.isArray(saved.followers) ? sanitizeUsers(saved.followers) : null;

    // Large analyses are saved without the full lists, so fall back to the saved totals.
    const savedCount = v => (Number.isFinite(Number(v)) && v != null ? Number(v) : '—');
    document.getElementById('statGhosts').textContent    = ghostList.length;
    document.getElementById('statReverse').textContent   = reverseList.length;
    document.getElementById('statMutuals').textContent   = mutualList.length;
    document.getElementById('statFollowing').textContent = followingData ? followingData.length : savedCount(c.following);
    document.getElementById('statFollowers').textContent = followersData ? followersData.length : savedCount(c.followers);
    const total = (data, saved) => (data ? data.length : (typeof savedCount(saved) === 'number' ? savedCount(saved) : null));
    totals = { following: total(followingData, c.following), followers: total(followersData, c.followers) };

    resetLookup();

    document.getElementById('results').style.display = 'block';
    renderList(ghostList,   'listGhosts',  'ghost');
    renderList(reverseList, 'listReverse', 'reverse');
    renderList(mutualList,  'listMutuals', 'mutual');
    banner.classList.remove('visible');
    document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (followersData && followingData) updateZoneUI();
  };
  document.getElementById('clearSavedBtn').onclick = clearSavedAnalysis;
}

// Nothing is kept without the opt-in. That includes analyses saved by older
// versions of this page, which saved automatically: those are removed here.
if (rememberEnabled()) {
  setRemember(true);
  offerRestore();
} else {
  forgetSavedAnalysis();
}

// The privacy note links to an FAQ answer; open it when it is the link target.
function openLinkedAnswer() {
  const target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
  if (target && target.tagName === 'DETAILS') target.open = true;
}
window.addEventListener('hashchange', openLinkedAnswer);
openLinkedAnswer();


function renderList(list, listId, mode) {
  const el = document.getElementById(listId);
  const isReverse = mode === 'reverse';
  const isMutual = mode === 'mutual';
  if (list.length === 0) {
    const msg = isMutual ? 'No mutual follows found.' : isReverse ? 'You follow everyone back!' : 'Everyone follows you back!';
    const emoji = isMutual ? '🤝' : isReverse ? '🤝' : '🎉';
    el.innerHTML = '<div class="empty-state"><div class="big">' + emoji + '</div>' + msg + '<br>(or no matches found)</div>';
    return;
  }
  const cardClass = isMutual ? ' mutual-hover' : isReverse ? ' blue-hover' : '';
  const avatarClass = isMutual ? ' purple' : isReverse ? ' blue' : '';
  const metaLabel = isMutual ? 'Mutual since' : isReverse ? 'Followed you' : 'You followed';
  el.innerHTML = list.map((u, i) => userCardHTML(u, i, { cardClass, avatarClass, metaLabel })).join('');
}

// The one card template, used by every list. Everything that came from an
// export file is escaped here, so no caller can put raw file text in the page.
// badgeHTML is the exception: it must be markup built by this script only.
function userCardHTML(u, i, opts) {
  const o = opts || {};
  return `
    <div class="user-card${o.cardClass || ''}" style="animation-delay:${Math.min(i * 0.02, 0.5)}s">
      <div class="user-info">
        <div class="user-avatar${o.avatarClass || ''}">${esc(u.username.charAt(0).toUpperCase())}</div>
        <div>
          <div class="username">@${esc(u.username)}${o.badgeHTML || ''}</div>
          ${u.date ? `<div class="user-meta">${esc(o.metaLabel)} ${esc(u.date)}</div>` : ''}
        </div>
      </div>
      <a class="user-link" href="${esc(u.href)}" target="_blank" rel="noopener">View Profile ↗</a>
    </div>`;
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
  });
});

document.getElementById('searchReverse').addEventListener('input', function() {
  renderList(reverseList.filter(u => u.username.includes(this.value.toLowerCase())), 'listReverse', 'reverse');
});
document.getElementById('searchMutuals').addEventListener('input', function() {
  renderList(mutualList.filter(u => u.username.includes(this.value.toLowerCase())), 'listMutuals', 'mutual');
});

// Usernames and links are validated, so only the free-text date needs care:
// quote it, and stop a spreadsheet from running it as a formula.
function csvText(value) {
  let s = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function exportCSV(list, filename) {
  const csv = ['username,instagram_url,date', ...list.map(u => `${u.username},${u.href},${csvText(u.date)}`)].join('\n');
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: filename
  });
  a.click();
}

document.getElementById('exportGhosts').addEventListener('click',  () => exportCSV(ghostList,   'not_following_back.csv'));
document.getElementById('exportReverse').addEventListener('click', () => exportCSV(reverseList, 'not_followed_back.csv'));
document.getElementById('exportMutuals').addEventListener('click', () => exportCSV(mutualList,  'mutuals.csv'));

document.getElementById('bannerDismiss').addEventListener('click', () => {
  document.getElementById('coffeeBanner').classList.remove('visible');
});

document.getElementById('shareBtn').addEventListener('click', () => {
  const text = 'I just found out who doesn\'t follow me back on Instagram using Follower Analyzer — runs entirely in your browser, no login needed.';
  const url = window.location.href;
  if (navigator.share) {
    navigator.share({ title: 'Follower Analyzer', text, url }).catch(() => {});
  } else {
    const tweetUrl = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text + ' ' + url);
    window.open(tweetUrl, '_blank', 'noopener');
  }
});

// ── Account lookup ─────────────────────────────────────────────────────────
//
// Looks each "not following back" username up in Instagram search, through a
// public proxy. A miss is only a hint: search also hides private, restricted
// and low-ranked accounts, so the UI says "not found in search", never
// "deleted". This is the only code that sends list data off the device.
//
// Status per username: 'checking' | 'found' | 'notfound' | 'unknown'
const lookupStatus = {};
let verifyRunning = false;
let lookupRun = 0;            // bumped on reset so an in-flight run stops
let currentGhostFilter = 'all';

const hasAnswer = username => lookupStatus[username] === 'found' || lookupStatus[username] === 'notfound';

document.getElementById('verifyBtn').addEventListener('click', startVerification);

// Clears every lookup result. Called whenever the list on screen is replaced.
function resetLookup() {
  lookupRun++;
  verifyRunning = false;
  for (const name of Object.keys(lookupStatus)) delete lookupStatus[name];
  currentGhostFilter = 'all';

  const btn = document.getElementById('verifyBtn');
  btn.disabled = false;
  btn.textContent = 'Check accounts';
  document.getElementById('verifyProgress').style.display = 'none';
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('progressText').textContent = 'Checking...';
  document.getElementById('filterRowGhosts').style.display = 'none';
  document.querySelectorAll('.filter-btn[data-list="ghosts"]').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === 'all');
  });
}

async function startVerification() {
  if (verifyRunning || !ghostList.length) return;
  verifyRunning = true;
  const run = lookupRun;

  const btn = document.getElementById('verifyBtn');
  const progress = document.getElementById('verifyProgress');
  const fill = document.getElementById('progressFill');
  const text = document.getElementById('progressText');

  btn.disabled = true;
  btn.textContent = 'Checking...';
  progress.style.display = 'block';
  fill.style.width = '0%';

  // Only look up accounts that have no answer yet, so a retry does not resend
  // usernames that were already resolved. If all have one, check them all again.
  let targets = ghostList.filter(u => !hasAnswer(u.username));
  if (!targets.length) targets = ghostList.slice();

  const total = targets.length;
  const BATCH = 3;
  const DELAY = 600;

  for (let i = 0; i < total; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    await Promise.all(batch.map(u => checkAccount(u.username, run)));
    if (run !== lookupRun) return;   // list was replaced or cleared mid-run
    const done = Math.min(i + BATCH, total);
    fill.style.width = Math.round((done / total) * 100) + '%';
    text.textContent = 'Checked ' + done + ' of ' + total + ' accounts...';
    renderGhostListWithStatus();
    if (i + BATCH < total) await sleep(DELAY);
    if (run !== lookupRun) return;
  }

  fill.style.width = '100%';
  const count = status => ghostList.filter(u => lookupStatus[u.username] === status).length;
  const unknownCount = count('unknown');
  let summary = 'Done. ' + count('notfound') + ' not found in search · ' + count('found') + ' found';
  if (unknownCount > 0) {
    summary += ' · ' + unknownCount + ' unknown (Instagram or the proxy blocked those lookups)';
  }
  text.textContent = summary;
  btn.textContent = unknownCount > 0 ? 'Retry unknowns' : 'Check again';
  btn.disabled = false;
  verifyRunning = false;

  document.getElementById('filterRowGhosts').style.display = 'flex';
  renderGhostListWithStatus();
}

async function checkAccount(username, run) {
  const set = status => { if (run === lookupRun) lookupStatus[username] = status; };
  set('checking');
  try {
    const target = 'https://www.instagram.com/web/search/topsearch/?query=' + encodeURIComponent(username) + '&context=blended&count=1';
    const proxy  = 'https://api.allorigins.win/get?url=' + encodeURIComponent(target);

    const res = await fetch(proxy, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) { set('unknown'); return; }

    const wrapper = await res.json();
    const httpCode = wrapper && wrapper.status && wrapper.status.http_code;
    if (httpCode !== 200) { set('unknown'); return; }

    const body = wrapper.contents || '';
    let data;
    try { data = JSON.parse(body); } catch { set('unknown'); return; }

    // A response that is not a search result (login page, error) tells us nothing.
    if (!data || !Array.isArray(data.users)) { set('unknown'); return; }

    const found = data.users.some(u => {
      const u2 = (u && u.user) || u;
      return String((u2 && u2.username) || '').toLowerCase() === username;
    });

    set(found ? 'found' : 'notfound');
  } catch {
    set('unknown');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const STATUS_BADGES = {
  notfound: '<span class="status-badge">not found in search</span>',
  checking: '<span class="status-badge muted">checking...</span>',
  unknown:  '<span class="status-badge warn">unknown</span>'
};

function renderGhostListWithStatus() {
  const searchQ = document.getElementById('searchGhosts').value.toLowerCase();
  let list = ghostList.filter(u => u.username.includes(searchQ));

  if (currentGhostFilter === 'found') list = list.filter(u => lookupStatus[u.username] === 'found');
  else if (currentGhostFilter === 'notfound') list = list.filter(u => lookupStatus[u.username] === 'notfound');
  else if (currentGhostFilter === 'unknown') list = list.filter(u => !hasAnswer(u.username));

  const el = document.getElementById('listGhosts');
  if (list.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="big">🎉</div>No accounts match this filter.</div>';
    return;
  }

  el.innerHTML = list.map((u, i) => userCardHTML(u, i, {
    metaLabel: 'You followed',
    badgeHTML: STATUS_BADGES[lookupStatus[u.username]] || ''
  })).join('');
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn');
  if (!btn || btn.dataset.list !== 'ghosts') return;
  document.querySelectorAll('.filter-btn[data-list="ghosts"]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentGhostFilter = btn.dataset.filter;
  renderGhostListWithStatus();
});

document.getElementById('searchGhosts').addEventListener('input', function() {
  if (Object.keys(lookupStatus).length > 0) {
    renderGhostListWithStatus();
  } else {
    renderList(ghostList.filter(u => u.username.includes(this.value.toLowerCase())), 'listGhosts', 'ghost');
  }
});
