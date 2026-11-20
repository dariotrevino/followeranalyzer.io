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
const uploadNote = document.getElementById('uploadNote');
const resetBtn = document.getElementById('resetBtn');
const resetRow = document.getElementById('resetRow');
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
// ts is the follow time in milliseconds (0 if unknown), used for sorting.
function makeUser(username, date, ts) {
  const cleanDate = typeof date === 'string' ? date.trim().slice(0, 40) : '';
  let time = Number(ts);
  if (!Number.isFinite(time) || time <= 0) time = Date.parse(cleanDate) || 0;
  return {
    username,
    href: 'https://www.instagram.com/' + username,
    date: cleanDate,
    ts: time > 0 ? time : 0
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
    out.push(makeUser(name, u.date, u.ts));
  }
  return out;
}

// ── Usage counts ───────────────────────────────────────────────────────────
//
// Tells Google Analytics which steps and buttons are used, so we can see how
// many visitors finish an analysis or click Buy me a coffee. Only the event
// name and a fixed label from this file are sent. Never usernames, list
// sizes, file names or anything else read from an export.
function track(name, params) {
  try {
    if (typeof window.gtag === 'function') window.gtag('event', name, params || {});
  } catch {}
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
    let ts = 0;
    const stamp = Number(entry?.timestamp);
    if (Number.isFinite(stamp) && stamp > 0) {
      const d = new Date(stamp * 1000);
      if (!isNaN(d)) {
        dateText = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        ts = stamp * 1000;
      }
    }
    users.push(makeUser(username, dateText, ts));
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

// Decides what an export file is from its name alone:
//   followers_1.json, followers_2.html, "followers (1).json"  → 'followers'
//   following.json, "following copy.html"                      → 'following'
// Every other file in the export (blocked_profiles, pending_follow_requests,
// following_hashtags, ...) returns null and is ignored. Files are never
// guessed from their content: that is how unrelated lists used to get
// counted as followers.
function classifyPath(path) {
  const name = basename(path).toLowerCase();
  const m = name.match(/^(followers|following)(?:[^a-z]|copy)*\.(json|html?)$/);
  return m ? m[1] : null;
}

function mergeUsers(existing, incoming) {
  const seen = new Set((existing || []).map(u => u.username));
  const out = existing ? existing.slice() : [];
  for (const u of incoming) {
    if (!seen.has(u.username)) { seen.add(u.username); out.push(u); }
  }
  return out;
}

// True once the loaded files have been analyzed (or an analysis was restored).
// The next drop after that starts a new analysis instead of adding to this one.
let analyzed = false;

// Rewrites the three status lines and the buttons from the current state.
function updateZoneUI() {
  followersStatus.textContent = followersData ? ('✓ ' + followersData.length + ' followers loaded') : '';
  followingStatus.textContent = followingData ? ('✓ ' + followingData.length + ' following loaded') : '';
  uploadStatus.classList.remove('error', 'warn');
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
  resetRow.hidden = !(followersData || followingData || analyzed);
}

// Messages about the latest drop: errors, skipped files, what a ZIP held.
// They live in their own element because updateZoneUI() rewrites the status
// lines every time, which used to erase every error before anyone saw it.
const dropNotes = [];

function note(text, level) {
  dropNotes.push({ text, level: level || 'warn' });
}

function showDropNotes() {
  uploadNote.replaceChildren(...dropNotes.map(n => {
    const line = document.createElement('div');
    line.className = 'drop-status' + (n.level === 'ok' ? '' : ' ' + n.level);
    line.textContent = n.text;   // file names are untrusted: text only
    return line;
  }));
}

const shortName = name => (name.length > 48 ? name.slice(0, 45) + '…' : name);

// The latest of a set of times, or 0. Only times Instagram wrote into an
// export ZIP are used: a loose file's date is when it was saved or unzipped
// on this device, which can be much later than the export itself.
function latestTime(times) {
  return times.reduce((max, t) => (Number.isFinite(t) && t > max ? t : max), 0);
}

// Reads the followers and following lists out of an export ZIP without
// touching the analysis on screen. Throws if the file is not a readable ZIP.
async function readZipLists(file) {
  const ZipLib = window['JSZip'];
  if (!ZipLib) throw new Error('nozip');
  const zip = await ZipLib.loadAsync(await readFileAsArrayBuffer(file));
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

  let followers = [];
  for (const entry of folFiles) {
    followers = mergeUsers(followers, parseFile(await entry.async('string'), entry.name));
  }
  let following = [];
  for (const entry of fingFiles) {
    following = mergeUsers(following, parseFile(await entry.async('string'), entry.name));
  }
  const date = latestTime(folFiles.concat(fingFiles).map(e => (e.date ? e.date.getTime() : 0)));
  return { followers, following, folCount: folFiles.length, fingCount: fingFiles.length, date };
}

// When the export on screen was made (0 if unknown). Used to put a
// comparison with another export in the right order.
let currentExportDate = 0;

// A ZIP is a whole export, so the lists it holds replace what was loaded.
async function handleZip(file) {
  if (!window['JSZip']) {
    note('✗ ZIP support did not load. Unzip the export and drop the followers and following files instead.', 'error');
    return;
  }
  try {
    const { followers: allFollowers, following: allFollowing, folCount, fingCount, date } = await readZipLists(file);

    if (allFollowers.length) followersData = allFollowers;
    if (allFollowing.length) followingData = allFollowing;
    if (allFollowers.length || allFollowing.length) currentExportDate = date;

    if (!allFollowers.length && !allFollowing.length) {
      note('✗ No followers or following lists found in ' + shortName(file.name) + '. Export “Followers and following” from Instagram, then drop that ZIP.', 'error');
    } else {
      const bits = [];
      if (allFollowers.length) bits.push(folCount + ' followers file(s)');
      if (allFollowing.length) bits.push(fingCount + ' following file(s)');
      note('✓ Read ' + bits.join(' and ') + ' from ' + shortName(file.name), 'ok');
    }
  } catch (err) {
    note('✗ Could not read ' + shortName(file.name) + '. Try unzipping it and dropping the files inside.', 'error');
  }
}

async function processDrop(files) {
  // Files add up until you analyze them (so followers_1 and followers_2 can
  // be dropped one at a time). After an analysis, a drop begins a new one.
  if (analyzed) startOver();
  dropNotes.length = 0;
  const skipped = [];

  for (const file of files) {
    if (/\.zip$/i.test(file.name)) { await handleZip(file); continue; }

    const kind = classifyPath(file.name);
    if (!kind) { skipped.push(file.name); continue; }

    try {
      const users = parseFile(await readFile(file), file.name);
      if (!users.length) {
        note('✗ No accounts found in ' + shortName(file.name) + '. Is it the right file?', 'error');
      } else {
        if (kind === 'followers') followersData = mergeUsers(followersData, users);
        else followingData = mergeUsers(followingData, users);
        currentExportDate = 0;   // loose files: when the export was made is unknown
      }
    } catch {
      note('✗ Could not read ' + shortName(file.name) + '.', 'error');
    }
  }

  if (skipped.length) {
    const shown = skipped.slice(0, 3).map(shortName).join(', ');
    const more = skipped.length > 3 ? ' and ' + (skipped.length - 3) + ' more' : '';
    note('Ignored ' + skipped.length + ' file(s) that are not followers or following lists: ' + shown + more + '.', 'warn');
  }

  updateZoneUI();
  showDropNotes();
  uploadFile.value = '';   // lets the same file be picked again after a reset

  if (followersData && followingData && !filesReadyTracked) {
    filesReadyTracked = true;
    track('files_ready');
  }
}

// files_ready is counted once per analysis, not once per dropped file.
let filesReadyTracked = false;

// Drops are handled one at a time so two quick drops cannot interleave.
let dropQueue = Promise.resolve();

function handleIncomingFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return dropQueue;
  dropQueue = dropQueue.then(() => processDrop(files)).catch(() => {});
  return dropQueue;
}

