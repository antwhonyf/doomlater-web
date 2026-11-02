/* ==========================================================================
   CASHEW WEB CLONE + STOCK & CHAT EN TIEMPO REAL
   Connected permanently to Firebase: https://ok-gogle-c018c-default-rtdb.firebaseio.com
   ========================================================================== */

(function () {
  const SESSION_KEY = 'cashew_doom_session_v2';
  const LEGACY_SESSION_KEY = 'cashew_doom_session_v1';
  const PREFS_KEY_PREFIX = 'cashew_doom_prefs_';
  const CHAT_READ_KEY_PREFIX = 'cashew_chat_last_read_';

  const SPANISH_ICON_KEYWORDS = {
    comida: ['cutlery', 'fast-food', 'pizza', 'sushi', 'taco', 'noodles', 'spaghetti', 'salad', 'sandwich', 'bread', 'healthy-food', 'food-tray', 'curry', 'grill'],
    mercado: ['groceries', 'shopping-cart', 'apple', 'fruit', 'milk', 'eggs', 'organic-food', 'bottles'],
    bebida: ['coffee', 'coffee-cup', 'bubble-tea', 'tea', 'fizzy-drink', 'orange-juice', 'glass-of-water', 'water-bottle', 'glass'],
    postre: ['cake', 'cupcake', 'donut', 'cookies', 'candy', 'ice-cream-cup', 'popsicle', 'popcorn'],
    banco: ['bank', 'wallet', 'cash-bill-dollar', 'coin', 'dollar-coin', 'money', 'money-bag', 'money-bag2', 'credit-card', 'crypto', 'safe-box', 'atm-machine'],
    dinero: ['cash-bill-dollar', 'coin', 'dollar-coin', 'money', 'money-bag', 'wallet', 'piggy-bank', 'charts', 'investment', 'loan'],
    compras: ['shopping', 'shopping-cart', 'price-tag', 'gift', 'gift-card', 'package', 'box', 'tshirt', 'hoodie', 'sneakers', 'dress'],
    ropa: ['tshirt', 'hoodie', 'sneakers', 'dress', 'clothes-hanger', 'high-heels', 'sandals', 'cap', 'winter-hat', 'tie', 'watch', 'necklace'],
    juegos: ['gamepad', 'portable-game-console', 'dice', 'chess', 'air-hockey', 'bowling', 'ball', 'trophy', 'robot'],
    consola: ['gamepad', 'portable-game-console', 'television', 'headphones', 'joystick'],
    tecnologia: ['laptop', 'desktop-computer', 'smartphone', 'tablet', 'headphones', 'keyboard', 'sim-card', '3d-printer', 'wifi', 'code', 'camera', 'battery-charge'],
    taller: ['gears', 'settings', 'construction-helmet', 'safety-helmet', '3d-printer', 'lightning-bolt', 'socket', 'battery-charge'],
    casa: ['house', 'home2', 'rent', 'key', 'furniture', 'double-bed', 'washing-machine', 'cleaning', 'plant', 'couch', 'cabin'],
    facturas: ['bills', 'bill', 'paper-bill', 'lightning-bolt', 'wifi', 'water-tap', 'gas-valve', 'subscription', 'oldschool-telephone'],
    transporte: ['car', 'tram', 'plane', 'taxi', 'bicycle', 'motor-bike', 'school-bus', 'locomotive', 'helicopter', 'gas-station', 'fuel', 'parking'],
    carro: ['car', 'gas-station', 'fuel', 'gasoline', 'car-key', 'car-charging-station', 'flat-tire', 'parking', 'taxi'],
    envio: ['delivery-truck', 'package', 'box', 'envelope', 'plane', 'location-pin', 'map'],
    salud: ['healthcare-and-medical', 'dental-care', 'multivitamin', 'face-mask', 'hearing-aid', 'vision', 'weight'],
    educacion: ['graduation', 'open-book', 'bookshelf', 'pen', 'pencil', 'essay', 'science', 'calculator', 'school-backpack'],
    mascotas: ['dog', 'cat', 'hamster', 'pet-bowl', 'fish', 'birdhouse'],
    regalo: ['gift', 'gift-card', 'balloons', 'celebration', 'confetti', 'bouquet', 'flower', 'heart']
  };

  function nowHHMM() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function todayLocalISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function currentYM() {
    return todayLocalISO().slice(0, 7);
  }

  const App = {
    profileId: null,              // 'profile_1' | 'profile_2'
    user: null,                   // active username string
    selectedLoginSlot: 'profile_1',
    activePage: 'home',           // home | stock | transactions | obligations | budgets | goals | analytics | accounts | profile | bot | settings
    sidebarCollapsed: false,

    // Dashboard & Analytics state
    selectedHomeWalletId: 'all',
    selectedMonthYM: currentYM(), // YYYY-MM for monthly totals & circular P&L chart
    homeChartTab: 'pnl',          // pnl | expense | income

    // Stock filters
    stockTab: 'all',              // all | para_vender | en_preparacion | insumo | out | kardex
    stockSearch: '',
    stockCategoryFilter: 'all',

    // Transactions filters
    txSearch: '',
    txTypeFilter: 'all',          // all | income | expense | transfer | correction
    txWalletFilter: 'all',
    txAuthorFilter: 'all',

    // Obligations / Upcoming / Overdue / Loans filters
    obligationTab: 'all',         // all | upcoming | overdue | subscription | credit | debt | settled

    // Category Icon Picker state
    _catModalState: null,
    _currencySearch: '',
    _quickChatOpen: false,

    // Omnichannel Bot & Inbox state
    botSubTab: 'inbox',           // inbox | faq | services | config | connect
    botActiveConvId: null,
    botChannelFilter: 'all',      // all | whatsapp | instagram | messenger | attention
    botSearchQuery: '',
    botSelectedMedia: null,       // { dataUrl, type: 'image'|'video'|'gif', name }
    botSimulatedTypingTimer: null,
    _botInited: false,

    prefs: {
      themeMode: 'dark',          // dark | amoled | light
      accentHex: '#5f85c2'
    },

    clockTimer: null,

    init() {
      this.bindLoginEvents();
      this.startSidebarClock();

      // Connect immediately to hardcoded Firebase & Official GitHub Currency API
      window.cashewSync.bootConnection();
      window.cashewCurrency.fetchOfficialRates();

      window.cashewCurrency.onUpdate(() => {
        if (this.profileId) {
          this.renderAppPreservingFocus();
        }
      });

      window.cashewSync.onChange((_state, meta) => {
        // Keep current username synced if profile was edited remotely
        if (this.profileId) {
          const myProf = this.getProfileById(this.profileId);
          if (myProf && myProf.username !== this.user) {
            this.user = myProf.username;
            window.cashewSync.currentUser = myProf.username;
          }
        }

        this.renderLoginProfiles();
        this.renderSyncIndicators();
        this.updateUnreadChatBadges();
        this.applyAppLogoToDom();

        if (meta && meta.source === 'realtime_chat') {
          if (this.activePage === 'profile' || this._quickChatOpen) {
            this.markChatAsRead();
          } else if (meta.by && meta.by !== this.user) {
            this.toast(`${meta.label || 'Nuevo mensaje en el chat'}`, 'chat');
          }
        } else if (meta && (meta.source === 'realtime' || meta.source === 'cloud_pull')) {
          if (meta.label && meta.by && meta.by !== this.user) {
            this.toast(`${meta.by}: ${meta.label}`, 'sync');
          }
        }

        if (this._quickChatOpen) {
          this.refreshQuickChatStreamIfOpen();
        }

        if (this.profileId && (!meta || meta.source !== 'presence')) {
          this.renderAppPreservingFocus();
        }
      });

      // Restore session across page reloads
      try {
        const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
        if (saved && saved.profileId) {
          const prof = this.getProfileById(saved.profileId);
          if (prof) {
            this.completeLogin(prof, false);
            return;
          }
        }
        // Migrate legacy v1 session if present
        const legacy = JSON.parse(localStorage.getItem(LEGACY_SESSION_KEY) || 'null');
        if (legacy && legacy.username) {
          const prof = this.getProfiles().find(p => p.username.toLowerCase() === String(legacy.username).toLowerCase());
          if (prof) {
            localStorage.removeItem(LEGACY_SESSION_KEY);
            this.completeLogin(prof, false);
            return;
          }
        }
      } catch (e) {}

      window.CashewTheme.apply('#5f85c2', 'dark');
      this.applyAppLogoToDom();
      this.renderLoginProfiles();
      this.selectLoginSlot('profile_1');
    },

    /* ======================================================================
       DYNAMIC PROFILES & AUTHENTICATION (Editable Username & Password!)
       ====================================================================== */
    get st() {
      return window.cashewSync.state;
    },

    getProfiles() {
      const list = (this.st.profiles || []).filter(Boolean);
      if (list.length >= 2) {
        return [...list].sort((a, b) => (a.slot || 1) - (b.slot || 2));
      }
      return window.createDefaultProfilesList();
    },

    getProfileById(profileId) {
      return this.getProfiles().find(p => p.id === profileId) || null;
    },

    getCurrentProfile() {
      return this.getProfileById(this.profileId) || this.getProfiles()[0];
    },

    getPartnerProfile() {
      const profiles = this.getProfiles();
      return profiles.find(p => p.id !== this.profileId) || profiles[1] || profiles[0];
    },

    isMasterAdmin() {
      const me = this.getCurrentProfile();
      if (!me) return false;
      return me.id === 'profile_1' || me.username === 'doom1' || (me.role && me.role.toLowerCase() === 'admin');
    },

    canUserDirectlyMutate(collection, entityId) {
      if (this.isMasterAdmin()) return true;
      if (!entityId) return true;
      const me = this.getCurrentProfile();
      if (!me) return true;
      const list = this.activeList(collection) || [];
      const item = list.find(x => x.id === entityId);
      if (!item) return true;

      const creatorProfile = item.createdByProfileId || item.profileId;
      const creatorUser = (item.createdBy || '').toLowerCase();
      const myUser = (me.username || '').toLowerCase();

      // doom2 can mutate items they created
      if (creatorProfile === me.id || creatorUser === myUser) {
        return true;
      }
      return false;
    },

    submitApprovalRequest(collection, entityId, action, proposedData, summary) {
      const me = this.getCurrentProfile();
      const partner = this.getPartnerProfile();
      const req = {
        id: `appr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        collection,
        entityId,
        action, // 'update' | 'delete'
        proposedData: proposedData ? { ...proposedData } : null,
        summary: summary || `${action === 'delete' ? 'Eliminar' : 'Modificar'} en ${collection}`,
        requestedBy: me ? me.username : 'doom2',
        requestedByProfileId: me ? me.id : 'profile_2',
        requestedByName: me ? (me.displayName || me.username) : 'Sebastián',
        targetProfileId: partner ? partner.id : 'profile_1',
        status: 'pending',
        createdAt: Date.now()
      };
      window.cashewSync.upsertEntity('approvalRequests', req, `Solicitud: ${req.summary}`);
      return req;
    },

    approveRequest(reqId) {
      this._resolvedApprovalIds = this._resolvedApprovalIds || new Set();
      if (this._resolvedApprovalIds.has(reqId)) return; // double-click guard
      const req = (this.st.approvalRequests || []).find(x => x && x.id === reqId);
      if (!req || req.deleted) {
        this._resolvedApprovalIds.add(reqId);
        this.renderAll();
        return;
      }
      // Hide instantly in the UI (optimistic), then apply everything in ONE atomic cloud write
      this._resolvedApprovalIds.add(reqId);

      const ops = [];
      const target = (this.st[req.collection] || []).find(x => x && x.id === req.entityId);
      if (req.action === 'delete') {
        if (target && !target.deleted) {
          ops.push({ collection: req.collection, item: { ...target, deleted: true } });
        }
      } else if (req.action === 'update' && req.proposedData && !(target && target.deleted)) {
        ops.push({
          collection: req.collection,
          item: { ...(target || {}), ...req.proposedData, id: req.entityId }
        });
      }
      ops.push({
        collection: 'approvalRequests',
        item: { ...req, status: 'approved', resolvedAt: window.cashewSync.nowTs(), resolvedBy: this.user, deleted: true }
      });

      window.cashewSync.batchUpsert(ops, `Cambio confirmado: ${req.summary || ''}`);
      this.toast('Cambio confirmado y aplicado al instante', 'check_circle');
      this.renderAll();
    },

    rejectRequest(reqId) {
      this._resolvedApprovalIds = this._resolvedApprovalIds || new Set();
      if (this._resolvedApprovalIds.has(reqId)) return;
      this._resolvedApprovalIds.add(reqId);
      const req = (this.st.approvalRequests || []).find(x => x && x.id === reqId);
      if (req && !req.deleted) {
        window.cashewSync.upsertEntity('approvalRequests', {
          ...req,
          status: 'rejected',
          resolvedAt: window.cashewSync.nowTs(),
          resolvedBy: this.user,
          deleted: true
        }, `Solicitud descartada: ${req.summary || ''}`);
      }
      this.toast('Solicitud descartada', 'cancel');
      this.renderAll();
    },

    getPendingApprovals() {
      const resolved = this._resolvedApprovalIds || new Set();
      return (this.activeList('approvalRequests') || [])
        .filter(r => (!r.status || r.status === 'pending') && !resolved.has(r.id));
    },

    renderPendingApprovalsBannerHTML() {
      const pending = this.getPendingApprovals();
      if (!pending.length) return '';

      const me = this.getCurrentProfile();
      const isAdmin = this.isMasterAdmin();

      if (isAdmin) {
        return `
          <section class="card pending-approvals-card" style="margin-bottom:20px; border:1.5px solid rgba(239, 108, 0, 0.45); background:linear-gradient(135deg, rgba(239, 108, 0, 0.08), rgba(255, 179, 0, 0.05));">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; flex-wrap:wrap; gap:8px;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span class="material-symbols-rounded" style="color:#ef6c00; font-size:26px;">pending_actions</span>
                <div>
                  <h3 style="margin:0; font-size:16px; font-weight:800; color:var(--text-main);">
                    Solicitudes de Modificación Pendientes (${pending.length})
                  </h3>
                  <div style="font-size:12.5px; color:var(--text-muted);">
                    Tu compañero ha solicitado cambios en registros compartidos. Puedes revisarlos, confirmarlos o descartarlos en tiempo real.
                  </div>
                </div>
              </div>
            </div>
            <div style="display:flex; flex-direction:column; gap:10px;">
              ${pending.map(r => `
                <div style="display:flex; align-items:center; justify-content:space-between; padding:12px 14px; background:var(--bg-card); border-radius:12px; border:1px solid var(--border-color); flex-wrap:wrap; gap:10px;">
                  <div style="display:flex; align-items:center; gap:10px; min-width:220px; flex:1;">
                    <span class="material-symbols-rounded" style="color:${r.action === 'delete' ? 'var(--cashew-expense)' : 'var(--primary)'}; font-size:22px;">
                      ${r.action === 'delete' ? 'delete' : 'edit'}
                    </span>
                    <div>
                      <div style="font-weight:700; font-size:14px; color:var(--text-main);">${this.escapeHtml(r.summary || 'Solicitud')}</div>
                      <div style="font-size:11.5px; color:var(--text-muted);">
                        Solicitado por: <strong>${this.escapeHtml(r.requestedByName || r.requestedBy || 'Compañero')}</strong> • ${new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                  <div style="display:flex; gap:8px;">
                    <button class="btn-cashew btn-primary btn-sm" onclick="CashewApp.approveRequest('${r.id}')" style="padding:6px 14px; font-size:12.5px;">
                      <span class="material-symbols-rounded" style="font-size:16px;">check</span> Confirmar y Aplicar
                    </button>
                    <button class="btn-cashew btn-surface btn-sm" onclick="CashewApp.rejectRequest('${r.id}')" style="padding:6px 12px; font-size:12.5px; color:var(--cashew-expense);">
                      <span class="material-symbols-rounded" style="font-size:16px;">close</span> Descartar
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          </section>
        `;
      }

      // If doom2 (partner) - Notice: NO mention of 'admin', perfectly collaborative phrasing!
      const myPending = pending.filter(r => r.requestedByProfileId === me.id || r.requestedBy === me.username);
      if (!myPending.length) return '';

      return `
        <section class="card pending-approvals-card" style="margin-bottom:20px; border:1.5px solid rgba(95, 133, 194, 0.4); background:rgba(95, 133, 194, 0.08); padding:14px 18px;">
          <div style="display:flex; align-items:center; gap:12px;">
            <span class="material-symbols-rounded" style="color:var(--primary); font-size:24px;">hourglass_top</span>
            <div style="flex:1;">
              <h4 style="margin:0; font-size:14.5px; font-weight:800; color:var(--text-main);">
                Solicitudes de cambio en espera de confirmación (${myPending.length})
              </h4>
              <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">
                Tus propuestas de modificación en registros compartidos están esperando la confirmación de tu compañero.
              </div>
              <div style="margin-top:8px; display:flex; flex-wrap:wrap; gap:6px;">
                ${myPending.map(r => `
                  <span style="display:inline-flex; align-items:center; gap:4px; padding:4px 8px; border-radius:8px; background:var(--bg-card); font-size:11.5px; border:1px solid var(--border-color);">
                    <span class="material-symbols-rounded" style="font-size:13px; color:var(--primary);">schedule</span>
                    ${this.escapeHtml(r.summary)}
                  </span>
                `).join('')}
              </div>
            </div>
          </div>
        </section>
      `;
    },

    getAvatarInitials(name) {
      const clean = String(name || 'D1').trim();
      if (/^doom[12]$/i.test(clean)) return ('D' + clean.slice(-1)).toUpperCase();
      const parts = clean.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      return clean.slice(0, 2).toUpperCase();
    },

    getProfileAvatarHTML(profile, size = 42, customClass = '') {
      if (!profile) {
        return `<div class="profile-mini-avatar ${customClass}" style="width:${size}px; height:${size}px; font-size:${Math.round(size * 0.42)}px;">?</div>`;
      }
      const name = profile.displayName || profile.username || 'Socio';
      const initials = this.getAvatarInitials(name);
      const url = profile.avatarUrl && String(profile.avatarUrl).trim();
      if (url && (/^https?:\/\//i.test(url) || /^data:image\//i.test(url))) {
        return `
          <div class="profile-mini-avatar ${customClass}" style="width:${size}px; height:${size}px; padding:0; overflow:hidden; border-radius:${Math.round(size * 0.32)}px; background:var(--primary-container); flex-shrink:0;">
            <img src="${this.escapeHtml(url)}" alt="${this.escapeHtml(name)}"
                 style="width:100%; height:100%; object-fit:cover; display:block;"
                 onerror="this.onerror=null; this.parentElement.innerHTML='<span style=\\'font-size:${Math.round(size * 0.42)}px; font-weight:800;\\'>${this.escapeHtml(initials)}</span>';" />
          </div>
        `;
      }
      return `<div class="profile-mini-avatar ${customClass}" style="width:${size}px; height:${size}px; font-size:${Math.round(size * 0.42)}px; border-radius:${Math.round(size * 0.32)}px; flex-shrink:0;">${this.escapeHtml(initials)}</div>`;
    },

    getAppLogoUrl() {
      const custom = (this.st && typeof this.st.appLogoUrl === 'string') ? this.st.appLogoUrl.trim() : '';
      return custom || (window.DEFAULT_DOOMLATER_LOGO_URL || './logo.jpg');
    },

    getAppLogoHTML(size = 34) {
      const url = this.getAppLogoUrl();
      if (url && (/^https?:\/\//i.test(url) || /^data:image\//i.test(url) || /^\.\//.test(url))) {
        return `<img src="${this.escapeHtml(url)}" alt="Doomlater.Corp Logo"
                     style="width:${size}px; height:${size}px; object-fit:contain; border-radius:${Math.round(size * 0.28)}px;"
                     onerror="this.onerror=null; this.src='./logo.jpg';" />`;
      }
      return `<img src="./logo.jpg" alt="Doomlater.Corp Logo"
                   style="width:${size}px; height:${size}px; object-fit:contain; border-radius:${Math.round(size * 0.28)}px;" />`;
    },

    applyAppLogoToDom(url) {
      const cleanUrl = String(url !== undefined ? url : (this.getAppLogoUrl() || '')).trim();
      const targetSrc = (cleanUrl && (/^https?:\/\//i.test(cleanUrl) || /^data:image\//i.test(cleanUrl) || /^\.\//.test(cleanUrl))) ? cleanUrl : './logo.jpg';

      const fav1 = document.getElementById('appFavicon');
      const fav2 = document.getElementById('appFaviconShortcut');
      const fav192 = document.getElementById('appFavicon192');
      const fav512 = document.getElementById('appFavicon512');
      if (fav1) fav1.href = targetSrc;
      if (fav2) fav2.href = targetSrc;
      if (fav192) fav192.href = targetSrc;
      if (fav512) fav512.href = targetSrc;

      const authImg = document.getElementById('authBrandLogoImg');
      if (authImg) authImg.src = targetSrc;

      const sideImg = document.getElementById('sidebarBrandLogoImg');
      if (sideImg) sideImg.src = targetSrc;
    },

    onAppLogoPreview(url) {
      this._appLogoDraft = url;
      const box = document.getElementById('appLogoPreviewBox');
      if (!box) return;
      const src = (url && (/^https?:\/\//i.test(url) || /^data:image\//i.test(url) || /^\.\//.test(url))) ? url : './logo.jpg';
      box.innerHTML = `<img src="${this.escapeHtml(src)}" style="width:100%; height:100%; object-fit:contain; border-radius:12px;" onerror="this.onerror=null; this.src='./logo.jpg';" />`;
      this.applyAppLogoToDom(url);
    },

    async onAppLogoFilePicked(event) {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        const res = await this.compressImageFile(file, 256, 0.85);
        this._appLogoDraft = res.dataUrl;
        const inp = document.getElementById('appLogoUrlInput');
        if (inp) inp.value = res.dataUrl;
        this.onAppLogoPreview(res.dataUrl);
        this.toast('Logo cargado: pulsa Guardar Logo para aplicarlo en todos los dispositivos', 'photo_camera');
      } catch (err) {
        this.toast('No se pudo cargar la imagen del logo: ' + err.message, 'error');
      }
    },

    saveAppLogo() {
      const inp = document.getElementById('appLogoUrlInput');
      const url = inp ? inp.value.trim() : (this._appLogoDraft || '');
      if (url && !/^https?:\/\//i.test(url) && !/^data:image\//i.test(url) && !/^\.\//.test(url)) {
        this.toast('El enlace del logo debe empezar con https:// o ser una imagen válida', 'error');
        return;
      }
      window.cashewSync.setAppLogoUrl(url || window.DEFAULT_DOOMLATER_LOGO_URL);
      this._appLogoDraft = undefined;
      this.applyAppLogoToDom(url);
      this.renderAll();
      this.toast('¡Logo actualizado en el inicio de sesión y en la pestaña del navegador!', 'check_circle');
    },

    resetAppLogo() {
      const defaultUrl = window.DEFAULT_DOOMLATER_LOGO_URL || './logo.jpg';
      window.cashewSync.setAppLogoUrl(defaultUrl);
      this._appLogoDraft = undefined;
      const inp = document.getElementById('appLogoUrlInput');
      if (inp) inp.value = defaultUrl;
      this.onAppLogoPreview(defaultUrl);
      this.applyAppLogoToDom(defaultUrl);
      this.renderAll();
      this.toast('Logo predeterminado de Doomlater.Corp restaurado', 'restart_alt');
    },

    renderLoginProfiles() {
      const grid = document.getElementById('loginProfilesGrid');
      if (grid) {
        const profiles = this.getProfiles();
        grid.innerHTML = profiles.map(p => {
          const isSel = this.selectedLoginSlot === p.id;
          const online = window.cashewSync.isProfileOnline(p.id);
          return `
            <button type="button" class="profile-pick-card ${isSel ? 'active' : ''}" data-slot="${p.id}"
                    onclick="CashewApp.selectLoginSlot('${p.id}')">
              <div style="position:relative; width:48px; height:48px; margin:0 auto 8px auto;">
                ${this.getProfileAvatarHTML(p, 48)}
                ${online ? `<span style="position:absolute; bottom:-1px; right:-1px; width:11px; height:11px; border-radius:50%; background:var(--cashew-income); border:2px solid var(--bg-card); z-index:2;"></span>` : ''}
              </div>
              <div class="profile-pick-name">${this.escapeHtml(p.displayName || p.username)}</div>
              <div class="profile-pick-role">@${this.escapeHtml(p.username)} • ${this.escapeHtml(p.role || 'Socio')}</div>
            </button>
          `;
        }).join('');

        // Keep username field synced with selected slot if login overlay is open & user hasn't typed custom text
        const overlay = document.getElementById('authOverlay');
        const userInp = document.getElementById('loginUsername');
        if (overlay && !overlay.classList.contains('hidden') && userInp && document.activeElement !== userInp) {
          const selProf = this.getProfileById(this.selectedLoginSlot);
          if (selProf) userInp.value = selProf.username;
        }
      }

      const dot = document.getElementById('loginSyncDot');
      const lbl = document.getElementById('loginSyncLabel');
      if (dot && lbl) {
        const st = window.cashewSync.status;
        dot.className = 'pulse-dot ' + (st === 'live' ? '' : st === 'connecting' ? 'syncing' : 'offline');
        lbl.textContent = st === 'live'
          ? 'Nube privada sincronizada en tiempo real'
          : st === 'connecting'
            ? 'Conectando a base de datos privada...'
            : 'Modo caché local activo (reconectando...)';
      }
    },

    bindLoginEvents() {
      const form = document.getElementById('loginForm');
      if (form) {
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          this.attemptLogin();
        });
      }
    },

    selectLoginSlot(profileId) {
      this.selectedLoginSlot = profileId;
      const prof = this.getProfileById(profileId);
      document.querySelectorAll('.profile-pick-card').forEach(el => {
        el.classList.toggle('active', el.dataset.slot === profileId);
      });
      const userInp = document.getElementById('loginUsername');
      const passInp = document.getElementById('loginPassword');
      const errBox = document.getElementById('loginError');
      if (errBox) errBox.classList.remove('visible');
      if (userInp && prof) userInp.value = prof.username;
      if (passInp) {
        passInp.value = '';
        setTimeout(() => passInp.focus(), 40);
      }
    },

    attemptLogin() {
      const userInp = document.getElementById('loginUsername');
      const passInp = document.getElementById('loginPassword');
      const errBox = document.getElementById('loginError');

      const typedUser = (userInp ? userInp.value : '').trim().toLowerCase();
      const typedPass = (passInp ? passInp.value : '').trim();

      const matched = this.getProfiles().find(p =>
        String(p.username || '').trim().toLowerCase() === typedUser &&
        String(p.password || '') === typedPass
      );

      if (!matched) {
        if (errBox) {
          errBox.classList.remove('visible');
          void errBox.offsetWidth;
          errBox.classList.add('visible');
        }
        return;
      }

      this.completeLogin(matched, true);
    },

    completeLogin(profile, showWelcomeToast = true) {
      this.profileId = profile.id;
      this.user = profile.username;
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        profileId: profile.id,
        username: profile.username,
        loginAt: Date.now()
      }));

      try {
        const savedPrefs = JSON.parse(localStorage.getItem(PREFS_KEY_PREFIX + profile.id) || 'null');
        this.prefs = {
          themeMode: (savedPrefs && savedPrefs.themeMode) || 'dark',
          accentHex: (savedPrefs && savedPrefs.accentHex) || profile.defaultAccent || '#5f85c2'
        };
      } catch (e) {
        this.prefs = { themeMode: 'dark', accentHex: profile.defaultAccent || '#5f85c2' };
      }

      window.CashewTheme.apply(this.prefs.accentHex, this.prefs.themeMode);

      const overlay = document.getElementById('authOverlay');
      if (overlay) overlay.classList.add('hidden');

      if (!window.cashewSync.currentProfileId) {
        window.cashewSync.start(profile.id, profile.username);
      } else {
        window.cashewSync.setUser(profile.id, profile.username);
      }

      this.renderAll();
      this.updateUnreadChatBadges();

      if (showWelcomeToast) {
        this.toast(`Bienvenido, ${profile.displayName || profile.username} • Nube en vivo`, 'verified_user');
      }
    },

    logout() {
      localStorage.removeItem(SESSION_KEY);
      window.cashewSync.clearUserPresence();
      this.profileId = null;
      this.user = null;
      this._ownAvatarDraft = undefined;
      this._loginPhotoDrafts = {};
      this._quickChatOpen = false;
      this.closeModal();
      const overlay = document.getElementById('authOverlay');
      if (overlay) overlay.classList.remove('hidden');
      this.renderLoginProfiles();
      this.selectLoginSlot('profile_1');
    },

    savePrefs(patch) {
      this.prefs = { ...this.prefs, ...patch };
      if (this.profileId) {
        localStorage.setItem(PREFS_KEY_PREFIX + this.profileId, JSON.stringify(this.prefs));
      }
      window.CashewTheme.apply(this.prefs.accentHex, this.prefs.themeMode);
      this.renderAll();
    },

    /* ======================================================================
       MULTI-CURRENCY, FINANCIAL, HEATMAP & STOCK SELECTORS
       ====================================================================== */
    activeList(col) {
      return (this.st[col] || []).filter(item => item && !item.deleted);
    },

    get primaryCurrency() {
      return window.cashewCurrency.getPrimaryCurrency();
    },

    get primarySymbol() {
      return window.cashewCurrency.getSymbol(this.primaryCurrency);
    },

    fmtMoney(num, symbol = null) {
      const sym = symbol !== null ? symbol : this.primarySymbol;
      const val = Number(num) || 0;
      const abs = Math.abs(val).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
      return val < 0 ? `-${sym}${abs}` : `${sym}${abs}`;
    },

    fmtWalletAmount(num, wallet) {
      const code = (wallet && wallet.currency) ? wallet.currency : this.primaryCurrency;
      const sym = window.cashewCurrency.getSymbol(code);
      return this.fmtMoney(num, sym);
    },

    escapeHtml(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    getWalletById(id) {
      return this.activeList('wallets').find(w => w.id === id) || null;
    },

    getCategoryById(id) {
      if (String(id) === '0') {
        return this.activeList('categories').find(c => String(c.id) === '0') || {
          id: '0',
          name: 'Corrección de Balance',
          type: 'both',
          color: '#607d8b',
          iconPng: 'charts.png',
          icon: 'tune'
        };
      }
      return this.activeList('categories').find(c => c.id === id) || {
        id: 'c_default',
        name: 'General',
        color: '#5f85c2',
        iconPng: 'coin.png',
        icon: 'category'
      };
    },

    isTxEffective(tx) {
      if (!tx || tx.deleted) return false;
      if (tx.paid === false) return false;
      return true;
    },

    txToPrimary(amount, walletId) {
      const w = this.getWalletById(walletId);
      const fromCode = w ? w.currency : this.primaryCurrency;
      return window.cashewCurrency.toPrimary(amount, fromCode);
    },

    /* Wallet balance in the wallet's own native currency */
    getWalletBalance(walletId) {
      const w = this.getWalletById(walletId);
      if (!w) return 0;
      let bal = Number(w.startingBalance) || 0;
      for (const tx of this.activeList('transactions')) {
        if (!this.isTxEffective(tx)) continue;
        const amt = Number(tx.amount) || 0;
        if (tx.type === 'income' && tx.walletId === walletId) {
          bal += amt;
        } else if (tx.type === 'expense' && tx.walletId === walletId) {
          bal -= amt;
        } else if (tx.type === 'transfer') {
          if (tx.walletId === walletId) bal -= amt;
          if (tx.toWalletId === walletId) {
            const fromW = this.getWalletById(tx.walletId);
            const convertedIn = (fromW && fromW.currency !== w.currency)
              ? window.cashewCurrency.convert(amt, fromW.currency, w.currency)
              : amt;
            bal += convertedIn;
          }
        }
      }
      return bal;
    },

    /* Total Net Worth converted accurately to Primary Currency (or single wallet native if selected) */
    getTotalNetWorth(filterWalletId = 'all') {
      if (filterWalletId && filterWalletId !== 'all') {
        return this.getWalletBalance(filterWalletId);
      }
      const wallets = this.activeList('wallets');
      return wallets.reduce((sum, w) => {
        const nativeBal = this.getWalletBalance(w.id);
        return sum + window.cashewCurrency.toPrimary(nativeBal, w.currency || 'USD');
      }, 0);
    },

    getDisplaySymbolForFilter(filterWalletId = 'all') {
      if (filterWalletId && filterWalletId !== 'all') {
        const w = this.getWalletById(filterWalletId);
        if (w) return window.cashewCurrency.getSymbol(w.currency);
      }
      return this.primarySymbol;
    },

    convertTxForFilter(tx, filterWalletId = 'all') {
      const amt = Number(tx.amount) || 0;
      if (filterWalletId && filterWalletId !== 'all') {
        return amt;
      }
      return this.txToPrimary(amt, tx.walletId);
    },

    /* Monthly Income, Expense, Net Profit/Loss & Category Slices */
    getMonthCashflow(filterWalletId = 'all', ym = null) {
      const targetYM = ym || this.selectedMonthYM || currentYM();
      let income = 0;
      let expense = 0;
      let realizedProfit = 0;
      const expByCat = new Map();
      const incByCat = new Map();

      for (const tx of this.activeList('transactions')) {
        if (!this.isTxEffective(tx)) continue;
        if (!(tx.date || '').startsWith(targetYM)) continue;
        if (filterWalletId !== 'all' && tx.walletId !== filterWalletId && tx.toWalletId !== filterWalletId) {
          continue;
        }
        // Exclude pure balance corrections from spending/income distortion if user wants, OR include only real income/expense
        const isCorrection = tx.isBalanceCorrection || String(tx.categoryId) === '0';
        const val = this.convertTxForFilter(tx, filterWalletId);
        const cat = this.getCategoryById(tx.categoryId);

        if (tx.type === 'income' && !isCorrection) {
          income += val;
          if (tx.costBasis !== undefined && tx.costBasis !== null) {
            const costConv = filterWalletId !== 'all'
              ? Number(tx.costBasis)
              : this.txToPrimary(Number(tx.costBasis), tx.walletId);
            realizedProfit += (val - costConv);
          }
          const prev = incByCat.get(cat.id) || { id: cat.id, name: cat.name, color: cat.color, value: 0 };
          prev.value += val;
          incByCat.set(cat.id, prev);
        } else if (tx.type === 'expense' && !isCorrection) {
          expense += val;
          const prev = expByCat.get(cat.id) || { id: cat.id, name: cat.name, color: cat.color, value: 0 };
          prev.value += val;
          expByCat.set(cat.id, prev);
        }
      }

      return {
        ym: targetYM,
        income,
        expense,
        net: income - expense,
        realizedProfit,
        expSlices: Array.from(expByCat.values()).sort((a, b) => b.value - a.value),
        incSlices: Array.from(incByCat.values()).sort((a, b) => b.value - a.value)
      };
    },

    /* Daily Map for Cashew Calendar Heatmap */
    getDailyHeatmapMap(filterWalletId = 'all') {
      const map = {};
      for (const tx of this.activeList('transactions')) {
        if (!this.isTxEffective(tx)) continue;
        if (filterWalletId !== 'all' && tx.walletId !== filterWalletId && tx.toWalletId !== filterWalletId) continue;
        const iso = (tx.date || '').slice(0, 10);
        if (!iso) continue;
        if (!map[iso]) map[iso] = { net: 0, income: 0, expense: 0, count: 0 };
        const val = this.convertTxForFilter(tx, filterWalletId);
        if (tx.type === 'income') {
          map[iso].income += val;
          map[iso].net += val;
          map[iso].count += 1;
        } else if (tx.type === 'expense') {
          map[iso].expense += val;
          map[iso].net -= val;
          map[iso].count += 1;
        } else if (tx.type === 'transfer') {
          map[iso].count += 1;
        }
      }
      return map;
    },

    /* Upcoming, Overdue, Subscriptions, Credits (Lent) & Debts (Borrowed) */
    getObligationsSummary() {
      const today = todayLocalISO();
      const all = this.activeList('obligations').sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));

      const overdue = [];
      const upcoming = [];
      const subscriptions = [];
      const credits = [];
      const debts = [];
      const settled = [];

      let overdueTotal = 0;
      let upcomingTotal = 0;
      let creditsTotal = 0;
      let debtsTotal = 0;

      for (const ob of all) {
        const val = this.txToPrimary(Number(ob.amount) || 0, ob.walletId);
        const isOverdue = !ob.settled && ob.dueDate && ob.dueDate < today;

        if (ob.settled) {
          settled.push(ob);
          continue;
        }
        if (isOverdue) {
          overdue.push(ob);
          overdueTotal += val;
        }
        if (ob.kind === 'upcoming' || ob.kind === 'subscription') {
          if (!isOverdue) {
            upcoming.push(ob);
            upcomingTotal += val;
          }
          if (ob.kind === 'subscription') subscriptions.push(ob);
        } else if (ob.kind === 'credit') {
          credits.push(ob);
          creditsTotal += val;
        } else if (ob.kind === 'debt') {
          debts.push(ob);
          debtsTotal += val;
        }
      }

      return {
        all,
        overdue,
        upcoming,
        subscriptions,
        credits,
        debts,
        settled,
        overdueTotal,
        upcomingTotal,
        creditsTotal,
        debtsTotal,
        pendingAlertCount: overdue.length + upcoming.length
      };
    },

    getStockSummary() {
      const items = this.activeList('stockItems');
      let retailValue = 0;
      let investedCapital = 0;
      let expectedProfit = 0;
      let readyUnits = 0;
      let prepUnits = 0;
      let lowStockCount = 0;

      for (const it of items) {
        const qty = Math.max(0, Number(it.stock) || 0);
        const unitCost = (Number(it.purchaseCost) || 0) + (Number(it.extraCost) || 0);
        const unitSale = Number(it.salePrice) || 0;

        if (it.kind === 'para_vender') {
          readyUnits += qty;
          retailValue += qty * unitSale;
          investedCapital += qty * unitCost;
          expectedProfit += qty * (unitSale - unitCost);
        } else if (it.kind === 'en_preparacion') {
          prepUnits += qty;
          investedCapital += qty * unitCost;
          retailValue += qty * unitSale;
          expectedProfit += qty * (unitSale - unitCost);
        } else {
          investedCapital += qty * unitCost;
        }

        if (qty <= (Number(it.minStock) || 0)) {
          lowStockCount++;
        }
      }

      return {
        totalItems: items.length,
        retailValue,
        investedCapital,
        expectedProfit,
        readyUnits,
        prepUnits,
        lowStockCount
      };
    },

    getNetWorthSeries(filterWalletId = 'all', days = 16) {
      const currentTotal = this.getTotalNetWorth(filterWalletId);
      const txs = this.activeList('transactions');
      const today = new Date();
      today.setHours(12, 0, 0, 0);

      const dailyDelta = {};
      for (const tx of txs) {
        if (!this.isTxEffective(tx)) continue;
        if (filterWalletId !== 'all' && tx.walletId !== filterWalletId && tx.toWalletId !== filterWalletId) continue;
        const dKey = (tx.date || '').slice(0, 10);
        if (!dKey) continue;
        const amt = this.convertTxForFilter(tx, filterWalletId);
        let delta = 0;
        if (tx.type === 'income') delta = amt;
        else if (tx.type === 'expense') delta = -amt;
        else if (tx.type === 'transfer' && filterWalletId !== 'all') {
          delta = tx.toWalletId === filterWalletId ? amt : -amt;
        }
        dailyDelta[dKey] = (dailyDelta[dKey] || 0) + delta;
      }

      const temp = [];
      let running = currentTotal;
      for (let i = 0; i < days; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const label = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
        temp.push({ label, value: running });
        running -= (dailyDelta[iso] || 0);
      }
      return temp.reverse();
    },

    /* ======================================================================
       CHAT UNREAD TRACKING & CLOCK / NAVIGATION
       ====================================================================== */
    getUnreadChatCount() {
      if (!this.profileId) return 0;
      const lastRead = Number(localStorage.getItem(CHAT_READ_KEY_PREFIX + this.profileId) || 0);
      return this.activeList('chatMessages').filter(m =>
        m.senderProfileId !== this.profileId && (Number(m.createdAt) || 0) > lastRead
      ).length;
    },

    markChatAsRead() {
      if (!this.profileId) return;
      localStorage.setItem(CHAT_READ_KEY_PREFIX + this.profileId, String(Date.now() + 500));
      this.updateUnreadChatBadges();
    },

    updateUnreadChatBadges() {
      const count = this.getUnreadChatCount();
      for (const id of ['navChatBadge', 'fabChatBadge', 'mobChatBadge']) {
        const el = document.getElementById(id);
        if (el) {
          if (count > 0) {
            el.style.display = 'inline-flex';
            el.textContent = count > 99 ? '99+' : String(count);
          } else {
            el.style.display = 'none';
          }
        }
      }
    },

    startSidebarClock() {
      const tick = () => {
        const now = new Date();
        const elTime = document.getElementById('sidebarClockTime');
        const elDate = document.getElementById('sidebarClockDate');
        if (elTime) {
          elTime.textContent = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        }
        if (elDate) {
          elDate.textContent = now.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
        }
      };
      tick();
      this.clockTimer = setInterval(tick, 15000);
    },

    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      const shell = document.getElementById('appShell');
      if (shell) shell.classList.toggle('collapsed-sidebar', this.sidebarCollapsed);
    },

    navigate(page) {
      this.activePage = page;
      if (page === 'profile') {
        this.markChatAsRead();
      }
      this.renderAll();
      if (page === 'profile') {
        this.scrollChatToBottom('pageChatStream');
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    },

    onFabClick() {
      if (this.activePage === 'stock') return this.openStockModal();
      if (this.activePage === 'budgets') return this.openBudgetModal();
      if (this.activePage === 'goals') return this.openGoalModal();
      if (this.activePage === 'obligations') return this.openObligationModal();
      if (this.activePage === 'accounts') return this.openCategoryModal();
      return this.openTransactionModal();
    },

    getGreetingText() {
      const h = new Date().getHours();
      if (h < 12) return 'Buenos días,';
      if (h < 19) return 'Buenas tardes,';
      return 'Buenas noches,';
    },

    shiftSelectedMonth(delta) {
      const [yStr, mStr] = (this.selectedMonthYM || currentYM()).split('-');
      const d = new Date(Number(yStr), Number(mStr) - 1 + delta, 1);
      this.selectedMonthYM = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      this.renderMainView();
    },

    getMonthDisplayName(ym) {
      try {
        const [y, m] = (ym || currentYM()).split('-');
        const d = new Date(Number(y), Number(m) - 1, 1);
        return d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
      } catch (e) {
        return ym;
      }
    },

    onManualSyncClick() {
      window.cashewSync.pullFromCloud();
      window.cashewCurrency.fetchOfficialRates();
      this.toast('Sincronizando nube privada y tasas oficiales...', 'sync');
    },

    renderSyncIndicators() {
      const dot = document.getElementById('syncPulseDot');
      const label = document.getElementById('syncStatusText');
      const partnerEl = document.getElementById('partnerPresenceBadge');
      const syncTimeEl = document.getElementById('syncLastTime');

      const st = window.cashewSync.status;
      if (dot) {
        dot.className = 'pulse-dot ' + (
          st === 'live' ? '' :
          st === 'connecting' ? 'syncing' : 'offline'
        );
      }
      if (label) {
        label.textContent =
          st === 'live' ? 'Nube en Vivo' :
          st === 'connecting' ? 'Conectando...' : 'Reconectando...';
      }

      const partner = this.getPartnerProfile();
      const isOnline = partner ? window.cashewSync.isProfileOnline(partner.id) : false;
      const partnerLabel = partner ? (partner.displayName || partner.username) : 'Socio';
      if (partnerEl) {
        partnerEl.className = 'partner-presence-pill ' + (isOnline ? 'online' : '');
        partnerEl.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:currentColor;"></span> ${this.escapeHtml(partnerLabel)} ${isOnline ? 'en vivo' : 'offline'}`;
      }

      if (syncTimeEl) {
        if (window.cashewSync.lastSyncAt) {
          const d = new Date(window.cashewSync.lastSyncAt);
          syncTimeEl.textContent = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        } else {
          syncTimeEl.textContent = st === 'live' ? 'Activo' : '...';
        }
      }
    },

    renderAppPreservingFocus() {
      const activeEl = document.activeElement;
      const focusId = activeEl && activeEl.id ? activeEl.id : null;
      const selStart = activeEl && typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null;

      this.renderSidebarMeta();
      this.renderMainView();

      if (this.activePage === 'profile') {
        this.scrollChatToBottom('pageChatStream');
      }

      if (focusId) {
        const restored = document.getElementById(focusId);
        if (restored) {
          restored.focus();
          if (selStart !== null && typeof restored.setSelectionRange === 'function') {
            try { restored.setSelectionRange(selStart, selStart); } catch (e) {}
          }
        }
      }
    },

    renderAll() {
      this.renderSyncIndicators();
      this.renderSidebarMeta();
      this.updateUnreadChatBadges();
      this.renderMainView();
    },

    renderSidebarMeta() {
      const stockStats = this.getStockSummary();
      const badgeEl = document.getElementById('navStockBadge');
      if (badgeEl) {
        if (stockStats.lowStockCount > 0) {
          badgeEl.textContent = `${stockStats.readyUnits} • !${stockStats.lowStockCount}`;
          badgeEl.className = 'nav-item-badge warn';
        } else {
          badgeEl.textContent = `${stockStats.readyUnits}`;
          badgeEl.className = 'nav-item-badge';
        }
      }

      const obSummary = this.getObligationsSummary();
      const obBadge = document.getElementById('navObligationsBadge');
      if (obBadge) {
        const totalPending = obSummary.overdue.length + obSummary.upcoming.length + obSummary.credits.length + obSummary.debts.length;
        if (totalPending > 0) {
          obBadge.style.display = 'inline-flex';
          obBadge.textContent = obSummary.overdue.length > 0 ? `!${obSummary.overdue.length}` : String(totalPending);
          obBadge.className = 'nav-item-badge ' + (obSummary.overdue.length > 0 ? 'warn' : '');
        } else {
          obBadge.style.display = 'none';
        }
      }

      document.querySelectorAll('[data-nav]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.nav === this.activePage);
      });

      const profAvatar = document.getElementById('sidebarProfileAvatar');
      const profName = document.getElementById('sidebarProfileName');
      const profRole = document.getElementById('sidebarProfileRole');
      const me = this.getCurrentProfile();

      if (profAvatar) profAvatar.innerHTML = this.getProfileAvatarHTML(me, 34);
      if (profName) profName.textContent = me.displayName || me.username;
      if (profRole) profRole.textContent = `@${me.username} • ${me.role || 'Socio'}`;

      this.updateNavBotBadge();
    },

    renderMainView() {
      const container = document.getElementById('cashewMainContent');
      if (!container) return;

      switch (this.activePage) {
        case 'home':
          container.innerHTML = this.buildHomePage();
          break;
        case 'stock':
          container.innerHTML = this.buildStockPage();
          break;
        case 'transactions':
          container.innerHTML = this.buildTransactionsPage();
          break;
        case 'obligations':
          container.innerHTML = this.buildObligationsPage();
          break;
        case 'budgets':
          container.innerHTML = this.buildBudgetsPage();
          break;
        case 'goals':
          container.innerHTML = this.buildGoalsPage();
          break;
        case 'analytics':
          container.innerHTML = this.buildAnalyticsPage();
          break;
        case 'accounts':
          container.innerHTML = this.buildAccountsPage();
          break;
        case 'profile':
          container.innerHTML = this.buildProfileAndChatPage();
          break;
        case 'bot':
          container.innerHTML = this.buildBotPage();
          break;
        case 'settings':
          container.innerHTML = this.buildSettingsPage();
          break;
        default:
          container.innerHTML = this.buildHomePage();
      }
    },

    /* ======================================================================
       PAGE 1: INICIO (EXACT CASHEW HOME DASHBOARD + STOCK)
       ====================================================================== */
    buildHomePage() {
      const me = this.getCurrentProfile();
      const partner = this.getPartnerProfile();
      const partnerOnline = partner ? window.cashewSync.isProfileOnline(partner.id) : false;

      const wallets = this.activeList('wallets');
      const dispSym = this.getDisplaySymbolForFilter(this.selectedHomeWalletId);
      const fmtActive = (v) => this.fmtMoney(v, dispSym);

      const netWorth = this.getTotalNetWorth(this.selectedHomeWalletId);
      const cashflow = this.getMonthCashflow(this.selectedHomeWalletId, this.selectedMonthYM);
      const obSum = this.getObligationsSummary();
      const stockSummary = this.getStockSummary();
      const series = this.getNetWorthSeries(this.selectedHomeWalletId, 16);
      const dailyHeatmap = this.getDailyHeatmapMap(this.selectedHomeWalletId);

      const pinnedBudgets = this.activeList('budgets').filter(b => b.pinned !== false);
      const goals = this.activeList('goals').slice(0, 3);
      const sellableItems = this.activeList('stockItems')
        .filter(it => it.kind === 'para_vender' && (Number(it.stock) || 0) > 0)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 4);

      const recentTxs = this.activeList('transactions')
        .filter(tx => this.selectedHomeWalletId === 'all' || tx.walletId === this.selectedHomeWalletId || tx.toWalletId === this.selectedHomeWalletId)
        .sort((a, b) => `${b.date || ''} ${b.time || '00:00'}`.localeCompare(`${a.date || ''} ${a.time || '00:00'}`) || (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, 8);

      const urgentObligations = [
        ...obSum.overdue,
        ...obSum.upcoming,
        ...obSum.credits,
        ...obSum.debts
      ].slice(0, 5);

      return `
        <!-- Cashew Greeting Banner -->
        <header class="cashew-greeting-header">
          <div>
            <div class="greeting-small">${this.getGreetingText()}</div>
            <h1 class="greeting-username">
              ${this.escapeHtml(me.displayName || me.username)}
              <button type="button" onclick="CashewApp.navigate('profile')"
                      class="partner-presence-pill ${partnerOnline ? 'online' : ''}"
                      style="font-size:12px; cursor:pointer;"
                      title="Abrir chat con ${this.escapeHtml(partner.displayName || partner.username)}">
                <span class="material-symbols-rounded" style="font-size:15px;">forum</span>
                ${this.escapeHtml(partner.displayName || partner.username)} ${partnerOnline ? 'en vivo' : 'chat'}
              </button>
            </h1>
          </div>

          <div class="header-actions-bar">
            <button class="btn-cashew btn-surface btn-sm" onclick="CashewApp.openCurrencyRatesModal()" title="Tasas oficiales GitHub de Cashew">
              <span class="material-symbols-rounded" style="font-size:17px; color:var(--primary);">currency_exchange</span>
              ${this.escapeHtml(this.primaryCurrency)}
            </button>

            <div class="swatch-pill-bar" title="Color Material You (Estilo Cashew)">
              ${window.CASHEW_ACCENT_SWATCHES.slice(0, 5).map(sw => `
                <button class="swatch-dot ${this.prefs.accentHex.toLowerCase() === sw.hex.toLowerCase() ? 'active' : ''}"
                  style="background:${sw.hex};"
                  title="${sw.name}"
                  onclick="CashewApp.savePrefs({ accentHex: '${sw.hex}' })"></button>
              `).join('')}
              <button class="icon-btn" style="width:28px;height:28px;border:none;border-radius:99px;"
                title="Cambiar tema Oscuro / AMOLED / Claro"
                onclick="CashewApp.cycleThemeMode()">
                <span class="material-symbols-rounded" style="font-size:17px;">
                  ${this.prefs.themeMode === 'light' ? 'light_mode' : this.prefs.themeMode === 'amoled' ? 'contrast' : 'dark_mode'}
                </span>
              </button>
            </div>

            <button class="btn-cashew btn-tonal" onclick="CashewApp.openStockModal()">
              <span class="material-symbols-rounded" style="font-size:19px;">inventory_2</span>
              Subir Stock
            </button>
            <button class="btn-cashew btn-primary" onclick="CashewApp.openTransactionModal()">
              <span class="material-symbols-rounded" style="font-size:19px;">add</span>
              Transacción
            </button>
          </div>
        </header>

        ${this.renderPendingApprovalsBannerHTML()}

        <!-- Wallets Horizontal Switcher (HomePageWalletSwitcher + Balance Correction!) -->
        <section class="wallets-strip">
          ${wallets.map(w => {
            const bal = this.getWalletBalance(w.id);
            const isSel = this.selectedHomeWalletId === w.id;
            const wCur = (w.currency || 'USD').toUpperCase();
            const showConv = wCur !== this.primaryCurrency;
            const convVal = showConv ? window.cashewCurrency.toPrimary(bal, wCur) : bal;
            return `
              <div class="wallet-card ${isSel ? 'selected' : ''}"
                   onclick="CashewApp.toggleHomeWallet('${w.id}')">
                <div class="wallet-card-top">
                  <div class="wallet-dot-icon" style="background:${w.color || '#5f85c2'};">
                    ${window.renderCashewIconHTML(w, 22)}
                  </div>
                  <div style="display:flex; align-items:center; gap:5px;">
                    <span class="wallet-currency-tag">${this.escapeHtml(wCur)}</span>
                    <button type="button" class="icon-btn"
                            style="width:28px; height:28px; border-radius:9px;"
                            title="Editar cuenta (nombre, color, eliminar)"
                            onclick="event.stopPropagation(); CashewApp.openWalletModal('${w.id}')">
                      <span class="material-symbols-rounded" style="font-size:15px;">edit</span>
                    </button>
                    <button type="button" class="icon-btn"
                            style="width:28px; height:28px; border-radius:9px;"
                            title="Corregir Balance de ${this.escapeHtml(w.name)}"
                            onclick="event.stopPropagation(); CashewApp.openBalanceCorrectionModal('${w.id}')">
                      <span class="material-symbols-rounded" style="font-size:15px;">tune</span>
                    </button>
                  </div>
                </div>
                <div class="wallet-balance">${this.fmtWalletAmount(bal, w)}</div>
                <div class="wallet-name" style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
                  <span>${this.escapeHtml(w.name)}</span>
                  ${showConv ? `<span style="font-size:11.5px; color:var(--primary); font-weight:700;">≈ ${this.fmtMoney(convVal)}</span>` : ''}
                </div>
              </div>
            `;
          }).join('')}

          <div class="wallet-card wallet-add-card" onclick="CashewApp.openWalletModal()">
            <span class="material-symbols-rounded" style="font-size:26px;">add_circle</span>
            <span style="font-weight:700; font-size:13.5px;">Nueva Cuenta</span>
          </div>
        </section>

        <!-- Cashew Top Financial Summary Strip: Valor Neto, Ingresos del Mes, Gastos del Mes, Deudas/Prestados -->
        <section class="kpi-grid-4">
          <div class="kpi-cashew-card">
            <div class="kpi-top">
              <span>Valor Neto (${this.selectedHomeWalletId === 'all' ? this.escapeHtml(this.primaryCurrency) : 'Cuenta'})</span>
              <div class="kpi-icon-box" style="background:var(--primary-container); color:var(--primary);">
                <span class="material-symbols-rounded">account_balance_wallet</span>
              </div>
            </div>
            <div class="kpi-big-val">${fmtActive(netWorth)}</div>
            <div class="kpi-foot">${wallets.length} cuenta(s) activas sincronizadas</div>
          </div>

          <div class="kpi-cashew-card">
            <div class="kpi-top">
              <span>Ingresos Totales (${this.escapeHtml(this.getMonthDisplayName(this.selectedMonthYM))})</span>
              <div class="kpi-icon-box" style="background:var(--cashew-income-bg); color:var(--cashew-income);">
                <span class="material-symbols-rounded">south_west</span>
              </div>
            </div>
            <div class="kpi-big-val" style="color:var(--cashew-income);">+${fmtActive(cashflow.income)}</div>
            <div class="kpi-foot">Entradas y ventas registradas del mes</div>
          </div>

          <div class="kpi-cashew-card">
            <div class="kpi-top">
              <span>Gastos Totales (${this.escapeHtml(this.getMonthDisplayName(this.selectedMonthYM))})</span>
              <div class="kpi-icon-box" style="background:var(--cashew-expense-bg); color:var(--cashew-expense);">
                <span class="material-symbols-rounded">north_east</span>
              </div>
            </div>
            <div class="kpi-big-val" style="color:var(--cashew-expense);">-${fmtActive(cashflow.expense)}</div>
            <div class="kpi-foot">Salidas, compras y pagos del mes</div>
          </div>

          <div class="kpi-cashew-card" style="cursor:pointer;" onclick="CashewApp.navigate('obligations')">
            <div class="kpi-top">
              <span>Prestados vs Deudas</span>
              <div class="kpi-icon-box" style="background:var(--cashew-overdue-bg); color:var(--cashew-overdue);">
                <span class="material-symbols-rounded">event_repeat</span>
              </div>
            </div>
            <div class="kpi-big-val" style="font-size:20px;">
              <span style="color:var(--cashew-income);">+${this.fmtMoney(obSum.creditsTotal)}</span>
              <span style="color:var(--text-muted); font-weight:500;"> / </span>
              <span style="color:var(--cashew-expense);">-${this.fmtMoney(obSum.debtsTotal + obSum.overdueTotal)}</span>
            </div>
            <div class="kpi-foot">
              ${obSum.overdue.length > 0
                ? `<span style="color:var(--cashew-expense); font-weight:800;">¡${obSum.overdue.length} vencido(s)!</span> • ${obSum.upcoming.length} próximos`
                : `${obSum.upcoming.length} pagos próximos • ${obSum.credits.length} nos deben`}
            </div>
          </div>
        </section>

        <!-- Cashew Double-Column Responsive Dashboard Grid -->
        <div class="cashew-home-grid">
          <!-- LEFT COLUMN -->
          <div class="cashew-col">
            <!-- Cashew Circular Profit & Loss Chart (Gráfico Circular de Ganancia y Pérdida) -->
            <div class="cashew-card">
              <div class="cashew-card-header" style="flex-wrap:wrap;">
                <div>
                  <div class="cashew-card-title">
                    <span class="material-symbols-rounded" style="color:var(--primary);">donut_large</span>
                    Ganancia y Pérdida (Cashew)
                  </div>
                  <div class="cashew-card-subtitle" style="text-transform:capitalize;">
                    ${this.escapeHtml(this.getMonthDisplayName(this.selectedMonthYM))}
                  </div>
                </div>

                <div class="month-nav-pill">
                  <button type="button" onclick="CashewApp.shiftSelectedMonth(-1)" title="Mes anterior" style="display:flex;">
                    <span class="material-symbols-rounded" style="font-size:18px;">chevron_left</span>
                  </button>
                  <span style="text-transform:capitalize;">${this.escapeHtml(this.getMonthDisplayName(this.selectedMonthYM))}</span>
                  <button type="button" onclick="CashewApp.shiftSelectedMonth(1)" title="Mes siguiente" style="display:flex;">
                    <span class="material-symbols-rounded" style="font-size:18px;">chevron_right</span>
                  </button>
                </div>
              </div>

              <div class="segmented-pills" style="margin-bottom:16px;">
                <button type="button" class="seg-pill ${this.homeChartTab === 'pnl' ? 'active' : ''}"
                        onclick="CashewApp.homeChartTab='pnl'; CashewApp.renderMainView();">
                  Ganancia y Pérdida
                </button>
                <button type="button" class="seg-pill ${this.homeChartTab === 'expense' ? 'active' : ''}"
                        onclick="CashewApp.homeChartTab='expense'; CashewApp.renderMainView();">
                  Gastos por Categoría
                </button>
                <button type="button" class="seg-pill ${this.homeChartTab === 'income' ? 'active' : ''}"
                        onclick="CashewApp.homeChartTab='income'; CashewApp.renderMainView();">
                  Ingresos por Categoría
                </button>
              </div>

              ${this.homeChartTab === 'pnl'
                ? window.CashewCharts.renderProfitLossRingSVG(cashflow.income, cashflow.expense, fmtActive)
                : this.homeChartTab === 'expense'
                  ? window.CashewCharts.renderDonutSVG(cashflow.expSlices, 'Gastos Mes', fmtActive(cashflow.expense), fmtActive)
                  : window.CashewCharts.renderDonutSVG(cashflow.incSlices, 'Ingresos Mes', fmtActive(cashflow.income), fmtActive)
              }
            </div>

            <!-- Cashew Calendar Heatmap (HomePageHeatMap) -->
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div>
                  <div class="cashew-card-title">
                    <span class="material-symbols-rounded" style="color:var(--cashew-income);">calendar_month</span>
                    Mapa de Calor Financiero
                  </div>
                  <div class="cashew-card-subtitle">Actividad diaria de ganancias y gastos</div>
                </div>
                <button class="btn-cashew btn-surface btn-sm" onclick="CashewApp.navigate('analytics')">
                  Ampliar
                </button>
              </div>
              ${window.CashewCharts.renderCashewHeatmapHTML(dailyHeatmap, { weeks: 21, fmtFn: fmtActive })}
            </div>

            <!-- Net Worth Evolution Line Graph -->
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div>
                  <div class="cashew-card-title">
                    <span class="material-symbols-rounded" style="color:var(--primary);">show_chart</span>
                    Evolución de Valor Neto
                  </div>
                  <div class="cashew-card-subtitle">
                    ${this.selectedHomeWalletId === 'all' ? 'Todas las cuentas combinadas' : 'Cuenta filtrada actual'}
                  </div>
                </div>
                ${this.selectedHomeWalletId !== 'all' ? `
                  <button class="btn-cashew btn-surface btn-sm" onclick="CashewApp.toggleHomeWallet('all')">
                    Ver todas
                  </button>
                ` : ''}
              </div>
              ${window.CashewCharts.renderAreaLineSVG(series, { symbol: dispSym })}
            </div>

            <!-- Pinned Budgets & Goals -->
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div class="cashew-card-title">
                  <span class="material-symbols-rounded" style="color:var(--primary);">donut_small</span>
                  Presupuestos y Metas
                </div>
                <div style="display:flex; gap:6px;">
                  <button class="btn-cashew btn-surface btn-sm" onclick="CashewApp.navigate('budgets')">Presupuestos</button>
                  <button class="btn-cashew btn-surface btn-sm" onclick="CashewApp.navigate('goals')">Metas</button>
                </div>
              </div>
              <div style="display:flex; flex-direction:column; gap:12px;">
                ${pinnedBudgets.map(b => this.renderBudgetCardHTML(b)).join('')}
                ${goals.map(g => {
                  const pct = Math.min(100, Math.round(((Number(g.currentAmount) || 0) / Math.max(1, Number(g.targetAmount) || 1)) * 100));
                  return `
                    <div class="budget-card-item" onclick="CashewApp.openGoalDepositModal('${g.id}')">
                      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                        <div style="display:flex; align-items:center; gap:10px;">
                          <div class="wallet-dot-icon" style="background:${g.color || '#4db685'}; width:38px; height:38px;">
                            ${window.renderCashewIconHTML(g, 21)}
                          </div>
                          <div>
                            <div style="font-weight:800; font-size:14.5px;">${this.escapeHtml(g.name)}</div>
                            <div style="font-size:12px; color:var(--text-muted);">${this.fmtMoney(g.currentAmount)} de ${this.fmtMoney(g.targetAmount)}</div>
                          </div>
                        </div>
                        <span style="font-weight:800; color:${g.color || 'var(--primary)'};">${pct}%</span>
                      </div>
                      <div class="stock-mini-progress" style="margin-top:10px; height:9px;">
                        <div class="stock-mini-fill" style="width:${pct}%; background:${g.color || 'var(--primary)'};"></div>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          </div>

          <!-- RIGHT COLUMN -->
          <div class="cashew-col">
            <!-- Upcoming, Overdue, Lent & Debts Widget (Cashew HomePageUpcoming) -->
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div>
                  <div class="cashew-card-title">
                    <span class="material-symbols-rounded" style="color:var(--cashew-upcoming);">event_repeat</span>
                    Próximamente, Vencidos, Prestados y Deudas
                  </div>
                  <div class="cashew-card-subtitle">Pagos programados, cobros pendientes y préstamos</div>
                </div>
                <button class="btn-cashew btn-tonal btn-sm" onclick="CashewApp.navigate('obligations')">
                  Gestionar →
                </button>
              </div>

              <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:9px; margin-bottom:13px;">
                <div style="background:var(--bg-elevated); border-radius:14px; padding:10px 12px; cursor:pointer;"
                     onclick="CashewApp.obligationTab='upcoming'; CashewApp.navigate('obligations');">
                  <div style="font-size:11px; color:var(--text-muted); font-weight:700;">Pagos Próximamente</div>
                  <div style="font-size:16px; font-weight:800; color:var(--cashew-upcoming);">${this.fmtMoney(obSum.upcomingTotal)}</div>
                </div>
                <div style="background:var(--bg-elevated); border-radius:14px; padding:10px 12px; cursor:pointer;"
                     onclick="CashewApp.obligationTab='overdue'; CashewApp.navigate('obligations');">
                  <div style="font-size:11px; color:var(--text-muted); font-weight:700;">Vencidos</div>
                  <div style="font-size:16px; font-weight:800; color:${obSum.overdueTotal > 0 ? 'var(--cashew-expense)' : 'var(--text-muted)'};">${this.fmtMoney(obSum.overdueTotal)}</div>
                </div>
                <div style="background:var(--bg-elevated); border-radius:14px; padding:10px 12px; cursor:pointer;"
                     onclick="CashewApp.obligationTab='credit'; CashewApp.navigate('obligations');">
                  <div style="font-size:11px; color:var(--text-muted); font-weight:700;">Prestados (Nos deben)</div>
                  <div style="font-size:16px; font-weight:800; color:var(--cashew-income);">${this.fmtMoney(obSum.creditsTotal)}</div>
                </div>
                <div style="background:var(--bg-elevated); border-radius:14px; padding:10px 12px; cursor:pointer;"
                     onclick="CashewApp.obligationTab='debt'; CashewApp.navigate('obligations');">
                  <div style="font-size:11px; color:var(--text-muted); font-weight:700;">Deudas (Debemos)</div>
                  <div style="font-size:16px; font-weight:800; color:var(--cashew-expense);">${this.fmtMoney(obSum.debtsTotal)}</div>
                </div>
              </div>

              ${urgentObligations.length === 0 ? `
                <div class="empty-cashew" style="padding:14px;">No hay pagos vencidos ni deudas pendientes</div>
              ` : `
                <div style="display:flex; flex-direction:column; gap:7px;">
                  ${urgentObligations.map(ob => this.renderObligationRowHTML(ob, true)).join('')}
                </div>
              `}
            </div>

            <!-- Stock Disponible Widget (Core Priority!) -->
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div>
                  <div class="cashew-card-title">
                    <span class="material-symbols-rounded" style="color:var(--primary);">inventory_2</span>
                    Stock Listo para Vender
                  </div>
                  <div class="cashew-card-subtitle">Inventario compartido en tiempo real</div>
                </div>
                <button class="btn-cashew btn-tonal btn-sm" onclick="CashewApp.navigate('stock')">
                  Inventario →
                </button>
              </div>

              <div class="stock-pricing-box" style="margin-bottom:14px;">
                <div>
                  <div class="price-col-label">Unidades Venta</div>
                  <div class="price-col-val">${stockSummary.readyUnits} uds</div>
                </div>
                <div>
                  <div class="price-col-label">Valor en Venta</div>
                  <div class="price-col-val">${this.fmtMoney(stockSummary.retailValue, '$')}</div>
                </div>
                <div>
                  <div class="price-col-label">Ganancia Est.</div>
                  <div class="price-col-val" style="color:var(--cashew-income);">+${this.fmtMoney(stockSummary.expectedProfit, '$')}</div>
                </div>
              </div>

              ${stockSummary.lowStockCount > 0 ? `
                <div onclick="CashewApp.setStockTab('out'); CashewApp.navigate('stock');" style="cursor:pointer; background:var(--cashew-warning-bg); color:var(--cashew-warning); border-radius:14px; padding:10px 13px; font-size:12.5px; font-weight:700; display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
                  <span style="display:flex; align-items:center; gap:7px;">
                    <span class="material-symbols-rounded" style="font-size:18px;">warning</span>
                    ${stockSummary.lowStockCount} artículo(s) con stock bajo o agotado
                  </span>
                  <span>Revisar →</span>
                </div>
              ` : ''}

              <div style="display:flex; flex-direction:column; gap:8px;">
                ${sellableItems.length === 0 ? `
                  <div class="empty-cashew" style="padding:16px;">No hay productos listos en vitrina</div>
                ` : sellableItems.map(it => `
                  <div class="tx-row" style="background:var(--bg-elevated);" onclick="CashewApp.openQuickSaleModal('${it.id}')">
                    <div class="cat-circle" style="background:${it.color || '#5f85c2'}; width:40px; height:40px; font-size:19px;">
                      ${it.imageUrl
                        ? `<img src="${this.escapeHtml(it.imageUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:13px;"/>`
                        : `<span class="material-symbols-rounded">${it.icon || 'inventory_2'}</span>`}
                    </div>
                    <div class="tx-info">
                      <div class="tx-title">${this.escapeHtml(it.name)}</div>
                      <div class="tx-sub">
                        <span><strong>${it.stock}</strong> disp.</span>
                        <span>•</span>
                        <span>${this.fmtMoney(it.salePrice, '$')} c/u</span>
                        <span class="author-tag">${this.escapeHtml(it.updatedBy || 'socio')}</span>
                      </div>
                    </div>
                    <button class="btn-cashew btn-income btn-sm" onclick="event.stopPropagation(); CashewApp.openQuickSaleModal('${it.id}')">
                      Vender
                    </button>
                  </div>
                `).join('')}
              </div>
            </div>

            <!-- Recent Transactions List (With Full Date, Weekday, Time, Type, Title & Note!) -->
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div class="cashew-card-title">
                  <span class="material-symbols-rounded" style="color:var(--primary);">payments</span>
                  Transacciones Recientes
                </div>
                <button class="btn-cashew btn-surface btn-sm" onclick="CashewApp.navigate('transactions')">
                  Ver todas
                </button>
              </div>
              ${this.renderTransactionsGroupedHTML(recentTxs)}
            </div>
          </div>
        </div>
      `;
    },

    toggleHomeWallet(id) {
      this.selectedHomeWalletId = this.selectedHomeWalletId === id ? 'all' : id;
      this.renderMainView();
    },

    cycleThemeMode() {
      const order = ['dark', 'amoled', 'light'];
      const next = order[(order.indexOf(this.prefs.themeMode) + 1) % order.length];
      const names = { dark: 'Oscuro Material You', amoled: 'Negro Puro AMOLED', light: 'Claro Material You' };
      this.savePrefs({ themeMode: next });
      this.toast(`Tema: ${names[next]}`, 'palette');
    },

    renderBudgetCardHTML(b) {
      const ym = this.selectedMonthYM || currentYM();
      const allowedCats = Array.isArray(b.categoryIds) && b.categoryIds.length > 0 ? new Set(b.categoryIds) : null;
      let spent = 0;

      for (const tx of this.activeList('transactions')) {
        if (!this.isTxEffective(tx)) continue;
        if (tx.type !== 'expense' || tx.isBalanceCorrection || String(tx.categoryId) === '0') continue;
        if (!(tx.date || '').startsWith(ym)) continue;
        if (allowedCats && !allowedCats.has(tx.categoryId)) continue;
        spent += this.txToPrimary(Number(tx.amount) || 0, tx.walletId);
      }

      const limit = Math.max(1, Number(b.limit) || 1);
      const pct = Math.min(100, (spent / limit) * 100);
      const over = spent > limit;

      const now = new Date();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const todayPct = Math.min(98, Math.max(2, (now.getDate() / daysInMonth) * 100));
      const daysLeft = Math.max(1, daysInMonth - now.getDate() + 1);
      const remaining = Math.max(0, limit - spent);
      const perDay = remaining / daysLeft;

      const fillColor = over ? 'var(--cashew-expense)' : (b.color || 'var(--primary)');

      return `
        <div class="budget-card-item">
          <div class="budget-top-row">
            <div class="budget-name" style="cursor:pointer;" onclick="CashewApp.openBudgetExpenseModal('${b.id}', 'expense')" title="Click para cargar gasto o aumentar límite">
              ${this.escapeHtml(b.name)}
            </div>
            <div class="budget-amounts">
              <span style="color:${over ? 'var(--cashew-expense)' : 'var(--text-main)'};">${this.fmtMoney(spent)}</span>
              <span style="color:var(--text-muted); font-weight:600;"> / ${this.fmtMoney(limit)}</span>
            </div>
          </div>

          <div class="budget-track-wrap" style="cursor:pointer;" onclick="CashewApp.openBudgetExpenseModal('${b.id}', 'expense')" title="Click para cargar gasto o aumentar límite">
            <span class="budget-today-label" style="left:${todayPct.toFixed(1)}%;">Hoy</span>
            <div class="budget-today-tick" style="left:${todayPct.toFixed(1)}%;" title="Ritmo esperado al día de hoy"></div>
            <div class="budget-track-inner">
              <div class="budget-fill" style="width:${pct.toFixed(1)}%; background:${fillColor};"></div>
            </div>
          </div>

          <div class="budget-foot-row">
            <span>${over ? 'Excedido por ' + this.fmtMoney(spent - limit) : 'Restante: ' + this.fmtMoney(remaining)}</span>
            <span style="font-weight:700;">${over ? '0.00/día' : this.fmtMoney(perDay) + '/día'}</span>
          </div>

          <div style="display:flex; gap:6px; margin-top:10px; padding-top:8px; border-top:1px solid var(--border-subtle); align-items:center;">
            <button type="button" class="btn-cashew btn-tonal btn-sm" style="flex:1; padding:6px 10px; font-size:12px; justify-content:center;"
                    onclick="event.stopPropagation(); CashewApp.openBudgetExpenseModal('${b.id}', 'expense');"
                    title="Registrar un gasto que se descuenta de tu cuenta y suma al presupuesto">
              <span class="material-symbols-rounded" style="font-size:15px;">payments</span>
              Cargar Gasto
            </button>
            <button type="button" class="btn-cashew btn-surface btn-sm" style="flex:1; padding:6px 10px; font-size:12px; justify-content:center;"
                    onclick="event.stopPropagation(); CashewApp.openBudgetExpenseModal('${b.id}', 'limit');"
                    title="Aumentar o sumar al límite mensual de este presupuesto">
              <span class="material-symbols-rounded" style="font-size:15px;">tune</span>
              Aumentar Límite
            </button>
            <button type="button" class="icon-btn" style="width:30px; height:30px; border-radius:8px;"
                    title="Editar configuración del presupuesto (categorías, nombre, color)"
                    onclick="event.stopPropagation(); CashewApp.openBudgetModal('${b.id}');">
              <span class="material-symbols-rounded" style="font-size:16px;">edit</span>
            </button>
          </div>
        </div>
      `;
    },

    /* Full Cashew Transaction List Renderer (Date + Weekday + Exact Hour + Type + Amount + Title + Note!) */
    renderTransactionsGroupedHTML(txList) {
      if (!txList || txList.length === 0) {
        return `<div class="empty-cashew">
          <span class="material-symbols-rounded">receipt_long</span>
          <div>No hay transacciones en esta vista</div>
        </div>`;
      }

      const groups = new Map();
      for (const tx of txList) {
        const dKey = tx.date || todayLocalISO();
        if (!groups.has(dKey)) groups.set(dKey, []);
        groups.get(dKey).push(tx);
      }

      const todayISO = todayLocalISO();
      let html = '';

      for (const [dateStr, items] of groups.entries()) {
        let dayNetPrimary = 0;
        for (const t of items) {
          const valP = this.txToPrimary(Number(t.amount) || 0, t.walletId);
          if (t.type === 'income') dayNetPrimary += valP;
          else if (t.type === 'expense') dayNetPrimary -= valP;
        }

        let fullWeekdayDate = dateStr;
        try {
          const d = new Date(dateStr + 'T12:00:00');
          const formatted = d.toLocaleDateString('es-ES', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric'
          });
          fullWeekdayDate = dateStr === todayISO ? `Hoy • ${formatted}` : formatted;
        } catch (e) {}

        html += `
          <div class="tx-date-group">
            <div class="tx-date-header">
              <span style="text-transform:capitalize;">${this.escapeHtml(fullWeekdayDate)}</span>
              <span style="color:${dayNetPrimary >= 0 ? 'var(--cashew-income)' : 'var(--cashew-expense)'}; font-weight:800;">
                ${dayNetPrimary >= 0 ? '+' : ''}${this.fmtMoney(dayNetPrimary)}
              </span>
            </div>
            ${items.map(tx => {
              const isTransfer = tx.type === 'transfer';
              const isCorrection = tx.isBalanceCorrection || String(tx.categoryId) === '0';
              const cat = isTransfer
                ? { name: 'Transferencia', color: '#7db6cc', icon: 'swap_horiz' }
                : this.getCategoryById(tx.categoryId);

              const w = this.getWalletById(tx.walletId);
              const toW = tx.toWalletId ? this.getWalletById(tx.toWalletId) : null;
              const sign = tx.type === 'income' ? '+' : tx.type === 'expense' ? '-' : '⇄ ';

              const timeDisplay = (tx.time && /^\d{2}:\d{2}/.test(tx.time))
                ? tx.time.slice(0, 5)
                : (tx.createdAt ? new Date(tx.createdAt).toTimeString().slice(0, 5) : '12:00');

              let kindLabel = tx.type === 'income' ? 'Ingreso' : tx.type === 'expense' ? 'Gasto' : 'Transferencia';
              let kindCls = tx.type === 'income' ? 'inc' : tx.type === 'expense' ? 'exp' : 'trf';
              if (isCorrection) {
                kindLabel = tx.type === 'income' ? 'Corrección (+)' : 'Corrección (-)';
                kindCls = 'cor';
              }

              const nativeFormatted = this.fmtWalletAmount(tx.amount, w);
              const wCur = w && w.currency ? w.currency.toUpperCase() : this.primaryCurrency;
              const showConv = wCur !== this.primaryCurrency;
              const convPrimary = showConv ? this.fmtMoney(this.txToPrimary(tx.amount, tx.walletId)) : '';

              return `
                <div class="tx-row" onclick="CashewApp.openTransactionModal('${tx.id}')">
                  <div class="cat-circle" style="background:${cat.color || '#5f85c2'};">
                    ${isTransfer
                      ? `<span class="material-symbols-rounded">swap_horiz</span>`
                      : window.renderCashewIconHTML(cat, 24)}
                  </div>
                  <div class="tx-info">
                    <div class="tx-title-line" style="flex-wrap:wrap;">
                      <span class="tx-title">${this.escapeHtml(tx.title || cat.name)}</span>
                      <span class="tx-kind-pill ${kindCls}">${kindLabel}</span>
                      <span class="tx-time-pill" title="Fecha: ${this.escapeHtml(dateStr)} • Hora: ${this.escapeHtml(timeDisplay)}">
                        🕒 ${this.escapeHtml(timeDisplay)}
                      </span>
                    </div>
                    <div class="tx-sub">
                      <span>${this.escapeHtml(cat.name)}</span>
                      <span>•</span>
                      <span style="font-weight:700; color:var(--text-main);">🏛️ ${this.escapeHtml(w ? w.name : 'Cuenta')}${toW ? ' → ' + this.escapeHtml(toW.name) : ''}</span>
                      <span>•</span>
                      <span>${this.escapeHtml(dateStr)}</span>
                      <span class="author-tag">${this.escapeHtml(tx.updatedBy || 'socio')}</span>
                    </div>
                    ${tx.note ? `<div class="tx-note-preview" title="${this.escapeHtml(tx.note)}">📝 ${this.escapeHtml(tx.note)}</div>` : ''}
                  </div>
                  <div style="text-align:right; flex-shrink:0; display:flex; align-items:center; gap:8px;">
                    <div>
                      <div class="tx-amount ${tx.type}">
                        ${sign}${nativeFormatted}
                      </div>
                      ${showConv ? `<div style="font-size:11px; color:var(--text-muted); font-weight:700;">≈ ${sign}${convPrimary}</div>` : ''}
                    </div>
                    <button type="button" class="icon-btn"
                            style="width:30px; height:30px; border-radius:9px;"
                            title="Editar transacción o mover de cuenta"
                            onclick="event.stopPropagation(); CashewApp.openTransactionModal('${tx.id}')">
                      <span class="material-symbols-rounded" style="font-size:17px;">edit</span>
                    </button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `;
      }
      return html;
    },

    renderObligationRowHTML(ob, compact = false) {
      const today = todayLocalISO();
      const isOverdue = !ob.settled && ob.dueDate && ob.dueDate < today;
      const isCredit = ob.kind === 'credit';
      const isDebt = ob.kind === 'debt';
      const isSub = ob.kind === 'subscription';
      const w = this.getWalletById(ob.walletId);

      let badgeLabel = 'Próximo';
      let iconPng = 'calendar.png';
      let bgCol = 'var(--cashew-upcoming)';

      if (isCredit) {
        badgeLabel = 'Prestado (Nos deben)';
        iconPng = 'loan.png';
        bgCol = 'var(--cashew-income)';
      } else if (isDebt) {
        badgeLabel = 'Deuda (Debemos)';
        iconPng = 'loan.png';
        bgCol = 'var(--cashew-expense)';
      } else if (isSub) {
        badgeLabel = 'Suscripción';
        iconPng = 'subscription.png';
        bgCol = 'var(--cashew-overdue)';
      }

      const actionWord = isCredit ? 'Cobrar' : 'Pagar';

      return `
        <div class="tx-row" style="${compact ? 'background:var(--bg-elevated); padding:9px 11px;' : ''}"
             onclick="CashewApp.openObligationModal('${ob.id}')">
          <div class="cat-circle" style="background:${isOverdue ? 'var(--cashew-expense)' : bgCol}; width:${compact ? 38 : 44}px; height:${compact ? 38 : 44}px;">
            ${window.renderCashewIconHTML({ iconPng }, compact ? 20 : 23)}
          </div>
          <div class="tx-info">
            <div class="tx-title-line" style="flex-wrap:wrap;">
              <span class="tx-title" style="${ob.settled ? 'text-decoration:line-through;opacity:0.6;' : ''}">
                ${this.escapeHtml(ob.title)}
              </span>
              ${isOverdue ? `<span class="overdue-badge">⚠️ Vencido</span>` : ''}
            </div>
            <div class="tx-sub">
              <span class="status-chip ${isCredit ? 'available' : isDebt || isOverdue ? 'out' : 'prep'}">${badgeLabel}</span>
              ${ob.person ? `<span>👤 ${this.escapeHtml(ob.person)}</span>` : ''}
              <span>• Fecha: <strong>${this.escapeHtml(ob.dueDate || '—')}</strong>${ob.time ? ' ' + this.escapeHtml(ob.time) : ''}</span>
              ${w ? `<span>• ${this.escapeHtml(w.name)}</span>` : ''}
            </div>
            ${(!compact && ob.note) ? `<div class="tx-note-preview">📝 ${this.escapeHtml(ob.note)}</div>` : ''}
          </div>
          <div style="display:flex; align-items:center; gap:9px; flex-shrink:0;">
            <span class="tx-amount ${isCredit ? 'income' : 'expense'}">
              ${isCredit ? '+' : '-'}${this.fmtWalletAmount(ob.amount, w)}
            </span>
            ${!ob.settled ? `
              <button class="btn-cashew ${isCredit ? 'btn-income' : 'btn-tonal'} btn-sm"
                      onclick="event.stopPropagation(); CashewApp.settleObligation('${ob.id}')">
                ${actionWord}
              </button>
            ` : `<span class="status-chip available">Completado</span>`}
          </div>
        </div>
      `;
    },

    /* ======================================================================
       PAGE 2: STOCK Y VENTAS (CORE REAL-TIME INVENTORY MODULE)
       ====================================================================== */
    buildStockPage() {
      const stats = this.getStockSummary();
      const allItems = this.activeList('stockItems')
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      const categories = Array.from(new Set(allItems.map(i => (i.category || 'General').trim()).filter(Boolean)));

      const filtered = allItems.filter(it => {
        const qty = Number(it.stock) || 0;
        if (this.stockTab === 'para_vender' && it.kind !== 'para_vender') return false;
        if (this.stockTab === 'en_preparacion' && it.kind !== 'en_preparacion') return false;
        if (this.stockTab === 'insumo' && it.kind !== 'insumo') return false;
        if (this.stockTab === 'out' && qty > (Number(it.minStock) || 0)) return false;

        if (this.stockCategoryFilter !== 'all' && (it.category || 'General') !== this.stockCategoryFilter) {
          return false;
        }
        if (this.stockSearch.trim()) {
          const q = this.stockSearch.toLowerCase();
          const hay = `${it.name} ${it.sku || ''} ${it.category || ''} ${it.notes || ''} ${it.extraDetail || ''} ${it.updatedBy || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      const movements = this.activeList('stockMovements')
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      return `
        <header class="cashew-greeting-header">
          <div>
            <div class="greeting-small">Inventario compartido sincronizado al instante</div>
            <h1 class="greeting-username">Stock y Ventas</h1>
          </div>
          <div class="header-actions-bar">
            <button class="btn-cashew btn-surface" onclick="CashewApp.onManualSyncClick()">
              <span class="material-symbols-rounded" style="font-size:19px;">sync</span>
              Sincronizar
            </button>
            <button class="btn-cashew btn-primary" onclick="CashewApp.openStockModal()">
              <span class="material-symbols-rounded" style="font-size:20px;">add_box</span>
              Subir Producto / Stock
            </button>
          </div>
        </header>

        ${this.renderPendingApprovalsBannerHTML()}

        <!-- 4 Tonal Cashew KPI Cards -->
        <section class="kpi-grid-4">
          <div class="kpi-cashew-card">
            <div class="kpi-top">
              <span>Stock para Vender</span>
              <div class="kpi-icon-box" style="background:var(--primary-container); color:var(--primary);">
                <span class="material-symbols-rounded">storefront</span>
              </div>
            </div>
            <div class="kpi-big-val">${this.fmtMoney(stats.retailValue, '$')}</div>
            <div class="kpi-foot">${stats.readyUnits} uds listas • ${stats.prepUnits} en preparación</div>
          </div>

          <div class="kpi-cashew-card">
            <div class="kpi-top">
              <span>Ganancia Proyectada</span>
              <div class="kpi-icon-box" style="background:var(--cashew-income-bg); color:var(--cashew-income);">
                <span class="material-symbols-rounded">trending_up</span>
              </div>
            </div>
            <div class="kpi-big-val" style="color:var(--cashew-income);">+${this.fmtMoney(stats.expectedProfit, '$')}</div>
            <div class="kpi-foot">Margen neto al vender el stock actual</div>
          </div>

          <div class="kpi-cashew-card">
            <div class="kpi-top">
              <span>Capital Invertido</span>
              <div class="kpi-icon-box" style="background:var(--cashew-overdue-bg); color:var(--cashew-overdue);">
                <span class="material-symbols-rounded">inventory_2</span>
              </div>
            </div>
            <div class="kpi-big-val">${this.fmtMoney(stats.investedCapital, '$')}</div>
            <div class="kpi-foot">Costo compra + inversión de preparación</div>
          </div>

          <div class="kpi-cashew-card" style="cursor:pointer;" onclick="CashewApp.setStockTab('out')">
            <div class="kpi-top">
              <span>Alertas / Stock Bajo</span>
              <div class="kpi-icon-box" style="background:var(--cashew-warning-bg); color:var(--cashew-warning);">
                <span class="material-symbols-rounded">notification_important</span>
              </div>
            </div>
            <div class="kpi-big-val" style="color:${stats.lowStockCount > 0 ? 'var(--cashew-warning)' : 'var(--cashew-income)'};">
              ${stats.lowStockCount} ítems
            </div>
            <div class="kpi-foot">${stats.lowStockCount > 0 ? 'Clic para filtrar artículos críticos' : 'Todo el stock sobre el mínimo'}</div>
          </div>
        </section>

        <!-- Segmented Tabs + Search Toolbar -->
        <div class="toolbar-row">
          <div class="segmented-pills">
            ${[
              { id: 'all', label: 'Todo', icon: 'apps' },
              { id: 'para_vender', label: 'Para Vender', icon: 'shopping_bag' },
              { id: 'en_preparacion', label: 'En Prep. / Taller', icon: 'build' },
              { id: 'insumo', label: 'Insumos / Repuestos', icon: 'memory' },
              { id: 'out', label: 'Stock Bajo / Agotados', icon: 'warning' },
              { id: 'kardex', label: 'Movimientos', icon: 'history' }
            ].map(t => `
              <button class="seg-pill ${this.stockTab === t.id ? 'active' : ''}"
                      onclick="CashewApp.setStockTab('${t.id}')">
                <span class="material-symbols-rounded" style="font-size:17px;">${t.icon}</span>
                ${t.label}
              </button>
            `).join('')}
          </div>
        </div>

        ${this.stockTab === 'kardex' ? this.buildStockKardexHTML(movements) : `
          <div class="toolbar-row">
            <div class="search-box">
              <span class="material-symbols-rounded" style="color:var(--text-muted);">search</span>
              <input id="stockSearchInput" type="text"
                     placeholder="Buscar por nombre, código SKU, categoría, detalle o socio..."
                     value="${this.escapeHtml(this.stockSearch)}"
                     oninput="CashewApp.onStockSearch(this.value)" />
              ${this.stockSearch ? `
                <button onclick="CashewApp.onStockSearch('')" style="color:var(--text-muted);">
                  <span class="material-symbols-rounded" style="font-size:18px;">close</span>
                </button>
              ` : ''}
            </div>

            <select class="cashew-select" style="width:auto; min-width:185px;"
                    onchange="CashewApp.setStockCategory(this.value)">
              <option value="all" ${this.stockCategoryFilter === 'all' ? 'selected' : ''}>Todas las categorías</option>
              ${categories.map(c => `
                <option value="${this.escapeHtml(c)}" ${this.stockCategoryFilter === c ? 'selected' : ''}>${this.escapeHtml(c)}</option>
              `).join('')}
            </select>
          </div>

          ${filtered.length === 0 ? `
            <div class="cashew-card empty-cashew">
              <span class="material-symbols-rounded">inventory_2</span>
              <div style="font-weight:700; font-size:16px; color:var(--text-main); margin-bottom:4px;">No hay artículos en esta vista</div>
              <div style="margin-bottom:14px;">Sube un nuevo producto o ajusta el filtro para verlo en tiempo real con tu compañero.</div>
              <button class="btn-cashew btn-primary" onclick="CashewApp.openStockModal()">
                <span class="material-symbols-rounded">add</span> Subir Producto al Stock
              </button>
            </div>
          ` : `
            <div class="stock-cards-grid">
              ${filtered.map(it => this.renderStockItemCardHTML(it)).join('')}
            </div>
          `}
        `}
      `;
    },

    renderStockItemCardHTML(it) {
      const qty = Math.max(0, Number(it.stock) || 0);
      const min = Math.max(0, Number(it.minStock) || 0);
      const unitCost = (Number(it.purchaseCost) || 0) + (Number(it.extraCost) || 0);
      const sale = Number(it.salePrice) || 0;
      const unitProfit = sale - unitCost;
      const pctMargin = unitCost > 0 ? Math.round((unitProfit / unitCost) * 100) : 100;

      const isOut = qty === 0;
      const isLow = !isOut && qty <= min;

      let statusChip = `<span class="status-chip available">Disponible</span>`;
      if (isOut) statusChip = `<span class="status-chip out">Agotado</span>`;
      else if (it.kind === 'en_preparacion') statusChip = `<span class="status-chip prep">En Preparación</span>`;
      else if (it.kind === 'insumo') statusChip = `<span class="status-chip supply">Insumo Taller</span>`;
      if (isLow) statusChip += ` <span class="status-chip low">Stock Bajo (mín. ${min})</span>`;

      const barTarget = Math.max(qty, min * 2, 5);
      const barPct = Math.min(100, Math.round((qty / barTarget) * 100));
      const barColor = isOut
        ? 'var(--cashew-expense)'
        : isLow
          ? 'var(--cashew-warning)'
          : (it.color || 'var(--primary)');

      return `
        <article class="stock-item-card ${isOut ? 'out-of-stock' : isLow ? 'low-stock' : ''}">
          <div class="stock-card-head">
            <div class="stock-thumb" style="background:${it.color || '#5f85c2'};">
              ${it.imageUrl
                ? `<img src="${this.escapeHtml(it.imageUrl)}" alt="${this.escapeHtml(it.name)}" onerror="this.style.display='none'"/>`
                : `<span class="material-symbols-rounded">${it.icon || 'inventory_2'}</span>`}
            </div>
            <div class="stock-head-info">
              <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:6px;">
                <h3 class="stock-title">${this.escapeHtml(it.name)}</h3>
                <button class="icon-btn" style="width:30px;height:30px;border-radius:10px;flex-shrink:0;"
                        title="Editar producto"
                        onclick="CashewApp.openStockModal('${it.id}')">
                  <span class="material-symbols-rounded" style="font-size:17px;">edit</span>
                </button>
              </div>
              <div class="stock-badges-row">
                ${statusChip}
                ${it.sku ? `<span style="font-size:11px; color:var(--text-muted); font-family:var(--font-mono);">${this.escapeHtml(it.sku)}</span>` : ''}
                <span class="author-tag">${this.escapeHtml(it.updatedBy || 'socio')}</span>
              </div>
            </div>
          </div>

          <div class="stock-pricing-box">
            <div>
              <div class="price-col-label">Costo Total</div>
              <div class="price-col-val">${this.fmtMoney(unitCost, '$')}</div>
            </div>
            <div>
              <div class="price-col-label">Precio Venta</div>
              <div class="price-col-val" style="color:var(--primary);">${this.fmtMoney(sale, '$')}</div>
            </div>
            <div>
              <div class="price-col-label">Ganancia</div>
              <div class="price-col-val" style="color:${unitProfit >= 0 ? 'var(--cashew-income)' : 'var(--cashew-expense)'};">
                ${unitProfit >= 0 ? '+' : ''}${this.fmtMoney(unitProfit, '$')}
              </div>
            </div>
          </div>

          ${(it.extraDetail || it.notes) ? `
            <div style="font-size:12px; color:var(--text-muted); line-height:1.35;">
              ${it.extraDetail ? `<div><strong>Detalle:</strong> ${this.escapeHtml(it.extraDetail)} (${pctMargin}% margen)</div>` : ''}
              ${it.notes ? `<div>${this.escapeHtml(it.notes)}</div>` : ''}
            </div>
          ` : ''}

          <div>
            <div class="stock-qty-bar" style="margin-bottom:7px;">
              <div style="font-size:12.5px; color:var(--text-muted); font-weight:700;">
                ${this.escapeHtml(it.category || 'General')} • <strong style="color:var(--text-main);">${qty} uds.</strong>
              </div>
              <div class="qty-stepper" title="Ajuste rápido en tiempo real">
                <button class="stepper-btn" onclick="CashewApp.quickStepStock('${it.id}', -1)">−</button>
                <span class="qty-num">${qty}</span>
                <button class="stepper-btn" onclick="CashewApp.quickStepStock('${it.id}', 1)">+</button>
              </div>
            </div>
            <div class="stock-mini-progress">
              <div class="stock-mini-fill" style="width:${barPct}%; background:${barColor};"></div>
            </div>
          </div>

          <div class="stock-card-actions">
            ${it.kind === 'en_preparacion' ? `
              <button class="btn-cashew btn-tonal btn-sm" onclick="CashewApp.markReadyForSale('${it.id}')">
                <span class="material-symbols-rounded" style="font-size:17px;">check_circle</span>
                Pasar a Venta
              </button>
            ` : `
              <button class="btn-cashew btn-income btn-sm" ${qty <= 0 ? 'disabled style="opacity:0.45;cursor:not-allowed;"' : ''}
                      onclick="CashewApp.openQuickSaleModal('${it.id}')">
                <span class="material-symbols-rounded" style="font-size:17px;">point_of_sale</span>
                Vender
              </button>
            `}
            <button class="btn-cashew btn-surface btn-sm" onclick="CashewApp.openRestockModal('${it.id}')">
              <span class="material-symbols-rounded" style="font-size:17px;">add_shopping_cart</span>
              + Stock
            </button>
          </div>
        </article>
      `;
    },

    buildStockKardexHTML(movements) {
      if (!movements || movements.length === 0) {
        return `<div class="cashew-card empty-cashew">
          <span class="material-symbols-rounded">history</span>
          <div>Aún no hay movimientos registrados en el historial de stock</div>
        </div>`;
      }
      return `
        <div class="cashew-card">
          <div class="cashew-card-header">
            <div class="cashew-card-title">
              <span class="material-symbols-rounded" style="color:var(--primary);">history</span>
              Kardex de Inventario en Tiempo Real
            </div>
          </div>
          <div style="display:flex; flex-direction:column; gap:6px;">
            ${movements.slice(0, 80).map(mv => {
              const isPos = (Number(mv.qtyChange) || 0) > 0;
              const isSale = mv.action === 'venta';
              const badgeColor = isSale ? 'var(--cashew-income)' : isPos ? 'var(--primary)' : 'var(--cashew-warning)';
              return `
                <div class="tx-row" style="cursor:default;">
                  <div class="cat-circle" style="background:${badgeColor}; width:40px; height:40px; font-size:19px;">
                    <span class="material-symbols-rounded">${isSale ? 'point_of_sale' : isPos ? 'south_west' : 'tune'}</span>
                  </div>
                  <div class="tx-info">
                    <div class="tx-title">${this.escapeHtml(mv.itemName)}</div>
                    <div class="tx-sub">
                      <span>${this.escapeHtml(mv.note || mv.action)}</span>
                      <span>•</span>
                      <span>Quedan: <strong>${mv.newStock}</strong></span>
                      <span>•</span>
                      <span>${this.escapeHtml(mv.date || '')} ${this.escapeHtml(mv.time || '')}</span>
                      <span class="author-tag">${this.escapeHtml(mv.updatedBy || 'socio')}</span>
                    </div>
                  </div>
                  <div style="text-align:right;">
                    <div style="font-weight:800; color:${isPos ? 'var(--cashew-income)' : 'var(--text-main)'};">
                      ${isPos ? '+' : ''}${mv.qtyChange} uds
                    </div>
                    ${mv.profit ? `<div style="font-size:11.5px; color:var(--cashew-income); font-weight:700;">Ganancia: +${this.fmtMoney(mv.profit, '$')}</div>` : ''}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    },

    setStockTab(tab) {
      this.stockTab = tab;
      this.renderMainView();
    },

    setStockCategory(cat) {
      this.stockCategoryFilter = cat;
      this.renderMainView();
    },

    onStockSearch(val) {
      this.stockSearch = val;
      this.renderAppPreservingFocus();
    },

    quickStepStock(id, delta) {
      const it = this.activeList('stockItems').find(x => x.id === id);
      if (!it) return;
      const nextQty = Math.max(0, (Number(it.stock) || 0) + delta);
      if (nextQty === it.stock) return;

      window.cashewSync.batchUpsert([
        {
          collection: 'stockItems',
          item: { ...it, stock: nextQty }
        },
        {
          collection: 'stockMovements',
          item: {
            stockId: it.id,
            itemName: it.name,
            action: delta > 0 ? 'ajuste_suma' : 'ajuste_resta',
            qtyChange: delta,
            newStock: nextQty,
            unitPrice: it.salePrice || 0,
            profit: 0,
            note: `Ajuste rápido (${delta > 0 ? '+' : ''}${delta})`,
            date: todayLocalISO(),
            time: nowHHMM()
          }
        }
      ], `Stock ${it.name}: ${nextQty} uds`);
    },

    markReadyForSale(id) {
      const it = this.activeList('stockItems').find(x => x.id === id);
      if (!it) return;
      window.cashewSync.upsertEntity(
        'stockItems',
        { ...it, kind: 'para_vender' },
        `Listo para vender: ${it.name}`
      );
      this.toast(`"${it.name}" ahora está disponible para vender`, 'check_circle');
    },

    /* ======================================================================
       PAGE 3: TRANSACCIONES (FULL CASHEW LEDGER WITH DATE, DAY, HOUR & NOTES)
       ====================================================================== */
    buildTransactionsPage() {
      const wallets = this.activeList('wallets');
      const profiles = this.getProfiles();
      const allTxs = this.activeList('transactions')
        .sort((a, b) => `${b.date || ''} ${b.time || '00:00'}`.localeCompare(`${a.date || ''} ${a.time || '00:00'}`) || (b.createdAt || 0) - (a.createdAt || 0));

      const filtered = allTxs.filter(tx => {
        const isCorr = tx.isBalanceCorrection || String(tx.categoryId) === '0';
        if (this.txTypeFilter === 'correction' && !isCorr) return false;
        if (this.txTypeFilter !== 'all' && this.txTypeFilter !== 'correction' && tx.type !== this.txTypeFilter) return false;

        if (this.txWalletFilter !== 'all' && tx.walletId !== this.txWalletFilter && tx.toWalletId !== this.txWalletFilter) return false;
        if (this.txAuthorFilter !== 'all') {
          const matchesSlot = tx.profileId === this.txAuthorFilter;
          const prof = this.getProfileById(this.txAuthorFilter);
          const matchesName = prof && String(tx.updatedBy || '').toLowerCase() === prof.username.toLowerCase();
          if (!matchesSlot && !matchesName) return false;
        }
        if (this.txSearch.trim()) {
          const q = this.txSearch.toLowerCase();
          const cat = this.getCategoryById(tx.categoryId);
          const hay = `${tx.title || ''} ${tx.note || ''} ${cat.name} ${tx.date || ''} ${tx.time || ''} ${tx.updatedBy || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      let sumInc = 0;
      let sumExp = 0;
      for (const t of filtered) {
        if (!this.isTxEffective(t)) continue;
        const valP = this.txToPrimary(Number(t.amount) || 0, t.walletId);
        if (t.type === 'income') sumInc += valP;
        else if (t.type === 'expense') sumExp += valP;
      }

      return `
        <header class="cashew-greeting-header">
          <div>
            <div class="greeting-small">Fecha, día, hora exacta, categoría, título y notas</div>
            <h1 class="greeting-username">Transacciones</h1>
          </div>
          <div class="header-actions-bar">
            <button class="btn-cashew btn-tonal" onclick="CashewApp.openBalanceCorrectionModal()">
              <span class="material-symbols-rounded">tune</span> Corregir Balance
            </button>
            <button class="btn-cashew btn-primary" onclick="CashewApp.openTransactionModal()">
              <span class="material-symbols-rounded">add</span> Nueva Transacción
            </button>
          </div>
        </header>

        ${this.renderPendingApprovalsBannerHTML()}

        <div class="kpi-grid-4" style="grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));">
          <div class="kpi-cashew-card">
            <div class="kpi-top"><span>Ingresos Filtrados (${this.escapeHtml(this.primaryCurrency)})</span></div>
            <div class="kpi-big-val" style="color:var(--cashew-income);">+${this.fmtMoney(sumInc)}</div>
          </div>
          <div class="kpi-cashew-card">
            <div class="kpi-top"><span>Gastos Filtrados (${this.escapeHtml(this.primaryCurrency)})</span></div>
            <div class="kpi-big-val" style="color:var(--cashew-expense);">-${this.fmtMoney(sumExp)}</div>
          </div>
          <div class="kpi-cashew-card">
            <div class="kpi-top"><span>Balance Neto (${filtered.length} movs)</span></div>
            <div class="kpi-big-val" style="color:${sumInc - sumExp >= 0 ? 'var(--cashew-income)' : 'var(--cashew-expense)'};">
              ${sumInc - sumExp >= 0 ? '+' : ''}${this.fmtMoney(sumInc - sumExp)}
            </div>
          </div>
        </div>

        <div class="toolbar-row">
          <div class="segmented-pills">
            ${[
              { id: 'all', label: 'Todas' },
              { id: 'income', label: 'Ingresos' },
              { id: 'expense', label: 'Gastos' },
              { id: 'transfer', label: 'Transferencias' },
              { id: 'correction', label: 'Correcciones' }
            ].map(f => `
              <button class="seg-pill ${this.txTypeFilter === f.id ? 'active' : ''}"
                      onclick="CashewApp.txTypeFilter='${f.id}'; CashewApp.renderMainView();">${f.label}</button>
            `).join('')}
          </div>

          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <select class="cashew-select" style="width:auto;" onchange="CashewApp.txWalletFilter=this.value; CashewApp.renderMainView();">
              <option value="all">Todas las cuentas</option>
              ${wallets.map(w => `<option value="${w.id}" ${this.txWalletFilter === w.id ? 'selected' : ''}>${this.escapeHtml(w.name)} (${this.escapeHtml(w.currency)})</option>`).join('')}
            </select>
            <select class="cashew-select" style="width:auto;" onchange="CashewApp.txAuthorFilter=this.value; CashewApp.renderMainView();">
              <option value="all">Ambos perfiles</option>
              ${profiles.map(p => `<option value="${p.id}" ${this.txAuthorFilter === p.id ? 'selected' : ''}>Solo ${this.escapeHtml(p.displayName || p.username)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="toolbar-row">
          <div class="search-box">
            <span class="material-symbols-rounded" style="color:var(--text-muted);">search</span>
            <input id="txSearchInput" type="text" placeholder="Buscar transacción por título, nota, categoría, fecha u hora..."
                   value="${this.escapeHtml(this.txSearch)}"
                   oninput="CashewApp.txSearch=this.value; CashewApp.renderAppPreservingFocus();" />
            ${this.txSearch ? `
              <button onclick="CashewApp.txSearch=''; CashewApp.renderMainView();" style="color:var(--text-muted);">
                <span class="material-symbols-rounded" style="font-size:18px;">close</span>
              </button>
            ` : ''}
          </div>
        </div>

        <div class="cashew-card">
          ${this.renderTransactionsGroupedHTML(filtered)}
        </div>
      `;
    },

    /* ======================================================================
       PAGE 4: PAGOS PRÓXIMAMENTE, VENCIDOS, SUSCRIPCIONES, PRESTADOS Y DEUDAS
       ====================================================================== */
    buildObligationsPage() {
      const obSum = this.getObligationsSummary();
      const today = todayLocalISO();

      let list = [];
      if (this.obligationTab === 'all') {
        list = [...obSum.overdue, ...obSum.upcoming, ...obSum.credits.filter(x => !x.dueDate || x.dueDate >= today), ...obSum.debts.filter(x => !x.dueDate || x.dueDate >= today)];
        // deduplicate preserving order
        const seen = new Set();
        list = list.filter(x => { if (seen.has(x.id)) return false; seen.add(x.id); return true; });
      } else if (this.obligationTab === 'overdue') {
        list = obSum.overdue;
      } else if (this.obligationTab === 'upcoming') {
        list = obSum.upcoming;
      } else if (this.obligationTab === 'subscription') {
        list = obSum.subscriptions;
      } else if (this.obligationTab === 'credit') {
        list = obSum.credits;
      } else if (this.obligationTab === 'debt') {
        list = obSum.debts;
      } else if (this.obligationTab === 'settled') {
        list = obSum.settled;
      }

      return `
        <header class="cashew-greeting-header">
          <div>
            <div class="greeting-small">Control exacto estilo Cashew de pagos programados y préstamos</div>
            <h1 class="greeting-username">Próximamente, Vencidos y Deudas</h1>
          </div>
          <button class="btn-cashew btn-primary" onclick="CashewApp.openObligationModal()">
            <span class="material-symbols-rounded">add</span> Nuevo Registro
          </button>
        </header>

        <section class="kpi-grid-4">
          <div class="kpi-cashew-card" style="cursor:pointer;" onclick="CashewApp.obligationTab='upcoming'; CashewApp.renderMainView();">
            <div class="kpi-top">
              <span>Pagos Próximamente</span>
              <div class="kpi-icon-box" style="background:var(--cashew-upcoming-bg); color:var(--cashew-upcoming);">
                <span class="material-symbols-rounded">schedule</span>
              </div>
            </div>
            <div class="kpi-big-val" style="color:var(--cashew-upcoming);">${this.fmtMoney(obSum.upcomingTotal)}</div>
            <div class="kpi-foot">${obSum.upcoming.length} pago(s) programados a tiempo</div>
          </div>

          <div class="kpi-cashew-card" style="cursor:pointer;" onclick="CashewApp.obligationTab='overdue'; CashewApp.renderMainView();">
            <div class="kpi-top">
              <span>Vencidos</span>
              <div class="kpi-icon-box" style="background:var(--cashew-expense-bg); color:var(--cashew-expense);">
                <span class="material-symbols-rounded">warning</span>
              </div>
            </div>
            <div class="kpi-big-val" style="color:${obSum.overdueTotal > 0 ? 'var(--cashew-expense)' : 'var(--cashew-income)'};">${this.fmtMoney(obSum.overdueTotal)}</div>
            <div class="kpi-foot">${obSum.overdue.length} registro(s) con fecha vencida</div>
          </div>

          <div class="kpi-cashew-card" style="cursor:pointer;" onclick="CashewApp.obligationTab='credit'; CashewApp.renderMainView();">
            <div class="kpi-top">
              <span>Prestados (Nos deben)</span>
              <div class="kpi-icon-box" style="background:var(--cashew-income-bg); color:var(--cashew-income);">
                <span class="material-symbols-rounded">call_received</span>
              </div>
            </div>
            <div class="kpi-big-val" style="color:var(--cashew-income);">${this.fmtMoney(obSum.creditsTotal)}</div>
            <div class="kpi-foot">${obSum.credits.length} cuenta(s) por cobrar</div>
          </div>

          <div class="kpi-cashew-card" style="cursor:pointer;" onclick="CashewApp.obligationTab='debt'; CashewApp.renderMainView();">
            <div class="kpi-top">
              <span>Deudas (Debemos)</span>
              <div class="kpi-icon-box" style="background:var(--cashew-overdue-bg); color:var(--cashew-overdue);">
                <span class="material-symbols-rounded">call_made</span>
              </div>
            </div>
            <div class="kpi-big-val" style="color:var(--cashew-expense);">${this.fmtMoney(obSum.debtsTotal)}</div>
            <div class="kpi-foot">${obSum.debts.length} deuda(s) pendientes por pagar</div>
          </div>
        </section>

        <div class="toolbar-row">
          <div class="segmented-pills">
            ${[
              { id: 'all', label: 'Todos Activos' },
              { id: 'upcoming', label: `Próximamente (${obSum.upcoming.length})` },
              { id: 'overdue', label: `Vencidos (${obSum.overdue.length})` },
              { id: 'subscription', label: `Suscripciones (${obSum.subscriptions.length})` },
              { id: 'credit', label: `Prestados (${obSum.credits.length})` },
              { id: 'debt', label: `Deudas (${obSum.debts.length})` },
              { id: 'settled', label: `Completados (${obSum.settled.length})` }
            ].map(t => `
              <button class="seg-pill ${this.obligationTab === t.id ? 'active' : ''}"
                      onclick="CashewApp.obligationTab='${t.id}'; CashewApp.renderMainView();">${t.label}</button>
            `).join('')}
          </div>
        </div>

        <div class="cashew-card">
          ${list.length === 0
            ? `<div class="empty-cashew"><span class="material-symbols-rounded">event_available</span><div>Sin registros en esta pestaña</div></div>`
            : `<div style="display:flex; flex-direction:column; gap:6px;">${list.map(ob => this.renderObligationRowHTML(ob, false)).join('')}</div>`
          }
        </div>
      `;
    },

    settleObligation(id) {
      const ob = this.activeList('obligations').find(x => x.id === id);
      if (!ob || ob.settled) return;

      if (!this.canUserDirectlyMutate('obligations', id)) {
        this.submitApprovalRequest('obligations', id, 'update', { ...ob, settled: true }, `Liquidar pendiente: ${ob.title}`);
        this.toast('Solicitud enviada a tu compañero para confirmar la liquidación', 'hourglass_top');
        return;
      }

      const isCredit = ob.kind === 'credit';
      const defaultWallet = ob.walletId || (this.activeList('wallets')[0] && this.activeList('wallets')[0].id);

      const ops = [
        {
          collection: 'obligations',
          item: { ...ob, settled: true }
        },
        {
          collection: 'transactions',
          item: {
            title: `${isCredit ? 'Cobro' : 'Pago'}: ${ob.title}`,
            amount: Number(ob.amount) || 0,
            type: isCredit ? 'income' : 'expense',
            categoryId: ob.categoryId || (isCredit ? 'c_servicio' : 'c_operativo'),
            walletId: defaultWallet,
            date: todayLocalISO(),
            time: nowHHMM(),
            paid: true,
            specialType: ob.kind,
            note: [ob.person ? `Contacto: ${ob.person}` : '', ob.note || 'Liquidado desde Próximos y Deudas'].filter(Boolean).join(' • ')
          }
        }
      ];

      // If it is a monthly subscription, automatically schedule next month's upcoming occurrence just like Cashew!
      if (ob.kind === 'subscription' && ob.dueDate) {
        try {
          const d = new Date(ob.dueDate + 'T12:00:00');
          d.setMonth(d.getMonth() + 1);
          const nextDue = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          ops.push({
            collection: 'obligations',
            item: {
              title: ob.title,
              amount: Number(ob.amount) || 0,
              kind: 'subscription',
              dueDate: nextDue,
              time: ob.time || '09:00',
              walletId: defaultWallet,
              categoryId: ob.categoryId || 'c_operativo',
              person: ob.person || '',
              note: ob.note || 'Renovación mensual automática',
              settled: false
            }
          });
        } catch (e) {}
      }

      window.cashewSync.batchUpsert(ops, `${isCredit ? 'Cobrado' : 'Pagado'}: ${ob.title}`);
      this.toast(
        ob.kind === 'subscription'
          ? 'Pago registrado y próximo mes programado automáticamente'
          : `${isCredit ? 'Cobro sumado a cuenta' : 'Pago descontado de cuenta'}`,
        'check_circle'
      );
    },

    /* ======================================================================
       PAGE 5: PRESUPUESTOS (CASHEW BUDGETS)
       ====================================================================== */
    buildBudgetsPage() {
      const budgets = this.activeList('budgets');
      return `
        <header class="cashew-greeting-header">
          <div>
            <div class="greeting-small">Control mensual con indicador de ritmo diario</div>
            <h1 class="greeting-username">Presupuestos</h1>
          </div>
          <button class="btn-cashew btn-primary" onclick="CashewApp.openBudgetModal()">
            <span class="material-symbols-rounded">add</span> Nuevo Presupuesto
          </button>
        </header>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(330px, 1fr)); gap:16px;">
          ${budgets.length === 0 ? `
            <div class="cashew-card empty-cashew">
              <span class="material-symbols-rounded">donut_small</span>
              <div>Crea un presupuesto para controlar límites de compras y gastos</div>
            </div>
          ` : budgets.map(b => `
            <div class="cashew-card" style="padding:14px;">
              ${this.renderBudgetCardHTML(b)}
            </div>
          `).join('')}
        </div>
      `;
    },

    /* ======================================================================
       PAGE 6: METAS (CASHEW GOALS / OBJECTIVES)
       ====================================================================== */
    buildGoalsPage() {
      const goals = this.activeList('goals');
      return `
        <header class="cashew-greeting-header">
          <div>
            <div class="greeting-small">Ahorros, reposición de lotes y objetivos financieros</div>
            <h1 class="greeting-username">Metas</h1>
          </div>
          <button class="btn-cashew btn-primary" onclick="CashewApp.openGoalModal()">
            <span class="material-symbols-rounded">add</span> Nueva Meta
          </button>
        </header>

        <div class="stock-cards-grid">
          ${goals.length === 0 ? `
            <div class="cashew-card empty-cashew" style="grid-column:1/-1;">
              <span class="material-symbols-rounded">savings</span>
              <div>Crea tu primera meta compartida</div>
            </div>
          ` : goals.map(g => {
            const cur = Number(g.currentAmount) || 0;
            const target = Math.max(1, Number(g.targetAmount) || 1);
            const pct = Math.min(100, Math.round((cur / target) * 100));
            return `
              <div class="cashew-card">
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
                  <div style="display:flex; align-items:center; gap:12px;">
                    <div class="cat-circle" style="background:${g.color || '#4db685'};">
                      ${window.renderCashewIconHTML(g, 24)}
                    </div>
                    <div>
                      <div style="font-weight:800; font-size:17px;">${this.escapeHtml(g.name)}</div>
                      <div style="font-size:12px; color:var(--text-muted);">${this.escapeHtml(g.note || 'Meta compartida')}</div>
                    </div>
                  </div>
                  <button class="icon-btn" onclick="CashewApp.openGoalModal('${g.id}')">
                    <span class="material-symbols-rounded" style="font-size:18px;">edit</span>
                  </button>
                </div>

                <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
                  <span style="font-size:24px; font-weight:800;">${this.fmtMoney(cur)}</span>
                  <span style="font-size:13.5px; color:var(--text-muted); font-weight:700;">de ${this.fmtMoney(target)} (${pct}%)</span>
                </div>

                <div class="budget-track-inner" style="height:16px; background:var(--bg-input); margin-bottom:14px;">
                  <div class="budget-fill" style="width:${pct}%; background:${g.color || 'var(--primary)'};"></div>
                </div>

                <button class="btn-cashew btn-tonal" style="width:100%;" onclick="CashewApp.openGoalDepositModal('${g.id}')"
                        title="Abonar a la meta descontando de una cuenta o retirar fondos">
                  <span class="material-symbols-rounded" style="font-size:18px;">payments</span>
                  Abonar / Retirar Fondos de Cuenta
                </button>
              </div>
            `;
          }).join('')}
        </div>
      `;
    },

    /* ======================================================================
       PAGE 7: ESTADÍSTICAS Y MAPA DE CALOR (ALL SPENDING SUMMARY)
       ====================================================================== */
    buildAnalyticsPage() {
      const cashflowMonth = this.getMonthCashflow('all', this.selectedMonthYM);
      const txs = this.activeList('transactions').filter(t => this.isTxEffective(t));
      const expByCat = new Map();
      const incByCat = new Map();
      const profiles = this.getProfiles();
      const byProfile = {};
      for (const p of profiles) byProfile[p.id] = { label: p.displayName || p.username, income: 0, expense: 0, count: 0 };

      let allTimeInc = 0;
      let allTimeExp = 0;

      for (const tx of txs) {
        if (tx.isBalanceCorrection || String(tx.categoryId) === '0') continue;
        const amt = this.txToPrimary(Number(tx.amount) || 0, tx.walletId);
        const cat = this.getCategoryById(tx.categoryId);

        let pSlot = tx.profileId;
        if (!pSlot || !byProfile[pSlot]) {
          const found = profiles.find(pr => pr.username.toLowerCase() === String(tx.updatedBy || '').toLowerCase());
          pSlot = found ? found.id : profiles[0].id;
        }
        byProfile[pSlot].count += 1;

        if (tx.type === 'expense') {
          allTimeExp += amt;
          byProfile[pSlot].expense += amt;
          const prev = expByCat.get(cat.id) || { name: cat.name, color: cat.color, value: 0 };
          prev.value += amt;
          expByCat.set(cat.id, prev);
        } else if (tx.type === 'income') {
          allTimeInc += amt;
          byProfile[pSlot].income += amt;
          const prev = incByCat.get(cat.id) || { name: cat.name, color: cat.color, value: 0 };
          prev.value += amt;
          incByCat.set(cat.id, prev);
        }
      }

      const expSlices = Array.from(expByCat.values()).sort((a, b) => b.value - a.value);
      const incSlices = Array.from(incByCat.values()).sort((a, b) => b.value - a.value);
      const series = this.getNetWorthSeries('all', 28);
      const dailyHeatmap = this.getDailyHeatmapMap('all');
      const fmtP = (v) => this.fmtMoney(v);

      return `
        <header class="cashew-greeting-header">
          <div>
            <div class="greeting-small">Ganancia y Pérdida, Mapa de Calor y Distribución en ${this.escapeHtml(this.primaryCurrency)}</div>
            <h1 class="greeting-username">Estadísticas y Mapa de Calor</h1>
          </div>
          <div class="month-nav-pill">
            <button type="button" onclick="CashewApp.shiftSelectedMonth(-1)"><span class="material-symbols-rounded">chevron_left</span></button>
            <span style="text-transform:capitalize;">${this.escapeHtml(this.getMonthDisplayName(this.selectedMonthYM))}</span>
            <button type="button" onclick="CashewApp.shiftSelectedMonth(1)"><span class="material-symbols-rounded">chevron_right</span></button>
          </div>
        </header>

        <div class="cashew-card" style="margin-bottom:18px;">
          <div class="cashew-card-header">
            <div>
              <div class="cashew-card-title">
                <span class="material-symbols-rounded" style="color:var(--cashew-income);">calendar_month</span>
                Mapa de Calor Completo (Últimos 6 Meses)
              </div>
              <div class="cashew-card-subtitle">Haz clic en cualquier cuadro para inspeccionar o añadir transacciones en esa fecha</div>
            </div>
          </div>
          ${window.CashewCharts.renderCashewHeatmapHTML(dailyHeatmap, { weeks: 27, fmtFn: fmtP })}
        </div>

        <div class="cashew-home-grid">
          <div class="cashew-col">
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div class="cashew-card-title">Gráfico Circular Ganancia y Pérdida (${this.escapeHtml(this.getMonthDisplayName(this.selectedMonthYM))})</div>
              </div>
              ${window.CashewCharts.renderProfitLossRingSVG(cashflowMonth.income, cashflowMonth.expense, fmtP)}
            </div>

            <div class="cashew-card">
              <div class="cashew-card-header">
                <div class="cashew-card-title">Distribución Histórica de Gastos</div>
              </div>
              ${window.CashewCharts.renderDonutSVG(expSlices, 'Gastos', fmtP(allTimeExp), fmtP)}
            </div>
          </div>

          <div class="cashew-col">
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div class="cashew-card-title">Fuentes Históricas de Ingresos</div>
              </div>
              ${window.CashewCharts.renderDonutSVG(incSlices, 'Ingresos', fmtP(allTimeInc), fmtP)}
            </div>

            <div class="cashew-card">
              <div class="cashew-card-header">
                <div class="cashew-card-title">Curva de Valor Neto (28 días)</div>
              </div>
              ${window.CashewCharts.renderAreaLineSVG(series, { symbol: this.primarySymbol })}
            </div>

            <div class="cashew-card">
              <div class="cashew-card-header">
                <div class="cashew-card-title">Actividad por Perfil</div>
              </div>
              <div class="cashflow-duo">
                ${profiles.map(p => {
                  const stP = byProfile[p.id];
                  return `
                    <div class="cashflow-pill-card">
                      <div class="profile-mini-avatar">${this.escapeHtml(this.getAvatarInitials(stP.label))}</div>
                      <div>
                        <div class="cashflow-label">${this.escapeHtml(stP.label)} (${stP.count} movs)</div>
                        <div class="cashflow-val inc" style="font-size:16px;">+${fmtP(stP.income)}</div>
                        <div style="font-size:11.5px; color:var(--cashew-expense); font-weight:700;">-${fmtP(stP.expense)}</div>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          </div>
        </div>
      `;
    },

    /* ======================================================================
       PAGE 8: CUENTAS, CORRECCIONES DE BALANCE, MONEDAS Y CATEGORÍAS CASHEW
       ====================================================================== */
    buildAccountsPage() {
      const wallets = this.activeList('wallets');
      const categories = this.activeList('categories');
      const ratesDate = window.cashewCurrency.ratesDate || 'En vivo';

      return `
        <header class="cashew-greeting-header">
          <div>
            <div class="greeting-small">Cuentas multimoneda, correcciones de balance y 277 íconos oficiales Cashew</div>
            <h1 class="greeting-username">Cuentas y Categorías</h1>
          </div>
          <div class="header-actions-bar">
            <button class="btn-cashew btn-surface" onclick="CashewApp.openCurrencyRatesModal()">
              <span class="material-symbols-rounded" style="color:var(--primary);">currency_exchange</span>
              Monedas GitHub (${this.escapeHtml(this.primaryCurrency)})
            </button>
            <button class="btn-cashew btn-tonal" onclick="CashewApp.openCategoryModal()">
              <span class="material-symbols-rounded">add_circle</span> Crear Categoría
            </button>
            <button class="btn-cashew btn-primary" onclick="CashewApp.openWalletModal()">
              <span class="material-symbols-rounded">account_balance_wallet</span> Nueva Cuenta
            </button>
          </div>
        </header>

        <div class="cashew-home-grid">
          <div class="cashew-col">
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div>
                  <div class="cashew-card-title">Cuentas / Billeteras</div>
                  <div class="cashew-card-subtitle">Tasas oficiales Cashew GitHub (${this.escapeHtml(ratesDate)})</div>
                </div>
                <button class="btn-cashew btn-tonal btn-sm" onclick="CashewApp.openBalanceCorrectionModal()">
                  <span class="material-symbols-rounded" style="font-size:16px;">tune</span> Corregir Balance
                </button>
              </div>

              <div style="display:flex; flex-direction:column; gap:10px;">
                ${wallets.map(w => {
                  const bal = this.getWalletBalance(w.id);
                  const wCur = (w.currency || 'USD').toUpperCase();
                  const showConv = wCur !== this.primaryCurrency;
                  return `
                    <div class="tx-row" style="background:var(--bg-elevated);" onclick="CashewApp.openWalletModal('${w.id}')">
                      <div class="cat-circle" style="background:${w.color || '#5f85c2'};">
                        ${window.renderCashewIconHTML(w, 24)}
                      </div>
                      <div class="tx-info">
                        <div class="tx-title">${this.escapeHtml(w.name)}</div>
                        <div class="tx-sub">
                          <span class="wallet-currency-tag">${this.escapeHtml(wCur)}</span>
                          ${showConv ? `<span>1 USD = ${window.cashewCurrency.getRatePerUSD(wCur).toFixed(2)} ${this.escapeHtml(wCur)}</span>` : '<span>Moneda principal</span>'}
                        </div>
                      </div>
                      <div style="text-align:right; display:flex; align-items:center; gap:8px;">
                        <div>
                          <div style="font-weight:800; font-size:17px;">${this.fmtWalletAmount(bal, w)}</div>
                          ${showConv ? `<div style="font-size:11.5px; color:var(--primary); font-weight:700;">≈ ${this.fmtMoney(window.cashewCurrency.toPrimary(bal, wCur))}</div>` : ''}
                        </div>
                        <button type="button" class="btn-cashew btn-tonal btn-sm"
                                title="Editar nombre, color o eliminar cuenta"
                                onclick="event.stopPropagation(); CashewApp.openWalletModal('${w.id}')">
                          <span class="material-symbols-rounded" style="font-size:16px;">edit</span>
                          Editar
                        </button>
                        <button type="button" class="btn-cashew btn-surface btn-sm"
                                title="Ajustar / Corregir balance real"
                                onclick="event.stopPropagation(); CashewApp.openBalanceCorrectionModal('${w.id}')">
                          <span class="material-symbols-rounded" style="font-size:16px;">tune</span>
                          Corregir
                        </button>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          </div>

          <div class="cashew-col">
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div>
                  <div class="cashew-card-title">Categorías Oficiales estilo Cashew</div>
                  <div class="cashew-card-subtitle">Toca cualquiera para cambiar su ícono ilustrado o color</div>
                </div>
                <button class="btn-cashew btn-primary btn-sm" onclick="CashewApp.openCategoryModal()">
                  + Nueva
                </button>
              </div>
              <div style="display:flex; flex-direction:column; gap:8px;">
                ${categories.map(c => `
                  <div class="tx-row" onclick="CashewApp.openCategoryModal('${c.id}')">
                    <div class="cat-circle" style="background:${c.color || '#5f85c2'}; width:42px; height:42px;">
                      ${window.renderCashewIconHTML(c, 23)}
                    </div>
                    <div class="tx-info">
                      <div class="tx-title">${this.escapeHtml(c.name)}</div>
                      <div class="tx-sub">
                        <span class="tx-kind-pill ${c.type === 'income' ? 'inc' : c.type === 'expense' ? 'exp' : 'cor'}">
                          ${c.type === 'income' ? 'Ingreso' : c.type === 'expense' ? 'Gasto' : 'Ambos / Balance'}
                        </span>
                        ${c.iconPng ? `<span style="font-size:11px; opacity:0.7;">${this.escapeHtml(c.iconPng.replace('.png', ''))}</span>` : ''}
                      </div>
                    </div>
                    <span class="material-symbols-rounded" style="color:var(--text-muted); font-size:18px;">edit</span>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>
        </div>
      `;
    },

    /* ======================================================================
       PAGE 9: PERFIL Y CHAT EN TIEMPO REAL ENTRE SOCIOS
       (Persistent Firebase Chat + Editable Username & Password!)
       ====================================================================== */
    renderChatMessageContent(m) {
      const hasMedia = Boolean(m.mediaKey);
      const imgHTML = hasMedia ? this.renderChatImageHTML(m) : '';

      let inlineMediaHTML = '';
      let formattedText = '';
      if (m.text) {
        const raw = String(m.text);
        // Detect direct GIF/image URLs or Tenor/Giphy links so they play in motion inline
        const mediaMatch = raw.match(/https?:\/\/[^\s<>"']+(?:\.(?:gif|webp|png|jpe?g)(?:\?[^\s<>"']*)?)|https?:\/\/(?:[a-zA-Z0-9-]+\.)?(?:giphy\.com|tenor\.com|imgur\.com|gifer\.com)\/[^\s<>"']+/i);
        if (mediaMatch) {
          const mediaUrl = mediaMatch[0];
          inlineMediaHTML = `
            <div class="chat-inline-gif-box">
              <img src="${this.escapeHtml(mediaUrl)}" class="chat-inline-gif" alt="GIF animado" loading="lazy"
                   onerror="this.parentElement.style.display='none';" />
            </div>
          `;
        }
        const escaped = this.escapeHtml(raw);
        formattedText = escaped.replace(/(https?:\/\/[^\s]+)/gi, (url) => {
          return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:inherit; text-decoration:underline; word-break:break-all;">${url}</a>`;
        });
      }

      const textHTML = formattedText ? `<div class="chat-bubble-text">${formattedText}</div>` : '';
      return `${imgHTML}${inlineMediaHTML}${textHTML}`;
    },

    renderChatMessagesHTML() {
      // WhatsApp-style ephemeral messages: auto-filter messages older than 30 days
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const msgs = this.activeList('chatMessages')
        .filter(m => {
          if (!m) return false;
          const t = Number(m.createdAt) || (m.date ? new Date(`${m.date}T${m.time || '12:00'}:00`).getTime() : 0);
          return t >= thirtyDaysAgo;
        })
        .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));

      const ephemeralNotice = `
        <div style="background:var(--bg-elevated); border:1px dashed var(--primary); border-radius:14px; padding:8px 12px; margin-bottom:12px; text-align:center; font-size:12px; color:var(--text-muted); display:flex; align-items:center; justify-content:center; gap:6px;">
          <span class="material-symbols-rounded" style="font-size:16px; color:var(--primary);">hourglass_top</span>
          <span><strong>Mensajes temporales (30 días):</strong> Se eliminan solos para cuidar el almacenamiento.</span>
        </div>
      `;

      if (msgs.length === 0) {
        const partner = this.getPartnerProfile();
        return ephemeralNotice + `
          <div class="empty-cashew" style="margin:auto;">
            <span class="material-symbols-rounded">forum</span>
            <div style="font-weight:800; color:var(--text-main); margin-bottom:4px;">Chat Privado • Doomlater.Corp</div>
            <div style="font-size:13px;">Escribe el primer mensaje para <strong>${this.escapeHtml(partner.displayName || partner.username)}</strong>. Los mensajes se borran automáticamente tras 30 días para no saturar la base de datos.</div>
          </div>
        `;
      }

      const ONE_HOUR_MS = 60 * 60 * 1000;
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();

      const html = ephemeralNotice + msgs.map(m => {
        const isMine = m.senderProfileId === this.profileId;
        const senderProf = this.getProfileById(m.senderProfileId);
        const senderLabel = senderProf ? (senderProf.displayName || senderProf.username) : (m.senderName || 'Socio');
        const hasMedia = Boolean(m.mediaKey);
        const contentHTML = this.renderChatMessageContent(m);

        const msgTime = Number(m.createdAt) || (m.date ? new Date(`${m.date}T${m.time || '12:00'}:00`).getTime() : 0);
        const ageMs = now - msgTime;
        const canEdit = isMine && ageMs >= 0 && ageMs <= ONE_HOUR_MS;
        const canDelete = isMine && ageMs >= 0 && ageMs <= TWENTY_FOUR_HOURS_MS;

        return `
          <div class="chat-msg-row ${isMine ? 'mine' : 'theirs'}">
            <div style="display:flex; align-items:flex-end; gap:8px; flex-direction:${isMine ? 'row-reverse' : 'row'}; max-width:100%;">
              ${this.getProfileAvatarHTML(senderProf, 30)}
              <div class="chat-bubble ${hasMedia ? 'has-image' : ''}">${contentHTML}</div>
            </div>
            <div class="chat-msg-meta" style="margin-${isMine ? 'right' : 'left'}:38px; ${isMine ? 'justify-content:flex-end;' : ''}">
              <span>${this.escapeHtml(senderLabel)}</span>
              <span>•</span>
              <span>${this.escapeHtml(m.date || '')} ${this.escapeHtml(m.time || '')}</span>
              ${m.isEdited ? '<span class="chat-edited-badge" title="Mensaje editado">(editado)</span>' : ''}
              ${hasMedia ? '<span>•</span><span class="material-symbols-rounded" style="font-size:12px;" title="Se elimina en 30 días">timer</span>' : ''}
              ${(canEdit || canDelete) ? `
                <span>•</span>
                <span style="display:inline-flex; align-items:center; gap:3px;">
                  ${canEdit ? `
                    <button type="button" class="chat-bubble-action-btn" title="Editar mensaje (disponible en la 1ra hora)"
                            onclick="event.stopPropagation(); CashewApp.openEditChatMessageModal('${this.escapeHtml(m.id)}')">
                      <span class="material-symbols-rounded">edit</span>
                    </button>
                  ` : ''}
                  ${canDelete ? `
                    <button type="button" class="chat-bubble-action-btn chat-bubble-delete-btn" title="Eliminar mensaje (disponible en las primeras 24 horas)"
                            onclick="event.stopPropagation(); CashewApp.confirmDeleteChatMessage('${this.escapeHtml(m.id)}')">
                      <span class="material-symbols-rounded">delete</span>
                    </button>
                  ` : ''}
                </span>
              ` : ''}
            </div>
          </div>
        `;
      }).join('');

      setTimeout(() => this.hydrateChatImages(), 0);
      return html;
    },

    /* ======================================================================
       CHAT IMAGES & ANIMATED GIFS (auto-deleted after 30 days)
       ====================================================================== */
    renderChatImageHTML(m) {
      this._chatMediaCache = this._chatMediaCache || new Map();
      const key = m.mediaKey;
      const cached = this._chatMediaCache.get(key);
      const w = Number(m.imageW) || 4;
      const h = Number(m.imageH) || 3;
      const isGif = m.mediaType === 'gif';
      return `
        <div class="chat-img-box ${isGif ? 'is-gif' : ''}" style="aspect-ratio:${w} / ${h};"
             onclick="CashewApp.openChatImageViewer('${this.escapeHtml(key)}')">
          <img class="chat-img" data-media-key="${this.escapeHtml(key)}"
               ${cached ? `src="${cached}"` : ''} alt="${isGif ? 'GIF animado' : 'Imagen del chat'}" />
          ${cached ? '' : `<div class="chat-img-loading"><span class="material-symbols-rounded">${isGif ? 'gif' : 'image'}</span> Cargando ${isGif ? 'GIF' : 'imagen'}...</div>`}
          ${isGif ? '<span class="chat-gif-badge">GIF</span>' : ''}
        </div>
      `;
    },

    hydrateChatImages() {
      this._chatMediaCache = this._chatMediaCache || new Map();
      this._chatMediaWatchers = this._chatMediaWatchers || new Map();
      const imgs = document.querySelectorAll('img.chat-img[data-media-key]');
      imgs.forEach(img => {
        const key = img.getAttribute('data-media-key');
        if (!key) return;
        const cached = this._chatMediaCache.get(key);
        if (cached) {
          if (!img.getAttribute('src')) this.applyChatImageToDom(key, cached);
          return;
        }
        if (this._chatMediaWatchers.has(key)) return;
        const unsub = window.cashewSync.watchChatMedia(key, (dataUrl) => {
          this._chatMediaCache.set(key, dataUrl);
          this._chatMediaWatchers.delete(key);
          this.applyChatImageToDom(key, dataUrl);
        });
        this._chatMediaWatchers.set(key, unsub);
      });
    },

    applyChatImageToDom(key, dataUrl) {
      document.querySelectorAll('img.chat-img[data-media-key]').forEach(img => {
        if (img.getAttribute('data-media-key') !== key) return;
        img.src = dataUrl;
        const loader = img.parentElement && img.parentElement.querySelector('.chat-img-loading');
        if (loader) loader.remove();
      });
    },

    openChatImageViewer(key) {
      const dataUrl = this._chatMediaCache && this._chatMediaCache.get(key);
      if (!dataUrl) {
        this.toast('La imagen aún se está cargando...', 'hourglass_top');
        return;
      }
      const isGif = dataUrl.startsWith('data:image/gif');
      const old = document.getElementById('chatImageViewer');
      if (old) old.remove();
      const ov = document.createElement('div');
      ov.id = 'chatImageViewer';
      ov.className = 'chat-image-viewer';
      ov.innerHTML = `
        <div class="chat-image-viewer-bar">
          <a class="btn-cashew btn-surface btn-sm" href="${dataUrl}" download="doomlater_chat_${key}.${isGif ? 'gif' : 'jpg'}" onclick="event.stopPropagation();">
            <span class="material-symbols-rounded" style="font-size:17px;">download</span> Descargar ${isGif ? 'GIF' : 'Foto'}
          </a>
          <button class="icon-btn" onclick="document.getElementById('chatImageViewer').remove()">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
        <img src="${dataUrl}" alt="${isGif ? 'GIF animado' : 'Imagen del chat'}" onclick="event.stopPropagation();" />
        <div class="chat-image-viewer-note">Los archivos multimedia del chat se eliminan automáticamente a los 30 días</div>
      `;
      ov.addEventListener('click', () => ov.remove());
      document.body.appendChild(ov);
    },

    /* Read raw GIF file preserving all animation frames (canvas compression destroys GIF frames!) */
    readGifFile(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('No se pudo leer el archivo GIF'));
        reader.onload = (ev) => resolve(ev.target.result);
        reader.readAsDataURL(file);
      });
    },

    getImageDimensions(dataUrl) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth || img.width || 320, height: img.naturalHeight || img.height || 240 });
        img.onerror = () => resolve({ width: 320, height: 240 });
        img.src = dataUrl;
      });
    },

    /* Resize + compress an image file in the browser (keeps Firebase storage small). */
    compressImageFile(file, maxDim = 1280, quality = 0.72) {
      return new Promise((resolve, reject) => {
        if (!file || !/^image\//i.test(file.type)) {
          reject(new Error('El archivo no es una imagen'));
          return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('No se pudo leer la imagen'));
        reader.onload = (ev) => {
          const img = new Image();
          img.onerror = () => reject(new Error('Formato de imagen no soportado'));
          img.onload = () => {
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            const scale = Math.min(1, maxDim / Math.max(w, h));
            w = Math.max(1, Math.round(w * scale));
            h = Math.max(1, Math.round(h * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            resolve({ dataUrl: canvas.toDataURL('image/jpeg', quality), width: w, height: h });
          };
          img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
      });
    },

    async sendChatImageFile(file, inputId, streamId) {
      if (!file) return;
      if (!window.cashewSync.mediaRef) {
        this.toast('Sin conexión con la nube: no se puede enviar el archivo ahora', 'error');
        return;
      }
      try {
        const isGif = Boolean((file.type && file.type === 'image/gif') || (file.name && file.name.toLowerCase().endsWith('.gif')));
        this.toast(isGif ? 'Enviando GIF animado...' : 'Enviando imagen...', 'hourglass_top');

        let res;
        if (isGif) {
          if (file.size > 5 * 1024 * 1024) {
            this.toast('El archivo GIF supera los 5MB. Envía uno más ligero.', 'warning');
            return;
          }
          const dataUrl = await this.readGifFile(file);
          const dims = await this.getImageDimensions(dataUrl);
          res = { dataUrl, width: dims.width, height: dims.height, isGif: true };
        } else {
          res = await this.compressImageFile(file, 1280, 0.72);
          if (res.dataUrl.length > 900 * 1024) res = await this.compressImageFile(file, 960, 0.6);
        }

        const inp = inputId ? document.getElementById(inputId) : null;
        const caption = inp ? String(inp.value || '').trim() : '';
        if (inp) inp.value = '';

        const key = window.cashewSync.newChatMediaKey();
        this._chatMediaCache = this._chatMediaCache || new Map();
        this._chatMediaCache.set(key, res.dataUrl); // sender sees it instantly

        const uploadPromise = window.cashewSync.uploadChatMedia(key, res.dataUrl);
        const me = this.getCurrentProfile();
        window.cashewSync.upsertEntity('chatMessages', {
          senderProfileId: me.id,
          senderName: me.displayName || me.username,
          text: caption,
          mediaKey: key,
          mediaType: isGif ? 'gif' : 'image',
          imageW: res.width,
          imageH: res.height,
          date: todayLocalISO(),
          time: nowHHMM()
        }, `💬 ${me.displayName || me.username}: ${isGif ? '🎞️ GIF' : '📷 Foto'}${caption ? ' - ' + caption.slice(0, 28) : ''}`);
        this.markChatAsRead();
        if (this._quickChatOpen) this.refreshQuickChatStreamIfOpen();
        if (streamId) this.scrollChatToBottom(streamId);

        await uploadPromise;
        this.toast(isGif ? 'GIF animado enviado en movimiento (30 días)' : 'Imagen enviada (se borra sola en 30 días)', isGif ? 'gif' : 'photo_camera');
      } catch (err) {
        console.error(err);
        this.toast('No se pudo enviar el archivo: ' + err.message, 'error');
      }
    },

    onChatImagePicked(event, inputId, streamId) {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (file) this.sendChatImageFile(file, inputId, streamId);
    },

    onChatInputPaste(event, inputId, streamId) {
      const items = (event.clipboardData && event.clipboardData.items) || [];
      for (const it of items) {
        if (it.kind === 'file' && /^image\//i.test(it.type)) {
          event.preventDefault();
          this.sendChatImageFile(it.getAsFile(), inputId, streamId);
          return;
        }
      }
    },

    /* Message Edit (1st hour) and Delete (1st 24 hours) handlers */
    openEditChatMessageModal(msgId) {
      const m = (this.st.chatMessages || []).find(x => x && x.id === msgId && !x.deleted);
      if (!m) {
        this.toast('Mensaje no encontrado', 'error');
        return;
      }
      if (m.senderProfileId !== this.profileId) {
        this.toast('Solo puedes editar tus propios mensajes', 'error');
        return;
      }
      const msgTime = Number(m.createdAt) || (m.date ? new Date(`${m.date}T${m.time || '12:00'}:00`).getTime() : 0);
      const ageMs = Date.now() - msgTime;
      const ONE_HOUR_MS = 60 * 60 * 1000;
      if (ageMs > ONE_HOUR_MS) {
        this.toast('El mensaje ya no se puede editar (superó la primera hora)', 'warning');
        return;
      }
      const remainingMin = Math.max(1, Math.round((ONE_HOUR_MS - ageMs) / 60000));

      this.openModalHTML(`
        <div class="modal-head">
          <div>
            <div style="font-size:12px; color:var(--text-muted); font-weight:700;">Edición de Mensaje</div>
            <h2 class="modal-title">Editar Mensaje</h2>
          </div>
          <button class="icon-btn" onclick="CashewApp.closeModal()">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>

        <div style="background:var(--bg-elevated); border-radius:12px; padding:10px 12px; margin-bottom:12px; font-size:12px; color:var(--text-muted); display:flex; align-items:center; gap:8px;">
          <span class="material-symbols-rounded" style="color:var(--primary); font-size:18px;">schedule</span>
          <span>Disponible en la primera hora de envío (te quedan ~${remainingMin} min).</span>
        </div>

        <div class="form-group">
          <label class="form-label">Texto del Mensaje</label>
          <textarea id="editChatMessageInput" class="cashew-input" rows="4" style="resize:vertical; min-height:80px; width:100%; box-sizing:border-box;">${this.escapeHtml(m.text || '')}</textarea>
        </div>

        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px;">
          <button class="btn-cashew btn-surface" onclick="CashewApp.closeModal()">Cancelar</button>
          <button class="btn-cashew btn-primary" onclick="CashewApp.saveEditedChatMessage('${this.escapeHtml(m.id)}')">
            <span class="material-symbols-rounded">save</span> Guardar Cambios
          </button>
        </div>
      `);

      setTimeout(() => {
        const inp = document.getElementById('editChatMessageInput');
        if (inp) {
          inp.focus();
          inp.setSelectionRange(inp.value.length, inp.value.length);
        }
      }, 50);
    },

    saveEditedChatMessage(msgId) {
      const m = (this.st.chatMessages || []).find(x => x && x.id === msgId && !x.deleted);
      if (!m) {
        this.toast('Mensaje no encontrado', 'error');
        this.closeModal();
        return;
      }
      if (m.senderProfileId !== this.profileId) {
        this.toast('Solo puedes editar tus propios mensajes', 'error');
        this.closeModal();
        return;
      }
      const msgTime = Number(m.createdAt) || (m.date ? new Date(`${m.date}T${m.time || '12:00'}:00`).getTime() : 0);
      const ageMs = Date.now() - msgTime;
      if (ageMs > 60 * 60 * 1000) {
        this.toast('El mensaje superó la primera hora y ya no se puede editar', 'warning');
        this.closeModal();
        return;
      }

      const inp = document.getElementById('editChatMessageInput');
      const newText = inp ? inp.value.trim() : '';
      if (!newText && !m.mediaKey) {
        this.toast('El mensaje no puede estar vacío', 'warning');
        return;
      }

      const updated = {
        ...m,
        text: newText,
        isEdited: true,
        editedAt: window.cashewSync.nowTs()
      };

      window.cashewSync.upsertEntity('chatMessages', updated, '✏️ Mensaje editado');
      this.closeModal();
      this.renderAll();
      if (this._quickChatOpen) this.refreshQuickChatStreamIfOpen();
      this.toast('Mensaje editado correctamente', 'check_circle');
    },

    confirmDeleteChatMessage(msgId) {
      const m = (this.st.chatMessages || []).find(x => x && x.id === msgId && !x.deleted);
      if (!m) {
        this.toast('Mensaje no encontrado', 'error');
        return;
      }
      if (m.senderProfileId !== this.profileId) {
        this.toast('Solo puedes eliminar tus propios mensajes', 'error');
        return;
      }
      const msgTime = Number(m.createdAt) || (m.date ? new Date(`${m.date}T${m.time || '12:00'}:00`).getTime() : 0);
      const ageMs = Date.now() - msgTime;
      const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
      if (ageMs > TWENTY_FOUR_HOURS_MS) {
        this.toast('El mensaje superó las 24 horas y ya no puede eliminarse', 'warning');
        return;
      }
      const remainingHours = Math.max(1, Math.round((TWENTY_FOUR_HOURS_MS - ageMs) / 3600000));

      this.openModalHTML(`
        <div class="modal-head">
          <div>
            <div style="font-size:12px; color:var(--cashew-expense); font-weight:700;">Eliminar Mensaje</div>
            <h2 class="modal-title">¿Eliminar este mensaje?</h2>
          </div>
          <button class="icon-btn" onclick="CashewApp.closeModal()">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>

        <div style="background:var(--bg-elevated); border-radius:12px; padding:12px 14px; margin-bottom:14px; font-size:13px; color:var(--text-muted);">
          <p style="margin:0 0 6px 0;">Esta acción eliminará el mensaje para ambos perfiles de forma permanente.</p>
          <div style="font-size:11.5px; color:var(--text-muted); display:flex; align-items:center; gap:6px;">
            <span class="material-symbols-rounded" style="font-size:15px; color:var(--primary);">timer</span>
            <span>Disponible durante las primeras 24 horas (te quedan ~${remainingHours}h).</span>
          </div>
        </div>

        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button class="btn-cashew btn-surface" onclick="CashewApp.closeModal()">Cancelar</button>
          <button class="btn-cashew" style="background:var(--cashew-expense); color:#fff; padding:10px 18px; border-radius:12px;"
                  onclick="CashewApp.deleteChatMessage('${this.escapeHtml(m.id)}')">
            <span class="material-symbols-rounded">delete</span> Eliminar
          </button>
        </div>
      `);
    },

    deleteChatMessage(msgId) {
      const m = (this.st.chatMessages || []).find(x => x && x.id === msgId && !x.deleted);
      if (!m) {
        this.closeModal();
        return;
      }
      if (m.senderProfileId !== this.profileId) {
        this.toast('Solo puedes eliminar tus propios mensajes', 'error');
        this.closeModal();
        return;
      }
      const msgTime = Number(m.createdAt) || (m.date ? new Date(`${m.date}T${m.time || '12:00'}:00`).getTime() : 0);
      const ageMs = Date.now() - msgTime;
      if (ageMs > 24 * 60 * 60 * 1000) {
        this.toast('El mensaje superó las 24 horas y ya no puede eliminarse', 'warning');
        this.closeModal();
        return;
      }

      if (m.mediaKey) {
        window.cashewSync.removeChatMedia(m.mediaKey);
      }

      window.cashewSync.deleteEntity('chatMessages', msgId, 'Mensaje eliminado');
      this.closeModal();
      this.renderAll();
      if (this._quickChatOpen) this.refreshQuickChatStreamIfOpen();
      this.toast('Mensaje eliminado para ambos perfiles', 'delete');
    },

    renderChatComposerHTML(inputId, streamId, placeholder, extraSubmit = '', formAttrs = 'class="chat-composer-bar"') {
      return `
        <form ${formAttrs} onsubmit="event.preventDefault(); CashewApp.sendChatMessageFromInput('${inputId}', '${streamId}'); ${extraSubmit}">
          <input id="${inputId}_file" type="file" accept="image/*,image/gif" style="display:none;"
                 onchange="CashewApp.onChatImagePicked(event, '${inputId}', '${streamId}')" />
          <button type="button" class="btn-cashew btn-surface chat-attach-btn" title="Enviar foto o GIF animado (se borra en 30 días)"
                  onclick="document.getElementById('${inputId}_file').click()">
            <span class="material-symbols-rounded">add_photo_alternate</span>
          </button>
          <input id="${inputId}" class="cashew-input" type="text" autocomplete="off"
                 onpaste="CashewApp.onChatInputPaste(event, '${inputId}', '${streamId}')"
                 placeholder="${placeholder}" />
          <button type="submit" class="btn-cashew btn-primary" style="padding:11px 16px;">
            <span class="material-symbols-rounded">send</span>
          </button>
        </form>
      `;
    },

    scrollChatToBottom(containerId) {
      setTimeout(() => {
        const el = document.getElementById(containerId);
        if (el) el.scrollTop = el.scrollHeight;
      }, 30);
    },

    sendChatMessageText(rawText) {
      const text = String(rawText || '').trim();
      if (!text) return false;
      const me = this.getCurrentProfile();
      window.cashewSync.upsertEntity('chatMessages', {
        senderProfileId: me.id,
        senderName: me.displayName || me.username,
        text,
        date: todayLocalISO(),
        time: nowHHMM()
      }, `💬 ${me.displayName || me.username}: ${text.slice(0, 38)}`);
      this.markChatAsRead();
      return true;
    },

    sendChatMessageFromInput(inputId, streamId) {
      const inp = document.getElementById(inputId);
      if (!inp) return;
      if (this.sendChatMessageText(inp.value)) {
        inp.value = '';
        this.scrollChatToBottom(streamId);
        inp.focus();
      }
    },

    sendQuickSummaryToChat(kind) {
      if (kind === 'networth') {
        const nw = this.fmtMoney(this.getTotalNetWorth('all'));
        const cf = this.getMonthCashflow('all', currentYM());
        this.sendChatMessageText(`📊 Resumen Finanzas: Valor Neto ${nw} | Mes: +${this.fmtMoney(cf.income)} ingresos / -${this.fmtMoney(cf.expense)} gastos.`);
      } else if (kind === 'stock') {
        const st = this.getStockSummary();
        this.sendChatMessageText(`📦 Resumen Stock: ${st.readyUnits} uds listas para vender (${this.fmtMoney(st.retailValue, '$')} en vitrina, ganancia proyectada +${this.fmtMoney(st.expectedProfit, '$')}).`);
      }
      this.scrollChatToBottom('pageChatStream');
      this.scrollChatToBottom('quickChatStream');
    },

    buildProfileAndChatPage() {
      const me = this.getCurrentProfile();
      const partner = this.getPartnerProfile();
      const partnerOnline = partner ? window.cashewSync.isProfileOnline(partner.id) : false;

      return `
        <header class="cashew-greeting-header">
          <div>
            <div class="greeting-small">Comunicación persistente en la nube y gestión de credenciales</div>
            <h1 class="greeting-username">Perfil y Chat de Socios</h1>
          </div>
          <div class="header-actions-bar">
            <button class="btn-cashew btn-surface btn-sm" onclick="CashewApp.sendQuickSummaryToChat('networth')">
              <span class="material-symbols-rounded" style="font-size:17px; color:var(--cashew-income);">monitoring</span>
              Enviar Resumen Finanzas
            </button>
            <button class="btn-cashew btn-surface btn-sm" onclick="CashewApp.sendQuickSummaryToChat('stock')">
              <span class="material-symbols-rounded" style="font-size:17px; color:var(--primary);">inventory_2</span>
              Enviar Resumen Stock
            </button>
          </div>
        </header>

        <div class="cashew-home-grid">
          <!-- LEFT: Persistent Real-Time Partner Chat -->
          <div class="cashew-col">
            <div class="chat-panel-card">
              <div class="chat-panel-head">
                <div style="display:flex; align-items:center; gap:11px;">
                  ${this.getProfileAvatarHTML(partner, 42)}
                  <div>
                    <div style="font-weight:800; font-size:15.5px; display:flex; align-items:center; gap:8px;">
                      Chat con ${this.escapeHtml(partner.displayName || partner.username)}
                      <span class="partner-presence-pill ${partnerOnline ? 'online' : ''}">
                        ${partnerOnline ? '● En línea' : '○ Offline'}
                      </span>
                    </div>
                    <div style="font-size:11.5px; color:var(--text-muted);">
                      Mensajes temporales automáticos (30 días) • Sincronizado en tiempo real
                    </div>
                  </div>
                </div>
              </div>

              <div id="pageChatStream" class="chat-messages-stream">
                ${this.renderChatMessagesHTML()}
              </div>

              ${this.renderChatComposerHTML('pageChatInput', 'pageChatStream', `Escribe un mensaje o envía una foto a ${this.escapeHtml(partner.displayName || partner.username)}...`)}
            </div>
          </div>

          <!-- RIGHT: Editable Profile Credentials (Username, Display Name, Avatar & Password) -->
          <div class="cashew-col">
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div>
                  <div class="cashew-card-title">
                    <span class="material-symbols-rounded" style="color:var(--primary);">manage_accounts</span>
                    Mi Perfil, Foto y Credenciales
                  </div>
                  <div class="cashew-card-subtitle">
                    Sesión activa en Slot #${me.slot || (me.id === 'profile_1' ? 1 : 2)} • Los cambios sincronizan en todos los dispositivos
                  </div>
                </div>
              </div>

              <div style="display:flex; align-items:center; gap:14px; background:var(--bg-elevated); padding:14px 16px; border-radius:18px; margin-bottom:16px;">
                <div id="profHeaderAvatar">
                  ${this.getProfileAvatarHTML(typeof this._ownAvatarDraft === 'string' ? { ...me, avatarUrl: this._ownAvatarDraft } : me, 54)}
                </div>
                <div>
                  <div style="font-weight:800; font-size:17px;">${this.escapeHtml(me.displayName || me.username)}</div>
                  <div style="font-size:12.5px; color:var(--text-muted);">Usuario de acceso actual: <strong>@${this.escapeHtml(me.username)}</strong></div>
                </div>
              </div>

              <div class="form-grid">
                <div class="form-group">
                  <label class="form-label">Usuario para Iniciar Sesión</label>
                  <input id="profEditUsername" class="cashew-input" value="${this.escapeHtml(me.username)}" placeholder="Ej: doom1" />
                </div>

                <div class="form-group">
                  <label class="form-label">Nombre Visible / Alias</label>
                  <input id="profEditDisplay" class="cashew-input" value="${this.escapeHtml(me.displayName || me.username)}" placeholder="Ej: Socio Principal" />
                </div>

                <div class="form-group full">
                  <label class="form-label">Foto de Perfil (Enlace / URL de imagen o subir desde tu dispositivo)</label>
                  <div style="display:flex; gap:8px; align-items:center;">
                    <input id="profEditAvatar" class="cashew-input" style="flex:1; min-width:0;"
                           value="${this.escapeHtml(typeof this._ownAvatarDraft === 'string' ? this._ownAvatarDraft : (me.avatarUrl || ''))}"
                           placeholder="https://... (pega el enlace de tu foto aquí)"
                           oninput="CashewApp.onProfileAvatarPreview(this.value)" />
                    <input id="profEditAvatarFile" type="file" accept="image/*" style="display:none;"
                           onchange="CashewApp.onAvatarFilePicked(event, 'profEditAvatar', 'profHeaderAvatar', '${me.id}')" />
                    <button type="button" class="btn-cashew btn-surface" title="Subir foto desde el dispositivo"
                            onclick="document.getElementById('profEditAvatarFile').click()">
                      <span class="material-symbols-rounded">upload</span>
                    </button>
                  </div>
                  <div style="font-size:11.5px; color:var(--text-muted); margin-top:3px;">
                    Pega un enlace directo de imagen (PNG, JPG, Imgur, etc.) o súbela desde tu galería. Se muestra en el inicio de sesión, la barra lateral y el chat.
                  </div>
                </div>

                <div class="form-group">
                  <label class="form-label">Rol o Cargo</label>
                  <input id="profEditRole" class="cashew-input" value="${this.escapeHtml(me.role || 'Socio')}" placeholder="Ej: Socio Principal" />
                </div>

                <div class="form-group">
                  <label class="form-label">Clave de Acceso (Puedes cambiarla)</label>
                  <div style="position:relative;">
                    <input id="profEditPassword" type="password" class="cashew-input" value="${this.escapeHtml(me.password)}" style="padding-right:42px;" />
                    <button type="button"
                            onclick="const i=document.getElementById('profEditPassword'); i.type=i.type==='password'?'text':'password';"
                            style="position:absolute; right:10px; top:50%; transform:translateY(-50%); color:var(--text-muted);">
                      <span class="material-symbols-rounded" style="font-size:18px;">visibility</span>
                    </button>
                  </div>
                </div>
              </div>

              <button type="button" class="btn-cashew btn-primary" style="width:100%; padding:13px; margin-top:4px;"
                      onclick="CashewApp.saveProfileCredentials()">
                <span class="material-symbols-rounded">save</span>
                Guardar Cambios de Perfil en la Nube
              </button>
            </div>
            ${this.isMasterAdmin() ? this.renderLoginPhotosCardHTML() : ''}
          </div>
        </div>
      `;
    },

    /* Only rendered for doom1: edit the profile photos shown on the login screen
       (both slots). doom2 never sees this card. */
    renderLoginPhotosCardHTML() {
      const profiles = this.getProfiles();
      return `
        <div class="cashew-card" style="margin-top:16px;">
          <div class="cashew-card-header">
            <div>
              <div class="cashew-card-title">
                <span class="material-symbols-rounded" style="color:var(--primary);">account_box</span>
                Fotos del Inicio de Sesión
              </div>
              <div class="cashew-card-subtitle">
                Cambia la foto que aparece en la pantalla de login para cada perfil • Se sincroniza al instante
              </div>
            </div>
          </div>

          <div style="display:flex; flex-direction:column; gap:12px;">
            ${profiles.map(p => {
              const drafts = this._loginPhotoDrafts || {};
              const curUrl = Object.prototype.hasOwnProperty.call(drafts, p.id) ? drafts[p.id] : (p.avatarUrl || '');
              return `
              <div style="display:flex; align-items:center; gap:12px; background:var(--bg-elevated); padding:12px 14px; border-radius:16px; flex-wrap:wrap;">
                <div id="loginPhotoPreview_${p.id}">${this.getProfileAvatarHTML({ ...p, avatarUrl: curUrl }, 52)}</div>
                <div style="flex:1; min-width:180px;">
                  <div style="font-weight:800; font-size:14px;">${this.escapeHtml(p.displayName || p.username)}
                    <span style="font-weight:600; font-size:12px; color:var(--text-muted);">@${this.escapeHtml(p.username)}</span>
                  </div>
                  <div style="display:flex; gap:6px; margin-top:6px;">
                    <input id="loginPhotoUrl_${p.id}" class="cashew-input" style="flex:1; min-width:0; padding:9px 12px; font-size:13px;"
                           value="${this.escapeHtml(curUrl)}" placeholder="https://... enlace de la foto"
                           oninput="CashewApp.onLoginPhotoPreview('${p.id}', this.value)" />
                    <input id="loginPhotoFile_${p.id}" type="file" accept="image/*" style="display:none;"
                           onchange="CashewApp.onAvatarFilePicked(event, 'loginPhotoUrl_${p.id}', 'loginPhotoPreview_${p.id}', '${p.id}')" />
                    <button type="button" class="btn-cashew btn-surface btn-sm" title="Subir desde el dispositivo"
                            onclick="document.getElementById('loginPhotoFile_${p.id}').click()">
                      <span class="material-symbols-rounded" style="font-size:18px;">upload</span>
                    </button>
                    <button type="button" class="btn-cashew btn-surface btn-sm" title="Quitar foto"
                            onclick="document.getElementById('loginPhotoUrl_${p.id}').value=''; CashewApp.onLoginPhotoPreview('${p.id}', '');">
                      <span class="material-symbols-rounded" style="font-size:18px;">hide_image</span>
                    </button>
                  </div>
                </div>
              </div>
            `;
            }).join('')}
          </div>

          <button type="button" class="btn-cashew btn-primary" style="width:100%; padding:12px; margin-top:14px;"
                  onclick="CashewApp.saveLoginPhotos()">
            <span class="material-symbols-rounded">save</span>
            Guardar Fotos del Inicio de Sesión
          </button>
        </div>

        <div class="cashew-card" style="margin-top:16px;">
          <div class="cashew-card-header">
            <div>
              <div class="cashew-card-title">
                <span class="material-symbols-rounded" style="color:var(--primary);">image</span>
                Logo de Doomlater.Corp (Pestaña Web y Login)
              </div>
              <div class="cashew-card-subtitle">
                Cambia el logo mostrado en la pantalla de inicio y en la pestaña del navegador para ambos socios
              </div>
            </div>
          </div>

          <div style="display:flex; align-items:center; gap:14px; background:var(--bg-elevated); padding:14px 16px; border-radius:18px; margin-bottom:14px;">
            <div id="appLogoPreviewBox" style="width:54px; height:54px; min-width:54px; display:flex; align-items:center; justify-content:center; background:var(--bg-card); border-radius:14px; border:1px solid var(--border-subtle); overflow:hidden; padding:4px;">
              ${this.getAppLogoHTML(46)}
            </div>
            <div style="flex:1; min-width:0;">
              <div style="font-weight:800; font-size:14.5px;">Logo Actual de Doomlater.Corp</div>
              <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">
                Se aplica en tiempo real en la pantalla de login, la barra lateral y el icono (favicon) de la pestaña.
              </div>
            </div>
          </div>

          <div class="form-group" style="margin-bottom:12px;">
            <label class="form-label">Enlace URL del Logo (Pega un enlace directo o sube una imagen)</label>
            <div style="display:flex; gap:8px; align-items:center;">
              <input id="appLogoUrlInput" class="cashew-input" style="flex:1; min-width:0;"
                     value="${this.escapeHtml(typeof this._appLogoDraft === 'string' ? this._appLogoDraft : this.getAppLogoUrl())}"
                     placeholder="https://... enlace directo de tu logo (SVG, PNG, JPG, GIF)"
                     oninput="CashewApp.onAppLogoPreview(this.value)" />
              <input id="appLogoFileInput" type="file" accept="image/*,image/gif" style="display:none;"
                     onchange="CashewApp.onAppLogoFilePicked(event)" />
              <button type="button" class="btn-cashew btn-surface" title="Subir desde el dispositivo"
                      onclick="document.getElementById('appLogoFileInput').click()">
                <span class="material-symbols-rounded">upload</span>
              </button>
            </div>
          </div>

          <div style="display:flex; gap:8px;">
            <button type="button" class="btn-cashew btn-primary" style="flex:1; padding:12px;"
                    onclick="CashewApp.saveAppLogo()">
              <span class="material-symbols-rounded">save</span>
              Guardar Logo de la Web
            </button>
            <button type="button" class="btn-cashew btn-surface" style="padding:12px;" title="Restaurar logo original"
                    onclick="CashewApp.resetAppLogo()">
              <span class="material-symbols-rounded">restart_alt</span>
              Restaurar
            </button>
          </div>
        </div>
      `;
    },

    onLoginPhotoPreview(profileId, url) {
      this._loginPhotoDrafts = this._loginPhotoDrafts || {};
      this._loginPhotoDrafts[profileId] = url;
      const box = document.getElementById(`loginPhotoPreview_${profileId}`);
      const p = this.getProfileById(profileId);
      if (box && p) box.innerHTML = this.getProfileAvatarHTML({ ...p, avatarUrl: url }, 52);
    },

    async onAvatarFilePicked(event, urlInputId, previewBoxId, profileId) {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        const res = await this.compressImageFile(file, 256, 0.82);
        // Keep the unsaved photo in a draft so live re-renders (chat, sync) don't wipe it
        if (urlInputId === 'profEditAvatar') {
          this._ownAvatarDraft = res.dataUrl;
        } else {
          this._loginPhotoDrafts = this._loginPhotoDrafts || {};
          this._loginPhotoDrafts[profileId] = res.dataUrl;
        }
        const inp = document.getElementById(urlInputId);
        if (inp) inp.value = res.dataUrl;
        const p = this.getProfileById(profileId);
        const box = document.getElementById(previewBoxId);
        const size = previewBoxId === 'profHeaderAvatar' ? 54 : 52;
        if (box && p) box.innerHTML = this.getProfileAvatarHTML({ ...p, avatarUrl: res.dataUrl }, size);
        this.toast('Foto lista: pulsa Guardar para sincronizarla', 'photo_camera');
      } catch (err) {
        this.toast('No se pudo cargar la foto: ' + err.message, 'error');
      }
    },

    saveLoginPhotos() {
      if (!this.isMasterAdmin()) return;
      const ops = [];
      for (const p of this.getProfiles()) {
        const inp = document.getElementById(`loginPhotoUrl_${p.id}`);
        if (!inp) continue;
        const url = String(inp.value || '').trim();
        if (url && !/^https?:\/\//i.test(url) && !/^data:image\//i.test(url)) {
          this.toast(`El enlace de ${p.displayName || p.username} no es válido (debe empezar por https://)`, 'error');
          return;
        }
        if ((p.avatarUrl || '') !== url) {
          ops.push({ collection: 'profiles', item: { ...p, avatarUrl: url } });
        }
      }
      if (!ops.length) {
        this._loginPhotoDrafts = {};
        this.toast('No hay cambios en las fotos', 'info');
        return;
      }
      window.cashewSync.batchUpsert(ops, 'Actualizó fotos del inicio de sesión');
      this._loginPhotoDrafts = {};
      this.renderAll();
      this.renderLoginProfiles();
      this.toast('Fotos del inicio de sesión actualizadas en todos los dispositivos', 'verified');
    },

    onProfileAvatarPreview(url) {
      this._ownAvatarDraft = url;
      const container = document.getElementById('profHeaderAvatar');
      if (!container) return;
      const me = this.getCurrentProfile();
      container.innerHTML = this.getProfileAvatarHTML({ ...me, avatarUrl: url }, 54);
    },

    saveProfileCredentials() {
      const me = this.getCurrentProfile();
      const partner = this.getPartnerProfile();

      const newUsername = (document.getElementById('profEditUsername').value || '').trim();
      const newDisplay = (document.getElementById('profEditDisplay').value || '').trim() || newUsername;
      const newRole = (document.getElementById('profEditRole').value || '').trim() || 'Socio';
      const newPassword = (document.getElementById('profEditPassword').value || '').trim();
      const newAvatarUrl = (document.getElementById('profEditAvatar') ? document.getElementById('profEditAvatar').value : '').trim();

      if (newUsername.length < 2) {
        this.toast('El nombre de usuario debe tener al menos 2 caracteres', 'error');
        return;
      }
      if (newPassword.length < 2) {
        this.toast('La clave debe tener al menos 2 caracteres', 'error');
        return;
      }
      if (partner && partner.username.toLowerCase() === newUsername.toLowerCase()) {
        this.toast('Ese nombre de usuario ya lo usa tu compañero. Elige otro distinto.', 'error');
        return;
      }

      const updatedProfile = {
        ...me,
        username: newUsername,
        displayName: newDisplay,
        role: newRole,
        password: newPassword,
        avatarUrl: newAvatarUrl
      };

      this.user = newUsername;
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        profileId: me.id,
        username: newUsername,
        loginAt: Date.now()
      }));

      window.cashewSync.setUser(me.id, newUsername);
      window.cashewSync.upsertEntity('profiles', updatedProfile, `Actualizó perfil @${newUsername}`);
      this._ownAvatarDraft = undefined;

      this.renderAll();
      this.toast(`¡Perfil actualizado! Nuevo acceso: @${newUsername}`, 'verified_user');
    },

        /* ======================================================================
       PAGE 10: BOT MULTICANAL & BANDEJA OMNICANAL (WHATSAPP, INSTAGRAM, MESSENGER)
       ====================================================================== */

    getBotConfig() {
      const cfg = (this.st.botConfig && typeof this.st.botConfig === 'object') ? this.st.botConfig : {};
      return {
        globalBotEnabled: cfg.globalBotEnabled !== false,
        typingDelaySec: cfg.typingDelaySec !== undefined ? Number(cfg.typingDelaySec) : 3.5,
        showTypingIndicator: cfg.showTypingIndicator !== false,
        showOnlinePresence: cfg.showOnlinePresence !== false,
        geminiApiKey: cfg.geminiApiKey || '',
        whatsappConnected: Boolean(cfg.whatsappConnected),
        whatsappQr: cfg.whatsappQr || null,
        instagramConnected: Boolean(cfg.instagramConnected),
        messengerDoom1Connected: Boolean(cfg.messengerDoom1Connected),
        messengerDoom2Connected: Boolean(cfg.messengerDoom2Connected),
        messengerRedirectMessage: cfg.messengerRedirectMessage || '¡Hola! Gracias por contactarnos en Doomlater.Corp 📱. Para brindarte atención inmediata con stock en tiempo real y coordinar envíos o entregas, por favor escríbenos directamente a nuestro WhatsApp oficial: +58 412 0000000 o toca este enlace: https://wa.me/584120000000 ¡Te atenderemos de inmediato!',
        paymentMethods: Array.isArray(cfg.paymentMethods) ? cfg.paymentMethods : [
          { id: 'pm_1', name: 'Pago Móvil / Banco', details: 'Banco Banesco (0134) • C.I: 12.345.678 • Tlf: 0412-1234567' },
          { id: 'pm_2', name: 'Binance Pay / USDT', details: 'Pay ID: 123456789 • Red TRC20 / Binance Pay' },
          { id: 'pm_3', name: 'Efectivo Divisas ($)', details: 'Entrega personal en tienda física o delivery en divisas exactas' }
        ],
        knowledgeBaseFaq: Array.isArray(cfg.knowledgeBaseFaq) ? cfg.knowledgeBaseFaq : [
          { id: 'faq_1', question: '¿Hacen envíos o delivery?', answer: 'Sí, contamos con servicio de delivery en la ciudad y envíos nacionales asegurados a través de MRW, Zoom y Tealca.' },
          { id: 'faq_2', question: '¿Los productos y servicios tienen garantía?', answer: 'Sí, todos los productos nuevos cuentan con garantía de 30 días y los servicios técnicos son probados detalladamente antes de la entrega.' },
          { id: 'faq_3', question: '¿Dónde están ubicados y cuál es el horario?', answer: 'Estamos ubicados en nuestro local comercial. Atendemos de Lunes a Sábado de 9:00 AM a 6:00 PM.' }
        ],
        serviceInsumosMap: Array.isArray(cfg.serviceInsumosMap) ? cfg.serviceInsumosMap : [
          { id: 'srv_1', serviceName: 'Servicio Técnico / Cambio de Pantalla', defaultInsumoName: 'Pantalla Repuesto', defaultLaborPrice: 40 }
        ]
      };
    },

    getVisibleBotConversations() {
      const all = this.activeList('botConversations') || [];
      const user = this.user || 'doom1';
      const myProfileId = this.profileId || 'profile_1';

      return all.filter(c => {
        if (!c || c.deleted) return false;
        // WhatsApp and Instagram: shared between doom1 and doom2
        if (c.platform === 'whatsapp' || c.platform === 'instagram') return true;
        // Messenger: strictly PRIVATE per profile!
        if (c.platform === 'messenger') {
          // Profile 1 (doom1 / Anthonwen2411 / itsdoomlater@gmail.com)
          if (myProfileId === 'profile_1' || user === 'doom1' || user === 'Anthonwen2411') {
            return c.platformAccount === 'doom1' || c.platformAccount === 'Anthonwen2411' || c.platformAccount === 'itsdoomlater@gmail.com' || c.profileId === 'profile_1' || !c.platformAccount;
          }
          // Profile 2 (doom2)
          if (myProfileId === 'profile_2' || user === 'doom2') {
            return c.platformAccount === 'doom2' || c.profileId === 'profile_2';
          }
          if (c.platformAccount) {
            return c.platformAccount === user;
          }
          return c.profileId === myProfileId;
        }
        return true;
      });
    },

    updateNavBotBadge() {
      const badge = document.getElementById('navBotBadge');
      if (!badge) return;
      const convs = this.getVisibleBotConversations();
      const attentionCount = convs.filter(c => c.needsAttention).length;
      const unreadCount = convs.reduce((acc, c) => acc + (Number(c.unreadCount) || 0), 0);
      const total = attentionCount + unreadCount;
      if (total > 0) {
        badge.style.display = 'inline-flex';
        badge.textContent = attentionCount > 0 ? `⚠️ ${attentionCount}` : String(unreadCount);
        badge.className = attentionCount > 0 ? 'nav-item-badge warn' : 'nav-item-badge';
      } else {
        badge.style.display = 'none';
      }
    },

    ensureSeedBotConversations() {
      if (this._botInited) return;
      this._botInited = true;
      const current = this.activeList('botConversations');
      if (current && current.length > 0) return;

      const now = Date.now();
      const seedConvs = [
        {
          id: 'conv_wa_carlos',
          platform: 'whatsapp',
          platformAccount: 'shared',
          customerName: 'Carlos Mendoza',
          customerPhone: '+58 412 8765432',
          customerAvatar: '',
          lastMessage: 'Ya pagué $40 por Binance Pay, aquí está el capture.',
          lastMessageAt: now - 300000,
          unreadCount: 1,
          needsAttention: true,
          attentionReason: 'Cliente reportó pago de $40.00 por Servicio Técnico Switch',
          pendingPayment: true,
          pendingPaymentAmount: 40.00,
          pendingPaymentItem: 'Servicio Técnico / Cambio de Pantalla',
          isService: true,
          isOnline: true,
          isTyping: false,
          botActive: true,
          updatedAt: now - 300000,
          updatedBy: 'doom1'
        },
        {
          id: 'conv_ig_maria',
          platform: 'instagram',
          platformAccount: 'shared',
          customerName: 'María Fernández (@maria_tech)',
          customerAvatar: '',
          lastMessage: '¡Gracias por la información! Mañana paso por la tienda.',
          lastMessageAt: now - 7200000,
          unreadCount: 0,
          needsAttention: false,
          attentionReason: '',
          pendingPayment: false,
          isOnline: true,
          isTyping: false,
          botActive: true,
          updatedAt: now - 7200000,
          updatedBy: 'doom1'
        },
        {
          id: 'conv_fb_doom1_roberto',
          platform: 'messenger',
          platformAccount: 'doom1',
          profileId: 'profile_1',
          customerName: 'Roberto Díaz (Facebook)',
          customerAvatar: '',
          lastMessage: '¡Hola! Gracias por contactarnos en Doomlater.Corp 📱. Para brindarte atención...',
          lastMessageAt: now - 14400000,
          unreadCount: 0,
          needsAttention: false,
          attentionReason: '',
          pendingPayment: false,
          messengerRedirectSent: true,
          isOnline: false,
          isTyping: false,
          botActive: true,
          updatedAt: now - 14400000,
          updatedBy: 'doom1'
        },
        {
          id: 'conv_fb_doom2_andres',
          platform: 'messenger',
          platformAccount: 'doom2',
          profileId: 'profile_2',
          customerName: 'Andrés Suárez (Facebook)',
          customerAvatar: '',
          lastMessage: '¡Hola! Gracias por contactarnos en Doomlater.Corp 📱. Para brindarte atención...',
          lastMessageAt: now - 18000000,
          unreadCount: 0,
          needsAttention: false,
          attentionReason: '',
          pendingPayment: false,
          messengerRedirectSent: true,
          isOnline: false,
          isTyping: false,
          botActive: true,
          updatedAt: now - 18000000,
          updatedBy: 'doom2'
        }
      ];

      const seedMsgs = [
        {
          id: 'bmsg_wa_1',
          convId: 'conv_wa_carlos',
          direction: 'in',
          text: '¡Hola! ¿Tienen disponible servicio técnico para cambio de pantalla de Nintendo Switch?',
          createdAt: now - 1800000,
          sentBy: 'Carlos Mendoza'
        },
        {
          id: 'bmsg_wa_2',
          convId: 'conv_wa_carlos',
          direction: 'out',
          text: '¡Hola Carlos! 👋 Sí, disponemos de servicio técnico especializado para Nintendo Switch en nuestro taller. La instalación con repuesto grado A cuesta $40.00 con garantía de 30 días.',
          createdAt: now - 1700000,
          sentBy: 'bot'
        },
        {
          id: 'bmsg_wa_3',
          convId: 'conv_wa_carlos',
          direction: 'in',
          text: 'Excelente, ¿cuáles son los métodos de pago para transferir ya mismo?',
          createdAt: now - 1200000,
          sentBy: 'Carlos Mendoza'
        },
        {
          id: 'bmsg_wa_4',
          convId: 'conv_wa_carlos',
          direction: 'out',
          text: 'Aceptamos:\n• Binance Pay (USDT): Pay ID 123456789\n• Pago Móvil: Banco Banesco (0134) • C.I 12.345.678 • Tlf: 0412-1234567\n• Efectivo en divisas en el local.\n\nAl transferir, envíanos el capture por aquí para verificarlo.',
          createdAt: now - 1100000,
          sentBy: 'bot'
        },
        {
          id: 'bmsg_wa_5',
          convId: 'conv_wa_carlos',
          direction: 'in',
          text: 'Ya pagué $40 por Binance Pay, aquí está el capture.',
          mediaUrl: 'https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?w=500&auto=format&fit=crop&q=60',
          mediaType: 'image',
          createdAt: now - 300000,
          sentBy: 'Carlos Mendoza'
        },
        {
          id: 'bmsg_ig_1',
          convId: 'conv_ig_maria',
          direction: 'in',
          text: 'Hola! ¿Tienen controles de PS5 en stock y cuánto valen?',
          createdAt: now - 7500000,
          sentBy: 'María Fernández'
        },
        {
          id: 'bmsg_ig_2',
          convId: 'conv_ig_maria',
          direction: 'out',
          text: '¡Hola María! 🎮 Sí, tenemos mandos DualSense PS5 originales disponibles en stock a $65.00 con garantía oficial.',
          createdAt: now - 7400000,
          sentBy: 'bot'
        },
        {
          id: 'bmsg_ig_3',
          convId: 'conv_ig_maria',
          direction: 'in',
          text: '¡Gracias por la información! Mañana paso por la tienda.',
          createdAt: now - 7200000,
          sentBy: 'María Fernández'
        },
        {
          id: 'bmsg_fb1_1',
          convId: 'conv_fb_doom1_roberto',
          direction: 'in',
          text: 'Buenas tardes, ¿qué precio tienen las consolas Nintendo Switch?',
          createdAt: now - 14500000,
          sentBy: 'Roberto Díaz'
        },
        {
          id: 'bmsg_fb1_2',
          convId: 'conv_fb_doom1_roberto',
          direction: 'out',
          text: '¡Hola! Gracias por contactarnos en Doomlater.Corp 📱. Para brindarte atención inmediata con stock en tiempo real y coordinar envíos o entregas, por favor escríbenos directamente a nuestro WhatsApp oficial: +58 412 0000000 o toca este enlace: https://wa.me/584120000000 ¡Te atenderemos de inmediato!',
          createdAt: now - 14400000,
          sentBy: 'bot'
        },
        {
          id: 'bmsg_fb2_1',
          convId: 'conv_fb_doom2_andres',
          direction: 'in',
          text: 'Hola amigo disponible para reparar un control de xbox?',
          createdAt: now - 18100000,
          sentBy: 'Andrés Suárez'
        },
        {
          id: 'bmsg_fb2_2',
          convId: 'conv_fb_doom2_andres',
          direction: 'out',
          text: '¡Hola! Gracias por contactarnos en Doomlater.Corp 📱. Para brindarte atención inmediata con stock en tiempo real y coordinar envíos o entregas, por favor escríbenos directamente a nuestro WhatsApp oficial: +58 412 0000000 o toca este enlace: https://wa.me/584120000000 ¡Te atenderemos de inmediato!',
          createdAt: now - 18000000,
          sentBy: 'bot'
        }
      ];

      const batch = [
        ...seedConvs.map(c => ({ collection: 'botConversations', item: c })),
        ...seedMsgs.map(m => ({ collection: 'botMessages', item: m }))
      ];
      window.cashewSync.batchUpsert(batch, 'Semillas iniciales de conversaciones multicanal');
    },

    setBotSubTab(tab) {
      this.botSubTab = tab;
      this.renderMainView();
    },

    setBotChannelFilter(filter) {
      this.botChannelFilter = filter;
      this.renderMainView();
    },

    setBotSearchQuery(query) {
      this.botSearchQuery = query;
      this.renderMainView();
    },

    selectBotConversation(convId) {
      this.botActiveConvId = convId;
      const conv = (this.activeList('botConversations') || []).find(c => c.id === convId);
      if (conv && conv.unreadCount > 0) {
        window.cashewSync.upsertEntity('botConversations', {
          ...conv,
          unreadCount: 0
        }, 'Mensajes leídos');
      }
      this.renderMainView();
      // On mobile, auto scroll to chat pane
      setTimeout(() => {
        const stream = document.getElementById('botMessagesStream');
        if (stream) stream.scrollTop = stream.scrollHeight;
      }, 50);
    },

    toggleBotAutoReply(convId) {
      const conv = (this.activeList('botConversations') || []).find(c => c.id === convId);
      if (!conv) return;
      const nextState = conv.botActive === false;
      window.cashewSync.upsertEntity('botConversations', {
        ...conv,
        botActive: nextState
      }, nextState ? 'Activó respuesta automática IA' : 'Puso chat en modo manual');
      this.toast(nextState ? 'Asistente IA Activado para este chat' : 'Modo Manual activado (IA pausada)', 'smart_toy');
      this.renderMainView();
    },

    markBotAttentionResolved(convId) {
      const conv = (this.activeList('botConversations') || []).find(c => c.id === convId);
      if (!conv) return;
      window.cashewSync.upsertEntity('botConversations', {
        ...conv,
        needsAttention: false,
        pendingPayment: false,
        attentionReason: ''
      }, 'Alerta resuelta por operador');
      this.toast('Alerta resuelta. Conversación al día.', 'check_circle');
      this.renderMainView();
    },

    toggleGlobalBot() {
      const cfg = this.getBotConfig();
      const next = cfg.globalBotEnabled === false ? true : false;
      window.cashewSync.saveBotConfig({ globalBotEnabled: next }, next ? 'Activó IA Global' : 'Pausó IA Global (Modo Solo Humano)');
      this.toast(next ? '🤖 IA Global ACTIVADA (Responde automáticamente)' : '⏸️ IA Global PAUSADA (Todos los chats en modo manual)', next ? 'smart_toy' : 'pause_circle');
      this.renderMainView();
    },

    /* ======================================================================
       MAIN BUILDER: BOT PAGE
       ====================================================================== */
    buildBotPage() {
      this.ensureSeedBotConversations();

      const convs = this.getVisibleBotConversations();
      const attentionCount = convs.filter(c => c.needsAttention).length;
      const cfg = this.getBotConfig();
      const globalActive = cfg.globalBotEnabled !== false;

      return `
        <header class="cashew-greeting-header">
          <div>
            <div class="greeting-small">Atención 24/7 • WhatsApp, Instagram y Messenger en tiempo real</div>
            <h1 class="greeting-username">Bot & Inbox Multicanal</h1>
          </div>
          <div class="header-actions-bar">
            <!-- Global AI Toggle -->
            <button class="btn-cashew ${globalActive ? 'btn-tonal' : 'btn-danger'}"
                    style="font-size:12px; font-weight:800; padding:6px 14px;"
                    title="Activar o pausar la respuesta automática de la IA en todas las plataformas a la vez"
                    onclick="CashewApp.toggleGlobalBot()">
              <span class="material-symbols-rounded" style="font-size:18px;">${globalActive ? 'smart_toy' : 'pause_circle'}</span>
              ${globalActive ? 'IA Global: ACTIVA' : 'IA Global: PAUSADA (Solo Humano)'}
            </button>
            <button class="btn-cashew btn-surface" onclick="CashewApp.onManualSyncClick()">
              <span class="material-symbols-rounded" style="font-size:19px;">sync</span> Sincronizar
            </button>
            <button class="btn-cashew btn-primary" onclick="CashewApp.setBotSubTab('connect')">
              <span class="material-symbols-rounded" style="font-size:20px;">qr_code_scanner</span> Conectar Redes
            </button>
          </div>
        </header>

        <!-- Sub-tabs navigation bar -->
        <div class="bot-subtabs-nav">
          <button class="bot-subtab-btn ${this.botSubTab === 'inbox' ? 'active' : ''}" onclick="CashewApp.setBotSubTab('inbox')">
            <span class="material-symbols-rounded" style="font-size:18px;">inbox</span>
            Inbox Multicanal
            ${attentionCount > 0 ? `<span class="bot-attention-pulse-badge">⚠️ ${attentionCount}</span>` : ''}
          </button>
          <button class="bot-subtab-btn ${this.botSubTab === 'faq' ? 'active' : ''}" onclick="CashewApp.setBotSubTab('faq')">
            <span class="material-symbols-rounded" style="font-size:18px;">payments</span>
            Métodos de Pago & FAQ
          </button>
          <button class="bot-subtab-btn ${this.botSubTab === 'services' ? 'active' : ''}" onclick="CashewApp.setBotSubTab('services')">
            <span class="material-symbols-rounded" style="font-size:18px;">build</span>
            Servicios e Insumos
          </button>
          <button class="bot-subtab-btn ${this.botSubTab === 'config' ? 'active' : ''}" onclick="CashewApp.setBotSubTab('config')">
            <span class="material-symbols-rounded" style="font-size:18px;">tune</span>
            Configuración & IA
          </button>
          <button class="bot-subtab-btn ${this.botSubTab === 'connect' ? 'active' : ''}" onclick="CashewApp.setBotSubTab('connect')">
            <span class="material-symbols-rounded" style="font-size:18px;">share</span>
            Conectar Canales
          </button>
        </div>

        ${this.renderBotCurrentSubTabHTML()}
      `;
    },

    renderBotCurrentSubTabHTML() {
      switch (this.botSubTab) {
        case 'faq':
          return this.buildBotFaqHTML();
        case 'services':
          return this.buildBotServicesHTML();
        case 'config':
          return this.buildBotConfigHTML();
        case 'connect':
          return this.buildBotConnectHTML();
        case 'inbox':
        default:
          return this.buildBotInboxHTML();
      }
    },

    /* ======================================================================
       SUB-TAB 1: INBOX MULTICANAL
       ====================================================================== */
    buildBotInboxHTML() {
      const allConvs = this.getVisibleBotConversations();

      // Filter by channel/attention
      const filtered = allConvs.filter(c => {
        if (this.botChannelFilter === 'whatsapp' && c.platform !== 'whatsapp') return false;
        if (this.botChannelFilter === 'instagram' && c.platform !== 'instagram') return false;
        if (this.botChannelFilter === 'messenger' && c.platform !== 'messenger') return false;
        if (this.botChannelFilter === 'attention' && !c.needsAttention) return false;

        if (this.botSearchQuery.trim()) {
          const q = this.botSearchQuery.toLowerCase();
          const hay = `${c.customerName || ''} ${c.customerPhone || ''} ${c.lastMessage || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }).sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));

      // Auto-select first conversation if none selected
      if (!this.botActiveConvId && filtered.length > 0) {
        this.botActiveConvId = filtered[0].id;
      }

      const activeConv = filtered.find(c => c.id === this.botActiveConvId) || allConvs.find(c => c.id === this.botActiveConvId) || filtered[0] || null;

      const waCount = allConvs.filter(c => c.platform === 'whatsapp').length;
      const igCount = allConvs.filter(c => c.platform === 'instagram').length;
      const fbCount = allConvs.filter(c => c.platform === 'messenger').length;
      const attnCount = allConvs.filter(c => c.needsAttention).length;

      return `
        <div class="bot-inbox-grid">
          <!-- Left Column: Search, Channels & Chat List -->
          <div class="bot-inbox-sidebar ${activeConv ? 'hidden-mobile' : ''}">
            <div class="bot-sidebar-header">
              <div class="bot-search-bar">
                <span class="material-symbols-rounded" style="font-size:18px; color:var(--text-muted);">search</span>
                <input type="text" placeholder="Buscar cliente o mensaje..."
                       value="${this.botSearchQuery}"
                       oninput="CashewApp.setBotSearchQuery(this.value)" />
                ${this.botSearchQuery ? `
                  <button style="background:none;border:none;color:var(--text-muted);cursor:pointer;" onclick="CashewApp.setBotSearchQuery('')">
                    <span class="material-symbols-rounded" style="font-size:16px;">close</span>
                  </button>
                ` : ''}
              </div>

              <!-- Channel Pills -->
              <div class="bot-channel-pills">
                <button class="bot-channel-pill ${this.botChannelFilter === 'all' ? 'active' : ''}" onclick="CashewApp.setBotChannelFilter('all')">
                  Todos (${allConvs.length})
                </button>
                <button class="bot-channel-pill ${this.botChannelFilter === 'attention' ? 'active-amber' : ''}" onclick="CashewApp.setBotChannelFilter('attention')">
                  ⚠️ Atención (${attnCount})
                </button>
                <button class="bot-channel-pill ${this.botChannelFilter === 'whatsapp' ? 'active' : ''}" onclick="CashewApp.setBotChannelFilter('whatsapp')">
                  WhatsApp (${waCount})
                </button>
                <button class="bot-channel-pill ${this.botChannelFilter === 'instagram' ? 'active' : ''}" onclick="CashewApp.setBotChannelFilter('instagram')">
                  Instagram (${igCount})
                </button>
                <button class="bot-channel-pill ${this.botChannelFilter === 'messenger' ? 'active' : ''}" onclick="CashewApp.setBotChannelFilter('messenger')">
                  Messenger (${fbCount})
                </button>
              </div>
            </div>

            <!-- Conversation Items List -->
            <div class="bot-conv-list">
              ${filtered.length === 0 ? `
                <div style="text-align:center; padding:32px 16px; color:var(--text-muted); font-size:13px;">
                  <span class="material-symbols-rounded" style="font-size:32px; opacity:0.5; margin-bottom:8px;">chat_bubble_outline</span>
                  <div>No hay conversaciones en este filtro.</div>
                </div>
              ` : filtered.map(c => this.renderBotConvItemHTML(c)).join('')}
            </div>
          </div>

          <!-- Right Column: Active Conversation Stream -->
          <div class="bot-chat-container ${!activeConv ? 'hidden-mobile' : ''}">
            ${activeConv ? this.renderBotActiveChatHTML(activeConv) : `
              <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:var(--text-muted); padding:30px; text-align:center;">
                <span class="material-symbols-rounded" style="font-size:48px; opacity:0.4; margin-bottom:12px;">forum</span>
                <h3 style="font-size:17px; font-weight:700; color:var(--text-main); margin-bottom:4px;">Bandeja Omnicanal</h3>
                <p style="font-size:13px; max-width:320px;">Selecciona una conversación de la izquierda para responder en tiempo real por WhatsApp, Instagram o Messenger.</p>
              </div>
            `}
          </div>
        </div>
      `;
    },

    renderSocialBadgeHTML(platform) {
      if (platform === 'whatsapp') {
        return `<span class="social-badge badge-wa" title="WhatsApp"><svg style="width:11px;height:11px;fill:#fff;" viewBox="0 0 24 24"><path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.711 2.598 2.669-.699c.969.54 1.772.82 2.791.82 3.181 0 5.767-2.586 5.768-5.766 0-3.18-2.586-5.766-5.768-5.766zm3.385 8.167c-.145.407-.847.776-1.18.825-.333.048-.752.067-2.434-.632-1.683-.698-2.766-2.42-2.85-2.531-.083-.112-.676-.902-.676-1.72 0-.819.429-1.222.581-1.389.153-.167.334-.209.445-.209.112 0 .223.002.32.007.102.006.239-.039.373.283.138.334.471 1.15.513 1.234.042.084.07.181.014.293-.056.111-.084.18-.167.278-.083.097-.175.217-.25.292-.083.084-.171.175-.073.343.097.167.433.714.93 1.156.64.57 1.18.747 1.347.83.167.084.264.07.362-.042.097-.112.417-.486.528-.653.111-.167.222-.139.375-.083.153.056.972.458 1.139.542.167.083.278.125.32.194.041.07.041.403-.104.81z"/></svg></span>`;
      }
      if (platform === 'instagram') {
        return `<span class="social-badge badge-ig" title="Instagram"><svg style="width:10px;height:10px;fill:#fff;" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg></span>`;
      }
      return `<span class="social-badge badge-fb" title="Messenger"><svg style="width:10px;height:10px;fill:#fff;" viewBox="0 0 24 24"><path d="M12 2C6.477 2 2 6.145 2 11.258c0 2.914 1.455 5.518 3.735 7.184V22l3.418-1.875c.907.251 1.865.388 2.847.388 5.523 0 10-4.145 10-9.255C22 6.145 17.523 2 12 2zm1.07 12.443l-2.73-2.909-5.328 2.909 5.86-6.222 2.797 2.91 5.26-2.91-5.859 6.222z"/></svg></span>`;
    },

    renderBotConvItemHTML(c) {
      const isActive = c.id === this.botActiveConvId;
      const initials = (c.customerName || 'U').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
      const timeStr = c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '';

      return `
        <div class="bot-conv-item ${isActive ? 'active' : ''} ${c.needsAttention ? 'needs-attention' : ''}"
             onclick="CashewApp.selectBotConversation('${c.id}')">
          <!-- Avatar with pinned social badge -->
          <div class="bot-avatar-wrap">
            ${c.customerAvatar ? `
              <img src="${c.customerAvatar}" class="bot-avatar-img" alt="${c.customerName}" />
            ` : `
              <div class="bot-avatar-img">${initials}</div>
            `}
            ${this.renderSocialBadgeHTML(c.platform)}
          </div>

          <!-- Content Details -->
          <div class="bot-conv-content">
            <div class="bot-conv-top-row">
              <span class="bot-conv-name">${c.customerName || 'Cliente'}</span>
              <span class="bot-conv-time">${timeStr}</span>
            </div>
            <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
              <span class="bot-conv-preview">
                ${c.needsAttention ? `<strong style="color:#d49b4b;">⚠️ Atención: </strong>` : ''}
                ${c.lastMessage || 'Sin mensajes'}
              </span>
              ${c.unreadCount > 0 ? `<span class="bot-conv-unread">${c.unreadCount}</span>` : ''}
              ${c.needsAttention && !c.unreadCount ? `<span class="bot-attention-pulse-badge">⚠️</span>` : ''}
            </div>
          </div>
        </div>
      `;
    },

    renderBotActiveChatHTML(conv) {
      const allMsgs = (this.activeList('botMessages') || [])
        .filter(m => m.convId === conv.id)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

      const initials = (conv.customerName || 'U').split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
      const botActive = conv.botActive !== false;

      return `
        <!-- Chat Header -->
        <div class="bot-chat-header">
          <div class="bot-chat-header-info">
            <button class="bot-icon-btn mob-back-btn" style="display:none;" onclick="CashewApp.selectBotConversation('')" title="Volver">
              <span class="material-symbols-rounded">arrow_back</span>
            </button>
            <div class="bot-avatar-wrap" style="width:40px; height:40px;">
              ${conv.customerAvatar ? `
                <img src="${conv.customerAvatar}" class="bot-avatar-img" alt="${conv.customerName}" />
              ` : `
                <div class="bot-avatar-img" style="font-size:13px;">${initials}</div>
              `}
              ${this.renderSocialBadgeHTML(conv.platform)}
            </div>
            <div>
              <div class="bot-chat-user-title">${conv.customerName}</div>
              <div class="bot-chat-user-sub">
                <span class="bot-status-dot"></span>
                <span>En línea • ${conv.platform === 'whatsapp' ? (conv.customerPhone || 'WhatsApp') : conv.platform === 'instagram' ? 'Instagram DM' : 'Facebook Messenger'}</span>
                ${conv.platform === 'messenger' ? `<span style="opacity:0.75;">(Privado: ${conv.platformAccount})</span>` : ''}
              </div>
            </div>
          </div>

          <div class="bot-chat-header-actions">
            <!-- Bot Toggle switch -->
            <button class="btn-cashew ${botActive ? 'btn-surface' : 'btn-primary'}"
                    style="font-size:12px; padding:6px 12px; ${!botActive ? 'border-color:#d49b4b; color:#d49b4b; background:rgba(212,155,75,0.12);' : ''}"
                    title="${botActive ? 'El Bot IA responde automáticamente. Clic para pausarlo en este chat.' : 'Modo Manual activo (IA pausada). Clic para reactivar el Bot IA.'}"
                    onclick="CashewApp.toggleBotAutoReply('${conv.id}')">
              <span class="material-symbols-rounded" style="font-size:17px; ${!botActive ? 'color:#d49b4b;' : ''}">${botActive ? 'smart_toy' : 'pause_circle'}</span>
              <span>${botActive ? 'Bot IA: Activo' : 'Modo Manual (IA Pausada)'}</span>
            </button>

            ${conv.pendingPayment ? `
              <button class="btn-cashew"
                      style="background:#d49b4b; color:#1a1a1a; font-weight:800; font-size:12px; padding:6px 12px;"
                      onclick="CashewApp.openVerifyPaymentModal('${conv.id}')">
                <span class="material-symbols-rounded" style="font-size:17px;">check_circle</span>
                Verificar Pago ($${conv.pendingPaymentAmount || 0})
              </button>
            ` : ''}

            ${conv.needsAttention && !conv.pendingPayment ? `
              <button class="btn-cashew btn-surface"
                      style="font-size:12px; padding:6px 12px; border-color:#d49b4b; color:#d49b4b;"
                      onclick="CashewApp.markBotAttentionResolved('${conv.id}')">
                <span class="material-symbols-rounded" style="font-size:17px;">done_all</span>
                Resolver Alerta
              </button>
            ` : ''}
          </div>
        </div>

        <!-- Prominent Attention Alert Banner at Top of Chat -->
        ${conv.needsAttention ? `
          <div class="bot-attention-banner">
            <div class="bot-attention-banner-text">
              <span class="material-symbols-rounded" style="font-size:24px;">warning</span>
              <div>
                <strong>Atención requerida para responder:</strong>
                <div>${conv.attentionReason || 'El cliente solicitó verificación de pago o realizó una pregunta fuera de stock.'}</div>
              </div>
            </div>
            <div class="bot-attention-banner-actions">
              ${conv.pendingPayment ? `
                <button class="btn-cashew"
                        style="background:#d49b4b; color:#1a1a1a; font-weight:800;"
                        onclick="CashewApp.openVerifyPaymentModal('${conv.id}')">
                  <span class="material-symbols-rounded">payments</span>
                  Verificar Pago Ahora
                </button>
              ` : `
                <button class="btn-cashew btn-surface" onclick="CashewApp.markBotAttentionResolved('${conv.id}')">
                  Marcar Atendido
                </button>
              `}
            </div>
          </div>
        ` : ''}

        <!-- Messages Stream -->
        <div id="botMessagesStream" class="bot-messages-stream">
          ${allMsgs.map(m => this.renderBotMessageBubbleHTML(m, conv)).join('')}

          ${conv.isTyping ? `
            <div class="bot-typing-box">
              <span>Doomlater Bot está escribiendo</span>
              <div class="bot-typing-dots">
                <span class="bot-typing-dot"></span>
                <span class="bot-typing-dot"></span>
                <span class="bot-typing-dot"></span>
              </div>
            </div>
          ` : ''}
        </div>

        <!-- Media Attachment Preview Tray (if file selected) -->
        ${this.botSelectedMedia ? `
          <div class="bot-media-tray">
            <div class="bot-media-thumb-wrap">
              ${this.botSelectedMedia.type === 'video' ? `
                <video src="${this.botSelectedMedia.dataUrl}"></video>
              ` : `
                <img src="${this.botSelectedMedia.dataUrl}" alt="Vista previa" />
              `}
              <button class="bot-media-thumb-remove" onclick="CashewApp.clearBotSelectedMedia()">✕</button>
            </div>
            <div style="font-size:12px; color:var(--text-muted); flex:1;">
              <strong>Archivo adjunto listo para enviar:</strong>
              <div>${this.botSelectedMedia.name || 'Multimedia'} (${this.botSelectedMedia.type.toUpperCase()})</div>
            </div>
          </div>
        ` : ''}

        ${!botActive ? `
          <div style="background:rgba(212,155,75,0.1); border:1px solid rgba(212,155,75,0.3); border-radius:8px; padding:7px 12px; margin:0 16px 8px 16px; display:flex; align-items:center; justify-content:space-between; font-size:12px; color:#f0f4f8;">
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="material-symbols-rounded" style="color:#d49b4b; font-size:18px;">pause_circle</span>
              <span><strong>Modo Manual Activo:</strong> El Bot IA está pausado en esta conversación para atención personal.</span>
            </div>
            <button class="btn-cashew btn-primary" style="font-size:11px; padding:3px 10px;" onclick="CashewApp.toggleBotAutoReply('${conv.id}')">
              <span class="material-symbols-rounded" style="font-size:14px;">play_arrow</span> Reactivar Bot IA
            </button>
          </div>
        ` : ''}

        <!-- Composer Bar -->
        <div class="bot-composer-bar">
          <label class="bot-icon-btn" title="Adjuntar foto o video">
            <span class="material-symbols-rounded">attach_file</span>
            <input type="file" accept="image/*,video/*" style="display:none;" onchange="CashewApp.onBotMediaSelected(event)" />
          </label>

          <button type="button" class="bot-icon-btn" title="Enviar GIF rápido" onclick="CashewApp.sendBotPresetReply('gif')">
            <span class="material-symbols-rounded">gif_box</span>
          </button>

          <button type="button" class="bot-icon-btn" title="Enviar datos de pago" onclick="CashewApp.sendBotPresetReply('payment')">
            <span class="material-symbols-rounded">credit_card</span>
          </button>

          <input type="text" id="botMessageInput" class="bot-composer-input"
                 placeholder="Escribe una respuesta como @${this.user || 'socio'}..."
                 onkeydown="if(event.key === 'Enter') CashewApp.sendBotMessageManual()" />

          <button class="bot-send-btn" title="Enviar mensaje" onclick="CashewApp.sendBotMessageManual()">
            <span class="material-symbols-rounded" style="font-size:20px;">send</span>
          </button>
        </div>
      `;
    },

    renderBotMessageBubbleHTML(msg, conv) {
      const isOutgoing = msg.direction === 'out';
      const timeStr = msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '';
      const authorLabel = isOutgoing
        ? (msg.sentBy === 'bot' ? '🤖 Doom Bot IA' : `👤 @${msg.sentBy || 'Operador'}`)
        : (conv.customerName || 'Cliente');

      let statusIcon = '';
      if (isOutgoing) {
        if (msg.deliveryStatus === 'error') {
          statusIcon = `<span class="material-symbols-rounded" style="color:#ef4444; font-size:15px; margin-left:4px; vertical-align:middle; cursor:help;" title="No entregado: ${this.escapeHtml(msg.deliveryError || 'Error de red')}">error</span>`;
        } else if (msg.deliveryStatus === 'sent') {
          statusIcon = `<span style="color:#38bdf8; font-size:12px; margin-left:4px; font-weight:700;" title="Entregado con éxito">✓✓</span>`;
        } else {
          statusIcon = `<span class="material-symbols-rounded" style="color:var(--text-muted); font-size:13px; margin-left:4px; vertical-align:middle;" title="Enviando...">schedule</span>`;
        }
      }

      return `
        <div class="bot-msg-row ${isOutgoing ? 'outgoing' : 'incoming'}">
          <span class="bot-msg-sender-name">${authorLabel}</span>
          <div class="bot-bubble">
            ${msg.mediaUrl ? `
              <div class="bot-msg-media-box">
                ${msg.mediaType === 'video' ? `
                  <video src="${msg.mediaUrl}" controls playsinline></video>
                ` : `
                  <img src="${msg.mediaUrl}" alt="Adjunto" onclick="CashewApp.openChatImageViewer('${msg.mediaUrl}', '${msg.mediaType || 'image'}')" />
                `}
              </div>
            ` : ''}
            <div>${this.escapeHtml(msg.text || '').replace(/\n/g, '<br/>')}</div>
            <div class="bot-bubble-meta">
              <span>${timeStr}</span>
              ${statusIcon}
            </div>
          </div>
        </div>
      `;
    },

    onBotMediaSelected(ev) {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      const isVid = file.type.startsWith('video');
      const reader = new FileReader();
      reader.onload = (e) => {
        this.botSelectedMedia = {
          dataUrl: e.target.result,
          type: isVid ? 'video' : 'image',
          name: file.name
        };
        this.renderMainView();
      };
      reader.readAsDataURL(file);
    },

    clearBotSelectedMedia() {
      this.botSelectedMedia = null;
      this.renderMainView();
    },

    sendBotMessageManual() {
      const input = document.getElementById('botMessageInput');
      const text = input ? input.value.trim() : '';
      if (!text && !this.botSelectedMedia) return;
      if (!this.botActiveConvId) return;

      const conv = (this.activeList('botConversations') || []).find(c => c.id === this.botActiveConvId);
      if (!conv) return;

      const now = Date.now();
      const newMsg = {
        id: 'bmsg_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        convId: conv.id,
        direction: 'out',
        text: text,
        mediaUrl: this.botSelectedMedia ? this.botSelectedMedia.dataUrl : null,
        mediaType: this.botSelectedMedia ? this.botSelectedMedia.type : null,
        sentBy: this.user || 'doom1',
        createdAt: now
      };

      const updatedConv = {
        ...conv,
        lastMessage: text || (this.botSelectedMedia ? `[${this.botSelectedMedia.type.toUpperCase()}]` : 'Mensaje'),
        lastMessageAt: now,
        unreadCount: 0
      };

      this.botSelectedMedia = null;
      if (input) input.value = '';

      window.cashewSync.batchUpsert([
        { collection: 'botMessages', item: newMsg },
        { collection: 'botConversations', item: updatedConv }
      ], `Respuesta enviada a ${conv.customerName}`);

      // Dispatch to bot-bridge outbox so customer receives it on their phone
      if (window.cashewSync && typeof window.cashewSync.queueBotOutbox === 'function') {
        window.cashewSync.queueBotOutbox({
          msgId: newMsg.id,
          convId: conv.id,
          platform: conv.platform,
          to: conv.customerPhone || conv.customerJid || conv.customerPlatformId || '',
          phone: conv.customerPhone || '',
          jid: conv.customerJid || '',
          text: text,
          mediaUrl: newMsg.mediaUrl,
          createdAt: now
        });
      }

      this.renderMainView();
      setTimeout(() => {
        const stream = document.getElementById('botMessagesStream');
        if (stream) stream.scrollTop = stream.scrollHeight;
      }, 50);
    },

    sendBotPresetReply(type) {
      if (!this.botActiveConvId) return;
      const conv = (this.activeList('botConversations') || []).find(c => c.id === this.botActiveConvId);
      if (!conv) return;

      if (type === 'payment') {
        const cfg = this.getBotConfig();
        const pms = cfg.paymentMethods || [];
        const text = 'Nuestros datos de pago verificados en Doomlater.Corp son:\n\n' +
          pms.map(p => `• ${p.name}: ${p.details}`).join('\n\n') +
          '\n\nPor favor envíanos el comprobante por acá una vez realizada la transferencia para procesar tu pedido de inmediato.';
        const input = document.getElementById('botMessageInput');
        if (input) {
          input.value = text;
          input.focus();
        }
      } else if (type === 'gif') {
        // Preset verified positive reaction GIF
        const gifUrl = 'https://media.giphy.com/media/111ebonMs90YLu/giphy.gif';
        this.botSelectedMedia = {
          dataUrl: gifUrl,
          type: 'image',
          name: 'thumbs_up.gif'
        };
        this.renderMainView();
      }
    },

    /* ======================================================================
       PAYMENT VERIFICATION MODAL & INSUMOS DEDUCTION FLOW
       ====================================================================== */
    openVerifyPaymentModal(convId) {
      const conv = (this.activeList('botConversations') || []).find(c => c.id === convId);
      if (!conv) return;

      const wallets = this.activeList('wallets') || [];
      const insumos = (this.activeList('stockItems') || []).filter(i => i.kind === 'insumo');
      const sellables = (this.activeList('stockItems') || []).filter(i => i.kind === 'para_vender');

      const amount = Number(conv.pendingPaymentAmount) || 40.00;
      const defaultInsumo = insumos[0] || null;

      const html = `
        <div class="cashew-modal-overlay" id="verifyPaymentModalOverlay" onclick="if(event.target===this) CashewApp.closeModal('verifyPaymentModalOverlay')">
          <div class="cashew-modal-sheet" style="max-width:520px;">
            <div class="modal-sheet-header">
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="material-symbols-rounded" style="color:#d49b4b; font-size:26px;">verified</span>
                <div>
                  <h2 style="font-size:18px; font-weight:800; margin:0;">Verificar y Registrar Pago</h2>
                  <div style="font-size:12px; color:var(--text-muted);">Acredita el ingreso y descuenta insumos de taller</div>
                </div>
              </div>
              <button class="icon-btn" onclick="CashewApp.closeModal('verifyPaymentModalOverlay')">
                <span class="material-symbols-rounded">close</span>
              </button>
            </div>

            <form id="verifyPaymentForm" onsubmit="event.preventDefault(); CashewApp.executeVerifyPayment('${conv.id}');">
              <!-- Summary Box -->
              <div class="verify-payment-summary-box">
                <div class="verify-payment-row">
                  <span style="color:var(--text-muted);">Cliente:</span>
                  <strong>${conv.customerName} (${conv.platform.toUpperCase()})</strong>
                </div>
                <div class="verify-payment-row">
                  <span style="color:var(--text-muted);">Concepto / Detalle:</span>
                  <span>${conv.pendingPaymentItem || 'Servicio Técnico / Venta'}</span>
                </div>
                <div class="verify-payment-row" style="font-size:15px;">
                  <span style="color:var(--text-muted); font-weight:700;">Monto Cobrado al Cliente:</span>
                  <strong style="color:var(--cashew-income); font-size:17px;">$${amount.toFixed(2)}</strong>
                </div>
              </div>

              <!-- Destination Wallet Selector -->
              <div class="form-group" style="margin-bottom:14px;">
                <label class="form-label" style="font-weight:700; font-size:13px; margin-bottom:5px; display:block;">
                  ¿En qué cuenta o billetera cayó el pago?
                </label>
                <select id="vpay_walletId" class="cashew-input" style="width:100%; font-size:13.5px;" required>
                  ${wallets.map(w => `
                    <option value="${w.id}">${w.name} (${w.currency || 'USD'})</option>
                  `).join('')}
                </select>
              </div>

              <!-- Service vs Direct Sale Toggle -->
              <div class="form-group" style="margin-bottom:14px;">
                <label class="form-label" style="font-weight:700; font-size:13px; margin-bottom:5px; display:flex; align-items:center; gap:8px;">
                  <input type="checkbox" id="vpay_isService" checked onchange="CashewApp.onVerifyServiceToggleChange(this.checked)" />
                  <span>Es un Servicio Técnico (Requiere descontar repuesto / insumo)</span>
                </label>
              </div>

              <!-- Insumo Selection section -->
              <div id="vpay_insumoSection" style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:12px; padding:12px; margin-bottom:14px;">
                <label class="form-label" style="font-weight:700; font-size:12.5px; margin-bottom:6px; display:block;">
                  Insumo de stock consumido en el taller:
                </label>
                <select id="vpay_insumoId" class="cashew-input" style="width:100%; font-size:13px;" onchange="CashewApp.updateVerifyPaymentBreakdown(${amount})">
                  ${insumos.length === 0 ? `
                    <option value="">(No hay insumos registrados en stock - se registrará sin descuento)</option>
                  ` : insumos.map(i => `
                    <option value="${i.id}" data-cost="${Number(i.purchaseCost) || 0}" data-stock="${Number(i.stock) || 0}">
                      ${i.name} (Stock: ${i.stock} un. • Costo compra: $${Number(i.purchaseCost || 0).toFixed(2)})
                    </option>
                  `).join('')}
                </select>

                <div style="display:flex; align-items:center; justify-content:space-between; margin-top:10px;">
                  <span style="font-size:12px; color:var(--text-muted);">Cantidad consumida:</span>
                  <input type="number" id="vpay_insumoQty" value="1" min="1" max="100" class="cashew-input" style="width:70px; text-align:center; padding:4px 8px; font-size:13px;" onchange="CashewApp.updateVerifyPaymentBreakdown(${amount})" />
                </div>

                <!-- Financial Net Profit Breakdown -->
                <div id="vpay_breakdownBox" style="margin-top:12px; padding-top:10px; border-top:1px dashed var(--border-subtle); font-size:12.5px;">
                  <div class="verify-profit-pill">
                    <span>Ganancia Neta Estimada:</span>
                    <strong id="vpay_netProfitVal">+$${defaultInsumo ? Math.max(0, amount - (Number(defaultInsumo.purchaseCost) || 0)).toFixed(2) : amount.toFixed(2)}</strong>
                  </div>
                </div>
              </div>

              <!-- Modal Actions -->
              <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:16px;">
                <button type="button" class="btn-cashew btn-surface" onclick="CashewApp.closeModal('verifyPaymentModalOverlay')">
                  Cancelar
                </button>
                <button type="submit" class="btn-cashew btn-primary" style="background:#d49b4b; border-color:#d49b4b; color:#1a1a1a; font-weight:800;">
                  <span class="material-symbols-rounded">check</span>
                  Confirmar y Sumar Ganancias
                </button>
              </div>
            </form>
          </div>
        </div>
      `;

      const existing = document.getElementById('verifyPaymentModalOverlay');
      if (existing) existing.remove();
      document.body.insertAdjacentHTML('beforeend', html);
    },

    onVerifyServiceToggleChange(isChecked) {
      const sec = document.getElementById('vpay_insumoSection');
      if (sec) sec.style.display = isChecked ? 'block' : 'none';
    },

    updateVerifyPaymentBreakdown(totalCharged) {
      const sel = document.getElementById('vpay_insumoId');
      const qtyInput = document.getElementById('vpay_insumoQty');
      const profitEl = document.getElementById('vpay_netProfitVal');
      if (!sel || !qtyInput || !profitEl) return;

      const opt = sel.options[sel.selectedIndex];
      const cost = opt ? (Number(opt.dataset.cost) || 0) : 0;
      const qty = Number(qtyInput.value) || 1;
      const totalCost = cost * qty;
      const net = Math.max(0, totalCharged - totalCost);
      profitEl.textContent = `+$${net.toFixed(2)} (Costo Insumo: -$${totalCost.toFixed(2)})`;
    },

    executeVerifyPayment(convId) {
      const conv = (this.activeList('botConversations') || []).find(c => c.id === convId);
      if (!conv) return;

      const walletId = document.getElementById('vpay_walletId').value;
      const isService = document.getElementById('vpay_isService').checked;
      const insumoId = document.getElementById('vpay_insumoId') ? document.getElementById('vpay_insumoId').value : null;
      const insumoQty = document.getElementById('vpay_insumoQty') ? (Number(document.getElementById('vpay_insumoQty').value) || 1) : 1;

      const amount = Number(conv.pendingPaymentAmount) || 40.00;
      const now = Date.now();
      const ops = [];

      let costBasis = 0;
      let insumoName = '';

      // 1. If service and insumo selected: deduct from stock and record Kardex movement
      if (isService && insumoId) {
        const insumo = (this.activeList('stockItems') || []).find(i => i.id === insumoId);
        if (insumo) {
          costBasis = (Number(insumo.purchaseCost) || 0) * insumoQty;
          insumoName = insumo.name;
          const updatedStock = Math.max(0, (Number(insumo.stock) || 0) - insumoQty);
          ops.push({
            collection: 'stockItems',
            item: {
              ...insumo,
              stock: updatedStock,
              updatedAt: now,
              updatedBy: this.user || 'doom1'
            }
          });

          // Stock movement
          ops.push({
            collection: 'stockMovements',
            item: {
              id: 'sm_vpay_' + now.toString(36),
              stockItemId: insumo.id,
              stockItemName: insumo.name,
              kind: 'out',
              qty: insumoQty,
              reason: 'service_insumo',
              costBasis: costBasis,
              note: `Insumo usado en servicio técnico para ${conv.customerName} (${conv.platform})`,
              createdBy: this.user || 'doom1',
              createdAt: now
            }
          });
        }
      }

      // 2. Register Income Transaction
      const serviceCat = (this.activeList('categories') || []).find(c => c.id === 'c_servicio' || c.type === 'income') || { id: 'c_servicio' };
      ops.push({
        collection: 'transactions',
        item: {
          id: 'tx_vpay_' + now.toString(36),
          type: 'income',
          amount: amount,
          costBasis: costBasis,
          netProfit: Math.max(0, amount - costBasis),
          walletId: walletId,
          categoryId: serviceCat.id,
          date: todayLocalISO(),
          time: nowHHMM(),
          title: `Cobro verificado ${conv.customerName} (${conv.platform.toUpperCase()})`,
          note: `Atendido por ${this.user || 'doom1'}. Servicio: ${conv.pendingPaymentItem || 'Servicio Técnico'}${insumoName ? ` (Insumo: ${insumoName} -$${costBasis.toFixed(2)})` : ''}`,
          createdBy: this.user || 'doom1',
          createdAt: now,
          updatedAt: now
        }
      });

      // 3. Update Conversation: remove mustard highlight & pending payment
      const updatedConv = {
        ...conv,
        needsAttention: false,
        pendingPayment: false,
        paymentVerified: true,
        attentionReason: '',
        lastMessage: `✅ Pago verificado por @${this.user}`,
        lastMessageAt: now
      };
      ops.push({ collection: 'botConversations', item: updatedConv });

      // 4. Send Confirmation Message to customer
      ops.push({
        collection: 'botMessages',
        item: {
          id: 'bmsg_vpay_conf_' + now.toString(36),
          convId: conv.id,
          direction: 'out',
          text: `✅ ¡Tu pago de $${amount.toFixed(2)} ha sido verificado con éxito por @${this.user || 'socio'}! Hemos procesado tu orden con éxito. ¡Muchas gracias por tu compra en Doomlater.Corp! ✨`,
          sentBy: this.user || 'doom1',
          createdAt: now + 100
        }
      });

      window.cashewSync.batchUpsert(ops, `Pago verificado: $${amount.toFixed(2)} de ${conv.customerName}`);

      this.closeModal('verifyPaymentModalOverlay');
      this.toast(`¡Pago de $${amount.toFixed(2)} verificado! Ganancias e insumos actualizados.`, 'verified');
      this.renderMainView();
    },

    /* ======================================================================
       SUB-TAB 2: MÉTODOS DE PAGO & FAQ (BASE DE CONOCIMIENTO)
       ====================================================================== */
    buildBotFaqHTML() {
      const cfg = this.getBotConfig();
      const pms = cfg.paymentMethods || [];
      const faqs = cfg.knowledgeBaseFaq || [];

      return `
        <div style="display:flex; flex-direction:column; gap:20px; max-width:960px;">
          <!-- Payment Methods Section -->
          <div class="bot-card-setting">
            <div class="bot-card-header">
              <div class="bot-card-title">
                <span class="material-symbols-rounded" style="color:var(--cashew-income);">account_balance_wallet</span>
                Métodos de Pago Oficiales
              </div>
              <button class="btn-cashew btn-primary" style="font-size:12px; padding:6px 14px;" onclick="CashewApp.openEditPaymentMethodModal('')">
                <span class="material-symbols-rounded" style="font-size:18px;">add</span>
                Agregar Método de Pago
              </button>
            </div>
            <p style="font-size:13px; color:var(--text-muted); margin:0;">
              Estos métodos de pago son entregados por el bot automáticamente a los clientes en WhatsApp e Instagram cuando preguntan cómo pagar.
            </p>

            <div style="display:flex; flex-direction:column; gap:8px;">
              ${pms.map(p => `
                <div style="display:flex; align-items:center; justify-content:space-between; background:var(--bg-elevated); padding:12px 16px; border-radius:14px; border:1px solid var(--border-subtle); gap:12px;">
                  <div>
                    <div style="font-weight:800; font-size:14px; color:var(--text-main);">${p.name}</div>
                    <div style="font-size:12.5px; color:var(--text-muted); margin-top:2px;">${p.details}</div>
                  </div>
                  <div style="display:flex; gap:6px;">
                    <button class="bot-icon-btn" title="Editar" onclick="CashewApp.openEditPaymentMethodModal('${p.id}')">
                      <span class="material-symbols-rounded" style="font-size:18px;">edit</span>
                    </button>
                    <button class="bot-icon-btn" style="color:var(--cashew-expense);" title="Eliminar" onclick="CashewApp.deletePaymentMethod('${p.id}')">
                      <span class="material-symbols-rounded" style="font-size:18px;">delete</span>
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Knowledge Base FAQ Section -->
          <div class="bot-card-setting">
            <div class="bot-card-header">
              <div class="bot-card-title">
                <span class="material-symbols-rounded" style="color:var(--primary);">psychology</span>
                Base de Conocimiento & Preguntas Frecuentes (FAQ)
              </div>
              <button class="btn-cashew btn-primary" style="font-size:12px; padding:6px 14px;" onclick="CashewApp.openEditFaqModal('')">
                <span class="material-symbols-rounded" style="font-size:18px;">add</span>
                Agregar Pregunta
              </button>
            </div>
            <p style="font-size:13px; color:var(--text-muted); margin:0;">
              El asistente de IA consulta estas preguntas y respuestas además del stock para responder dudas comunes de forma autónoma.
            </p>

            <div style="display:flex; flex-direction:column; gap:10px;">
              ${faqs.map(f => `
                <div style="background:var(--bg-elevated); padding:14px 16px; border-radius:14px; border:1px solid var(--border-subtle); display:flex; justify-content:space-between; gap:12px;">
                  <div style="flex:1;">
                    <div style="font-weight:800; font-size:14px; color:var(--primary);">${f.question}</div>
                    <div style="font-size:13px; color:var(--text-main); margin-top:4px; line-height:1.45;">${f.answer}</div>
                  </div>
                  <div style="display:flex; gap:6px; align-self:flex-start;">
                    <button class="bot-icon-btn" title="Editar" onclick="CashewApp.openEditFaqModal('${f.id}')">
                      <span class="material-symbols-rounded" style="font-size:18px;">edit</span>
                    </button>
                    <button class="bot-icon-btn" style="color:var(--cashew-expense);" title="Eliminar" onclick="CashewApp.deleteFaqItem('${f.id}')">
                      <span class="material-symbols-rounded" style="font-size:18px;">delete</span>
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;
    },

    openEditPaymentMethodModal(pmId) {
      const cfg = this.getBotConfig();
      const existing = (cfg.paymentMethods || []).find(p => p.id === pmId) || { id: '', name: '', details: '' };

      const html = `
        <div class="cashew-modal-overlay" id="editPmModalOverlay" onclick="if(event.target===this) CashewApp.closeModal('editPmModalOverlay')">
          <div class="cashew-modal-sheet" style="max-width:440px;">
            <div class="modal-sheet-header">
              <h2 style="font-size:17px; font-weight:800; margin:0;">${pmId ? 'Editar' : 'Agregar'} Método de Pago</h2>
              <button class="icon-btn" onclick="CashewApp.closeModal('editPmModalOverlay')">
                <span class="material-symbols-rounded">close</span>
              </button>
            </div>
            <form onsubmit="event.preventDefault(); CashewApp.savePaymentMethod('${pmId}');">
              <div class="form-group" style="margin-bottom:12px;">
                <label class="form-label" style="font-size:12.5px; font-weight:700; margin-bottom:4px; display:block;">Nombre del Método (ej. Pago Móvil / Binance)</label>
                <input type="text" id="pm_name" class="cashew-input" style="width:100%;" value="${this.escapeHtml(existing.name)}" required />
              </div>
              <div class="form-group" style="margin-bottom:16px;">
                <label class="form-label" style="font-size:12.5px; font-weight:700; margin-bottom:4px; display:block;">Datos / Detalles de Cuenta</label>
                <textarea id="pm_details" class="cashew-input" style="width:100%; height:75px;" required>${this.escapeHtml(existing.details)}</textarea>
              </div>
              <div style="display:flex; justify-content:flex-end; gap:8px;">
                <button type="button" class="btn-cashew btn-surface" onclick="CashewApp.closeModal('editPmModalOverlay')">Cancelar</button>
                <button type="submit" class="btn-cashew btn-primary">Guardar Método</button>
              </div>
            </form>
          </div>
        </div>
      `;
      const ex = document.getElementById('editPmModalOverlay');
      if (ex) ex.remove();
      document.body.insertAdjacentHTML('beforeend', html);
    },

    savePaymentMethod(pmId) {
      const name = document.getElementById('pm_name').value.trim();
      const details = document.getElementById('pm_details').value.trim();
      if (!name || !details) return;

      const cfg = this.getBotConfig();
      const list = [...(cfg.paymentMethods || [])];
      if (pmId) {
        const idx = list.findIndex(p => p.id === pmId);
        if (idx !== -1) list[idx] = { id: pmId, name, details };
      } else {
        list.push({ id: 'pm_' + Date.now().toString(36), name, details });
      }

      window.cashewSync.saveBotConfig({ paymentMethods: list }, 'Método de pago guardado');
      this.closeModal('editPmModalOverlay');
      this.toast('Método de pago actualizado', 'verified');
      this.renderMainView();
    },

    deletePaymentMethod(pmId) {
      if (!confirm('¿Eliminar este método de pago?')) return;
      const cfg = this.getBotConfig();
      const list = (cfg.paymentMethods || []).filter(p => p.id !== pmId);
      window.cashewSync.saveBotConfig({ paymentMethods: list }, 'Método de pago eliminado');
      this.toast('Método de pago eliminado', 'delete');
      this.renderMainView();
    },

    openEditFaqModal(faqId) {
      const cfg = this.getBotConfig();
      const existing = (cfg.knowledgeBaseFaq || []).find(f => f.id === faqId) || { id: '', question: '', answer: '' };

      const html = `
        <div class="cashew-modal-overlay" id="editFaqModalOverlay" onclick="if(event.target===this) CashewApp.closeModal('editFaqModalOverlay')">
          <div class="cashew-modal-sheet" style="max-width:480px;">
            <div class="modal-sheet-header">
              <h2 style="font-size:17px; font-weight:800; margin:0;">${faqId ? 'Editar' : 'Agregar'} Pregunta Frecuente (FAQ)</h2>
              <button class="icon-btn" onclick="CashewApp.closeModal('editFaqModalOverlay')">
                <span class="material-symbols-rounded">close</span>
              </button>
            </div>
            <form onsubmit="event.preventDefault(); CashewApp.saveFaqItem('${faqId}');">
              <div class="form-group" style="margin-bottom:12px;">
                <label class="form-label" style="font-size:12.5px; font-weight:700; margin-bottom:4px; display:block;">Pregunta del Cliente (ej. ¿Hacen delivery?)</label>
                <input type="text" id="faq_q" class="cashew-input" style="width:100%;" value="${this.escapeHtml(existing.question)}" required />
              </div>
              <div class="form-group" style="margin-bottom:16px;">
                <label class="form-label" style="font-size:12.5px; font-weight:700; margin-bottom:4px; display:block;">Respuesta que dará la IA</label>
                <textarea id="faq_a" class="cashew-input" style="width:100%; height:90px;" required>${this.escapeHtml(existing.answer)}</textarea>
              </div>
              <div style="display:flex; justify-content:flex-end; gap:8px;">
                <button type="button" class="btn-cashew btn-surface" onclick="CashewApp.closeModal('editFaqModalOverlay')">Cancelar</button>
                <button type="submit" class="btn-cashew btn-primary">Guardar Pregunta</button>
              </div>
            </form>
          </div>
        </div>
      `;
      const ex = document.getElementById('editFaqModalOverlay');
      if (ex) ex.remove();
      document.body.insertAdjacentHTML('beforeend', html);
    },

    saveFaqItem(faqId) {
      const q = document.getElementById('faq_q').value.trim();
      const a = document.getElementById('faq_a').value.trim();
      if (!q || !a) return;

      const cfg = this.getBotConfig();
      const list = [...(cfg.knowledgeBaseFaq || [])];
      if (faqId) {
        const idx = list.findIndex(f => f.id === faqId);
        if (idx !== -1) list[idx] = { id: faqId, question: q, answer: a };
      } else {
        list.push({ id: 'faq_' + Date.now().toString(36), question: q, answer: a });
      }

      window.cashewSync.saveBotConfig({ knowledgeBaseFaq: list }, 'FAQ del bot guardado');
      this.closeModal('editFaqModalOverlay');
      this.toast('Pregunta frecuente guardada', 'psychology');
      this.renderMainView();
    },

    deleteFaqItem(faqId) {
      if (!confirm('¿Eliminar esta pregunta de la base de conocimiento?')) return;
      const cfg = this.getBotConfig();
      const list = (cfg.knowledgeBaseFaq || []).filter(f => f.id !== faqId);
      window.cashewSync.saveBotConfig({ knowledgeBaseFaq: list }, 'FAQ eliminado');
      this.toast('Pregunta eliminada', 'delete');
      this.renderMainView();
    },

    /* ======================================================================
       SUB-TAB 3: SERVICIOS E INSUMOS
       ====================================================================== */
    buildBotServicesHTML() {
      const cfg = this.getBotConfig();
      const maps = cfg.serviceInsumosMap || [];
      const insumos = (this.activeList('stockItems') || []).filter(i => i.kind === 'insumo');

      return `
        <div style="display:flex; flex-direction:column; gap:20px; max-width:960px;">
          <div class="bot-card-setting">
            <div class="bot-card-header">
              <div class="bot-card-title">
                <span class="material-symbols-rounded" style="color:var(--primary);">build</span>
                Servicios Técnicos Vinculados a Insumos
              </div>
              <button class="btn-cashew btn-primary" style="font-size:12px; padding:6px 14px;" onclick="CashewApp.openAddServiceMappingModal()">
                <span class="material-symbols-rounded" style="font-size:18px;">add</span>
                Vincular Servicio
              </button>
            </div>
            <p style="font-size:13px; color:var(--text-muted); margin:0;">
              Cuando un cliente paga por uno de estos servicios, el bot sugiere automáticamente descontar el insumo de taller correspondiente para calcular la ganancia neta.
            </p>

            <div style="display:flex; flex-direction:column; gap:10px;">
              ${maps.map(s => `
                <div style="display:flex; align-items:center; justify-content:space-between; background:var(--bg-elevated); padding:14px 16px; border-radius:14px; border:1px solid var(--border-subtle); gap:12px;">
                  <div>
                    <div style="font-weight:800; font-size:14.5px; color:var(--text-main);">${s.serviceName}</div>
                    <div style="font-size:12.5px; color:var(--text-muted); margin-top:3px;">
                      Insumo por defecto: <strong style="color:var(--text-main);">${s.defaultInsumoName}</strong> • Precio mano de obra sugerido: <strong style="color:var(--cashew-income);">$${Number(s.defaultLaborPrice || 0).toFixed(2)}</strong>
                    </div>
                  </div>
                  <button class="bot-icon-btn" style="color:var(--cashew-expense);" onclick="CashewApp.deleteServiceMapping('${s.id}')" title="Eliminar mapeo">
                    <span class="material-symbols-rounded" style="font-size:18px;">delete</span>
                  </button>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      `;
    },

    openAddServiceMappingModal() {
      const insumos = (this.activeList('stockItems') || []).filter(i => i.kind === 'insumo');

      const html = `
        <div class="cashew-modal-overlay" id="addSrvModalOverlay" onclick="if(event.target===this) CashewApp.closeModal('addSrvModalOverlay')">
          <div class="cashew-modal-sheet" style="max-width:440px;">
            <div class="modal-sheet-header">
              <h2 style="font-size:17px; font-weight:800; margin:0;">Vincular Servicio a Insumo</h2>
              <button class="icon-btn" onclick="CashewApp.closeModal('addSrvModalOverlay')">
                <span class="material-symbols-rounded">close</span>
              </button>
            </div>
            <form onsubmit="event.preventDefault(); CashewApp.saveServiceMapping();">
              <div class="form-group" style="margin-bottom:12px;">
                <label class="form-label" style="font-size:12.5px; font-weight:700; margin-bottom:4px; display:block;">Nombre del Servicio (ej. Mantenimiento PS5 / Cambio Pantalla)</label>
                <input type="text" id="srv_name" class="cashew-input" style="width:100%;" required />
              </div>
              <div class="form-group" style="margin-bottom:12px;">
                <label class="form-label" style="font-size:12.5px; font-weight:700; margin-bottom:4px; display:block;">Insumo de taller que consume</label>
                <select id="srv_insumo" class="cashew-input" style="width:100%;">
                  ${insumos.map(i => `<option value="${i.name}">${i.name}</option>`).join('')}
                  <option value="Insumo genérico">Otro / Insumo genérico</option>
                </select>
              </div>
              <div class="form-group" style="margin-bottom:16px;">
                <label class="form-label" style="font-size:12.5px; font-weight:700; margin-bottom:4px; display:block;">Precio sugerido de venta ($)</label>
                <input type="number" step="0.5" id="srv_price" class="cashew-input" style="width:100%;" value="40" required />
              </div>
              <div style="display:flex; justify-content:flex-end; gap:8px;">
                <button type="button" class="btn-cashew btn-surface" onclick="CashewApp.closeModal('addSrvModalOverlay')">Cancelar</button>
                <button type="submit" class="btn-cashew btn-primary">Guardar</button>
              </div>
            </form>
          </div>
        </div>
      `;
      const ex = document.getElementById('addSrvModalOverlay');
      if (ex) ex.remove();
      document.body.insertAdjacentHTML('beforeend', html);
    },

    saveServiceMapping() {
      const name = document.getElementById('srv_name').value.trim();
      const insumoName = document.getElementById('srv_insumo').value.trim();
      const price = Number(document.getElementById('srv_price').value) || 0;
      if (!name) return;

      const cfg = this.getBotConfig();
      const list = [...(cfg.serviceInsumosMap || [])];
      list.push({
        id: 'srv_' + Date.now().toString(36),
        serviceName: name,
        defaultInsumoName: insumoName,
        defaultLaborPrice: price
      });

      window.cashewSync.saveBotConfig({ serviceInsumosMap: list }, 'Mapeo de servicio guardado');
      this.closeModal('addSrvModalOverlay');
      this.toast('Servicio técnico vinculado', 'build');
      this.renderMainView();
    },

    deleteServiceMapping(id) {
      if (!confirm('¿Eliminar este servicio?')) return;
      const cfg = this.getBotConfig();
      const list = (cfg.serviceInsumosMap || []).filter(s => s.id !== id);
      window.cashewSync.saveBotConfig({ serviceInsumosMap: list }, 'Mapeo de servicio eliminado');
      this.toast('Servicio eliminado', 'delete');
      this.renderMainView();
    },

    /* ======================================================================
       SUB-TAB 4: CONFIGURACIÓN & IA
       ====================================================================== */
    buildBotConfigHTML() {
      const cfg = this.getBotConfig();

      return `
        <div style="display:flex; flex-direction:column; gap:20px; max-width:960px;">
          <form onsubmit="event.preventDefault(); CashewApp.saveBotConfigFromForm();">
            <div class="bot-card-setting">
              <div class="bot-card-title">
                <span class="material-symbols-rounded" style="color:var(--primary);">tune</span>
                Comportamiento & Simulación Humana
              </div>

              <!-- Typing Delay Slider -->
              <div style="display:flex; flex-direction:column; gap:6px;">
                <label style="font-weight:700; font-size:13.5px; color:var(--text-main); display:flex; justify-content:space-between;">
                  <span>Retardo de Respuesta Humana:</span>
                  <span id="cfg_delayVal" style="color:var(--primary); font-weight:800;">${cfg.typingDelaySec} segundos</span>
                </label>
                <input type="range" id="cfg_delay" min="1.0" max="6.0" step="0.5" value="${cfg.typingDelaySec}"
                       oninput="document.getElementById('cfg_delayVal').textContent = this.value + ' segundos'" />
                <span style="font-size:12px; color:var(--text-muted);">Recomendado: 3.0 a 4.0 segundos para simular lectura y tipeo humano creíble.</span>
              </div>

              <!-- Indicators toggles -->
              <div style="display:flex; flex-direction:column; gap:10px; margin-top:8px;">
                <label style="display:flex; align-items:center; gap:10px; font-size:13.5px; font-weight:700; cursor:pointer;">
                  <input type="checkbox" id="cfg_showTyping" ${cfg.showTypingIndicator ? 'checked' : ''} />
                  <span>Simular estado "Escribiendo..." durante el retardo</span>
                </label>
                <label style="display:flex; align-items:center; gap:10px; font-size:13.5px; font-weight:700; cursor:pointer;">
                  <input type="checkbox" id="cfg_showOnline" ${cfg.showOnlinePresence ? 'checked' : ''} />
                  <span>Mostrar estado "En línea" permanente en los perfiles</span>
                </label>
              </div>

              <!-- Facebook Messenger Dedicated Redirect Message -->
              <div style="margin-top:14px;">
                <label style="font-weight:700; font-size:13.5px; color:var(--text-main); display:block; margin-bottom:5px;">
                  Mensaje Único Exclusivo para Facebook Messenger (Redirección a WhatsApp):
                </label>
                <textarea id="cfg_messengerMsg" class="cashew-input" style="width:100%; height:90px; font-size:13px; line-height:1.45;" required>${this.escapeHtml(cfg.messengerRedirectMessage)}</textarea>
                <span style="font-size:12px; color:var(--text-muted);">
                  Tal como solicitaste, Messenger enviará <strong>estrictamente un solo mensaje</strong> con este texto y el número para que el cliente continúe por WhatsApp.
                </span>
              </div>

              <!-- Gemini API Key -->
              <div style="margin-top:14px;">
                <label style="font-weight:700; font-size:13.5px; color:var(--text-main); display:block; margin-bottom:5px;">
                  Clave API de Google Gemini (100% Gratuita en Google AI Studio):
                </label>
                <input type="password" id="cfg_geminiKey" class="cashew-input" style="width:100%;" value="${this.escapeHtml(cfg.geminiApiKey)}" placeholder="AIzaSy..." />
                <span style="font-size:12px; color:var(--text-muted); display:block; margin-top:4px;">
                  Puedes obtener tu clave gratuita en <a href="https://aistudio.google.com/app/apikey" target="_blank" style="color:var(--primary); font-weight:700;">Google AI Studio</a> (0$ costo para siempre).
                </span>
              </div>

              <div style="display:flex; justify-content:flex-end; margin-top:12px;">
                <button type="submit" class="btn-cashew btn-primary" style="padding:8px 20px;">
                  <span class="material-symbols-rounded">save</span> Guardar Configuración
                </button>
              </div>
            </div>
          </form>
        </div>
      `;
    },

    saveBotConfigFromForm() {
      const delay = Number(document.getElementById('cfg_delay').value) || 3.5;
      const showTyping = document.getElementById('cfg_showTyping').checked;
      const showOnline = document.getElementById('cfg_showOnline').checked;
      const messengerMsg = document.getElementById('cfg_messengerMsg').value.trim();
      const geminiKey = document.getElementById('cfg_geminiKey').value.trim();

      window.cashewSync.saveBotConfig({
        typingDelaySec: delay,
        showTypingIndicator: showTyping,
        showOnlinePresence: showOnline,
        messengerRedirectMessage: messengerMsg,
        geminiApiKey: geminiKey
      }, 'Configuración del bot guardada');

      this.toast('Ajustes del bot guardados con éxito', 'verified');
      this.renderMainView();
    },

    /* ======================================================================
       SUB-TAB 5: CONECTAR CANALES (WHATSAPP QR, INSTAGRAM, MESSENGER)
       ====================================================================== */
    buildBotConnectHTML() {
      const cfg = this.getBotConfig();

      return `
        <div style="display:flex; flex-direction:column; gap:20px; max-width:960px;">
          <!-- 1. WhatsApp Connection Card (Pairing Code & QR) -->
          <div class="bot-channel-conn-card">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span class="social-badge badge-wa" style="position:static; width:26px; height:26px; font-size:14px;">
                  <svg style="width:14px;height:14px;fill:#fff;" viewBox="0 0 24 24"><path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.711 2.598 2.669-.699c.969.54 1.772.82 2.791.82 3.181 0 5.767-2.586 5.768-5.766 0-3.18-2.586-5.766-5.768-5.766zm3.385 8.167c-.145.407-.847.776-1.18.825-.333.048-.752.067-2.434-.632-1.683-.698-2.766-2.42-2.85-2.531-.083-.112-.676-.902-.676-1.72 0-.819.429-1.222.581-1.389.153-.167.334-.209.445-.209.112 0 .223.002.32.007.102.006.239-.039.373.283.138.334.471 1.15.513 1.234.042.084.07.181.014.293-.056.111-.084.18-.167.278-.083.097-.175.217-.25.292-.083.084-.171.175-.073.343.097.167.433.714.93 1.156.64.57 1.18.747 1.347.83.167.084.264.07.362-.042.097-.112.417-.486.528-.653.111-.167.222-.139.375-.083.153.056.972.458 1.139.542.167.083.278.125.32.194.041.07.041.403-.104.81z"/></svg>
                </span>
                <div>
                  <h3 style="font-size:16px; font-weight:800; margin:0;">WhatsApp Oficial (Compartido doom1 & doom2)</h3>
                  <div style="font-size:12px; color:var(--text-muted);">Vinculación directa por Código de 8 Dígitos o Código QR</div>
                </div>
              </div>
              <span class="bot-channel-status-pill ${cfg.whatsappConnected ? 'connected' : 'disconnected'}">
                <span class="material-symbols-rounded" style="font-size:14px;">${cfg.whatsappConnected ? 'check_circle' : 'pending'}</span>
                ${cfg.whatsappConnected ? 'Conectado' : 'Esperando Vinculación'}
              </span>
            </div>

            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:14px; margin-top:10px;">
              <!-- Método A: Código de 8 Dígitos (Pairing Code) -->
              <div style="background:var(--bg-card); padding:16px; border-radius:14px; border:1px solid var(--border-subtle); display:flex; flex-direction:column; gap:10px;">
                <div style="font-weight:800; font-size:14px; color:var(--primary); display:flex; align-items:center; gap:6px;">
                  <span class="material-symbols-rounded">pin</span>
                  Método 1: Código de 8 Dígitos (Recomendado)
                </div>
                <p style="font-size:12px; color:var(--text-muted); margin:0; line-height:1.4;">
                  Escribe tu número de teléfono con código de país. Te generará un código de 8 dígitos para escribirlo en WhatsApp en tu teléfono sin escanear nada.
                </p>
                <div style="display:flex; gap:8px;">
                  <input type="text" id="waPairPhoneInput" class="cashew-input" style="flex:1; font-size:13px;"
                         placeholder="Ej: 584245323796" value="${cfg.whatsappPairingPhone || '584245323796'}" />
                  <button class="btn-cashew btn-primary" style="font-size:12px; padding:6px 12px;" onclick="CashewApp.requestWhatsAppPairingCode()">
                    Generar Código
                  </button>
                </div>

                ${cfg.whatsappPairingCode ? `
                  <div style="background:var(--bg-elevated); border:1.5px dashed var(--primary); border-radius:12px; padding:12px; text-align:center;">
                    <div style="font-size:11px; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.05em;">Tu Código de Vinculación</div>
                    <div style="font-size:24px; font-weight:900; letter-spacing:0.18em; color:var(--primary); margin:6px 0;" id="waPairCodeText">
                      ${cfg.whatsappPairingCode}
                    </div>
                    <button class="btn-cashew btn-surface btn-sm" onclick="CashewApp.copyWhatsAppPairingCode('${cfg.whatsappPairingCode}')">
                      <span class="material-symbols-rounded" style="font-size:15px;">content_copy</span> Copiar Código
                    </button>
                  </div>
                  <div style="font-size:11.5px; color:var(--text-muted); line-height:1.45;">
                    👉 En tu teléfono: Abre <strong>WhatsApp</strong> &gt; <strong>Dispositivos vinculados</strong> &gt; <strong>Vincular un dispositivo</strong> &gt; Toca abajo en <strong>"Vincular con el número de teléfono"</strong> &gt; Escribe este código.
                  </div>
                ` : ''}
              </div>

              <!-- Método B: Código QR -->
              <div style="background:var(--bg-card); padding:16px; border-radius:14px; border:1px solid var(--border-subtle); display:flex; flex-direction:column; align-items:center; gap:10px; text-align:center;">
                <div style="font-weight:800; font-size:14px; color:var(--text-main); display:flex; align-items:center; gap:6px;">
                  <span class="material-symbols-rounded">qr_code_scanner</span>
                  Método 2: Escanear Código QR
                </div>
                <div class="bot-qr-box" style="padding:8px;">
                  ${cfg.whatsappQr ? `
                    <img src="${cfg.whatsappQr}" alt="QR WhatsApp" style="width:140px; height:140px;" />
                  ` : `
                    <div style="width:140px; height:140px; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--text-muted); font-size:11px; padding:8px; line-height:1.4;">
                      <span class="material-symbols-rounded" style="font-size:32px; margin-bottom:4px; opacity:0.5;">hourglass_empty</span>
                      <span>Esperando QR real de WhatsApp del servidor...</span>
                    </div>
                  `}
                </div>
                <button class="btn-cashew btn-surface btn-sm" onclick="CashewApp.refreshWhatsAppQr()">
                  <span class="material-symbols-rounded" style="font-size:15px;">refresh</span> Solicitar Nuevo QR
                </button>
              </div>
            </div>
          </div>

          <!-- 2. Instagram Card (Shared for doom1 and doom2) -->
          <div class="bot-channel-conn-card">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span class="social-badge badge-ig" style="position:static; width:26px; height:26px; font-size:14px;">
                  <svg style="width:13px;height:13px;fill:#fff;" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>
                </span>
                <div>
                  <h3 style="font-size:16px; font-weight:800; margin:0;">Instagram Direct (Compartido doom1 & doom2)</h3>
                  <div style="font-size:12px; color:var(--text-muted);">Mensajes directos de Instagram con Webhook Meta oficial</div>
                </div>
              </div>
              <span class="bot-channel-status-pill ${cfg.instagramConnected ? 'connected' : 'disconnected'}">
                <span class="material-symbols-rounded" style="font-size:14px;">${cfg.instagramConnected ? 'check_circle' : 'pending'}</span>
                ${cfg.instagramConnected ? 'Conectado' : 'Desconectado'}
              </span>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-card); padding:10px 14px; border-radius:12px;">
              <span style="font-size:13px; color:var(--text-muted);">Estado de la sesión de Instagram:</span>
              <button class="btn-cashew btn-surface" onclick="CashewApp.toggleChannelConnection('instagram')">
                <span class="material-symbols-rounded">${cfg.instagramConnected ? 'logout' : 'login'}</span>
                ${cfg.instagramConnected ? 'Cerrar Sesión Instagram' : 'Iniciar Sesión en Instagram'}
              </button>
            </div>
          </div>

          <!-- 3. Facebook Messenger Card (Strictly Private per Profile!) -->
          <div class="bot-channel-conn-card">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span class="social-badge badge-fb" style="position:static; width:26px; height:26px; font-size:14px;">
                  <svg style="width:13px;height:13px;fill:#fff;" viewBox="0 0 24 24"><path d="M12 2C6.477 2 2 6.145 2 11.258c0 2.914 1.455 5.518 3.735 7.184V22l3.418-1.875c.907.251 1.865.388 2.847.388 5.523 0 10-4.145 10-9.255C22 6.145 17.523 2 12 2zm1.07 12.443l-2.73-2.909-5.328 2.909 5.86-6.222 2.797 2.91 5.26-2.91-5.859 6.222z"/></svg>
                </span>
                <div>
                  <h3 style="font-size:16px; font-weight:800; margin:0;">Facebook Messenger (Cuentas Separadas Privadas)</h3>
                  <div style="font-size:12px; color:var(--text-muted);">Cada socio tiene su propio Messenger independiente</div>
                </div>
              </div>
            </div>

            <p style="font-size:13px; color:var(--text-muted); margin:0;">
              En Facebook Messenger, cada socio inicia sesión con sus propias credenciales. Las conversaciones de doom1 son privadas para doom1, y las de doom2 son privadas para doom2.
            </p>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
              <!-- Messenger doom1 -->
              <div style="background:var(--bg-card); padding:14px; border-radius:14px; border:1px solid var(--border-subtle); display:flex; flex-direction:column; gap:8px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <strong>Messenger de @doom1</strong>
                  <span class="bot-channel-status-pill ${cfg.messengerDoom1Connected ? 'connected' : 'disconnected'}">
                    ${cfg.messengerDoom1Connected ? 'Activo' : 'Inactivo'}
                  </span>
                </div>
                <div style="font-size:12px; color:var(--text-muted);">
                  Privado para el socio doom1. Envía redirección a WhatsApp y muestra chats solo a doom1.
                </div>
                <button class="btn-cashew btn-surface" style="font-size:12px; margin-top:4px;" onclick="CashewApp.toggleChannelConnection('messenger', 'messengerDoom1Connected')">
                  <span class="material-symbols-rounded">${cfg.messengerDoom1Connected ? 'logout' : 'login'}</span>
                  ${cfg.messengerDoom1Connected ? 'Desconectar doom1' : 'Iniciar Sesión doom1'}
                </button>
              </div>

              <!-- Messenger doom2 -->
              <div style="background:var(--bg-card); padding:14px; border-radius:14px; border:1px solid var(--border-subtle); display:flex; flex-direction:column; gap:8px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <strong>Messenger de @doom2</strong>
                  <span class="bot-channel-status-pill ${cfg.messengerDoom2Connected ? 'connected' : 'disconnected'}">
                    ${cfg.messengerDoom2Connected ? 'Activo' : 'Inactivo'}
                  </span>
                </div>
                <div style="font-size:12px; color:var(--text-muted);">
                  Privado para el socio doom2. Envía redirección a WhatsApp y muestra chats solo a doom2.
                </div>
                <button class="btn-cashew btn-surface" style="font-size:12px; margin-top:4px;" onclick="CashewApp.toggleChannelConnection('messenger', 'messengerDoom2Connected')">
                  <span class="material-symbols-rounded">${cfg.messengerDoom2Connected ? 'logout' : 'login'}</span>
                  ${cfg.messengerDoom2Connected ? 'Iniciar Sesión doom2' : 'Iniciar Sesión doom2'}
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
    },

    async refreshWhatsAppQr() {
      this.toast('Solicitando QR nuevo a WhatsApp...', 'refresh');
      // 1. Post newQr command to server
      fetch('https://ok-gogle-c018c-default-rtdb.firebaseio.com/cashew_doom_bot_commands/newQr.json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestedAt: Date.now() })
      }).catch(() => {});
      fetch('https://doomlater-bot.onrender.com/api/whatsapp/reset', { method: 'POST' }).catch(() => {});

      // 2. Poll for fresh QR from status
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const res = await fetch('https://ok-gogle-c018c-default-rtdb.firebaseio.com/cashew_doom_bot_status/whatsapp.json');
          if (res.ok) {
            const data = await res.json();
            if (data && data.qr) {
              clearInterval(poll);
              window.cashewSync.saveBotConfig({
                whatsappQr: data.qr,
                whatsappConnected: Boolean(data.connected)
              });
              this.toast('¡Código QR listo! Escanéalo en WhatsApp.', 'verified');
              this.renderMainView();
              return;
            }
          }
        } catch (e) {}
        if (attempts >= 10) clearInterval(poll);
      }, 1500);
    },

    requestWhatsAppPairingCode() {
      const phoneInput = document.getElementById('waPairPhoneInput');
      const phone = phoneInput ? phoneInput.value.replace(/[^0-9]/g, '') : '';
      if (!phone || phone.length < 8) {
        this.toast('Ingresa tu número con código de país (ej. 584245323796)', 'warning');
        return;
      }
      this.toast('Solicitando código de 8 dígitos a WhatsApp...', 'hourglass_top');

      // 1. Trigger via Firebase Realtime Database
      window.cashewSync.saveBotConfig({
        requestPairingPhone: phone,
        whatsappPairingPhone: phone,
        whatsappPairingCode: 'SOLICITANDO...'
      }, 'Solicitud código de vinculación WhatsApp');

      this.renderMainView();

      // 2. Direct call: try local bot bridge first, then Render cloud server
      const tryPair = async (url) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 6000);
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone }),
            signal: controller.signal
          });
          clearTimeout(timer);
          if (r.ok) {
            const data = await r.json();
            if (data && data.code) {
              window.cashewSync.saveBotConfig({
                whatsappPairingCode: data.code,
                requestPairingPhone: null
              });
              this.toast(`¡Código generado: ${data.code}!`, 'verified');
              this.renderMainView();
              return true;
            }
          }
        } catch (e) {}
        return false;
      };

      tryPair('http://localhost:3000/api/whatsapp/pair').then(ok => {
        if (!ok) {
          tryPair('https://doomlater-bot.onrender.com/api/whatsapp/pair');
        }
      });

      // 3. Poll Firebase for 20 seconds in case backend watcher handled it
      let checkAttempts = 0;
      const pollTimer = setInterval(() => {
        checkAttempts++;
        const currentCfg = this.getBotConfig();
        const code = currentCfg.whatsappPairingCode;
        if (code && code !== 'SOLICITANDO...') {
          clearInterval(pollTimer);
          this.toast(`¡Código recibido: ${code}!`, 'verified');
          this.renderMainView();
        } else if (checkAttempts >= 15) {
          clearInterval(pollTimer);
        }
      }, 1500);
    },

    copyWhatsAppPairingCode(code) {
      if (!code) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code);
        this.toast(`Código ${code} copiado al portapapeles`, 'content_copy');
      } else {
        this.toast(`Código: ${code}`, 'content_copy');
      }
    },

    toggleChannelConnection(channel, subKey = null) {
      const cfg = this.getBotConfig();
      if (channel === 'whatsapp') {
        const next = !cfg.whatsappConnected;
        window.cashewSync.saveBotConfig({ whatsappConnected: next }, next ? 'WhatsApp conectado' : 'WhatsApp desconectado');
        this.toast(next ? 'WhatsApp conectado exitosamente' : 'WhatsApp desconectado', 'verified');
      } else if (channel === 'instagram') {
        const next = !cfg.instagramConnected;
        window.cashewSync.saveBotConfig({ instagramConnected: next }, next ? 'Instagram conectado' : 'Instagram desconectado');
        this.toast(next ? 'Instagram conectado exitosamente' : 'Instagram desconectado', 'verified');
      } else if (channel === 'messenger' && subKey) {
        const next = !cfg[subKey];
        const updates = {};
        updates[subKey] = next;
        window.cashewSync.saveBotConfig(updates, next ? 'Messenger conectado' : 'Messenger desconectado');
        this.toast(next ? 'Messenger conectado para ' + (subKey.includes('Doom1') ? 'doom1' : 'doom2') : 'Messenger desconectado', 'verified');
      }
      this.renderMainView();
    },

    buildSettingsPage() {
      const isLive = window.cashewSync.status === 'live';
      const partner = this.getPartnerProfile();

      return `
        <header class="cashew-greeting-header">
          <div>
            <div class="greeting-small">Compatibilidad 100% con Cashew Original, Estética Material You y Nube</div>
            <h1 class="greeting-username">Más y Copias de Seguridad</h1>
          </div>
          <button class="btn-cashew btn-danger" onclick="CashewApp.logout()">
            <span class="material-symbols-rounded">logout</span> Cambiar Perfil / Salir
          </button>
        </header>

        <!-- Quick Navigation Shortcuts (Especially handy on Mobile "Más" tab!) -->
        <section class="kpi-grid-4" style="margin-bottom:20px;">
          <button type="button" class="kpi-cashew-card" style="text-align:left;" onclick="CashewApp.navigate('obligations')">
            <div class="kpi-top"><span>Próximos, Vencidos y Deudas</span><span class="material-symbols-rounded" style="color:var(--cashew-upcoming);">event_repeat</span></div>
            <div style="font-weight:800; font-size:15px;">Pagos y Préstamos →</div>
          </button>
          <button type="button" class="kpi-cashew-card" style="text-align:left;" onclick="CashewApp.navigate('analytics')">
            <div class="kpi-top"><span>Mapa de Calor y Gráficos</span><span class="material-symbols-rounded" style="color:var(--cashew-income);">donut_large</span></div>
            <div style="font-weight:800; font-size:15px;">Estadísticas Cashew →</div>
          </button>
          <button type="button" class="kpi-cashew-card" style="text-align:left;" onclick="CashewApp.navigate('accounts')">
            <div class="kpi-top"><span>Cuentas, Colores y Monedas</span><span class="material-symbols-rounded" style="color:var(--primary);">account_balance_wallet</span></div>
            <div style="font-weight:800; font-size:15px;">Gestionar Cuentas →</div>
          </button>
          <button type="button" class="kpi-cashew-card" style="text-align:left;" onclick="CashewApp.navigate('bot')">
            <div class="kpi-top"><span>Asistente Automatizado</span><span class="material-symbols-rounded" style="color:var(--cashew-overdue);">smart_toy</span></div>
            <div style="font-weight:800; font-size:15px;">Bot (Próximamente) →</div>
          </button>
        </section>

        <div class="cashew-home-grid">
          <div class="cashew-col">
            <!-- Bidirectional Original Cashew Backup (.sql SQLite3 Schema46 & .csv) -->
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div>
                  <div class="cashew-card-title">
                    <span class="material-symbols-rounded" style="color:var(--cashew-income);">database</span>
                    Compatibilidad Oficial con Cashew Original (.SQL y .CSV)
                  </div>
                  <div class="cashew-card-subtitle">
                    Importa tu copia original de Cashew o exporta una base SQLite idéntica para abrirla en la app oficial de Cashew sin perder datos jamás
                  </div>
                </div>
              </div>

              <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:14px;">
                <button class="btn-cashew btn-primary" style="justify-content:flex-start; padding:13px 16px;"
                        onclick="CashewApp.handleExportOriginalCashewSQL()">
                  <span class="material-symbols-rounded">download</span>
                  Exportar Copia para Cashew Original (.sql SQLite v46)
                </button>

                <label class="btn-cashew btn-tonal" style="justify-content:flex-start; padding:13px 16px; cursor:pointer;">
                  <span class="material-symbols-rounded">upload_file</span>
                  Importar Copia Original de Cashew (.sql / .db / .csv / .json)
                  <input type="file" accept=".sql,.db,.sqlite,.csv,.json" style="display:none;"
                         onchange="CashewApp.handleImportAnyCashewFile(event)" />
                </label>

                <div style="display:flex; flex-wrap:wrap; gap:8px;">
                  <button class="btn-cashew btn-surface btn-sm" style="flex:1;"
                          onclick="CashewApp.handleExportOriginalCashewCSV()">
                    <span class="material-symbols-rounded" style="font-size:17px;">table_chart</span>
                    Exportar CSV Cashew
                  </button>
                  <button class="btn-cashew btn-surface btn-sm" style="flex:1;"
                          onclick="CashewApp.exportBackupJSON()">
                    <span class="material-symbols-rounded" style="font-size:17px;">inventory_2</span>
                    Respaldo Total + Stock & Chat (.JSON)
                  </button>
                  <button class="btn-cashew btn-surface btn-sm" style="flex:1;"
                          onclick="CashewApp.exportStockCSV()">
                    <span class="material-symbols-rounded" style="font-size:17px;">list_alt</span>
                    Stock (.CSV)
                  </button>
                </div>
              </div>

              <div style="padding-top:12px; border-top:1px solid var(--divider); display:flex; align-items:center; justify-content:space-between; gap:12px;">
                <div style="font-size:12px; color:var(--text-muted);">
                  ¿Deseas reiniciar transacciones y productos de demostración en blanco conservando perfiles y chat?
                </div>
                <button class="btn-cashew btn-danger btn-sm" onclick="CashewApp.resetCleanWorkspace()">
                  Reiniciar en Blanco
                </button>
              </div>
            </div>

            <!-- Apariencia Material You -->
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div class="cashew-card-title">
                  <span class="material-symbols-rounded" style="color:var(--primary);">palette</span>
                  Estética Material You (Cashew)
                </div>
              </div>

              <div class="form-group">
                <label class="form-label">Modo de Tema</label>
                <div class="segmented-pills">
                  ${[
                    { id: 'dark', label: 'Oscuro Pastel', icon: 'dark_mode' },
                    { id: 'amoled', label: 'Negro AMOLED', icon: 'contrast' },
                    { id: 'light', label: 'Claro Pastel', icon: 'light_mode' }
                  ].map(m => `
                    <button class="seg-pill ${this.prefs.themeMode === m.id ? 'active' : ''}"
                            onclick="CashewApp.savePrefs({ themeMode: '${m.id}' })">
                      <span class="material-symbols-rounded" style="font-size:17px;">${m.icon}</span>
                      ${m.label}
                    </button>
                  `).join('')}
                </div>
              </div>

              <div class="form-group" style="margin-top:14px;">
                <label class="form-label">Color Dinámico Principal</label>
                <div class="picker-grid" style="align-items:center;">
                  ${window.CASHEW_ACCENT_SWATCHES.map(sw => `
                    <button class="color-pick-btn ${this.prefs.accentHex.toLowerCase() === sw.hex.toLowerCase() ? 'active' : ''}"
                            style="background:${sw.hex};"
                            title="${sw.name}"
                            onclick="CashewApp.savePrefs({ accentHex: '${sw.hex}' })"></button>
                  `).join('')}
                  <input type="color" value="${this.prefs.accentHex}"
                         style="width:34px;height:34px;border:none;border-radius:10px;background:transparent;cursor:pointer;"
                         onchange="CashewApp.savePrefs({ accentHex: this.value })" />
                </div>
              </div>
            </div>
          </div>

          <div class="cashew-col">
            <!-- Monedas Oficiales GitHub & Perfil Shortcut -->
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div>
                  <div class="cashew-card-title">
                    <span class="material-symbols-rounded" style="color:var(--primary);">currency_exchange</span>
                    Moneda Principal y Tasas Oficiales GitHub
                  </div>
                  <div class="cashew-card-subtitle">Conectado al repositorio oficial de tasas de Cashew</div>
                </div>
                <button class="btn-cashew btn-tonal btn-sm" onclick="CashewApp.openCurrencyRatesModal()">
                  Abrir Monedas
                </button>
              </div>

              <div style="display:flex; align-items:center; justify-content:space-between; background:var(--bg-elevated); padding:13px 16px; border-radius:16px; margin-bottom:12px;">
                <div>
                  <div style="font-size:12px; color:var(--text-muted); font-weight:700;">Moneda Principal Activa</div>
                  <div style="font-size:20px; font-weight:800;">${this.escapeHtml(this.primaryCurrency)} (${this.escapeHtml(this.primarySymbol)})</div>
                </div>
                <button class="btn-cashew btn-primary btn-sm" onclick="CashewApp.openCurrencyRatesModal()">
                  Cambiar / Ver Tasas
                </button>
              </div>

              <button class="btn-cashew btn-surface" style="width:100%;" onclick="CashewApp.navigate('profile')">
                <span class="material-symbols-rounded">manage_accounts</span>
                Cambiar Usuario / Clave o Abrir Chat con ${this.escapeHtml(partner.displayName || partner.username)}
              </button>
            </div>

            <!-- Estado de Nube Privada Integrada (Sin pedir enlaces nunca!) -->
            <div class="cashew-card">
              <div class="cashew-card-header">
                <div>
                  <div class="cashew-card-title">
                    <span class="material-symbols-rounded" style="color:${isLive ? 'var(--cashew-income)' : 'var(--primary)'};">cloud_done</span>
                    Base de Datos Privada Integrada
                  </div>
                  <div class="cashew-card-subtitle">
                    ${isLive
                      ? `Sincronización en vivo por WebSockets • Revisión #${this.st.rev || 1}`
                      : 'Reconectando automáticamente a la nube privada...'}
                  </div>
                </div>
                <button class="btn-cashew btn-surface btn-sm" onclick="CashewApp.onManualSyncClick()">
                  <span class="material-symbols-rounded" style="font-size:16px;">sync</span>
                  Refrescar
                </button>
              </div>

              <div style="background:var(--cashew-income-bg); color:var(--cashew-income); border-radius:15px; padding:12px 15px; font-size:13px; font-weight:700; display:flex; align-items:center; gap:9px; margin-bottom:12px;">
                <span class="material-symbols-rounded">verified</span>
                Conexión integrada directamente en el código para ambos perfiles (Finanzas, Stock y Chat protegidos).
              </div>

              <div style="background:var(--bg-input); border-radius:14px; padding:12px; max-height:150px; overflow-y:auto; font-family:var(--font-mono); font-size:11.5px; color:var(--text-muted);">
                ${window.cashewSync.syncLogs.length === 0
                  ? '<div>Nube activa y sincronizada en tiempo real.</div>'
                  : window.cashewSync.syncLogs.map(l => `<div>${this.escapeHtml(l)}</div>`).join('')}
              </div>
            </div>
          </div>
        </div>
      `;
    },

    /* ======================================================================
       MODAL INFRASTRUCTURE & FLOATING QUICK CHAT DRAWER
       ====================================================================== */
    openModalHTML(innerHtml, wide = false, onCloseCb = null) {
      this.closeModal();
      this._modalCloseCb = onCloseCb;
      const wrap = document.createElement('div');
      wrap.id = 'cashewModalBackdrop';
      wrap.className = 'modal-backdrop';
      wrap.addEventListener('click', (e) => {
        if (e.target === wrap) this.closeModal();
      });
      wrap.innerHTML = `
        <div class="modal-sheet ${wide ? 'wide' : ''}">
          <div class="sheet-handle"></div>
          ${innerHtml}
        </div>
      `;
      document.body.appendChild(wrap);
    },

    closeModal() {
      this._quickChatOpen = false;
      if (typeof this._modalCloseCb === 'function') {
        const cb = this._modalCloseCb;
        this._modalCloseCb = null;
        try { cb(); } catch (e) {}
      }
      const existing = document.getElementById('cashewModalBackdrop');
      if (existing) existing.remove();
    },

    openQuickChatModal() {
      const partner = this.getPartnerProfile();
      const partnerOnline = partner ? window.cashewSync.isProfileOnline(partner.id) : false;
      this.markChatAsRead();

      this.openModalHTML(`
        <div class="modal-head" style="margin-bottom:10px;">
          <div style="display:flex; align-items:center; gap:10px;">
            ${this.getProfileAvatarHTML(partner, 38)}
            <div>
              <h2 class="modal-title" style="font-size:18px;">Chat con ${this.escapeHtml(partner.displayName || partner.username)}</h2>
              <div style="font-size:11.5px; color:var(--text-muted);">
                ${partnerOnline ? '🟢 Conectado en tiempo real' : '⚪ Offline (recibirá tus mensajes al entrar)'}
              </div>
            </div>
          </div>
          <div style="display:flex; gap:6px;">
            <button class="btn-cashew btn-surface btn-sm" onclick="CashewApp.closeModal(); CashewApp.navigate('profile');">
              Perfil
            </button>
            <button class="icon-btn" onclick="CashewApp.closeModal()">
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
        </div>

        <div id="quickChatStream" class="chat-messages-stream" style="background:var(--bg-input); border-radius:18px; height:340px; max-height:54vh; margin-bottom:12px;">
          ${this.renderChatMessagesHTML()}
        </div>

        ${this.renderChatComposerHTML('quickChatInput', 'quickChatStream', 'Escribe un mensaje o envía una foto...', 'CashewApp.refreshQuickChatStreamIfOpen();', 'style="display:flex; gap:8px; align-items:center;"')}
      `);

      this._quickChatOpen = true;
      this.scrollChatToBottom('quickChatStream');
      setTimeout(() => {
        const inp = document.getElementById('quickChatInput');
        if (inp) inp.focus();
      }, 40);
    },

    refreshQuickChatStreamIfOpen() {
      const stream = document.getElementById('quickChatStream');
      if (stream) {
        stream.innerHTML = this.renderChatMessagesHTML();
        this.scrollChatToBottom('quickChatStream');
      }
    },

    /* ======================================================================
       HEATMAP DAY TRANSACTIONS BOTTOM SHEET
       ====================================================================== */
    openDayTransactionsModal(dateISO) {
      const txs = this.activeList('transactions')
        .filter(t => t.date === dateISO)
        .sort((a, b) => (b.time || '').localeCompare(a.time || ''));

      let pretty = dateISO;
      try {
        pretty = new Date(dateISO + 'T12:00:00').toLocaleDateString('es-ES', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric'
        });
      } catch (e) {}

      this.openModalHTML(`
        <div class="modal-head">
          <div>
            <div style="font-size:12px; color:var(--text-muted); font-weight:700;">Movimientos del Día</div>
            <h2 class="modal-title" style="text-transform:capitalize;">${this.escapeHtml(pretty)}</h2>
          </div>
          <button class="icon-btn" onclick="CashewApp.closeModal()">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>

        <div style="max-height:55vh; overflow-y:auto; margin-bottom:14px;">
          ${this.renderTransactionsGroupedHTML(txs)}
        </div>

        <button type="button" class="btn-cashew btn-primary" style="width:100%; padding:13px;"
                onclick="CashewApp.openTransactionModal(null, '${this.escapeHtml(dateISO)}')">
          <span class="material-symbols-rounded">add</span>
          Agregar Transacción en ${this.escapeHtml(dateISO)}
        </button>
      `, true);
    },

    /* ======================================================================
       MODALS: CASHEW TRANSACTION SHEET (+ NUMPAD, EXACT HOUR & SPECIAL TYPES)
       ====================================================================== */
    evalMathExpr(raw) {
      const cleaned = String(raw || '').replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/').replace(/[^0-9.+\-*/() ]/g, '');
      if (!cleaned.trim()) return 0;
      try {
        const val = Function(`"use strict"; return (${cleaned});`)();
        return Number.isFinite(val) ? Math.round(Math.abs(val) * 100) / 100 : 0;
      } catch (e) {
        return parseFloat(cleaned) || 0;
      }
    },

    openTransactionModal(editId = null, presetDate = null) {
      const existing = editId ? this.activeList('transactions').find(t => t.id === editId) : null;
      const wallets = this.activeList('wallets');
      const categories = this.activeList('categories');
      const defaultWalletId = existing
        ? existing.walletId
        : (this.selectedHomeWalletId !== 'all' ? this.selectedHomeWalletId : (wallets[0] && wallets[0].id));

      this._txDraft = {
        id: existing ? existing.id : null,
        type: existing ? existing.type : 'expense',
        amountExpr: existing ? String(existing.amount) : '',
        title: existing ? existing.title : '',
        categoryId: existing ? existing.categoryId : 'c_insumos',
        walletId: defaultWalletId || '',
        toWalletId: existing && existing.toWalletId ? existing.toWalletId : (wallets[1] ? wallets[1].id : (wallets[0] ? wallets[0].id : '')),
        date: existing ? existing.date : (presetDate || todayLocalISO()),
        time: existing && existing.time ? existing.time : nowHHMM(),
        scheduleKind: 'normal', // normal | upcoming | subscription | credit | debt
        person: '',
        note: existing ? (existing.note || '') : ''
      };

      this.renderTransactionModalContent(categories, wallets);
    },

    renderTransactionModalContent(categories, wallets) {
      const d = this._txDraft;
      const filteredCats = categories.filter(c => String(c.id) !== '0' && (c.type === 'both' || c.type === d.type));
      if (d.type !== 'transfer' && String(d.categoryId) !== '0' && !filteredCats.some(c => c.id === d.categoryId) && filteredCats[0]) {
        d.categoryId = filteredCats[0].id;
      }

      const activeWallet = wallets.find(w => w.id === d.walletId) || wallets[0];
      const wSym = activeWallet ? window.cashewCurrency.getSymbol(activeWallet.currency) : this.primarySymbol;
      const evaluated = this.evalMathExpr(d.amountExpr);

      this.openModalHTML(`
        <div class="modal-head">
          <h2 class="modal-title">${d.id ? 'Editar Transacción' : 'Nueva Transacción'}</h2>
          <div style="display:flex; gap:8px;">
            ${d.id ? `
              <button class="btn-cashew btn-danger btn-sm" onclick="CashewApp.deleteTransaction('${d.id}')" title="Eliminar transacción">
                <span class="material-symbols-rounded" style="font-size:17px;">delete</span>
              </button>
            ` : ''}
            <button class="icon-btn" onclick="CashewApp.closeModal()">
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
        </div>

        ${(d.id && wallets.length > 1) ? `
          <!-- Quick 1-Touch Account Switcher (moves tx immediately with 1 click!) -->
          <div style="background:var(--bg-elevated); border:1.5px solid var(--primary); border-radius:18px; padding:12px 14px; margin-bottom:14px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; flex-wrap:wrap; gap:4px;">
              <span style="font-size:11.5px; font-weight:800; color:var(--primary); text-transform:uppercase; letter-spacing:0.04em;">
                ⇄ Mover a otra cuenta con 1 toque
              </span>
              <span style="font-size:12px; color:var(--text-muted);">
                Cuenta actual: <strong style="color:var(--text-main);">${this.escapeHtml(activeWallet ? activeWallet.name : 'Cuenta')}</strong>
              </span>
            </div>
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">
              Toca una cuenta para pasarla de inmediato y recalcular balances:
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:8px;">
              ${wallets.filter(w => w.id !== d.walletId).map(w => `
                <button type="button" class="btn-cashew btn-tonal btn-sm"
                        style="padding:8px 13px; font-weight:700; font-size:13px;"
                        onclick="CashewApp.moveTransactionToWallet('${d.id}', '${w.id}')">
                  <span class="chip-mini-dot" style="background:${w.color || '#5f85c2'}; width:10px; height:10px; border-radius:50%; display:inline-block; margin-right:4px;"></span>
                  Mover a ${this.escapeHtml(w.name)}
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <!-- Type Sliding Pill Selector -->
        <div class="segmented-pills" style="margin-bottom:12px; justify-content:center;">
          <button type="button" class="seg-pill ${d.type === 'expense' ? 'active' : ''}" onclick="CashewApp.setTxDraftType('expense')">
            <span class="material-symbols-rounded" style="font-size:17px;">north_east</span> Gasto
          </button>
          <button type="button" class="seg-pill ${d.type === 'income' ? 'active' : ''}" onclick="CashewApp.setTxDraftType('income')">
            <span class="material-symbols-rounded" style="font-size:17px;">south_west</span> Ingreso
          </button>
          <button type="button" class="seg-pill ${d.type === 'transfer' ? 'active' : ''}" onclick="CashewApp.setTxDraftType('transfer')">
            <span class="material-symbols-rounded" style="font-size:17px;">swap_horiz</span> Transferir
          </button>
        </div>

        <!-- Cashew Signature Amount & Expression Display -->
        <div class="cashew-amount-box">
          <div id="txExprPreview" class="amount-expr-preview">
            ${/[+\-*/×÷]/.test(d.amountExpr) ? `${this.escapeHtml(d.amountExpr)} = ${this.escapeHtml(wSym)}${evaluated.toFixed(2)}` : 'Calculadora integrada (+ − × ÷)'}
          </div>
          <div class="amount-big-input-wrap">
            <span id="txBigAmountSymbol" class="amount-big-symbol" style="color:${d.type === 'income' ? 'var(--cashew-income)' : d.type === 'expense' ? 'var(--cashew-expense)' : 'var(--cashew-upcoming)'};">${this.escapeHtml(wSym)}</span>
            <input id="txAmountInput" class="amount-big-input" type="text" inputmode="decimal"
                   placeholder="0.00"
                   value="${this.escapeHtml(d.amountExpr)}"
                   oninput="CashewApp.onTxAmountType(this.value)" />
          </div>
        </div>

        <!-- Cashew Tactile Calculator Numpad -->
        <div class="cashew-numpad">
          ${['7','8','9','÷','4','5','6','×','1','2','3','-','.','0','⌫','+'].map(k => {
            const isOp = ['÷','×','-','+','⌫'].includes(k);
            return `<button type="button" class="numpad-key ${isOp ? 'op' : ''}" onclick="CashewApp.tapNumpad('${k}')">${k}</button>`;
          }).join('')}
        </div>

        ${d.type !== 'transfer' ? `
          <div class="form-group">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <label class="form-label">Categoría (Íconos Oficiales Cashew)</label>
              <button type="button" style="font-size:12px; font-weight:800; color:var(--primary);"
                      onclick="CashewApp.openCategoryModal()">+ Nueva Categoría</button>
            </div>
            <div class="chips-scroll-row">
              ${filteredCats.map(c => `
                <button type="button" class="select-chip ${d.categoryId === c.id ? 'active' : ''}"
                        onclick="CashewApp.syncTxFormInputs(); CashewApp._txDraft.categoryId='${c.id}'; CashewApp.refreshTxModal();">
                  <span class="chip-mini-dot" style="background:${c.color || '#5f85c2'};">
                    ${window.renderCashewIconHTML(c, 15)}
                  </span>
                  ${this.escapeHtml(c.name)}
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <div class="form-group">
          <label class="form-label">${d.type === 'transfer' ? 'Desde la Cuenta' : 'Cuenta / Billetera Asignada'}</label>
          <select id="txWalletSelect" class="cashew-select" onchange="CashewApp.onTxWalletSelectChange(this.value)" style="margin-bottom:8px;">
            ${wallets.map(w => `
              <option value="${w.id}" ${d.walletId === w.id ? 'selected' : ''}>
                ${this.escapeHtml(w.name)} (${this.escapeHtml(w.currency)}) — Saldo: ${this.fmtWalletAmount(this.getWalletBalance(w.id), w)}
              </option>
            `).join('')}
          </select>
          <div class="chips-scroll-row">
            ${wallets.map(w => `
              <button type="button" class="select-chip w-tx-chip ${d.walletId === w.id ? 'active' : ''}"
                      data-wid="${w.id}"
                      onclick="CashewApp.setTxWalletChip('${w.id}')">
                <span class="chip-mini-dot" style="background:${w.color || '#5f85c2'};">
                  ${window.renderCashewIconHTML(w, 15)}
                </span>
                ${this.escapeHtml(w.name)} (${this.escapeHtml(w.currency)})
              </button>
            `).join('')}
          </div>
        </div>

        ${d.type === 'transfer' ? `
          <div class="form-group">
            <label class="form-label">Hacia la Cuenta</label>
            <select id="txToWalletSelect" class="cashew-select" onchange="CashewApp.onTxToWalletSelectChange(this.value)" style="margin-bottom:8px;">
              ${wallets.map(w => `
                <option value="${w.id}" ${d.toWalletId === w.id ? 'selected' : ''}>
                  ${this.escapeHtml(w.name)} (${this.escapeHtml(w.currency)}) — Saldo: ${this.fmtWalletAmount(this.getWalletBalance(w.id), w)}
                </option>
              `).join('')}
            </select>
            <div class="chips-scroll-row">
              ${wallets.map(w => `
                <button type="button" class="select-chip w-txto-chip ${d.toWalletId === w.id ? 'active' : ''}"
                        data-towid="${w.id}"
                        onclick="CashewApp.setTxToWalletChip('${w.id}')">
                  <span class="chip-mini-dot" style="background:${w.color || '#5f85c2'};">
                    ${window.renderCashewIconHTML(w, 15)}
                  </span>
                  ${this.escapeHtml(w.name)} (${this.escapeHtml(w.currency)})
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <div class="form-grid">
          <div class="form-group full">
            <label class="form-label">Título / Concepto</label>
            <input id="txTitleInput" class="cashew-input" placeholder="Ej: Reparación DualSense / Compra insumos..." value="${this.escapeHtml(d.title)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Fecha</label>
            <input id="txDateInput" type="date" class="cashew-input" value="${this.escapeHtml(d.date)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Hora Exacta</label>
            <input id="txTimeInput" type="time" class="cashew-input" value="${this.escapeHtml(d.time)}" />
          </div>

          ${!d.id && d.type !== 'transfer' ? `
            <div class="form-group full">
              <label class="form-label">Tipo de Movimiento Cashew</label>
              <select id="txScheduleInput" class="cashew-select" onchange="CashewApp.syncTxFormInputs();">
                <option value="normal" ${d.scheduleKind === 'normal' ? 'selected' : ''}>Normal (Pagado / Efectuado ahora)</option>
                <option value="upcoming" ${d.scheduleKind === 'upcoming' ? 'selected' : ''}>Pago Próximamente (Programar para cobrar/pagar luego)</option>
                <option value="subscription" ${d.scheduleKind === 'subscription' ? 'selected' : ''}>Suscripción Mensual Recurrente</option>
                <option value="credit" ${d.scheduleKind === 'credit' ? 'selected' : ''}>Prestado / Crédito (Nos deben)</option>
                <option value="debt" ${d.scheduleKind === 'debt' ? 'selected' : ''}>Deuda (Debemos pagar)</option>
              </select>
            </div>
          ` : ''}

          <div class="form-group full">
            <label class="form-label">Nota adicional (Opcional)</label>
            <input id="txNoteInput" class="cashew-input" placeholder="Detalles, cliente, referencia, método de pago..." value="${this.escapeHtml(d.note)}" />
          </div>
        </div>

        <button type="button" class="btn-cashew btn-primary" style="width:100%; padding:14px;" onclick="CashewApp.saveTransactionFromModal()">
          <span class="material-symbols-rounded">check</span>
          Guardar Transacción (${this.escapeHtml(this.user)})
        </button>
      `, true);
    },

    syncTxFormInputs() {
      if (!this._txDraft) return;
      const t = document.getElementById('txTitleInput');
      const dt = document.getElementById('txDateInput');
      const tm = document.getElementById('txTimeInput');
      const sc = document.getElementById('txScheduleInput');
      const n = document.getElementById('txNoteInput');
      const a = document.getElementById('txAmountInput');
      const wSel = document.getElementById('txWalletSelect');
      const toWSel = document.getElementById('txToWalletSelect');
      if (t) this._txDraft.title = t.value;
      if (dt) this._txDraft.date = dt.value;
      if (tm) this._txDraft.time = tm.value;
      if (sc) this._txDraft.scheduleKind = sc.value;
      if (n) this._txDraft.note = n.value;
      if (a) this._txDraft.amountExpr = a.value;
      if (wSel) this._txDraft.walletId = wSel.value;
      if (toWSel) this._txDraft.toWalletId = toWSel.value;
    },

    onTxWalletSelectChange(walletId) {
      if (!this._txDraft) return;
      this._txDraft.walletId = walletId;
      document.querySelectorAll('.w-tx-chip').forEach(b => {
        b.classList.toggle('active', b.dataset.wid === walletId);
      });
      const w = this.getWalletById(walletId);
      const sym = w ? window.cashewCurrency.getSymbol(w.currency) : this.primarySymbol;
      const symEl = document.getElementById('txBigAmountSymbol');
      if (symEl) symEl.textContent = sym;
    },

    setTxWalletChip(walletId) {
      if (!this._txDraft) return;
      this._txDraft.walletId = walletId;
      const sel = document.getElementById('txWalletSelect');
      if (sel) sel.value = walletId;
      this.onTxWalletSelectChange(walletId);
    },

    onTxToWalletSelectChange(walletId) {
      if (!this._txDraft) return;
      this._txDraft.toWalletId = walletId;
      document.querySelectorAll('.w-txto-chip').forEach(b => {
        b.classList.toggle('active', b.dataset.towid === walletId);
      });
    },

    setTxToWalletChip(walletId) {
      if (!this._txDraft) return;
      this._txDraft.toWalletId = walletId;
      const sel = document.getElementById('txToWalletSelect');
      if (sel) sel.value = walletId;
      this.onTxToWalletSelectChange(walletId);
    },

    setTxDraftType(type) {
      this.syncTxFormInputs();
      this._txDraft.type = type;
      this.refreshTxModal();
    },

    refreshTxModal() {
      this.renderTransactionModalContent(this.activeList('categories'), this.activeList('wallets'));
    },

    onTxAmountType(val) {
      this._txDraft.amountExpr = val;
      const prev = document.getElementById('txExprPreview');
      if (prev) {
        const res = this.evalMathExpr(val);
        prev.textContent = /[+\-*/×÷]/.test(val) ? `${val} = ${res.toFixed(2)}` : 'Calculadora integrada (+ − × ÷)';
      }
    },

    tapNumpad(key) {
      this.syncTxFormInputs();
      let cur = String(this._txDraft.amountExpr || '');
      if (key === '⌫') cur = cur.slice(0, -1);
      else cur += key;
      this._txDraft.amountExpr = cur;
      const inp = document.getElementById('txAmountInput');
      if (inp) inp.value = cur;
      this.onTxAmountType(cur);
    },

    saveTransactionFromModal() {
      this.syncTxFormInputs();
      const d = this._txDraft;
      const amount = this.evalMathExpr(d.amountExpr);
      if (amount <= 0) {
        this.toast('Ingresa un monto mayor a 0', 'error');
        return;
      }
      if (d.type === 'transfer' && d.walletId === d.toWalletId) {
        this.toast('Elige dos cuentas distintas para transferir', 'error');
        return;
      }

      const cat = this.getCategoryById(d.categoryId);
      const title = d.title.trim() || (d.type === 'transfer' ? 'Transferencia entre cuentas' : cat.name);
      const dateStr = d.date || todayLocalISO();
      const timeStr = d.time || nowHHMM();

      // If user chose Upcoming / Subscription / Credit / Debt on new transaction, save directly to obligations!
      if (!d.id && d.scheduleKind && d.scheduleKind !== 'normal') {
        window.cashewSync.upsertEntity('obligations', {
          title,
          amount,
          kind: d.scheduleKind,
          isIncome: d.type === 'income',
          dueDate: dateStr,
          time: timeStr,
          walletId: d.walletId,
          categoryId: d.categoryId,
          person: '',
          note: d.note.trim(),
          settled: false
        }, `Programado (${d.scheduleKind}): ${title}`);

        this.closeModal();
        this.toast('Guardado en Próximamente, Vencidos y Deudas', 'event_repeat');
        return;
      }

      const existing = d.id ? this.activeList('transactions').find(x => x.id === d.id) : null;

      if (d.id && !this.canUserDirectlyMutate('transactions', d.id)) {
        const proposedTx = {
          ...(existing || {}),
          id: d.id,
          title,
          amount,
          type: d.type,
          categoryId: d.type === 'transfer' ? '0' : d.categoryId,
          walletId: d.walletId,
          toWalletId: d.type === 'transfer' ? d.toWalletId : null,
          date: dateStr,
          time: timeStr,
          paid: true,
          note: d.note.trim()
        };
        this.submitApprovalRequest('transactions', d.id, 'update', proposedTx, `Modificar transacción: ${title} (${this.fmtWalletAmount(amount, this.getWalletById(d.walletId))})`);
        this.closeModal();
        this.toast('Solicitud enviada a tu compañero para confirmar los cambios', 'hourglass_top');
        return;
      }

      window.cashewSync.upsertEntity('transactions', {
        ...(existing || {}),
        id: d.id || undefined,
        title,
        amount,
        type: d.type,
        categoryId: d.type === 'transfer' ? '0' : d.categoryId,
        walletId: d.walletId,
        toWalletId: d.type === 'transfer' ? d.toWalletId : null,
        date: dateStr,
        time: timeStr,
        paid: true,
        note: d.note.trim()
      }, `${title} (${this.fmtWalletAmount(amount, this.getWalletById(d.walletId))})`);

      this.closeModal();
      this.toast('Transacción guardada con fecha y hora exacta', 'check_circle');
    },

    moveTransactionToWallet(txId, targetWalletId) {
      const tx = this.activeList('transactions').find(t => t.id === txId);
      const targetW = this.getWalletById(targetWalletId);
      if (!tx || !targetW) {
        this.toast('Transacción o cuenta no encontrada', 'error');
        return;
      }
      if (tx.walletId === targetWalletId) {
        this.toast(`Esta transacción ya está en la cuenta ${targetW.name}`, 'info');
        return;
      }
      const prevW = this.getWalletById(tx.walletId);
      const prevName = prevW ? prevW.name : 'Cuenta anterior';

      const updatedTx = {
        ...tx,
        walletId: targetWalletId,
        updatedAt: Date.now(),
        updatedBy: this.user || 'socio'
      };

      if (!this.canUserDirectlyMutate('transactions', txId)) {
        this.submitApprovalRequest(
          'transactions',
          txId,
          'update',
          updatedTx,
          `Mover transacción "${tx.title || 'Transacción'}" a "${targetW.name}"`
        );
        this.closeModal();
        this.toast('Solicitud enviada a tu compañero para confirmar el cambio de cuenta', 'hourglass_top');
        return;
      }

      window.cashewSync.upsertEntity(
        'transactions',
        updatedTx,
        `Movió transacción de "${prevName}" a "${targetW.name}"`
      );

      this.closeModal();
      this.renderAll();
      this.toast(`¡Listo! Transacción cambiada a "${targetW.name}"`, 'swap_horiz');
    },

    deleteTransaction(id) {
      const it = this.activeList('transactions').find(x => x.id === id);
      if (!this.canUserDirectlyMutate('transactions', id)) {
        this.submitApprovalRequest('transactions', id, 'delete', null, `Eliminar transacción: ${it ? it.title : id}`);
        this.closeModal();
        this.toast('Solicitud enviada a tu compañero para confirmar la eliminación', 'hourglass_top');
        return;
      }
      window.cashewSync.deleteEntity('transactions', id, 'Transacción eliminada');
      this.closeModal();
      this.toast('Transacción eliminada', 'delete');
    },

    /* ======================================================================
       MODAL: CORRECCIÓN DE BALANCE (EXACT CASHEW BALANCE CORRECTION!)
       ====================================================================== */
    openBalanceCorrectionModal(presetWalletId = null) {
      const wallets = this.activeList('wallets');
      if (wallets.length === 0) {
        this.toast('Crea una cuenta primero', 'error');
        return;
      }
      const wId = presetWalletId || (this.selectedHomeWalletId !== 'all' ? this.selectedHomeWalletId : wallets[0].id);
      const w = this.getWalletById(wId) || wallets[0];
      const curBal = this.getWalletBalance(w.id);

      this.openModalHTML(`
        <div class="modal-head">
          <h2 class="modal-title">Corrección de Balance</h2>
          <button class="icon-btn" onclick="CashewApp.closeModal()">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>

        <p style="font-size:13px; color:var(--text-muted); margin-bottom:14px;">
          Tal cual como en Cashew original: ingresa el saldo real que tienes hoy en la cuenta y se registrará automáticamente una transacción de <strong>Corrección de Balance</strong> por la diferencia exacta.
        </p>

        <div class="form-group">
          <label class="form-label">Selecciona la Cuenta</label>
          <select id="corrWalletSelect" class="cashew-select"
                  onchange="CashewApp.openBalanceCorrectionModal(this.value)">
            ${wallets.map(item => `
              <option value="${item.id}" ${item.id === w.id ? 'selected' : ''}>
                ${this.escapeHtml(item.name)} (Saldo actual: ${this.fmtWalletAmount(this.getWalletBalance(item.id), item)})
              </option>
            `).join('')}
          </select>
        </div>

        <div style="background:var(--bg-elevated); border-radius:16px; padding:13px 16px; display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
          <span style="font-size:13px; color:var(--text-muted); font-weight:700;">Balance actual registrado:</span>
          <strong style="font-size:18px;">${this.fmtWalletAmount(curBal, w)}</strong>
        </div>

        <div class="form-grid">
          <div class="form-group full">
            <label class="form-label">Nuevo Balance Real Exacto (${this.escapeHtml(w.currency)})</label>
            <input id="corrTargetInput" type="number" step="0.01" class="cashew-input"
                   style="font-size:20px; font-weight:800;"
                   value="${curBal.toFixed(2)}"
                   oninput="CashewApp.updateBalanceCorrectionPreview('${w.id}')" />
          </div>
          <div class="form-group full">
            <div id="corrDiffPreview" style="font-size:13.5px; font-weight:800; color:var(--primary); padding:4px 2px;">
              Diferencia a registrar: ${this.fmtWalletAmount(0, w)}
            </div>
          </div>
          <div class="form-group full">
            <label class="form-label">Nota de Corrección (Opcional)</label>
            <input id="corrNoteInput" class="cashew-input" placeholder="Ej: Arqueo de caja / Ajuste de comisión..." />
          </div>
        </div>

        <button type="button" class="btn-cashew btn-primary" style="width:100%; padding:14px;"
                onclick="CashewApp.confirmBalanceCorrection('${w.id}')">
          <span class="material-symbols-rounded">tune</span>
          Aplicar Corrección de Balance
        </button>
      `);
    },

    updateBalanceCorrectionPreview(walletId) {
      const w = this.getWalletById(walletId);
      const curBal = this.getWalletBalance(walletId);
      const target = parseFloat(document.getElementById('corrTargetInput').value);
      const el = document.getElementById('corrDiffPreview');
      if (!el || !w) return;
      if (isNaN(target)) {
        el.textContent = 'Ingresa un monto numérico válido';
        return;
      }
      const diff = Math.round((target - curBal) * 100) / 100;
      const sign = diff > 0 ? '+' : '';
      el.style.color = diff > 0 ? 'var(--cashew-income)' : diff < 0 ? 'var(--cashew-expense)' : 'var(--text-muted)';
      el.textContent = `Ajuste a registrar: ${sign}${this.fmtWalletAmount(diff, w)}`;
    },

    confirmBalanceCorrection(walletId) {
      const w = this.getWalletById(walletId);
      if (!w) return;
      const curBal = this.getWalletBalance(walletId);
      const target = parseFloat(document.getElementById('corrTargetInput').value);
      const extraNote = (document.getElementById('corrNoteInput').value || '').trim();

      if (isNaN(target)) {
        this.toast('Ingresa un saldo válido', 'error');
        return;
      }

      const diff = Math.round((target - curBal) * 100) / 100;
      if (Math.abs(diff) < 0.005) {
        this.toast('El balance ingresado ya es igual al saldo actual', 'info');
        this.closeModal();
        return;
      }

      const isPos = diff > 0;
      const autoNote = `Saldo anterior: ${this.fmtWalletAmount(curBal, w)} → Nuevo: ${this.fmtWalletAmount(target, w)}${extraNote ? ' • ' + extraNote : ''}`;

      window.cashewSync.upsertEntity('transactions', {
        title: 'Corrección de Balance',
        amount: Math.abs(diff),
        type: isPos ? 'income' : 'expense',
        categoryId: '0',
        isBalanceCorrection: true,
        walletId: w.id,
        date: todayLocalISO(),
        time: nowHHMM(),
        paid: true,
        note: autoNote
      }, `Corrección ${w.name}: ${isPos ? '+' : '-'}${this.fmtWalletAmount(Math.abs(diff), w)}`);

      this.closeModal();
      this.toast(`Balance de ${w.name} corregido a ${this.fmtWalletAmount(target, w)}`, 'check_circle');
    },

    /* ======================================================================
       MODAL: CREATE & EDIT CATEGORIES WITH 277 OFFICIAL CASHEW PNG ICONS!
       ====================================================================== */
    openCategoryModal(editId = null) {
      const c = editId ? this.activeList('categories').find(x => x.id === editId) : null;
      const isZero = c && String(c.id) === '0';

      this._catModalState = {
        id: c ? c.id : null,
        name: c ? c.name : '',
        type: c ? c.type : 'expense',
        color: c ? (c.color || '#5f85c2') : '#5f85c2',
        iconTab: (c && c.emoji) ? 'emoji' : (c && !c.iconPng && c.icon ? 'material' : 'png'),
        iconPng: (c && c.iconPng) ? c.iconPng : 'shopping.png',
        emoji: (c && c.emoji) ? c.emoji : '',
        icon: (c && c.icon) ? c.icon : 'category',
        search: '',
        isZero
      };

      this.renderCategoryModalContent();
    },

    syncCategoryModalFields() {
      const st = this._catModalState;
      if (!st) return;
      const n = document.getElementById('catModalName');
      const tp = document.getElementById('catModalType');
      const sr = document.getElementById('catIconSearch');
      if (n) st.name = n.value;
      if (tp) st.type = tp.value;
      if (sr) st.search = sr.value;
    },

    filterOfficialPngIcons(query) {
      const all = window.CASHEW_OFFICIAL_PNG_ICONS || [];
      const q = String(query || '').trim().toLowerCase();
      if (!q) return all;

      const matched = new Set();
      // Match Spanish keywords first!
      for (const [esWord, enPrefixes] of Object.entries(SPANISH_ICON_KEYWORDS)) {
        if (esWord.includes(q) || q.includes(esWord)) {
          for (const pref of enPrefixes) {
            for (const png of all) {
              if (png.toLowerCase().includes(pref)) matched.add(png);
            }
          }
        }
      }
      // Also match English filename substrings
      for (const png of all) {
        if (png.toLowerCase().includes(q)) matched.add(png);
      }
      return Array.from(matched);
    },

    renderCategoryModalContent() {
      const st = this._catModalState;
      if (!st) return;

      const previewEntity = {
        color: st.color,
        iconPng: st.iconTab === 'png' ? st.iconPng : null,
        emoji: st.iconTab === 'emoji' ? st.emoji : '',
        icon: st.iconTab === 'material' ? st.icon : 'category'
      };

      const filteredPngs = this.filterOfficialPngIcons(st.search);

      this.openModalHTML(`
        <div class="modal-head">
          <h2 class="modal-title">${st.id ? 'Editar Categoría Cashew' : 'Crear Categoría Cashew'}</h2>
          <div style="display:flex; gap:8px;">
            ${(st.id && !st.isZero) ? `
              <button class="btn-cashew btn-danger btn-sm" onclick="CashewApp.deleteEntityAndClose('categories','${st.id}','Categoría eliminada')">
                <span class="material-symbols-rounded" style="font-size:17px;">delete</span>
              </button>
            ` : ''}
            <button class="icon-btn" onclick="CashewApp.closeModal()"><span class="material-symbols-rounded">close</span></button>
          </div>
        </div>

        <!-- Live Preview Header -->
        <div style="display:flex; align-items:center; gap:14px; background:var(--bg-elevated); padding:14px 16px; border-radius:18px; margin-bottom:15px;">
          <div class="cat-circle" style="background:${st.color}; width:54px; height:54px; border-radius:18px;">
            ${window.renderCashewIconHTML(previewEntity, 30)}
          </div>
          <div style="flex:1; min-width:0;">
            <div style="font-size:11.5px; color:var(--text-muted); font-weight:700;">Vista Previa estilo Cashew</div>
            <div style="font-size:18px; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${this.escapeHtml(st.name || 'Nombre de Categoría')}
            </div>
          </div>
        </div>

        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">Nombre de la Categoría</label>
            <input id="catModalName" class="cashew-input" placeholder="Ej: Comida, Videojuegos, Envíos..."
                   value="${this.escapeHtml(st.name)}"
                   oninput="CashewApp._catModalState.name=this.value;" />
          </div>

          <div class="form-group">
            <label class="form-label">Tipo de Categoría</label>
            <select id="catModalType" class="cashew-select" ${st.isZero ? 'disabled' : ''}>
              <option value="expense" ${st.type === 'expense' ? 'selected' : ''}>Gasto (-)</option>
              <option value="income" ${st.type === 'income' ? 'selected' : ''}>Ingreso (+)</option>
              <option value="both" ${st.type === 'both' ? 'selected' : ''}>Ambos (Gasto e Ingreso)</option>
            </select>
          </div>
        </div>

        <!-- Color Palette -->
        <div class="form-group">
          <label class="form-label">Color de Categoría</label>
          <div class="picker-grid" style="align-items:center;">
            ${window.CASHEW_PALETTE_COLORS.map(col => `
              <button type="button" class="color-pick-btn ${st.color.toLowerCase() === col.toLowerCase() ? 'active' : ''}"
                      style="background:${col};"
                      onclick="CashewApp.syncCategoryModalFields(); CashewApp._catModalState.color='${col}'; CashewApp.renderCategoryModalContent();"></button>
            `).join('')}
            <input type="color" value="${st.color}"
                   style="width:32px;height:32px;border:none;background:transparent;cursor:pointer;"
                   onchange="CashewApp.syncCategoryModalFields(); CashewApp._catModalState.color=this.value; CashewApp.renderCategoryModalContent();" />
          </div>
        </div>

        <!-- Icon Style Tabs: Official Cashew PNGs | Emojis | Material -->
        <div class="form-group">
          <label class="form-label">Ícono de la Categoría</label>
          <div class="segmented-pills" style="margin-bottom:10px;">
            <button type="button" class="seg-pill ${st.iconTab === 'png' ? 'active' : ''}"
                    onclick="CashewApp.syncCategoryModalFields(); CashewApp._catModalState.iconTab='png'; CashewApp.renderCategoryModalContent();">
              Íconos Cashew (277 Oficiales)
            </button>
            <button type="button" class="seg-pill ${st.iconTab === 'emoji' ? 'active' : ''}"
                    onclick="CashewApp.syncCategoryModalFields(); CashewApp._catModalState.iconTab='emoji'; if(!CashewApp._catModalState.emoji) CashewApp._catModalState.emoji='💸'; CashewApp.renderCategoryModalContent();">
              Emojis
            </button>
            <button type="button" class="seg-pill ${st.iconTab === 'material' ? 'active' : ''}"
                    onclick="CashewApp.syncCategoryModalFields(); CashewApp._catModalState.iconTab='material'; CashewApp.renderCategoryModalContent();">
              Material
            </button>
          </div>

          ${st.iconTab === 'png' ? `
            <div class="search-box" style="margin-bottom:9px; padding:8px 13px;">
              <span class="material-symbols-rounded" style="color:var(--text-muted); font-size:19px;">search</span>
              <input id="catIconSearch" type="text"
                     placeholder="Buscar ícono (ej: comida, banco, juegos, carro, ropa, casa, regalo...)"
                     value="${this.escapeHtml(st.search)}"
                     oninput="CashewApp.onCatIconSearchInput(this.value)" />
            </div>
            <div id="catPngGridContainer" class="icon-picker-scroll">
              ${filteredPngs.map(png => `
                <button type="button" class="icon-pick-tile ${st.iconPng === png ? 'active' : ''}"
                        title="${this.escapeHtml(png.replace('.png', ''))}"
                        onclick="CashewApp.syncCategoryModalFields(); CashewApp._catModalState.iconPng='${png}'; CashewApp.renderCategoryModalContent();">
                  ${window.renderCashewIconHTML({ iconPng: png }, 26)}
                </button>
              `).join('')}
            </div>
          ` : st.iconTab === 'emoji' ? `
            <div style="display:flex; gap:8px; margin-bottom:9px;">
              <input class="cashew-input" style="max-width:130px; text-align:center; font-size:20px;"
                     placeholder="😎"
                     value="${this.escapeHtml(st.emoji)}"
                     oninput="CashewApp.syncCategoryModalFields(); CashewApp._catModalState.emoji=this.value.trim(); CashewApp.renderCategoryModalContent();" />
              <span style="font-size:12px; color:var(--text-muted); align-self:center;">Escribe cualquier emoji o elige uno abajo:</span>
            </div>
            <div class="icon-picker-scroll">
              ${window.CASHEW_EMOJIS.map(em => `
                <button type="button" class="icon-pick-tile ${st.emoji === em ? 'active' : ''}"
                        style="font-size:22px;"
                        onclick="CashewApp.syncCategoryModalFields(); CashewApp._catModalState.emoji='${em}'; CashewApp.renderCategoryModalContent();">
                  ${em}
                </button>
              `).join('')}
            </div>
          ` : `
            <div class="icon-picker-scroll">
              ${window.CASHEW_ICONS.map(ic => `
                <button type="button" class="icon-pick-tile ${st.icon === ic ? 'active' : ''}"
                        onclick="CashewApp.syncCategoryModalFields(); CashewApp._catModalState.icon='${ic}'; CashewApp.renderCategoryModalContent();">
                  <span class="material-symbols-rounded">${ic}</span>
                </button>
              `).join('')}
            </div>
          `}
        </div>

        <button type="button" class="btn-cashew btn-primary" style="width:100%; padding:14px;"
                onclick="CashewApp.saveCategoryFromModal()">
          <span class="material-symbols-rounded">check</span>
          Guardar Categoría
        </button>
      `, true);
    },

    onCatIconSearchInput(val) {
      if (!this._catModalState) return;
      this._catModalState.search = val;
      const grid = document.getElementById('catPngGridContainer');
      if (!grid) return;
      const filtered = this.filterOfficialPngIcons(val);
      grid.innerHTML = filtered.map(png => `
        <button type="button" class="icon-pick-tile ${this._catModalState.iconPng === png ? 'active' : ''}"
                title="${this.escapeHtml(png.replace('.png', ''))}"
                onclick="CashewApp.syncCategoryModalFields(); CashewApp._catModalState.iconPng='${png}'; CashewApp.renderCategoryModalContent();">
          ${window.renderCashewIconHTML({ iconPng: png }, 26)}
        </button>
      `).join('');
    },

    saveCategoryFromModal() {
      this.syncCategoryModalFields();
      const st = this._catModalState;
      if (!st || !st.name.trim()) {
        this.toast('Escribe un nombre para la categoría', 'error');
        return;
      }

      const existing = st.id ? this.activeList('categories').find(x => x.id === st.id) : null;

      if (st.id && !this.canUserDirectlyMutate('categories', st.id)) {
        const proposedCat = {
          ...(existing || {}),
          id: st.id,
          name: st.name.trim(),
          type: st.isZero ? 'both' : st.type,
          color: st.color,
          iconPng: st.iconTab === 'png' ? st.iconPng : null,
          emoji: st.iconTab === 'emoji' ? st.emoji : '',
          icon: st.iconTab === 'material' ? st.icon : (existing && existing.icon ? existing.icon : 'category')
        };
        this.submitApprovalRequest('categories', st.id, 'update', proposedCat, `Modificar categoría: ${st.name.trim()}`);
        this.closeModal();
        this.toast('Solicitud enviada a tu compañero para confirmar los cambios', 'hourglass_top');
        return;
      }

      const saved = window.cashewSync.upsertEntity('categories', {
        ...(existing || {}),
        id: st.id || undefined,
        name: st.name.trim(),
        type: st.isZero ? 'both' : st.type,
        color: st.color,
        iconPng: st.iconTab === 'png' ? st.iconPng : null,
        emoji: st.iconTab === 'emoji' ? st.emoji : '',
        icon: st.iconTab === 'material' ? st.icon : (existing && existing.icon ? existing.icon : 'category')
      }, `Categoría: ${st.name.trim()}`);

      this.closeModal();
      this.toast(`Categoría "${saved.name}" guardada y sincronizada`, 'category');
    },

    /* ======================================================================
       MODAL: OFFICIAL CASHEW GITHUB CURRENCY RATES & CUSTOM OVERRIDES
       ====================================================================== */
    openCurrencyRatesModal() {
      const allCurrencies = window.cashewCurrency.getCurrencyList();
      const customOverrides = this.activeList('currencyRatesCustom');
      const customMap = window.cashewCurrency.getCustomOverridesMap();
      const q = (this._currencySearch || '').trim().toLowerCase();

      const filtered = allCurrencies.filter(c =>
        !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
      ).slice(0, 60);

      this.openModalHTML(`
        <div class="modal-head">
          <div>
            <h2 class="modal-title">Monedas y Tasas Oficiales (GitHub Cashew)</h2>
            <div style="font-size:12px; color:var(--text-muted);">
              Fuente oficial: @fawazahmed0/currency-api (${this.escapeHtml(window.cashewCurrency.ratesDate || 'actualizado')})
            </div>
          </div>
          <div style="display:flex; gap:6px;">
            <button class="btn-cashew btn-surface btn-sm"
                    onclick="window.cashewCurrency.fetchOfficialRates().then(() => CashewApp.openCurrencyRatesModal())">
              <span class="material-symbols-rounded" style="font-size:16px;">refresh</span>
              Actualizar
            </button>
            <button class="icon-btn" onclick="CashewApp.closeModal()"><span class="material-symbols-rounded">close</span></button>
          </div>
        </div>

        <!-- Primary Currency Selector -->
        <div class="form-group">
          <label class="form-label">Moneda Principal del Espacio Compartido</label>
          <select class="cashew-select" onchange="CashewApp.setPrimaryCurrencyAndRefresh(this.value)">
            ${allCurrencies.slice(0, 40).map(c => `
              <option value="${c.code}" ${c.code === this.primaryCurrency ? 'selected' : ''}>
                ${this.escapeHtml(c.code)} — ${this.escapeHtml(c.name)} (${this.escapeHtml(c.symbol.trim())})
              </option>
            `).join('')}
          </select>
        </div>

        <!-- Custom Override Box (e.g. Custom VES / COP / ARS Parallel Rate) -->
        <div style="background:var(--bg-elevated); border-radius:16px; padding:13px 15px; margin-bottom:14px;">
          <div style="font-size:12.5px; font-weight:800; margin-bottom:8px;">Fijar Tasa Personalizada (Opcional, sincronizada entre ambos)</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <input id="customRateCode" class="cashew-input" style="width:95px; text-transform:uppercase;" placeholder="VES" />
            <input id="customRateVal" type="number" step="0.0001" min="0.0001" class="cashew-input" style="flex:1; min-width:140px;" placeholder="1 USD = Ej: 45.50" />
            <button type="button" class="btn-cashew btn-tonal btn-sm" onclick="CashewApp.saveCustomCurrencyRate()">
              Guardar Tasa
            </button>
          </div>
          ${customOverrides.length > 0 ? `
            <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:10px;">
              ${customOverrides.map(ov => `
                <span class="status-chip prep" style="gap:6px; padding:4px 10px;">
                  1 USD = ${Number(ov.ratePerUSD)} ${this.escapeHtml(String(ov.code).toUpperCase())}
                  <button type="button" onclick="CashewApp.deleteCustomCurrencyRate('${ov.id}')" style="color:inherit; font-weight:900;">✕</button>
                </span>
              `).join('')}
            </div>
          ` : ''}
        </div>

        <!-- Search & Live GitHub Rates Table -->
        <div class="search-box" style="margin-bottom:10px; padding:8px 13px;">
          <span class="material-symbols-rounded" style="color:var(--text-muted); font-size:19px;">search</span>
          <input type="text" placeholder="Buscar moneda (USD, VES, EUR, COP, MXN, ARS, BRL, BTC...)"
                 value="${this.escapeHtml(this._currencySearch)}"
                 oninput="CashewApp._currencySearch=this.value; CashewApp.renderCurrencyListRows();" />
        </div>

        <div id="currencyRatesListBox" style="max-height:260px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;">
          ${this.buildCurrencyRowsHTML(filtered, customMap)}
        </div>
      `, true);
    },

    buildCurrencyRowsHTML(list, customMap) {
      return list.map(c => {
        const isCustom = Boolean(customMap[c.key]);
        return `
          <div class="tx-row" style="background:var(--bg-input); padding:9px 13px; cursor:pointer;"
               onclick="CashewApp.setPrimaryCurrencyAndRefresh('${c.code}')">
            <div style="font-weight:800; width:56px; color:var(--primary);">${this.escapeHtml(c.code)}</div>
            <div class="tx-info">
              <div style="font-weight:700; font-size:13.5px;">${this.escapeHtml(c.name)}</div>
              <div style="font-size:11px; color:var(--text-muted);">${isCustom ? 'Tasa personalizada activa' : 'Tasa oficial GitHub Cashew'}</div>
            </div>
            <div style="text-align:right; font-family:var(--font-mono); font-size:13px; font-weight:700;">
              1 USD = ${c.ratePerUSD >= 100 ? c.ratePerUSD.toFixed(2) : c.ratePerUSD.toFixed(4)} ${this.escapeHtml(c.code)}
            </div>
          </div>
        `;
      }).join('');
    },

    renderCurrencyListRows() {
      const box = document.getElementById('currencyRatesListBox');
      if (!box) return;
      const q = (this._currencySearch || '').trim().toLowerCase();
      const all = window.cashewCurrency.getCurrencyList();
      const filtered = all.filter(c => !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)).slice(0, 60);
      box.innerHTML = this.buildCurrencyRowsHTML(filtered, window.cashewCurrency.getCustomOverridesMap());
    },

    setPrimaryCurrencyAndRefresh(code) {
      window.cashewSync.setPrimaryCurrency(code);
      this.toast(`Moneda principal cambiada a ${code}`, 'currency_exchange');
      this.openCurrencyRatesModal();
    },

    saveCustomCurrencyRate() {
      const code = (document.getElementById('customRateCode').value || '').trim().toUpperCase();
      const val = parseFloat(document.getElementById('customRateVal').value);
      if (!code || code.length < 2 || isNaN(val) || val <= 0) {
        this.toast('Ingresa el código (ej: VES) y un valor mayor a 0', 'error');
        return;
      }
      const existing = this.activeList('currencyRatesCustom').find(x => String(x.code).toUpperCase() === code);
      window.cashewSync.upsertEntity('currencyRatesCustom', {
        id: existing ? existing.id : `rate_${code.toLowerCase()}`,
        code,
        ratePerUSD: val
      }, `Tasa 1 USD = ${val} ${code}`);
      this.toast(`Tasa 1 USD = ${val} ${code} sincronizada`, 'check_circle');
      this.openCurrencyRatesModal();
    },

    deleteCustomCurrencyRate(id) {
      window.cashewSync.deleteEntity('currencyRatesCustom', id, 'Restauró tasa oficial GitHub');
      this.toast('Restaurada tasa oficial de GitHub', 'restore');
      this.openCurrencyRatesModal();
    },

    /* ======================================================================
       MODALS: WALLETS (CREAR, EDITAR NOMBRE, COLOR, SALDO Y BORRAR CUENTAS)
       ====================================================================== */
    openWalletModal(editId = null) {
      const w = editId ? this.getWalletById(editId) : null;
      const currentBal = w ? this.getWalletBalance(w.id) : 0;
      const currencies = window.cashewCurrency.getCurrencyList().slice(0, 35);
      const selectedPng = (w && w.iconPng) ? w.iconPng : 'wallet.png';
      const selectedColor = (w && w.color) ? w.color : '#5f85c2';
      const walletIcons = [
        'wallet.png', 'bank.png', 'cash-bill-dollar.png', 'crypto.png',
        'credit-card.png', 'piggy-bank.png', 'safe-box.png', 'money-bag.png',
        'coin.png', 'dollar-coin.png', 'euro-coin.png', 'invoice.png',
        'calculator.png', 'charts.png', 'savings.png', 'cutlery.png'
      ];

      this._walletModalState = {
        id: w ? w.id : null,
        name: w ? w.name : '',
        currency: w ? w.currency.toUpperCase() : this.primaryCurrency,
        color: selectedColor,
        iconPng: selectedPng
      };

      this.openModalHTML(`
        <div class="modal-head">
          <h2 class="modal-title">${w ? 'Editar Cuenta' : 'Nueva Cuenta'}</h2>
          <div style="display:flex; gap:8px;">
            ${w ? `
              <button class="btn-cashew btn-tonal btn-sm" onclick="CashewApp.openBalanceCorrectionModal('${w.id}')" title="Corregir saldo real">
                <span class="material-symbols-rounded" style="font-size:16px;">tune</span> Corregir Balance
              </button>
              <button class="btn-cashew btn-danger btn-sm" onclick="CashewApp.confirmDeleteWallet('${w.id}')" title="Eliminar cuenta">
                <span class="material-symbols-rounded" style="font-size:17px;">delete</span>
              </button>
            ` : ''}
            <button class="icon-btn" onclick="CashewApp.closeModal()"><span class="material-symbols-rounded">close</span></button>
          </div>
        </div>

        <!-- Live Visual Preview of Account (stamped with icon and chosen color) -->
        <div style="display:flex; align-items:center; gap:14px; background:var(--bg-elevated); padding:14px 16px; border-radius:18px; margin-bottom:15px;">
          <div id="wPreviewDot" class="wallet-dot-icon" style="background:${selectedColor}; width:54px; height:54px; border-radius:18px;">
            ${window.renderCashewIconHTML({ iconPng: selectedPng }, 30)}
          </div>
          <div style="flex:1; min-width:0;">
            <div style="font-size:11.5px; color:var(--text-muted); font-weight:700;">${w ? 'Cuenta Compartida (Editable)' : 'Nueva Cuenta Compartida'}</div>
            <div id="wPreviewTitle" style="font-size:18px; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${this.escapeHtml(w ? w.name : 'Nombre de Cuenta')}
            </div>
          </div>
        </div>

        <div class="form-grid">
          <div class="form-group full">
            <label class="form-label">Nombre de la Cuenta</label>
            <input id="wName" class="cashew-input" placeholder="Ej: Anthony, Sebastian, Binance, Efectivo..."
                   value="${this.escapeHtml(w ? w.name : '')}"
                   oninput="CashewApp.onWalletModalNameInput(this.value)" />
          </div>

          <div class="form-group">
            <label class="form-label">Moneda Oficial</label>
            <select id="wCurrency" class="cashew-select">
              ${currencies.map(c => `
                <option value="${c.code}" ${(w ? w.currency.toUpperCase() : this.primaryCurrency) === c.code ? 'selected' : ''}>
                  ${this.escapeHtml(c.code)} — ${this.escapeHtml(c.name)}
                </option>
              `).join('')}
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">${w ? 'Balance Actual' : 'Saldo Inicial'}</label>
            <input id="wBalance" type="number" step="0.01" class="cashew-input" value="${w ? currentBal.toFixed(2) : '0'}" />
          </div>

          <div class="form-group full">
            <label class="form-label">Ícono Oficial Cashew</label>
            <div class="picker-grid">
              ${walletIcons.map(png => `
                <button type="button" class="icon-pick-tile w-png-tile ${selectedPng === png ? 'active' : ''}"
                        data-png="${png}"
                        style="width:46px; height:46px;"
                        title="${this.escapeHtml(png.replace('.png',''))}"
                        onclick="CashewApp.setWalletModalIcon('${png}')">
                  ${window.renderCashewIconHTML({ iconPng: png }, 25)}
                </button>
              `).join('')}
            </div>
          </div>

          <div class="form-group full">
            <label class="form-label">Color de la Cuenta</label>
            <div class="picker-grid" style="align-items:center;">
              ${window.CASHEW_PALETTE_COLORS.map(col => `
                <button type="button" class="color-pick-btn w-color-tile ${selectedColor.toLowerCase() === col.toLowerCase() ? 'active' : ''}"
                        data-col="${col}"
                        style="background:${col};"
                        onclick="CashewApp.setWalletModalColor('${col}')"></button>
              `).join('')}
              <input id="wColor" type="color" value="${selectedColor}"
                     style="width:34px; height:34px; border:none; background:transparent; cursor:pointer;"
                     onchange="CashewApp.setWalletModalColor(this.value)" />
            </div>
          </div>
        </div>

        <button type="button" class="btn-cashew btn-primary" style="width:100%; padding:14px; margin-top:8px;" onclick="CashewApp.saveWallet('${w ? w.id : ''}')">
          <span class="material-symbols-rounded">save</span>
          ${w ? 'Guardar Cambios de la Cuenta' : 'Crear Cuenta'}
        </button>

        ${w ? `
          <div style="margin-top:16px; padding-top:12px; border-top:1px solid var(--border-subtle);">
            <button type="button" class="btn-cashew btn-danger" style="width:100%; padding:12px; font-weight:700;"
                    onclick="CashewApp.confirmDeleteWallet('${w.id}')">
              <span class="material-symbols-rounded">delete</span>
              Eliminar esta Cuenta (${this.escapeHtml(w.name)})
            </button>
          </div>
        ` : ''}
      `);
    },

    onWalletModalNameInput(val) {
      if (this._walletModalState) this._walletModalState.name = val;
      const el = document.getElementById('wPreviewTitle');
      if (el) el.textContent = val.trim() || 'Nombre de Cuenta';
    },

    setWalletModalColor(col) {
      if (this._walletModalState) this._walletModalState.color = col;
      const inp = document.getElementById('wColor');
      if (inp) inp.value = col;
      const dot = document.getElementById('wPreviewDot');
      if (dot) dot.style.background = col;
      document.querySelectorAll('.w-color-tile').forEach(b => {
        b.classList.toggle('active', (b.dataset.col || '').toLowerCase() === col.toLowerCase());
      });
    },

    setWalletModalIcon(png) {
      if (this._walletModalState) this._walletModalState.iconPng = png;
      const dot = document.getElementById('wPreviewDot');
      if (dot) dot.innerHTML = window.renderCashewIconHTML({ iconPng: png }, 30);
      document.querySelectorAll('.w-png-tile').forEach(b => {
        b.classList.toggle('active', b.dataset.png === png);
      });
    },

    confirmDeleteWallet(walletId) {
      const w = this.getWalletById(walletId);
      if (!w) return;
      const allActive = this.activeList('wallets');
      if (allActive.length <= 1) {
        this.toast('Debes mantener al menos una cuenta en tus finanzas', 'error');
        return;
      }
      const countTxs = this.activeList('transactions').filter(t => t.walletId === walletId || t.toWalletId === walletId).length;
      const confirmMsg = countTxs > 0
        ? `¿Seguro que deseas eliminar la cuenta "${w.name}"?\nTiene ${countTxs} movimiento(s) asociados que quedarán en el historial.`
        : `¿Seguro que deseas eliminar la cuenta "${w.name}"?`;

      if (!confirm(confirmMsg)) return;

      if (!this.canUserDirectlyMutate('wallets', walletId)) {
        this.submitApprovalRequest('wallets', walletId, 'delete', null, `Eliminar cuenta: ${w.name}`);
        this.closeModal();
        this.toast('Solicitud enviada a tu compañero para confirmar la eliminación de la cuenta', 'hourglass_top');
        return;
      }

      window.cashewSync.deleteEntity('wallets', walletId, `Eliminó cuenta: ${w.name}`);
      if (this.selectedHomeWalletId === walletId) {
        this.selectedHomeWalletId = 'all';
      }
      this.closeModal();
      this.renderAll();
      this.toast(`Cuenta "${w.name}" eliminada correctamente`, 'delete');
    },

    saveWallet(editId) {
      const name = (document.getElementById('wName').value || '').trim();
      const currency = (document.getElementById('wCurrency').value || 'USD').trim().toUpperCase();
      const targetBal = parseFloat(document.getElementById('wBalance').value) || 0;
      const color = (this._walletModalState && this._walletModalState.color) || (document.getElementById('wColor') ? document.getElementById('wColor').value : '#5f85c2');
      const symbol = window.cashewCurrency.getSymbol(currency);
      const iconPng = (this._walletModalState && this._walletModalState.iconPng) || 'wallet.png';

      if (!name) {
        this.toast('Ingresa un nombre para la cuenta', 'error');
        return;
      }

      if (editId) {
        const existing = this.getWalletById(editId);
        if (!existing) return;

        if (!this.canUserDirectlyMutate('wallets', editId)) {
          const proposedWallet = {
            ...existing,
            name,
            currency,
            symbol,
            color,
            iconPng,
            updatedAt: Date.now(),
            updatedBy: this.user || 'socio'
          };
          this.submitApprovalRequest('wallets', editId, 'update', proposedWallet, `Modificar cuenta: ${name}`);
          this.closeModal();
          this.toast('Solicitud enviada a tu compañero para confirmar los cambios de la cuenta', 'hourglass_top');
          return;
        }

        const curBal = this.getWalletBalance(editId);
        const diff = Math.round((targetBal - curBal) * 100) / 100;

        const ops = [
          {
            collection: 'wallets',
            item: {
              ...existing,
              name,
              currency,
              symbol,
              color,
              iconPng,
              updatedAt: Date.now(),
              updatedBy: this.user || 'socio'
            }
          }
        ];

        // Log real Cashew Balance Correction transaction if balance was modified!
        if (Math.abs(diff) >= 0.005) {
          ops.push({
            collection: 'transactions',
            item: {
              title: 'Corrección de Balance',
              amount: Math.abs(diff),
              type: diff > 0 ? 'income' : 'expense',
              categoryId: '0',
              isBalanceCorrection: true,
              walletId: editId,
              date: todayLocalISO(),
              time: nowHHMM(),
              paid: true,
              note: `Ajuste desde edición de cuenta (${this.fmtMoney(curBal, symbol)} → ${this.fmtMoney(targetBal, symbol)})`
            }
          });
        }

        window.cashewSync.batchUpsert(ops, `Cuenta actualizada: ${name}`);
        this.closeModal();
        this.renderAll();
        this.toast(`Cuenta "${name}" guardada y sincronizada`, 'check_circle');
      } else {
        window.cashewSync.upsertEntity('wallets', {
          name,
          currency,
          symbol,
          startingBalance: targetBal,
          color,
          iconPng,
          icon: 'account_balance_wallet'
        }, `Nueva cuenta: ${name}`);
        this.closeModal();
        this.renderAll();
        this.toast(`Cuenta "${name}" creada y sincronizada`, 'check_circle');
      }
    },

    /* STOCK UPLOAD / EDIT, 1-CLICK QUICK SALE & RESTOCK */
    openStockModal(editId = null) {
      const existing = editId ? this.activeList('stockItems').find(s => s.id === editId) : null;
      this._stockDraft = {
        id: existing ? existing.id : null,
        name: existing ? existing.name : '',
        sku: existing ? (existing.sku || '') : '',
        kind: existing ? existing.kind : 'para_vender',
        category: existing ? (existing.category || 'Consolas') : 'Consolas',
        icon: existing ? (existing.icon || 'sports_esports') : 'sports_esports',
        color: existing ? (existing.color || '#5f85c2') : '#5f85c2',
        stock: existing ? existing.stock : 1,
        minStock: existing ? (existing.minStock ?? 1) : 1,
        purchaseCost: existing ? (existing.purchaseCost ?? 0) : '',
        extraCost: existing ? (existing.extraCost ?? 0) : 0,
        extraDetail: existing ? (existing.extraDetail || '') : '',
        salePrice: existing ? (existing.salePrice ?? 0) : '',
        imageUrl: existing ? (existing.imageUrl || '') : '',
        notes: existing ? (existing.notes || '') : ''
      };
      this.renderStockModalContent();
    },

    syncStockFormInputs() {
      const d = this._stockDraft;
      if (!d) return;
      const fields = ['name', 'sku', 'kind', 'category', 'stock', 'minStock', 'purchaseCost', 'extraCost', 'extraDetail', 'salePrice', 'imageUrl', 'notes'];
      for (const f of fields) {
        const el = document.getElementById('stField_' + f);
        if (el) d[f] = el.value;
      }
    },

    renderStockModalContent() {
      const d = this._stockDraft;
      this.openModalHTML(`
        <div class="modal-head">
          <h2 class="modal-title">${d.id ? 'Editar Artículo de Stock' : 'Subir Nuevo Stock / Producto'}</h2>
          <div style="display:flex; gap:8px;">
            ${d.id ? `
              <button class="btn-cashew btn-danger btn-sm" onclick="CashewApp.deleteStockItem('${d.id}')">
                <span class="material-symbols-rounded" style="font-size:17px;">delete</span>
              </button>
            ` : ''}
            <button class="icon-btn" onclick="CashewApp.closeModal()">
              <span class="material-symbols-rounded">close</span>
            </button>
          </div>
        </div>

        <div class="form-grid">
          <div class="form-group full">
            <label class="form-label">Nombre del Producto / Repuesto</label>
            <input id="stField_name" class="cashew-input" placeholder="Ej: PlayStation 5 Slim 1TB / Control Xbox..." value="${this.escapeHtml(d.name)}" />
          </div>

          <div class="form-group">
            <label class="form-label">Estado / Tipo en Inventario</label>
            <select id="stField_kind" class="cashew-select">
              <option value="para_vender" ${d.kind === 'para_vender' ? 'selected' : ''}>Para Vender (Disponible)</option>
              <option value="en_preparacion" ${d.kind === 'en_preparacion' ? 'selected' : ''}>En Preparación / Taller</option>
              <option value="insumo" ${d.kind === 'insumo' ? 'selected' : ''}>Insumo / Repuesto Interno</option>
            </select>
          </div>

          <div class="form-group">
            <label class="form-label">Categoría</label>
            <input id="stField_category" class="cashew-input" list="stockCatSuggestions" placeholder="Consolas, Controles, Juegos..." value="${this.escapeHtml(d.category)}" />
            <datalist id="stockCatSuggestions">
              <option value="Consolas"></option>
              <option value="Controles"></option>
              <option value="Juegos"></option>
              <option value="Accesorios"></option>
              <option value="Repuestos Taller"></option>
            </datalist>
          </div>

          <div class="form-group">
            <label class="form-label">Stock Disponible (Unidades)</label>
            <input id="stField_stock" type="number" min="0" step="1" class="cashew-input" value="${this.escapeHtml(d.stock)}" />
          </div>

          <div class="form-group">
            <label class="form-label">Alerta de Stock Mínimo</label>
            <input id="stField_minStock" type="number" min="0" step="1" class="cashew-input" value="${this.escapeHtml(d.minStock)}" />
          </div>

          <div class="form-group">
            <label class="form-label">Costo de Compra Unitario ($)</label>
            <input id="stField_purchaseCost" type="number" min="0" step="0.01" class="cashew-input" placeholder="0.00" value="${this.escapeHtml(d.purchaseCost)}" />
          </div>

          <div class="form-group">
            <label class="form-label">Inversión Extra / Taller ($)</label>
            <input id="stField_extraCost" type="number" min="0" step="0.01" class="cashew-input" placeholder="0.00" value="${this.escapeHtml(d.extraCost)}" />
          </div>

          <div class="form-group">
            <label class="form-label">Precio de Venta ($)</label>
            <input id="stField_salePrice" type="number" min="0" step="0.01" class="cashew-input" placeholder="0.00" value="${this.escapeHtml(d.salePrice)}" />
          </div>

          <div class="form-group">
            <label class="form-label">Código / SKU (Opcional)</label>
            <input id="stField_sku" class="cashew-input" placeholder="Ej: CON-01" value="${this.escapeHtml(d.sku)}" />
          </div>

          <div class="form-group full">
            <label class="form-label">Detalle de Inversión / Repuestos usados (Opcional)</label>
            <input id="stField_extraDetail" class="cashew-input" placeholder="Ej: Chip + MicroSD 128GB / Par Joysticks Hall Effect" value="${this.escapeHtml(d.extraDetail)}" />
          </div>

          <div class="form-group full">
            <label class="form-label">Foto URL o subir imagen ligera (Opcional)</label>
            <div style="display:flex; gap:8px;">
              <input id="stField_imageUrl" class="cashew-input" placeholder="https://... (o sube foto con el botón)" value="${this.escapeHtml(d.imageUrl)}" />
              <label class="btn-cashew btn-surface" style="cursor:pointer; flex-shrink:0;">
                <span class="material-symbols-rounded">photo_camera</span>
                <input type="file" accept="image/*" style="display:none;" onchange="CashewApp.handleStockImageUpload(event)" />
              </label>
            </div>
          </div>

          <div class="form-group full">
            <label class="form-label">Notas / Estado del Equipo</label>
            <input id="stField_notes" class="cashew-input" placeholder="Caja, accesorios, garantía, ubicación..." value="${this.escapeHtml(d.notes)}" />
          </div>

          <div class="form-group full">
            <label class="form-label">Color de Tarjeta</label>
            <div class="picker-grid">
              ${window.CASHEW_PALETTE_COLORS.slice(0, 15).map(col => `
                <button type="button" class="color-pick-btn ${d.color === col ? 'active' : ''}"
                        style="background:${col};"
                        onclick="CashewApp.syncStockFormInputs(); CashewApp._stockDraft.color='${col}'; CashewApp.renderStockModalContent();"></button>
              `).join('')}
            </div>
          </div>

          <div class="form-group full">
            <label class="form-label">Ícono de Inventario</label>
            <div class="picker-grid">
              ${window.CASHEW_ICONS.slice(0, 18).map(ic => `
                <button type="button" class="icon-pick-btn ${d.icon === ic ? 'active' : ''}"
                        onclick="CashewApp.syncStockFormInputs(); CashewApp._stockDraft.icon='${ic}'; CashewApp.renderStockModalContent();">
                  <span class="material-symbols-rounded">${ic}</span>
                </button>
              `).join('')}
            </div>
          </div>
        </div>

        <button type="button" class="btn-cashew btn-primary" style="width:100%; padding:14px;" onclick="CashewApp.saveStockFromModal()">
          <span class="material-symbols-rounded">cloud_upload</span>
          ${d.id ? 'Guardar Cambios en Tiempo Real' : 'Subir al Inventario Compartido'}
        </button>
      `, true);
    },

    handleStockImageUpload(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      this.syncStockFormInputs();

      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const maxDim = 220;
          let w = img.width;
          let h = img.height;
          if (w > h && w > maxDim) { h = Math.round((h * maxDim) / w); w = maxDim; }
          else if (h > maxDim) { w = Math.round((w * maxDim) / h); h = maxDim; }
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
          this._stockDraft.imageUrl = dataUrl;
          const inp = document.getElementById('stField_imageUrl');
          if (inp) inp.value = dataUrl;
          this.toast('Miniatura optimizada lista', 'image');
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    },

    saveStockFromModal() {
      this.syncStockFormInputs();
      const d = this._stockDraft;
      if (!d.name.trim()) {
        this.toast('Escribe el nombre del producto', 'error');
        return;
      }

      const isNew = !d.id;
      const qty = Math.max(0, parseInt(d.stock, 10) || 0);
      const itemObj = {
        id: d.id || undefined,
        name: d.name.trim(),
        sku: d.sku.trim(),
        kind: d.kind,
        category: d.category.trim() || 'General',
        icon: d.icon,
        color: d.color,
        stock: qty,
        minStock: Math.max(0, parseInt(d.minStock, 10) || 0),
        purchaseCost: Math.max(0, parseFloat(d.purchaseCost) || 0),
        extraCost: Math.max(0, parseFloat(d.extraCost) || 0),
        extraDetail: d.extraDetail.trim(),
        salePrice: Math.max(0, parseFloat(d.salePrice) || 0),
        imageUrl: d.imageUrl.trim(),
        notes: d.notes.trim()
      };

      if (!isNew && !this.canUserDirectlyMutate('stockItems', d.id)) {
        this.submitApprovalRequest('stockItems', d.id, 'update', itemObj, `Modificar producto: ${itemObj.name}`);
        this.closeModal();
        this.toast('Solicitud enviada a tu compañero para confirmar los cambios', 'hourglass_top');
        return;
      }

      const saved = window.cashewSync.upsertEntity(
        'stockItems',
        itemObj,
        `${isNew ? 'Subió stock' : 'Editó stock'}: ${itemObj.name} (${qty} uds)`
      );

      if (isNew) {
        window.cashewSync.upsertEntity('stockMovements', {
          stockId: saved.id,
          itemName: saved.name,
          action: 'ingreso',
          qtyChange: qty,
          newStock: qty,
          unitPrice: saved.salePrice,
          profit: 0,
          note: 'Alta inicial en inventario',
          date: todayLocalISO(),
          time: nowHHMM()
        }, `Alta en kardex: ${saved.name}`);
      }

      this.closeModal();
      this.toast('Stock sincronizado en tiempo real', 'cloud_done');
    },

    deleteStockItem(id) {
      const it = this.activeList('stockItems').find(x => x.id === id);
      if (!this.canUserDirectlyMutate('stockItems', id)) {
        this.submitApprovalRequest('stockItems', id, 'delete', null, `Eliminar producto: ${it ? it.name : id}`);
        this.closeModal();
        this.toast('Solicitud enviada a tu compañero para confirmar la eliminación', 'hourglass_top');
        return;
      }
      window.cashewSync.deleteEntity('stockItems', id, `Eliminó de stock: ${it ? it.name : ''}`);
      this.closeModal();
      this.toast('Artículo eliminado del inventario', 'delete');
    },

    openQuickSaleModal(stockId) {
      const it = this.activeList('stockItems').find(x => x.id === stockId);
      if (!it) return;
      const wallets = this.activeList('wallets');
      const unitCost = (Number(it.purchaseCost) || 0) + (Number(it.extraCost) || 0);

      this.openModalHTML(`
        <div class="modal-head">
          <h2 class="modal-title">Registrar Venta de Stock</h2>
          <button class="icon-btn" onclick="CashewApp.closeModal()">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>

        <div class="tx-row" style="background:var(--bg-elevated); margin-bottom:16px; cursor:default;">
          <div class="cat-circle" style="background:${it.color || '#5f85c2'};">
            <span class="material-symbols-rounded">${it.icon || 'shopping_bag'}</span>
          </div>
          <div class="tx-info">
            <div class="tx-title">${this.escapeHtml(it.name)}</div>
            <div class="tx-sub">Stock disponible: <strong>${it.stock} uds</strong> • Costo base: ${this.fmtMoney(unitCost, '$')}</div>
          </div>
        </div>

        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">Cantidad a Vender</label>
            <input id="saleQtyInput" type="number" min="1" max="${Math.max(1, it.stock)}" value="1" class="cashew-input" />
          </div>
          <div class="form-group">
            <label class="form-label">Precio Venta Unitario ($)</label>
            <input id="salePriceInput" type="number" min="0" step="0.01" value="${it.salePrice}" class="cashew-input" />
          </div>
          <div class="form-group full">
            <label class="form-label">Cuenta donde ingresa el dinero</label>
            <select id="saleWalletInput" class="cashew-select">
              ${wallets.map(w => `<option value="${w.id}">${this.escapeHtml(w.name)} (${this.escapeHtml(w.currency)})</option>`).join('')}
            </select>
          </div>
          <div class="form-group full">
            <label class="form-label">Cliente / Nota de Venta (Opcional)</label>
            <input id="saleNoteInput" class="cashew-input" placeholder="Ej: Cliente tienda / Entrega personal..." />
          </div>
        </div>

        <button class="btn-cashew btn-primary" style="width:100%; padding:14px; background:var(--cashew-income); color:#05210c;"
                onclick="CashewApp.confirmQuickSale('${it.id}')">
          <span class="material-symbols-rounded">point_of_sale</span>
          Confirmar Venta y Sumar a Finanzas
        </button>
      `);
    },

    confirmQuickSale(stockId) {
      const it = this.activeList('stockItems').find(x => x.id === stockId);
      if (!it) return;
      const qty = Math.max(1, parseInt(document.getElementById('saleQtyInput').value, 10) || 1);
      const unitPriceUSD = Math.max(0, parseFloat(document.getElementById('salePriceInput').value) || 0);
      const walletId = document.getElementById('saleWalletInput').value;
      const note = document.getElementById('saleNoteInput').value.trim();

      if (qty > (Number(it.stock) || 0)) {
        this.toast('No hay suficiente stock disponible', 'error');
        return;
      }

      const w = this.getWalletById(walletId);
      const wCur = w ? w.currency : 'USD';
      const newStock = Math.max(0, (Number(it.stock) || 0) - qty);
      const unitCostUSD = (Number(it.purchaseCost) || 0) + (Number(it.extraCost) || 0);
      const totalSaleUSD = qty * unitPriceUSD;
      const totalCostUSD = qty * unitCostUSD;
      const netProfitUSD = totalSaleUSD - totalCostUSD;

      // Convert USD sale amount into destination wallet currency if needed!
      const txAmountInWallet = window.cashewCurrency.convert(totalSaleUSD, 'USD', wCur);
      const costInWallet = window.cashewCurrency.convert(totalCostUSD, 'USD', wCur);

      const dateStr = todayLocalISO();
      const timeStr = nowHHMM();
      const salesCat = this.activeList('categories').find(c => c.id === 'c_ventas' || c.type === 'income') || { id: '0' };

      window.cashewSync.batchUpsert([
        {
          collection: 'stockItems',
          item: { ...it, stock: newStock }
        },
        {
          collection: 'stockMovements',
          item: {
            stockId: it.id,
            itemName: it.name,
            action: 'venta',
            qtyChange: -qty,
            newStock,
            unitPrice: unitPriceUSD,
            profit: netProfitUSD,
            note: note || `Venta de ${qty} ud(s)`,
            date: dateStr,
            time: timeStr
          }
        },
        {
          collection: 'transactions',
          item: {
            title: `Venta (${qty}x) ${it.name}`,
            amount: Math.round(txAmountInWallet * 100) / 100,
            type: 'income',
            categoryId: salesCat.id,
            walletId,
            date: dateStr,
            time: timeStr,
            paid: true,
            stockId: it.id,
            costBasis: Math.round(costInWallet * 100) / 100,
            note: `${note ? note + ' • ' : ''}Ganancia neta: +${this.fmtMoney(netProfitUSD, '$')}`
          }
        }
      ], `Vendió ${qty}x ${it.name} (+${this.fmtMoney(totalSaleUSD, '$')})`);

      this.closeModal();
      this.toast(`¡Venta registrada! Quedan ${newStock} uds en stock`, 'celebration');
    },

    openRestockModal(stockId) {
      const it = this.activeList('stockItems').find(x => x.id === stockId);
      if (!it) return;
      const wallets = this.activeList('wallets');

      this.openModalHTML(`
        <div class="modal-head">
          <h2 class="modal-title">Reabastecer Stock</h2>
          <button class="icon-btn" onclick="CashewApp.closeModal()">
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>

        <p style="font-size:13.5px; color:var(--text-muted); margin-bottom:14px;">
          Artículo: <strong style="color:var(--text-main);">${this.escapeHtml(it.name)}</strong> (Actual: ${it.stock} uds)
        </p>

        <div class="form-grid">
          <div class="form-group">
            <label class="form-label">Unidades que ingresan (+)</label>
            <input id="restockQty" type="number" min="1" value="1" class="cashew-input" />
          </div>
          <div class="form-group">
            <label class="form-label">Costo Unitario Compra ($)</label>
            <input id="restockCost" type="number" min="0" step="0.01" value="${it.purchaseCost || 0}" class="cashew-input" />
          </div>
          <div class="form-group full">
            <label style="display:flex; align-items:center; gap:9px; cursor:pointer; font-size:13.5px; font-weight:700;">
              <input id="restockRecordExpense" type="checkbox" checked style="width:17px;height:17px;" />
              Registrar también la compra como Gasto en una cuenta
            </label>
          </div>
          <div class="form-group full">
            <label class="form-label">Cuenta de pago (si se registra gasto)</label>
            <select id="restockWallet" class="cashew-select">
              ${wallets.map(w => `<option value="${w.id}">${this.escapeHtml(w.name)} (${this.escapeHtml(w.currency)})</option>`).join('')}
            </select>
          </div>
        </div>

        <button class="btn-cashew btn-primary" style="width:100%; padding:13px;" onclick="CashewApp.confirmRestock('${it.id}')">
          <span class="material-symbols-rounded">add_box</span> Sumar Unidades al Stock
        </button>
      `);
    },

    confirmRestock(stockId) {
      const it = this.activeList('stockItems').find(x => x.id === stockId);
      if (!it) return;
      const qty = Math.max(1, parseInt(document.getElementById('restockQty').value, 10) || 1);
      const unitCostUSD = Math.max(0, parseFloat(document.getElementById('restockCost').value) || 0);
      const recordExp = document.getElementById('restockRecordExpense').checked;
      const walletId = document.getElementById('restockWallet').value;
      const w = this.getWalletById(walletId);

      const newStock = (Number(it.stock) || 0) + qty;
      const dateStr = todayLocalISO();
      const timeStr = nowHHMM();

      const ops = [
        {
          collection: 'stockItems',
          item: { ...it, stock: newStock, purchaseCost: unitCostUSD }
        },
        {
          collection: 'stockMovements',
          item: {
            stockId: it.id,
            itemName: it.name,
            action: 'reposicion',
            qtyChange: qty,
            newStock,
            unitPrice: it.salePrice,
            profit: 0,
            note: `Reposición de +${qty} ud(s)`,
            date: dateStr,
            time: timeStr
          }
        }
      ];

      if (recordExp && qty * unitCostUSD > 0) {
        const expAmt = window.cashewCurrency.convert(qty * unitCostUSD, 'USD', w ? w.currency : 'USD');
        const expCat = this.activeList('categories').find(c => c.id === (it.kind === 'insumo' ? 'c_insumos' : 'c_mercancia') || c.type === 'expense') || { id: '0' };
        ops.push({
          collection: 'transactions',
          item: {
            title: `Compra stock (${qty}x) ${it.name}`,
            amount: Math.round(expAmt * 100) / 100,
            type: 'expense',
            categoryId: expCat.id,
            walletId,
            date: dateStr,
            time: timeStr,
            paid: true,
            note: `Costo unitario: ${this.fmtMoney(unitCostUSD, '$')}`
          }
        });
      }

      window.cashewSync.batchUpsert(ops, `Reabasteció +${qty} ${it.name}`);
      this.closeModal();
      this.toast(`Stock actualizado: ${newStock} uds disponibles`, 'inventory_2');
    },

    /* BUDGETS, GOALS & OBLIGATIONS MODALS */
    openBudgetModal(editId = null) {
      const b = editId ? this.activeList('budgets').find(x => x.id === editId) : null;
      const expCats = this.activeList('categories').filter(c => String(c.id) !== '0' && c.type !== 'income');
      const selectedSet = new Set(b && Array.isArray(b.categoryIds) ? b.categoryIds : expCats.map(c => c.id));

      this.openModalHTML(`
        <div class="modal-head">
          <h2 class="modal-title">${b ? 'Editar Presupuesto' : 'Nuevo Presupuesto'}</h2>
          <div style="display:flex; gap:8px;">
            ${b ? `<button class="btn-cashew btn-danger btn-sm" onclick="CashewApp.deleteEntityAndClose('budgets','${b.id}','Presupuesto eliminado')"><span class="material-symbols-rounded" style="font-size:17px;">delete</span></button>` : ''}
            <button class="icon-btn" onclick="CashewApp.closeModal()"><span class="material-symbols-rounded">close</span></button>
          </div>
        </div>

        <div class="form-grid">
          <div class="form-group full">
            <label class="form-label">Nombre del Presupuesto</label>
            <input id="bgName" class="cashew-input" placeholder="Ej: Límite Gastos Mes" value="${this.escapeHtml(b ? b.name : '')}" />
          </div>
          <div class="form-group">
            <label class="form-label">Límite Mensual (${this.escapeHtml(this.primaryCurrency)})</label>
            <input id="bgLimit" type="number" min="1" step="0.01" class="cashew-input" value="${b ? b.limit : '300'}" />
          </div>
          <div class="form-group">
            <label class="form-label">Color</label>
            <input id="bgColor" type="color" class="cashew-input" style="height:44px;padding:4px;" value="${b ? (b.color || '#5f85c2') : '#5f85c2'}" />
          </div>
          <div class="form-group full">
            <label class="form-label">Categorías incluidas</label>
            <div style="display:flex; flex-wrap:wrap; gap:8px;">
              ${expCats.map(c => `
                <label class="select-chip" style="cursor:pointer;">
                  <input type="checkbox" class="bgCatChk" value="${c.id}" ${selectedSet.has(c.id) ? 'checked' : ''} />
                  ${window.renderCashewIconHTML(c, 16)}
                  ${this.escapeHtml(c.name)}
                </label>
              `).join('')}
            </div>
          </div>
        </div>

        <button class="btn-cashew btn-primary" style="width:100%; padding:13px;" onclick="CashewApp.saveBudget('${b ? b.id : ''}')">
          Guardar Presupuesto
        </button>
      `);
    },

    saveBudget(editId) {
      const name = document.getElementById('bgName').value.trim();
      const limit = Math.max(1, parseFloat(document.getElementById('bgLimit').value) || 100);
      const color = document.getElementById('bgColor').value;
      const categoryIds = Array.from(document.querySelectorAll('.bgCatChk:checked')).map(el => el.value);
      if (!name) { this.toast('Escribe un nombre para el presupuesto', 'error'); return; }

      const existing = editId ? this.activeList('budgets').find(x => x.id === editId) : null;
      window.cashewSync.upsertEntity('budgets', {
        ...(existing || {}),
        id: editId || undefined,
        name,
        limit,
        period: 'monthly',
        categoryIds,
        color,
        pinned: true
      }, `Presupuesto: ${name}`);
      this.closeModal();
    },

    openGoalModal(editId = null) {
      const g = editId ? this.activeList('goals').find(x => x.id === editId) : null;
      const goalIcons = ['piggy-bank.png', 'portable-game-console.png', 'gamepad.png', 'laptop.png', 'car.png', 'house.png', 'plane.png', 'science.png', 'diamond.png', 'trophy.png'];
      this._goalModalPng = (g && g.iconPng) ? g.iconPng : 'piggy-bank.png';

      this.openModalHTML(`
        <div class="modal-head">
          <h2 class="modal-title">${g ? 'Editar Meta' : 'Nueva Meta'}</h2>
          <div style="display:flex; gap:8px;">
            ${g ? `<button class="btn-cashew btn-danger btn-sm" onclick="CashewApp.deleteEntityAndClose('goals','${g.id}','Meta eliminada')"><span class="material-symbols-rounded" style="font-size:17px;">delete</span></button>` : ''}
            <button class="icon-btn" onclick="CashewApp.closeModal()"><span class="material-symbols-rounded">close</span></button>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group full">
            <label class="form-label">Nombre de la Meta</label>
            <input id="glName" class="cashew-input" placeholder="Ej: Nuevo lote consolas" value="${this.escapeHtml(g ? g.name : '')}" />
          </div>
          <div class="form-group">
            <label class="form-label">Monto Objetivo (${this.escapeHtml(this.primaryCurrency)})</label>
            <input id="glTarget" type="number" min="1" step="0.01" class="cashew-input" value="${g ? g.targetAmount : '500'}" />
          </div>
          <div class="form-group">
            <label class="form-label">Ahorrado Actual (${this.escapeHtml(this.primaryCurrency)})</label>
            <input id="glCurrent" type="number" min="0" step="0.01" class="cashew-input" value="${g ? g.currentAmount : '0'}" />
          </div>
          <div class="form-group full">
            <label class="form-label">Ícono Cashew</label>
            <div class="picker-grid">
              ${goalIcons.map(png => `
                <button type="button" class="icon-pick-tile gl-png-tile ${this._goalModalPng === png ? 'active' : ''}"
                        style="width:46px;"
                        onclick="CashewApp._goalModalPng='${png}'; document.querySelectorAll('.gl-png-tile').forEach(b=>b.classList.remove('active')); this.classList.add('active');">
                  ${window.renderCashewIconHTML({ iconPng: png }, 25)}
                </button>
              `).join('')}
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Color</label>
            <input id="glColor" type="color" class="cashew-input" style="height:44px;padding:4px;" value="${g ? (g.color || '#4db685') : '#4db685'}" />
          </div>
          <div class="form-group">
            <label class="form-label">Nota</label>
            <input id="glNote" class="cashew-input" value="${this.escapeHtml(g ? (g.note || '') : '')}" />
          </div>
        </div>
        <button class="btn-cashew btn-primary" style="width:100%; padding:13px;" onclick="CashewApp.saveGoal('${g ? g.id : ''}')">
          Guardar Meta
        </button>
      `);
    },

    saveGoal(editId) {
      const name = document.getElementById('glName').value.trim();
      if (!name) return;
      const existing = editId ? this.activeList('goals').find(x => x.id === editId) : null;
      window.cashewSync.upsertEntity('goals', {
        ...(existing || {}),
        id: editId || undefined,
        name,
        targetAmount: Math.max(1, parseFloat(document.getElementById('glTarget').value) || 100),
        currentAmount: Math.max(0, parseFloat(document.getElementById('glCurrent').value) || 0),
        color: document.getElementById('glColor').value,
        note: document.getElementById('glNote').value.trim(),
        iconPng: this._goalModalPng || 'piggy-bank.png',
        icon: 'savings'
      }, `Meta: ${name}`);
      this.closeModal();
    },

    /* ======================================================================
       METAS & OBJETIVOS: ABONAR Y RETIRAR FONDOS CON DEDUCCIÓN DE CUENTA
       (Compatible con Cashew: descuenta o deposita en la cuenta que escojas)
       ====================================================================== */
    openGoalDepositModal(goalId, initialMode = 'deposit') {
      const g = this.activeList('goals').find(x => x.id === goalId);
      if (!g) return;
      const wallets = this.activeList('wallets');
      const cur = Number(g.currentAmount) || 0;
      const target = Math.max(1, Number(g.targetAmount) || 1);
      const remainingToTarget = Math.max(0, target - cur);
      const pct = Math.min(100, Math.round((cur / target) * 100));

      this._goalDepositMode = initialMode; // 'deposit' | 'withdraw'

      this.openModalHTML(`
        <div class="modal-head">
          <div style="display:flex; align-items:center; gap:10px;">
            <div class="cat-circle" style="background:${g.color || '#4db685'}; width:40px; height:40px;">
              ${window.renderCashewIconHTML(g, 22)}
            </div>
            <div>
              <h2 class="modal-title" style="font-size:17.5px;">${this.escapeHtml(g.name)}</h2>
              <div style="font-size:12px; color:var(--text-muted);">
                Progreso: <strong>${this.fmtMoney(cur)}</strong> de ${this.fmtMoney(target)} (${pct}%)
              </div>
            </div>
          </div>
          <button class="icon-btn" onclick="CashewApp.closeModal()"><span class="material-symbols-rounded">close</span></button>
        </div>

        <!-- Barra visual de avance -->
        <div class="budget-track-inner" style="height:12px; background:var(--bg-input); margin:12px 0 16px;">
          <div class="budget-fill" style="width:${pct}%; background:${g.color || 'var(--primary)'};"></div>
        </div>

        <!-- Selector de Modo: Abonar (Ahorrar) vs Retirar Fondos -->
        <div class="segmented-pills" style="margin-bottom:16px;">
          <button type="button" id="btnGoalModeDep" class="seg-pill ${this._goalDepositMode === 'deposit' ? 'active' : ''}"
                  style="flex:1; text-align:center;"
                  onclick="CashewApp.setGoalDepositMode('deposit', '${g.id}')">
            <span class="material-symbols-rounded" style="font-size:16px; vertical-align:middle;">add_circle</span>
            Abonar (Ahorrar)
          </button>
          <button type="button" id="btnGoalModeWd" class="seg-pill ${this._goalDepositMode === 'withdraw' ? 'active' : ''}"
                  style="flex:1; text-align:center;"
                  onclick="CashewApp.setGoalDepositMode('withdraw', '${g.id}')">
            <span class="material-symbols-rounded" style="font-size:16px; vertical-align:middle;">remove_circle</span>
            Retirar Fondos
          </button>
        </div>

        <div class="form-grid">
          <div class="form-group full">
            <label class="form-label" id="lblGoalAmount">
              ${this._goalDepositMode === 'deposit' ? 'Monto a Abonar a la Meta' : 'Monto a Retirar de la Meta'} (${this.escapeHtml(this.primaryCurrency)})
            </label>
            <div style="position:relative;">
              <span style="position:absolute; left:14px; top:50%; transform:translateY(-50%); font-weight:800; color:var(--text-muted); font-size:17px;">${this.primarySymbol}</span>
              <input id="glDeltaAmt" type="number" step="0.01" min="0.01"
                     value="${this._goalDepositMode === 'deposit' ? (remainingToTarget > 0 ? Math.min(50, remainingToTarget) : 25) : (cur > 0 ? Math.min(50, cur) : 0)}"
                     class="cashew-input" style="padding-left:36px; font-size:18px; font-weight:700;"
                     oninput="CashewApp.updateGoalDeltaPreview('${g.id}')" />
            </div>
            <div id="glPreviewText" style="font-size:12px; color:var(--text-muted); margin-top:4px;">
              ${this._goalDepositMode === 'deposit'
                ? `Falta para completar: <strong>${this.fmtMoney(remainingToTarget)}</strong>`
                : `Disponible para retirar: <strong>${this.fmtMoney(cur)}</strong>`}
            </div>
          </div>

          <!-- Selector de Cuenta a Descontar o Depositar (Estilo Cashew) -->
          <div class="form-group full" style="background:var(--bg-elevated); padding:12px 14px; border-radius:14px; border:1px solid var(--border-subtle);">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
              <label for="glDeductFromWallet" style="font-weight:700; font-size:13px; display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" id="glDeductFromWallet" checked
                       onchange="document.getElementById('glWalletPickerRow').style.display = this.checked ? 'block' : 'none';" />
                <span id="lblDeductTitle">
                  ${this._goalDepositMode === 'deposit' ? 'Descontar monto de una cuenta seleccionada' : 'Depositar dinero en una cuenta seleccionada'}
                </span>
              </label>
              <span class="material-symbols-rounded" style="color:var(--primary); font-size:20px;">account_balance_wallet</span>
            </div>

            <div id="glWalletPickerRow">
              <label class="form-label" id="lblChooseWallet" style="font-size:11.5px;">
                ${this._goalDepositMode === 'deposit' ? '¿De qué cuenta se resta el dinero?' : '¿A qué cuenta transferir el dinero retirado?'}
              </label>
              <select id="glWalletId" class="cashew-select">
                ${wallets.map(w => {
                  const bal = this.getWalletBalance(w.id);
                  const wCur = (w.currency || 'USD').toUpperCase();
                  return `<option value="${w.id}">${this.escapeHtml(w.name)} — Saldo disponible: ${this.fmtMoney(bal, wCur)}</option>`;
                }).join('')}
              </select>
              <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">
                Se registrará la transacción en tiempo real y se restará automáticamente del saldo de esa cuenta.
              </div>
            </div>
          </div>

          <div class="form-group full">
            <label class="form-label">Nota o Concepto (Opcional)</label>
            <input id="glNote" class="cashew-input" placeholder="${this._goalDepositMode === 'deposit' ? 'Ej: Ahorro quincenal / Ganancia de venta' : 'Ej: Disposición para pago o compra'}" />
          </div>
        </div>

        <button type="button" class="btn-cashew btn-primary" id="btnGoalSubmit" style="width:100%; padding:14px; margin-top:8px;"
                onclick="CashewApp.applyGoalDeposit('${g.id}')">
          <span class="material-symbols-rounded">payments</span>
          <span id="btnGoalSubmitText">${this._goalDepositMode === 'deposit' ? 'Abonar a la Meta y Descontar de la Cuenta' : 'Retirar Fondos y Depositar en Cuenta'}</span>
        </button>
      `);
    },

    setGoalDepositMode(mode, goalId) {
      this._goalDepositMode = mode;
      const g = this.activeList('goals').find(x => x.id === goalId);
      if (!g) return;
      const cur = Number(g.currentAmount) || 0;
      const target = Math.max(1, Number(g.targetAmount) || 1);
      const remainingToTarget = Math.max(0, target - cur);

      const btnDep = document.getElementById('btnGoalModeDep');
      const btnWd = document.getElementById('btnGoalModeWd');
      if (btnDep) btnDep.classList.toggle('active', mode === 'deposit');
      if (btnWd) btnWd.classList.toggle('active', mode === 'withdraw');

      const lblAmt = document.getElementById('lblGoalAmount');
      if (lblAmt) lblAmt.textContent = (mode === 'deposit' ? 'Monto a Abonar a la Meta' : 'Monto a Retirar de la Meta') + ` (${this.primaryCurrency})`;

      const lblDed = document.getElementById('lblDeductTitle');
      if (lblDed) lblDed.textContent = mode === 'deposit' ? 'Descontar monto de una cuenta seleccionada' : 'Depositar dinero en una cuenta seleccionada';

      const lblW = document.getElementById('lblChooseWallet');
      if (lblW) lblW.textContent = mode === 'deposit' ? '¿De qué cuenta se resta el dinero?' : '¿A qué cuenta transferir el dinero retirado?';

      const btnSub = document.getElementById('btnGoalSubmitText');
      if (btnSub) btnSub.textContent = mode === 'deposit' ? 'Abonar a la Meta y Descontar de la Cuenta' : 'Retirar Fondos y Depositar en Cuenta';

      const amtInp = document.getElementById('glDeltaAmt');
      if (amtInp) {
        if (mode === 'deposit') {
          amtInp.value = remainingToTarget > 0 ? Math.min(50, remainingToTarget) : 25;
        } else {
          amtInp.value = cur > 0 ? Math.min(50, cur) : 0;
        }
      }
      this.updateGoalDeltaPreview(goalId);
    },

    updateGoalDeltaPreview(goalId) {
      const g = this.activeList('goals').find(x => x.id === goalId);
      if (!g) return;
      const cur = Number(g.currentAmount) || 0;
      const target = Math.max(1, Number(g.targetAmount) || 1);
      const amtInp = document.getElementById('glDeltaAmt');
      const amt = Math.max(0, parseFloat(amtInp ? amtInp.value : 0) || 0);
      const mode = this._goalDepositMode || 'deposit';
      const next = mode === 'deposit' ? (cur + amt) : Math.max(0, cur - amt);
      const nextPct = Math.min(100, Math.round((next / target) * 100));

      const previewEl = document.getElementById('glPreviewText');
      if (previewEl) {
        previewEl.innerHTML = `Nuevo progreso proyectado: <strong>${this.fmtMoney(next)}</strong> de ${this.fmtMoney(target)} (${nextPct}%)`;
      }
    },

    applyGoalDeposit(goalId) {
      const g = this.activeList('goals').find(x => x.id === goalId);
      if (!g) return;
      const amtInp = document.getElementById('glDeltaAmt');
      const amount = Math.max(0, parseFloat(amtInp ? amtInp.value : 0) || 0);
      if (amount <= 0) {
        this.toast('Ingresa un monto mayor a 0', 'error');
        return;
      }

      const mode = this._goalDepositMode || 'deposit';
      const deductFromWallet = document.getElementById('glDeductFromWallet') ? document.getElementById('glDeductFromWallet').checked : true;
      const walletId = document.getElementById('glWalletId') ? document.getElementById('glWalletId').value : null;
      const note = (document.getElementById('glNote') ? document.getElementById('glNote').value : '').trim();

      const cur = Number(g.currentAmount) || 0;
      const nextAmount = mode === 'deposit' ? (cur + amount) : Math.max(0, cur - amount);

      const ops = [
        {
          collection: 'goals',
          item: { ...g, currentAmount: nextAmount }
        }
      ];

      let walletName = '';
      if (deductFromWallet && walletId) {
        const w = this.getWalletById(walletId);
        walletName = w ? w.name : 'cuenta';
        const isDeposit = mode === 'deposit';

        const allCats = this.activeList('categories');
        let ahorroCat = allCats.find(c => c.id === 'c_ahorro' || /ahorro|meta/i.test(c.name));
        if (!ahorroCat) {
          ahorroCat = {
            id: 'c_ahorro',
            name: 'Ahorro y Metas',
            type: 'both',
            color: '#4db685',
            iconPng: 'piggy-bank.png',
            icon: 'savings'
          };
          ops.push({ collection: 'categories', item: ahorroCat });
        }

        const txObj = {
          title: isDeposit ? `Aporte a meta: ${g.name}` : `Retiro de meta: ${g.name}`,
          amount: amount,
          type: isDeposit ? 'expense' : 'income',
          walletId: walletId,
          categoryId: ahorroCat.id,
          date: todayLocalISO(),
          time: nowHHMM(),
          paid: true,
          specialType: isDeposit ? 'goal_deposit' : 'goal_withdraw',
          goalId: g.id,
          note: note || (isDeposit ? `Abono a la meta "${g.name}"` : `Retiro de la meta "${g.name}" a ${walletName}`)
        };
        ops.push({ collection: 'transactions', item: txObj });
      }

      window.cashewSync.batchUpsert(ops, mode === 'deposit'
        ? `Abonó ${this.fmtMoney(amount)} a meta ${g.name}${walletName ? ' desde ' + walletName : ''}`
        : `Retiró ${this.fmtMoney(amount)} de meta ${g.name}${walletName ? ' hacia ' + walletName : ''}`
      );

      this.closeModal();
      this.renderAll();
      if (mode === 'deposit') {
        this.toast(`¡Abonados ${this.fmtMoney(amount)} a "${g.name}"!${walletName ? ' Descontados de ' + walletName : ''}`, 'savings');
      } else {
        this.toast(`¡Retirados ${this.fmtMoney(amount)} de "${g.name}"!${walletName ? ' Depositados en ' + walletName : ''}`, 'payments');
      }
    },

    applyGoalDelta(goalId) {
      return this.applyGoalDeposit(goalId);
    },

    /* ======================================================================
       PRESUPUESTOS: CARGAR GASTO DESCONTANDO DE CUENTA & AUMENTAR LÍMITE
       (Permite sumar al consumo del presupuesto restando de la cuenta)
       ====================================================================== */
    openBudgetExpenseModal(budgetId, initialTab = 'expense') {
      const b = this.activeList('budgets').find(x => x.id === budgetId);
      if (!b) return;
      const ym = this.selectedMonthYM || currentYM();
      const wallets = this.activeList('wallets');
      const allCats = this.activeList('categories');
      const allowedCats = Array.isArray(b.categoryIds) && b.categoryIds.length > 0
        ? allCats.filter(c => b.categoryIds.includes(c.id))
        : allCats.filter(c => c.type !== 'income' && String(c.id) !== '0');

      let spent = 0;
      for (const tx of this.activeList('transactions')) {
        if (!this.isTxEffective(tx)) continue;
        if (tx.type !== 'expense' || tx.isBalanceCorrection || String(tx.categoryId) === '0') continue;
        if (!(tx.date || '').startsWith(ym)) continue;
        if (b.categoryIds && b.categoryIds.length > 0 && !b.categoryIds.includes(tx.categoryId)) continue;
        spent += this.txToPrimary(Number(tx.amount) || 0, tx.walletId);
      }
      const limit = Math.max(1, Number(b.limit) || 1);
      const remaining = Math.max(0, limit - spent);
      const pct = Math.min(100, Math.round((spent / limit) * 100));

      this._budgetModalTab = initialTab; // 'expense' | 'limit'

      this.openModalHTML(`
        <div class="modal-head">
          <div style="display:flex; align-items:center; gap:10px;">
            <div class="wallet-dot-icon" style="background:${b.color || '#5f85c2'}; width:38px; height:38px;">
              <span class="material-symbols-rounded" style="font-size:20px;">donut_small</span>
            </div>
            <div>
              <h2 class="modal-title" style="font-size:17.5px;">${this.escapeHtml(b.name)}</h2>
              <div style="font-size:12px; color:var(--text-muted);">
                Consumido: <strong>${this.fmtMoney(spent)}</strong> de ${this.fmtMoney(limit)} (${pct}%) • Restante: <strong>${this.fmtMoney(remaining)}</strong>
              </div>
            </div>
          </div>
          <button class="icon-btn" onclick="CashewApp.closeModal()"><span class="material-symbols-rounded">close</span></button>
        </div>

        <!-- Barra visual de ritmo -->
        <div class="budget-track-inner" style="height:12px; background:var(--bg-input); margin:12px 0 16px;">
          <div class="budget-fill" style="width:${pct}%; background:${spent > limit ? 'var(--cashew-expense)' : (b.color || 'var(--primary)')};"></div>
        </div>

        <!-- Pestañas: Cargar Gasto al Presupuesto vs Aumentar Límite -->
        <div class="segmented-pills" style="margin-bottom:16px;">
          <button type="button" id="btnBgTabExp" class="seg-pill ${this._budgetModalTab === 'expense' ? 'active' : ''}"
                  style="flex:1; text-align:center;"
                  onclick="CashewApp.setBudgetModalTab('expense', '${b.id}')">
            <span class="material-symbols-rounded" style="font-size:16px; vertical-align:middle;">shopping_cart_checkout</span>
            Cargar Gasto al Presupuesto
          </button>
          <button type="button" id="btnBgTabLim" class="seg-pill ${this._budgetModalTab === 'limit' ? 'active' : ''}"
                  style="flex:1; text-align:center;"
                  onclick="CashewApp.setBudgetModalTab('limit', '${b.id}')">
            <span class="material-symbols-rounded" style="font-size:16px; vertical-align:middle;">tune</span>
            Aumentar / Ajustar Límite
          </button>
        </div>

        <div id="bgTabContentExpense" style="display:${this._budgetModalTab === 'expense' ? 'block' : 'none'};">
          <div class="form-grid">
            <div class="form-group full">
              <label class="form-label">Concepto o Título del Gasto</label>
              <input id="bgExpTitle" class="cashew-input" placeholder="Ej: Compra de insumos / Almuerzo / Factura" />
            </div>

            <div class="form-group">
              <label class="form-label">Monto del Gasto (${this.escapeHtml(this.primaryCurrency)})</label>
              <input id="bgExpAmount" type="number" step="0.01" min="0.01" placeholder="0.00" class="cashew-input" style="font-size:18px; font-weight:700;" />
            </div>

            <div class="form-group">
              <label class="form-label">Cuenta de donde se descuenta el dinero</label>
              <select id="bgExpWalletId" class="cashew-select">
                ${wallets.map(w => {
                  const bal = this.getWalletBalance(w.id);
                  const wCur = (w.currency || 'USD').toUpperCase();
                  return `<option value="${w.id}">${this.escapeHtml(w.name)} (${this.fmtMoney(bal, wCur)})</option>`;
                }).join('')}
              </select>
            </div>

            <div class="form-group full">
              <label class="form-label">Categoría del Presupuesto</label>
              <select id="bgExpCategoryId" class="cashew-select">
                ${allowedCats.map(c => `<option value="${c.id}">${this.escapeHtml(c.name)}</option>`).join('')}
              </select>
              <div style="font-size:11.5px; color:var(--text-muted); margin-top:3px;">
                El dinero se restará automáticamente de la cuenta elegida y sumará al gasto consumido de este presupuesto.
              </div>
            </div>
          </div>

          <button type="button" class="btn-cashew btn-primary" style="width:100%; padding:14px; margin-top:10px;"
                  onclick="CashewApp.applyBudgetExpense('${b.id}')">
            <span class="material-symbols-rounded">check</span>
            Descontar de la Cuenta y Sumar al Presupuesto
          </button>
        </div>

        <div id="bgTabContentLimit" style="display:${this._budgetModalTab === 'limit' ? 'block' : 'none'};">
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label">Límite Mensual Actual</label>
              <input class="cashew-input" value="${this.fmtMoney(limit)}" disabled style="opacity:0.75;" />
            </div>
            <div class="form-group">
              <label class="form-label">Monto a Sumar al Límite (${this.escapeHtml(this.primaryCurrency)})</label>
              <input id="bgAddLimitAmount" type="number" step="0.01" value="50" class="cashew-input" style="font-size:18px; font-weight:700;"
                     oninput="const val = (parseFloat(this.value)||0); document.getElementById('bgNewLimitPreview').textContent = CashewApp.fmtMoney(${limit} + val);" />
            </div>
            <div class="form-group full" style="font-size:13px; color:var(--text-muted);">
              Nuevo límite mensual proyectado: <strong id="bgNewLimitPreview" style="color:var(--text-main); font-size:15.5px;">${this.fmtMoney(limit + 50)}</strong>
            </div>
          </div>

          <button type="button" class="btn-cashew btn-primary" style="width:100%; padding:14px; margin-top:10px;"
                  onclick="CashewApp.applyBudgetLimitAdd('${b.id}')">
            <span class="material-symbols-rounded">save</span>
            Guardar Nuevo Límite del Presupuesto
          </button>
        </div>
      `);
    },

    setBudgetModalTab(tab, budgetId) {
      this._budgetModalTab = tab;
      const btnExp = document.getElementById('btnBgTabExp');
      const btnLim = document.getElementById('btnBgTabLim');
      const boxExp = document.getElementById('bgTabContentExpense');
      const boxLim = document.getElementById('bgTabContentLimit');
      if (btnExp) btnExp.classList.toggle('active', tab === 'expense');
      if (btnLim) btnLim.classList.toggle('active', tab === 'limit');
      if (boxExp) boxExp.style.display = tab === 'expense' ? 'block' : 'none';
      if (boxLim) boxLim.style.display = tab === 'limit' ? 'block' : 'none';
    },

    applyBudgetExpense(budgetId) {
      const b = this.activeList('budgets').find(x => x.id === budgetId);
      if (!b) return;
      const amount = Math.max(0, parseFloat(document.getElementById('bgExpAmount').value) || 0);
      if (amount <= 0) {
        this.toast('Ingresa un monto mayor a 0', 'error');
        return;
      }
      const title = (document.getElementById('bgExpTitle').value || '').trim() || `Gasto en ${b.name}`;
      const walletId = document.getElementById('bgExpWalletId').value;
      const categoryId = document.getElementById('bgExpCategoryId').value;
      const w = this.getWalletById(walletId);

      const txObj = {
        title,
        amount,
        type: 'expense',
        walletId,
        categoryId,
        date: todayLocalISO(),
        time: nowHHMM(),
        paid: true,
        note: `Cargado a presupuesto "${b.name}"`
      };

      window.cashewSync.upsertEntity('transactions', txObj, `${title} (${this.fmtWalletAmount(amount, w)})`);
      this.closeModal();
      this.renderAll();
      this.toast(`¡Gasto de ${this.fmtMoney(amount)} descontado de ${w ? w.name : 'cuenta'} y sumado al presupuesto!`, 'check_circle');
    },

    applyBudgetLimitAdd(budgetId) {
      const b = this.activeList('budgets').find(x => x.id === budgetId);
      if (!b) return;
      const addAmt = parseFloat(document.getElementById('bgAddLimitAmount').value) || 0;
      const curLimit = Number(b.limit) || 100;
      const newLimit = Math.max(1, curLimit + addAmt);

      window.cashewSync.upsertEntity('budgets', { ...b, limit: newLimit }, `Aumentó límite de presupuesto: ${b.name} a ${this.fmtMoney(newLimit)}`);
      this.closeModal();
      this.renderAll();
      this.toast(`Límite del presupuesto "${b.name}" actualizado a ${this.fmtMoney(newLimit)}`, 'tune');
    },

    openObligationModal(editId = null) {
      const ob = editId ? this.activeList('obligations').find(x => x.id === editId) : null;
      const wallets = this.activeList('wallets');
      const categories = this.activeList('categories').filter(c => String(c.id) !== '0');

      this.openModalHTML(`
        <div class="modal-head">
          <h2 class="modal-title">${ob ? 'Editar Registro' : 'Nuevo Próximo / Préstamo / Deuda'}</h2>
          <div style="display:flex; gap:8px;">
            ${ob ? `<button class="btn-cashew btn-danger btn-sm" onclick="CashewApp.deleteEntityAndClose('obligations','${ob.id}','Registro eliminado')"><span class="material-symbols-rounded" style="font-size:17px;">delete</span></button>` : ''}
            <button class="icon-btn" onclick="CashewApp.closeModal()"><span class="material-symbols-rounded">close</span></button>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group full">
            <label class="form-label">Título / Concepto</label>
            <input id="obTitle" class="cashew-input" placeholder="Ej: Pago Internet / Restante consola / Deuda proveedor..." value="${this.escapeHtml(ob ? ob.title : '')}" />
          </div>
          <div class="form-group">
            <label class="form-label">Clasificación Cashew</label>
            <select id="obKind" class="cashew-select">
              <option value="upcoming" ${ob && ob.kind === 'upcoming' ? 'selected' : ''}>Pago Próximamente</option>
              <option value="subscription" ${ob && ob.kind === 'subscription' ? 'selected' : ''}>Suscripción Mensual</option>
              <option value="credit" ${ob && ob.kind === 'credit' ? 'selected' : ''}>Prestado / Nos Deben (Por cobrar)</option>
              <option value="debt" ${ob && ob.kind === 'debt' ? 'selected' : ''}>Deuda / Debemos (Por pagar)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Monto</label>
            <input id="obAmount" type="number" min="0" step="0.01" class="cashew-input" value="${ob ? ob.amount : ''}" />
          </div>
          <div class="form-group">
            <label class="form-label">Fecha Límite / Vencimiento</label>
            <input id="obDate" type="date" class="cashew-input" value="${ob ? ob.dueDate : todayLocalISO()}" />
          </div>
          <div class="form-group">
            <label class="form-label">Hora</label>
            <input id="obTime" type="time" class="cashew-input" value="${ob && ob.time ? ob.time : '09:00'}" />
          </div>
          <div class="form-group">
            <label class="form-label">Persona / Contacto (Opcional)</label>
            <input id="obPerson" class="cashew-input" placeholder="Cliente o proveedor..." value="${this.escapeHtml(ob ? (ob.person || '') : '')}" />
          </div>
          <div class="form-group">
            <label class="form-label">Cuenta Asociada</label>
            <select id="obWallet" class="cashew-select">
              ${wallets.map(w => `<option value="${w.id}" ${ob && ob.walletId === w.id ? 'selected' : ''}>${this.escapeHtml(w.name)} (${this.escapeHtml(w.currency)})</option>`).join('')}
            </select>
          </div>
          <div class="form-group full">
            <label class="form-label">Categoría</label>
            <select id="obCategory" class="cashew-select">
              ${categories.map(c => `<option value="${c.id}" ${ob && ob.categoryId === c.id ? 'selected' : ''}>${this.escapeHtml(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group full">
            <label class="form-label">Nota adicional</label>
            <input id="obNote" class="cashew-input" placeholder="Detalles..." value="${this.escapeHtml(ob ? (ob.note || '') : '')}" />
          </div>
        </div>
        <button class="btn-cashew btn-primary" style="width:100%; padding:13px;" onclick="CashewApp.saveObligation('${ob ? ob.id : ''}')">
          Guardar Registro
        </button>
      `, true);
    },

    saveObligation(editId) {
      const title = document.getElementById('obTitle').value.trim();
      const amount = Math.max(0, parseFloat(document.getElementById('obAmount').value) || 0);
      if (!title || amount <= 0) {
        this.toast('Completa el concepto y un monto mayor a 0', 'error');
        return;
      }
      const existing = editId ? this.activeList('obligations').find(x => x.id === editId) : null;

      if (editId && !this.canUserDirectlyMutate('obligations', editId)) {
        const proposedOb = {
          ...(existing || { settled: false }),
          id: editId,
          title,
          kind: document.getElementById('obKind').value,
          amount,
          dueDate: document.getElementById('obDate').value || todayLocalISO(),
          time: document.getElementById('obTime').value || '09:00',
          person: document.getElementById('obPerson').value.trim(),
          walletId: document.getElementById('obWallet').value,
          categoryId: document.getElementById('obCategory').value,
          note: document.getElementById('obNote').value.trim()
        };
        this.submitApprovalRequest('obligations', editId, 'update', proposedOb, `Modificar registro: ${title}`);
        this.closeModal();
        this.toast('Solicitud enviada a tu compañero para confirmar los cambios', 'hourglass_top');
        return;
      }

      window.cashewSync.upsertEntity('obligations', {
        ...(existing || { settled: false }),
        id: editId || undefined,
        title,
        kind: document.getElementById('obKind').value,
        amount,
        dueDate: document.getElementById('obDate').value || todayLocalISO(),
        time: document.getElementById('obTime').value || '09:00',
        person: document.getElementById('obPerson').value.trim(),
        walletId: document.getElementById('obWallet').value,
        categoryId: document.getElementById('obCategory').value,
        note: document.getElementById('obNote').value.trim()
      }, `Pendiente: ${title}`);
      this.closeModal();
      this.toast('Registro guardado y sincronizado', 'event_repeat');
    },

    deleteEntityAndClose(collection, id, msg) {
      if (!this.canUserDirectlyMutate(collection, id)) {
        const it = (this.activeList(collection) || []).find(x => x.id === id);
        this.submitApprovalRequest(collection, id, 'delete', null, `Eliminar de ${collection}: ${it ? (it.name || it.title || id) : id}`);
        this.closeModal();
        this.toast('Solicitud enviada a tu compañero para confirmar la eliminación', 'hourglass_top');
        return;
      }
      window.cashewSync.deleteEntity(collection, id, msg);
      this.closeModal();
      this.toast(msg, 'delete');
    },

    /* ======================================================================
       ORIGINAL CASHEW .SQL / .CSV & FULL JSON BACKUP HANDLERS
       ====================================================================== */
    async handleExportOriginalCashewSQL() {
      try {
        this.toast('Generando base de datos SQLite v46 compatible con Cashew...', 'hourglass_top');
        const fname = await window.cashewBackup.exportOriginalCashewSQL(this.st);
        this.toast(`Copia "${fname}" lista para importar en Cashew Original`, 'database');
      } catch (err) {
        console.error(err);
        this.toast('Error exportando .sql: ' + err.message, 'error');
      }
    },

    handleExportOriginalCashewCSV() {
      try {
        const fname = window.cashewBackup.exportOriginalCashewCSV(this.st);
        this.toast(`CSV oficial de Cashew descargado (${fname})`, 'table_chart');
      } catch (err) {
        this.toast('Error exportando CSV: ' + err.message, 'error');
      }
    },

    async handleImportAnyCashewFile(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      try {
        this.toast(`Importando "${file.name}" y sincronizando en la nube...`, 'sync');
        const res = await window.cashewBackup.importFile(file);
        this.renderAll();
        const label = res.kind === 'cashew_sql'
          ? 'Base SQLite original de Cashew'
          : res.kind === 'cashew_csv'
            ? 'CSV oficial de Cashew'
            : 'Respaldo completo JSON';
        this.toast(`${label} restaurado: ${res.walletsCount} cuentas, ${res.categoriesCount} categorías y ${res.transactionsCount} transacciones (Stock y Chat intactos)`, 'cloud_done');
      } catch (err) {
        console.error(err);
        this.toast('Error al importar: ' + err.message, 'error');
      } finally {
        event.target.value = '';
      }
    },

    exportBackupJSON() {
      const blob = new Blob([JSON.stringify(this.st, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cashew_completo_stock_chat_${todayLocalISO()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.toast('Respaldo completo (Finanzas + Stock + Chat) descargado', 'download');
    },

    exportStockCSV() {
      const rows = [
        ['Nombre', 'SKU', 'Tipo', 'Categoria', 'Stock', 'Minimo', 'CostoCompra', 'InversionExtra', 'PrecioVenta', 'ActualizadoPor']
      ];
      for (const it of this.activeList('stockItems')) {
        rows.push([
          `"${String(it.name || '').replace(/"/g, '""')}"`,
          `"${String(it.sku || '')}"`,
          it.kind,
          `"${String(it.category || '')}"`,
          it.stock,
          it.minStock,
          it.purchaseCost,
          it.extraCost,
          it.salePrice,
          it.updatedBy || 'socio'
        ]);
      }
      const csv = rows.map(r => r.join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `stock_inventario_${todayLocalISO()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    },

    async resetCleanWorkspace() {
      const seed = window.createInitialSeedState();
      seed.stockItems = [];
      seed.stockMovements = [];
      seed.transactions = [];
      seed.obligations = [];
      seed.goals = [];
      seed.wallets = seed.wallets.map(w => ({ ...w, startingBalance: 0 }));

      await window.cashewSync.replaceEntireWorkspace(seed, 'Espacio reiniciado en blanco', true);
      // Note: preserveStockAndChat=true keeps chat if desired, but user explicitly clicked reset stock & transactions:
      // So let's explicitly clear stock while keeping profiles & chat!
      this.st.stockItems = [];
      this.st.stockMovements = [];
      await window.cashewSync.pushFullStateToFirebase('Espacio limpio conservando perfiles y chat');
      this.renderAll();
      this.toast('Finanzas y Stock en blanco (Perfiles y Chat conservados)', 'restart_alt');
    },

    /* ======================================================================
       CASHEW TOAST NOTIFICATION
       ====================================================================== */
    toast(message, icon = 'check_circle') {
      const stack = document.getElementById('cashewToastStack');
      if (!stack) return;
      const el = document.createElement('div');
      el.className = 'cashew-toast';
      el.innerHTML = `
        <span class="material-symbols-rounded" style="color:var(--primary); font-size:20px;">${icon}</span>
        <span>${this.escapeHtml(message)}</span>
      `;
      stack.appendChild(el);
      setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(-8px)';
        el.style.transition = 'all 0.25s ease';
        setTimeout(() => el.remove(), 260);
      }, 3600);
    }
  };

  window.CashewApp = App;
  document.addEventListener('DOMContentLoaded', () => App.init());
})();
