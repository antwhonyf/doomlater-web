/* ==========================================================================
   CASHEW NATIVE FIREBASE REALTIME DATABASE WEBSOCKET SYNC ENGINE
   Hardcoded Private DB: https://ok-gogle-c018c-default-rtdb.firebaseio.com
   Syncs: Profiles, Chat, Stock, Kardex, Wallets, Categories, Transactions,
          Budgets, Goals, Obligations & Currency Rates in Real Time (<100ms).
   ========================================================================== */

(function () {
  const HARDCODED_FIREBASE_CONFIG = {
    databaseURL: (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.databaseURL)
      ? window.FIREBASE_CONFIG.databaseURL.replace(/\/+$/, '')
      : 'https://ok-gogle-c018c-default-rtdb.firebaseio.com'
  };

  const STORAGE_STATE_KEY = 'cashew_doom_shared_state_v2';
  const WORKSPACE_PATH = 'cashew_doom_v1';
  const PRESENCE_PATH = 'cashew_doom_presence';
  // Chat images live in a separate node (keys = "<timestamp>_<rand>") so the main
  // workspace stays light and expired media can be swept by key range (30 days).
  const CHAT_MEDIA_PATH = 'cashew_doom_chat_media';
  const CHAT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  const COLLECTIONS = [
    'profiles',
    'chatMessages',
    'approvalRequests',
    'currencyRatesCustom',
    'wallets',
    'categories',
    'stockItems',
    'stockMovements',
    'transactions',
    'budgets',
    'goals',
    'obligations',
    'botConversations',
    'botMessages'
  ];

  const clientId = 'cl_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);

  function cleanForFirebase(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  class CashewSyncEngine {
    constructor() {
      this.fbConfig = HARDCODED_FIREBASE_CONFIG;
      this.state = this.loadLocalState();
      this.currentProfileId = null; // 'profile_1' | 'profile_2'
      this.currentUser = null;      // current username string

      this.status = 'connecting';   // 'live' | 'connecting' | 'error' | 'offline'
      this.firebaseError = null;
      this.lastSyncAt = null;
      this.partnerPresence = {};
      this.listeners = [];
      this.syncLogs = [];

      this.fbApp = null;
      this.db = null;
      this.workspaceRef = null;
      this.presenceRootRef = null;
      this.connectedRef = null;
      this.myPresenceRef = null;
      this.hasConnectedOnce = false;
      this.serverTimeOffset = 0;     // ms difference between this device clock and Firebase server clock
      this.mediaRef = null;
      this.mediaSweepDone = false;

      this.bc = typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel('cashew_doom_local_bus_v2')
        : null;
    }

    /* Server-synchronized clock: both partners' devices stamp changes with the same
       time base, so a device whose clock is ahead can't "win" over a newer change. */
    nowTs() {
      return Date.now() + (Number(this.serverTimeOffset) || 0);
    }

    /* Timestamp for a new revision of an entity: always strictly newer than the
       revision it replaces (fixes approvals/deletions being reverted by clock skew). */
    nextStamp(existing) {
      const prev = existing ? (Number(existing.updatedAt) || 0) : 0;
      return Math.max(this.nowTs(), prev + 1);
    }

    log(msg) {
      const time = new Date().toLocaleTimeString('es-ES');
      this.syncLogs.unshift(`[${time}] ${msg}`);
      if (this.syncLogs.length > 45) this.syncLogs.pop();
    }

    loadLocalState() {
      try {
        const raw = localStorage.getItem(STORAGE_STATE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.schemaVersion) {
            return this.normalizeState(parsed);
          }
        }
      } catch (e) {}
      const seed = window.createInitialSeedState();
      seed.resetEpoch = 1;
      seed.initialized = true;
      seed.isSeedOnly = true;
      localStorage.setItem(STORAGE_STATE_KEY, JSON.stringify(seed));
      return this.normalizeState(seed);
    }

    normalizeState(st) {
      const base = {
        schemaVersion: 2,
        resetEpoch: Number(st.resetEpoch) || 1,
        initialized: st.initialized !== false,
        isSeedOnly: Boolean(st.isSeedOnly),
        primaryCurrency: st.primaryCurrency || 'USD',
        appLogoUrl: (typeof st.appLogoUrl === 'string' && st.appLogoUrl) ? st.appLogoUrl : ((st.meta && typeof st.meta.appLogoUrl === 'string' && st.meta.appLogoUrl) ? st.meta.appLogoUrl : (window.DEFAULT_DOOMLATER_LOGO_URL || './logo.jpg')),
        botConfig: (st.botConfig && typeof st.botConfig === 'object') ? st.botConfig : ((st.meta && st.meta.botConfig && typeof st.meta.botConfig === 'object') ? st.meta.botConfig : ((typeof window.createInitialSeedState === 'function' && window.createInitialSeedState().botConfig) ? window.createInitialSeedState().botConfig : null)),
        rev: Number(st.rev) || 1,
        updatedAt: Number(st.updatedAt) || 1700000000000,
        updatedBy: st.updatedBy || 'doom1',
        lastLabel: st.lastLabel || ''
      };
      for (const col of COLLECTIONS) {
        if (Array.isArray(st[col])) {
          base[col] = st[col].filter(Boolean);
        } else if (st[col] && typeof st[col] === 'object') {
          base[col] = Object.values(st[col]).filter(Boolean);
        } else {
          base[col] = [];
        }
      }

      // Ensure WhatsApp-style ephemeral messages: auto-purge messages older than 30 days
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      base.chatMessages = (base.chatMessages || []).filter(m => {
        if (!m) return false;
        const msgTime = Number(m.createdAt) || (m.date ? new Date(`${m.date}T${m.time || '12:00'}:00`).getTime() : 0);
        return msgTime >= thirtyDaysAgo;
      });

      // Ensure the 2 partner profile slots always exist
      if (!base.profiles || base.profiles.length < 2) {
        const defaults = window.createDefaultProfilesList();
        const existingMap = new Map((base.profiles || []).map(p => [p.id, p]));
        for (const dp of defaults) {
          if (!existingMap.has(dp.id)) existingMap.set(dp.id, dp);
        }
        base.profiles = Array.from(existingMap.values());
      }
      return base;
    }

    firebaseSnapshotToState(val) {
      if (!val || typeof val !== 'object') return null;
      const meta = val.meta || {};
      if (!meta.initialized && !val.wallets && !val.stockItems && !val.transactions && !val.profiles) {
        return null;
      }
      const st = {
        schemaVersion: 2,
        resetEpoch: Number(meta.resetEpoch) || 1,
        initialized: true,
        isSeedOnly: false,
        primaryCurrency: meta.primaryCurrency || 'USD',
        appLogoUrl: (typeof meta.appLogoUrl === 'string' ? meta.appLogoUrl : '') || (typeof val.appLogoUrl === 'string' ? val.appLogoUrl : ''),
        botConfig: meta.botConfig || val.botConfig || null,
        rev: Number(meta.rev) || 1,
        updatedAt: Number(meta.updatedAt) || Date.now(),
        updatedBy: meta.updatedBy || 'doom1',
        lastLabel: meta.lastLabel || '',
        lastClientId: meta.lastClientId || ''
      };
      for (const col of COLLECTIONS) {
        const rawCol = val[col];
        if (!rawCol) st[col] = [];
        else if (Array.isArray(rawCol)) st[col] = rawCol.filter(Boolean);
        else st[col] = Object.values(rawCol).filter(Boolean);
      }
      return this.normalizeState(st);
    }

    stateToFirebaseObject(st) {
      const norm = this.normalizeState(st);
      const out = {
        meta: {
          schemaVersion: 2,
          initialized: true,
          resetEpoch: norm.resetEpoch || 1,
          primaryCurrency: norm.primaryCurrency || 'USD',
          appLogoUrl: norm.appLogoUrl || '',
          botConfig: norm.botConfig || null,
          rev: norm.rev || 1,
          updatedAt: norm.updatedAt || Date.now(),
          updatedBy: norm.updatedBy || this.currentUser || 'doom1',
          lastLabel: norm.lastLabel || 'Sincronización inicial',
          lastClientId: clientId
        }
      };
      for (const col of COLLECTIONS) {
        const map = {};
        for (const item of norm[col]) {
          if (item && item.id) {
            map[item.id] = item;
          }
        }
        out[col] = map;
      }
      return cleanForFirebase(out);
    }

    saveLocalState() {
      try {
        localStorage.setItem(STORAGE_STATE_KEY, JSON.stringify(this.state));
      } catch (e) {
        this.log('Aviso cache local: ' + e.message);
      }
    }

    onChange(fn) {
      this.listeners.push(fn);
    }

    emit(meta = {}) {
      for (const fn of this.listeners) {
        try {
          fn(this.state, meta);
        } catch (err) {
          console.error('Sync listener error:', err);
        }
      }
    }

    mergeStates(local, remote) {
      if (!remote) {
        return { merged: local, changedFromLocal: false, localItemsToPush: [] };
      }

      const normLocal = this.normalizeState(local);
      const normRemote = this.normalizeState(remote);

      if (normLocal.isSeedOnly && !normRemote.isSeedOnly) {
        return { merged: normRemote, changedFromLocal: true, localItemsToPush: [] };
      }

      const localEpoch = normLocal.resetEpoch || 1;
      const remoteEpoch = normRemote.resetEpoch || 1;

      if (remoteEpoch > localEpoch) {
        return { merged: normRemote, changedFromLocal: true, localItemsToPush: [] };
      }
      if (localEpoch > remoteEpoch) {
        return { merged: normLocal, changedFromLocal: false, needFullPush: true, localItemsToPush: [] };
      }

      let changedFromLocal = false;
      const localItemsToPush = [];

      const remoteNewer = (normRemote.updatedAt || 0) >= (normLocal.updatedAt || 0);
      const merged = {
        schemaVersion: 2,
        resetEpoch: Math.max(localEpoch, remoteEpoch),
        initialized: true,
        isSeedOnly: false,
        primaryCurrency: remoteNewer ? (normRemote.primaryCurrency || 'USD') : (normLocal.primaryCurrency || 'USD'),
        appLogoUrl: remoteNewer ? (normRemote.appLogoUrl || '') : (normLocal.appLogoUrl || normRemote.appLogoUrl || ''),
        botConfig: remoteNewer ? (normRemote.botConfig || normLocal.botConfig) : (normLocal.botConfig || normRemote.botConfig),
        rev: Math.max(normLocal.rev || 1, normRemote.rev || 1),
        updatedAt: Math.max(normLocal.updatedAt || 0, normRemote.updatedAt || 0),
        updatedBy: remoteNewer ? normRemote.updatedBy : normLocal.updatedBy,
        lastLabel: normRemote.lastLabel || normLocal.lastLabel || ''
      };

      for (const col of COLLECTIONS) {
        const map = new Map();
        const remoteMap = new Map();

        for (const rItem of normRemote[col]) {
          if (rItem && rItem.id) remoteMap.set(rItem.id, rItem);
        }

        for (const lItem of normLocal[col]) {
          if (!lItem || !lItem.id) continue;
          const rItem = remoteMap.get(lItem.id);
          if (!rItem) {
            map.set(lItem.id, lItem);
            if (!normLocal.isSeedOnly) {
              localItemsToPush.push({ collection: col, item: lItem });
            }
          } else {
            const lTs = Number(lItem.updatedAt) || 0;
            const rTs = Number(rItem.updatedAt) || 0;
            // Tombstones are sticky: once an item is deleted/resolved on any device,
            // a stale (non-deleted) copy from another device can never resurrect it.
            let takeRemote;
            if (rItem.deleted && !lItem.deleted) takeRemote = true;
            else if (lItem.deleted && !rItem.deleted) takeRemote = false;
            else takeRemote = rTs >= lTs;

            if (takeRemote) {
              map.set(rItem.id, rItem);
              if (JSON.stringify(rItem) !== JSON.stringify(lItem)) {
                changedFromLocal = true;
              }
            } else {
              map.set(lItem.id, lItem);
              if (JSON.stringify(rItem) !== JSON.stringify(lItem)) {
                localItemsToPush.push({ collection: col, item: lItem });
              }
            }
          }
        }

        for (const [id, rItem] of remoteMap.entries()) {
          if (!map.has(id)) {
            map.set(id, rItem);
            changedFromLocal = true;
          }
        }

        merged[col] = Array.from(map.values());
      }

      return { merged: this.normalizeState(merged), changedFromLocal, localItemsToPush };
    }

    /* Connect immediately (even before login so updated usernames/passwords & chat are ready!) */
    bootConnection() {
      if (this.hasConnectedOnce) return;
      this.hasConnectedOnce = true;

      if (this.bc) {
        this.bc.onmessage = (ev) => {
          const msg = ev.data;
          if (!msg || msg.clientId === clientId) return;
          if (msg.type === 'local_state' && msg.state) {
            const res = this.mergeStates(this.state, msg.state);
            if (res.changedFromLocal) {
              this.state = res.merged;
              this.saveLocalState();
              this.emit({ source: 'tab', by: msg.by });
            }
          }
        };
      }

      this.connectFirebase();
    }

    start(profileId, username) {
      this.currentProfileId = profileId;
      this.currentUser = username;
      this.bootConnection();
      this.setupPresenceForCurrentUser();
    }

    setUser(profileId, username) {
      if (this.myPresenceRef) {
        try {
          this.myPresenceRef.set({ online: false, username: this.currentUser, lastSeen: Date.now() });
        } catch (e) {}
      }
      this.currentProfileId = profileId;
      this.currentUser = username;
      this.setupPresenceForCurrentUser();
      this.emit({ source: 'auth' });
    }

    clearUserPresence() {
      if (this.myPresenceRef) {
        try {
          this.myPresenceRef.set({ online: false, username: this.currentUser, lastSeen: Date.now() });
        } catch (e) {}
      }
      this.currentProfileId = null;
      this.currentUser = null;
    }

    isProfileOnline(profileId) {
      const info = this.partnerPresence[profileId];
      return Boolean(info && info.online === true);
    }

    connectFirebase() {
      if (typeof window.firebase === 'undefined' || !window.firebase.database) {
        this.status = 'error';
        this.firebaseError = 'Cargando SDK de Firebase... revisa conexión a internet.';
        this.emit({ source: 'status' });
        return;
      }

      try {
        this.status = 'connecting';
        this.firebaseError = null;
        this.emit({ source: 'status' });

        const appName = 'cashew_private_rt_' + Date.now();
        this.fbApp = window.firebase.initializeApp(this.fbConfig, appName);
        this.db = this.fbApp.database();

        this.workspaceRef = this.db.ref(WORKSPACE_PATH);
        this.presenceRootRef = this.db.ref(PRESENCE_PATH);
        this.connectedRef = this.db.ref('.info/connected');
        this.mediaRef = this.db.ref(CHAT_MEDIA_PATH);

        this.db.ref('.info/serverTimeOffset').on('value', (snap) => {
          this.serverTimeOffset = Number(snap.val()) || 0;
        });

        this.connectedRef.on('value', (snap) => {
          if (snap.val() === true) {
            this.status = 'live';
            this.firebaseError = null;
            this.log('Conectado en tiempo real a Firebase privado');
            this.setupPresenceForCurrentUser();
            this.pruneExpiredChatMedia();
          } else if (this.status === 'live') {
            this.status = 'offline';
          }
          this.emit({ source: 'status' });
        });

        this.presenceRootRef.on('value', (snap) => {
          this.partnerPresence = snap.val() || {};
          this.emit({ source: 'presence' });
        });

        this.workspaceRef.on(
          'value',
          (snapshot) => {
            const val = snapshot.val();
            this.status = 'live';
            this.firebaseError = null;
            this.lastSyncAt = Date.now();

            if (val && val.chatMessages) {
              this.pruneExpiredChatMessagesFromCloud(val);
            }

            if (!val) {
              this.pushFullStateToFirebase('Espacio inicializado en Firebase');
              this.emit({ source: 'cloud_init' });
              return;
            }

            const remoteState = this.firebaseSnapshotToState(val);
            if (!remoteState) {
              this.pushFullStateToFirebase('Espacio inicializado en Firebase');
              return;
            }

            const mergeRes = this.mergeStates(this.state, remoteState);

            if (mergeRes.needFullPush) {
              this.pushFullStateToFirebase('Sincronizando respaldo completo');
              return;
            }

            if (mergeRes.localItemsToPush && mergeRes.localItemsToPush.length > 0) {
              this.pushBatchItemsToFirebase(mergeRes.localItemsToPush, 'Sincronizando cambios locales');
            }

            if (mergeRes.changedFromLocal) {
              this.state = mergeRes.merged;
              this.saveLocalState();
              const isRemoteAuthor = val.meta && val.meta.lastClientId && val.meta.lastClientId !== clientId;
              const isChat = val.meta && String(val.meta.lastLabel || '').startsWith('💬');
              this.emit({
                source: isRemoteAuthor ? (isChat ? 'realtime_chat' : 'realtime') : 'cloud_pull',
                by: val.meta ? val.meta.updatedBy : null,
                label: isRemoteAuthor && val.meta ? val.meta.lastLabel : null
              });
            } else {
              this.emit({ source: 'status' });
            }
          },
          (err) => {
            this.status = 'error';
            this.firebaseError = err ? err.message : 'Error de conexión';
            this.log('Error Firebase: ' + this.firebaseError);
            this.emit({ source: 'status' });
          }
        );
      } catch (err) {
        this.status = 'error';
        this.firebaseError = err.message;
        this.emit({ source: 'status' });
      }
    }

    setupPresenceForCurrentUser() {
      if (!this.db || !this.currentProfileId) return;
      try {
        this.myPresenceRef = this.db.ref(`${PRESENCE_PATH}/${this.currentProfileId}`);
        this.myPresenceRef.onDisconnect().set({
          online: false,
          username: this.currentUser || '',
          lastSeen: window.firebase.database.ServerValue.TIMESTAMP
        });
        this.myPresenceRef.set({
          online: true,
          username: this.currentUser || '',
          lastSeen: window.firebase.database.ServerValue.TIMESTAMP
        });
      } catch (e) {}
    }

    async pushFullStateToFirebase(label = 'Actualización completa') {
      if (!this.workspaceRef) return;
      try {
        this.state.isSeedOnly = false;
        const payload = this.stateToFirebaseObject(this.state);
        payload.meta.lastLabel = label;
        payload.meta.lastClientId = clientId;
        await this.workspaceRef.set(payload);
        this.lastSyncAt = Date.now();
      } catch (err) {
        this.log('Error guardando estado: ' + err.message);
      }
    }

    async pushBatchItemsToFirebase(ops, label = 'Cambio en tiempo real', extraMeta = {}) {
      if (!this.workspaceRef || (!ops.length && !Object.keys(extraMeta).length)) return;
      try {
        const updates = {
          'meta/initialized': true,
          'meta/schemaVersion': 2,
          'meta/resetEpoch': this.state.resetEpoch || 1,
          'meta/primaryCurrency': this.state.primaryCurrency || 'USD',
          'meta/appLogoUrl': this.state.appLogoUrl || '',
          'meta/rev': this.state.rev || 1,
          'meta/updatedAt': this.state.updatedAt || Date.now(),
          'meta/updatedBy': this.currentUser || 'doom1',
          'meta/lastLabel': label,
          'meta/lastClientId': clientId,
          ...extraMeta
        };
        for (const op of ops) {
          updates[`${op.collection}/${op.item.id}`] = cleanForFirebase(op.item);
        }
        await this.workspaceRef.update(updates);
        this.lastSyncAt = Date.now();
      } catch (err) {
        this.log('Error enviando delta: ' + err.message);
      }
    }

    pruneExpiredChatMessagesFromCloud(rawVal) {
      if (!this.workspaceRef || !rawVal || !rawVal.chatMessages) return;
      const thirtyDaysAgo = Date.now() - CHAT_TTL_MS;
      const keys = Object.keys(rawVal.chatMessages);
      for (const k of keys) {
        const m = rawVal.chatMessages[k];
        if (!m) continue;
        const t = Number(m.createdAt) || (m.date ? new Date(`${m.date}T${m.time || '12:00'}:00`).getTime() : 0);
        if (t && t < thirtyDaysAgo) {
          try {
            this.workspaceRef.child(`chatMessages/${k}`).remove();
            if (m.mediaKey) this.removeChatMedia(m.mediaKey);
          } catch (e) {}
        }
      }
    }

    /* ---------------- CHAT IMAGES (30-day ephemeral, separate node) ---------------- */
    newChatMediaKey() {
      return `${this.nowTs()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    uploadChatMedia(key, dataUrl) {
      if (!this.mediaRef) return Promise.reject(new Error('Sin conexión con Firebase'));
      return this.mediaRef.child(key).set({
        data: dataUrl,
        createdAt: this.nowTs(),
        by: this.currentUser || ''
      });
    }

    /* Calls cb(dataUrl) as soon as the image exists in the cloud (works even if the
       message arrives a few ms before the upload finishes). Returns an unsubscribe fn. */
    watchChatMedia(key, cb) {
      if (!this.mediaRef || !key) return () => {};
      const ref = this.mediaRef.child(key);
      const handler = (snap) => {
        const v = snap.val();
        if (v && v.data) {
          ref.off('value', handler);
          cb(v.data);
        }
      };
      ref.on('value', handler);
      return () => ref.off('value', handler);
    }

    removeChatMedia(key) {
      if (!this.mediaRef || !key) return;
      try { this.mediaRef.child(key).remove(); } catch (e) {}
    }

    /* Deletes every chat image older than 30 days using the timestamp-prefixed keys
       (orderByKey needs no index and only downloads the expired range). */
    pruneExpiredChatMedia() {
      if (!this.mediaRef || this.mediaSweepDone) return;
      this.mediaSweepDone = true;
      const limitKey = String(Date.now() - CHAT_TTL_MS);
      this.mediaRef.orderByKey().endAt(limitKey).once('value').then((snap) => {
        const updates = {};
        snap.forEach((child) => { updates[child.key] = null; });
        if (Object.keys(updates).length) {
          this.mediaRef.update(updates);
          this.log(`Imágenes de chat expiradas eliminadas: ${Object.keys(updates).length}`);
        }
      }).catch(() => { this.mediaSweepDone = false; });
    }

    setPrimaryCurrency(code) {
      const upper = String(code || 'USD').toUpperCase();
      this.state.primaryCurrency = upper;
      this.state.isSeedOnly = false;
      this.state.rev = (Number(this.state.rev) || 1) + 1;
      this.state.updatedAt = Date.now();
      this.saveLocalState();
      this.emit({ source: 'local' });
      this.pushBatchItemsToFirebase([], `Moneda principal: ${upper}`);
    }

    setAppLogoUrl(url) {
      const cleanUrl = String(url !== undefined ? url : (window.DEFAULT_DOOMLATER_LOGO_URL || '')).trim() || (window.DEFAULT_DOOMLATER_LOGO_URL || './logo.jpg');
      this.state.appLogoUrl = cleanUrl;
      this.state.isSeedOnly = false;
      this.state.rev = (Number(this.state.rev) || 1) + 1;
      this.state.updatedAt = this.nowTs();
      this.saveLocalState();
      this.emit({ source: 'local' });
      this.pushBatchItemsToFirebase([], cleanUrl ? 'Actualizó logo de la empresa' : 'Restauró logo original', {
        'meta/appLogoUrl': cleanUrl
      });
    }

    saveBotConfig(updates, label = 'Configuración del bot actualizada') {
      const author = this.currentUser || 'doom1';
      const now = this.nowTs();
      const current = (this.state.botConfig && typeof this.state.botConfig === 'object') ? this.state.botConfig : {};
      const nextConfig = {
        ...current,
        ...updates,
        updatedAt: now,
        updatedBy: author
      };
      this.state.botConfig = nextConfig;
      this.state.isSeedOnly = false;
      this.state.rev = (Number(this.state.rev) || 1) + 1;
      this.state.updatedAt = now;
      this.state.updatedBy = author;
      this.state.lastLabel = label;
      this.saveLocalState();
      if (this.bc) {
        this.bc.postMessage({ type: 'local_state', clientId, by: author, state: this.state });
      }
      this.emit({ source: 'local', by: author });
      this.pushBatchItemsToFirebase([], label, {
        'meta/botConfig': cleanForFirebase(nextConfig)
      });
      return nextConfig;
    }

    queueBotOutbox(item) {
      if (!this.db) return;
      try {
        const outboxRef = this.db.ref('cashew_doom_bot_outbox');
        outboxRef.push({ ...item, by: this.currentUser || 'doom1' });
      } catch (e) {
        console.warn('Error queueing outbox:', e);
      }
    }

    pullFromCloud() {
      if (!this.workspaceRef) {
        this.connectFirebase();
        return;
      }
      this.workspaceRef.once('value').then((snap) => {
        const val = snap.val();
        if (val) {
          const remoteState = this.firebaseSnapshotToState(val);
          if (remoteState) {
            const res = this.mergeStates(this.state, remoteState);
            if (res.changedFromLocal) {
              this.state = res.merged;
              this.saveLocalState();
            }
          }
        }
        this.lastSyncAt = Date.now();
        this.status = 'live';
        this.emit({ source: 'cloud_pull' });
      }).catch(() => {});
    }

    upsertEntity(collection, item, label = '') {
      const author = this.currentUser || 'doom1';
      const arr = this.state[collection] || [];
      const existing = item.id ? arr.find(x => x.id === item.id) : null;
      const now = this.nextStamp(existing);
      const createdBy = (existing && existing.createdBy) || item.createdBy || author;
      const createdByProfileId = (existing && existing.createdByProfileId) || item.createdByProfileId || this.currentProfileId || 'profile_1';

      const stamped = cleanForFirebase({
        ...item,
        id: item.id || `${collection.slice(0, 3)}_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        updatedAt: now,
        updatedBy: author,
        createdBy,
        createdByProfileId,
        profileId: (existing && existing.profileId) || item.profileId || this.currentProfileId || 'profile_1',
        createdAt: (existing && existing.createdAt) || item.createdAt || now
      });

      const idx = arr.findIndex(x => x.id === stamped.id);
      if (idx === -1) arr.push(stamped);
      else arr[idx] = stamped;
      this.state[collection] = arr;

      this.state.isSeedOnly = false;
      this.state.rev = (Number(this.state.rev) || 1) + 1;
      this.state.updatedAt = now;
      this.state.updatedBy = author;
      this.state.lastLabel = label;

      this.saveLocalState();
      if (this.bc) {
        this.bc.postMessage({ type: 'local_state', clientId, by: author, state: this.state });
      }
      this.emit({ source: 'local', by: author });
      this.pushBatchItemsToFirebase([{ collection, item: stamped }], label || `Actualizó ${collection}`);
      return stamped;
    }

    batchUpsert(ops, label = '') {
      let now = this.nowTs();
      const author = this.currentUser || 'doom1';
      const preparedOps = [];

      for (const op of ops) {
        const arr = this.state[op.collection] || [];
        const existing = op.item.id ? arr.find(x => x.id === op.item.id) : null;
        const itemTs = this.nextStamp(existing);
        now = Math.max(now, itemTs);
        const createdBy = (existing && existing.createdBy) || op.item.createdBy || author;
        const createdByProfileId = (existing && existing.createdByProfileId) || op.item.createdByProfileId || this.currentProfileId || 'profile_1';

        const stamped = cleanForFirebase({
          ...op.item,
          id: op.item.id || `${op.collection.slice(0, 3)}_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          updatedAt: now,
          updatedBy: author,
          createdBy,
          createdByProfileId,
          profileId: (existing && existing.profileId) || op.item.profileId || this.currentProfileId || 'profile_1',
          createdAt: (existing && existing.createdAt) || op.item.createdAt || now
        });

        const idx = arr.findIndex(x => x.id === stamped.id);
        if (idx === -1) arr.push(stamped);
        else arr[idx] = stamped;
        this.state[op.collection] = arr;

        preparedOps.push({ collection: op.collection, item: stamped });
      }

      this.state.isSeedOnly = false;
      this.state.rev = (Number(this.state.rev) || 1) + 1;
      this.state.updatedAt = now;
      this.state.updatedBy = author;
      this.state.lastLabel = label;

      this.saveLocalState();
      if (this.bc) {
        this.bc.postMessage({ type: 'local_state', clientId, by: author, state: this.state });
      }
      this.emit({ source: 'local', by: author });
      this.pushBatchItemsToFirebase(preparedOps, label || 'Operación sincronizada');
    }

    deleteEntity(collection, id, label = '') {
      const arr = this.state[collection];
      const existing = arr.find(x => x.id === id);
      if (!existing) return;
      return this.upsertEntity(
        collection,
        { ...existing, deleted: true },
        label || 'Elemento eliminado'
      );
    }

    async replaceEntireWorkspace(newState, label = 'Base de datos actualizada', preserveStockAndChat = false) {
      const nextEpoch = (Number(this.state.resetEpoch) || 1) + 1;
      const author = this.currentUser || 'doom1';

      const prevProfiles = this.state.profiles || [];
      const prevChat = this.state.chatMessages || [];
      const prevStock = this.state.stockItems || [];
      const prevMovs = this.state.stockMovements || [];

      const normalized = this.normalizeState(newState);
      normalized.profiles = (newState.profiles && newState.profiles.length >= 2) ? normalized.profiles : prevProfiles;
      if (preserveStockAndChat) {
        normalized.chatMessages = prevChat;
        if (!newState.stockItems || newState.stockItems.length === 0) {
          normalized.stockItems = prevStock;
          normalized.stockMovements = prevMovs;
        }
      } else if (!newState.chatMessages) {
        normalized.chatMessages = prevChat;
      }

      normalized.isSeedOnly = false;
      normalized.resetEpoch = nextEpoch;
      normalized.rev = (Number(this.state.rev) || 1) + 10;
      normalized.updatedAt = Date.now();
      normalized.updatedBy = author;
      normalized.lastLabel = label;

      this.state = normalized;
      this.saveLocalState();
      if (this.bc) {
        this.bc.postMessage({ type: 'local_state', clientId, by: author, state: this.state });
      }
      this.emit({ source: 'local', by: author });
      await this.pushFullStateToFirebase(label);
    }
  }

  window.cashewSync = new CashewSyncEngine();
})();