// Clears everything on the page. The saved copy, if the visitor opted in to
// one, is left alone: that is controlled by the "Remember" checkbox.
function startOver() {
  followersData = null;
  followingData = null;
  ghostList = [];
  reverseList = [];
  mutualList = [];
  totals = { following: null, followers: null };
  analyzed = false;
  filesReadyTracked = false;
  currentExportDate = 0;
  resetCompare();

  dropNotes.length = 0;
  showDropNotes();
  resetInactiveEstimate();
  document.getElementById('results').style.display = 'none';
  document.getElementById('coffeeBanner').classList.remove('visible');
  ['searchGhosts', 'searchReverse', 'searchMutuals'].forEach(id => { document.getElementById(id).value = ''; });
  uploadFile.value = '';
  updateZoneUI();
}

resetBtn.addEventListener('click', startOver);

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

// Links that jump back up to the tool also flash the drop zone, so it's
// obvious where the file goes.
document.querySelectorAll('a[href="#tool"]').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    uploadZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
    uploadZone.classList.add('drag-over');
    setTimeout(() => uploadZone.classList.remove('drag-over'), 900);
  });
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
  analyzed = true;
  updateZoneUI();

  resetInactiveEstimate();
  resetCompare();
  document.getElementById('results').style.display = 'block';
  renderAllLists();
  document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (!options.fromRestore) {
    syncSavedAnalysis();
    track('analysis_completed');
    showSupportPrompts();
  }
}

