// ==UserScript==
// @name         ChatGPT One-File Archive (Account Safe)
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  One TXT archive for ChatGPT chats, grouped by account label, with full auto-sync, safer delete sync, archive import, and bullet summaries.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // Config
  // ============================================================
  const DB_NAME = 'cgpt_archive_v3';
  const DB_STORE = 'kv';
  const FILE_HANDLE_KEY = 'archiveFileHandle';
  const CHAT_KEY_PREFIX = 'account:';
  const PROFILE_KEY_PREFIX = 'profile:';
  const ACCOUNT_LABEL_KEY = 'cgptArchiveAccountLabel';
  const LABEL_BINDINGS_KEY = 'cgptArchiveLabelBindings';
  const UI_HIDDEN_KEY = 'cgptArchiveUiHidden';
  const SAVE_DEBOUNCE_MS = 1400;
  const DELETE_DELAY_MS = 1800;
  const FULL_SYNC_PAGE_SIZE = 100;
  const FULL_SYNC_MAX_PAGES = 500;
  const FULL_SYNC_CONCURRENCY = 4;
  const AUTO_SYNC_INTERVAL_MS = 120000;
  const AUTO_SYNC_MIN_GAP_MS = 15000;
  const PROFILE_SYNC_MIN_GAP_MS = 600000;
  const ACCESS_TOKEN_CACHE_MS = 300000;
  const SESSION_INFO_CACHE_MS = 60000;
  const CHAT_BLOCK_SPLIT = '\n################################################################\nCHAT\n################################################################\n';
  const PROFILE_BLOCK_MARKER = '\n################################################################\nPROFILE\n################################################################\n';

  // ============================================================
  // Runtime state
  // ============================================================
  let activeAccountLabel = null;     // intentionally in-memory only
  let deleteSyncEnabled = false;
  let saveTimer = null;
  let lastRenderedArchive = '';
  let lastPath = location.pathname;
  let lastRowChatId = null;
  let pendingDeleteChatId = null;
  let archiveImportPromise = null;
  let archiveImportDone = false;
  let fullSyncPromise = null;
  let profileSyncPromise = null;
  let autoSyncIntervalId = null;
  let lastSyncStartedAt = 0;
  let lastProfileSyncStartedAt = 0;
  let cachedAccessToken = '';
  let cachedAccessTokenAt = 0;
  let cachedSessionInfo = null;
  let cachedSessionInfoAt = 0;
  let importWizardData = null;
  let importInProgress = false;

  // ============================================================
  // IndexedDB helpers
  // ============================================================
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const store = tx.objectStore(DB_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      const req = store.put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDelete(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      const req = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetAllChats() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const store = tx.objectStore(DB_STORE);
      const out = [];
      const req = store.openCursor();

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(out);
          return;
        }

        const key = String(cursor.key || '');
        if (key.startsWith(CHAT_KEY_PREFIX) && key.includes(':chat:')) {
          out.push(cursor.value);
        }

        cursor.continue();
      };

      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetAllProfiles() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const store = tx.objectStore(DB_STORE);
      const out = [];
      const req = store.openCursor();

      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(out);
          return;
        }

        const key = String(cursor.key || '');
        if (key.startsWith(PROFILE_KEY_PREFIX)) {
          out.push(cursor.value);
        }

        cursor.continue();
      };

      req.onerror = () => reject(req.error);
    });
  }

  // ============================================================
  // File helpers
  // ============================================================
  async function getSavedFileHandle() {
    try {
      return await dbGet(FILE_HANDLE_KEY);
    } catch (err) {
      console.error('Could not restore file handle:', err);
      return null;
    }
  }

  async function setSavedFileHandle(handle) {
    await dbSet(FILE_HANDLE_KEY, handle);
  }

  async function ensureWritePermission(handle) {
    if (!handle) return false;

    try {
      if (handle.queryPermission) {
        const current = await handle.queryPermission({ mode: 'readwrite' });
        if (current === 'granted') return true;
      }

      if (handle.requestPermission) {
        const requested = await handle.requestPermission({ mode: 'readwrite' });
        return requested === 'granted';
      }
    } catch (err) {
      console.error('Permission check failed:', err);
    }

    return false;
  }

  async function chooseArchiveFile() {
    if (!window.showSaveFilePicker) {
      alert('This script needs a browser with showSaveFilePicker support, like recent Chrome or Edge.');
      return null;
    }

    const handle = await window.showSaveFilePicker({
      suggestedName: 'chatgpt-archive.txt',
      types: [
        {
          description: 'Text files',
          accept: { 'text/plain': ['.txt'] }
        }
      ]
    });

    await setSavedFileHandle(handle);
    archiveImportDone = false;
    archiveImportPromise = null;
    await maybeImportArchiveFromFile(handle);
    setStatus('Archive file selected');
    return handle;
  }

  async function writeArchiveText(text) {
    const handle = await getSavedFileHandle();

    if (!handle) {
      setStatus('Choose archive file');
      return;
    }

    const ok = await ensureWritePermission(handle);
    if (!ok) {
      setStatus('File permission denied');
      return;
    }

    try {
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      setStatus('Saved ' + new Date().toLocaleTimeString());
    } catch (err) {
      console.error('Write failed:', err);
      setStatus('Write failed');
    }
  }

  async function readArchiveText(handle) {
    if (!handle?.getFile) return '';

    try {
      const file = await handle.getFile();
      return await file.text();
    } catch (err) {
      console.error('Read failed:', err);
      return '';
    }
  }

  function parseArchiveField(line, prefix) {
    return line.startsWith(prefix) ? line.slice(prefix.length) : '';
  }

  function squeezeWhitespace(text) {
    return cleanText(text).replace(/\s+/g, ' ');
  }

  function truncateSummaryText(text, maxLen = 180) {
    const normalized = squeezeWhitespace(text);
    if (!normalized) return '';
    if (normalized.length <= maxLen) return normalized;

    const sliced = normalized.slice(0, maxLen);
    const lastBreak = Math.max(
      sliced.lastIndexOf('. '),
      sliced.lastIndexOf('; '),
      sliced.lastIndexOf(', '),
      sliced.lastIndexOf(' ')
    );

    return cleanText((lastBreak > 80 ? sliced.slice(0, lastBreak) : sliced).replace(/[,:;.\s]+$/g, '')) + '...';
  }

  function createBullet(label, text) {
    const body = truncateSummaryText(text);
    return body ? `${label}: ${body}` : '';
  }

  function buildChatSummaryBullets(chat) {
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    const userMessages = messages.filter((m) => String(m.role || '').toLowerCase() === 'user');
    const assistantMessages = messages.filter((m) => String(m.role || '').toLowerCase() === 'assistant');
    const bullets = [];

    if (chat?.title && !/^untitled chat$/i.test(chat.title)) {
      bullets.push(createBullet('Topic', chat.title));
    }

    const userAsk = userMessages
      .slice(0, 2)
      .map((m) => squeezeWhitespace(m.text))
      .filter(Boolean)
      .join(' ');
    if (userAsk) {
      bullets.push(createBullet('Asked for', userAsk));
    }

    const lastAssistant = assistantMessages.length ? assistantMessages[assistantMessages.length - 1] : null;
    if (lastAssistant?.text) {
      bullets.push(createBullet('Outcome', lastAssistant.text));
    }

    const lastUser = userMessages.length ? userMessages[userMessages.length - 1] : null;
    if (lastUser?.text && userMessages.length > 2) {
      bullets.push(createBullet('Latest request', lastUser.text));
    }

    const uniqueBullets = [];
    const seen = new Set();
    for (const bullet of bullets) {
      if (!bullet) continue;
      const key = bullet.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueBullets.push(bullet);
      if (uniqueBullets.length >= 4) break;
    }

    return uniqueBullets;
  }

  function getConversationApiOrigin() {
    return location.origin.includes('chat.openai.com')
      ? 'https://chat.openai.com'
      : 'https://chatgpt.com';
  }

  async function fetchAccessToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && cachedAccessToken && now - cachedAccessTokenAt < ACCESS_TOKEN_CACHE_MS) {
      return cachedAccessToken;
    }

    const candidates = [
      `${getConversationApiOrigin()}/api/auth/session`,
      'https://chatgpt.com/api/auth/session',
      'https://chat.openai.com/api/auth/session'
    ];

    const seen = new Set();
    const uniqueCandidates = candidates.filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });

    for (const url of uniqueCandidates) {
      try {
        const response = await fetch(url, {
          credentials: 'include',
          headers: {
            accept: 'application/json'
          }
        });
        if (!response.ok) continue;

        const data = await response.json();
        const token = pickFirstString([
          data?.accessToken,
          data?.access_token,
          data?.token,
          data?.session?.accessToken,
          data?.user?.accessToken
        ]);

        if (token) {
          cachedAccessToken = token;
          cachedAccessTokenAt = Date.now();
          return token;
        }
      } catch {
        // Try next candidate.
      }
    }

    return '';
  }

  async function fetchJson(url, options = {}) {
    const {
      method = 'GET',
      headers = {},
      body = undefined,
      authMode = 'auto'
    } = options;

    const attempted = [];
    const authModes =
      authMode === 'required' ? ['bearer'] :
      authMode === 'none' ? ['cookie'] :
      ['cookie', 'bearer'];

    for (let i = 0; i < authModes.length; i++) {
      const mode = authModes[i];
      const mergedHeaders = {
        accept: 'application/json',
        ...headers
      };

      if (mode === 'bearer') {
        let token = await fetchAccessToken(false);
        if (!token) {
          attempted.push(`No bearer token available (${url})`);
          continue;
        }
        mergedHeaders.authorization = `Bearer ${token}`;
      }

      const response = await fetch(url, {
        credentials: 'include',
        method,
        headers: mergedHeaders,
        body
      });

      if (response.ok) {
        const raw = await response.text();
        if (!raw) return {};
        try {
          return JSON.parse(raw);
        } catch {
          return { raw };
        }
      }

      attempted.push(`HTTP ${response.status} [${mode}] for ${url}`);

      // If bearer token likely expired, refresh token once and retry bearer.
      if (mode === 'bearer' && response.status === 401) {
        const refreshedToken = await fetchAccessToken(true);
        if (refreshedToken) {
          const retryResponse = await fetch(url, {
            credentials: 'include',
            method,
            headers: {
              ...mergedHeaders,
              authorization: `Bearer ${refreshedToken}`
            },
            body
          });

          if (retryResponse.ok) {
            const retryRaw = await retryResponse.text();
            if (!retryRaw) return {};
            try {
              return JSON.parse(retryRaw);
            } catch {
              return { raw: retryRaw };
            }
          }

          attempted.push(`HTTP ${retryResponse.status} [bearer-refresh] for ${url}`);
        }
      }
    }

    throw new Error(attempted.join(' | ') || `Request failed for ${url}`);
  }

  async function fetchFirstSuccessfulJson(urls, options = {}) {
    const errors = [];
    for (const url of urls) {
      try {
        const data = await fetchJson(url, options);
        return { url, data };
      } catch (err) {
        errors.push(err?.message || String(err));
      }
    }

    throw new Error(errors.join(' || ') || 'All API candidates failed');
  }

  function normalizeOptionalBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
    }
    return null;
  }

  function pickFirstString(values) {
    for (const value of values) {
      if (typeof value === 'string' && cleanText(value)) {
        return cleanText(value);
      }
    }
    return '';
  }

  function findValueByKeysDeep(root, keys, maxDepth = 5) {
    if (!root || typeof root !== 'object' || maxDepth < 0) return undefined;
    const wanted = new Set(keys.map((key) => String(key).toLowerCase()));
    const queue = [{ value: root, depth: 0 }];
    const visited = new Set();

    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current.value !== 'object') continue;
      if (visited.has(current.value)) continue;
      visited.add(current.value);

      if (current.depth > maxDepth) continue;

      if (Array.isArray(current.value)) {
        for (const item of current.value) {
          queue.push({ value: item, depth: current.depth + 1 });
        }
        continue;
      }

      for (const [key, value] of Object.entries(current.value)) {
        if (wanted.has(String(key).toLowerCase())) {
          return value;
        }
        if (value && typeof value === 'object') {
          queue.push({ value, depth: current.depth + 1 });
        }
      }
    }

    return undefined;
  }

  function parseCustomInstructionsPayload(data) {
    const root = (data && typeof data === 'object' && data.data && typeof data.data === 'object')
      ? data.data
      : data;

    const deepAboutUser = findValueByKeysDeep(root, [
      'about_user_message',
      'about_user',
      'aboutUser',
      'user_profile',
      'userProfile'
    ]);
    const deepAboutModel = findValueByKeysDeep(root, [
      'about_model_message',
      'about_model',
      'aboutModel',
      'assistant_profile',
      'assistantProfile',
      'response_preferences'
    ]);
    const deepEnabled = findValueByKeysDeep(root, [
      'enabled',
      'is_enabled',
      'isEnabled',
      'custom_instructions_enabled',
      'customInstructionsEnabled'
    ]);

    const aboutUser = pickFirstString([
      root?.about_user_message,
      root?.about_user,
      root?.aboutUser,
      root?.user_profile,
      root?.userProfile,
      typeof deepAboutUser === 'string' ? deepAboutUser : ''
    ]);

    const aboutModel = pickFirstString([
      root?.about_model_message,
      root?.about_model,
      root?.aboutModel,
      root?.assistant_profile,
      root?.assistantProfile,
      root?.response_preferences,
      typeof deepAboutModel === 'string' ? deepAboutModel : ''
    ]);

    const enabled = normalizeOptionalBoolean(
      root?.enabled ??
      root?.is_enabled ??
      root?.isEnabled ??
      root?.custom_instructions_enabled ??
      root?.customInstructionsEnabled ??
      deepEnabled
    );

    return { aboutUser, aboutModel, enabled };
  }

  function extractStringLeaves(value, out = [], depth = 0, maxDepth = 4, maxItems = 24) {
    if (out.length >= maxItems || depth > maxDepth || value === null || value === undefined) return out;

    if (typeof value === 'string') {
      const text = squeezeWhitespace(value);
      if (text) out.push(text);
      return out;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      out.push(String(value));
      return out;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        extractStringLeaves(item, out, depth + 1, maxDepth, maxItems);
        if (out.length >= maxItems) break;
      }
      return out;
    }

    if (typeof value === 'object') {
      for (const nested of Object.values(value)) {
        extractStringLeaves(nested, out, depth + 1, maxDepth, maxItems);
        if (out.length >= maxItems) break;
      }
    }

    return out;
  }

  function uniqueNormalizedLines(lines) {
    const out = [];
    const seen = new Set();
    for (const line of lines) {
      const normalized = squeezeWhitespace(line);
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
    return out;
  }

  function parseAboutYouPayload(data) {
    const root = (data && typeof data === 'object' && data.data && typeof data.data === 'object')
      ? data.data
      : data;

    const preferredName = pickFirstString([
      root?.preferred_name,
      root?.preferredName,
      root?.display_name,
      root?.displayName,
      root?.nickname,
      root?.name,
      typeof findValueByKeysDeep(root, ['preferred_name', 'preferredName', 'display_name', 'displayName', 'nickname']) === 'string'
        ? findValueByKeysDeep(root, ['preferred_name', 'preferredName', 'display_name', 'displayName', 'nickname'])
        : ''
    ]);

    const occupation = pickFirstString([
      root?.occupation,
      root?.job,
      root?.role,
      root?.profession,
      typeof findValueByKeysDeep(root, ['occupation', 'job', 'role', 'profession']) === 'string'
        ? findValueByKeysDeep(root, ['occupation', 'job', 'role', 'profession'])
        : ''
    ]);

    const freeform = pickFirstString([
      root?.about_you,
      root?.aboutYou,
      root?.about_me,
      root?.aboutMe,
      root?.bio,
      root?.biography,
      root?.description,
      typeof findValueByKeysDeep(root, [
        'about_you',
        'aboutYou',
        'about_me',
        'aboutMe',
        'bio',
        'biography',
        'description'
      ]) === 'string'
        ? findValueByKeysDeep(root, [
          'about_you',
          'aboutYou',
          'about_me',
          'aboutMe',
          'bio',
          'biography',
          'description'
        ])
        : ''
    ]);

    const aboutObject = findValueByKeysDeep(root, ['about_you', 'aboutYou', 'profile', 'user_profile']);
    const extraLines = uniqueNormalizedLines(extractStringLeaves(aboutObject || [], [], 0, 3, 10));

    const lines = [];
    if (preferredName) lines.push(`Preferred name: ${preferredName}`);
    if (occupation) lines.push(`Occupation: ${occupation}`);
    if (freeform) lines.push(freeform);
    for (const line of extraLines) {
      if (lines.length >= 12) break;
      lines.push(line);
    }

    const text = uniqueNormalizedLines(lines).join('\n');
    return {
      text,
      preferredName,
      occupation
    };
  }

  async function fetchCustomInstructions() {
    const base = getConversationApiOrigin();
    const candidates = [
      `${base}/backend-api/user_system_messages`,
      `${base}/backend-api/user_system_messages?include_defaults=true`,
      `${base}/backend-api/custom_instructions`,
      `${base}/backend-api/custom_instructions?include_defaults=true`,
      `${base}/backend-api/settings`
    ];

    const { url, data } = await fetchFirstSuccessfulJson(candidates, { authMode: 'auto' });
    const parsed = parseCustomInstructionsPayload(data);
    return {
      ...parsed,
      sourceUrl: url
    };
  }

  async function fetchAboutYou() {
    const base = getConversationApiOrigin();
    const candidates = [
      `${base}/backend-api/settings`,
      `${base}/backend-api/user`,
      `${base}/backend-api/me`,
      `${base}/api/auth/session`
    ];

    let firstSuccess = null;
    const errors = [];

    for (const url of candidates) {
      try {
        const data = await fetchJson(url, { authMode: 'auto' });
        const parsed = parseAboutYouPayload(data);
        if (!firstSuccess) {
          firstSuccess = { url, parsed };
        }
        if (parsed.text) {
          return {
            ...parsed,
            sourceUrl: url
          };
        }
      } catch (err) {
        errors.push(err?.message || String(err));
      }
    }

    if (firstSuccess) {
      return {
        ...firstSuccess.parsed,
        sourceUrl: firstSuccess.url
      };
    }

    throw new Error(errors.join(' || ') || 'No about-you endpoint succeeded');
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function collectMemoryItems(payload) {
    const top = payload && typeof payload === 'object' ? payload : null;
    const candidates = [
      top,
      top?.data
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
      if (!candidate || typeof candidate !== 'object') continue;

      const arrays = [
        candidate.items,
        candidate.memories,
        candidate.memorys,
        candidate.results,
        candidate.data
      ];
      for (const arr of arrays) {
        if (Array.isArray(arr)) return arr;
      }
    }

    return [];
  }

  function normalizeMemoryText(entry) {
    if (typeof entry === 'string') return squeezeWhitespace(entry);
    if (!entry || typeof entry !== 'object') return '';

    const direct = pickFirstString([
      entry?.text,
      entry?.memory,
      entry?.content,
      entry?.value,
      entry?.summary,
      entry?.fact,
      entry?.message,
      entry?.description,
      entry?.title,
      entry?.memory?.text,
      entry?.memory?.content,
      entry?.memory?.value,
      entry?.data?.text,
      entry?.data?.content
    ]);

    if (direct) return squeezeWhitespace(direct);

    if (Array.isArray(entry?.content?.parts)) {
      return squeezeWhitespace(entry.content.parts.join(' '));
    }

    if (Array.isArray(entry?.parts)) {
      return squeezeWhitespace(entry.parts.join(' '));
    }

    return '';
  }

  function normalizeMemoryItem(entry, index) {
    const text = normalizeMemoryText(entry);
    if (!text) return null;

    return {
      id: pickFirstString([
        entry?.id,
        entry?.memory_id,
        entry?.uuid,
        entry?.key,
        `memory-${index + 1}`
      ]),
      text,
      updatedAt: pickFirstString([
        entry?.updated_at,
        entry?.update_time,
        entry?.created_at,
        entry?.create_time,
        entry?.timestamp
      ])
    };
  }

  function dedupeMemories(items) {
    const out = [];
    const seen = new Set();

    for (const item of items) {
      if (!item?.text) continue;
      const key = item.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }

    return out;
  }

  async function fetchMemories() {
    const base = getConversationApiOrigin();
    const candidates = [
      `${base}/backend-api/memories?limit=200`,
      `${base}/backend-api/memories?offset=0&limit=200`,
      `${base}/backend-api/memories`,
      `${base}/backend-api/memory?limit=200`,
      `${base}/backend-api/memory`
    ];

    const { url, data } = await fetchFirstSuccessfulJson(candidates, { authMode: 'auto' });
    const rawItems = collectMemoryItems(data);
    const normalizedItems = dedupeMemories(
      asArray(rawItems)
        .map((entry, index) => normalizeMemoryItem(entry, index))
        .filter(Boolean)
    );

    return {
      items: normalizedItems,
      sourceUrl: url
    };
  }

  function profileStorageKey(accountLabel) {
    return `${PROFILE_KEY_PREFIX}${accountLabel}`;
  }

  async function syncAccountProfileForActiveAccount(options = {}) {
    const { silent = false, force = false } = options;
    await maybeImportArchiveFromFile();

    if (!activeAccountLabel) {
      if (!silent) setStatus('Set account label first');
      return null;
    }

    if (!(await ensureActiveLabelBinding({ silent }))) {
      return null;
    }

    if (profileSyncPromise) return profileSyncPromise;

    const now = Date.now();
    if (!force && now - lastProfileSyncStartedAt < PROFILE_SYNC_MIN_GAP_MS) {
      return dbGet(profileStorageKey(activeAccountLabel));
    }

    profileSyncPromise = (async () => {
      lastProfileSyncStartedAt = Date.now();
      if (!silent) setStatus(`Syncing profile for ${activeAccountLabel}...`);

      const profile = {
        accountLabel: activeAccountLabel,
        updatedAt: new Date().toISOString(),
        customInstructions: {
          enabled: null,
          aboutUser: '',
          aboutModel: '',
          sourceUrl: ''
        },
        aboutYou: {
          text: '',
          preferredName: '',
          occupation: '',
          sourceUrl: ''
        },
        memories: [],
        memoriesSourceUrl: '',
        warnings: []
      };

      try {
        profile.customInstructions = await fetchCustomInstructions();
      } catch (err) {
        profile.warnings.push(`Custom instructions fetch failed: ${err?.message || err}`);
      }

      try {
        profile.aboutYou = await fetchAboutYou();
      } catch (err) {
        profile.warnings.push(`About-you fetch failed: ${err?.message || err}`);
      }

      if (!profile.aboutYou.text && profile.customInstructions.aboutUser) {
        profile.aboutYou = {
          text: profile.customInstructions.aboutUser,
          preferredName: '',
          occupation: '',
          sourceUrl: 'custom-instructions-fallback'
        };
      }

      try {
        const memoryResult = await fetchMemories();
        profile.memories = memoryResult.items;
        profile.memoriesSourceUrl = memoryResult.sourceUrl || '';
      } catch (err) {
        profile.warnings.push(`Memory fetch failed: ${err?.message || err}`);
      }

      await dbSet(profileStorageKey(activeAccountLabel), profile);
      await rebuildArchiveFile();

      if (!silent) {
        setStatus(
          `Profile synced: ${profile.memories.length} memories, custom instructions ` +
          (profile.customInstructions.aboutUser || profile.customInstructions.aboutModel ? 'captured' : 'empty') +
          `, about-you ${profile.aboutYou.text ? 'captured' : 'empty'}`
        );
      }

      return profile;
    })().finally(() => {
      profileSyncPromise = null;
    });

    return profileSyncPromise;
  }

  function parseConversationListItems(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.data?.items)) return data.data.items;
    if (Array.isArray(data?.conversations)) return data.conversations;
    if (Array.isArray(data?.data)) return data.data;
    return [];
  }

  async function fetchConversationMetaPage(offset) {
    const base = getConversationApiOrigin();
    const candidates = [
      `${base}/backend-api/conversations?offset=${offset}&limit=${FULL_SYNC_PAGE_SIZE}&order=updated`,
      `${base}/backend-api/conversations?offset=${offset}&limit=${FULL_SYNC_PAGE_SIZE}`
    ];

    let lastError = null;
    for (const url of candidates) {
      try {
        const data = await fetchJson(url);
        const items = parseConversationListItems(data);
        return {
          items,
          total: Number(data?.total || data?.data?.total || 0),
          hasMore: Boolean(data?.has_missing_conversations || data?.has_more || data?.data?.has_more)
        };
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('Could not load conversation list');
  }

  async function fetchAllConversationMetas() {
    const all = [];

    for (let page = 0; page < FULL_SYNC_MAX_PAGES; page++) {
      const offset = page * FULL_SYNC_PAGE_SIZE;
      const { items, total, hasMore } = await fetchConversationMetaPage(offset);
      if (!items.length) break;

      all.push(...items);

      if (items.length < FULL_SYNC_PAGE_SIZE && !hasMore) break;
      if (total && all.length >= total) break;
    }

    return all;
  }

  function collectSidebarChatIds() {
    const ids = new Set();
    const anchors = document.querySelectorAll('a[href*="/c/"]');

    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || anchor.href || '';
      const match = href.match(/\/c\/([a-zA-Z0-9-]+)/);
      if (match) ids.add(match[1]);
    }

    return [...ids];
  }

  function normalizeConversationMeta(meta) {
    return {
      id: cleanText(meta?.id || meta?.conversation_id || meta?.uuid || ''),
      title: cleanText(meta?.title || meta?.name || ''),
      updatedAt: meta?.update_time || meta?.updated_at || meta?.create_time || meta?.created_at || null
    };
  }

  function extractMessageTextContent(content) {
    if (!content) return '';
    if (typeof content === 'string') return cleanText(content);
    if (Array.isArray(content)) {
      return cleanText(content.map((part) => extractMessageTextContent(part)).filter(Boolean).join('\n'));
    }

    if (Array.isArray(content.parts)) {
      return cleanText(content.parts.map((part) => extractMessageTextContent(part)).filter(Boolean).join('\n'));
    }

    if (typeof content.text === 'string') return cleanText(content.text);
    if (typeof content.result === 'string') return cleanText(content.result);
    if (typeof content.content === 'string') return cleanText(content.content);

    return '';
  }

  function extractConversationMessages(payload) {
    const mapping = payload?.mapping;
    if (!mapping || typeof mapping !== 'object') return [];

    let nodeId = payload.current_node;
    if (!nodeId) {
      const entries = Object.entries(mapping);
      nodeId = entries.length ? entries[entries.length - 1][0] : null;
    }

    const chain = [];
    const seen = new Set();

    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      chain.push(mapping[nodeId]);
      nodeId = mapping[nodeId].parent;
    }

    chain.reverse();

    const messages = [];
    for (const node of chain) {
      const message = node?.message;
      const role = cleanText(message?.author?.role || 'unknown').toLowerCase();
      const text = extractMessageTextContent(message?.content);

      if (!text) continue;
      if (role === 'system') continue;

      messages.push({ role, text });
    }

    return messages;
  }

  async function fetchConversationById(chatId) {
    const base = getConversationApiOrigin();
    const payload = await fetchJson(`${base}/backend-api/conversation/${chatId}`);
    const title = cleanText(payload?.title || 'Untitled Chat') || 'Untitled Chat';
    const messages = extractConversationMessages(payload);

    return {
      id: cleanText(payload?.conversation_id || payload?.id || chatId),
      title,
      url: `${base}/c/${chatId}`,
      updatedAt: payload?.update_time || payload?.create_time || new Date().toISOString(),
      summaryBullets: buildChatSummaryBullets({ title, messages }),
      messages
    };
  }

  async function syncAllChatsForActiveAccount(options = {}) {
    const { silent = false } = options;
    await maybeImportArchiveFromFile();

    if (!activeAccountLabel) {
      if (!silent) setStatus('Set account label first');
      return 0;
    }

    if (!(await ensureActiveLabelBinding({ silent }))) {
      return 0;
    }

    if (fullSyncPromise) return fullSyncPromise;

    fullSyncPromise = (async () => {
      lastSyncStartedAt = Date.now();
      if (!silent) {
        setStatus(`Syncing all chats for ${activeAccountLabel}...`);
      }

      try {
        await syncAccountProfileForActiveAccount({ silent: true });
      } catch (err) {
        console.warn('Profile sync failed before chat sync:', err);
      }

      const existingChats = await dbGetAllChats();
      const existingById = new Map(
        existingChats
          .filter((chat) => normalizeAccountLabel(chat.accountLabel) === activeAccountLabel)
          .map((chat) => [chat.id, chat])
      );

      let metas = [];
      try {
        metas = (await fetchAllConversationMetas()).map(normalizeConversationMeta).filter((meta) => meta.id);
      } catch (err) {
        console.warn('Conversation list fetch failed, falling back to sidebar IDs:', err);
        metas = collectSidebarChatIds().map((id) => ({ id, title: '', updatedAt: null }));
      }

      const uniqueMetas = [];
      const seenIds = new Set();
      for (const meta of metas) {
        if (!meta?.id || seenIds.has(meta.id)) continue;
        seenIds.add(meta.id);
        uniqueMetas.push(meta);
      }

      const metasToFetch = [];
      for (const meta of uniqueMetas) {
        const existing = existingById.get(meta.id);
        const existingUpdatedAt = Date.parse(existing?.updatedAt || 0);
        const listedUpdatedAt = Date.parse(meta.updatedAt || 0);
        const shouldSkip =
          existing &&
          (!Number.isFinite(listedUpdatedAt) || listedUpdatedAt <= existingUpdatedAt) &&
          (existing.messages?.length || 0) > 0;

        if (shouldSkip) continue;
        metasToFetch.push(meta);
      }

      let savedCount = 0;
      let processedCount = 0;
      let cursor = 0;
      const workerCount = Math.max(1, Math.min(FULL_SYNC_CONCURRENCY, metasToFetch.length || 1));

      const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = cursor++;
          if (index >= metasToFetch.length) break;

          const meta = metasToFetch[index];
          try {
            const chat = await fetchConversationById(meta.id);
            chat.accountLabel = activeAccountLabel;
            if (!chat.title && meta.title) chat.title = meta.title;
            if (!Number.isFinite(Date.parse(chat.updatedAt || 0)) && meta.updatedAt) {
              chat.updatedAt = meta.updatedAt;
            }

            await dbSet(chatStorageKey(activeAccountLabel, chat.id), chat);
            existingById.set(chat.id, chat);
            savedCount++;
          } catch (err) {
            console.warn('Chat sync failed for', meta.id, err);
          } finally {
            processedCount++;
            if (!silent && (processedCount % 10 === 0 || processedCount === metasToFetch.length)) {
              setStatus(`Synced ${processedCount}/${metasToFetch.length} chats...`);
            }
          }
        }
      });

      await Promise.all(workers);

      await rebuildArchiveFile();
      if (!silent || savedCount > 0) {
        setStatus(`All-chat sync finished: ${savedCount} updated (${metasToFetch.length} checked)`);
      }
      return savedCount;
    })().finally(() => {
      fullSyncPromise = null;
    });

    return fullSyncPromise;
  }

  function maybeAutoSync(reason = 'auto') {
    if (!activeAccountLabel) return;
    if (fullSyncPromise) return;

    const now = Date.now();
    if (now - lastSyncStartedAt < AUTO_SYNC_MIN_GAP_MS) return;

    syncAllChatsForActiveAccount({ silent: reason !== 'manual' }).catch((err) => {
      console.error('Auto sync failed:', err);
      setStatus('All-chat sync failed');
    });
  }

  function startAutoSyncLoop() {
    if (autoSyncIntervalId) {
      clearInterval(autoSyncIntervalId);
    }

    autoSyncIntervalId = setInterval(() => {
      maybeAutoSync('interval');
    }, AUTO_SYNC_INTERVAL_MS);
  }

  function installAutoSyncListeners() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        maybeAutoSync('visible');
      }
    });

    window.addEventListener('focus', () => {
      maybeAutoSync('focus');
    });
  }

  function parseArchiveChatBlock(block, accountLabel) {
    const lines = String(block || '').split('\n');
    const title = cleanText(parseArchiveField(lines[0] || '', 'Title: '));
    const chatId = cleanText(parseArchiveField(lines[1] || '', 'Chat ID: '));
    const url = cleanText(parseArchiveField(lines[2] || '', 'URL: '));
    const updatedAtRaw = cleanText(parseArchiveField(lines[3] || '', 'Last Updated: '));

    if (!chatId) return null;

    const parsedUpdatedAt = Date.parse(updatedAtRaw);
    const updatedAt = Number.isFinite(parsedUpdatedAt)
      ? new Date(parsedUpdatedAt).toISOString()
      : new Date().toISOString();

    let i = 4;
    while (i < lines.length && !lines[i]) i++;

    const summaryBullets = [];
    if (lines[i] === 'Summary:') {
      i++;

      while (i < lines.length) {
        const line = lines[i];
        if (!line) {
          i++;
          if (summaryBullets.length) break;
          continue;
        }

        if (!line.startsWith('- ')) break;
        summaryBullets.push(cleanText(line.slice(2)));
        i++;
      }

      while (i < lines.length && !lines[i]) i++;
    }

    const messages = [];
    while (i < lines.length) {
      const isMessageHeader =
        lines[i] === '------------------------------------------------------------' &&
        /^\[\d+\]\s+/.test(lines[i + 1] || '') &&
        lines[i + 2] === '------------------------------------------------------------';

      if (!isMessageHeader) {
        i++;
        continue;
      }

      const role = cleanText((lines[i + 1] || '').replace(/^\[\d+\]\s+/, '')).toLowerCase() || 'unknown';
      i += 3;

      const textLines = [];
      while (i < lines.length) {
        const startsNextMessage =
          lines[i] === '------------------------------------------------------------' &&
          /^\[\d+\]\s+/.test(lines[i + 1] || '') &&
          lines[i + 2] === '------------------------------------------------------------';

        if (startsNextMessage) break;

        textLines.push(lines[i]);
        i++;
      }

      while (textLines.length && !textLines[textLines.length - 1]) {
        textLines.pop();
      }

      const text = cleanText(textLines.join('\n'));
      if (text) {
        messages.push({ role, text });
      }
    }

    return {
      accountLabel,
      id: chatId,
      title: title || 'Untitled Chat',
      url,
      updatedAt,
      summaryBullets,
      messages
    };
  }

  function extractMarkedBlock(block, startMarker, endMarker) {
    const start = block.indexOf(startMarker);
    if (start < 0) return '';
    const from = start + startMarker.length;
    const end = block.indexOf(endMarker, from);
    if (end < 0) return '';
    return cleanText(block.slice(from, end));
  }

  function parseArchiveProfileBlock(block, accountLabel) {
    const normalized = String(block || '').replace(/\r\n?/g, '\n');
    if (!cleanText(normalized)) return null;

    const lines = normalized.split('\n');
    const getField = (prefix) => {
      for (const line of lines) {
        if (line.startsWith(prefix)) return cleanText(parseArchiveField(line, prefix));
      }
      return '';
    };

    const updatedAtRaw = getField('Profile Last Synced: ');
    const enabledRaw = getField('Custom Instructions Enabled: ').toLowerCase();
    const customInstructionsSource = getField('Custom Instructions Source: ');
    const aboutYouSource = getField('About You Source: ');
    const memoriesSourceUrl = getField('Memories Source: ');

    const aboutUser = extractMarkedBlock(
      normalized,
      '<<CUSTOM_INSTRUCTIONS_ABOUT_USER>>\n',
      '\n<<END_CUSTOM_INSTRUCTIONS_ABOUT_USER>>'
    );
    const aboutModel = extractMarkedBlock(
      normalized,
      '<<CUSTOM_INSTRUCTIONS_ABOUT_MODEL>>\n',
      '\n<<END_CUSTOM_INSTRUCTIONS_ABOUT_MODEL>>'
    );
    const aboutYouText = extractMarkedBlock(
      normalized,
      '<<ABOUT_YOU>>\n',
      '\n<<END_ABOUT_YOU>>'
    );

    const memories = [];
    const memorySectionIndex = lines.findIndex((line) => line === 'Saved Memories:');
    if (memorySectionIndex >= 0) {
      for (let i = memorySectionIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) break;
        if (!line.startsWith('- ')) continue;
        const text = cleanText(line.slice(2));
        if (!text) continue;
        if (text === '(none found)') continue;
        memories.push({
          id: `memory-${memories.length + 1}`,
          text,
          updatedAt: ''
        });
      }
    }

    const enabled =
      enabledRaw === 'yes' ? true :
      enabledRaw === 'no' ? false :
      null;

    return {
      accountLabel,
      updatedAt: Number.isFinite(Date.parse(updatedAtRaw))
        ? new Date(updatedAtRaw).toISOString()
        : new Date().toISOString(),
      customInstructions: {
        enabled,
        aboutUser,
        aboutModel,
        sourceUrl: customInstructionsSource
      },
      aboutYou: {
        text: aboutYouText,
        preferredName: '',
        occupation: '',
        sourceUrl: aboutYouSource
      },
      memories,
      memoriesSourceUrl,
      warnings: []
    };
  }

  function pickSectionSlice(section, marker) {
    let markerLen = marker.length;
    let start = section.indexOf(marker);
    if (start < 0 && marker.startsWith('\n')) {
      const fallbackMarker = marker.slice(1);
      start = section.indexOf(fallbackMarker);
      markerLen = fallbackMarker.length;
    }
    if (start < 0) return '';

    const from = start + markerLen;
    const nextChatStart = section.indexOf(CHAT_BLOCK_SPLIT, from);
    const to = nextChatStart >= 0 ? nextChatStart : section.length;
    return section.slice(from, to);
  }

  function parseArchiveText(text) {
    const normalized = String(text || '').replace(/\r\n?/g, '\n');
    if (!normalized.includes('CHATGPT ARCHIVE')) {
      return {
        chats: [],
        profiles: []
      };
    }

    const accountMatches = [...normalized.matchAll(/^ACCOUNT:\s*(.+)$/gm)];
    const chats = [];
    const profiles = [];

    for (let index = 0; index < accountMatches.length; index++) {
      const match = accountMatches[index];
      const nextMatch = accountMatches[index + 1];
      const rawLabel = cleanText(match[1] || '');
      const accountLabel = normalizeAccountLabel(rawLabel) || 'unlabeled';
      const sectionStart = match.index || 0;
      const sectionEnd = nextMatch ? (nextMatch.index || normalized.length) : normalized.length;
      const section = normalized.slice(sectionStart, sectionEnd);
      let blocks = section.split(CHAT_BLOCK_SPLIT);
      if (blocks.length === 1 && CHAT_BLOCK_SPLIT.startsWith('\n')) {
        blocks = section.split(CHAT_BLOCK_SPLIT.slice(1));
      }

      for (let i = 1; i < blocks.length; i++) {
        const chat = parseArchiveChatBlock(blocks[i], accountLabel);
        if (chat) chats.push(chat);
      }

      const profileBlock = pickSectionSlice(section, PROFILE_BLOCK_MARKER);
      if (profileBlock) {
        const profile = parseArchiveProfileBlock(profileBlock, accountLabel);
        if (profile) profiles.push(profile);
      }
    }

    return { chats, profiles };
  }

  async function maybeImportArchiveFromFile(handleOverride = null) {
    if (archiveImportDone) return 0;
    if (archiveImportPromise) return archiveImportPromise;

    archiveImportPromise = (async () => {
      const handle = handleOverride || await getSavedFileHandle();
      if (!handle) return 0;

      const text = await readArchiveText(handle);
      const parsedArchive = parseArchiveText(text);
      const importedChats = parsedArchive.chats || [];
      const importedProfiles = parsedArchive.profiles || [];
      if (!importedChats.length && !importedProfiles.length) return 0;

      const existingChats = await dbGetAllChats();
      const existingByKey = new Map(
        existingChats.map((chat) => [
          chatStorageKey(normalizeAccountLabel(chat.accountLabel) || 'unlabeled', chat.id),
          chat
        ])
      );

      let importedCount = 0;

      for (const chat of importedChats) {
        const label = normalizeAccountLabel(chat.accountLabel) || 'unlabeled';
        const key = chatStorageKey(label, chat.id);
        const existing = existingByKey.get(key);
        const existingUpdatedAt = Date.parse(existing?.updatedAt || 0);
        const importedUpdatedAt = Date.parse(chat.updatedAt || 0);
        const shouldImport =
          !existing ||
          (Number.isFinite(importedUpdatedAt) && importedUpdatedAt > existingUpdatedAt) ||
          ((existing?.messages?.length || 0) === 0 && chat.messages.length > 0);

        if (!shouldImport) continue;

        chat.accountLabel = label;
        await dbSet(key, chat);
        existingByKey.set(key, chat);
        importedCount++;
      }

      if (importedProfiles.length) {
        const existingProfiles = await dbGetAllProfiles();
        const existingByLabel = new Map(
          existingProfiles.map((profile) => [
            normalizeAccountLabel(profile?.accountLabel) || 'unlabeled',
            profile
          ])
        );

        for (const profile of importedProfiles) {
          const label = normalizeAccountLabel(profile?.accountLabel) || 'unlabeled';
          profile.accountLabel = label;

          const existing = existingByLabel.get(label);
          const existingUpdatedAt = Date.parse(existing?.updatedAt || 0);
          const importedUpdatedAt = Date.parse(profile?.updatedAt || 0);
          const shouldImport =
            !existing ||
            (Number.isFinite(importedUpdatedAt) && importedUpdatedAt > existingUpdatedAt) ||
            ((existing?.memories?.length || 0) === 0 && (profile?.memories?.length || 0) > 0) ||
            (!existing?.customInstructions?.aboutUser && !!profile?.customInstructions?.aboutUser) ||
            (!existing?.customInstructions?.aboutModel && !!profile?.customInstructions?.aboutModel) ||
            (!existing?.aboutYou?.text && !!profile?.aboutYou?.text);

          if (!shouldImport) continue;

          await dbSet(profileStorageKey(label), profile);
          existingByLabel.set(label, profile);
          importedCount++;
        }
      }

      return importedCount;
    })()
      .catch((err) => {
        console.error('Archive import failed:', err);
        return 0;
      })
      .finally(() => {
        archiveImportDone = true;
        archiveImportPromise = null;
      });

    return archiveImportPromise;
  }

  function getPersistedAccountLabel() {
    try {
      return normalizeAccountLabel(localStorage.getItem(ACCOUNT_LABEL_KEY) || '');
    } catch {
      return '';
    }
  }

  function persistAccountLabel(label) {
    try {
      if (label) {
        localStorage.setItem(ACCOUNT_LABEL_KEY, label);
      } else {
        localStorage.removeItem(ACCOUNT_LABEL_KEY);
      }
    } catch {
      // Ignore localStorage failures and continue with in-memory state.
    }
  }

  function getLabelBindings() {
    try {
      const raw = localStorage.getItem(LABEL_BINDINGS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveLabelBindings(bindings) {
    try {
      localStorage.setItem(LABEL_BINDINGS_KEY, JSON.stringify(bindings || {}));
    } catch {
      // Ignore localStorage failures and continue with in-memory state.
    }
  }

  // ============================================================
  // Account helpers
  // ============================================================
  function normalizeAccountLabel(label) {
    return String(label || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 64);
  }

  async function fetchSessionInfo(force = false) {
    const now = Date.now();
    if (!force && cachedSessionInfo && now - cachedSessionInfoAt < SESSION_INFO_CACHE_MS) {
      return cachedSessionInfo;
    }

    const candidates = [
      `${getConversationApiOrigin()}/api/auth/session`,
      'https://chatgpt.com/api/auth/session',
      'https://chat.openai.com/api/auth/session'
    ];

    let data = null;
    const seen = new Set();
    for (const url of candidates) {
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        const response = await fetch(url, {
          credentials: 'include',
          headers: {
            accept: 'application/json'
          }
        });
        if (!response.ok) continue;
        data = await response.json();
        break;
      } catch {
        // Keep trying other candidates.
      }
    }

    const user = data?.user || data?.session?.user || data?.data?.user || {};
    const email = pickFirstString([user?.email, data?.email]).toLowerCase();
    const userId = pickFirstString([user?.id, user?.sub, data?.user_id, data?.sub]);
    const name = pickFirstString([user?.name, data?.name]).toLowerCase();

    let fingerprint = 'unknown:session';
    let display = '';

    if (email) {
      fingerprint = `email:${email}`;
      display = email;
    } else if (userId) {
      fingerprint = `id:${userId}`;
      display = userId;
    } else if (name) {
      fingerprint = `name:${name}`;
      display = name;
    } else if (data?.expires || data?.accessToken) {
      fingerprint = 'unknown:authenticated';
      display = 'authenticated-user';
    } else {
      fingerprint = 'signed-out';
      display = 'signed-out';
    }

    const sessionInfo = {
      fingerprint,
      display
    };

    cachedSessionInfo = sessionInfo;
    cachedSessionInfoAt = Date.now();
    return sessionInfo;
  }

  async function ensureActiveLabelBinding(options = {}) {
    const { silent = false } = options;
    if (!activeAccountLabel) return false;

    const session = await fetchSessionInfo(true);
    if (!session || session.fingerprint === 'signed-out') {
      if (!silent) setStatus('Sign in to ChatGPT before syncing this label');
      return false;
    }

    if (session.fingerprint.startsWith('unknown:')) {
      if (!silent) {
        setStatus(`Could not verify account identity for label ${activeAccountLabel}. Open account menu and try again.`);
      }
      return false;
    }

    const bindings = getLabelBindings();
    const existing = bindings[activeAccountLabel];
    const nowIso = new Date().toISOString();

    if (!existing || !existing.fingerprint) {
      bindings[activeAccountLabel] = {
        fingerprint: session.fingerprint,
        display: session.display || '(unknown)',
        boundAt: nowIso,
        lastSeenAt: nowIso
      };
      saveLabelBindings(bindings);
      return true;
    }

    if (existing.fingerprint === session.fingerprint) {
      bindings[activeAccountLabel] = {
        ...existing,
        display: session.display || existing.display || '(unknown)',
        lastSeenAt: nowIso
      };
      saveLabelBindings(bindings);
      return true;
    }

    if (!silent) {
      setStatus(
        `Label ${activeAccountLabel} is bound to ${existing.display || 'another account'}. ` +
        `Use Set Account and choose a different label.`
      );
    }
    return false;
  }

  async function confirmOrBindLabelForCurrentSession(label) {
    const normalizedLabel = normalizeAccountLabel(label);
    if (!normalizedLabel) return false;

    const session = await fetchSessionInfo(true);
    if (!session || session.fingerprint === 'signed-out') {
      alert('Please sign in to ChatGPT before setting an account label.');
      return false;
    }

    if (session.fingerprint.startsWith('unknown:')) {
      alert('Could not verify the logged-in account identity. Open the account menu, then try again.');
      return false;
    }

    const bindings = getLabelBindings();
    const existing = bindings[normalizedLabel];
    const nowIso = new Date().toISOString();

    if (existing && existing.fingerprint && existing.fingerprint !== session.fingerprint) {
      const shouldRebind = confirm(
        `Label "${normalizedLabel}" is already bound to ${existing.display || 'another account'}.\n` +
        `Current account appears to be ${session.display || 'another account'}.\n\n` +
        'Rebind this label to the current account?'
      );
      if (!shouldRebind) return false;
    }

    bindings[normalizedLabel] = {
      fingerprint: session.fingerprint,
      display: session.display || '(unknown)',
      boundAt: existing?.boundAt || nowIso,
      lastSeenAt: nowIso
    };
    saveLabelBindings(bindings);
    return true;
  }

  function setActiveAccountLabel(label) {
    activeAccountLabel = normalizeAccountLabel(label);
    persistAccountLabel(activeAccountLabel);
    deleteSyncEnabled = !!activeAccountLabel;
    updateAccountBadge();

    if (activeAccountLabel) {
      setStatus(`Account armed: ${activeAccountLabel}`);
      syncAllChatsForActiveAccount({ silent: false }).catch((err) => {
        console.error('Initial all-chat sync failed:', err);
        setStatus('All-chat sync failed');
      });
    } else {
      setStatus('Account label required');
    }
  }

  async function promptForAccountLabel() {
    const existing = activeAccountLabel || '';
    const input = prompt(
      'Enter an account label for the currently logged-in ChatGPT account.\n\nUse a unique label per account.\n\nExamples:\n- main\n- alt\n- work\n- personal\n\nThis label is now remembered across reloads until you change it.',
      existing
    );

    if (input === null) return;

    const normalized = normalizeAccountLabel(input);
    if (!normalized) {
      alert('Please enter a valid account label.');
      return;
    }

    const bound = await confirmOrBindLabelForCurrentSession(normalized);
    if (!bound) return;

    setActiveAccountLabel(normalized);
    scheduleCapture();
  }

  function chatStorageKey(accountLabel, chatId) {
    return `account:${accountLabel}:chat:${chatId}`;
  }

  // ============================================================
  // Chat parsing
  // ============================================================
  function cleanText(text) {
    return String(text || '')
      .replace(/\u200b/g, '')
      .replace(/\r/g, '')
      .trim();
  }

  function getCurrentChatId() {
    const match = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
    return match ? match[1] : null;
  }

  function getCurrentChatTitle() {
    const h1 = document.querySelector('h1');
    if (h1 && cleanText(h1.innerText)) return cleanText(h1.innerText);

    const title = cleanText(document.title).replace(/\s*-\s*ChatGPT.*$/i, '');
    return title || 'Untitled Chat';
  }

  function getMessageNodes() {
    return [...document.querySelectorAll('[data-message-author-role]')];
  }

  function getCurrentMessages() {
    return getMessageNodes()
      .map((node) => {
        const role = node.getAttribute('data-message-author-role') || 'unknown';
        const text = cleanText(node.innerText);
        return { role, text };
      })
      .filter((m) => m.text);
  }

  async function captureCurrentChat() {
    await maybeImportArchiveFromFile();

    if (!activeAccountLabel) {
      setStatus('Set account label first');
      return;
    }

    if (!(await ensureActiveLabelBinding({ silent: false }))) {
      return;
    }

    const chatId = getCurrentChatId();
    if (!chatId) return;

    const messages = getCurrentMessages();
    if (!messages.length) return;
    const title = getCurrentChatTitle();

    const chat = {
      accountLabel: activeAccountLabel,
      id: chatId,
      title,
      url: location.href,
      updatedAt: new Date().toISOString(),
      summaryBullets: buildChatSummaryBullets({
        title,
        messages
      }),
      messages
    };

    await dbSet(chatStorageKey(activeAccountLabel, chatId), chat);
    await rebuildArchiveFile();
  }

  // ============================================================
  // Rendering
  // ============================================================
  function formatTimestamp(iso) {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso || '';
    }
  }

  function formatOptionalBoolean(boolValue) {
    if (boolValue === true) return 'YES';
    if (boolValue === false) return 'NO';
    return 'UNKNOWN';
  }

  function renderProfileSection(profile) {
    const lines = [];
    const customInstructions = profile?.customInstructions || {};
    const aboutYou = profile?.aboutYou || {};
    const memories = Array.isArray(profile?.memories) ? profile.memories : [];

    lines.push('################################################################');
    lines.push('PROFILE');
    lines.push('################################################################');
    lines.push('Profile Last Synced: ' + formatTimestamp(profile?.updatedAt || ''));
    lines.push('Custom Instructions Enabled: ' + formatOptionalBoolean(customInstructions?.enabled));
    lines.push('Custom Instructions Source: ' + (customInstructions?.sourceUrl || ''));
    lines.push('About You Source: ' + (aboutYou?.sourceUrl || ''));
    lines.push('Memories Source: ' + (profile?.memoriesSourceUrl || ''));
    lines.push('<<CUSTOM_INSTRUCTIONS_ABOUT_USER>>');
    lines.push(customInstructions?.aboutUser || '');
    lines.push('<<END_CUSTOM_INSTRUCTIONS_ABOUT_USER>>');
    lines.push('<<CUSTOM_INSTRUCTIONS_ABOUT_MODEL>>');
    lines.push(customInstructions?.aboutModel || '');
    lines.push('<<END_CUSTOM_INSTRUCTIONS_ABOUT_MODEL>>');
    lines.push('<<ABOUT_YOU>>');
    lines.push(aboutYou?.text || '');
    lines.push('<<END_ABOUT_YOU>>');
    lines.push('Saved Memories:');

    if (memories.length) {
      for (const memory of memories) {
        lines.push('- ' + squeezeWhitespace(memory?.text || ''));
      }
    } else {
      lines.push('- (none found)');
    }

    if (Array.isArray(profile?.warnings) && profile.warnings.length) {
      lines.push('');
      lines.push('Profile Warnings:');
      for (const warning of profile.warnings) {
        lines.push('- ' + squeezeWhitespace(warning));
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  function renderChatSection(chat) {
    const lines = [];
    const summaryBullets = Array.isArray(chat.summaryBullets) && chat.summaryBullets.length
      ? chat.summaryBullets
      : buildChatSummaryBullets(chat);

    lines.push('################################################################');
    lines.push('CHAT');
    lines.push('################################################################');
    lines.push('Title: ' + (chat.title || 'Untitled Chat'));
    lines.push('Chat ID: ' + (chat.id || ''));
    lines.push('URL: ' + (chat.url || ''));
    lines.push('Last Updated: ' + formatTimestamp(chat.updatedAt));
    lines.push('');

    if (summaryBullets.length) {
      lines.push('Summary:');
      for (const bullet of summaryBullets) {
        lines.push('- ' + bullet);
      }
      lines.push('');
    }

    for (let i = 0; i < chat.messages.length; i++) {
      const m = chat.messages[i];
      lines.push('------------------------------------------------------------');
      lines.push('[' + (i + 1) + '] ' + String(m.role || 'unknown').toUpperCase());
      lines.push('------------------------------------------------------------');
      lines.push(m.text || '');
      lines.push('');
    }

    lines.push('');
    return lines.join('\n');
  }

  async function renderFullArchive() {
    const chats = await dbGetAllChats();
    const profiles = await dbGetAllProfiles();

    const grouped = new Map();
    for (const chat of chats) {
      const label = chat.accountLabel || 'unlabeled';
      if (!grouped.has(label)) grouped.set(label, []);
      grouped.get(label).push(chat);
    }

    const profileByAccount = new Map(
      profiles.map((profile) => [
        normalizeAccountLabel(profile?.accountLabel) || 'unlabeled',
        profile
      ])
    );

    const accountLabels = [...new Set([
      ...grouped.keys(),
      ...profileByAccount.keys()
    ])].sort();

    const out = [];
    out.push('============================================================');
    out.push('CHATGPT ARCHIVE');
    out.push('============================================================');
    out.push('Generated: ' + new Date().toLocaleString());
    out.push('Active account label in this page load: ' + (activeAccountLabel || '(not set)'));
    out.push('Delete sync armed: ' + (deleteSyncEnabled ? 'YES' : 'NO'));
    out.push('');

    for (const label of accountLabels) {
      const accountChats = grouped.get(label) || [];
      accountChats.sort((a, b) => {
        const ta = new Date(a.updatedAt || 0).getTime();
        const tb = new Date(b.updatedAt || 0).getTime();
        return tb - ta;
      });

      out.push('############################################################');
      out.push('ACCOUNT: ' + label);
      out.push('Tracked chats: ' + accountChats.length);
      out.push('############################################################');
      out.push('');

      const profile = profileByAccount.get(label);
      if (profile) {
        out.push(renderProfileSection(profile));
      }

      for (const chat of accountChats) {
        out.push(renderChatSection(chat));
      }
    }

    if (!accountLabels.length) {
      out.push('(No chats archived yet)');
      out.push('');
    }

    return out.join('\n');
  }

  async function rebuildArchiveFile() {
    const text = await renderFullArchive();
    if (text === lastRenderedArchive) return;
    lastRenderedArchive = text;
    await writeArchiveText(text);
  }

  // ============================================================
  // Delete sync
  // ============================================================
  async function removeChatForActiveAccount(chatId) {
    if (!chatId || !activeAccountLabel) return;
    if (!(await ensureActiveLabelBinding({ silent: true }))) return;
    await maybeImportArchiveFromFile();
    await dbDelete(chatStorageKey(activeAccountLabel, chatId));
    await rebuildArchiveFile();
    setStatus(`Removed chat ${chatId.slice(0, 8)} from ${activeAccountLabel}`);
  }

  function findNearestChatIdFromElement(el) {
    if (!el) return null;

    const directAnchor = el.closest?.('a[href*="/c/"]');
    if (directAnchor) {
      const m = directAnchor.href.match(/\/c\/([a-zA-Z0-9-]+)/);
      if (m) return m[1];
    }

    let node = el;
    for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
      const anchor = node.querySelector?.('a[href*="/c/"]');
      if (anchor) {
        const m = anchor.href.match(/\/c\/([a-zA-Z0-9-]+)/);
        if (m) return m[1];
      }
    }

    return null;
  }

  function looksLikeDeleteAction(el) {
    if (!el) return false;

    const text = cleanText(el.innerText || el.textContent || '');
    const aria = cleanText(el.getAttribute?.('aria-label') || '');
    const title = cleanText(el.getAttribute?.('title') || '');

    return /delete/i.test(text) || /delete/i.test(aria) || /delete/i.test(title);
  }

  function installDeleteTracking() {
    document.addEventListener('click', (event) => {
      const target = event.target;

      const chatIdFromContext = findNearestChatIdFromElement(target);
      if (chatIdFromContext) {
        lastRowChatId = chatIdFromContext;
      }

      if (!deleteSyncEnabled || !activeAccountLabel) return;
      if (!looksLikeDeleteAction(target)) return;

      pendingDeleteChatId = lastRowChatId || getCurrentChatId();
      if (!pendingDeleteChatId) return;

      setStatus(`Delete detected for ${pendingDeleteChatId.slice(0, 8)}...`);

      setTimeout(() => {
        const chatId = pendingDeleteChatId;
        pendingDeleteChatId = null;

        removeChatForActiveAccount(chatId).catch((err) => {
          console.error('Delete sync failed:', err);
          setStatus('Delete sync failed');
        });
      }, DELETE_DELAY_MS);
    }, true);
  }

  // ============================================================
  // Import wizard helpers
  // ============================================================
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function buildArchiveImportAccounts(parsedArchive) {
    const byLabel = new Map();
    const chats = Array.isArray(parsedArchive?.chats) ? parsedArchive.chats : [];
    const profiles = Array.isArray(parsedArchive?.profiles) ? parsedArchive.profiles : [];

    for (const chat of chats) {
      const label = normalizeAccountLabel(chat?.accountLabel) || 'unlabeled';
      if (!byLabel.has(label)) byLabel.set(label, { label, chats: [], profile: null });
      byLabel.get(label).chats.push(chat);
    }

    for (const profile of profiles) {
      const label = normalizeAccountLabel(profile?.accountLabel) || 'unlabeled';
      if (!byLabel.has(label)) byLabel.set(label, { label, chats: [], profile: null });
      byLabel.get(label).profile = profile;
    }

    const out = [...byLabel.values()];
    for (const account of out) {
      account.chats.sort((a, b) => {
        const ta = new Date(a?.updatedAt || 0).getTime();
        const tb = new Date(b?.updatedAt || 0).getTime();
        return ta - tb;
      });
    }

    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  function getImportSelection() {
    if (!importWizardData?.accounts?.length) return null;
    const selectedLabel = importWizardData.selectedLabel || importWizardData.accounts[0].label;
    return importWizardData.accounts.find((acc) => acc.label === selectedLabel) || importWizardData.accounts[0];
  }

  function getComposerTextarea() {
    return document.querySelector('#prompt-textarea')
      || document.querySelector('textarea[data-id="root"]')
      || document.querySelector('main textarea')
      || null;
  }

  function getSendButton() {
    return document.querySelector('button[data-testid="send-button"]')
      || document.querySelector('button[aria-label*="Send"]')
      || document.querySelector('button[aria-label*="send"]')
      || null;
  }

  function setTextareaValue(textarea, value) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value');
    if (descriptor?.set) {
      descriptor.set.call(textarea, value);
    } else {
      textarea.value = value;
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function waitFor(fn, timeoutMs = 120000, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = fn();
      if (result) return result;
      await sleep(intervalMs);
    }
    throw new Error('Timed out waiting for UI state');
  }

  async function waitForComposerAvailability(timeoutMs = 180000) {
    return waitFor(() => {
      const textarea = getComposerTextarea();
      if (!textarea || textarea.disabled) return null;

      const button = getSendButton();
      if (button) {
        const label = `${button.getAttribute('aria-label') || ''} ${button.innerText || ''}`.toLowerCase();
        if (button.disabled) return null;
        if (label.includes('stop')) return null;
      }

      return textarea;
    }, timeoutMs, 250);
  }

  async function sendComposerMessage(text) {
    const textarea = await waitForComposerAvailability();
    textarea.focus();
    setTextareaValue(textarea, text);
    await sleep(120);

    let sent = false;
    const sendButton = getSendButton();
    if (sendButton && !sendButton.disabled) {
      sendButton.click();
      sent = true;
    }

    if (!sent) {
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        which: 13,
        keyCode: 13,
        bubbles: true
      }));
      sent = true;
    }

    if (!sent) {
      throw new Error('Could not send import message');
    }

    await sleep(250);
    await waitFor(() => {
      const el = getComposerTextarea();
      return el && !cleanText(el.value || '');
    }, 15000, 200).catch(() => true);
  }

  function renderImportedChat(chat, index) {
    const lines = [];
    lines.push(`===== IMPORTED CHAT ${index + 1} =====`);
    lines.push(`Title: ${chat?.title || 'Untitled Chat'}`);
    lines.push(`Chat ID: ${chat?.id || ''}`);
    lines.push(`URL: ${chat?.url || ''}`);
    lines.push(`Last Updated: ${formatTimestamp(chat?.updatedAt || '')}`);
    lines.push('');

    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    for (const message of messages) {
      lines.push(`[${String(message?.role || 'unknown').toUpperCase()}]`);
      lines.push(message?.text || '');
      lines.push('');
    }

    return lines.join('\n');
  }

  function buildImportChunks(chats, sourceLabel, maxChars = 12000) {
    const header = [
      `Imported chat archive from account label: ${sourceLabel}`,
      `Imported on: ${new Date().toLocaleString()}`,
      '',
      'Please keep this thread as an archive record.',
      ''
    ].join('\n');

    const blocks = chats.map((chat, index) => renderImportedChat(chat, index));
    const chunks = [];
    let current = header;

    for (const block of blocks) {
      const candidate = `${current}\n${block}\n`;
      if (candidate.length <= maxChars || current.length < header.length + 20) {
        current = candidate;
      } else {
        chunks.push(current);
        current = `${header}\n${block}\n`;
      }
    }

    if (cleanText(current)) {
      chunks.push(current);
    }

    return chunks;
  }

  function buildCustomInstructionPayloads(customInstructions, aboutYouText = '') {
    const aboutUser = customInstructions?.aboutUser || aboutYouText || '';
    const aboutModel = customInstructions?.aboutModel || '';
    const enabled = customInstructions?.enabled === null ? true : !!customInstructions?.enabled;

    return [
      { about_user_message: aboutUser, about_model_message: aboutModel, enabled },
      { about_user: aboutUser, about_model: aboutModel, enabled },
      { aboutUser, aboutModel, enabled },
      {
        data: {
          about_user_message: aboutUser,
          about_model_message: aboutModel,
          enabled
        }
      }
    ];
  }

  async function applyCustomInstructionsToCurrentAccount(customInstructions, aboutYouText = '') {
    const base = getConversationApiOrigin();
    const endpoints = [
      `${base}/backend-api/user_system_messages`,
      `${base}/backend-api/custom_instructions`
    ];
    const methods = ['POST', 'PATCH', 'PUT'];
    const payloads = buildCustomInstructionPayloads(customInstructions, aboutYouText);
    const errors = [];

    for (const endpoint of endpoints) {
      for (const method of methods) {
        for (const payload of payloads) {
          try {
            await fetchJson(endpoint, {
              method,
              authMode: 'auto',
              headers: {
                'content-type': 'application/json'
              },
              body: JSON.stringify(payload)
            });

            return { endpoint, method };
          } catch (err) {
            errors.push(`${method} ${endpoint} => ${err?.message || err}`);
          }
        }
      }
    }

    throw new Error(errors.slice(-10).join(' || ') || 'Could not apply custom instructions');
  }

  function updateImportWizardUi() {
    const modal = document.getElementById('cgpt-archive-import-modal');
    if (!modal) return;

    const select = modal.querySelector('#cgpt-import-account-select');
    const fileEl = modal.querySelector('#cgpt-import-source-file');
    const summaryEl = modal.querySelector('#cgpt-import-summary');
    const btnApply = modal.querySelector('#cgpt-import-apply-ci');
    const btnImport = modal.querySelector('#cgpt-import-import-chats');
    const btnRunAll = modal.querySelector('#cgpt-import-run-all');

    if (!select || !fileEl || !summaryEl || !btnApply || !btnImport || !btnRunAll) return;

    select.innerHTML = '';
    const accounts = importWizardData?.accounts || [];

    if (!accounts.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '(load archive first)';
      select.appendChild(option);
      select.disabled = true;
      btnApply.disabled = true;
      btnImport.disabled = true;
      btnRunAll.disabled = true;
      fileEl.textContent = importWizardData?.sourceFileName || '(none loaded)';
      summaryEl.innerHTML = 'Load an archive TXT to begin.';
      return;
    }

    const selectedLabel = importWizardData.selectedLabel || accounts[0].label;
    importWizardData.selectedLabel = selectedLabel;

    for (const account of accounts) {
      const option = document.createElement('option');
      option.value = account.label;
      option.textContent = `${account.label} (${account.chats.length} chats)`;
      if (account.label === selectedLabel) option.selected = true;
      select.appendChild(option);
    }

    const selected = getImportSelection();
    const profile = selected?.profile;
    const hasCustomInstructions = !!(profile?.customInstructions?.aboutUser || profile?.customInstructions?.aboutModel);
    const hasAboutYou = !!profile?.aboutYou?.text;
    const memoryCount = Array.isArray(profile?.memories) ? profile.memories.length : 0;

    fileEl.textContent = importWizardData?.sourceFileName || '(unnamed file)';
    summaryEl.innerHTML =
      `Selected account: <b>${escapeHtml(selected?.label || '')}</b><br>` +
      `Chats in archive: <b>${selected?.chats?.length || 0}</b><br>` +
      `Custom instructions in archive: <b>${hasCustomInstructions ? 'yes' : 'no'}</b><br>` +
      `About You in archive: <b>${hasAboutYou ? 'yes' : 'no'}</b><br>` +
      `Memories in archive: <b>${memoryCount}</b><br>` +
      `Import status: <b>${importInProgress ? 'running' : 'idle'}</b>`;

    select.disabled = false;
    btnApply.disabled = !hasCustomInstructions || importInProgress;
    btnImport.disabled = !(selected?.chats?.length > 0) || importInProgress;
    btnRunAll.disabled = importInProgress;
  }

  async function openArchiveTextFile() {
    if (window.showOpenFilePicker) {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{
          description: 'Text files',
          accept: { 'text/plain': ['.txt'] }
        }]
      });
      const file = await handle.getFile();
      return {
        name: file.name || 'archive.txt',
        text: await file.text()
      };
    }

    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,text/plain';
      input.onchange = async () => {
        try {
          const file = input.files && input.files[0];
          if (!file) {
            reject(new Error('No file selected'));
            return;
          }
          resolve({
            name: file.name || 'archive.txt',
            text: await file.text()
          });
        } catch (err) {
          reject(err);
        }
      };
      input.click();
    });
  }

  async function loadImportWizardArchiveFile() {
    const selected = await openArchiveTextFile();
    const parsed = parseArchiveText(selected.text);
    const accounts = buildArchiveImportAccounts(parsed);

    importWizardData = {
      sourceFileName: selected.name,
      parsed,
      accounts,
      selectedLabel: accounts[0]?.label || ''
    };

    updateImportWizardUi();
    setStatus(`Import archive loaded: ${selected.name}`);
  }

  async function importWizardApplyCustomInstructions() {
    const selected = getImportSelection();
    const customInstructions = selected?.profile?.customInstructions;
    const aboutYouText = selected?.profile?.aboutYou?.text || '';
    if (!customInstructions || !(customInstructions.aboutUser || customInstructions.aboutModel || aboutYouText)) {
      throw new Error('No custom instructions/about-you found for selected account');
    }

    setStatus(`Applying custom instructions from ${selected.label}...`);
    const result = await applyCustomInstructionsToCurrentAccount(customInstructions, aboutYouText);
    setStatus(`Custom instructions applied (${result.method})`);
  }

  async function importWizardImportChats() {
    if (importInProgress) return;
    const selected = getImportSelection();
    if (!selected?.chats?.length) {
      throw new Error('No chats found for selected account');
    }

    const chunks = buildImportChunks(selected.chats, selected.label);
    const proceed = confirm(
      `Import ${selected.chats.length} chats from "${selected.label}" as ${chunks.length} message chunk(s) into this account?\n\n` +
      'This will send messages in the currently open chat.'
    );
    if (!proceed) return;

    importInProgress = true;
    updateImportWizardUi();
    try {
      for (let i = 0; i < chunks.length; i++) {
        setStatus(`Importing chats chunk ${i + 1}/${chunks.length}...`);
        await sendComposerMessage(chunks[i]);
        await sleep(500);
        await waitForComposerAvailability();
      }
      setStatus(`Chat import complete: ${selected.chats.length} chats imported`);
    } finally {
      importInProgress = false;
      updateImportWizardUi();
    }
  }

  async function importWizardRunAll() {
    if (importInProgress) return;
    try {
      await importWizardApplyCustomInstructions();
    } catch (err) {
      console.warn('Import wizard custom instruction step failed:', err);
      setStatus(`Custom instructions step failed: ${err?.message || err}`);
    }

    await importWizardImportChats();
  }

  // ============================================================
  // Watchers
  // ============================================================
  function scheduleCapture() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      captureCurrentChat().catch((err) => {
        console.error('Capture failed:', err);
        setStatus('Capture failed');
      });
    }, SAVE_DEBOUNCE_MS);
  }

  function watchDom() {
    const observer = new MutationObserver(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        scheduleCapture();
        return;
      }

      scheduleCapture();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // ============================================================
  // UI
  // ============================================================
  function setStatus(msg) {
    const el = document.getElementById('cgpt-archive-status');
    if (el) el.textContent = msg;
  }

  function isUiHidden() {
    try { return localStorage.getItem(UI_HIDDEN_KEY) === '1'; } catch { return false; }
  }

  function setUiHidden(hidden) {
    try { localStorage.setItem(UI_HIDDEN_KEY, hidden ? '1' : '0'); } catch {}
    updateUiVisibility();
  }

  function updateUiVisibility() {
    const wrap = document.getElementById('cgpt-archive-wrap');
    const showBtn = document.getElementById('cgpt-archive-show');
    const hidden = isUiHidden();
    if (wrap) wrap.style.display = hidden ? 'none' : 'flex';
    if (showBtn) showBtn.style.display = hidden ? 'flex' : 'none';
  }

  function updateAccountBadge() {
    const el = document.getElementById('cgpt-archive-account');
    if (!el) return;
    el.textContent = activeAccountLabel ? `Account: ${activeAccountLabel}` : 'Account: Unset';
    el.style.color = activeAccountLabel ? '#10a37f' : '#ef4444';
  }

  function injectStyles() {
    if (document.getElementById('cgpt-archive-styles')) return;
    const style = document.createElement('style');
    style.id = 'cgpt-archive-styles';
    style.innerHTML = `
      #cgpt-archive-wrap {
        position: fixed; right: 20px; bottom: 20px; z-index: 999999;
        display: flex; flex-direction: column; gap: 12px; width: 320px;
        background: rgba(32, 33, 35, 0.85); backdrop-filter: blur(12px);
        border: 1px solid rgba(255,255,255,0.1); border-radius: 16px;
        padding: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #ececf1;
      }
      .cgpt-btn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .cgpt-btn {
        background: #444654; color: #fff; border: 1px solid rgba(255,255,255,0.05);
        padding: 8px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500;
        transition: all 0.2s ease; display: flex; align-items: center; justify-content: center;
      }
      .cgpt-btn:hover { background: #565869; transform: translateY(-1px); }
      .cgpt-btn-primary { background: #10a37f; border-color: #10a37f; }
      .cgpt-btn-primary:hover { background: #0e906f; }
      .cgpt-btn-danger { background: transparent; color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); }
      .cgpt-btn-danger:hover { background: rgba(239, 68, 68, 0.1); }
      #cgpt-archive-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px; margin-bottom: 4px; }
      #cgpt-archive-title { font-weight: 600; font-size: 14px; }
      #cgpt-archive-account { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
      #cgpt-archive-status { font-size: 12px; color: #9ca3af; text-align: center; margin-top: 4px; background: rgba(0,0,0,0.2); padding: 6px; border-radius: 6px; }
      #cgpt-archive-show {
        position: fixed; right: 20px; bottom: 20px; z-index: 999999;
        background: #10a37f; color: white; border: none; padding: 12px 20px;
        border-radius: 99px; cursor: pointer; font-family: inherit; font-weight: 600; font-size: 14px;
        box-shadow: 0 4px 12px rgba(16, 163, 127, 0.4); transition: transform 0.2s ease;
      }
      #cgpt-archive-show:hover { transform: scale(1.05); }
      #cgpt-archive-guide-modal {
        position: fixed; inset: 0; z-index: 1000000; display: none;
        align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.65);
        padding: 16px;
      }
      .cgpt-guide-panel {
        width: min(760px, 95vw); max-height: 86vh; overflow: auto;
        background: #1f2023; border: 1px solid rgba(255,255,255,0.12); border-radius: 14px;
        box-shadow: 0 16px 40px rgba(0,0,0,0.5); color: #ececf1;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .cgpt-guide-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.1);
        position: sticky; top: 0; background: #1f2023;
      }
      .cgpt-guide-title { font-size: 15px; font-weight: 700; }
      .cgpt-guide-close {
        background: transparent; color: #ececf1; border: 1px solid rgba(255,255,255,0.2);
        border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; font-weight: 600;
      }
      .cgpt-guide-close:hover { background: rgba(255,255,255,0.08); }
      .cgpt-guide-body { padding: 14px 16px 16px; font-size: 13px; line-height: 1.45; }
      .cgpt-guide-body h3 { margin: 8px 0 8px; font-size: 14px; color: #93c5fd; }
      .cgpt-guide-body ol { margin: 0 0 12px 20px; padding: 0; }
      .cgpt-guide-body li { margin: 0 0 7px; }
      .cgpt-guide-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      .cgpt-guide-table th, .cgpt-guide-table td {
        border: 1px solid rgba(255,255,255,0.12); padding: 8px; text-align: left; vertical-align: top;
      }
      .cgpt-guide-table th { background: rgba(255,255,255,0.06); font-size: 12px; }
      .cgpt-guide-note {
        margin-top: 10px; padding: 10px; border-radius: 8px;
        background: rgba(16, 163, 127, 0.12); border: 1px solid rgba(16, 163, 127, 0.35);
      }
      .cgpt-btn-row-single { display: grid; grid-template-columns: 1fr; gap: 8px; }
      #cgpt-archive-import-modal {
        position: fixed; inset: 0; z-index: 1000001; display: none;
        align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.72); padding: 16px;
      }
      .cgpt-import-panel {
        width: min(820px, 96vw); max-height: 88vh; overflow: auto;
        background: #17181b; border: 1px solid rgba(255,255,255,0.16); border-radius: 14px;
        box-shadow: 0 20px 48px rgba(0,0,0,0.55); color: #ececf1;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .cgpt-import-head {
        display: flex; justify-content: space-between; align-items: center;
        padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.12);
        position: sticky; top: 0; background: #17181b;
      }
      .cgpt-import-title { font-size: 15px; font-weight: 700; }
      .cgpt-import-body { padding: 14px 16px 16px; font-size: 13px; line-height: 1.45; }
      .cgpt-import-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
      .cgpt-import-actions .cgpt-btn { width: 100%; }
      .cgpt-import-row { display: grid; grid-template-columns: 160px 1fr; gap: 10px; align-items: center; margin-top: 10px; }
      .cgpt-import-select {
        width: 100%; background: #2a2d34; color: #ececf1; border: 1px solid rgba(255,255,255,0.16);
        border-radius: 8px; padding: 8px; font-size: 13px;
      }
      .cgpt-import-summary {
        margin-top: 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12);
        border-radius: 10px; padding: 10px; color: #d1d5db;
      }
      .cgpt-import-hint {
        margin-top: 10px; padding: 10px; border-radius: 8px;
        background: rgba(59, 130, 246, 0.14); border: 1px solid rgba(59, 130, 246, 0.35);
      }
      @media (max-width: 780px) {
        .cgpt-import-actions { grid-template-columns: 1fr; }
        .cgpt-import-row { grid-template-columns: 1fr; gap: 6px; }
      }
    `;
    document.head.appendChild(style);
  }

  function closeGuideModal() {
    const modal = document.getElementById('cgpt-archive-guide-modal');
    if (modal) modal.style.display = 'none';
  }

  function ensureGuideModal() {
    let modal = document.getElementById('cgpt-archive-guide-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'cgpt-archive-guide-modal';
    modal.innerHTML = `
      <div class="cgpt-guide-panel" role="dialog" aria-modal="true" aria-label="Archive guide">
        <div class="cgpt-guide-head">
          <div class="cgpt-guide-title">Archive Manager Guide</div>
          <button class="cgpt-guide-close" data-guide-close="1">Close</button>
        </div>
        <div class="cgpt-guide-body">
          <h3>Step-by-step setup</h3>
          <ol>
            <li>Open ChatGPT and log into the account you want to archive.</li>
            <li>Click <b>Set Account</b> and enter a unique label per account like <code>main</code> or <code>work</code>.</li>
            <li>Click <b>Choose File</b> and pick your archive <code>.txt</code> file.</li>
            <li>Click <b>Sync All</b> to pull all chats plus account profile data.</li>
            <li>Click <b>Sync Profile</b> any time you want to force-refresh memories/custom instructions/About You.</li>
            <li>Leave the tab open and the script keeps auto-syncing in the background.</li>
          </ol>

          <h3>What each button does</h3>
          <table class="cgpt-guide-table">
            <thead>
              <tr><th>Button</th><th>Action</th></tr>
            </thead>
            <tbody>
              <tr><td><b>Set Account</b></td><td>Sets the label for the currently logged-in ChatGPT account. Data is grouped by this label in the TXT archive.</td></tr>
              <tr><td><b>Choose File</b></td><td>Selects the archive TXT file to read/write. Existing archive content is imported first.</td></tr>
              <tr><td><b>Save Now</b></td><td>Captures only the currently open chat page immediately.</td></tr>
              <tr><td><b>Sync All</b></td><td>Fetches conversation list, downloads each chat, and also syncs account profile data.</td></tr>
              <tr><td><b>Sync Profile</b></td><td>Forces a profile refresh (custom instructions + About You + saved memories) and writes it to archive.</td></tr>
              <tr><td><b>Hide UI</b></td><td>Hides the panel. Use the floating <b>Open Archive</b> button to show it again.</td></tr>
              <tr><td><b>Guide</b></td><td>Opens this step-by-step help window.</td></tr>
              <tr><td><b>Import Wizard</b></td><td>Loads an archive TXT and helps import custom instructions + chats into the current account.</td></tr>
            </tbody>
          </table>

          <div class="cgpt-guide-note">
            Tip: If memories/custom instructions/About You are not showing yet, click <b>Sync Profile</b> once while logged into the correct account.
          </div>
        </div>
      </div>
    `;

    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeGuideModal();
      }
    });

    modal.querySelectorAll('[data-guide-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeGuideModal());
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeGuideModal();
      }
    });

    document.body.appendChild(modal);
    return modal;
  }

  function openGuideModal() {
    const modal = ensureGuideModal();
    modal.style.display = 'flex';
  }

  function closeImportWizardModal() {
    const modal = document.getElementById('cgpt-archive-import-modal');
    if (modal) modal.style.display = 'none';
  }

  function ensureImportWizardModal() {
    let modal = document.getElementById('cgpt-archive-import-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'cgpt-archive-import-modal';
    modal.innerHTML = `
      <div class="cgpt-import-panel" role="dialog" aria-modal="true" aria-label="Import wizard">
        <div class="cgpt-import-head">
          <div class="cgpt-import-title">Import Wizard</div>
          <button class="cgpt-guide-close" data-import-close="1">Close</button>
        </div>
        <div class="cgpt-import-body">
          <div><b>Goal:</b> move archive content into this currently logged-in account with minimal clicks.</div>
          <div class="cgpt-import-row">
            <div>Source archive file</div>
            <div id="cgpt-import-source-file">(none loaded)</div>
          </div>
          <div class="cgpt-import-row">
            <div>Source account label</div>
            <div>
              <select id="cgpt-import-account-select" class="cgpt-import-select" disabled>
                <option>(load archive first)</option>
              </select>
            </div>
          </div>

          <div class="cgpt-import-actions">
            <button class="cgpt-btn" id="cgpt-import-load-file">Load Archive TXT</button>
            <button class="cgpt-btn" id="cgpt-import-apply-ci" disabled>Apply Custom Instructions</button>
            <button class="cgpt-btn" id="cgpt-import-import-chats" disabled>Import Chats</button>
          </div>
          <div class="cgpt-import-actions">
            <button class="cgpt-btn cgpt-btn-primary" id="cgpt-import-run-all" disabled>Run Import All</button>
          </div>

          <div class="cgpt-import-summary" id="cgpt-import-summary">Load an archive TXT to begin.</div>
          <div class="cgpt-import-hint">
            Import Chats sends archive chunks into the currently open chat thread in this account.
          </div>
        </div>
      </div>
    `;

    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeImportWizardModal();
      }
    });

    modal.querySelectorAll('[data-import-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeImportWizardModal());
    });

    const select = modal.querySelector('#cgpt-import-account-select');
    if (select) {
      select.addEventListener('change', () => {
        importWizardData = importWizardData || { accounts: [] };
        importWizardData.selectedLabel = select.value;
        updateImportWizardUi();
      });
    }

    const loadBtn = modal.querySelector('#cgpt-import-load-file');
    if (loadBtn) {
      loadBtn.addEventListener('click', async () => {
        try {
          await loadImportWizardArchiveFile();
        } catch (err) {
          setStatus(`Import load failed: ${err?.message || err}`);
        }
      });
    }

    const applyBtn = modal.querySelector('#cgpt-import-apply-ci');
    if (applyBtn) {
      applyBtn.addEventListener('click', async () => {
        try {
          await importWizardApplyCustomInstructions();
          updateImportWizardUi();
        } catch (err) {
          setStatus(`Apply custom instructions failed: ${err?.message || err}`);
        }
      });
    }

    const importBtn = modal.querySelector('#cgpt-import-import-chats');
    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        try {
          await importWizardImportChats();
        } catch (err) {
          setStatus(`Chat import failed: ${err?.message || err}`);
        }
      });
    }

    const runAllBtn = modal.querySelector('#cgpt-import-run-all');
    if (runAllBtn) {
      runAllBtn.addEventListener('click', async () => {
        try {
          await importWizardRunAll();
        } catch (err) {
          setStatus(`Run-all import failed: ${err?.message || err}`);
        }
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeImportWizardModal();
      }
    });

    document.body.appendChild(modal);
    return modal;
  }

  function openImportWizardModal() {
    const modal = ensureImportWizardModal();
    modal.style.display = 'flex';
    updateImportWizardUi();
  }

  function addUi() {
    if (document.getElementById('cgpt-archive-wrap')) {
      updateUiVisibility();
      return;
    }

    injectStyles();

    const showBtn = document.createElement('button');
    showBtn.id = 'cgpt-archive-show';
    showBtn.textContent = 'Open Archive';
    showBtn.onclick = () => setUiHidden(false);

    const wrap = document.createElement('div');
    wrap.id = 'cgpt-archive-wrap';

    // Header
    const header = document.createElement('div');
    header.id = 'cgpt-archive-header';

    const title = document.createElement('div');
    title.id = 'cgpt-archive-title';
    title.textContent = 'Archive Manager';

    const accountBadge = document.createElement('div');
    accountBadge.id = 'cgpt-archive-account';

    header.appendChild(title);
    header.appendChild(accountBadge);

    // Buttons
    const row1 = document.createElement('div');
    row1.className = 'cgpt-btn-row';
    const setAccountBtn = createBtn('Set Account', () => promptForAccountLabel());
    const chooseFileBtn = createBtn('Choose File', async () => {
      try { await chooseArchiveFile(); await rebuildArchiveFile(); }
      catch (err) { setStatus('Could not choose file'); }
    });
    row1.appendChild(setAccountBtn);
    row1.appendChild(chooseFileBtn);

    const row2 = document.createElement('div');
    row2.className = 'cgpt-btn-row';
    const saveBtn = createBtn('Save Now', async () => {
      try { await captureCurrentChat(); } catch (err) { setStatus('Save failed'); }
    }, 'cgpt-btn-primary');
    const syncAllBtn = createBtn('Sync All', async () => {
      try { await syncAllChatsForActiveAccount({ silent: false }); } catch (err) { setStatus('Sync failed'); }
    });
    row2.appendChild(saveBtn);
    row2.appendChild(syncAllBtn);

    const row3 = document.createElement('div');
    row3.className = 'cgpt-btn-row';
    const syncProfileBtn = createBtn('Sync Profile', async () => {
      try { await syncAccountProfileForActiveAccount({ silent: false, force: true }); }
      catch (err) { setStatus('Profile sync failed'); }
    });
    const hideBtn = createBtn('Hide UI', () => setUiHidden(true), 'cgpt-btn-danger');
    row3.appendChild(syncProfileBtn);
    row3.appendChild(hideBtn);

    const row4 = document.createElement('div');
    row4.className = 'cgpt-btn-row';
    const importWizardBtn = createBtn('Import Wizard', () => openImportWizardModal());
    const guideBtn = createBtn('Guide', () => openGuideModal());
    row4.appendChild(importWizardBtn);
    row4.appendChild(guideBtn);

    const status = document.createElement('div');
    status.id = 'cgpt-archive-status';
    status.textContent = 'Waiting for input...';

    wrap.appendChild(header);
    wrap.appendChild(row1);
    wrap.appendChild(row2);
    wrap.appendChild(row3);
    wrap.appendChild(row4);
    wrap.appendChild(status);

    document.body.appendChild(showBtn);
    document.body.appendChild(wrap);
    ensureGuideModal();
    ensureImportWizardModal();

    updateAccountBadge();
    updateUiVisibility();
  }

  function createBtn(text, onClick, extraClass = '') {
    const btn = document.createElement('button');
    btn.className = `cgpt-btn ${extraClass}`;
    btn.textContent = text;
    btn.onclick = onClick;
    return btn;
  }

  // ============================================================
  // Init
  // ============================================================
  async function init() {
    addUi();
    installDeleteTracking();
    installAutoSyncListeners();
    watchDom();
    startAutoSyncLoop();

    const handle = await getSavedFileHandle();
    await maybeImportArchiveFromFile(handle);
    const persistedAccountLabel = getPersistedAccountLabel();
    if (persistedAccountLabel) {
      setActiveAccountLabel(persistedAccountLabel);
      setStatus(`Account auto-loaded: ${persistedAccountLabel}`);
    } else if (handle) {
      setStatus('Set account label first');
    } else {
      setStatus('Choose archive file + set account label');
    }

    setInterval(addUi, 2000);
    scheduleCapture();
  }

  init().catch((err) => {
    console.error('Init failed:', err);
  });
})();
