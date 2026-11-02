/* ==========================================================================
   CASHEW OFFICIAL GITHUB CURRENCY ENGINE (Ported from currencyFunctions.dart)
   - Official Rates: https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json
   - Official Metadata: https://cdn.jsdelivr.net/gh/jameskokoska/Cashew@main/budget/assets/static/generated/currencies.json
   ========================================================================== */

(function () {
  const RATES_CACHE_KEY = 'cashew_official_rates_cache_v1';
  const META_CACHE_KEY = 'cashew_official_currencies_meta_v1';

  const RATES_API_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json';
  const FALLBACK_RATES_URL = 'https://latest.currency-api.pages.dev/v1/currencies/usd.min.json';
  const CASHEW_CURRENCIES_URL = 'https://cdn.jsdelivr.net/gh/jameskokoska/Cashew@main/budget/assets/static/generated/currencies.json';

  const POPULAR_CURRENCIES = {
    usd: { Currency: 'Dólar Estadounidense', Code: 'USD', Symbol: '$' },
    usdt: { Currency: 'Tether USDT', Code: 'USDT', Symbol: 'USDT ' },
    eur: { Currency: 'Euro', Code: 'EUR', Symbol: '€' },
    ves: { Currency: 'Bolívar Venezolano', Code: 'VES', Symbol: 'Bs.' },
    cop: { Currency: 'Peso Colombiano', Code: 'COP', Symbol: 'COP ' },
    mxn: { Currency: 'Peso Mexicano', Code: 'MXN', Symbol: 'MX$' },
    ars: { Currency: 'Peso Argentino', Code: 'ARS', Symbol: 'ARS ' },
    clp: { Currency: 'Peso Chileno', Code: 'CLP', Symbol: 'CLP$' },
    pen: { Currency: 'Sol Peruano', Code: 'PEN', Symbol: 'S/' },
    brl: { Currency: 'Real Brasileño', Code: 'BRL', Symbol: 'R$' },
    uyu: { Currency: 'Peso Uruguayo', Code: 'UYU', Symbol: '$U' },
    dop: { Currency: 'Peso Dominicano', Code: 'DOP', Symbol: 'RD$' },
    gtq: { Currency: 'Quetzal Guatemalteco', Code: 'GTQ', Symbol: 'Q' },
    crc: { Currency: 'Colón Costarricense', Code: 'CRC', Symbol: '₡' },
    pab: { Currency: 'Balboa Panameño', Code: 'PAB', Symbol: 'B/.' },
    bob: { Currency: 'Boliviano', Code: 'BOB', Symbol: 'Bs' },
    pyg: { Currency: 'Guaraní Paraguayo', Code: 'PYG', Symbol: '₲' },
    gbp: { Currency: 'Libra Esterlina', Code: 'GBP', Symbol: '£' },
    cad: { Currency: 'Dólar Canadiense', Code: 'CAD', Symbol: 'CA$' },
    chf: { Currency: 'Franco Suizo', Code: 'CHF', Symbol: 'CHF ' },
    jpy: { Currency: 'Yen Japonés', Code: 'JPY', Symbol: '¥' },
    cny: { Currency: 'Yuan Chino', Code: 'CNY', Symbol: '¥' },
    btc: { Currency: 'Bitcoin', Code: 'BTC', Symbol: '₿' },
    eth: { Currency: 'Ethereum', Code: 'ETH', Symbol: 'Ξ' }
  };

  class CashewCurrencyEngine {
    constructor() {
      this.rates = { usd: 1, usdt: 1 };
      this.ratesDate = null;
      this.currenciesMeta = { ...POPULAR_CURRENCIES };
      this.loading = false;
      this.listeners = [];
      this.loadFromCache();
    }

    loadFromCache() {
      try {
        const cached = JSON.parse(localStorage.getItem(RATES_CACHE_KEY) || 'null');
        if (cached && cached.rates) {
          this.rates = { usd: 1, usdt: 1, ...cached.rates };
          this.ratesDate = cached.date || null;
        }
        const meta = JSON.parse(localStorage.getItem(META_CACHE_KEY) || 'null');
        if (meta && typeof meta === 'object') {
          this.currenciesMeta = { ...POPULAR_CURRENCIES, ...meta };
        }
      } catch (e) {}
    }

    onUpdate(fn) {
      this.listeners.push(fn);
    }

    notify() {
      for (const fn of this.listeners) {
        try { fn(); } catch (e) {}
      }
    }

    async fetchOfficialRates() {
      this.loading = true;
      try {
        let data = null;
        try {
          const r1 = await fetch(RATES_API_URL);
          if (r1.ok) data = await r1.json();
        } catch (e) {}

        if (!data) {
          const r2 = await fetch(FALLBACK_RATES_URL);
          if (r2.ok) data = await r2.json();
        }

        if (data && data.usd) {
          this.rates = { usd: 1, usdt: 1, ...data.usd };
          this.ratesDate = data.date || new Date().toISOString().slice(0, 10);
          localStorage.setItem(RATES_CACHE_KEY, JSON.stringify({
            date: this.ratesDate,
            rates: this.rates
          }));
        }

        // Load official Cashew currencies.json metadata if not cached yet
        if (Object.keys(this.currenciesMeta).length <= 30) {
          const mc = await fetch(CASHEW_CURRENCIES_URL);
          if (mc.ok) {
            const metaJson = await mc.json();
            if (metaJson && typeof metaJson === 'object') {
              this.currenciesMeta = { ...metaJson, ...POPULAR_CURRENCIES };
              localStorage.setItem(META_CACHE_KEY, JSON.stringify(this.currenciesMeta));
            }
          }
        }
      } catch (err) {
        console.warn('Currency fetch warning:', err);
      } finally {
        this.loading = false;
        this.notify();
      }
    }

    getCustomOverridesMap() {
      const map = {};
      if (window.cashewSync && window.cashewSync.state && Array.isArray(window.cashewSync.state.currencyRatesCustom)) {
        for (const item of window.cashewSync.state.currencyRatesCustom) {
          if (item && !item.deleted && item.code && Number(item.ratePerUSD) > 0) {
            map[String(item.code).toLowerCase()] = Number(item.ratePerUSD);
          }
        }
      }
      return map;
    }

    /* Rate: 1 USD = X units of currencyKey */
    getRatePerUSD(currencyCode) {
      if (!currencyCode) return 1;
      const key = String(currencyCode).trim().toLowerCase();
      if (key === 'usd') return 1;
      const custom = this.getCustomOverridesMap();
      if (custom[key]) return custom[key];
      if (this.rates[key] && Number(this.rates[key]) > 0) return Number(this.rates[key]);
      if (key === 'usdt' || key === 'usdc') return 1;
      return 1;
    }

    convert(amount, fromCode, toCode) {
      const val = Number(amount) || 0;
      const from = String(fromCode || 'USD').toLowerCase();
      const to = String(toCode || 'USD').toLowerCase();
      if (from === to) return val;
      const fromPerUSD = this.getRatePerUSD(from);
      const toPerUSD = this.getRatePerUSD(to);
      if (!fromPerUSD || !toPerUSD) return val;
      return (val / fromPerUSD) * toPerUSD;
    }

    getPrimaryCurrency() {
      return (window.cashewSync && window.cashewSync.state && window.cashewSync.state.primaryCurrency) || 'USD';
    }

    toPrimary(amount, fromCode) {
      return this.convert(amount, fromCode || 'USD', this.getPrimaryCurrency());
    }

    getSymbol(currencyCode) {
      const code = String(currencyCode || 'USD').toLowerCase();
      if (code === 'usd') return '$';
      const entry = this.currenciesMeta[code];
      if (entry && entry.Symbol) return entry.Symbol;
      return String(currencyCode || '$').toUpperCase() + ' ';
    }

    getCurrencyList() {
      const priority = ['usd', 'usdt', 'ves', 'eur', 'cop', 'mxn', 'ars', 'clp', 'pen', 'brl', 'dop', 'gbp', 'cad', 'btc', 'eth'];
      const seen = new Set();
      const list = [];

      const pushKey = (k) => {
        const low = k.toLowerCase();
        if (seen.has(low)) return;
        seen.add(low);
        const info = this.currenciesMeta[low] || {};
        const rate = this.getRatePerUSD(low);
        list.push({
          key: low,
          code: (info.Code || low).toUpperCase(),
          name: info.Currency || info.CountryName || low.toUpperCase(),
          symbol: info.Symbol || (low.toUpperCase() + ' '),
          ratePerUSD: rate
        });
      };

      for (const p of priority) pushKey(p);
      for (const k of Object.keys(this.currenciesMeta)) {
        if (this.rates[k.toLowerCase()]) pushKey(k);
      }
      return list;
    }
  }

  window.cashewCurrency = new CashewCurrencyEngine();
})();