// The moment someone sees their results is when they are most grateful, so
// that is when the coffee prompts appear. The banner names how many accounts
// they just found; that number is only shown on the page, never sent anywhere.
function showSupportPrompts() {
  const n = ghostList.length;
  document.getElementById('bannerHook').textContent = n === 0
    ? 'Everyone you follow follows you back. Nice.'
    : 'You just found ' + n.toLocaleString() + (n === 1 ? ' account that doesn’t' : ' accounts that don’t') + ' follow you back.';
  setTimeout(() => document.getElementById('coffeeBanner').classList.add('visible'), 900);

  // Nudge the floating button open for a few seconds so phone visitors, who
  // cannot hover, see what the little cup is.
  const float = document.querySelector('.coffee-float');
  if (float) {
    setTimeout(() => float.classList.add('peek'), 2500);
    setTimeout(() => float.classList.remove('peek'), 8000);
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

    // Large analyses are saved without the two full lists, so the follower and
    // following totals fall back to the saved numbers (or a dash if unusable).
    const savedCount = v => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
    totals = {
      following: followingData ? followingData.length : savedCount(c.following),
      followers: followersData ? followersData.length : savedCount(c.followers)
    };
    document.getElementById('statGhosts').textContent    = ghostList.length;
    document.getElementById('statReverse').textContent   = reverseList.length;
    document.getElementById('statMutuals').textContent   = mutualList.length;
    document.getElementById('statFollowing').textContent = totals.following != null ? totals.following : '—';
    document.getElementById('statFollowers').textContent = totals.followers != null ? totals.followers : '—';

    resetInactiveEstimate();
    resetCompare();
    // A saved analysis does not record when its export was made.
    currentExportDate = 0;

    document.getElementById('results').style.display = 'block';
    renderAllLists();
    banner.classList.remove('visible');
    document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    analyzed = true;
    updateZoneUI();
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
  const metaLabel = isReverse ? 'Followed you' : 'You followed';
  el.innerHTML = list.map((u, i) => userCardHTML(u, i, { cardClass, avatarClass, metaLabel })).join('');
}

// The one card template, used by every list. Everything that came from an
// export file is escaped here, so no caller can put raw file text in the page.
function userCardHTML(u, i, opts) {
  const o = opts || {};
  return `
    <div class="user-card${o.cardClass || ''}" style="animation-delay:${Math.min(i * 0.02, 0.5)}s">
      <div class="user-info">
        <div class="user-avatar${o.avatarClass || ''}">${esc(u.username.charAt(0).toUpperCase())}</div>
        <div>
          <div class="username">@${esc(u.username)}</div>
          ${u.date ? `<div class="user-meta">${esc(o.metaLabel)} ${esc(u.date)}</div>` : ''}
        </div>
      </div>
      <a class="user-link" href="${esc(u.href)}" target="_blank" rel="noopener">View Profile ↗</a>
    </div>`;
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
  });
});


// ── Search, filter and sort ────────────────────────────────────────────────

