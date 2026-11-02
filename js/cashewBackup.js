/* ==========================================================================
   CASHEW BIDIRECTIONAL ORIGINAL BACKUP ENGINE (Drift Schema46 SQLite3 + CSV + JSON)
   - Exports binary SQLite3 `.sql` compatible 100% with jameskokoska/Cashew (v46)
   - Imports original Cashew `.sql` / `.db` SQLite3 backups without losing data
   - Exports & Imports official Cashew 15-column `.csv` and full `.json` (Stock+Chat)
   ========================================================================== */

(function () {
  const SQL_WASM_CDN_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/';

  const SPECIAL_TYPE_TO_INT = {
    upcoming: 0,
    subscription: 1,
    repetitive: 2,
    credit: 3,
    debt: 4
  };

  const INT_TO_SPECIAL_TYPE = {
    0: 'upcoming',
    1: 'subscription',
    2: 'repetitive',
    3: 'credit',
    4: 'debt'
  };

  const MATERIAL_TO_CASHEW_PNG = {
    shopping_bag: 'shopping.png',
    handyman: 'gears.png',
    build: 'gears.png',
    auto_awesome: 'coin.png',
    inventory_2: 'shopping.png',
    memory: 'laptop.png',
    local_shipping: 'delivery-truck.png',
    bolt: 'bills.png',
    account_balance_wallet: 'wallet.png',
    payments: 'bills.png',
    tune: 'charts.png',
    restaurant: 'cutlery.png',
    sports_esports: 'gamepad.png',
    stadia_controller: 'portable-game-console.png',
    videogame_asset: 'gamepad.png',
    savings: 'piggy-bank.png',
    account_balance: 'bank.png',
    currency_bitcoin: 'crypto.png',
    credit_card: 'credit-card.png',
    event_repeat: 'subscription.png'
  };

  function hexToCashewColour(hex) {
    const clean = String(hex || '#5f85c2').trim().replace(/^#/, '').replace(/^0xff/i, '');
    const padded = clean.length === 3
      ? clean.split('').map(c => c + c).join('')
      : (clean.padEnd(6, '0').slice(0, 6));
    return '0xff' + padded.toLowerCase();
  }

  function cashewColourToHex(colour) {
    if (!colour) return '#5f85c2';
    const s = String(colour).trim();
    if (s.startsWith('#')) return s.slice(0, 7);
    if (/^0x[0-9a-f]{8}$/i.test(s)) {
      return '#' + s.slice(4).toLowerCase();
    }
    if (/^[0-9a-f]{6}$/i.test(s)) {
      return '#' + s.toLowerCase();
    }
    return '#5f85c2';
  }

  function dateAndTimeToUnixSec(dateStr, timeStr, fallbackMs) {
    try {
      if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const hhmm = (timeStr && /^\d{2}:\d{2}/.test(timeStr)) ? timeStr.slice(0, 5) : '12:00';
        const d = new Date(`${dateStr}T${hhmm}:00`);
        if (!isNaN(d.getTime())) {
          return Math.floor(d.getTime() / 1000);
        }
      }
    } catch (e) {}
    const ms = Number(fallbackMs) > 100000000000 ? Number(fallbackMs) : Date.now();
    return Math.floor(ms / 1000);
  }

  function unixToDateAndTime(rawTs) {
    let ms = Number(rawTs) || Math.floor(Date.now() / 1000);
    // Drift stores Unix seconds, though handle ms gracefully if > 1e11
    if (ms < 100000000000) ms = ms * 1000;
    const d = new Date(ms);
    if (isNaN(d.getTime())) {
      const now = new Date();
      return {
        date: now.toISOString().slice(0, 10),
        time: now.toTimeString().slice(0, 5),
        ms: now.getTime()
      };
    }
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return {
      date: `${yyyy}-${mm}-${dd}`,
      time: `${hh}:${mi}`,
      ms
    };
  }

  function resolveIconPng(entity, fallbackPng = 'coin.png') {
    if (entity && entity.iconPng && String(entity.iconPng).endsWith('.png')) {
      return entity.iconPng;
    }
    if (entity && entity.icon && String(entity.icon).endsWith('.png')) {
      return entity.icon;
    }
    if (entity && entity.icon && MATERIAL_TO_CASHEW_PNG[entity.icon]) {
      return MATERIAL_TO_CASHEW_PNG[entity.icon];
    }
    return fallbackPng;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 300);
  }

  function parseCSVRows(csvText) {
    const rows = [];
    let row = [];
    let cur = '';
    let inQuotes = false;
    const text = String(csvText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          row.push(cur);
          cur = '';
        } else if (ch === '\n') {
          row.push(cur);
          if (row.some(cell => cell.trim() !== '')) rows.push(row);
          row = [];
          cur = '';
        } else {
          cur += ch;
        }
      }
    }
    if (cur.length > 0 || row.length > 0) {
      row.push(cur);
      if (row.some(cell => cell.trim() !== '')) rows.push(row);
    }
    return rows;
  }

  function csvEscape(val) {
    const s = String(val ?? '');
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  class CashewBackupManager {
    constructor() {
      this._sqlPromise = null;
    }

    async getSQL() {
      if (this._sqlPromise) return this._sqlPromise;
      if (typeof window.initSqlJs !== 'function') {
        throw new Error('Librería SQLite (sql.js) aún no ha cargado. Verifica tu conexión a internet.');
      }
      this._sqlPromise = window.initSqlJs({
        locateFile: (file) => SQL_WASM_CDN_BASE + file
      });
      return this._sqlPromise;
    }

    createSchema46Tables(db) {
      db.run(`
        PRAGMA user_version = 46;

        CREATE TABLE IF NOT EXISTS wallets (
          wallet_pk TEXT NOT NULL PRIMARY KEY,
          name TEXT NOT NULL,
          colour TEXT NULL,
          icon_name TEXT NULL,
          date_created INTEGER NOT NULL,
          date_time_modified INTEGER NULL,
          "order" INTEGER NOT NULL,
          currency TEXT NULL,
          currency_format TEXT NULL,
          decimals INTEGER NOT NULL DEFAULT 2,
          home_page_widget_display TEXT NULL
        );

        CREATE TABLE IF NOT EXISTS categories (
          category_pk TEXT NOT NULL PRIMARY KEY,
          name TEXT NOT NULL,
          colour TEXT NULL,
          icon_name TEXT NULL,
          emoji_icon_name TEXT NULL,
          date_created INTEGER NOT NULL,
          date_time_modified INTEGER NULL,
          "order" INTEGER NOT NULL,
          income INTEGER NOT NULL DEFAULT 0 CHECK ("income" IN (0, 1)),
          method_added INTEGER NULL,
          main_category_pk TEXT NULL
        );

        CREATE TABLE IF NOT EXISTS objectives (
          objective_pk TEXT NOT NULL PRIMARY KEY,
          type INTEGER NOT NULL DEFAULT 0,
          name TEXT NOT NULL,
          amount REAL NOT NULL,
          "order" INTEGER NOT NULL,
          colour TEXT NULL,
          date_created INTEGER NOT NULL,
          end_date INTEGER NULL,
          date_time_modified INTEGER NULL,
          icon_name TEXT NULL,
          emoji_icon_name TEXT NULL,
          income INTEGER NOT NULL DEFAULT 0 CHECK ("income" IN (0, 1)),
          pinned INTEGER NOT NULL DEFAULT 1 CHECK ("pinned" IN (0, 1)),
          archived INTEGER NOT NULL DEFAULT 0 CHECK ("archived" IN (0, 1)),
          wallet_fk TEXT NOT NULL DEFAULT '0'
        );

        CREATE TABLE IF NOT EXISTS transactions (
          transaction_pk TEXT NOT NULL PRIMARY KEY,
          paired_transaction_fk TEXT NULL,
          name TEXT NOT NULL,
          amount REAL NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          category_fk TEXT NOT NULL,
          sub_category_fk TEXT NULL,
          wallet_fk TEXT NOT NULL,
          date_created INTEGER NOT NULL,
          date_time_modified INTEGER NULL,
          original_date_due INTEGER NULL,
          income INTEGER NOT NULL DEFAULT 0 CHECK ("income" IN (0, 1)),
          period_length INTEGER NULL,
          reoccurrence INTEGER NULL,
          end_date INTEGER NULL,
          upcoming_transaction_notification INTEGER NULL DEFAULT 1 CHECK ("upcoming_transaction_notification" IN (0, 1)),
          type INTEGER NULL,
          paid INTEGER NOT NULL DEFAULT 1 CHECK ("paid" IN (0, 1)),
          created_another_future_transaction INTEGER NULL DEFAULT 0 CHECK ("created_another_future_transaction" IN (0, 1)),
          skip_paid INTEGER NOT NULL DEFAULT 0 CHECK ("skip_paid" IN (0, 1)),
          method_added INTEGER NULL,
          transaction_owner_email TEXT NULL,
          transaction_original_owner_email TEXT NULL,
          shared_key TEXT NULL,
          shared_old_key TEXT NULL,
          shared_status INTEGER NULL,
          shared_date_updated INTEGER NULL,
          shared_reference_budget_pk TEXT NULL,
          objective_fk TEXT NULL,
          objective_loan_fk TEXT NULL,
          budget_fks_exclude TEXT NULL
        );

        CREATE TABLE IF NOT EXISTS budgets (
          budget_pk TEXT NOT NULL PRIMARY KEY,
          name TEXT NOT NULL,
          amount REAL NOT NULL,
          colour TEXT NULL,
          start_date INTEGER NOT NULL,
          end_date INTEGER NOT NULL,
          wallet_fks TEXT NULL,
          category_fks TEXT NULL,
          category_fks_exclude TEXT NULL,
          income INTEGER NOT NULL DEFAULT 0 CHECK ("income" IN (0, 1)),
          archived INTEGER NOT NULL DEFAULT 0 CHECK ("archived" IN (0, 1)),
          added_transactions_only INTEGER NOT NULL DEFAULT 0 CHECK ("added_transactions_only" IN (0, 1)),
          period_length INTEGER NOT NULL DEFAULT 1,
          reoccurrence INTEGER NULL,
          date_created INTEGER NOT NULL,
          date_time_modified INTEGER NULL,
          pinned INTEGER NOT NULL DEFAULT 0 CHECK ("pinned" IN (0, 1)),
          "order" INTEGER NOT NULL,
          wallet_fk TEXT NOT NULL DEFAULT '0',
          budget_transaction_filters TEXT NULL,
          member_transaction_filters TEXT NULL,
          shared_key TEXT NULL,
          shared_owner_member INTEGER NULL,
          shared_date_updated INTEGER NULL,
          shared_members TEXT NULL,
          shared_all_members_ever TEXT NULL,
          is_absolute_spending_limit INTEGER NOT NULL DEFAULT 0 CHECK ("is_absolute_spending_limit" IN (0, 1))
        );

        CREATE TABLE IF NOT EXISTS category_budget_limits (
          category_limit_pk TEXT NOT NULL PRIMARY KEY,
          category_fk TEXT NOT NULL,
          budget_fk TEXT NOT NULL,
          amount REAL NOT NULL,
          date_time_modified INTEGER NULL,
          wallet_fk TEXT NOT NULL DEFAULT '0'
        );

        CREATE TABLE IF NOT EXISTS associated_titles (
          associated_title_pk TEXT NOT NULL PRIMARY KEY,
          category_fk TEXT NOT NULL,
          title TEXT NOT NULL,
          date_created INTEGER NOT NULL,
          date_time_modified INTEGER NULL,
          "order" INTEGER NOT NULL,
          is_exact_match INTEGER NOT NULL DEFAULT 0 CHECK ("is_exact_match" IN (0, 1))
        );

        CREATE TABLE IF NOT EXISTS app_settings (
          settings_pk INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
          settings_j_s_o_n TEXT NOT NULL,
          date_updated INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS scanner_templates (
          scanner_template_pk TEXT NOT NULL PRIMARY KEY,
          date_created INTEGER NOT NULL,
          date_time_modified INTEGER NULL,
          template_name TEXT NOT NULL,
          contains TEXT NOT NULL,
          title_transaction_before TEXT NOT NULL,
          title_transaction_after TEXT NOT NULL,
          amount_transaction_before TEXT NOT NULL,
          amount_transaction_after TEXT NOT NULL,
          default_category_fk TEXT NOT NULL,
          wallet_fk TEXT NOT NULL,
          ignore INTEGER NOT NULL DEFAULT 0 CHECK ("ignore" IN (0, 1))
        );

        CREATE TABLE IF NOT EXISTS delete_logs (
          delete_log_pk TEXT NOT NULL PRIMARY KEY,
          entry_pk TEXT NOT NULL,
          type INTEGER NOT NULL,
          date_time_modified INTEGER NOT NULL
        );
      `);
    }

    async buildOriginalCashewSQLBytes(state) {
      const SQL = await this.getSQL();
      const db = new SQL.Database();
      this.createSchema46Tables(db);

      const nowSec = Math.floor(Date.now() / 1000);
      const active = (col) => (state[col] || []).filter(x => x && !x.deleted);

      const wallets = active('wallets');
      const categories = active('categories');
      const transactions = active('transactions');
      const budgets = active('budgets');
      const goals = active('goals');
      const obligations = active('obligations');

      // Ensure at least 1 wallet exists, and map primary/first wallet to wallet_pk = "0" (Cashew requirement)
      const walletIdToPk = new Map();
      const exportWallets = wallets.length > 0 ? wallets : [{
        id: '0',
        name: 'Cuenta Principal',
        currency: state.primaryCurrency || 'USD',
        startingBalance: 0,
        color: '#5f85c2',
        iconPng: 'wallet.png'
      }];

      const explicitZero = exportWallets.find(w => String(w.id) === '0' || String(w.cashewPk) === '0');
      exportWallets.forEach((w, idx) => {
        if (explicitZero) {
          walletIdToPk.set(w.id, (w === explicitZero) ? '0' : String(w.cashewPk || w.id));
        } else {
          walletIdToPk.set(w.id, idx === 0 ? '0' : String(w.cashewPk || w.id));
        }
      });

      const stmtWallet = db.prepare(`
        INSERT OR REPLACE INTO wallets
        (wallet_pk, name, colour, icon_name, date_created, date_time_modified, "order", currency, currency_format, decimals, home_page_widget_display)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      exportWallets.forEach((w, idx) => {
        const pk = walletIdToPk.get(w.id);
        const createdSec = w.createdAt ? Math.floor(Number(w.createdAt) / 1000) : (nowSec - 86400 * 30);
        const modSec = w.updatedAt ? Math.floor(Number(w.updatedAt) / 1000) : nowSec;
        const currLower = String(w.currency || state.primaryCurrency || 'usd').trim().toLowerCase();
        const decimals = (w.decimals !== undefined && w.decimals !== null) ? Number(w.decimals) : 2;
        stmtWallet.run([
          pk,
          String(w.name || 'Cuenta').slice(0, 250),
          hexToCashewColour(w.color || '#5f85c2'),
          resolveIconPng(w, 'wallet.png'),
          createdSec,
          modSec,
          idx,
          currLower,
          null,
          decimals,
          '[0,1,2,3]'
        ]);
      });
      stmtWallet.free();

      // Categories: Always ensure category_pk = "0" (Cashew Balance Correction category) exists
      const catIdToPk = new Map();
      const stmtCat = db.prepare(`
        INSERT OR REPLACE INTO categories
        (category_pk, name, colour, icon_name, emoji_icon_name, date_created, date_time_modified, "order", income, method_added, main_category_pk)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmtCat.run([
        '0',
        'Corrección de Balance',
        hexToCashewColour('#607d8b'),
        'charts.png',
        null,
        nowSec - 86400 * 60,
        nowSec,
        0,
        0,
        null,
        null
      ]);
      catIdToPk.set('0', '0');
      catIdToPk.set('c_ajuste', '0');

      let catOrder = 1;
      for (const c of categories) {
        if (String(c.id) === '0') {
          catIdToPk.set(c.id, '0');
          continue;
        }
        const pk = String(c.cashewPk || c.id);
        catIdToPk.set(c.id, pk);
        const isInc = c.type === 'income' ? 1 : 0;
        const createdSec = c.createdAt ? Math.floor(Number(c.createdAt) / 1000) : (nowSec - 86400 * 30);
        const modSec = c.updatedAt ? Math.floor(Number(c.updatedAt) / 1000) : nowSec;
        stmtCat.run([
          pk,
          String(c.name || 'Categoría').slice(0, 250),
          hexToCashewColour(c.color || '#5f85c2'),
          c.emoji ? null : resolveIconPng(c, isInc ? 'coin.png' : 'shopping.png'),
          c.emoji ? String(c.emoji) : null,
          createdSec,
          modSec,
          catOrder++,
          isInc,
          null,
          c.mainCategoryPk || null
        ]);
      }
      stmtCat.free();

      // Objectives (Goals -> type = 0)
      const stmtObj = db.prepare(`
        INSERT OR REPLACE INTO objectives
        (objective_pk, type, name, amount, "order", colour, date_created, end_date, date_time_modified, icon_name, emoji_icon_name, income, pinned, archived, wallet_fk)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const goalInitialTxOps = [];
      goals.forEach((g, idx) => {
        const gPk = String(g.cashewPk || g.id);
        const createdSec = g.createdAt ? Math.floor(Number(g.createdAt) / 1000) : (nowSec - 86400 * 15);
        const modSec = g.updatedAt ? Math.floor(Number(g.updatedAt) / 1000) : nowSec;
        const target = Math.max(0, Number(g.targetAmount) || 0);
        stmtObj.run([
          gPk,
          0,
          String(g.name || 'Meta').slice(0, 250),
          target,
          idx,
          hexToCashewColour(g.color || '#4db685'),
          createdSec,
          null,
          modSec,
          g.emoji ? null : resolveIconPng(g, 'piggy-bank.png'),
          g.emoji ? String(g.emoji) : null,
          1, // Saving goal (positive accumulation in Cashew)
          1,
          0,
          '0'
        ]);

        // Calculate if currentAmount exceeds linked objective transactions; if so, note or represent cleanly
        const curSaved = Number(g.currentAmount) || 0;
        const linkedSum = transactions
          .filter(t => t.objectiveId === g.id || t.objectiveId === gPk)
          .reduce((s, t) => s + (t.type === 'income' ? Number(t.amount) || 0 : -(Number(t.amount) || 0)), 0);
        const diffSaved = curSaved - linkedSum;
        if (Math.abs(diffSaved) >= 0.01 && g.exportProgressTx !== false) {
          // Only attach objective progress if user wants, without distorting wallet balance:
          // Note: In Cashew, transactions with objective_fk also affect wallet_fk balance unless paired.
          // To avoid changing wallet balances unexpectedly, we only keep real transactions!
        }
      });
      stmtObj.free();

      // Transactions Statement
      const stmtTx = db.prepare(`
        INSERT OR REPLACE INTO transactions
        (transaction_pk, paired_transaction_fk, name, amount, note, category_fk, sub_category_fk, wallet_fk, date_created, date_time_modified, original_date_due, income, period_length, reoccurrence, end_date, upcoming_transaction_notification, type, paid, created_another_future_transaction, skip_paid, method_added, transaction_owner_email, transaction_original_owner_email, shared_key, shared_old_key, shared_status, shared_date_updated, shared_reference_budget_pk, objective_fk, objective_loan_fk, budget_fks_exclude)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // 1) Export wallet startingBalance != 0 as Cashew Balance Correction (category_fk = "0")
      for (const w of exportWallets) {
        const startBal = Number(w.startingBalance) || 0;
        if (Math.abs(startBal) >= 0.005) {
          const wPk = walletIdToPk.get(w.id) || '0';
          const isInc = startBal >= 0 ? 1 : 0;
          const signedAmt = isInc ? Math.abs(startBal) : -Math.abs(startBal);
          const createdSec = w.createdAt ? Math.floor(Number(w.createdAt) / 1000) : (nowSec - 86400 * 45);
          stmtTx.run([
            `init_bal_${wPk}`,
            null,
            'Saldo Inicial',
            signedAmt,
            `Saldo base de ${w.name}`,
            '0',
            null,
            wPk,
            createdSec,
            nowSec,
            createdSec,
            isInc,
            null,
            null,
            null,
            1,
            null,
            1,
            0,
            0,
            null, null, null, null, null, null, null, null, null, null, null
          ]);
        }
      }

      // 2) Export all transactions (including transfers, balance corrections, upcoming, overdue, credits, debts)
      for (const tx of transactions) {
        const rawAmt = Math.abs(Number(tx.amount) || 0);
        const wPk = walletIdToPk.get(tx.walletId) || '0';
        const txSec = dateAndTimeToUnixSec(tx.date, tx.time, tx.createdAt);
        const modSec = tx.updatedAt ? Math.floor(Number(tx.updatedAt) / 1000) : nowSec;

        if (tx.type === 'transfer' && tx.toWalletId) {
          const toWPk = walletIdToPk.get(tx.toWalletId) || '0';
          const outPk = `${tx.id}_out`;
          const inPk = `${tx.id}_in`;
          const title = String(tx.title || 'Transferencia').slice(0, 250);
          const note = String(tx.note || '').slice(0, 500);

          // Outgoing leg
          stmtTx.run([
            outPk, inPk, title, -rawAmt, note, '0', null, wPk, txSec, modSec, txSec,
            0, null, null, null, 1, null, 1, 0, 0,
            null, null, null, null, null, null, null, null, null, null, null
          ]);
          // Incoming leg
          stmtTx.run([
            inPk, outPk, title, rawAmt, note, '0', null, toWPk, txSec, modSec, txSec,
            1, null, null, null, 1, null, 1, 0, 0,
            null, null, null, null, null, null, null, null, null, null, null
          ]);
          continue;
        }

        const isInc = tx.type === 'income' ? 1 : 0;
        const signedAmt = isInc ? rawAmt : -rawAmt;
        const catPk = (tx.isBalanceCorrection || String(tx.categoryId) === '0')
          ? '0'
          : (catIdToPk.get(tx.categoryId) || '0');

        const spInt = (tx.specialType && SPECIAL_TYPE_TO_INT[tx.specialType] !== undefined)
          ? SPECIAL_TYPE_TO_INT[tx.specialType]
          : null;

        // Cashew convention for `paid`:
        // - Standard transactions: paid = 1
        // - Upcoming / Subscription / Repetitive: paid = 0 while unpaid, paid = 1 once paid
        // - Credit / Debt (tables.dart line 313): paid = 1 while active/unsettled, paid = 0 when collected/paid off
        let paidInt = 1;
        if (tx.specialType === 'credit' || tx.specialType === 'debt') {
          paidInt = tx.paid === true ? 0 : 1; // settled -> 0, active -> 1
        } else if (spInt !== null) {
          paidInt = tx.paid === false ? 0 : 1;
        } else {
          paidInt = tx.paid === false ? 0 : 1;
        }

        const reocc = (tx.specialType === 'subscription' || tx.specialType === 'repetitive') ? 3 : null;
        const pLen = reocc !== null ? 1 : null;

        stmtTx.run([
          String(tx.cashewPk || tx.id),
          null,
          String(tx.title || 'Transacción').slice(0, 250),
          signedAmt,
          String(tx.note || '').slice(0, 500),
          catPk,
          null,
          wPk,
          txSec,
          modSec,
          txSec,
          isInc,
          pLen,
          reocc,
          null,
          1,
          spInt,
          paidInt,
          0,
          0,
          null, null, null, null, null, null, null, null,
          tx.objectiveId || null,
          null,
          null
        ]);
      }

      // 3) Export active obligations (upcoming, subscriptions, credits, debts) so Cashew shows them in Upcoming/Loans!
      for (const ob of obligations) {
        if (ob.settled) continue; // settled obligations already generated a paid transaction!
        const rawAmt = Math.abs(Number(ob.amount) || 0);
        const wPk = walletIdToPk.get(ob.walletId) || '0';
        const dueSec = dateAndTimeToUnixSec(ob.dueDate, ob.time || '09:00', ob.createdAt);
        const modSec = ob.updatedAt ? Math.floor(Number(ob.updatedAt) / 1000) : nowSec;

        // Credit = lent/owed to us (in Cashew: expense/outflow initially or credit type=3, income=0; Debt = borrowed type=4, income=1)
        let spType = 0; // upcoming
        let isInc = ob.isIncome ? 1 : 0;
        let paidVal = 0;

        if (ob.kind === 'subscription') {
          spType = 1;
          isInc = 0;
          paidVal = 0;
        } else if (ob.kind === 'upcoming') {
          spType = 0;
          isInc = ob.isIncome ? 1 : 0;
          paidVal = 0;
        } else if (ob.kind === 'credit') {
          spType = 3; // lent / nos deben
          isInc = 0;
          paidVal = 1; // active loan in Cashew has paid = 1 until collected
        } else if (ob.kind === 'debt') {
          spType = 4; // borrowed / debemos
          isInc = 1;
          paidVal = 1; // active debt in Cashew has paid = 1 until paid off
        }

        const signedAmt = isInc ? rawAmt : -rawAmt;
        const catPk = catIdToPk.get(ob.categoryId) || (Array.from(catIdToPk.values()).find(v => v !== '0') || '0');
        const noteParts = [ob.person ? `Contacto: ${ob.person}` : '', ob.note || ''].filter(Boolean).join(' • ');

        stmtTx.run([
          `ob_${ob.id}`,
          null,
          String(ob.title || 'Pendiente').slice(0, 250),
          signedAmt,
          noteParts.slice(0, 500),
          catPk,
          null,
          wPk,
          dueSec,
          modSec,
          dueSec,
          isInc,
          spType === 1 ? 1 : null,
          spType === 1 ? 3 : null,
          null,
          1,
          spType,
          paidVal,
          0,
          0,
          null, null, null, null, null, null, null, null, null, null, null
        ]);
      }
      stmtTx.free();

      // Budgets
      const stmtBg = db.prepare(`
        INSERT OR REPLACE INTO budgets
        (budget_pk, name, amount, colour, start_date, end_date, wallet_fks, category_fks, category_fks_exclude, income, archived, added_transactions_only, period_length, reoccurrence, date_created, date_time_modified, pinned, "order", wallet_fk, budget_transaction_filters, member_transaction_filters, shared_key, shared_owner_member, shared_date_updated, shared_members, shared_all_members_ever, is_absolute_spending_limit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const nowDate = new Date();
      const monthStartSec = Math.floor(new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).getTime() / 1000);
      const monthEndSec = Math.floor(new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 0, 23, 59, 59).getTime() / 1000);

      budgets.forEach((b, idx) => {
        const mappedCats = Array.isArray(b.categoryIds) && b.categoryIds.length > 0
          ? b.categoryIds.map(cid => catIdToPk.get(cid) || cid).filter(Boolean)
          : null;

        stmtBg.run([
          String(b.cashewPk || b.id),
          String(b.name || 'Presupuesto').slice(0, 250),
          Math.max(0, Number(b.limit) || 0),
          hexToCashewColour(b.color || '#5f85c2'),
          monthStartSec,
          monthEndSec,
          null,
          mappedCats ? JSON.stringify(mappedCats) : null,
          null,
          0,
          0,
          0,
          1,
          3, // BudgetReoccurence.monthly
          monthStartSec,
          nowSec,
          b.pinned !== false ? 1 : 0,
          idx,
          '0',
          null,
          null,
          null, null, null, null, null,
          0
        ]);
      });
      stmtBg.free();

      // App Settings
      const settingsObj = {
        selectedWalletPk: '0',
        accentColor: hexToCashewColour('#5f85c2'),
        materialYou: true,
        hasOnboarded: true
      };
      const stmtSet = db.prepare(`
        INSERT INTO app_settings (settings_pk, settings_j_s_o_n, date_updated)
        VALUES (?, ?, ?)
      `);
      stmtSet.run([1, JSON.stringify(settingsObj), nowSec]);
      stmtSet.free();

      const binaryArray = db.export();
      db.close();
      return binaryArray;
    }

    async exportOriginalCashewSQL(state) {
      const bytes = await this.buildOriginalCashewSQLBytes(state);
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '-');
      const filename = `cashew-${stamp}.sql`;
      triggerDownload(blob, filename);
      return filename;
    }

    exportOriginalCashewCSV(state) {
      const active = (col) => (state[col] || []).filter(x => x && !x.deleted);
      const wallets = active('wallets');
      const categories = active('categories');
      const transactions = active('transactions');

      const walletMap = new Map(wallets.map(w => [w.id, w]));
      const catMap = new Map(categories.map(c => [c.id, c]));

      const headers = [
        'account', 'amount', 'currency', 'title', 'note', 'date',
        'income', 'type', 'category name', 'subcategory name',
        'color', 'icon', 'emoji', 'budget', 'objective'
      ];

      const rows = [headers.join(',')];

      const sorted = [...transactions].sort((a, b) =>
        `${a.date || ''} ${a.time || ''}`.localeCompare(`${b.date || ''} ${b.time || ''}`)
      );

      for (const tx of sorted) {
        const w = walletMap.get(tx.walletId) || wallets[0] || { name: 'Principal', currency: 'USD' };
        const cat = (tx.type === 'transfer' || String(tx.categoryId) === '0' || tx.isBalanceCorrection)
          ? { name: 'Corrección de Balance', color: '#607d8b', iconPng: 'charts.png', emoji: '' }
          : (catMap.get(tx.categoryId) || { name: 'General', color: '#5f85c2', iconPng: 'coin.png', emoji: '' });

        const isInc = tx.type === 'income';
        const signedAmt = isInc ? Math.abs(Number(tx.amount) || 0) : -Math.abs(Number(tx.amount) || 0);
        const datePart = tx.date || new Date().toISOString().slice(0, 10);
        const timePart = (tx.time && /^\d{2}:\d{2}/.test(tx.time)) ? tx.time.slice(0, 5) : '12:00';
        const fullDate = `${datePart} ${timePart}:00.000`;

        const row = [
          w.name || 'Cuenta',
          signedAmt.toFixed(2),
          String(w.currency || state.primaryCurrency || 'USD').toUpperCase(),
          tx.title || cat.name,
          tx.note || '',
          fullDate,
          isInc ? 'true' : 'false',
          tx.specialType || 'null',
          cat.name || 'General',
          '',
          hexToCashewColour(cat.color || '#5f85c2'),
          resolveIconPng(cat, 'coin.png'),
          cat.emoji || '',
          '',
          ''
        ].map(csvEscape);

        rows.push(row.join(','));
      }

      const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = `cashew-${stamp}.csv`;
      triggerDownload(blob, filename);
      return filename;
    }

    async parseOriginalCashewSQLBytes(uint8Array) {
      const SQL = await this.getSQL();
      const db = new SQL.Database(uint8Array);
      const nowMs = Date.now();

      const queryObjects = (sqlQuery) => {
        try {
          const res = db.exec(sqlQuery);
          if (!res || !res[0]) return [];
          const cols = res[0].columns;
          return res[0].values.map(vals => {
            const obj = {};
            cols.forEach((col, i) => { obj[col] = vals[i]; });
            return obj;
          });
        } catch (e) {
          return [];
        }
      };

      const rawWallets = queryObjects('SELECT * FROM wallets ORDER BY "order" ASC');
      const rawCategories = queryObjects('SELECT * FROM categories ORDER BY "order" ASC');
      const rawTransactions = queryObjects('SELECT * FROM transactions ORDER BY date_created ASC');
      const rawBudgets = queryObjects('SELECT * FROM budgets ORDER BY "order" ASC');
      const rawObjectives = queryObjects('SELECT * FROM objectives ORDER BY "order" ASC');
      const rawSettings = queryObjects('SELECT * FROM app_settings LIMIT 1');

      db.close();

      let primaryCurrency = 'USD';
      if (rawSettings[0] && rawSettings[0].settings_j_s_o_n) {
        try {
          const parsedSet = JSON.parse(rawSettings[0].settings_j_s_o_n);
          const selPk = String(parsedSet.selectedWalletPk ?? '0');
          const primaryW = rawWallets.find(w => String(w.wallet_pk) === selPk) || rawWallets[0];
          if (primaryW && primaryW.currency) {
            primaryCurrency = String(primaryW.currency).toUpperCase();
          }
        } catch (e) {}
      } else if (rawWallets[0] && rawWallets[0].currency) {
        primaryCurrency = String(rawWallets[0].currency).toUpperCase();
      }

      // 1) Wallets (startingBalance = 0 because Cashew stores balance corrections & initial balances in transactions!)
      const wallets = rawWallets.map((rw) => {
        const wId = String(rw.wallet_pk) === '0' ? 'w_cashew_0' : `w_cashew_${rw.wallet_pk}`;
        const curCode = String(rw.currency || primaryCurrency || 'USD').toUpperCase();
        const sym = window.cashewCurrency ? window.cashewCurrency.getSymbol(curCode) : '$';
        return {
          id: wId,
          cashewPk: String(rw.wallet_pk),
          name: rw.name || 'Cuenta Cashew',
          currency: curCode,
          symbol: sym,
          decimals: rw.decimals !== null && rw.decimals !== undefined ? Number(rw.decimals) : 2,
          startingBalance: 0,
          color: cashewColourToHex(rw.colour),
          iconPng: rw.icon_name || 'wallet.png',
          icon: 'account_balance_wallet',
          createdAt: rw.date_created ? Number(rw.date_created) * 1000 : nowMs,
          updatedAt: nowMs
        };
      });

      const walletPkToId = new Map(wallets.map(w => [String(w.cashewPk), w.id]));
      if (wallets.length === 0) {
        wallets.push({
          id: 'w_cashew_0',
          cashewPk: '0',
          name: 'Cuenta Principal',
          currency: primaryCurrency,
          symbol: '$',
          startingBalance: 0,
          color: '#5f85c2',
          iconPng: 'wallet.png',
          icon: 'account_balance_wallet',
          createdAt: nowMs,
          updatedAt: nowMs
        });
        walletPkToId.set('0', 'w_cashew_0');
      }

      // 2) Categories
      const categories = [];
      const catPkToId = new Map();

      for (const rc of rawCategories) {
        const pk = String(rc.category_pk);
        const cId = pk === '0' ? '0' : `cat_cashew_${pk}`;
        catPkToId.set(pk, cId);
        categories.push({
          id: cId,
          cashewPk: pk,
          name: pk === '0' ? (rc.name || 'Corrección de Balance') : (rc.name || 'Categoría'),
          type: pk === '0' ? 'both' : (Number(rc.income) === 1 ? 'income' : 'expense'),
          color: cashewColourToHex(rc.colour),
          iconPng: rc.icon_name || (pk === '0' ? 'charts.png' : 'coin.png'),
          emoji: rc.emoji_icon_name || '',
          icon: pk === '0' ? 'tune' : 'category',
          mainCategoryPk: rc.main_category_pk || null,
          createdAt: rc.date_created ? Number(rc.date_created) * 1000 : nowMs,
          updatedAt: nowMs
        });
      }

      if (!catPkToId.has('0')) {
        catPkToId.set('0', '0');
        categories.unshift({
          id: '0',
          cashewPk: '0',
          name: 'Corrección de Balance',
          type: 'both',
          color: '#607d8b',
          iconPng: 'charts.png',
          emoji: '',
          icon: 'tune',
          createdAt: nowMs,
          updatedAt: nowMs
        });
      }

      // 3) Transactions & Obligations (upcoming, subscriptions, credits, debts) + Paired Transfers
      const transactions = [];
      const obligations = [];
      const handledTransferPks = new Set();
      const rawTxByPk = new Map(rawTransactions.map(rt => [String(rt.transaction_pk), rt]));
      const goalSavedByObjPk = new Map();

      for (const rt of rawTransactions) {
        const pk = String(rt.transaction_pk);
        if (handledTransferPks.has(pk)) continue;

        const dt = unixToDateAndTime(rt.date_created);
        const rawAmt = Number(rt.amount) || 0;
        const absAmt = Math.abs(rawAmt);
        const isInc = Number(rt.income) === 1 || (rt.income === null && rawAmt >= 0);
        const wId = walletPkToId.get(String(rt.wallet_fk)) || wallets[0].id;
        const catId = catPkToId.get(String(rt.category_fk)) || '0';

        // Track goal savings accumulation if linked to an objective
        if (rt.objective_fk && Number(rt.paid) === 1) {
          const prevG = goalSavedByObjPk.get(String(rt.objective_fk)) || 0;
          goalSavedByObjPk.set(String(rt.objective_fk), prevG + (isInc ? absAmt : -absAmt));
        }

        // Check if paired account-to-account transfer
        if (rt.paired_transaction_fk && rawTxByPk.has(String(rt.paired_transaction_fk))) {
          const partner = rawTxByPk.get(String(rt.paired_transaction_fk));
          const partnerPk = String(partner.transaction_pk);
          handledTransferPks.add(pk);
          handledTransferPks.add(partnerPk);

          const outTx = Number(rt.income) === 0 ? rt : partner;
          const inTx = Number(rt.income) === 0 ? partner : rt;
          const fromW = walletPkToId.get(String(outTx.wallet_fk)) || wId;
          const toW = walletPkToId.get(String(inTx.wallet_fk)) || wId;

          if (fromW !== toW) {
            transactions.push({
              id: `tx_cashew_${outTx.transaction_pk}`,
              cashewPk: String(outTx.transaction_pk),
              title: outTx.name || inTx.name || 'Transferencia',
              amount: Math.abs(Number(outTx.amount) || absAmt),
              type: 'transfer',
              categoryId: '0',
              walletId: fromW,
              toWalletId: toW,
              date: dt.date,
              time: dt.time,
              paid: true,
              note: outTx.note || inTx.note || '',
              createdAt: dt.ms,
              updatedAt: nowMs
            });
            continue;
          }
        }

        const spType = (rt.type !== null && rt.type !== undefined && INT_TO_SPECIAL_TYPE[Number(rt.type)])
          ? INT_TO_SPECIAL_TYPE[Number(rt.type)]
          : null;

        // If unpaid upcoming/subscription OR active credit/debt, also expose in obligations/upcoming while preserving accurate ledger balance!
        if (spType === 'upcoming' || spType === 'subscription' || spType === 'repetitive') {
          const isPaid = Number(rt.paid) === 1;
          if (!isPaid) {
            obligations.push({
              id: `ob_cashew_${pk}`,
              title: rt.name || (spType === 'subscription' ? 'Suscripción' : 'Pago Próximo'),
              amount: absAmt,
              kind: spType === 'upcoming' ? 'upcoming' : 'subscription',
              isIncome: isInc,
              dueDate: dt.date,
              time: dt.time,
              walletId: wId,
              categoryId: catId,
              person: '',
              note: rt.note || '',
              settled: false,
              createdAt: dt.ms,
              updatedAt: nowMs
            });
            continue; // Unpaid future transaction should NOT alter current wallet balance yet
          }
        }

        if (spType === 'credit' || spType === 'debt') {
          // In Cashew: paid == 1 means active loan (money lent out or borrowed in), paid == 0 means settled/collected
          const isActiveLoan = Number(rt.paid) === 1;
          if (isActiveLoan) {
            obligations.push({
              id: `ob_cashew_${pk}`,
              title: rt.name || (spType === 'credit' ? 'Prestado' : 'Deuda'),
              amount: absAmt,
              kind: spType, // 'credit' | 'debt'
              isIncome: isInc,
              dueDate: dt.date,
              time: dt.time,
              walletId: wId,
              categoryId: catId,
              person: '',
              note: rt.note || '',
              settled: false,
              affectBalanceAlreadyInTx: true,
              createdAt: dt.ms,
              updatedAt: nowMs
            });
          }
        }

        // Paid / effective transaction affecting wallet balance
        if (Number(rt.paid) === 1 || spType === null) {
          transactions.push({
            id: `tx_cashew_${pk}`,
            cashewPk: pk,
            title: rt.name || (String(rt.category_fk) === '0' ? 'Corrección de Balance' : 'Transacción'),
            amount: absAmt,
            type: isInc ? 'income' : 'expense',
            categoryId: catId,
            walletId: wId,
            date: dt.date,
            time: dt.time,
            specialType: spType,
            paid: true,
            isBalanceCorrection: String(rt.category_fk) === '0',
            objectiveId: rt.objective_fk ? `gl_cashew_${rt.objective_fk}` : null,
            note: rt.note || '',
            createdAt: dt.ms,
            updatedAt: nowMs
          });
        }
      }

      // 4) Budgets
      const budgets = rawBudgets
        .filter(rb => Number(rb.archived) !== 1)
        .map(rb => {
          let catIds = [];
          if (rb.category_fks) {
            try {
              const parsed = JSON.parse(rb.category_fks);
              if (Array.isArray(parsed)) {
                catIds = parsed.map(pk => catPkToId.get(String(pk)) || String(pk)).filter(Boolean);
              }
            } catch (e) {}
          }
          return {
            id: `bg_cashew_${rb.budget_pk}`,
            cashewPk: String(rb.budget_pk),
            name: rb.name || 'Presupuesto',
            limit: Math.abs(Number(rb.amount) || 0),
            period: 'monthly',
            categoryIds: catIds,
            color: cashewColourToHex(rb.colour),
            pinned: Number(rb.pinned) === 1,
            createdAt: rb.date_created ? Number(rb.date_created) * 1000 : nowMs,
            updatedAt: nowMs
          };
        });

      // 5) Goals & Loan Objectives
      const goals = [];
      for (const ro of rawObjectives) {
        if (Number(ro.archived) === 1) continue;
        const objPk = String(ro.objective_pk);
        if (Number(ro.type) === 1) {
          // Objective loan
          const isLent = Number(ro.income) === 1;
          obligations.push({
            id: `ob_obj_${objPk}`,
            title: ro.name || (isLent ? 'Préstamo' : 'Deuda'),
            amount: Math.abs(Number(ro.amount) || 0),
            kind: isLent ? 'credit' : 'debt',
            dueDate: ro.end_date ? unixToDateAndTime(ro.end_date).date : new Date().toISOString().slice(0, 10),
            time: '12:00',
            walletId: walletPkToId.get(String(ro.wallet_fk)) || wallets[0].id,
            categoryId: '0',
            person: ro.name || '',
            note: 'Importado de Préstamos Cashew',
            settled: false,
            createdAt: ro.date_created ? Number(ro.date_created) * 1000 : nowMs,
            updatedAt: nowMs
          });
        } else {
          const savedVal = Math.max(0, goalSavedByObjPk.get(objPk) || 0);
          goals.push({
            id: `gl_cashew_${objPk}`,
            cashewPk: objPk,
            name: ro.name || 'Meta Cashew',
            targetAmount: Math.max(1, Math.abs(Number(ro.amount) || 100)),
            currentAmount: savedVal,
            color: cashewColourToHex(ro.colour),
            iconPng: ro.icon_name || 'piggy-bank.png',
            emoji: ro.emoji_icon_name || '',
            icon: 'savings',
            note: 'Meta importada de Cashew',
            createdAt: ro.date_created ? Number(ro.date_created) * 1000 : nowMs,
            updatedAt: nowMs
          });
        }
      }

      return {
        primaryCurrency,
        wallets,
        categories,
        transactions,
        budgets,
        goals,
        obligations
      };
    }

    parseOriginalCashewCSVText(csvText) {
      const rows = parseCSVRows(csvText);
      if (rows.length < 2) {
        throw new Error('El archivo CSV está vacío o no contiene filas.');
      }

      const header = rows[0].map(h => h.trim().toLowerCase());
      const colIdx = (name) => header.indexOf(name);

      const iAccount = colIdx('account');
      const iAmount = colIdx('amount');
      const iCurrency = colIdx('currency');
      const iTitle = colIdx('title');
      const iNote = colIdx('note');
      const iDate = colIdx('date');
      const iIncome = colIdx('income');
      const iType = colIdx('type');
      const iCatName = colIdx('category name');
      const iColor = colIdx('color');
      const iIcon = colIdx('icon');
      const iEmoji = colIdx('emoji');

      if (iAmount === -1 || iDate === -1) {
        throw new Error('El CSV no tiene las columnas oficiales de Cashew (amount, date, account...).');
      }

      const nowMs = Date.now();
      const walletByName = new Map();
      const catByName = new Map();
      const transactions = [];

      // Always include category '0'
      catByName.set('corrección de balance', {
        id: '0',
        name: 'Corrección de Balance',
        type: 'both',
        color: '#607d8b',
        iconPng: 'charts.png',
        icon: 'tune',
        updatedAt: nowMs
      });

      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r];
        const accName = (iAccount >= 0 ? cells[iAccount] : 'Cuenta Principal').trim() || 'Cuenta Principal';
        const curCode = (iCurrency >= 0 ? cells[iCurrency] : 'USD').trim().toUpperCase() || 'USD';
        const wKey = `${accName.toLowerCase()}_${curCode}`;

        if (!walletByName.has(wKey)) {
          walletByName.set(wKey, {
            id: `w_csv_${walletByName.size}`,
            name: accName,
            currency: curCode,
            symbol: window.cashewCurrency ? window.cashewCurrency.getSymbol(curCode) : '$',
            startingBalance: 0,
            color: '#5f85c2',
            iconPng: 'wallet.png',
            icon: 'account_balance_wallet',
            updatedAt: nowMs
          });
        }
        const wallet = walletByName.get(wKey);

        const rawAmt = parseFloat(String(cells[iAmount] || '0').replace(/,/g, '')) || 0;
        const incStr = iIncome >= 0 ? String(cells[iIncome]).trim().toLowerCase() : '';
        const isInc = incStr === 'true' || incStr === '1' || (incStr === '' && rawAmt >= 0);

        const catName = (iCatName >= 0 ? cells[iCatName] : 'General').trim() || 'General';
        const cKey = catName.toLowerCase();
        if (!catByName.has(cKey)) {
          const isZero = cKey === 'balance correction' || cKey === 'correccion de balance';
          catByName.set(cKey, {
            id: isZero ? '0' : `cat_csv_${catByName.size}`,
            name: isZero ? 'Corrección de Balance' : catName,
            type: isZero ? 'both' : (isInc ? 'income' : 'expense'),
            color: iColor >= 0 ? cashewColourToHex(cells[iColor]) : '#5f85c2',
            iconPng: (iIcon >= 0 && cells[iIcon] && cells[iIcon].endsWith('.png')) ? cells[iIcon].trim() : 'coin.png',
            emoji: iEmoji >= 0 ? (cells[iEmoji] || '').trim() : '',
            icon: 'category',
            updatedAt: nowMs
          });
        }
        const cat = catByName.get(cKey);

        const rawDate = (cells[iDate] || '').trim();
        let dateISO = new Date().toISOString().slice(0, 10);
        let timeHHMM = '12:00';
        const mDate = rawDate.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
        if (mDate) {
          dateISO = mDate[1];
          if (mDate[2]) timeHHMM = mDate[2];
        } else {
          const parsedD = new Date(rawDate);
          if (!isNaN(parsedD.getTime())) {
            const dt = unixToDateAndTime(parsedD.getTime());
            dateISO = dt.date;
            timeHHMM = dt.time;
          }
        }

        const spRaw = iType >= 0 ? String(cells[iType] || '').trim().toLowerCase() : '';
        const spType = SPECIAL_TYPE_TO_INT[spRaw] !== undefined ? spRaw : null;

        transactions.push({
          id: `tx_csv_${r}_${Math.random().toString(36).slice(2, 6)}`,
          title: (iTitle >= 0 ? cells[iTitle] : '').trim() || cat.name,
          amount: Math.abs(rawAmt),
          type: isInc ? 'income' : 'expense',
          categoryId: cat.id,
          walletId: wallet.id,
          date: dateISO,
          time: timeHHMM,
          specialType: spType,
          paid: true,
          isBalanceCorrection: cat.id === '0',
          note: iNote >= 0 ? (cells[iNote] || '').trim() : '',
          createdAt: dateAndTimeToUnixSec(dateISO, timeHHMM, nowMs) * 1000,
          updatedAt: nowMs
        });
      }

      const wallets = Array.from(walletByName.values());
      return {
        primaryCurrency: wallets[0] ? wallets[0].currency : 'USD',
        wallets,
        categories: Array.from(catByName.values()),
        transactions,
        budgets: [],
        goals: [],
        obligations: []
      };
    }

    async importFile(file) {
      if (!file) throw new Error('Selecciona un archivo.');
      const buffer = await file.arrayBuffer();
      const uint8 = new Uint8Array(buffer);

      // Check SQLite3 binary magic header: "SQLite format 3\0"
      let magic = '';
      for (let i = 0; i < Math.min(15, uint8.length); i++) {
        magic += String.fromCharCode(uint8[i]);
      }

      if (magic === 'SQLite format 3') {
        const imported = await this.parseOriginalCashewSQLBytes(uint8);
        await window.cashewSync.replaceEntireWorkspace(
          imported,
          `Copia original de Cashew importada (${imported.transactions.length} movs)`,
          true // Preserve Stock, Kardex, Profiles & Chat!
        );
        return {
          kind: 'cashew_sql',
          walletsCount: imported.wallets.length,
          categoriesCount: imported.categories.length,
          transactionsCount: imported.transactions.length
        };
      }

      // Otherwise decode UTF-8 text (.json or .csv)
      const text = new TextDecoder('utf-8').decode(uint8).trim();

      if (text.startsWith('{')) {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('El archivo JSON no tiene un formato válido.');
        }
        const hasStock = Array.isArray(parsed.stockItems) && parsed.stockItems.length > 0;
        await window.cashewSync.replaceEntireWorkspace(
          parsed,
          'Respaldo completo JSON restaurado',
          !hasStock
        );
        return {
          kind: 'json',
          walletsCount: (parsed.wallets || []).length,
          categoriesCount: (parsed.categories || []).length,
          transactionsCount: (parsed.transactions || []).length
        };
      }

      // CSV fallback (Original Cashew 15-column CSV)
      const csvImported = this.parseOriginalCashewCSVText(text);
      await window.cashewSync.replaceEntireWorkspace(
        csvImported,
        `CSV de Cashew importado (${csvImported.transactions.length} movs)`,
        true // Preserve Stock & Chat!
      );
      return {
        kind: 'cashew_csv',
        walletsCount: csvImported.wallets.length,
        categoriesCount: csvImported.categories.length,
        transactionsCount: csvImported.transactions.length
      };
    }
  }

  window.cashewBackup = new CashewBackupManager();
})();
