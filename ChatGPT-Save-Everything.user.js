// ==UserScript==
// @name         ChatGPT Archive (Save Chatlogs Locally)
// @namespace    http://tampermonkey.net/
// @version      2.11
// @description  Archive ChatGPT chats and profile context into one local TXT file, with account-safe labels, auto-sync, and import tools.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @homepageURL  https://github.com/darkcpps/ChatGPT-Save-Everything
// @updateURL    https://raw.githubusercontent.com/darkcpps/ChatGPT-Save-Everything/main/ChatGPT-Save-Everything.user.js
// @downloadURL  https://raw.githubusercontent.com/darkcpps/ChatGPT-Save-Everything/main/ChatGPT-Save-Everything.user.js
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
  const BUNDLE_FOLDER_HANDLE_KEY = 'archiveBundleFolderHandle';
  const EXPORT_SETTINGS_KEY = 'cgptArchiveExportSettings';
  const CHAT_KEY_PREFIX = 'account:';
  const PROFILE_KEY_PREFIX = 'profile:';
  const ACCOUNT_LABEL_KEY = 'cgptArchiveAccountLabel';
  const LABEL_BINDINGS_KEY = 'cgptArchiveLabelBindings';
  const UI_HIDDEN_KEY = 'cgptArchiveUiHidden';
  const SETUP_SHOWN_KEY = 'cgpt-archive-setup-shown-v2';
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
  const UI_VISIBILITY_ANIMATION_MS = 260;
  const MODAL_ANIMATION_MS = 220;
  const STATUS_PULSE_MS = 420;
  const CHAT_BLOCK_SPLIT = '\n################################################################\nCHAT\n################################################################\n';
  const PROFILE_BLOCK_MARKER = '\n################################################################\nPROFILE\n################################################################\n';
  const MEMORY_SYNC_STATUS_FRESH = 'fresh';
  const MEMORY_SYNC_STATUS_STALE = 'stale';
  const MEMORY_SYNC_STATUS_FAILED = 'failed';
  const MEMORY_SYNC_STATUS_UNKNOWN = 'unknown';
  const SCRIPT_VERSION = '2.10';
  const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const UPDATE_LAST_CHECK_KEY = 'cgptArchiveUpdateLastCheckAt';
  const UPDATE_DISMISSED_VERSION_KEY = 'cgptArchiveUpdateDismissedVersion';
  const UPDATE_CHECK_CANDIDATES = [
    'https://raw.githubusercontent.com/darkcpps/ChatGPT-Save-Everything/main/ChatGPT-Save-Everything.user.js',
    'https://cdn.jsdelivr.net/gh/darkcpps/ChatGPT-Save-Everything@main/ChatGPT-Save-Everything.user.js'
  ];
  const UPDATE_INSTALL_URL = UPDATE_CHECK_CANDIDATES[0];

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
  let statusPulseTimer = null;
  let progressHideTimer = null;
  let wrapHideTimer = null;
  let showButtonHideTimer = null;
  let guideStepIndex = 0;
  let hasArchiveFileHandle = false;
  let hasBundleFolderHandle = false;
  const modalHideTimers = new WeakMap();

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

  async function getSavedBundleFolderHandle() {
    try {
      return await dbGet(BUNDLE_FOLDER_HANDLE_KEY);
    } catch (err) {
      console.error('Could not restore bundle folder handle:', err);
      return null;
    }
  }

  async function setSavedBundleFolderHandle(handle) {
    await dbSet(BUNDLE_FOLDER_HANDLE_KEY, handle);
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
    hasArchiveFileHandle = true;
    archiveImportDone = false;
    archiveImportPromise = null;
    await maybeImportArchiveFromFile(handle);
    setStatus('Archive file selected');
    return handle;
  }

  async function chooseArchiveBundleFolder() {
    if (!window.showDirectoryPicker) {
      alert('This browser does not support directory picker. Use recent Chrome/Edge for bundle folder export.');
      return null;
    }

    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await setSavedBundleFolderHandle(handle);
    hasBundleFolderHandle = true;
    setStatus('Bundle folder selected');
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

  function sanitizeFilename(name, fallback = 'file') {
    const safe = cleanText(String(name || ''))
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '');
    return safe || fallback;
  }

  function extractUrlsFromText(text) {
    const input = String(text || '');
    const regex = /https?:\/\/[^\s<>"'`]+/gi;
    const urls = [];
    let match;
    while ((match = regex.exec(input)) !== null) {
      const raw = cleanText(match[0] || '');
      if (!raw) continue;
      const normalized = raw.replace(/[),.;!?]+$/g, '');
      if (!normalized) continue;
      urls.push(normalized);
    }
    return urls;
  }

  function extractCodeBlocksFromText(text) {
    const input = String(text || '');
    const regex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
    const out = [];
    let match;
    while ((match = regex.exec(input)) !== null) {
      const lang = cleanText(match[1] || '');
      const code = String(match[2] || '').replace(/\r\n?/g, '\n').trim();
      if (!code) continue;
      out.push({ lang, code });
    }
    return out;
  }

  function classifyUrlKind(url) {
    const input = String(url || '').toLowerCase();
    if (!input) return 'source';
    // ChatGPT estuary URLs are commonly used for generated/uploaded images.
    if (input.includes('/backend-api/estuary/content') || input.includes('/estuary/content')) return 'media';
    if (/\.(png|jpe?g|gif|webp|svg|bmp|tiff?|avif|heic)(\?|#|$)/i.test(input)) return 'media';
    if (/\.(mp4|mov|webm|m4v|avi|mkv|mp3|wav|ogg|flac)(\?|#|$)/i.test(input)) return 'media';
    if (input.includes('/image') || input.includes('/images/') || input.includes('/media/')) return 'media';
    if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|csv|json|txt|md)(\?|#|$)/i.test(input)) return 'file';
    if (input.includes('/files/') || input.includes('/file/') || input.includes('download')) return 'file';
    return 'source';
  }

  function extensionFromUrl(url) {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname || '';
      const extMatch = path.match(/\.([a-zA-Z0-9]{1,8})$/);
      return extMatch ? `.${extMatch[1].toLowerCase()}` : '';
    } catch {
      const extMatch = String(url || '').match(/\.([a-zA-Z0-9]{1,8})(\?|#|$)/);
      return extMatch ? `.${String(extMatch[1]).toLowerCase()}` : '';
    }
  }

  function extensionFromMime(contentType) {
    const type = String(contentType || '').toLowerCase();
    if (type.includes('image/png')) return '.png';
    if (type.includes('image/jpeg')) return '.jpg';
    if (type.includes('image/webp')) return '.webp';
    if (type.includes('image/gif')) return '.gif';
    if (type.includes('image/svg')) return '.svg';
    if (type.includes('video/mp4')) return '.mp4';
    if (type.includes('video/webm')) return '.webm';
    if (type.includes('audio/mpeg')) return '.mp3';
    if (type.includes('audio/wav')) return '.wav';
    if (type.includes('application/pdf')) return '.pdf';
    if (type.includes('application/zip')) return '.zip';
    if (type.includes('application/json')) return '.json';
    if (type.includes('text/plain')) return '.txt';
    return '';
  }

  async function writeTextFileInFolder(dirHandle, fileName, text) {
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(String(text || ''));
    await writable.close();
  }

  async function writeBlobFileInFolder(dirHandle, fileName, blob) {
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  function urlsFromUnknownPayload(value) {
    const strings = extractStringLeaves(value, [], 0, 6, 120);
    const set = new Set();
    for (const item of strings) {
      for (const url of extractUrlsFromText(item)) {
        set.add(url);
      }
    }
    return [...set];
  }

  function getUrlFileBaseName(url, fallbackBase = 'asset') {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split('/').filter(Boolean);
      const raw = parts.length ? decodeURIComponent(parts[parts.length - 1]) : fallbackBase;
      const withoutExt = raw.replace(/\.[a-zA-Z0-9]{1,8}$/, '');
      return sanitizeFilename(withoutExt || fallbackBase, fallbackBase);
    } catch {
      return sanitizeFilename(fallbackBase, fallbackBase);
    }
  }

  function renderChatTranscriptText(chat) {
    const lines = [];
    lines.push(`Title: ${chat?.title || 'Untitled Chat'}`);
    lines.push(`Chat ID: ${chat?.id || ''}`);
    lines.push(`Project ID: ${chat?.projectId || ''}`);
    lines.push(`Project Name: ${getChatProjectName(chat)}`);
    lines.push(`URL: ${chat?.url || ''}`);
    lines.push(`Last Updated: ${formatTimestamp(chat?.updatedAt || '')}`);
    lines.push('');

    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i] || {};
      const role = String(message.role || 'unknown').toUpperCase();
      lines.push(`----- [${i + 1}] ${role} -----`);
      if (message?.timestamp) {
        lines.push(`Time: ${formatTimestamp(message.timestamp)}`);
      }
      lines.push(message.text || '');
      const msgUrls = Array.isArray(message.urls) ? message.urls : [];
      if (msgUrls.length) {
        lines.push('Attached/Referenced URLs:');
        for (const url of msgUrls) {
          lines.push(`- ${url}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  function collectBundleArtifacts(chats, profiles) {
    const sourceUrls = new Set();
    const mediaUrls = new Set();
    const fileUrls = new Set();
    const codeBlocks = [];
    const perChat = [];

    const addProfileText = (text, context = '') => {
      for (const url of extractUrlsFromText(text)) {
        sourceUrls.add(url);
        const kind = classifyUrlKind(url);
        if (kind === 'media') mediaUrls.add(url);
        if (kind === 'file') fileUrls.add(url);
      }
      for (const block of extractCodeBlocksFromText(text)) {
        codeBlocks.push({ lang: block.lang || '', code: block.code, context });
      }
    };

    for (let chatIndex = 0; chatIndex < chats.length; chatIndex++) {
      const chat = chats[chatIndex] || {};
      const chatSources = new Set();
      const chatMedia = new Set();
      const chatFiles = new Set();
      const chatCode = [];

      const messages = Array.isArray(chat?.messages) ? chat.messages : [];
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i] || {};
        const msgUrls = new Set([
          ...extractUrlsFromText(message?.text || ''),
          ...(Array.isArray(message?.urls) ? message.urls : [])
        ]);

        for (const url of msgUrls) {
          chatSources.add(url);
          sourceUrls.add(url);
          const kind = classifyUrlKind(url);
          if (kind === 'media') {
            chatMedia.add(url);
            mediaUrls.add(url);
          }
          if (kind === 'file') {
            chatFiles.add(url);
            fileUrls.add(url);
          }
        }

        for (const block of extractCodeBlocksFromText(message?.text || '')) {
          const entry = { lang: block.lang || '', code: block.code, context: `${chat?.title || 'Untitled Chat'} #${i + 1}` };
          chatCode.push(entry);
          codeBlocks.push(entry);
        }
      }

      perChat.push({
        chatIndex,
        chatId: chat?.id || `chat-${chatIndex + 1}`,
        chatTitle: chat?.title || 'Untitled Chat',
        chat,
        sourceUrls: [...chatSources].sort((a, b) => a.localeCompare(b)),
        mediaUrls: [...chatMedia].sort((a, b) => a.localeCompare(b)),
        fileUrls: [...chatFiles].sort((a, b) => a.localeCompare(b)),
        codeBlocks: chatCode
      });
    }

    for (const profile of profiles) {
      addProfileText(profile?.customInstructions?.aboutUser || '', 'Custom Instructions (about user)');
      addProfileText(profile?.customInstructions?.aboutModel || '', 'Custom Instructions (about model)');
      addProfileText(profile?.aboutYou?.text || '', 'About You');

      const projectInstructions = Array.isArray(profile?.projectInstructions)
        ? profile.projectInstructions
        : [];
      for (const item of projectInstructions) {
        addProfileText(
          item?.instructions || '',
          `Project Instructions (${item?.projectName || item?.projectId || 'project'})`
        );
      }
    }

    return {
      sourceUrls: [...sourceUrls].sort((a, b) => a.localeCompare(b)),
      mediaUrls: [...mediaUrls].sort((a, b) => a.localeCompare(b)),
      fileUrls: [...fileUrls].sort((a, b) => a.localeCompare(b)),
      codeBlocks,
      perChat
    };
  }

  function formatChatHeader(chatEntry) {
    const title = cleanText(chatEntry?.chatTitle || 'Untitled Chat');
    const chatId = cleanText(chatEntry?.chatId || '');
    return chatId ? `${title} (${chatId})` : title;
  }

  function buildBundleUrlReport(artifacts, kind) {
    const keyMap = {
      sources: 'sourceUrls',
      media: 'mediaUrls',
      files: 'fileUrls'
    };
    const titleMap = {
      sources: 'Sources',
      media: 'Media URLs',
      files: 'File URLs'
    };

    const field = keyMap[kind] || 'sourceUrls';
    const title = titleMap[kind] || 'URLs';
    const uniqueUrls = Array.isArray(artifacts?.[field]) ? artifacts[field] : [];
    const perChat = Array.isArray(artifacts?.perChat) ? artifacts.perChat : [];

    const lines = [`# ${title}`, '', '## All Unique URLs', ''];
    if (uniqueUrls.length) {
      for (const url of uniqueUrls) lines.push(`- ${url}`);
    } else {
      lines.push('(No URLs found)');
    }
    lines.push('');
    lines.push(`Total Unique: ${uniqueUrls.length}`);
    lines.push('');
    lines.push('## By Chat');
    lines.push('');

    let chatsWithUrls = 0;
    for (const chatEntry of perChat) {
      const chatUrls = Array.isArray(chatEntry?.[field]) ? chatEntry[field] : [];
      if (!chatUrls.length) continue;
      chatsWithUrls += 1;
      lines.push(`### Chat: ${formatChatHeader(chatEntry)}`);
      for (const url of chatUrls) lines.push(`- ${url}`);
      lines.push('');
    }

    if (!chatsWithUrls) {
      lines.push('(No chat-specific URLs found)');
      lines.push('');
    }

    lines.push(`Chats With ${title}: ${chatsWithUrls}`);
    return lines.join('\n');
  }

  async function fetchAssetBlob(url) {
    let response = null;
    let lastError = null;

    const attempts = [
      () => fetch(url, { credentials: 'include' }),
      () => fetch(url, { credentials: 'omit' })
    ];

    for (const run of attempts) {
      try {
        const res = await run();
        if (!res.ok) {
          lastError = new Error(`HTTP ${res.status}`);
          continue;
        }
        response = res;
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!response) throw lastError || new Error('Download failed');
    const blob = await response.blob();
    return {
      blob,
      contentType: response.headers.get('content-type') || ''
    };
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

  function normalizeMemorySyncStatus(value) {
    const normalized = cleanText(String(value || '')).toLowerCase();
    if (!normalized) return MEMORY_SYNC_STATUS_UNKNOWN;
    if (normalized === MEMORY_SYNC_STATUS_FRESH) return MEMORY_SYNC_STATUS_FRESH;
    if (normalized === MEMORY_SYNC_STATUS_STALE) return MEMORY_SYNC_STATUS_STALE;
    if (normalized === MEMORY_SYNC_STATUS_FAILED) return MEMORY_SYNC_STATUS_FAILED;
    if (normalized === MEMORY_SYNC_STATUS_UNKNOWN) return MEMORY_SYNC_STATUS_UNKNOWN;
    if (normalized.includes('fresh') || normalized.includes('success') || normalized.includes('synced')) {
      return MEMORY_SYNC_STATUS_FRESH;
    }
    if (normalized.includes('stale')) return MEMORY_SYNC_STATUS_STALE;
    if (normalized.includes('fail') || normalized.includes('error')) return MEMORY_SYNC_STATUS_FAILED;
    return MEMORY_SYNC_STATUS_UNKNOWN;
  }

  function formatMemorySyncStatus(status) {
    const normalized = normalizeMemorySyncStatus(status);
    if (normalized === MEMORY_SYNC_STATUS_FRESH) return 'FRESH';
    if (normalized === MEMORY_SYNC_STATUS_STALE) return 'STALE';
    if (normalized === MEMORY_SYNC_STATUS_FAILED) return 'FAILED';
    return 'UNKNOWN';
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
      const profileStepTotal = 6;
      let profileStepDone = 0;
      const profileStep = (label) => {
        if (silent) return;
        profileStepDone++;
        const pct = Math.round((profileStepDone / profileStepTotal) * 100);
        setProgress(pct, label);
      };

      if (!silent) {
        setProgress(0, `Syncing profile for ${activeAccountLabel}...`);
      }

      const existingProfile = await dbGet(profileStorageKey(activeAccountLabel));

      const profile = {
        accountLabel: activeAccountLabel,
        updatedAt: new Date().toISOString(),
        customInstructions: {
          enabled: normalizeOptionalBoolean(existingProfile?.customInstructions?.enabled),
          aboutUser: cleanText(existingProfile?.customInstructions?.aboutUser || ''),
          aboutModel: cleanText(existingProfile?.customInstructions?.aboutModel || ''),
          sourceUrl: cleanText(existingProfile?.customInstructions?.sourceUrl || '')
        },
        aboutYou: {
          text: cleanText(existingProfile?.aboutYou?.text || ''),
          preferredName: cleanText(existingProfile?.aboutYou?.preferredName || ''),
          occupation: cleanText(existingProfile?.aboutYou?.occupation || ''),
          sourceUrl: cleanText(existingProfile?.aboutYou?.sourceUrl || '')
        },
        memories: Array.isArray(existingProfile?.memories) ? existingProfile.memories : [],
        memoriesSourceUrl: cleanText(existingProfile?.memoriesSourceUrl || ''),
        memoriesSyncStatus: normalizeMemorySyncStatus(
          existingProfile?.memoriesSyncStatus ||
          (Array.isArray(existingProfile?.memories) && existingProfile.memories.length
            ? MEMORY_SYNC_STATUS_STALE
            : MEMORY_SYNC_STATUS_UNKNOWN)
        ),
        memoriesLastSuccessfulSyncAt: cleanText(existingProfile?.memoriesLastSuccessfulSyncAt || ''),
        memoriesLastError: cleanText(existingProfile?.memoriesLastError || ''),
        projectInstructions: Array.isArray(existingProfile?.projectInstructions)
          ? normalizeProjectInstructionItems(existingProfile.projectInstructions)
          : [],
        warnings: []
      };

      try {
        profile.customInstructions = await fetchCustomInstructions();
      } catch (err) {
        profile.warnings.push(`Custom instructions fetch failed: ${err?.message || err}`);
      }
      profileStep('Custom instructions checked');

      try {
        profile.aboutYou = await fetchAboutYou();
      } catch (err) {
        profile.warnings.push(`About-you fetch failed: ${err?.message || err}`);
      }
      profileStep('About-you checked');

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
        profile.memoriesSyncStatus = MEMORY_SYNC_STATUS_FRESH;
        profile.memoriesLastSuccessfulSyncAt = new Date().toISOString();
        profile.memoriesLastError = '';
      } catch (err) {
        const errorText = cleanText(err?.message || String(err) || 'Unknown error');
        profile.memoriesSyncStatus = profile.memories.length
          ? MEMORY_SYNC_STATUS_STALE
          : MEMORY_SYNC_STATUS_FAILED;
        profile.memoriesLastError = errorText;
        profile.warnings.push(`Memory fetch failed: ${errorText}`);
      }
      profileStep('Memories checked');

      try {
        const projectResult = await fetchProjectInstructions();
        profile.projectInstructions = projectResult.items;
        if (Array.isArray(projectResult.warnings) && projectResult.warnings.length) {
          profile.warnings.push(...projectResult.warnings);
        }
      } catch (err) {
        profile.warnings.push(`Project instructions fetch failed: ${err?.message || err}`);
      }
      profileStep('Project instructions checked');

      await dbSet(profileStorageKey(activeAccountLabel), profile);
      profileStep('Profile saved');
      await rebuildArchiveFile();
      profileStep('Archive rebuilt');

      if (!silent) {
        setStatus(
          `Profile synced: ${profile.memories.length} memories (${formatMemorySyncStatus(profile.memoriesSyncStatus).toLowerCase()}), custom instructions ` +
          (profile.customInstructions.aboutUser || profile.customInstructions.aboutModel ? 'captured' : 'empty') +
          `, about-you ${profile.aboutYou.text ? 'captured' : 'empty'}, project instructions ${profile.projectInstructions.length}`
        );
        setProgressDone('Profile sync complete');
      }

      return profile;
    })().catch((err) => {
      if (!silent) {
        setProgressFailed('Profile sync failed');
      }
      throw err;
    }).finally(() => {
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

  function parseProjectListItems(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.projects)) return data.projects;
    if (Array.isArray(data?.data?.items)) return data.data.items;
    if (Array.isArray(data?.data?.projects)) return data.data.projects;
    if (Array.isArray(data?.workspaces)) return data.workspaces;
    if (Array.isArray(data?.data?.workspaces)) return data.data.workspaces;
    return [];
  }

  function normalizeProjectInstructionText(value) {
    if (typeof value === 'string') return cleanText(value);
    if (value === null || value === undefined) return '';
    const lines = uniqueNormalizedLines(extractStringLeaves(value, [], 0, 5, 40));
    return lines.join('\n');
  }

  function extractProjectInstructionText(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const root = (payload?.data && typeof payload.data === 'object') ? payload.data : payload;
    const direct = [
      root?.instructions,
      root?.instruction,
      root?.custom_instructions,
      root?.customInstructions,
      root?.system_prompt,
      root?.systemPrompt,
      root?.project_instructions,
      root?.projectInstructions,
      root?.prompt,
      root?.settings?.instructions,
      root?.settings?.custom_instructions,
      root?.settings?.system_prompt
    ];

    for (const candidate of direct) {
      const normalized = normalizeProjectInstructionText(candidate);
      if (normalized) return normalized;
    }

    const deep = findValueByKeysDeep(root, [
      'instructions',
      'instruction',
      'custom_instructions',
      'customInstructions',
      'system_prompt',
      'systemPrompt',
      'project_instructions',
      'projectInstructions',
      'prompt'
    ], 7);

    return normalizeProjectInstructionText(deep);
  }

  function normalizeProjectInstructionItem(item, index = 0) {
    const projectId = pickFirstString([
      item?.projectId,
      item?.project_id,
      item?.id,
      item?.workspace_id,
      item?.workspaceId,
      item?.uuid,
      `project-${index + 1}`
    ]);
    const projectName = pickFirstString([
      item?.projectName,
      item?.project_name,
      item?.name,
      item?.title,
      item?.workspace_name,
      item?.workspaceName
    ]);
    const instructions = normalizeProjectInstructionText(
      item?.instructions ??
      item?.custom_instructions ??
      item?.customInstructions ??
      item?.system_prompt ??
      item?.systemPrompt ??
      extractProjectInstructionText(item)
    );
    const sourceUrl = cleanText(item?.sourceUrl || item?.source_url || '');
    const rawUpdatedAt = pickFirstString([
      item?.updatedAt,
      item?.updated_at,
      item?.update_time,
      item?.created_at,
      item?.create_time
    ]);
    const updatedAt = Number.isFinite(Date.parse(rawUpdatedAt))
      ? new Date(rawUpdatedAt).toISOString()
      : '';

    if (!projectId && !projectName && !instructions) return null;
    return {
      projectId,
      projectName,
      instructions,
      sourceUrl,
      updatedAt
    };
  }

  function normalizeProjectInstructionItems(items) {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < items.length; i++) {
      const normalized = normalizeProjectInstructionItem(items[i], i);
      if (!normalized) continue;
      const key = `${normalized.projectId || ''}|${(normalized.projectName || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
    return out;
  }

  function normalizeProjectMeta(meta, index = 0) {
    return {
      id: pickFirstString([
        meta?.id,
        meta?.project_id,
        meta?.projectId,
        meta?.workspace_id,
        meta?.workspaceId,
        meta?.uuid,
        `project-${index + 1}`
      ]),
      name: pickFirstString([
        meta?.name,
        meta?.title,
        meta?.project_name,
        meta?.projectName,
        meta?.workspace_name,
        meta?.workspaceName
      ]),
      updatedAt: meta?.updated_at || meta?.update_time || meta?.created_at || meta?.create_time || '',
      instructions: extractProjectInstructionText(meta),
      sourceUrl: cleanText(meta?.sourceUrl || '')
    };
  }

  async function fetchProjectList() {
    const base = getConversationApiOrigin();
    const candidates = [
      `${base}/backend-api/projects?offset=0&limit=200`,
      `${base}/backend-api/projects?limit=200`,
      `${base}/backend-api/projects`,
      `${base}/backend-api/project`
    ];
    const { url, data } = await fetchFirstSuccessfulJson(candidates, { authMode: 'auto' });
    return parseProjectListItems(data)
      .map((project, index) => {
        const normalized = normalizeProjectMeta(project, index);
        normalized.sourceUrl = normalized.sourceUrl || url;
        return normalized;
      })
      .filter((project) => project.id || project.name);
  }

  async function fetchProjectDetailById(projectId) {
    const base = getConversationApiOrigin();
    const encoded = encodeURIComponent(projectId);
    const candidates = [
      `${base}/backend-api/projects/${encoded}`,
      `${base}/backend-api/projects/${encoded}?include=all`,
      `${base}/backend-api/project/${encoded}`
    ];
    return fetchFirstSuccessfulJson(candidates, { authMode: 'auto' });
  }

  async function fetchProjectInstructions() {
    const warnings = [];
    const projectList = await fetchProjectList();
    if (!projectList.length) {
      return { items: [], warnings };
    }

    const merged = [];
    for (const project of projectList) {
      const current = {
        projectId: project.id,
        projectName: project.name,
        instructions: project.instructions || '',
        sourceUrl: project.sourceUrl || '',
        updatedAt: project.updatedAt || ''
      };

      if (!current.instructions && current.projectId) {
        try {
          const { url, data } = await fetchProjectDetailById(current.projectId);
          const detailMeta = normalizeProjectMeta(data || {}, 0);
          current.instructions = current.instructions || detailMeta.instructions || '';
          current.projectName = current.projectName || detailMeta.name || '';
          current.updatedAt = current.updatedAt || detailMeta.updatedAt || '';
          current.sourceUrl = url || current.sourceUrl || '';
        } catch (err) {
          warnings.push(
            `Project detail fetch failed for ${current.projectName || current.projectId}: ${err?.message || err}`
          );
        }
      }

      merged.push(current);
    }

    const normalized = normalizeProjectInstructionItems(merged)
      .filter((item) => !!item.instructions);
    return { items: normalized, warnings };
  }

  async function fetchProjectConversationMetaPage(projectId, offset) {
    const base = getConversationApiOrigin();
    const encoded = encodeURIComponent(projectId);
    const candidates = [
      `${base}/backend-api/projects/${encoded}/conversations?offset=${offset}&limit=${FULL_SYNC_PAGE_SIZE}&order=updated`,
      `${base}/backend-api/projects/${encoded}/conversations?offset=${offset}&limit=${FULL_SYNC_PAGE_SIZE}`,
      `${base}/backend-api/project/${encoded}/conversations?offset=${offset}&limit=${FULL_SYNC_PAGE_SIZE}`,
      `${base}/backend-api/projects/${encoded}/chats?offset=${offset}&limit=${FULL_SYNC_PAGE_SIZE}`
    ];

    let lastError = null;
    for (const url of candidates) {
      try {
        const data = await fetchJson(url, { authMode: 'auto' });
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
    throw lastError || new Error(`Could not load project conversations for ${projectId}`);
  }

  async function fetchAllProjectConversationMetas(projectId) {
    const all = [];
    for (let page = 0; page < FULL_SYNC_MAX_PAGES; page++) {
      const offset = page * FULL_SYNC_PAGE_SIZE;
      const { items, total, hasMore } = await fetchProjectConversationMetaPage(projectId, offset);
      if (!items.length) break;
      all.push(...items);
      if (items.length < FULL_SYNC_PAGE_SIZE && !hasMore) break;
      if (total && all.length >= total) break;
    }
    return all;
  }

  async function fetchProjectConversationMetasForAllProjects() {
    const warnings = [];
    let projects = [];
    try {
      projects = await fetchProjectList();
    } catch (err) {
      return {
        metas: [],
        warnings: [`Project list fetch failed: ${err?.message || err}`]
      };
    }

    const metas = [];
    for (const project of projects) {
      if (!project?.id) continue;
      try {
        const projectMetas = await fetchAllProjectConversationMetas(project.id);
        for (const rawMeta of projectMetas) {
          const normalized = normalizeConversationMeta(rawMeta);
          if (!normalized.id) continue;
          normalized.projectId = normalized.projectId || project.id;
          normalized.projectName = normalized.projectName || project.name || '';
          metas.push(normalized);
        }
      } catch (err) {
        warnings.push(
          `Project chat list fetch failed for ${project.name || project.id}: ${err?.message || err}`
        );
      }
    }

    return { metas, warnings };
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
      updatedAt: meta?.update_time || meta?.updated_at || meta?.create_time || meta?.created_at || null,
      url: cleanText(meta?.url || meta?.conversation_url || ''),
      projectId: cleanText(
        meta?.project_id ||
        meta?.projectId ||
        meta?.workspace_id ||
        meta?.workspaceId ||
        meta?.project?.id ||
        ''
      ),
      projectName: cleanText(
        meta?.project_name ||
        meta?.projectName ||
        meta?.workspace_name ||
        meta?.workspaceName ||
        meta?.project?.name ||
        ''
      )
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

  function normalizeTimestampInput(value) {
    if (value === null || value === undefined) return '';

    if (typeof value === 'number' && Number.isFinite(value)) {
      const ms = value > 1e12 ? value : value * 1000;
      const date = new Date(ms);
      return Number.isFinite(date.getTime()) ? date.toISOString() : '';
    }

    const raw = cleanText(String(value || ''));
    if (!raw) return '';

    if (/^\d+(\.\d+)?$/.test(raw)) {
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) {
        const ms = numeric > 1e12 ? numeric : numeric * 1000;
        const date = new Date(ms);
        return Number.isFinite(date.getTime()) ? date.toISOString() : '';
      }
    }

    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return '';
    return new Date(parsed).toISOString();
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
      const timestamp = normalizeTimestampInput(
        message?.create_time ||
        message?.update_time ||
        message?.metadata?.create_time ||
        message?.metadata?.created_at ||
        message?.metadata?.update_time ||
        message?.metadata?.updated_at ||
        message?.metadata?.timestamp ||
        node?.create_time ||
        node?.update_time
      );
      const urlSet = new Set([
        ...extractUrlsFromText(text),
        ...urlsFromUnknownPayload(message?.content),
        ...urlsFromUnknownPayload(message?.metadata)
      ]);
      const urls = [...urlSet].filter((url) => /^https?:\/\//i.test(url));

      if (!text && !urls.length) continue;
      if (role === 'system') continue;

      messages.push({ role, text: text || '[non-text content]', urls, timestamp });
    }

    return messages;
  }

  async function fetchConversationById(chatId, meta = null) {
    const base = getConversationApiOrigin();
    const payload = await fetchJson(`${base}/backend-api/conversation/${chatId}`);
    const title = cleanText(payload?.title || 'Untitled Chat') || 'Untitled Chat';
    const messages = extractConversationMessages(payload);
    const projectId = cleanText(
      payload?.project_id ||
      payload?.projectId ||
      payload?.workspace_id ||
      payload?.workspaceId ||
      payload?.project?.id ||
      meta?.projectId ||
      ''
    );
    let projectName = cleanText(
      payload?.project_name ||
      payload?.projectName ||
      payload?.workspace_name ||
      payload?.workspaceName ||
      payload?.project?.name ||
      meta?.projectName ||
      ''
    );
    if (!projectName) {
      projectName = inferProjectNameFromTitle(title);
    }
    const urlFromMeta = cleanText(meta?.url || '');

    return {
      id: cleanText(payload?.conversation_id || payload?.id || chatId),
      title,
      url: urlFromMeta || `${base}/c/${chatId}`,
      updatedAt: payload?.update_time || payload?.create_time || new Date().toISOString(),
      summaryBullets: buildChatSummaryBullets({ title, messages }),
      messages,
      projectId,
      projectName
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
        setProgress(1, `Syncing all chats for ${activeAccountLabel}...`);
      }

      try {
        await syncAccountProfileForActiveAccount({ silent: true });
      } catch (err) {
        console.warn('Profile sync failed before chat sync:', err);
      }
      if (!silent) setProgress(10, 'Profile sync stage done');

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
      if (!silent) setProgress(16, `Loaded ${metas.length} standard chat metadata records`);

      try {
        const projectMetaResult = await fetchProjectConversationMetasForAllProjects();
        if (projectMetaResult?.metas?.length) {
          metas.push(...projectMetaResult.metas);
        }
        if (Array.isArray(projectMetaResult?.warnings) && projectMetaResult.warnings.length) {
          for (const warning of projectMetaResult.warnings) {
            console.warn('Project chat metadata warning:', warning);
          }
        }
      } catch (err) {
        console.warn('Project chat metadata fetch failed:', err);
      }
      if (!silent) setProgress(22, `Loaded ${metas.length} total chat metadata records`);

      const uniqueMetas = [];
      const byId = new Map();
      for (const meta of metas) {
        if (!meta?.id) continue;
        const existingMeta = byId.get(meta.id);
        if (!existingMeta) {
          byId.set(meta.id, { ...meta });
          continue;
        }

        if (!existingMeta.title && meta.title) existingMeta.title = meta.title;
        if (!existingMeta.url && meta.url) existingMeta.url = meta.url;
        if (!existingMeta.projectId && meta.projectId) existingMeta.projectId = meta.projectId;
        if (!existingMeta.projectName && meta.projectName) existingMeta.projectName = meta.projectName;

        const existingTs = Date.parse(existingMeta.updatedAt || 0);
        const incomingTs = Date.parse(meta.updatedAt || 0);
        if (Number.isFinite(incomingTs) && incomingTs > existingTs) {
          existingMeta.updatedAt = meta.updatedAt;
        }
      }
      uniqueMetas.push(...byId.values());

      const metasToFetch = [];
      for (const meta of uniqueMetas) {
        const existing = existingById.get(meta.id);
        const existingUpdatedAt = Date.parse(existing?.updatedAt || 0);
        const listedUpdatedAt = Date.parse(meta.updatedAt || 0);
        const hasNewProjectLink =
          (!existing?.projectId && !!meta?.projectId) ||
          (!existing?.projectName && !!meta?.projectName);
        const shouldSkip =
          existing &&
          !hasNewProjectLink &&
          (!Number.isFinite(listedUpdatedAt) || listedUpdatedAt <= existingUpdatedAt) &&
          (existing.messages?.length || 0) > 0;

        if (shouldSkip) continue;
        metasToFetch.push(meta);
      }

      let savedCount = 0;
      let processedCount = 0;
      let cursor = 0;
      const workerCount = Math.max(1, Math.min(FULL_SYNC_CONCURRENCY, metasToFetch.length || 1));

      if (!silent && metasToFetch.length === 0) {
        setProgress(90, 'No out-of-date chats to fetch');
      }

      const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = cursor++;
          if (index >= metasToFetch.length) break;

          const meta = metasToFetch[index];
          try {
            const chat = await fetchConversationById(meta.id, meta);
            chat.accountLabel = activeAccountLabel;
            if (!chat.title && meta.title) chat.title = meta.title;
            if (!Number.isFinite(Date.parse(chat.updatedAt || 0)) && meta.updatedAt) {
              chat.updatedAt = meta.updatedAt;
            }
            if (!chat.projectId && meta.projectId) chat.projectId = meta.projectId;
            if (!chat.projectName && meta.projectName) chat.projectName = meta.projectName;

            await dbSet(chatStorageKey(activeAccountLabel, chat.id), chat);
            existingById.set(chat.id, chat);
            savedCount++;
          } catch (err) {
            console.warn('Chat sync failed for', meta.id, err);
          } finally {
            processedCount++;
            if (!silent) {
              const progressPct = metasToFetch.length
                ? Math.round(22 + ((processedCount / metasToFetch.length) * 68))
                : 90;
              setProgress(progressPct, `Chat sync progress ${processedCount}/${metasToFetch.length}`);
            }
            if (!silent && (processedCount % 10 === 0 || processedCount === metasToFetch.length)) {
              setStatus(`Synced ${processedCount}/${metasToFetch.length} chats...`);
            }
          }
        }
      });

      await Promise.all(workers);

      if (!silent) setProgress(96, 'Rebuilding archive file...');
      await rebuildArchiveFile();
      const projectLinkedCount = [...existingById.values()]
        .filter((chat) => isProjectLinkedChat(chat))
        .length;
      if (!silent || savedCount > 0) {
        setStatus(
          `All-chat sync finished: ${savedCount} updated (${metasToFetch.length} checked, ${projectLinkedCount} project chats tracked)`
        );
      }
      if (!silent) {
        setProgressDone(`Sync complete: ${savedCount} updated`);
      }
      return savedCount;
    })().catch((err) => {
      if (!silent) {
        setProgressFailed('All-chat sync failed');
      }
      throw err;
    }).finally(() => {
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
    const getField = (prefix) => {
      for (const line of lines) {
        if (line.startsWith(prefix)) return cleanText(parseArchiveField(line, prefix));
      }
      return '';
    };

    const title = getField('Title: ');
    const chatId = getField('Chat ID: ');
    const projectId = getField('Project ID: ');
    const projectName = getField('Project Name: ');
    const url = getField('URL: ');
    const updatedAtRaw = getField('Last Updated: ');

    if (!chatId) return null;

    const parsedUpdatedAt = Date.parse(updatedAtRaw);
    const updatedAt = Number.isFinite(parsedUpdatedAt)
      ? new Date(parsedUpdatedAt).toISOString()
      : new Date().toISOString();

    let i = 0;
    while (i < lines.length && lines[i] !== '') i++;
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
      let timestamp = '';
      if ((lines[i] || '').startsWith('Time: ')) {
        timestamp = normalizeTimestampInput(parseArchiveField(lines[i], 'Time: '));
        i++;
      }

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
        messages.push({ role, text, timestamp });
      }
    }

    return {
      accountLabel,
      id: chatId,
      title: title || 'Untitled Chat',
      url,
      updatedAt,
      summaryBullets,
      messages,
      projectId,
      projectName
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
    const memoriesSyncStatus = normalizeMemorySyncStatus(getField('Memories Sync Status: '));
    const memoriesLastSuccessfulSyncRaw = getField('Memories Last Successful Sync: ');
    const memoriesLastError = getField('Memories Last Error: ');

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

    const projectInstructionsRaw = extractMarkedBlock(
      normalized,
      '<<PROJECT_INSTRUCTIONS_JSON>>\n',
      '\n<<END_PROJECT_INSTRUCTIONS_JSON>>'
    );
    let projectInstructions = [];
    if (projectInstructionsRaw) {
      try {
        const parsedProjectInstructions = JSON.parse(projectInstructionsRaw);
        if (Array.isArray(parsedProjectInstructions)) {
          projectInstructions = normalizeProjectInstructionItems(parsedProjectInstructions);
        }
      } catch (err) {
        // Ignore malformed legacy blocks.
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
      memoriesSyncStatus: memories.length && memoriesSyncStatus === MEMORY_SYNC_STATUS_UNKNOWN
        ? MEMORY_SYNC_STATUS_STALE
        : memoriesSyncStatus,
      memoriesLastSuccessfulSyncAt: Number.isFinite(Date.parse(memoriesLastSuccessfulSyncRaw))
        ? new Date(memoriesLastSuccessfulSyncRaw).toISOString()
        : '',
      memoriesLastError,
      memoriesSourceUrl,
      projectInstructions,
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
            (!existing?.aboutYou?.text && !!profile?.aboutYou?.text) ||
            ((existing?.projectInstructions?.length || 0) === 0 && (profile?.projectInstructions?.length || 0) > 0);

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

  function getDefaultExportSettings() {
    return {
      includeSources: true,
      includeMedia: true,
      includeCode: true,
      includeFiles: true,
      autoDownloadAssets: true
    };
  }

  function normalizeExportSettings(settings) {
    const defaults = getDefaultExportSettings();
    const input = settings && typeof settings === 'object' ? settings : {};
    return {
      includeSources: input.includeSources !== undefined ? !!input.includeSources : defaults.includeSources,
      includeMedia: input.includeMedia !== undefined ? !!input.includeMedia : defaults.includeMedia,
      includeCode: input.includeCode !== undefined ? !!input.includeCode : defaults.includeCode,
      includeFiles: input.includeFiles !== undefined ? !!input.includeFiles : defaults.includeFiles,
      autoDownloadAssets: input.autoDownloadAssets !== undefined ? !!input.autoDownloadAssets : defaults.autoDownloadAssets
    };
  }

  function getExportSettings() {
    try {
      const raw = localStorage.getItem(EXPORT_SETTINGS_KEY);
      if (!raw) return getDefaultExportSettings();
      return normalizeExportSettings(JSON.parse(raw));
    } catch {
      return getDefaultExportSettings();
    }
  }

  function saveExportSettings(settings) {
    try {
      localStorage.setItem(EXPORT_SETTINGS_KEY, JSON.stringify(normalizeExportSettings(settings)));
    } catch {
      // Ignore localStorage failures and continue with defaults.
    }
  }

  function parseVersionParts(version) {
    return String(version || '')
      .split(/[^0-9]+/g)
      .filter(Boolean)
      .map((part) => Number(part) || 0);
  }

  function compareVersions(a, b) {
    const pa = parseVersionParts(a);
    const pb = parseVersionParts(b);
    const maxLen = Math.max(pa.length, pb.length);
    for (let i = 0; i < maxLen; i++) {
      const va = pa[i] || 0;
      const vb = pb[i] || 0;
      if (va > vb) return 1;
      if (va < vb) return -1;
    }
    return 0;
  }

  function extractUserscriptVersion(scriptText) {
    const match = String(scriptText || '').match(/@version\s+([^\s]+)/i);
    return cleanText(match?.[1] || '');
  }

  function shouldRunUpdateCheck() {
    try {
      const last = Number(localStorage.getItem(UPDATE_LAST_CHECK_KEY) || 0);
      return !last || (Date.now() - last) > UPDATE_CHECK_INTERVAL_MS;
    } catch {
      return true;
    }
  }

  function markUpdateCheckRan() {
    try {
      localStorage.setItem(UPDATE_LAST_CHECK_KEY, String(Date.now()));
    } catch {
      // Ignore localStorage failures and continue.
    }
  }

  async function fetchLatestScriptVersion() {
    for (const url of UPDATE_CHECK_CANDIDATES) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) continue;
        const text = await res.text();
        const version = extractUserscriptVersion(text);
        if (version) {
          return { version, sourceUrl: url };
        }
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }

  async function maybePromptForScriptUpdate() {
    if (!shouldRunUpdateCheck()) return;
    markUpdateCheckRan();

    const latest = await fetchLatestScriptVersion();
    if (!latest?.version) return;
    if (compareVersions(latest.version, SCRIPT_VERSION) <= 0) return;

    let dismissedVersion = '';
    try {
      dismissedVersion = cleanText(localStorage.getItem(UPDATE_DISMISSED_VERSION_KEY) || '');
    } catch {
      dismissedVersion = '';
    }
    if (dismissedVersion && dismissedVersion === latest.version) return;

    const shouldOpenUpdate = confirm(
      `Update available: v${latest.version} (current v${SCRIPT_VERSION}).\n\n` +
      'Open the update page now?\n\n' +
      'Your local archive data is safe: updating the script does not delete your saved chats, profiles, or archive files.'
    );

    if (shouldOpenUpdate) {
      try {
        localStorage.removeItem(UPDATE_DISMISSED_VERSION_KEY);
      } catch {
        // Ignore localStorage failures and continue.
      }
      window.open(UPDATE_INSTALL_URL, '_blank', 'noopener');
      setStatus(`Update available: v${latest.version}. Install page opened.`);
      return;
    }

    try {
      localStorage.setItem(UPDATE_DISMISSED_VERSION_KEY, latest.version);
    } catch {
      // Ignore localStorage failures and continue.
    }
    setStatus(`Update available: v${latest.version} (dismissed for now).`);
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

  function getCurrentProjectContextFromPath() {
    const path = location.pathname || '';
    const patterns = [
      /\/projects\/([a-zA-Z0-9-]+)/i,
      /\/project\/([a-zA-Z0-9-]+)/i,
      /\/g\/p\/([a-zA-Z0-9-]+)/i
    ];
    for (const pattern of patterns) {
      const match = path.match(pattern);
      if (match && match[1]) {
        return {
          projectId: cleanText(match[1]),
          projectName: ''
        };
      }
    }
    return { projectId: '', projectName: '' };
  }

  function getCurrentChatTitle() {
    const h1 = document.querySelector('h1');
    if (h1 && cleanText(h1.innerText)) return cleanText(h1.innerText);

    const title = cleanText(document.title).replace(/\s*-\s*ChatGPT.*$/i, '');
    return title || 'Untitled Chat';
  }

  function inferProjectNameFromTitle(title) {
    const value = cleanText(title || '');
    if (!value) return '';
    const match = value.match(/^chatgpt\s*[-:|]\s*(.+)$/i);
    return match ? cleanText(match[1]) : '';
  }

  function getChatProjectName(chat) {
    return cleanText(chat?.projectName || '') || inferProjectNameFromTitle(chat?.title || '');
  }

  function isProjectLinkedChat(chat) {
    return !!(
      cleanText(chat?.projectId || '') ||
      getChatProjectName(chat)
    );
  }

  function getMessageNodes() {
    return [...document.querySelectorAll('[data-message-author-role]')];
  }

  function getCurrentMessages() {
    return getMessageNodes()
      .map((node) => {
        const role = node.getAttribute('data-message-author-role') || 'unknown';
        const text = cleanText(node.innerText);
        const urlSet = new Set([
          ...extractUrlsFromText(text),
          ...[...node.querySelectorAll('a[href]')].map((el) => cleanText(el.getAttribute('href') || el.href || '')),
          ...[...node.querySelectorAll('img[src]')].map((el) => cleanText(el.getAttribute('src') || '')),
          ...[...node.querySelectorAll('source[src]')].map((el) => cleanText(el.getAttribute('src') || ''))
        ]);
        const urls = [...urlSet].filter((url) => /^https?:\/\//i.test(url));
        return {
          role,
          text: text || (urls.length ? '[non-text content]' : ''),
          urls
        };
      })
      .filter((m) => m.text || (Array.isArray(m.urls) && m.urls.length));
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
      messages,
      ...getCurrentProjectContextFromPath()
    };
    if (!chat.projectName) {
      chat.projectName = getChatProjectName(chat);
    }

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
    const projectInstructions = normalizeProjectInstructionItems(
      Array.isArray(profile?.projectInstructions) ? profile.projectInstructions : []
    );

    lines.push('################################################################');
    lines.push('PROFILE');
    lines.push('################################################################');
    lines.push('Profile Last Synced: ' + formatTimestamp(profile?.updatedAt || ''));
    lines.push('Custom Instructions Enabled: ' + formatOptionalBoolean(customInstructions?.enabled));
    lines.push('Custom Instructions Source: ' + (customInstructions?.sourceUrl || ''));
    lines.push('About You Source: ' + (aboutYou?.sourceUrl || ''));
    lines.push('Memories Source: ' + (profile?.memoriesSourceUrl || ''));
    lines.push('Memories Sync Status: ' + formatMemorySyncStatus(
      profile?.memoriesSyncStatus ||
      (memories.length ? MEMORY_SYNC_STATUS_STALE : MEMORY_SYNC_STATUS_UNKNOWN)
    ));
    lines.push('Memories Last Successful Sync: ' + (profile?.memoriesLastSuccessfulSyncAt || ''));
    lines.push('Memories Last Error: ' + (profile?.memoriesLastError || ''));
    lines.push('Project Instructions Count: ' + projectInstructions.length);
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
    lines.push('<<PROJECT_INSTRUCTIONS_JSON>>');
    lines.push(JSON.stringify(projectInstructions, null, 2));
    lines.push('<<END_PROJECT_INSTRUCTIONS_JSON>>');

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
    lines.push('Project ID: ' + (chat.projectId || ''));
    lines.push('Project Name: ' + getChatProjectName(chat));
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
      if (m?.timestamp) {
        lines.push('Time: ' + formatTimestamp(m.timestamp));
      }
      lines.push(m.text || '');
      if (Array.isArray(m.urls) && m.urls.length) {
        lines.push('');
        lines.push('Referenced URLs:');
        for (const url of m.urls) {
          lines.push('- ' + url);
        }
      }
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
      const trackedProjectChats = accountChats.filter((chat) => isProjectLinkedChat(chat));
      out.push('Tracked project chats: ' + trackedProjectChats.length);
      if (trackedProjectChats.length) {
        out.push('Tracked project chat list:');
        for (const chat of trackedProjectChats) {
          const projectName = getChatProjectName(chat);
          const projectId = cleanText(chat?.projectId || '');
          let projectLabel = projectName || '(unknown project)';
          if (projectId) {
            projectLabel += ` [${projectId}]`;
          }
          out.push(`- ${(chat?.title || 'Untitled Chat')} | Chat ID: ${chat?.id || ''} | Project: ${projectLabel}`);
        }
      }
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

  async function exportArchiveBundleToFolder() {
    const folderHandle = await getSavedBundleFolderHandle();
    if (!folderHandle) {
      setStatus('Choose bundle folder first');
      return;
    }

    const hasPermission = await ensureWritePermission(folderHandle);
    if (!hasPermission) {
      setStatus('Bundle folder permission denied');
      return;
    }

    await maybeImportArchiveFromFile();
    setProgress(0, 'Preparing bundle export...', { indeterminate: true });

    try {
      const exportSettings = getExportSettings();
      const includeSources = !!exportSettings.includeSources;
      const includeMedia = !!exportSettings.includeMedia;
      const includeCode = !!exportSettings.includeCode;
      const includeFiles = !!exportSettings.includeFiles;
      const autoDownloadAssets = !!exportSettings.autoDownloadAssets;

      const chats = await dbGetAllChats();
      const profiles = await dbGetAllProfiles();
      const archiveText = await renderFullArchive();

      const mediaDir = includeMedia ? await folderHandle.getDirectoryHandle('media', { create: true }) : null;
      const sourcesDir = includeSources ? await folderHandle.getDirectoryHandle('sources', { create: true }) : null;
      const codeDir = includeCode ? await folderHandle.getDirectoryHandle('code', { create: true }) : null;
      const filesDir = includeFiles ? await folderHandle.getDirectoryHandle('files', { create: true }) : null;

      setProgress(14, 'Writing archive.txt...');
      await writeTextFileInFolder(folderHandle, 'archive.txt', archiveText);

      setProgress(26, 'Collecting sources/media/code...');
      const artifacts = await collectBundleArtifacts(chats, profiles);
      const chatsDir = await folderHandle.getDirectoryHandle('chats', { create: true });

      if (includeSources && sourcesDir) {
        await writeTextFileInFolder(sourcesDir, 'sources.txt', buildBundleUrlReport(artifacts, 'sources'));
      }

      if (includeMedia && mediaDir) {
        await writeTextFileInFolder(mediaDir, 'media-index.txt', buildBundleUrlReport(artifacts, 'media'));
      }

      if (includeFiles && filesDir) {
        await writeTextFileInFolder(filesDir, 'files-index.txt', buildBundleUrlReport(artifacts, 'files'));
      }

      if (includeCode && codeDir) {
        const codeLines = ['# Code Blocks', ''];
        for (let i = 0; i < artifacts.codeBlocks.length; i++) {
          const block = artifacts.codeBlocks[i];
          codeLines.push(`## Snippet ${i + 1}`);
          codeLines.push(`Context: ${block.context || 'Unknown'}`);
          codeLines.push('');
          codeLines.push(`\`\`\`${block.lang || ''}`);
          codeLines.push(block.code);
          codeLines.push('```');
          codeLines.push('');
        }
        if (!artifacts.codeBlocks.length) {
          codeLines.push('(No code blocks found)');
        }
        await writeTextFileInFolder(codeDir, 'code-snippets.md', codeLines.join('\n'));
      }

      const downloadManifest = [];
      const totalChatAssets = autoDownloadAssets
        ? artifacts.perChat.reduce(
          (sum, chatEntry) => sum +
            (includeMedia ? chatEntry.mediaUrls.length : 0) +
            (includeFiles ? chatEntry.fileUrls.length : 0),
          0
        )
        : 0;
      let downloadedAssets = 0;

      for (let chatIndex = 0; chatIndex < artifacts.perChat.length; chatIndex++) {
        const chatEntry = artifacts.perChat[chatIndex];
        const folderStem = sanitizeFilename(
          `${String(chatIndex + 1).padStart(4, '0')}-${chatEntry.chatTitle || 'chat'}-${String(chatEntry.chatId || '').slice(0, 8)}`,
          `chat-${chatIndex + 1}`
        ).slice(0, 96);
        const chatDir = await chatsDir.getDirectoryHandle(folderStem, { create: true });
        const chatMediaDir = includeMedia ? await chatDir.getDirectoryHandle('media', { create: true }) : null;
        const chatFilesDir = includeFiles ? await chatDir.getDirectoryHandle('files', { create: true }) : null;

        setProgress(34, `Writing chat bundle ${chatIndex + 1}/${artifacts.perChat.length}`);
        await writeTextFileInFolder(chatDir, 'transcript.txt', renderChatTranscriptText(chatEntry.chat));

        if (includeSources) {
          const chatSourcesLines = [
            '# Chat Sources',
            `Chat: ${chatEntry.chatTitle || 'Untitled Chat'}`,
            `Chat ID: ${chatEntry.chatId || ''}`,
            '',
            ...chatEntry.sourceUrls.map((url) => `- ${url}`),
            '',
            `Total: ${chatEntry.sourceUrls.length}`
          ];
          await writeTextFileInFolder(chatDir, 'sources.txt', chatSourcesLines.join('\n'));
        }

        if (includeMedia) {
          const chatMediaLines = [
            '# Chat Media URLs',
            `Chat: ${chatEntry.chatTitle || 'Untitled Chat'}`,
            `Chat ID: ${chatEntry.chatId || ''}`,
            '',
            ...chatEntry.mediaUrls.map((url) => `- ${url}`),
            '',
            `Total: ${chatEntry.mediaUrls.length}`
          ];
          await writeTextFileInFolder(chatDir, 'media-urls.txt', chatMediaLines.join('\n'));
        }

        if (includeFiles) {
          const chatFileLines = [
            '# Chat File URLs',
            `Chat: ${chatEntry.chatTitle || 'Untitled Chat'}`,
            `Chat ID: ${chatEntry.chatId || ''}`,
            '',
            ...chatEntry.fileUrls.map((url) => `- ${url}`),
            '',
            `Total: ${chatEntry.fileUrls.length}`
          ];
          await writeTextFileInFolder(chatDir, 'file-urls.txt', chatFileLines.join('\n'));
        }

        if (includeCode) {
          const chatCodeLines = ['# Chat Code Blocks', ''];
          for (let i = 0; i < chatEntry.codeBlocks.length; i++) {
            const block = chatEntry.codeBlocks[i];
            chatCodeLines.push(`## Snippet ${i + 1}`);
            chatCodeLines.push(`Context: ${block.context || 'Unknown'}`);
            chatCodeLines.push('');
            chatCodeLines.push(`\`\`\`${block.lang || ''}`);
            chatCodeLines.push(block.code);
            chatCodeLines.push('```');
            chatCodeLines.push('');
          }
          if (!chatEntry.codeBlocks.length) {
            chatCodeLines.push('(No code blocks found)');
          }
          await writeTextFileInFolder(chatDir, 'code-snippets.md', chatCodeLines.join('\n'));
        }

        const perChatManifest = [];
        const chatTargets = autoDownloadAssets
          ? [
            ...(includeMedia ? chatEntry.mediaUrls.map((url) => ({ kind: 'media', url })) : []),
            ...(includeFiles ? chatEntry.fileUrls.map((url) => ({ kind: 'files', url })) : [])
          ]
          : [];

        if (!autoDownloadAssets) {
          const manifestRow = {
            chatId: chatEntry.chatId,
            chatFolder: folderStem,
            kind: 'meta',
            status: 'skipped',
            note: 'Asset download skipped by export settings'
          };
          perChatManifest.push(manifestRow);
          downloadManifest.push(manifestRow);
        }

        for (let i = 0; i < chatTargets.length; i++) {
          const target = chatTargets[i];
          downloadedAssets++;
          const pct = totalChatAssets
            ? 40 + Math.round((downloadedAssets / totalChatAssets) * 56)
            : 96;
          setProgress(pct, `Downloading chat assets ${downloadedAssets}/${Math.max(1, totalChatAssets)}`);

          const targetDir = target.kind === 'media' ? chatMediaDir : chatFilesDir;
          if (!targetDir) continue;
          const baseName = getUrlFileBaseName(target.url, `${target.kind}-${i + 1}`);
          try {
            const fetched = await fetchAssetBlob(target.url);
            const ext = extensionFromUrl(target.url) || extensionFromMime(fetched.contentType) || '.bin';
            const fileName = sanitizeFilename(
              `${String(i + 1).padStart(3, '0')}-${baseName}${ext}`,
              `${target.kind}-${i + 1}${ext}`
            );
            await writeBlobFileInFolder(targetDir, fileName, fetched.blob);
            const manifestRow = {
              chatId: chatEntry.chatId,
              chatFolder: folderStem,
              url: target.url,
              kind: target.kind,
              status: 'saved',
              fileName
            };
            perChatManifest.push(manifestRow);
            downloadManifest.push(manifestRow);
          } catch (err) {
            const manifestRow = {
              chatId: chatEntry.chatId,
              chatFolder: folderStem,
              url: target.url,
              kind: target.kind,
              status: 'failed',
              error: cleanText(err?.message || String(err))
            };
            perChatManifest.push(manifestRow);
            downloadManifest.push(manifestRow);
          }
        }

        await writeTextFileInFolder(chatDir, 'download-manifest.json', JSON.stringify({
          chatId: chatEntry.chatId,
          chatTitle: chatEntry.chatTitle,
          totalTargets: chatTargets.length,
          downloads: perChatManifest
        }, null, 2));
      }

      if (!autoDownloadAssets) {
        downloadManifest.push({
          kind: 'meta',
          status: 'skipped',
          note: 'Global asset download skipped by export settings'
        });
      }

      if (!totalChatAssets) {
        setProgress(96, 'Finalizing bundle manifest...');
      }

      await writeTextFileInFolder(folderHandle, 'bundle-manifest.json', JSON.stringify({
        exportedAt: new Date().toISOString(),
        chats: chats.length,
        profiles: profiles.length,
        sources: artifacts.sourceUrls.length,
        mediaUrls: artifacts.mediaUrls.length,
        fileUrls: artifacts.fileUrls.length,
        codeBlocks: artifacts.codeBlocks.length,
        perChatBundles: artifacts.perChat.length,
        settings: {
          includeSources,
          includeMedia,
          includeCode,
          includeFiles,
          autoDownloadAssets
        },
        downloads: downloadManifest
      }, null, 2));

      setStatus('Bundle export complete: settings applied for sources/media/code/files');
      setProgressDone('Bundle export complete');
    } catch (err) {
      setProgressFailed('Bundle export failed');
      setStatus(`Bundle export failed: ${err?.message || err}`);
    }
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

  function getComposerInput() {
    return document.querySelector('#prompt-textarea')
      || document.querySelector('textarea[data-id="root"]')
      || document.querySelector('main textarea')
      || null;
  }

  function getSendButton() {
    return document.querySelector('button[data-testid="send-button"]')
      || document.querySelector('button[data-testid="fruitjuice-send-button"]')
      || document.querySelector('button[aria-label="Send prompt"]')
      || document.querySelector('button[aria-label^="Send"]')
      || document.querySelector('button[aria-label*="Send"]')
      || document.querySelector('button[aria-label*="send"]')
      || document.querySelector('form button[type="submit"]')
      || null;
  }

  function readComposerInputValue(inputEl) {
    if (!inputEl) return '';
    if (typeof inputEl.value === 'string') return inputEl.value;
    return inputEl.innerText || inputEl.textContent || '';
  }

  function clearContentEditable(el) {
    if (!el) return;
    try {
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      if (document.execCommand) {
        document.execCommand('delete', false);
      }
      selection.removeAllRanges();
    } catch {
      // Fallback below.
    }
    el.textContent = '';
  }

  function setComposerInputValue(inputEl, value) {
    const text = String(value || '');
    const isTextAreaLike = typeof inputEl.value === 'string';

    if (isTextAreaLike) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inputEl), 'value');
      if (descriptor?.set) {
        descriptor.set.call(inputEl, text);
      } else {
        inputEl.value = text;
      }
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    clearContentEditable(inputEl);
    inputEl.focus();
    if (document.execCommand) {
      try {
        document.execCommand('insertText', false, text);
      } catch {
        // Fallback below.
      }
    }
    if (!cleanText(readComposerInputValue(inputEl))) {
      inputEl.textContent = text;
    }
    try {
      inputEl.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text
      }));
    } catch {
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
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
      const inputEl = getComposerInput();
      if (!inputEl || inputEl.disabled) return null;

      const button = getSendButton();
      if (button) {
        const label = `${button.getAttribute('aria-label') || ''} ${button.innerText || ''}`.toLowerCase();
        if (button.disabled) return null;
        if (label.includes('stop')) return null;
      }

      return inputEl;
    }, timeoutMs, 250);
  }

  async function sendComposerMessage(text) {
    const inputEl = await waitForComposerAvailability();
    inputEl.focus();
    setComposerInputValue(inputEl, text);
    await sleep(120);
    await waitFor(() => {
      const button = getSendButton();
      if (!button || button.disabled) return false;
      const label = `${button.getAttribute('aria-label') || ''} ${button.innerText || ''}`.toLowerCase();
      return !label.includes('stop');
    }, 8000, 120).catch(() => true);

    let sent = false;
    const sendButton = getSendButton();
    if (sendButton && !sendButton.disabled) {
      sendButton.click();
      sent = true;
    }

    if (!sent) {
      inputEl.dispatchEvent(new KeyboardEvent('keydown', {
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
      const el = getComposerInput();
      return el && !cleanText(readComposerInputValue(el));
    }, 15000, 200).catch(() => true);
  }

  function renderImportedChat(chat, index) {
    const lines = [];
    lines.push(`===== IMPORTED CHAT ${index + 1} =====`);
    lines.push(`Title: ${chat?.title || 'Untitled Chat'}`);
    lines.push(`Chat ID: ${chat?.id || ''}`);
    lines.push(`Project ID: ${chat?.projectId || ''}`);
    lines.push(`Project Name: ${getChatProjectName(chat)}`);
    lines.push(`URL: ${chat?.url || ''}`);
    lines.push(`Last Updated: ${formatTimestamp(chat?.updatedAt || '')}`);
    lines.push('');

    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    for (const message of messages) {
      lines.push(`[${String(message?.role || 'unknown').toUpperCase()}]`);
      if (message?.timestamp) {
        lines.push(`Time: ${formatTimestamp(message.timestamp)}`);
      }
      lines.push(message?.text || '');
      if (Array.isArray(message?.urls) && message.urls.length) {
        lines.push('');
        lines.push('Referenced URLs:');
        for (const url of message.urls) {
          lines.push(`- ${url}`);
        }
      }
      lines.push('');
    }

    lines.push('----- POST-IMPORT INSTRUCTIONS -----');
    lines.push('1) Summarize the imported chat above in 5 concise bullets.');
    lines.push('2) Then continue the conversation naturally from the last user turn.');
    lines.push('3) Do not mention that this was an import; just continue as normal.');
    lines.push('-----------------------------------');
    lines.push('');

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

  function splitTextIntoChunks(text, maxChars = 12000) {
    const normalized = String(text || '');
    if (!normalized) return [];
    if (normalized.length <= maxChars) return [normalized];

    const lines = normalized.split('\n');
    const chunks = [];
    let current = '';

    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length <= maxChars) {
        current = candidate;
        continue;
      }

      if (current) {
        chunks.push(current);
      }

      if (line.length <= maxChars) {
        current = line;
        continue;
      }

      for (let i = 0; i < line.length; i += maxChars) {
        const piece = line.slice(i, i + maxChars);
        if (piece) chunks.push(piece);
      }
      current = '';
    }

    if (current) chunks.push(current);
    return chunks.filter((chunk) => cleanText(chunk));
  }

  function buildSingleChatImportChunks(chat, sourceLabel, chatIndex, totalChats, maxChars = 12000) {
    const header = [
      `Imported chat ${chatIndex + 1} of ${totalChats} from account label: ${sourceLabel}`,
      `Imported on: ${new Date().toLocaleString()}`,
      '',
      'This thread contains one restored archived chat.',
      ''
    ].join('\n');
    const body = renderImportedChat(chat, chatIndex);
    const fullText = `${header}\n${body}\n`;
    return splitTextIntoChunks(fullText, maxChars);
  }

  function getNewChatButton() {
    return document.querySelector('button[data-testid="new-chat-button"]')
      || document.querySelector('a[data-testid="new-chat-button"]')
      || document.querySelector('button[aria-label*="New chat"]')
      || document.querySelector('a[aria-label*="New chat"]')
      || document.querySelector('a[href="/"]')
      || document.querySelector('button[aria-label*="new chat"]')
      || document.querySelector('a[aria-label*="new chat"]')
      || null;
  }

  async function openNewChatThreadForImport() {
    const beforePath = location.pathname;
    const btn = getNewChatButton();
    if (btn) {
      btn.click();
    } else {
      location.assign('/');
    }

    await sleep(300);
    await waitFor(() => {
      const inputEl = getComposerInput();
      if (!inputEl || inputEl.disabled) return null;
      if (location.pathname !== beforePath) return inputEl;
      if (location.pathname === '/') return inputEl;
      return inputEl;
    }, 60000, 250);
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

  function buildMemoryImportPayloads(memoryText) {
    return [
      { text: memoryText },
      { memory: memoryText },
      { content: memoryText },
      { message: memoryText },
      { memory_text: memoryText },
      { data: { text: memoryText } }
    ];
  }

  async function applySingleMemoryToCurrentAccount(memoryText) {
    const normalized = squeezeWhitespace(memoryText || '');
    if (!normalized) return { endpoint: '', method: '', skipped: true };

    const base = getConversationApiOrigin();
    const endpoints = [
      `${base}/backend-api/memories`,
      `${base}/backend-api/memory`,
      `${base}/backend-api/memories/add`
    ];
    const methods = ['POST', 'PUT', 'PATCH'];
    const payloads = buildMemoryImportPayloads(normalized);
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
            return { endpoint, method, skipped: false };
          } catch (err) {
            errors.push(`${method} ${endpoint} => ${err?.message || err}`);
          }
        }
      }
    }

    throw new Error(errors.slice(-12).join(' || ') || 'Could not import memory');
  }

  async function importMemoriesToCurrentAccount(memories) {
    const sourceMemories = dedupeMemories(
      asArray(memories)
        .map((memory, index) => normalizeMemoryItem(memory, index))
        .filter(Boolean)
    );
    if (!sourceMemories.length) {
      return { imported: 0, skipped: 0, failed: 0, errors: [] };
    }

    let existing = [];
    try {
      const fetched = await fetchMemories();
      existing = asArray(fetched?.items);
    } catch {
      existing = [];
    }

    const existingSet = new Set(
      existing
        .map((entry) => squeezeWhitespace(entry?.text || '').toLowerCase())
        .filter(Boolean)
    );

    const toImport = sourceMemories.filter((entry) => !existingSet.has((entry.text || '').toLowerCase()));
    if (!toImport.length) {
      return { imported: 0, skipped: sourceMemories.length, failed: 0, errors: [] };
    }

    let imported = 0;
    let failed = 0;
    const errors = [];

    for (const memory of toImport) {
      try {
        await applySingleMemoryToCurrentAccount(memory.text);
        imported++;
      } catch (err) {
        failed++;
        errors.push(cleanText(err?.message || String(err)));
      }
      await sleep(260);
    }

    return {
      imported,
      skipped: sourceMemories.length - toImport.length,
      failed,
      errors
    };
  }

  async function importWizardImportMemories() {
    if (importInProgress) return;
    const selected = getImportSelection();
    const memoryItems = asArray(selected?.profile?.memories);
    if (!memoryItems.length) {
      throw new Error('No memories found for selected account');
    }

    const proceed = confirm(
      `Import ${memoryItems.length} saved memories from "${selected.label}" into this account?\n\n` +
      'Existing matching memories will be skipped.'
    );
    if (!proceed) return;

    importInProgress = true;
    updateImportWizardUi();
    try {
      setProgress(0, `Importing memories from ${selected.label}...`, { indeterminate: true });
      setStatus(`Importing memories from ${selected.label}...`);
      const result = await importMemoriesToCurrentAccount(memoryItems);

      if (result.failed > 0 && result.imported === 0) {
        setProgressFailed('Memory import failed');
      } else {
        setProgressDone(`Memories imported: ${result.imported}`);
      }

      setStatus(
        `Memory import done: imported ${result.imported}, skipped ${result.skipped}, failed ${result.failed}`
      );
      if (result.failed > 0) {
        console.warn('Memory import errors:', result.errors);
      }
    } catch (err) {
      setProgressFailed('Memory import failed');
      throw err;
    } finally {
      importInProgress = false;
      updateImportWizardUi();
    }
  }

  function updateImportWizardUi() {
    const modal = document.getElementById('cgpt-archive-import-modal');
    if (!modal) return;

    const select = modal.querySelector('#cgpt-import-account-select');
    const fileEl = modal.querySelector('#cgpt-import-source-file');
    const summaryEl = modal.querySelector('#cgpt-import-summary');
    const btnApply = modal.querySelector('#cgpt-import-apply-ci');
    const btnMemories = modal.querySelector('#cgpt-import-import-memories');
    const btnImport = modal.querySelector('#cgpt-import-import-chats');
    const btnImportSeparate = modal.querySelector('#cgpt-import-import-chats-separate');
    const btnCleanupSource = modal.querySelector('#cgpt-import-cleanup-source-chats');
    const btnRunAll = modal.querySelector('#cgpt-import-run-all');

    if (!select || !fileEl || !summaryEl || !btnApply || !btnMemories || !btnImport || !btnImportSeparate || !btnCleanupSource || !btnRunAll) return;

    select.innerHTML = '';
    const accounts = importWizardData?.accounts || [];

    if (!accounts.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '(load archive first)';
      select.appendChild(option);
      select.disabled = true;
      btnApply.disabled = true;
      btnMemories.disabled = true;
      btnImport.disabled = true;
      btnImportSeparate.disabled = true;
      btnCleanupSource.disabled = true;
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
    const hasSelectedAccount = !!selected?.label;
    const hasCustomInstructions = !!(profile?.customInstructions?.aboutUser || profile?.customInstructions?.aboutModel);
    const hasAboutYou = !!profile?.aboutYou?.text;
    const memoryCount = Array.isArray(profile?.memories) ? profile.memories.length : 0;
    const projectInstructionCount = Array.isArray(profile?.projectInstructions) ? profile.projectInstructions.length : 0;

    fileEl.textContent = importWizardData?.sourceFileName || '(unnamed file)';
    summaryEl.innerHTML =
      `Selected account: <b>${escapeHtml(selected?.label || '')}</b><br>` +
      `Chats in archive: <b>${selected?.chats?.length || 0}</b><br>` +
      `Custom instructions in archive: <b>${hasCustomInstructions ? 'yes' : 'no'}</b><br>` +
      `About You in archive: <b>${hasAboutYou ? 'yes' : 'no'}</b><br>` +
      `Memories in archive: <b>${memoryCount}</b><br>` +
      `Project instructions in archive: <b>${projectInstructionCount}</b><br>` +
      `Import status: <b>${importInProgress ? 'running' : 'idle'}</b>`;

    select.disabled = false;
    btnApply.disabled = !hasCustomInstructions || importInProgress;
    btnMemories.disabled = !(memoryCount > 0) || importInProgress;
    btnImport.disabled = !(selected?.chats?.length > 0) || importInProgress;
    btnImportSeparate.disabled = !(selected?.chats?.length > 0) || importInProgress;
    btnCleanupSource.disabled = !hasSelectedAccount || importInProgress;
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
    setProgress(0, 'Loading import archive...', { indeterminate: true });
    try {
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
      setProgressDone('Import archive loaded');
    } catch (err) {
      setProgressFailed('Import archive load failed');
      throw err;
    }
  }

  async function importWizardApplyCustomInstructions() {
    const selected = getImportSelection();
    const customInstructions = selected?.profile?.customInstructions;
    const aboutYouText = selected?.profile?.aboutYou?.text || '';
    if (!customInstructions || !(customInstructions.aboutUser || customInstructions.aboutModel || aboutYouText)) {
      throw new Error('No custom instructions/about-you found for selected account');
    }

    setProgress(0, `Applying custom instructions from ${selected.label}...`, { indeterminate: true });
    try {
      setStatus(`Applying custom instructions from ${selected.label}...`);
      const result = await applyCustomInstructionsToCurrentAccount(customInstructions, aboutYouText);
      setStatus(`Custom instructions applied (${result.method})`);
      setProgressDone('Custom instructions applied');
    } catch (err) {
      setProgressFailed('Custom instructions step failed');
      throw err;
    }
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
      'This will send messages in the currently open chat.\n\n' +
      'Warning: this can take a few minutes for larger archives.'
    );
    if (!proceed) return;

    importInProgress = true;
    updateImportWizardUi();
    try {
      for (let i = 0; i < chunks.length; i++) {
        const pct = Math.round((i / chunks.length) * 100);
        setProgress(pct, `Importing chats chunk ${i + 1}/${chunks.length}`);
        setStatus(`Importing chats chunk ${i + 1}/${chunks.length}...`);
        await sendComposerMessage(chunks[i]);
        await sleep(500);
        await waitForComposerAvailability();
      }
      setStatus(`Chat import complete: ${selected.chats.length} chats imported`);
      setProgressDone(`Import complete: ${selected.chats.length} chats`);
    } catch (err) {
      setProgressFailed('Chat import failed');
      throw err;
    } finally {
      importInProgress = false;
      updateImportWizardUi();
    }
  }

  async function importWizardImportChatsSeparateThreads() {
    if (importInProgress) return;
    const selected = getImportSelection();
    const chats = Array.isArray(selected?.chats) ? selected.chats : [];
    if (!chats.length) {
      throw new Error('No chats found for selected account');
    }

    const proceed = confirm(
      `Import ${chats.length} chats from "${selected.label}" into separate new ChatGPT threads?\n\n` +
      'This opens a new chat and sends one archived chat per thread.\n\n' +
      'Warning: this can take several minutes for larger archives.'
    );
    if (!proceed) return;

    importInProgress = true;
    updateImportWizardUi();
    try {
      for (let i = 0; i < chats.length; i++) {
        const pct = Math.round((i / chats.length) * 100);
        setProgress(pct, `Preparing thread ${i + 1}/${chats.length}`);
        setStatus(`Opening new thread ${i + 1}/${chats.length}...`);
        await openNewChatThreadForImport();

        const chunks = buildSingleChatImportChunks(chats[i], selected.label, i, chats.length);
        if (!chunks.length) continue;

        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const chunkText = chunks[chunkIndex];
          const chunkLabel = chunks.length > 1
            ? `thread ${i + 1}/${chats.length}, part ${chunkIndex + 1}/${chunks.length}`
            : `thread ${i + 1}/${chats.length}`;
          setStatus(`Importing ${chunkLabel}...`);
          await sendComposerMessage(chunkText);
          await sleep(500);
          await waitForComposerAvailability();
        }

        await sleep(500);
      }

      setStatus(`Separate-thread import complete: ${chats.length} chats imported`);
      setProgressDone(`Separate-thread import complete: ${chats.length}`);
    } catch (err) {
      setProgressFailed('Separate-thread chat import failed');
      throw err;
    } finally {
      importInProgress = false;
      updateImportWizardUi();
    }
  }

  async function importWizardPurgeSourceChats() {
    if (importInProgress) return;
    const allChats = await dbGetAllChats();
    const allProfiles = await dbGetAllProfiles();
    const bindings = getLabelBindings();
    const labels = new Set(
      [
        ...(importWizardData?.accounts || []).map((account) => normalizeAccountLabel(account?.label || '')),
        ...allChats.map((chat) => normalizeAccountLabel(chat?.accountLabel || '')),
        ...allProfiles.map((profile) => normalizeAccountLabel(profile?.accountLabel || '')),
        ...Object.keys(bindings || {}).map((label) => normalizeAccountLabel(label || ''))
      ].filter(Boolean)
    );
    const knownLabels = [...labels].sort((a, b) => a.localeCompare(b));

    if (!knownLabels.length) {
      setStatus('No source account labels found for cleanup');
      return;
    }

    const defaultLabel = normalizeAccountLabel(
      importWizardData?.selectedLabel ||
      getImportSelection()?.label ||
      knownLabels[0]
    ) || knownLabels[0];

    const labelPrompt = prompt(
      `Which account label should be cleaned up?\n\nAvailable labels:\n- ${knownLabels.join('\n- ')}`,
      defaultLabel
    );
    if (labelPrompt === null) return;

    const sourceLabel = normalizeAccountLabel(labelPrompt);
    if (!sourceLabel) {
      throw new Error('Please enter a valid account label');
    }

    const sourceChats = allChats.filter(
      (chat) => normalizeAccountLabel(chat?.accountLabel) === sourceLabel
    );
    const hasSourceProfile = allProfiles.some(
      (profile) => normalizeAccountLabel(profile?.accountLabel) === sourceLabel
    );
    const hasSourceBinding = !!bindings[sourceLabel];

    if (!sourceChats.length && !hasSourceProfile && !hasSourceBinding) {
      setStatus(`No local archived data found for "${sourceLabel}"`);
      return;
    }

    const proceed = confirm(
      `Remove local data for "${sourceLabel}"?\n\n` +
      `Chats: ${sourceChats.length}\n` +
      `Profile: ${hasSourceProfile ? 'yes' : 'no'}\n` +
      `Label binding: ${hasSourceBinding ? 'yes' : 'no'}\n\n` +
      'Backup warning: make a backup copy of your archive TXT/folder first.\n\n' +
      'This only removes local archive data. It does not delete anything from ChatGPT servers.'
    );
    if (!proceed) return;

    importInProgress = true;
    updateImportWizardUi();
    try {
      const totalSteps =
        sourceChats.length +
        (hasSourceProfile ? 1 : 0) +
        (hasSourceBinding ? 1 : 0) +
        (activeAccountLabel === sourceLabel ? 1 : 0);
      let done = 0;
      const bump = (label) => {
        done++;
        const pct = totalSteps > 0 ? Math.round((done / totalSteps) * 100) : 100;
        setProgress(pct, label);
      };

      for (let i = 0; i < sourceChats.length; i++) {
        const chat = sourceChats[i];
        setProgress(
          totalSteps > 0 ? Math.round(((done + 1) / totalSteps) * 100) : 100,
          `Removing source chats ${i + 1}/${sourceChats.length}`
        );
        await dbDelete(chatStorageKey(sourceLabel, chat.id));
        done++;
      }

      if (hasSourceProfile) {
        await dbDelete(profileStorageKey(sourceLabel));
        bump('Removing source profile data');
      }

      if (hasSourceBinding) {
        const nextBindings = { ...(bindings || {}) };
        delete nextBindings[sourceLabel];
        saveLabelBindings(nextBindings);
        bump('Removing source label binding');
      }

      if (activeAccountLabel === sourceLabel) {
        setActiveAccountLabel('');
        bump('Clearing active label selection');
      }

      await rebuildArchiveFile();
      setStatus(
        `Storage cleanup complete for "${sourceLabel}": ` +
        `${sourceChats.length} chats removed, profile ${hasSourceProfile ? 'removed' : 'not found'}, ` +
        `binding ${hasSourceBinding ? 'removed' : 'not found'}`
      );
      setProgressDone(`Removed local account data for "${sourceLabel}"`);
    } catch (err) {
      setProgressFailed('Source account cleanup failed');
      throw err;
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

    try {
      await importWizardImportMemories();
    } catch (err) {
      console.warn('Import wizard memory step failed:', err);
      setStatus(`Memory step failed: ${err?.message || err}`);
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
  function prefersReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function getMotionDuration(ms) {
    return prefersReducedMotion() ? 0 : ms;
  }

  function setStatusPulse(el) {
    if (!el) return;

    el.classList.remove('cgpt-status-updated');
    if (statusPulseTimer) {
      clearTimeout(statusPulseTimer);
      statusPulseTimer = null;
    }

    if (prefersReducedMotion()) return;

    // Restarting the class ensures repeated updates retrigger the pulse.
    void el.offsetWidth;
    el.classList.add('cgpt-status-updated');
    statusPulseTimer = setTimeout(() => {
      el.classList.remove('cgpt-status-updated');
      statusPulseTimer = null;
    }, STATUS_PULSE_MS + 40);
  }

  function setModalVisibility(modal, isOpen) {
    if (!modal) return;

    const existingTimer = modalHideTimers.get(modal);
    if (existingTimer) {
      clearTimeout(existingTimer);
      modalHideTimers.delete(modal);
    }

    if (isOpen) {
      modal.style.display = 'flex';
      requestAnimationFrame(() => {
        modal.classList.add('cgpt-modal-open');
      });
      return;
    }

    modal.classList.remove('cgpt-modal-open');
    const closeDelay = getMotionDuration(MODAL_ANIMATION_MS);
    if (!closeDelay) {
      modal.style.display = 'none';
      return;
    }

    const hideTimer = setTimeout(() => {
      modal.style.display = 'none';
      modalHideTimers.delete(modal);
    }, closeDelay);
    modalHideTimers.set(modal, hideTimer);
  }

  function setStatus(msg) {
    const el = document.getElementById('cgpt-archive-status');
    if (!el) return;
    el.textContent = msg;
    setStatusPulse(el);
  }

  function setProgressBarVisibility(visible) {
    const bar = document.getElementById('cgpt-archive-progress');
    if (!bar) return;
    if (visible) {
      bar.classList.add('cgpt-progress-visible');
    } else {
      bar.classList.remove('cgpt-progress-visible');
    }
  }

  function setProgressLabel(label) {
    const el = document.getElementById('cgpt-archive-progress-label');
    if (!el) return;
    el.textContent = cleanText(label || '');
  }

  function setProgress(value, label = '', options = {}) {
    const {
      indeterminate = false,
      state = 'normal'
    } = options;

    const fill = document.getElementById('cgpt-archive-progress-fill');
    const bar = document.getElementById('cgpt-archive-progress');
    if (!fill || !bar) return;

    if (progressHideTimer) {
      clearTimeout(progressHideTimer);
      progressHideTimer = null;
    }

    setProgressBarVisibility(true);
    setProgressLabel(label);

    bar.classList.toggle('cgpt-progress-indeterminate', indeterminate);
    bar.classList.toggle('cgpt-progress-success', state === 'success');
    bar.classList.toggle('cgpt-progress-error', state === 'error');

    if (indeterminate) {
      fill.style.width = '36%';
      return;
    }

    const numeric = Number(value);
    const clamped = Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
    fill.style.width = `${clamped}%`;
  }

  function hideProgress(delayMs = 0) {
    const fill = document.getElementById('cgpt-archive-progress-fill');
    const bar = document.getElementById('cgpt-archive-progress');
    if (!fill || !bar) return;

    if (progressHideTimer) {
      clearTimeout(progressHideTimer);
      progressHideTimer = null;
    }

    const close = () => {
      setProgressBarVisibility(false);
      bar.classList.remove('cgpt-progress-indeterminate');
      bar.classList.remove('cgpt-progress-success');
      bar.classList.remove('cgpt-progress-error');
      setProgressLabel('');
      fill.style.width = '0%';
    };

    if (delayMs <= 0) {
      close();
      return;
    }

    progressHideTimer = setTimeout(() => {
      close();
      progressHideTimer = null;
    }, delayMs);
  }

  function setProgressDone(label = 'Done') {
    setProgress(100, label, { state: 'success' });
    hideProgress(1400);
  }

  function setProgressFailed(label = 'Failed') {
    setProgress(100, label, { state: 'error' });
    hideProgress(2200);
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
    const hideDelay = getMotionDuration(UI_VISIBILITY_ANIMATION_MS);

    if (wrapHideTimer) {
      clearTimeout(wrapHideTimer);
      wrapHideTimer = null;
    }
    if (showButtonHideTimer) {
      clearTimeout(showButtonHideTimer);
      showButtonHideTimer = null;
    }

    if (wrap) {
      if (hidden) {
        wrap.classList.remove('cgpt-visible');

        if (!hideDelay) {
          wrap.classList.remove('cgpt-leaving');
          wrap.style.display = 'none';
        } else {
          wrap.classList.add('cgpt-leaving');
          wrapHideTimer = setTimeout(() => {
            wrap.style.display = 'none';
            wrap.classList.remove('cgpt-leaving');
            wrapHideTimer = null;
          }, hideDelay);
        }
      } else {
        wrap.style.display = 'flex';
        wrap.classList.remove('cgpt-leaving');
        requestAnimationFrame(() => {
          wrap.classList.add('cgpt-visible');
        });
      }
    }

    if (showBtn) {
      if (hidden) {
        showBtn.style.display = 'flex';
        requestAnimationFrame(() => {
          showBtn.classList.add('cgpt-visible');
        });
      } else {
        showBtn.classList.remove('cgpt-visible');
        if (!hideDelay) {
          showBtn.style.display = 'none';
        } else {
          showButtonHideTimer = setTimeout(() => {
            if (!isUiHidden()) showBtn.style.display = 'none';
            showButtonHideTimer = null;
          }, hideDelay);
        }
      }
    }
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
      :root {
        --cgpt-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
        --cgpt-ease-fast: cubic-bezier(0.25, 1, 0.5, 1);
      }
      #cgpt-archive-wrap {
        position: fixed; right: 20px; bottom: 20px; z-index: 999999;
        display: flex; flex-direction: column; gap: 12px; width: 320px;
        background: rgba(32, 33, 35, 0.85); backdrop-filter: blur(12px);
        border: 1px solid rgba(255,255,255,0.1); border-radius: 16px;
        padding: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #ececf1;
        opacity: 0; transform: translate3d(0, 14px, 0) scale(0.985); pointer-events: none;
        transition: opacity ${UI_VISIBILITY_ANIMATION_MS}ms var(--cgpt-ease-out), transform ${UI_VISIBILITY_ANIMATION_MS}ms var(--cgpt-ease-out), box-shadow ${UI_VISIBILITY_ANIMATION_MS}ms var(--cgpt-ease-fast);
      }
      #cgpt-archive-wrap.cgpt-visible { opacity: 1; transform: translate3d(0, 0, 0) scale(1); pointer-events: auto; }
      #cgpt-archive-wrap.cgpt-leaving { opacity: 0; transform: translate3d(0, 10px, 0) scale(0.99); pointer-events: none; }
      #cgpt-archive-wrap > * {
        opacity: 0; transform: translate3d(0, 8px, 0);
        transition: opacity ${UI_VISIBILITY_ANIMATION_MS}ms var(--cgpt-ease-out), transform ${UI_VISIBILITY_ANIMATION_MS}ms var(--cgpt-ease-out);
      }
      #cgpt-archive-wrap.cgpt-visible > * { opacity: 1; transform: translate3d(0, 0, 0); }
      #cgpt-archive-wrap > :nth-child(1) { transition-delay: 20ms; }
      #cgpt-archive-wrap > :nth-child(2) { transition-delay: 45ms; }
      #cgpt-archive-wrap > :nth-child(3) { transition-delay: 70ms; }
      #cgpt-archive-wrap > :nth-child(4) { transition-delay: 95ms; }
      #cgpt-archive-wrap > :nth-child(5) { transition-delay: 120ms; }
      #cgpt-archive-wrap > :nth-child(6) { transition-delay: 145ms; }
      .cgpt-btn-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .cgpt-btn {
        background: #444654; color: #fff; border: 1px solid rgba(255,255,255,0.05);
        padding: 8px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500;
        transition: background-color 180ms var(--cgpt-ease-fast), border-color 180ms var(--cgpt-ease-fast), color 180ms var(--cgpt-ease-fast), transform 160ms var(--cgpt-ease-fast), box-shadow 180ms var(--cgpt-ease-fast);
        display: flex; align-items: center; justify-content: center; will-change: transform;
      }
      .cgpt-btn:hover { background: #565869; transform: translate3d(0, -1px, 0); box-shadow: 0 8px 20px rgba(0, 0, 0, 0.25); }
      .cgpt-btn:active { transform: translate3d(0, 1px, 0) scale(0.98); }
      .cgpt-btn:disabled { opacity: 0.55; cursor: not-allowed; box-shadow: none; transform: none; }
      .cgpt-btn-primary { background: #10a37f; border-color: #10a37f; }
      .cgpt-btn-primary:hover { background: #0e906f; }
      .cgpt-btn-danger { background: transparent; color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); }
      .cgpt-btn-danger:hover { background: rgba(239, 68, 68, 0.1); }
      #cgpt-archive-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px; margin-bottom: 4px; }
      #cgpt-archive-title { font-weight: 600; font-size: 14px; }
      #cgpt-archive-account { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; transition: color 200ms var(--cgpt-ease-fast); }
      #cgpt-archive-status {
        font-size: 12px; color: #9ca3af; text-align: center; margin-top: 4px;
        background: rgba(0,0,0,0.2); padding: 6px; border-radius: 6px;
        transition: background-color 180ms var(--cgpt-ease-fast), color 180ms var(--cgpt-ease-fast), transform 180ms var(--cgpt-ease-fast);
      }
      #cgpt-archive-progress {
        display: none;
        background: rgba(0,0,0,0.2);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 8px;
        padding: 6px 8px;
      }
      #cgpt-archive-progress.cgpt-progress-visible { display: block; }
      #cgpt-archive-progress-track {
        width: 100%;
        height: 7px;
        background: rgba(255,255,255,0.08);
        border-radius: 999px;
        overflow: hidden;
      }
      #cgpt-archive-progress-fill {
        height: 100%;
        width: 0%;
        border-radius: 999px;
        background: linear-gradient(90deg, #10a37f, #22c55e);
        transition: width 220ms var(--cgpt-ease-fast), background 180ms var(--cgpt-ease-fast), transform 180ms var(--cgpt-ease-fast);
      }
      #cgpt-archive-progress.cgpt-progress-indeterminate #cgpt-archive-progress-fill {
        width: 36%;
        animation: cgpt-progress-indeterminate 1.15s linear infinite;
      }
      #cgpt-archive-progress.cgpt-progress-success #cgpt-archive-progress-fill {
        background: linear-gradient(90deg, #22c55e, #34d399);
      }
      #cgpt-archive-progress.cgpt-progress-error #cgpt-archive-progress-fill {
        background: linear-gradient(90deg, #ef4444, #f97316);
      }
      #cgpt-archive-progress-label {
        font-size: 11px;
        color: #cbd5e1;
        text-align: right;
        margin-top: 5px;
        min-height: 14px;
      }
      #cgpt-archive-status.cgpt-status-updated {
        animation: cgpt-status-pulse ${STATUS_PULSE_MS}ms var(--cgpt-ease-out);
      }
      @keyframes cgpt-progress-indeterminate {
        0% { transform: translateX(-120%); }
        100% { transform: translateX(320%); }
      }
      @keyframes cgpt-status-pulse {
        0% { transform: translate3d(0, 0, 0) scale(1); background: rgba(0,0,0,0.2); color: #9ca3af; }
        38% { transform: translate3d(0, -1px, 0) scale(1.01); background: rgba(16, 163, 127, 0.22); color: #e2fcef; }
        100% { transform: translate3d(0, 0, 0) scale(1); background: rgba(0,0,0,0.2); color: #9ca3af; }
      }
      #cgpt-archive-show {
        position: fixed; right: 20px; bottom: 20px; z-index: 999999;
        background: #10a37f; color: white; border: none; padding: 12px 20px;
        border-radius: 99px; cursor: pointer; font-family: inherit; font-weight: 600; font-size: 14px;
        box-shadow: 0 4px 12px rgba(16, 163, 127, 0.4);
        opacity: 0; transform: translate3d(0, 12px, 0) scale(0.96); pointer-events: none;
        transition: opacity ${UI_VISIBILITY_ANIMATION_MS}ms var(--cgpt-ease-out), transform ${UI_VISIBILITY_ANIMATION_MS}ms var(--cgpt-ease-out), box-shadow 180ms var(--cgpt-ease-fast);
      }
      #cgpt-archive-show.cgpt-visible { opacity: 1; transform: translate3d(0, 0, 0) scale(1); pointer-events: auto; }
      #cgpt-archive-show:hover { transform: translate3d(0, 0, 0) scale(1.03); box-shadow: 0 10px 24px rgba(16, 163, 127, 0.36); }
      #cgpt-archive-show:active { transform: translate3d(0, 1px, 0) scale(0.98); }
      #cgpt-archive-guide-modal {
        position: fixed; inset: 0; z-index: 1000000; display: none;
        align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.65);
        padding: 16px;
        opacity: 0; pointer-events: none;
        transition: opacity ${MODAL_ANIMATION_MS}ms var(--cgpt-ease-out);
      }
      .cgpt-guide-panel {
        width: min(760px, 95vw); max-height: 86vh; overflow: auto;
        background: #1f2023; border: 1px solid rgba(255,255,255,0.12); border-radius: 14px;
        box-shadow: 0 16px 40px rgba(0,0,0,0.5); color: #ececf1;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        transform: translate3d(0, 14px, 0) scale(0.985); opacity: 0.95;
        transition: transform ${MODAL_ANIMATION_MS}ms var(--cgpt-ease-out), opacity ${MODAL_ANIMATION_MS}ms var(--cgpt-ease-out);
      }
      #cgpt-archive-guide-modal.cgpt-modal-open { opacity: 1; pointer-events: auto; }
      #cgpt-archive-guide-modal.cgpt-modal-open .cgpt-guide-panel { transform: translate3d(0, 0, 0) scale(1); opacity: 1; }
      .cgpt-guide-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.1);
        position: sticky; top: 0; background: #1f2023;
      }
      .cgpt-guide-title { font-size: 15px; font-weight: 700; }
      .cgpt-guide-close {
        background: transparent; color: #ececf1; border: 1px solid rgba(255,255,255,0.2);
        border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; font-weight: 600;
        transition: background-color 160ms var(--cgpt-ease-fast), transform 160ms var(--cgpt-ease-fast);
      }
      .cgpt-guide-close:hover { background: rgba(255,255,255,0.08); transform: translate3d(0, -1px, 0); }
      .cgpt-guide-close:active { transform: translate3d(0, 1px, 0) scale(0.98); }
      .cgpt-guide-body { padding: 14px 16px 16px; font-size: 13px; line-height: 1.45; }
      .cgpt-guide-body h3 { margin: 8px 0 8px; font-size: 14px; color: #93c5fd; }
      .cgpt-guide-body p { margin: 0 0 10px; color: #d1d5db; }
      .cgpt-guide-body ol { margin: 0 0 12px 20px; padding: 0; }
      .cgpt-guide-body li { margin: 0 0 7px; }
      .cgpt-guide-walkthrough {
        margin-bottom: 14px;
        padding: 12px;
        border-radius: 10px;
        border: 1px solid rgba(59, 130, 246, 0.35);
        background: rgba(59, 130, 246, 0.08);
      }
      .cgpt-guide-step-meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .cgpt-guide-step-counter {
        font-size: 12px;
        font-weight: 700;
        color: #dbeafe;
      }
      .cgpt-guide-step-state {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        color: #9ca3af;
      }
      .cgpt-guide-step-state.cgpt-step-complete { color: #34d399; }
      .cgpt-guide-step-track {
        width: 100%;
        height: 6px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(255,255,255,0.14);
        margin-bottom: 10px;
      }
      .cgpt-guide-step-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #3b82f6, #10b981);
        transition: width 180ms var(--cgpt-ease-fast);
      }
      .cgpt-guide-step-title {
        margin: 0 0 6px;
        font-size: 14px;
        color: #f8fafc;
      }
      .cgpt-guide-step-checklist {
        margin: 0 0 10px;
        padding: 0 0 0 18px;
        color: #e5e7eb;
      }
      .cgpt-guide-step-checklist li { margin-bottom: 5px; }
      .cgpt-guide-step-hint {
        margin-top: 8px;
        padding: 8px;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(0,0,0,0.18);
        color: #d1d5db;
        font-size: 12px;
      }
      .cgpt-guide-step-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        flex-wrap: wrap;
        margin-top: 10px;
      }
      .cgpt-guide-step-actions .cgpt-btn {
        min-width: 104px;
      }
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
        opacity: 0; pointer-events: none;
        transition: opacity ${MODAL_ANIMATION_MS}ms var(--cgpt-ease-out);
      }
      .cgpt-import-panel {
        width: min(820px, 96vw); max-height: 88vh; overflow: auto;
        background: #17181b; border: 1px solid rgba(255,255,255,0.16); border-radius: 14px;
        box-shadow: 0 20px 48px rgba(0,0,0,0.55); color: #ececf1;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        transform: translate3d(0, 14px, 0) scale(0.985); opacity: 0.95;
        transition: transform ${MODAL_ANIMATION_MS}ms var(--cgpt-ease-out), opacity ${MODAL_ANIMATION_MS}ms var(--cgpt-ease-out);
      }
      #cgpt-archive-import-modal.cgpt-modal-open { opacity: 1; pointer-events: auto; }
      #cgpt-archive-import-modal.cgpt-modal-open .cgpt-import-panel { transform: translate3d(0, 0, 0) scale(1); opacity: 1; }
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
        transition: border-color 180ms var(--cgpt-ease-fast), background-color 180ms var(--cgpt-ease-fast);
      }
      .cgpt-import-hint {
        margin-top: 10px; padding: 10px; border-radius: 8px;
        background: rgba(59, 130, 246, 0.14); border: 1px solid rgba(59, 130, 246, 0.35);
      }
      .cgpt-import-warn {
        margin-top: 8px; padding: 10px; border-radius: 8px;
        background: rgba(245, 158, 11, 0.14); border: 1px solid rgba(245, 158, 11, 0.4);
        color: #fde68a;
      }
      #cgpt-archive-settings-modal {
        position: fixed; inset: 0; z-index: 1000002; display: none;
        align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.72); padding: 16px;
        opacity: 0; pointer-events: none;
        transition: opacity ${MODAL_ANIMATION_MS}ms var(--cgpt-ease-out);
      }
      .cgpt-settings-panel {
        width: min(560px, 96vw); max-height: 88vh; overflow: auto;
        background: #17181b; border: 1px solid rgba(255,255,255,0.16); border-radius: 14px;
        box-shadow: 0 20px 48px rgba(0,0,0,0.55); color: #ececf1;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        transform: translate3d(0, 14px, 0) scale(0.985); opacity: 0.95;
        transition: transform ${MODAL_ANIMATION_MS}ms var(--cgpt-ease-out), opacity ${MODAL_ANIMATION_MS}ms var(--cgpt-ease-out);
      }
      #cgpt-archive-settings-modal.cgpt-modal-open { opacity: 1; pointer-events: auto; }
      #cgpt-archive-settings-modal.cgpt-modal-open .cgpt-settings-panel { transform: translate3d(0, 0, 0) scale(1); opacity: 1; }
      .cgpt-settings-head {
        display: flex; justify-content: space-between; align-items: center;
        padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.12);
        position: sticky; top: 0; background: #17181b;
      }
      .cgpt-settings-title { font-size: 15px; font-weight: 700; }
      .cgpt-settings-body { padding: 14px 16px 16px; font-size: 13px; line-height: 1.45; }
      .cgpt-settings-list {
        display: grid; grid-template-columns: 1fr; gap: 8px;
        margin-top: 8px;
      }
      .cgpt-settings-item {
        display: flex; align-items: flex-start; gap: 8px;
        border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
        background: rgba(255,255,255,0.03); padding: 10px;
      }
      .cgpt-settings-item input { margin-top: 2px; }
      .cgpt-settings-actions {
        display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px;
      }
      @media (prefers-reduced-motion: reduce) {
        #cgpt-archive-wrap,
        #cgpt-archive-wrap > *,
        .cgpt-btn,
        #cgpt-archive-show,
        #cgpt-archive-guide-modal,
        #cgpt-archive-import-modal,
        #cgpt-archive-settings-modal,
        .cgpt-guide-panel,
        .cgpt-import-panel,
        .cgpt-settings-panel,
        .cgpt-guide-close,
        #cgpt-archive-progress-fill,
        #cgpt-archive-status {
          transition-duration: 0.01ms !important;
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
        }
      }
      @media (max-width: 780px) {
        .cgpt-import-actions { grid-template-columns: 1fr; }
        .cgpt-import-row { grid-template-columns: 1fr; gap: 6px; }
        .cgpt-settings-actions { grid-template-columns: 1fr; }
        .cgpt-guide-step-actions { justify-content: stretch; }
        .cgpt-guide-step-actions .cgpt-btn { flex: 1 1 100%; }
      }
    `;
    document.head.appendChild(style);
  }

  function getGuideSteps() {
    return [
      {
        id: 'set-account',
        title: 'Set an account label',
        body: 'Give the current login a unique label so archives stay separated across accounts.',
        checklist: [
          'Click Set Account.',
          'Use labels like main, work, or personal.',
          'Keep one label per ChatGPT login.'
        ],
        hint: 'You can change the label later, but keep it stable for clean history grouping.',
        actionId: 'set-account',
        actionLabel: 'Set Account Now'
      },
      {
        id: 'choose-file',
        title: 'Choose your archive destination',
        body: 'Pick either a local archive .txt file or a bundle folder (or both).',
        checklist: [
          'Option A: Click Choose File and select/create your archive .txt file.',
          'Option B: Click Choose Folder for bundle export output.',
          'Grant write permission when the browser asks.'
        ],
        hint: 'Choose File is needed for live archive writes. Choose Folder enables bundled exports with per-chat assets.',
        actionId: 'choose-file',
        actionLabel: 'Choose File Now',
        altActionId: 'choose-folder',
        altActionLabel: 'Choose Folder Instead'
      },
      {
        id: 'sync-all',
        title: 'Run first full sync',
        body: 'Pull your conversation list and save each chat into the archive file.',
        checklist: [
          'Click Sync All.',
          'Wait for progress to finish.',
          'Keep the tab open while the first sync runs.'
        ],
        hint: 'This first run can take a bit if you have many chats.',
        actionId: 'sync-all',
        actionLabel: 'Run Sync All'
      },
      {
        id: 'sync-profile',
        title: 'Sync profile context',
        body: 'Capture memories, custom instructions, and About You so account context is preserved.',
        checklist: [
          'Click Sync Profile after setup.',
          'Run again whenever profile details change.',
          'Use this if memory/profile data looks stale.'
        ],
        hint: 'If profile data is missing, run this once while logged into the correct account.',
        actionId: 'sync-profile',
        actionLabel: 'Sync Profile Now'
      },
      {
        id: 'daily-flow',
        title: 'Daily archive workflow',
        body: 'Use Save Now for the current chat, leave the tab open for auto-sync, and use Import Wizard to restore.',
        checklist: [
          'Click Save Now to capture only the current chat instantly.',
          'Leave ChatGPT open so background sync can keep the archive fresh.',
          'Open Import Wizard when you want to re-import archive content.'
        ],
        hint: 'You can reopen this setup anytime from the Setup Guide button.',
        actionId: 'open-import',
        actionLabel: 'Open Import Wizard'
      }
    ];
  }

  function isGuideStepComplete(stepId) {
    switch (stepId) {
      case 'set-account':
        return !!activeAccountLabel;
      case 'choose-file':
        return !!hasArchiveFileHandle || !!hasBundleFolderHandle;
      case 'choose-folder':
        return !!hasBundleFolderHandle;
      case 'sync-all':
        return lastSyncStartedAt > 0;
      case 'sync-profile':
        return lastProfileSyncStartedAt > 0;
      default:
        return false;
    }
  }

  function renderGuideStep() {
    const steps = getGuideSteps();
    guideStepIndex = Math.max(0, Math.min(steps.length - 1, guideStepIndex));
    const step = steps[guideStepIndex];
    if (!step) return;

    const counter = document.getElementById('cgpt-guide-step-counter');
    const state = document.getElementById('cgpt-guide-step-state');
    const fill = document.getElementById('cgpt-guide-step-fill');
    const title = document.getElementById('cgpt-guide-step-title');
    const body = document.getElementById('cgpt-guide-step-body');
    const list = document.getElementById('cgpt-guide-step-checklist');
    const hint = document.getElementById('cgpt-guide-step-hint');
    const actionBtn = document.getElementById('cgpt-guide-step-action');
    const altActionBtn = document.getElementById('cgpt-guide-step-action-alt');
    const prevBtn = document.getElementById('cgpt-guide-prev');
    const nextBtn = document.getElementById('cgpt-guide-next');

    if (counter) counter.textContent = `Step ${guideStepIndex + 1} of ${steps.length}`;

    const complete = isGuideStepComplete(step.id);
    if (state) {
      state.textContent = complete ? 'Complete' : 'Pending';
      state.classList.toggle('cgpt-step-complete', complete);
    }

    if (fill) fill.style.width = `${Math.round(((guideStepIndex + 1) / steps.length) * 100)}%`;
    if (title) title.textContent = step.title;
    if (body) body.textContent = step.body;
    if (hint) hint.textContent = step.hint || '';

    if (list) {
      list.innerHTML = '';
      for (const item of step.checklist || []) {
        const li = document.createElement('li');
        li.textContent = item;
        list.appendChild(li);
      }
    }

    if (actionBtn) {
      if (step.actionId) {
        actionBtn.style.display = '';
        actionBtn.textContent = step.actionLabel || 'Do This Step';
      } else {
        actionBtn.style.display = 'none';
      }
    }
    if (altActionBtn) {
      if (step.altActionId) {
        altActionBtn.style.display = '';
        altActionBtn.textContent = step.altActionLabel || 'Alternative Option';
      } else {
        altActionBtn.style.display = 'none';
      }
    }

    if (prevBtn) prevBtn.disabled = guideStepIndex === 0;
    if (nextBtn) nextBtn.textContent = guideStepIndex >= steps.length - 1 ? 'Finish' : 'Next';
  }

  async function runGuideStepAction(actionOverride = '') {
    const step = getGuideSteps()[guideStepIndex];
    const actionId = cleanText(actionOverride || step?.actionId || '');
    if (!actionId) return;

    try {
      if (actionId === 'set-account') {
        await promptForAccountLabel();
      } else if (actionId === 'choose-file') {
        setProgress(0, 'Choosing archive file...', { indeterminate: true });
        await chooseArchiveFile();
        await rebuildArchiveFile();
        setProgressDone('Archive file ready');
      } else if (actionId === 'choose-folder') {
        setProgress(0, 'Choosing bundle folder...', { indeterminate: true });
        await chooseArchiveBundleFolder();
        setProgressDone('Bundle folder ready');
      } else if (actionId === 'sync-all') {
        await syncAllChatsForActiveAccount({ silent: false });
      } else if (actionId === 'sync-profile') {
        await syncAccountProfileForActiveAccount({ silent: false, force: true });
      } else if (actionId === 'open-import') {
        closeGuideModal();
        openImportWizardModal();
        return;
      }
    } catch (err) {
      const message = err?.message || String(err);
      setStatus(`Setup step failed: ${message}`);
      setProgressFailed('Setup step failed');
    } finally {
      renderGuideStep();
    }
  }

  function closeGuideModal() {
    const modal = document.getElementById('cgpt-archive-guide-modal');
    setModalVisibility(modal, false);
  }

  function ensureGuideModal() {
    let modal = document.getElementById('cgpt-archive-guide-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'cgpt-archive-guide-modal';
    modal.innerHTML = `
      <div class="cgpt-guide-panel" role="dialog" aria-modal="true" aria-label="Archive setup guide">
        <div class="cgpt-guide-head">
          <div class="cgpt-guide-title">First-Time Archive Setup</div>
          <button class="cgpt-guide-close" data-guide-close="1">Close</button>
        </div>
        <div class="cgpt-guide-body">
          <div class="cgpt-guide-walkthrough">
            <div class="cgpt-guide-step-meta">
              <div class="cgpt-guide-step-counter" id="cgpt-guide-step-counter"></div>
              <div class="cgpt-guide-step-state" id="cgpt-guide-step-state"></div>
            </div>
            <div class="cgpt-guide-step-track">
              <div class="cgpt-guide-step-fill" id="cgpt-guide-step-fill"></div>
            </div>
            <h3 class="cgpt-guide-step-title" id="cgpt-guide-step-title"></h3>
            <p id="cgpt-guide-step-body"></p>
            <ul class="cgpt-guide-step-checklist" id="cgpt-guide-step-checklist"></ul>
            <div class="cgpt-guide-step-hint" id="cgpt-guide-step-hint"></div>
            <div class="cgpt-guide-step-actions">
              <button class="cgpt-btn" id="cgpt-guide-prev">Back</button>
              <button class="cgpt-btn" id="cgpt-guide-step-action">Do This Step</button>
              <button class="cgpt-btn" id="cgpt-guide-step-action-alt">Alternative Option</button>
              <button class="cgpt-btn cgpt-btn-primary" id="cgpt-guide-next">Next</button>
            </div>
          </div>

          <h3>Quick button reference</h3>
          <table class="cgpt-guide-table">
            <thead>
              <tr><th>Button</th><th>Action</th></tr>
            </thead>
            <tbody>
              <tr><td><b>Set Account</b></td><td>Sets the label for the current ChatGPT login so archive entries stay grouped correctly.</td></tr>
              <tr><td><b>Choose File</b></td><td>Selects the archive TXT file to read and write.</td></tr>
              <tr><td><b>Choose Folder</b></td><td>Selects an export folder for bundle output.</td></tr>
              <tr><td><b>Export Bundle</b></td><td>Writes <code>archive.txt</code>, global indexes, and per-chat folders with sources/code plus automatic media/file download attempts.</td></tr>
              <tr><td><b>Save Now</b></td><td>Saves the currently open chat immediately.</td></tr>
              <tr><td><b>Sync All</b></td><td>Runs a full chat + profile sync sweep for the active account label.</td></tr>
              <tr><td><b>Sync Profile</b></td><td>Refreshes memories, custom instructions, and About You in the archive.</td></tr>
              <tr><td><b>Import Wizard</b></td><td>Loads archive data and helps import it into the currently logged-in account.</td></tr>
              <tr><td><b>Settings</b></td><td>Controls bundle export toggles (sources/media/code/files and automatic downloads).</td></tr>
              <tr><td><b>Setup Guide</b></td><td>Reopens this first-time step-by-step setup walkthrough.</td></tr>
              <tr><td><b>Hide UI</b></td><td>Hides this panel. Use <b>Open Archive</b> to show it again.</td></tr>
            </tbody>
          </table>
          <div class="cgpt-guide-note">
            Tip: For first setup, run in order: Set Account -> Choose File or Choose Folder -> Sync All.
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

    const prevBtn = modal.querySelector('#cgpt-guide-prev');
    const nextBtn = modal.querySelector('#cgpt-guide-next');
    const actionBtn = modal.querySelector('#cgpt-guide-step-action');
    const altActionBtn = modal.querySelector('#cgpt-guide-step-action-alt');

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        guideStepIndex = Math.max(0, guideStepIndex - 1);
        renderGuideStep();
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        const last = getGuideSteps().length - 1;
        if (guideStepIndex >= last) {
          closeGuideModal();
          return;
        }
        guideStepIndex = Math.min(last, guideStepIndex + 1);
        renderGuideStep();
      });
    }
    if (actionBtn) {
      actionBtn.addEventListener('click', async () => {
        actionBtn.disabled = true;
        try {
          await runGuideStepAction();
        } finally {
          actionBtn.disabled = false;
        }
      });
    }
    if (altActionBtn) {
      altActionBtn.addEventListener('click', async () => {
        const step = getGuideSteps()[guideStepIndex];
        if (!step?.altActionId) return;
        altActionBtn.disabled = true;
        try {
          await runGuideStepAction(step.altActionId);
        } finally {
          altActionBtn.disabled = false;
        }
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeGuideModal();
      }
    });

    document.body.appendChild(modal);
    return modal;
  }

  function openGuideModal(startStep = 0) {
    const steps = getGuideSteps();
    guideStepIndex = Math.max(0, Math.min(steps.length - 1, Number(startStep) || 0));
    const modal = ensureGuideModal();
    renderGuideStep();
    setModalVisibility(modal, true);
  }

  function closeSettingsModal() {
    const modal = document.getElementById('cgpt-archive-settings-modal');
    setModalVisibility(modal, false);
  }

  function updateSettingsModalControls() {
    const modal = document.getElementById('cgpt-archive-settings-modal');
    if (!modal) return;
    const settings = getExportSettings();
    const setChecked = (id, checked) => {
      const el = modal.querySelector(`#${id}`);
      if (el) el.checked = !!checked;
    };
    setChecked('cgpt-settings-include-sources', settings.includeSources);
    setChecked('cgpt-settings-include-media', settings.includeMedia);
    setChecked('cgpt-settings-include-code', settings.includeCode);
    setChecked('cgpt-settings-include-files', settings.includeFiles);
    setChecked('cgpt-settings-auto-download', settings.autoDownloadAssets);
  }

  function ensureSettingsModal() {
    let modal = document.getElementById('cgpt-archive-settings-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'cgpt-archive-settings-modal';
    modal.innerHTML = `
      <div class="cgpt-settings-panel" role="dialog" aria-modal="true" aria-label="Archive settings">
        <div class="cgpt-settings-head">
          <div class="cgpt-settings-title">Archive Settings</div>
          <button class="cgpt-guide-close" data-settings-close="1">Close</button>
        </div>
        <div class="cgpt-settings-body">
          <div>Control what bundle export writes/downloads.</div>
          <div class="cgpt-settings-list">
            <label class="cgpt-settings-item">
              <input type="checkbox" id="cgpt-settings-include-sources" />
              <div><b>Include Sources</b><br/>Write global + per-chat source lists.</div>
            </label>
            <label class="cgpt-settings-item">
              <input type="checkbox" id="cgpt-settings-include-media" />
              <div><b>Include Media</b><br/>Write media indexes and chat media folders.</div>
            </label>
            <label class="cgpt-settings-item">
              <input type="checkbox" id="cgpt-settings-include-code" />
              <div><b>Include Code</b><br/>Write global + per-chat code snippet files.</div>
            </label>
            <label class="cgpt-settings-item">
              <input type="checkbox" id="cgpt-settings-include-files" />
              <div><b>Include Files</b><br/>Write file indexes and chat file folders.</div>
            </label>
            <label class="cgpt-settings-item">
              <input type="checkbox" id="cgpt-settings-auto-download" />
              <div><b>Auto-download Assets</b><br/>Automatically download media/files during Export Bundle.</div>
            </label>
          </div>
          <div class="cgpt-settings-actions">
            <button class="cgpt-btn" id="cgpt-settings-reset">Reset Defaults</button>
            <button class="cgpt-btn cgpt-btn-primary" id="cgpt-settings-save">Save Settings</button>
          </div>
        </div>
      </div>
    `;

    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeSettingsModal();
      }
    });

    modal.querySelectorAll('[data-settings-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeSettingsModal());
    });

    const saveBtn = modal.querySelector('#cgpt-settings-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const readChecked = (id) => {
          const el = modal.querySelector(`#${id}`);
          return !!el?.checked;
        };
        saveExportSettings({
          includeSources: readChecked('cgpt-settings-include-sources'),
          includeMedia: readChecked('cgpt-settings-include-media'),
          includeCode: readChecked('cgpt-settings-include-code'),
          includeFiles: readChecked('cgpt-settings-include-files'),
          autoDownloadAssets: readChecked('cgpt-settings-auto-download')
        });
        setStatus('Export settings saved');
        closeSettingsModal();
      });
    }

    const resetBtn = modal.querySelector('#cgpt-settings-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        saveExportSettings(getDefaultExportSettings());
        updateSettingsModalControls();
        setStatus('Export settings reset to defaults');
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeSettingsModal();
      }
    });

    document.body.appendChild(modal);
    return modal;
  }

  function openSettingsModal() {
    const modal = ensureSettingsModal();
    updateSettingsModalControls();
    setModalVisibility(modal, true);
  }

  function closeImportWizardModal() {
    const modal = document.getElementById('cgpt-archive-import-modal');
    setModalVisibility(modal, false);
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
            <button class="cgpt-btn" id="cgpt-import-import-memories" disabled>Import Memories</button>
          </div>
          <div class="cgpt-import-actions">
            <button class="cgpt-btn" id="cgpt-import-import-chats" disabled>Import Chats (One Thread)</button>
            <button class="cgpt-btn" id="cgpt-import-import-chats-separate" disabled>Import Chats (Separate Threads)</button>
            <button class="cgpt-btn cgpt-btn-primary" id="cgpt-import-run-all" disabled>Run Import All</button>
          </div>
          <div class="cgpt-import-actions">
            <button class="cgpt-btn cgpt-btn-danger" id="cgpt-import-cleanup-source-chats" disabled>Remove Source Account Data (Save Space)</button>
          </div>

          <div class="cgpt-import-summary" id="cgpt-import-summary">Load an archive TXT to begin.</div>
          <div class="cgpt-import-hint">
            Import Memories uses API calls when available. One-thread mode sends all imported chats into the current thread; separate-thread mode opens one new chat per archived chat.
          </div>
          <div class="cgpt-import-hint">
            Need less local storage after migration? Use <b>Remove Source Account Data (Save Space)</b> to remove prior account chats, profile, and label binding from this local archive.
          </div>
          <div class="cgpt-import-warn">
            Backup warning: make a backup copy of your archive TXT/folder before removing source account data.
          </div>
          <div class="cgpt-import-warn">
            Warning: chat import can take a moment (or several minutes for large archives). Keep this tab open until it finishes.
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

    const importMemoriesBtn = modal.querySelector('#cgpt-import-import-memories');
    if (importMemoriesBtn) {
      importMemoriesBtn.addEventListener('click', async () => {
        try {
          await importWizardImportMemories();
        } catch (err) {
          setStatus(`Memory import failed: ${err?.message || err}`);
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

    const importSeparateBtn = modal.querySelector('#cgpt-import-import-chats-separate');
    if (importSeparateBtn) {
      importSeparateBtn.addEventListener('click', async () => {
        try {
          await importWizardImportChatsSeparateThreads();
        } catch (err) {
          setStatus(`Separate-thread import failed: ${err?.message || err}`);
        }
      });
    }

    const cleanupSourceBtn = modal.querySelector('#cgpt-import-cleanup-source-chats');
    if (cleanupSourceBtn) {
      cleanupSourceBtn.addEventListener('click', async () => {
        try {
          await importWizardPurgeSourceChats();
        } catch (err) {
          setStatus(`Source account cleanup failed: ${err?.message || err}`);
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
    setModalVisibility(modal, true);
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
      setProgress(0, 'Choosing archive file...', { indeterminate: true });
      try {
        await chooseArchiveFile();
        await rebuildArchiveFile();
        setProgressDone('Archive file ready');
      } catch (err) {
        setStatus('Could not choose file');
        setProgressFailed('Choose file failed');
      }
    });
    row1.appendChild(setAccountBtn);
    row1.appendChild(chooseFileBtn);

    const row1b = document.createElement('div');
    row1b.className = 'cgpt-btn-row';
    const chooseFolderBtn = createBtn('Choose Folder', async () => {
      setProgress(0, 'Choosing bundle folder...', { indeterminate: true });
      try {
        await chooseArchiveBundleFolder();
        setProgressDone('Bundle folder ready');
      } catch (err) {
        setStatus('Could not choose folder');
        setProgressFailed('Choose folder failed');
      }
    });
    const exportBundleBtn = createBtn('Export Bundle', async () => {
      try {
        await exportArchiveBundleToFolder();
      } catch (err) {
        setStatus(`Bundle export failed: ${err?.message || err}`);
      }
    }, 'cgpt-btn-primary');
    row1b.appendChild(chooseFolderBtn);
    row1b.appendChild(exportBundleBtn);

    const row2 = document.createElement('div');
    row2.className = 'cgpt-btn-row';
    const saveBtn = createBtn('Save Now', async () => {
      setProgress(0, 'Saving current chat...', { indeterminate: true });
      try {
        await captureCurrentChat();
        setProgressDone('Chat saved');
      } catch (err) {
        setStatus('Save failed');
        setProgressFailed('Save failed');
      }
    }, 'cgpt-btn-primary');
    const syncAllBtn = createBtn('Sync All', async () => {
      try { await syncAllChatsForActiveAccount({ silent: false }); } catch (err) { setStatus('Sync failed'); }
    });
    row2.appendChild(saveBtn);
    row2.appendChild(syncAllBtn);

    const row3 = document.createElement('div');
    row3.className = 'cgpt-btn-row-single';
    const syncProfileBtn = createBtn('Sync Profile', async () => {
      try { await syncAccountProfileForActiveAccount({ silent: false, force: true }); }
      catch (err) { setStatus('Profile sync failed'); }
    });
    row3.appendChild(syncProfileBtn);

    const row4 = document.createElement('div');
    row4.className = 'cgpt-btn-row';
    const importWizardBtn = createBtn('Import Wizard', () => openImportWizardModal());
    const settingsBtn = createBtn('Settings', () => openSettingsModal());
    row4.appendChild(importWizardBtn);
    row4.appendChild(settingsBtn);

    const row5 = document.createElement('div');
    row5.className = 'cgpt-btn-row-single';
    const guideBtn = createBtn('Setup Guide', () => openGuideModal(0));
    row5.appendChild(guideBtn);

    const row6 = document.createElement('div');
    row6.className = 'cgpt-btn-row-single';
    const hideBtn = createBtn('Hide UI', () => setUiHidden(true), 'cgpt-btn-danger');
    row6.appendChild(hideBtn);

    const status = document.createElement('div');
    status.id = 'cgpt-archive-status';
    status.textContent = 'Waiting for input...';

    const progress = document.createElement('div');
    progress.id = 'cgpt-archive-progress';
    progress.innerHTML = `
      <div id="cgpt-archive-progress-track">
        <div id="cgpt-archive-progress-fill"></div>
      </div>
      <div id="cgpt-archive-progress-label"></div>
    `;

    wrap.appendChild(header);
    wrap.appendChild(row1);
    wrap.appendChild(row1b);
    wrap.appendChild(row2);
    wrap.appendChild(row3);
    wrap.appendChild(row4);
    wrap.appendChild(row5);
    wrap.appendChild(row6);
    wrap.appendChild(progress);
    wrap.appendChild(status);

    document.body.appendChild(showBtn);
    document.body.appendChild(wrap);
    ensureGuideModal();
    ensureImportWizardModal();
    ensureSettingsModal();

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
    hasArchiveFileHandle = !!handle;
    const bundleFolderHandle = await getSavedBundleFolderHandle();
    hasBundleFolderHandle = !!bundleFolderHandle;
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

    try {
      if (!localStorage.getItem(SETUP_SHOWN_KEY)) {
        localStorage.setItem(SETUP_SHOWN_KEY, '1');
        setTimeout(() => {
          openGuideModal(0);
        }, 800);
      }
    } catch (e) {
      // Ignore localStorage errors in incognito or blocked environments
    }

    setTimeout(() => {
      maybePromptForScriptUpdate().catch((err) => {
        console.warn('Update check failed:', err);
      });
    }, 1600);

    setInterval(addUi, 2000);
    scheduleCapture();
  }

  init().catch((err) => {
    console.error('Init failed:', err);
  });
})();