const LISTS = {
  ghosts:  { search: 'searchGhosts',  sort: 'sortGhosts',  count: 'countGhosts',  el: 'listGhosts',  mode: 'ghost',   get: () => ghostList },
  reverse: { search: 'searchReverse', sort: 'sortReverse', count: 'countReverse', el: 'listReverse', mode: 'reverse', get: () => reverseList },
  mutuals: { search: 'searchMutuals', sort: 'sortMutuals', count: 'countMutuals', el: 'listMutuals', mode: 'mutual',  get: () => mutualList }
};

// Array sort is stable, so accounts with no date keep the export's own order.
function sortUsers(list, mode) {
  const out = list.slice();
  if (mode === 'az')          out.sort((a, b) => a.username.localeCompare(b.username));
  else if (mode === 'za')     out.sort((a, b) => b.username.localeCompare(a.username));
  else if (mode === 'oldest') out.sort((a, b) => (a.ts || Infinity) - (b.ts || Infinity));
  else                        out.sort((a, b) => (b.ts || 0) - (a.ts || 0));   // newest first
  return out;
}

// The accounts currently on screen for one list, after search and sort.
function visibleList(name) {
  const cfg = LISTS[name];
  const q = document.getElementById(cfg.search).value.toLowerCase();
  const list = cfg.get().filter(u => u.username.includes(q));
  return sortUsers(list, document.getElementById(cfg.sort).value);
}

function renderNamedList(name) {
  renderList(visibleList(name), LISTS[name].el, LISTS[name].mode);
}

function renderAllLists() {
  for (const name of Object.keys(LISTS)) {
    document.getElementById(LISTS[name].count).textContent = LISTS[name].get().length.toLocaleString();
    renderNamedList(name);
  }
}

for (const name of Object.keys(LISTS)) {
  document.getElementById(LISTS[name].search).addEventListener('input', () => renderNamedList(name));
  document.getElementById(LISTS[name].sort).addEventListener('change', () => renderNamedList(name));
}


// ── Copy usernames ─────────────────────────────────────────────────────────

// Copies what is on screen, so a search narrows what gets copied. The comparison lists have no search, so they
// copy in full.
async function copyUsernames(name, btn) {
  const list = COMPARE_LISTS[name] ? COMPARE_LISTS[name]() : visibleList(name);
  const text = list.map(u => '@' + u.username).join('\n');
  const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Older browsers: copy from a hidden text box instead.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
  }
  btn.textContent = ok ? '✓ Copied ' + list.length.toLocaleString() : '✗ Copy failed';
  clearTimeout(btn._reset);
  btn._reset = setTimeout(() => { btn.textContent = label; }, 1800);
  if (ok) track('copy_usernames', { list: name });
}

document.querySelectorAll('[data-copy]').forEach(btn => {
  btn.addEventListener('click', () => copyUsernames(btn.dataset.copy, btn));
});


// ── Who unfollowed you ─────────────────────────────────────────────────────
//
// Compares the followers in an older export with the followers on screen.
// Anyone in the older list but not the newer one unfollowed you (or
// deactivated their account); anyone only in the newer one is a new follower.
// Like everything else, the older export is read on this device only.

let unfollowedList = [];
let newFollowerList = [];
let compareRunning = false;

const COMPARE_LISTS = { unfollowed: () => unfollowedList, newfollowers: () => newFollowerList };

const compareZone = document.getElementById('compareZone');
const compareFile = document.getElementById('compareFile');
const compareStatus = document.getElementById('compareStatus');

// The followers in the analysis on screen. A large saved analysis keeps only
// the three result lists, but everyone who follows you is either a mutual or
// someone you don't follow back, so the full list can be rebuilt from those.
function currentFollowers() {
  return followersData || mergeUsers(reverseList.slice(), mutualList);
}

// Reads an older export (a ZIP, or loose followers files) without touching
// the analysis on screen.
async function readOlderExport(files) {
  let followers = [];
  let date = 0;
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      const lists = await readZipLists(file);
      followers = mergeUsers(followers, lists.followers);
      date = latestTime([date, lists.date]);
    } else if (classifyPath(file.name) === 'followers') {
      followers = mergeUsers(followers, parseFile(await readFile(file), file.name));
    }
  }
  return { followers, date };
}

const formatDay = t => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function setCompareStatus(text, level) {
  compareStatus.textContent = text;
  compareStatus.className = 'drop-status' + (level ? ' ' + level : '');
}

async function runCompare(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length || compareRunning) return;
  compareRunning = true;
  setCompareStatus('Reading…', 'warn');
  try {
    const older = await readOlderExport(files);
    if (!older.followers.length) {
      setCompareStatus('✗ No followers list found. Add an Instagram export ZIP, or its followers_1 file.', 'error');
      return;
    }

    // Put the two exports in time order. If the added one turns out to be
    // newer than the one on screen, compare the other way round.
    let before = older.followers, after = currentFollowers();
    let beforeDate = older.date, afterDate = currentExportDate;
    if (beforeDate && afterDate && beforeDate > afterDate) {
      [before, after] = [after, before];
      [beforeDate, afterDate] = [afterDate, beforeDate];
    }

    const afterSet = new Set(after.map(u => u.username));
    const beforeSet = new Set(before.map(u => u.username));
    unfollowedList = before.filter(u => !afterSet.has(u.username));
    newFollowerList = after.filter(u => !beforeSet.has(u.username));

    showCompareResults(beforeDate, afterDate);
    track('compare_completed');
  } catch {
    setCompareStatus('✗ Could not read that file. Try the ZIP Instagram sent you, or unzip it and add followers_1.', 'error');
  } finally {
    compareRunning = false;
    compareFile.value = '';
  }
}

function showCompareResults(beforeDate, afterDate) {
  const n = unfollowedList.length, m = newFollowerList.length;
  const since = beforeDate ? 'Since ' + formatDay(beforeDate) : 'Since your older export';
  const until = beforeDate && afterDate ? ' (compared with ' + formatDay(afterDate) + ')' : '';
  document.getElementById('compareSummary').textContent = since + until;
  document.getElementById('statUnfollowed').textContent = n.toLocaleString();
  document.getElementById('statNewFollowers').textContent = m.toLocaleString();
  document.getElementById('countUnfollowed').textContent = n.toLocaleString();

  const card = (u, i, avatarClass) => userCardHTML(u, i, { cardClass: ' compare-row', avatarClass, metaLabel: 'Followed you' });
  document.getElementById('listUnfollowed').innerHTML = n
    ? unfollowedList.map((u, i) => card(u, i, ' orange')).join('')
    : '<div class="empty-state"><div class="big">🎉</div>Nobody unfollowed you in that time.</div>';
  document.getElementById('listNewFollowers').innerHTML = m
    ? newFollowerList.map((u, i) => card(u, i, ' green')).join('')
    : '<div class="empty-state">No new followers in that time.</div>';

  document.getElementById('compareStart').hidden = true;
  document.getElementById('compareResults').hidden = false;
}

function resetCompare() {
  unfollowedList = [];
  newFollowerList = [];
  setCompareStatus('');
  document.getElementById('countUnfollowed').textContent = '';
  document.getElementById('listUnfollowed').innerHTML = '';
  document.getElementById('listNewFollowers').innerHTML = '';
  document.getElementById('compareStart').hidden = false;
  document.getElementById('compareResults').hidden = true;
}

compareFile.addEventListener('change', () => runCompare(compareFile.files));
compareZone.addEventListener('dragover', e => { e.preventDefault(); compareZone.classList.add('drag-over'); });
compareZone.addEventListener('dragleave', () => compareZone.classList.remove('drag-over'));
compareZone.addEventListener('drop', e => {
  e.preventDefault();
  compareZone.classList.remove('drag-over');
  runCompare(e.dataTransfer.files);
});
document.getElementById('compareAgain').addEventListener('click', resetCompare);
document.getElementById('exportUnfollowed').addEventListener('click', () => { exportCSV(unfollowedList, 'unfollowed_you.csv'); track('csv_export', { list: 'unfollowed' }); });
document.getElementById('exportNewFollowers').addEventListener('click', () => { exportCSV(newFollowerList, 'new_followers.csv'); track('csv_export', { list: 'newfollowers' }); });

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

document.getElementById('exportGhosts').addEventListener('click',  () => { exportCSV(ghostList,   'not_following_back.csv'); track('csv_export', { list: 'ghosts' }); });
document.getElementById('exportReverse').addEventListener('click', () => { exportCSV(reverseList, 'not_followed_back.csv'); track('csv_export', { list: 'reverse' }); });
document.getElementById('exportMutuals').addEventListener('click', () => { exportCSV(mutualList,  'mutuals.csv');           track('csv_export', { list: 'mutuals' }); });

document.getElementById('bannerDismiss').addEventListener('click', () => {
  document.getElementById('coffeeBanner').classList.remove('visible');
  track('coffee_banner_dismissed');
});

// Every Buy me a coffee link carries data-coffee="<where it is on the page>",
// so the reports show which placement people actually click. Listening on the
// document also covers the floating button, which comes after this script.
document.addEventListener('click', e => {
  const link = e.target.closest('[data-coffee]');
  if (link) track('coffee_click', { placement: link.dataset.coffee });
});

// Always share the home page, not whatever #section the visitor is on.
const SHARE_URL = 'https://followeranalyzer.io/';

document.querySelectorAll('[data-share]').forEach(btn => {
  btn.addEventListener('click', () => {
    const text = 'I just found out who doesn\'t follow me back on Instagram using Follower Analyzer — runs entirely in your browser, no login needed.';
    if (navigator.share) {
      track('share_click', { method: 'native', placement: btn.dataset.share });
      navigator.share({ title: 'Follower Analyzer', text, url: SHARE_URL }).catch(() => {});
    } else {
      track('share_click', { method: 'twitter', placement: btn.dataset.share });
      const tweetUrl = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text + ' ' + SHARE_URL);
      window.open(tweetUrl, '_blank', 'noopener');
    }
  });
});


// ── Inactive accounts ──────────────────────────────────────────────────────
//
// Instagram's export still lists accounts that were deactivated or deleted,
// but the app leaves them out of the Following count on your profile. So the
// export's count minus the profile's count is roughly how many accounts you
// follow are inactive. They can't follow you back, so they all sit on the
// "not following you back" list. The number typed in is only used here.

const appFollowingInput = document.getElementById('appFollowing');
const inactiveResult = document.getElementById('inactiveResult');
let inactiveTracked = false;

function setInactiveResult(text, level) {
  inactiveResult.textContent = text;
  inactiveResult.className = 'inactive-result' + (level ? ' ' + level : '');
}

function updateInactiveEstimate() {
  const exportCount = totals.following;
  const raw = appFollowingInput.value.trim();
  if (!raw || exportCount == null) { setInactiveResult(''); return; }

  const appCount = Number(raw);
  if (!Number.isInteger(appCount) || appCount < 0) {
    setInactiveResult('Enter the number shown under Following on your Instagram profile.', 'warn');
    return;
  }

  const gap = exportCount - appCount;
  const fmt = n => n.toLocaleString();
  if (gap > 0 && gap <= ghostList.length) {
    setInactiveResult('About ' + fmt(gap) + ' of the ' + fmt(ghostList.length) + ' accounts on this list are probably inactive. Instagram’s export still lists them, but your profile doesn’t count them.', 'ok');
  } else if (gap > 0) {
    setInactiveResult('Your export lists ' + fmt(gap) + ' more accounts than Instagram shows, more than this whole list. You’ve probably unfollowed people since you exported.', 'warn');
  } else if (gap === 0) {
    setInactiveResult('Your export matches Instagram exactly, so the accounts on this list are probably all active.', 'ok');
  } else {
    setInactiveResult('Instagram shows ' + fmt(-gap) + ' more than your export. You’ve probably followed people since you exported, or the export’s date range wasn’t All time.', 'warn');
  }

  if (!inactiveTracked) { inactiveTracked = true; track('inactive_estimate'); }
}

// Called whenever the lists on screen are replaced.
function resetInactiveEstimate() {
  appFollowingInput.value = '';
  setInactiveResult('');
  inactiveTracked = false;
  document.getElementById('exportFollowingCount').textContent = totals.following != null ? totals.following.toLocaleString() : '';
  // The estimate needs the export's Following count and at least one account
  // on the list.
  document.getElementById('inactiveEstimate').hidden = totals.following == null || !ghostList.length;
  document.getElementById('inactiveCard').hidden = !ghostList.length;
}

appFollowingInput.addEventListener('input', updateInactiveEstimate);
