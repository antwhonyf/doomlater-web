/* ==========================================================================
   CASHEW SEED DATA, DYNAMIC PROFILES, 277 OFFICIAL CASHEW ICONS & THEME ENGINE
   ========================================================================== */

window.CASHEW_ICON_CDN_BASE = 'https://cdn.jsdelivr.net/gh/jameskokoska/Cashew@main/budget/assets/categories/';

window.createDefaultProfilesList = function () {
  const baseTs = 1700000000000;
  return [
    {
      id: 'profile_1',
      slot: 1,
      username: 'doom1',
      password: '2411',
      displayName: 'doom1',
      role: 'Socio Principal',
      badgeClass: 'doom1',
      defaultAccent: '#5f85c2',
      avatarUrl: '',
      createdAt: baseTs,
      updatedAt: baseTs
    },
    {
      id: 'profile_2',
      slot: 2,
      username: 'doom2',
      password: 'doom2',
      displayName: 'doom2',
      role: 'Socio & Operaciones',
      badgeClass: 'doom2',
      defaultAccent: '#4db685',
      avatarUrl: '',
      createdAt: baseTs,
      updatedAt: baseTs
    }
  ];
};

window.CASHEW_PROFILES = {
  doom1: window.createDefaultProfilesList()[0],
  doom2: window.createDefaultProfilesList()[1]
};

window.CASHEW_ACCENT_SWATCHES = [
  { name: 'Cashew Blue', hex: '#5f85c2' },
  { name: 'Emerald Mint', hex: '#4db685' },
  { name: 'Lavender', hex: '#8e7cc3' },
  { name: 'Coral Rose', hex: '#d9738a' },
  { name: 'Amber Gold', hex: '#d49b4b' },
  { name: 'Ocean Teal', hex: '#4ba3b5' },
  { name: 'Doom Crimson', hex: '#d16666' },
  { name: 'Sage Olive', hex: '#7c9a5e' }
];

window.CASHEW_PALETTE_COLORS = [
  '#5f85c2', '#4db685', '#8e7cc3', '#d9738a', '#d49b4b',
  '#4ba3b5', '#d16666', '#62ca77', '#6577e0', '#e07a5f',
  '#3d9970', '#9b5de5', '#f15bb5', '#00bbf9', '#607d8b',
  '#f4a261', '#2a9d8f', '#e76f51', '#577590', '#43aa8b'
];

/* All 277 Official Illustrated Category PNG Icons from jameskokoska/Cashew */
window.CASHEW_OFFICIAL_PNG_ICONS = [
  // Featured Finance, Business, Gaming, Tech & Everyday Cashew Defaults first
  'wallet.png', 'bank.png', 'cash-bill-dollar.png', 'coin.png', 'dollar-coin.png',
  'money.png', 'money-bag.png', 'money-bag2.png', 'crypto.png', 'credit-card.png',
  'piggy-bank.png', 'charts.png', 'investment.png', 'increase.png', 'decrease.png',
  'loan.png', 'subscription.png', 'bills.png', 'bill.png', 'paper-bill.png',
  'calculator.png', 'safe-box.png', 'security-box.png', 'exchange-arrows-circle.png', 'price-tag.png',
  'shopping.png', 'shopping-cart.png', 'package.png', 'box.png', 'delivery-truck.png',
  'gamepad.png', 'portable-game-console.png', 'laptop.png', 'desktop-computer.png', 'smartphone.png',
  'tablet.png', 'television.png', 'headphones.png', 'keyboard.png', 'sim-card.png',
  '3d-printer.png', 'gears.png', 'settings.png', 'battery-charge.png', 'lightning-bolt.png',
  'wifi.png', 'internet-globe.png', 'code.png', 'robot.png', 'camera.png',
  'cutlery.png', 'groceries.png', 'fast-food.png', 'pizza.png', 'coffee.png',
  'coffee-cup.png', 'bubble-tea.png', 'popcorn.png', 'cake.png', 'donut.png',
  'sushi.png', 'taco.png', 'noodles.png', 'spaghetti.png', 'healthy-food.png',
  'tram.png', 'car.png', 'gas-station.png', 'fuel.png', 'plane.png',
  'house.png', 'home2.png', 'rent.png', 'key.png', 'furniture.png',
  'gift.png', 'gift-card.png', 'briefcase.png', 'graduation.png', 'healthcare-and-medical.png',
  'flower.png', 'plant.png', 'tshirt.png', 'hoodie.png', 'sneakers.png',
  // Full Official Cashew Catalog (Remaining Verified PNGs)
  'air-hockey.png', 'anchor.png', 'antivirus.png', 'apple.png', 'atm-machine(1).png',
  'atm-machine(2).png', 'back-undo-arrow.png', 'ball.png', 'balloons.png', 'barber.png',
  'baseball-player.png', 'beach-umbrella.png', 'bicycle.png', 'binoculars.png', 'birdhouse.png',
  'bookshelf.png', 'bottles.png', 'bouquet.png', 'bowling.png', 'bread.png',
  'butterfly.png', 'cabin.png', 'cactus.png', 'calendar.png', 'campfire.png',
  'candy.png', 'cap.png', 'car(1).png', 'car(2).png', 'car-charging-station.png',
  'car-key.png', 'cards.png', 'cat.png', 'celebration.png', 'checker-chess-board.png',
  'chef-hat.png', 'chess.png', 'christmas-tree.png', 'church.png', 'cleaning.png',
  'clipboard.png', 'clock.png', 'clothes-hanger.png', 'cloudy.png', 'coconut-tree.png',
  'color-palette.png', 'compass.png', 'confetti(2).png', 'confetti.png', 'construction-helmet.png',
  'cookies.png', 'cottage.png', 'cowboy-hat.png', 'cricket-bat.png', 'cupcake.png',
  'curry.png', 'dental-care.png', 'diamond.png', 'dice.png', 'dog.png',
  'double-bed.png', 'dress.png', 'dvd.png', 'earth.png', 'eggs.png',
  'emergency-exit.png', 'envelope.png', 'essay.png', 'exchange-arrows.png', 'extinguisher.png',
  'face-mask.png', 'favourite.png', 'feathers.png', 'feeding-bottle.png', 'fireplace.png',
  'fish.png', 'fishing-rod.png', 'fizzy-drink.png', 'flashlight.png', 'flat-tire.png',
  'folder.png', 'food-tray.png', 'fried-egg.png', 'fried-potatoes.png', 'fruit.png',
  'garden-hose.png', 'gas-valve.png', 'gasoline.png', 'glass-of-water.png', 'glass.png',
  'golf-ball.png', 'golf.png', 'grill.png', 'guitar.png', 'haircut.png',
  'hamster.png', 'hand-fan.png', 'hearing-aid.png', 'heart.png', 'helicopter.png',
  'high-heels.png', 'hiking-backpack.png', 'hockey-stick.png', 'house(1).png', 'ice-cream-cup.png',
  'idea.png', 'image.png', 'kite.png', 'lighthouse.png', 'limousine.png',
  'location-pin.png', 'locomotive.png', 'magic-box.png', 'magnifying-glass.png', 'make-up.png',
  'makeup(1).png', 'makeup.png', 'map.png', 'media-content.png', 'microphone.png',
  'milk.png', 'mixer.png', 'motor-bike(1).png', 'motor-bike(2).png', 'multivitamin.png',
  'music.png', 'necklace.png', 'note.png', 'oldschool-telephone.png', 'open-book.png',
  'open-email.png', 'orange-juice.png', 'organic-food.png', 'padlock.png', 'paper-ticket.png',
  'parents.png', 'parking.png', 'pen.png', 'pencil.png', 'pet-bowl.png',
  'piano.png', 'picnic.png', 'popsicle.png', 'pumpkin.png', 'radio.png',
  'rain.png', 'rainbow.png', 'raw-meat.png', 'recycling.png', 'reload.png',
  'safety-helmet.png', 'salad.png', 'sandals.png', 'sandwich.png', 'sauces.png',
  'school-backpack.png', 'school-bus.png', 'science.png', 'shrimp.png', 'skincare.png',
  'snooker.png', 'snorkling.png', 'snowman.png', 'socket.png', 'speaker.png',
  'sports.png', 'sticky-notes.png', 'target.png', 'taxi(1).png', 'taxi(2).png',
  'tea.png', 'teddy-bear.png', 'telescope.png', 'theatre.png', 'tickets.png',
  'tie.png', 'toiletries.png', 'top-hat.png', 'trash.png', 'tree.png',
  'trophy.png', 'umbrella.png', 'user.png', 'vision.png', 'washing-machine.png',
  'watch.png', 'water-bottle.png', 'water-tap.png', 'watering-can.png', 'weight.png',
  'winter-hat.png', 'yarn-ball.png'
];

window.CASHEW_EMOJIS = [
  '💸', '💰', '💳', '🏦', '🪙', '📈', '📊', '🛍️',
  '🎮', '🕹️', '💻', '📱', '🎧', '🔧', '🛠️', '📦',
  '🚚', '⚡', '🌐', '🍔', '🍕', '☕', '🛒', '🏠',
  '🚗', '⛽', '✈️', '🎁', '💊', '🎓', '🎬', '🍿',
  '👕', '👟', '💎', '🧾', '🤝', '🎯', '🏆', '⭐'
];

window.CASHEW_ICONS = [
  'sports_esports', 'stadia_controller', 'videogame_asset', 'memory',
  'inventory_2', 'shopping_bag', 'storefront', 'build', 'handyman',
  'cable', 'headphones', 'tv', 'smartphone', 'laptop_mac', 'sd_card',
  'payments', 'account_balance_wallet', 'savings', 'currency_bitcoin',
  'account_balance', 'credit_card', 'local_shipping', 'receipt_long',
  'bolt', 'wifi', 'restaurant', 'sell', 'auto_awesome', 'category',
  'star', 'tune', 'swap_horiz', 'event_repeat', 'directions_car', 'home'
];

/* Universal Cashew Icon Renderer (Official PNG -> Emoji -> Material Symbol) */
window.renderCashewIconHTML = function (entity, sizePx = 24) {
  if (!entity) {
    return `<span class="material-symbols-rounded" style="font-size:${sizePx}px;">category</span>`;
  }
  if (entity.emoji && String(entity.emoji).trim() !== '') {
    const safeEmoji = String(entity.emoji).replace(/[<>"'&]/g, '');
    return `<span class="cashew-emoji-icon" style="font-size:${Math.round(sizePx * 0.92)}px; line-height:1;">${safeEmoji}</span>`;
  }
  if (entity.iconPng && String(entity.iconPng).endsWith('.png')) {
    const file = encodeURIComponent(entity.iconPng).replace(/%28/g, '(').replace(/%29/g, ')');
    const fallbackMat = (entity.icon && !String(entity.icon).endsWith('.png')) ? entity.icon : 'category';
    return `<img src="${window.CASHEW_ICON_CDN_BASE}${file}" alt="" class="cashew-png-icon" style="width:${sizePx}px; height:${sizePx}px;" loading="lazy" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='inline-flex';" /><span class="material-symbols-rounded" style="display:none; font-size:${sizePx}px;">${fallbackMat}</span>`;
  }
  const mat = entity.icon || 'category';
  return `<span class="material-symbols-rounded" style="font-size:${sizePx}px;">${mat}</span>`;
};

/* Material You Dynamic Pastel Generator (Ported from Cashew colors.dart) */
window.CashewTheme = {
  hexToRgb(hex) {
    const clean = (hex || '#5f85c2').replace('#', '');
    const num = parseInt(clean.length === 3
      ? clean.split('').map(c => c + c).join('')
      : clean, 16) || 0x5f85c2;
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  },

  mix(hex1, hex2, weight2) {
    const c1 = this.hexToRgb(hex1);
    const c2 = this.hexToRgb(hex2);
    const w = Math.max(0, Math.min(1, weight2));
    const r = Math.round(c1.r * (1 - w) + c2.r * w);
    const g = Math.round(c1.g * (1 - w) + c2.g * w);
    const b = Math.round(c1.b * (1 - w) + c2.b * w);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  },

  apply(accentHex = '#5f85c2', mode = 'dark') {
    const root = document.documentElement;
    root.style.setProperty('--seed-hex', accentHex);

    if (mode === 'light') {
      root.style.setProperty('--bg-main', this.mix(accentHex, '#ffffff', 0.92));
      root.style.setProperty('--bg-sidebar', this.mix(accentHex, '#ffffff', 0.89));
      root.style.setProperty('--bg-card', '#ffffff');
      root.style.setProperty('--bg-card-hover', this.mix(accentHex, '#ffffff', 0.86));
      root.style.setProperty('--bg-elevated', this.mix(accentHex, '#f3f5f8', 0.88));
      root.style.setProperty('--bg-input', this.mix(accentHex, '#eef1f6', 0.9));
      root.style.setProperty('--bg-chip', this.mix(accentHex, '#ffffff', 0.84));

      root.style.setProperty('--primary', this.mix(accentHex, '#0b1526', 0.18));
      root.style.setProperty('--on-primary', '#ffffff');
      root.style.setProperty('--primary-container', this.mix(accentHex, '#ffffff', 0.76));
      root.style.setProperty('--on-primary-container', this.mix(accentHex, '#060c17', 0.65));
      root.style.setProperty('--secondary-container', this.mix(accentHex, '#ffffff', 0.83));
      root.style.setProperty('--on-secondary-container', this.mix(accentHex, '#111827', 0.6));

      root.style.setProperty('--text-main', '#141821');
      root.style.setProperty('--text-muted', '#5b6577');
      root.style.setProperty('--text-faint', '#8d96a8');
      root.style.setProperty('--border-subtle', 'rgba(15, 23, 42, 0.08)');
      root.style.setProperty('--border-sidebar', this.mix(accentHex, '#ffffff', 0.78));
      root.style.setProperty('--divider', 'rgba(15, 23, 42, 0.08)');
      root.style.setProperty('--shadow-card', '0 6px 22px rgba(15, 23, 42, 0.07)');

      root.style.setProperty('--cashew-income', '#479b38');
      root.style.setProperty('--cashew-expense', '#c94f4f');
    } else if (mode === 'amoled') {
      root.style.setProperty('--bg-main', '#000000');
      root.style.setProperty('--bg-sidebar', '#040507');
      root.style.setProperty('--bg-card', '#0e1116');
      root.style.setProperty('--bg-card-hover', '#171c24');
      root.style.setProperty('--bg-elevated', '#151a22');
      root.style.setProperty('--bg-input', '#0a0d12');
      root.style.setProperty('--bg-chip', '#161c26');

      root.style.setProperty('--primary', this.mix(accentHex, '#ffffff', 0.34));
      root.style.setProperty('--on-primary', this.mix(accentHex, '#000000', 0.78));
      root.style.setProperty('--primary-container', this.mix(accentHex, '#05070a', 0.62));
      root.style.setProperty('--on-primary-container', this.mix(accentHex, '#ffffff', 0.78));
      root.style.setProperty('--secondary-container', this.mix(accentHex, '#080b10', 0.75));
      root.style.setProperty('--on-secondary-container', this.mix(accentHex, '#ffffff', 0.7));

      root.style.setProperty('--text-main', '#f4f6fa');
      root.style.setProperty('--text-muted', '#8e9ab0');
      root.style.setProperty('--text-faint', '#586478');
      root.style.setProperty('--border-subtle', 'rgba(255, 255, 255, 0.08)');
      root.style.setProperty('--border-sidebar', this.mix(accentHex, '#000000', 0.78));
      root.style.setProperty('--divider', 'rgba(255, 255, 255, 0.08)');
      root.style.setProperty('--shadow-card', '0 8px 28px rgba(0, 0, 0, 0.5)');

      root.style.setProperty('--cashew-income', '#62ca77');
      root.style.setProperty('--cashew-expense', '#da7272');
    } else {
      /* Default Cashew Dark Material You (darkenPastel 0.90) */
      root.style.setProperty('--bg-main', this.mix(accentHex, '#0b0e14', 0.90));
      root.style.setProperty('--bg-sidebar', this.mix(accentHex, '#090c11', 0.91));
      root.style.setProperty('--bg-card', this.mix(accentHex, '#141922', 0.87));
      root.style.setProperty('--bg-card-hover', this.mix(accentHex, '#1c2330', 0.83));
      root.style.setProperty('--bg-elevated', this.mix(accentHex, '#1d2432', 0.84));
      root.style.setProperty('--bg-input', this.mix(accentHex, '#10141c', 0.90));
      root.style.setProperty('--bg-chip', this.mix(accentHex, '#1b2230', 0.84));

      root.style.setProperty('--primary', this.mix(accentHex, '#ffffff', 0.34));
      root.style.setProperty('--on-primary', this.mix(accentHex, '#04080f', 0.78));
      root.style.setProperty('--primary-container', this.mix(accentHex, '#0d121a', 0.58));
      root.style.setProperty('--on-primary-container', this.mix(accentHex, '#ffffff', 0.80));
      root.style.setProperty('--secondary-container', this.mix(accentHex, '#10151f', 0.72));
      root.style.setProperty('--on-secondary-container', this.mix(accentHex, '#ffffff', 0.70));

      root.style.setProperty('--text-main', '#f1f4f9');
      root.style.setProperty('--text-muted', '#95a2b8');
      root.style.setProperty('--text-faint', '#5f6c80');
      root.style.setProperty('--border-subtle', 'rgba(255, 255, 255, 0.065)');
      root.style.setProperty('--border-sidebar', this.mix(accentHex, '#0d1117', 0.70));
      root.style.setProperty('--divider', 'rgba(255, 255, 255, 0.07)');
      root.style.setProperty('--shadow-card', '0 8px 26px rgba(0, 0, 0, 0.25)');

      root.style.setProperty('--cashew-income', '#62ca77');
      root.style.setProperty('--cashew-expense', '#da7272');
    }
  }
};

window.createInitialSeedState = function () {
  // Fixed baseline timestamp so real cloud edits ALWAYS supersede fresh local demo data
  const now = 1700000000000;
  const todayISO = new Date().toISOString().slice(0, 10);
  const daysOffset = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  const DEFAULT_APP_LOGO_URL = 'https://scontent-lga3-3.cdninstagram.com/v/t51.82787-19/606685381_17868023541519134_8280792384950894045_n.jpg?_nc_cat=104&ig_cache_key=GMVIKSQe0wds33o-AN39wfPMSOtybmNDAQAB0j-ccb7-5&ccb=7-5&_nc_sid=669407&efg=eyJ2ZW5jb2RlX3RhZyI6InByb2ZpbGVfcGljLnd3dy4xMDAwLkMzIn0%3D&_nc_ohc=XoChwT7NjDMQ7kNvwHHrNGQ&_nc_oc=Adq5cWvNu3r6LVZppW29nz2oLxqeR037W4lg4GfiXCC2cKFv_5Rl6kmbTcwsdAHIFFw&_nc_zt=24&_nc_ht=scontent-lga3-3.cdninstagram.com&_nc_gid=AbK_kK4q56fCpnrYjqQJ-Q&_nc_ss=79aaf&oh=00_AQT-XpleaSO6iVOX3yRRjSaC5geQ-tbpf5_2dpWhBNw-mQ&oe=6AEDE0E0';
  window.DEFAULT_DOOMLATER_LOGO_URL = DEFAULT_APP_LOGO_URL;

  return {
    schemaVersion: 2,
    isSeedOnly: true,
    primaryCurrency: 'USD',
    appLogoUrl: DEFAULT_APP_LOGO_URL,
    rev: 1,
    updatedAt: now,
    updatedBy: 'doom1',

    profiles: window.createDefaultProfilesList(),

    chatMessages: [],

    botConversations: [],
    botMessages: [],
    partnerPendingRegistrations: [],
    partnerReminders: [],
    botConfig: {
      typingDelaySec: 3.5,
      showTypingIndicator: true,
      showOnlinePresence: true,
      geminiApiKey: '',
      whatsappConnected: false,
      whatsappQr: null,
      instagramConnected: false,
      messengerDoom1Connected: false,
      messengerDoom2Connected: false,
      messengerRedirectMessage: '¡Hola! Gracias por contactarnos en Doomlater.Corp 📱. Para brindarte atención inmediata con stock en tiempo real y coordinar envíos o entregas, por favor escríbenos directamente a nuestro WhatsApp oficial: +58 412 0000000 o toca este enlace: https://wa.me/584120000000 ¡Te atenderemos de inmediato!',
      paymentMethods: [
        { id: 'pm_1', name: 'Pago Móvil / Banco', details: 'Banco Banesco (0134) • C.I: 12.345.678 • Tlf: 0412-1234567' },
        { id: 'pm_2', name: 'Binance Pay / USDT', details: 'Pay ID: 123456789 • Red TRC20 / Binance Pay' },
        { id: 'pm_3', name: 'Efectivo Divisas ($)', details: 'Entrega personal en tienda física o delivery en divisas exactas' }
      ],
      knowledgeBaseFaq: [
        { id: 'faq_1', question: '¿Hacen envíos o delivery?', answer: 'Sí, contamos con servicio de delivery en la ciudad y envíos nacionales asegurados a través de MRW, Zoom y Tealca.' },
        { id: 'faq_2', question: '¿Los productos y servicios tienen garantía?', answer: 'Sí, todos los productos nuevos cuentan con garantía de 30 días y los servicios técnicos son probados detalladamente antes de la entrega.' },
        { id: 'faq_3', question: '¿Dónde están ubicados y cuál es el horario?', answer: 'Estamos ubicados en nuestro local comercial. Atendemos de Lunes a Sábado de 9:00 AM a 6:00 PM.' }
      ],
      serviceInsumosMap: [
        { id: 'srv_1', serviceName: 'Servicio Técnico / Cambio de Pantalla', defaultInsumoName: 'Pantalla Repuesto', defaultLaborPrice: 40 }
      ]
    },

    approvalRequests: [],

    currencyRatesCustom: [],

    wallets: [
      {
        id: 'w_binance',
        cashewPk: '0',
        name: 'Binance (USDT)',
        currency: 'USDT',
        symbol: '$',
        startingBalance: 335.50,
        color: '#d49b4b',
        iconPng: 'crypto.png',
        icon: 'currency_bitcoin',
        updatedAt: now,
        updatedBy: 'doom1'
      },
      {
        id: 'w_efectivo',
        name: 'Efectivo Caja ($)',
        currency: 'USD',
        symbol: '$',
        startingBalance: 353.00,
        color: '#4db685',
        iconPng: 'cash-bill-dollar.png',
        icon: 'payments',
        updatedAt: now,
        updatedBy: 'doom1'
      },
      {
        id: 'w_banco',
        name: 'Pago Móvil / Banco',
        currency: 'USD',
        symbol: '$',
        startingBalance: 146.20,
        color: '#5f85c2',
        iconPng: 'bank.png',
        icon: 'account_balance',
        updatedAt: now,
        updatedBy: 'doom2'
      }
    ],

    categories: [
      { id: '0', cashewPk: '0', name: 'Corrección de Balance', type: 'both', color: '#607d8b', iconPng: 'charts.png', icon: 'tune', updatedAt: now },
      { id: 'c_ventas', name: 'Ventas Stock', type: 'income', color: '#4db685', iconPng: 'shopping.png', icon: 'shopping_bag', updatedAt: now },
      { id: 'c_servicio', name: 'Servicio Técnico', type: 'income', color: '#5f85c2', iconPng: 'gears.png', icon: 'handyman', updatedAt: now },
      { id: 'c_otros_ing', name: 'Otros Ingresos', type: 'income', color: '#4ba3b5', iconPng: 'coin.png', icon: 'auto_awesome', updatedAt: now },
      { id: 'c_mercancia', name: 'Compra Mercancía', type: 'expense', color: '#8e7cc3', iconPng: 'package.png', icon: 'inventory_2', updatedAt: now },
      { id: 'c_insumos', name: 'Repuestos e Insumos', type: 'expense', color: '#d49b4b', iconPng: 'laptop.png', icon: 'memory', updatedAt: now },
      { id: 'c_envios', name: 'Envíos y Logística', type: 'expense', color: '#4ba3b5', iconPng: 'delivery-truck.png', icon: 'local_shipping', updatedAt: now },
      { id: 'c_operativo', name: 'Servicios y Facturas', type: 'expense', color: '#d9738a', iconPng: 'bills.png', icon: 'bolt', updatedAt: now },
      { id: 'c_comida', name: 'Comida y Bebidas', type: 'expense', color: '#e07a5f', iconPng: 'cutlery.png', icon: 'restaurant', updatedAt: now },
      { id: 'c_transporte', name: 'Transporte', type: 'expense', color: '#6577e0', iconPng: 'tram.png', icon: 'directions_car', updatedAt: now },
      { id: 'c_ahorro', name: 'Ahorro y Metas', type: 'both', color: '#4db685', iconPng: 'piggy-bank.png', icon: 'savings', updatedAt: now },
      { id: 'c_retiro', name: 'Reparto / Socios', type: 'expense', color: '#d16666', iconPng: 'wallet.png', icon: 'account_balance_wallet', updatedAt: now }
    ],

    stockItems: [
      {
        id: 'st_switch_oled',
        name: 'Nintendo Switch OLED + Magia 128GB',
        sku: 'CON-SW-01',
        kind: 'para_vender',
        category: 'Consolas',
        icon: 'sports_esports',
        iconPng: 'portable-game-console.png',
        color: '#d16666',
        stock: 2,
        minStock: 1,
        purchaseCost: 190,
        extraCost: 25,
        extraDetail: 'Chip RP2040 + MicroSD 128GB',
        salePrice: 310,
        notes: 'Lista en caja con accesorios originales, probada al 100%.',
        imageUrl: '',
        updatedAt: now,
        updatedBy: 'doom1'
      },
      {
        id: 'st_dualsense_he',
        name: 'Control DualSense PS5 (Hall Effect)',
        sku: 'ACC-PS5-02',
        kind: 'para_vender',
        category: 'Controles',
        icon: 'stadia_controller',
        iconPng: 'gamepad.png',
        color: '#5f85c2',
        stock: 4,
        minStock: 2,
        purchaseCost: 25,
        extraCost: 8,
        extraDetail: 'Joysticks magnéticos anti-drift nuevos',
        salePrice: 60,
        notes: 'Garantía 3 meses sin drift. Colores blanco y negro.',
        imageUrl: '',
        updatedAt: now,
        updatedBy: 'doom2'
      },
      {
        id: 'st_ps4_slim',
        name: 'PlayStation 4 Slim 1TB + 2 Controles',
        sku: 'CON-PS4-03',
        kind: 'para_vender',
        category: 'Consolas',
        icon: 'videogame_asset',
        iconPng: 'gamepad.png',
        color: '#4ba3b5',
        stock: 1,
        minStock: 1,
        purchaseCost: 135,
        extraCost: 10,
        extraDetail: 'Mantenimiento completo + pasta térmica',
        salePrice: 215,
        notes: 'Firmware 11.00 lista para entregar.',
        imageUrl: '',
        updatedAt: now,
        updatedBy: 'doom1'
      },
      {
        id: 'st_xbox_series_s',
        name: 'Xbox Series S 512GB (En Preparación)',
        sku: 'TAL-XBX-04',
        kind: 'en_preparacion',
        category: 'Consolas',
        icon: 'build',
        iconPng: 'gears.png',
        color: '#4db685',
        stock: 1,
        minStock: 0,
        purchaseCost: 140,
        extraCost: 15,
        extraDetail: 'Cambio fuente interna y limpieza',
        salePrice: 230,
        notes: 'Falta prueba de estrés de 2 horas para pasar a venta.',
        imageUrl: '',
        updatedAt: now,
        updatedBy: 'doom2'
      },
      {
        id: 'st_hdmi_ports',
        name: 'Puertos HDMI PS4 / PS5 Originales',
        sku: 'INS-HDMI-05',
        kind: 'insumo',
        category: 'Repuestos Taller',
        icon: 'cable',
        iconPng: 'socket.png',
        color: '#d49b4b',
        stock: 2,
        minStock: 5,
        purchaseCost: 3.5,
        extraCost: 0,
        extraDetail: 'Uso en taller o venta directa',
        salePrice: 10,
        notes: 'Stock bajo: pedir lote de 15 unidades.',
        imageUrl: '',
        updatedAt: now,
        updatedBy: 'doom2'
      },
      {
        id: 'st_joysticks_hall',
        name: 'Par Joysticks Hall Effect (PS5 / Xbox)',
        sku: 'INS-HALL-06',
        kind: 'insumo',
        category: 'Repuestos Taller',
        icon: 'memory',
        iconPng: 'gears.png',
        color: '#8e7cc3',
        stock: 12,
        minStock: 4,
        purchaseCost: 4.0,
        extraCost: 0,
        extraDetail: 'Calibración rápida',
        salePrice: 12,
        notes: 'Disponibles en gaveta A2.',
        imageUrl: '',
        updatedAt: now,
        updatedBy: 'doom1'
      }
    ],

    stockMovements: [
      {
        id: 'mv_1',
        stockId: 'st_switch_oled',
        itemName: 'Nintendo Switch OLED + Magia 128GB',
        action: 'venta',
        qtyChange: -1,
        newStock: 2,
        unitPrice: 310,
        profit: 95,
        note: 'Venta cliente entrega directa',
        date: daysOffset(-2),
        time: '15:40',
        createdAt: now - 172800000,
        updatedAt: now - 172800000,
        updatedBy: 'doom1'
      },
      {
        id: 'mv_2',
        stockId: 'st_dualsense_he',
        itemName: 'Control DualSense PS5 (Hall Effect)',
        action: 'ingreso',
        qtyChange: 4,
        newStock: 4,
        unitPrice: 60,
        profit: 0,
        note: 'Lote preparado y calibrado para vitrina',
        date: daysOffset(-1),
        time: '11:15',
        createdAt: now - 86400000,
        updatedAt: now - 86400000,
        updatedBy: 'doom2'
      }
    ],

    transactions: [
      {
        id: 'tx_1',
        title: 'Venta Nintendo Switch OLED + Magia',
        amount: 310,
        type: 'income',
        categoryId: 'c_ventas',
        walletId: 'w_binance',
        date: daysOffset(-2),
        time: '15:40',
        paid: true,
        note: 'Costo base $190 + $25 taller (Ganancia neta: +$95)',
        stockId: 'st_switch_oled',
        costBasis: 215,
        createdAt: now - 172800000,
        updatedAt: now - 172800000,
        updatedBy: 'doom1'
      },
      {
        id: 'tx_2',
        title: 'Cambio Puerto HDMI PS4 Pro + Mant.',
        amount: 45,
        type: 'income',
        categoryId: 'c_servicio',
        walletId: 'w_banco',
        date: daysOffset(-1),
        time: '16:20',
        paid: true,
        note: '1x Puerto HDMI + Pasta térmica alta conductividad',
        costBasis: 6,
        createdAt: now - 90000000,
        updatedAt: now - 90000000,
        updatedBy: 'doom2'
      },
      {
        id: 'tx_3',
        title: 'Compra lote Joysticks Hall Effect y Flux',
        amount: 33,
        type: 'expense',
        categoryId: 'c_insumos',
        walletId: 'w_efectivo',
        date: daysOffset(-1),
        time: '10:05',
        paid: true,
        note: 'Reposición repuestos de taller',
        createdAt: now - 80000000,
        updatedAt: now - 80000000,
        updatedBy: 'doom2'
      },
      {
        id: 'tx_4',
        title: 'Envío encomienda repuestos',
        amount: 6,
        type: 'expense',
        categoryId: 'c_envios',
        walletId: 'w_banco',
        date: todayISO,
        time: '09:30',
        paid: true,
        note: 'Zoom / MRW guía pagada',
        createdAt: now - 14000000,
        updatedAt: now - 14000000,
        updatedBy: 'doom1'
      }
    ],

    budgets: [
      {
        id: 'bg_compras_mes',
        name: 'Presupuesto Compras & Insumos',
        limit: 450,
        period: 'monthly',
        categoryIds: ['c_mercancia', 'c_insumos', 'c_envios', 'c_operativo'],
        color: '#5f85c2',
        pinned: true,
        updatedAt: now,
        updatedBy: 'doom1'
      },
      {
        id: 'bg_gastos_op',
        name: 'Gastos Operativos y Envíos',
        limit: 120,
        period: 'monthly',
        categoryIds: ['c_envios', 'c_operativo'],
        color: '#d9738a',
        pinned: true,
        updatedAt: now,
        updatedBy: 'doom2'
      }
    ],

    goals: [
      {
        id: 'gl_lote_consolas',
        name: 'Fondo Nuevo Lote Consolas',
        targetAmount: 1000,
        currentAmount: 420,
        color: '#4db685',
        iconPng: 'portable-game-console.png',
        icon: 'sports_esports',
        note: 'Meta compartida para importar lote Switch / PS5',
        updatedAt: now,
        updatedBy: 'doom1'
      },
      {
        id: 'gl_microscopio',
        name: 'Microscopio Trinocular & Estación',
        targetAmount: 350,
        currentAmount: 185,
        color: '#8e7cc3',
        iconPng: 'science.png',
        icon: 'biotech',
        note: 'Mejora de equipamiento del taller',
        updatedAt: now,
        updatedBy: 'doom2'
      }
    ],

    obligations: [
      {
        id: 'ob_1',
        title: 'Internet Fibra Taller / Tienda',
        amount: 25,
        kind: 'subscription',
        dueDate: daysOffset(4),
        time: '09:00',
        walletId: 'w_banco',
        categoryId: 'c_operativo',
        person: 'Proveedor Fibra',
        note: 'Mensualidad fija internet fibra óptica',
        settled: false,
        updatedAt: now,
        updatedBy: 'doom1'
      },
      {
        id: 'ob_2',
        title: 'Restante reparación PS5 (Cliente Carlos)',
        amount: 35,
        kind: 'credit',
        dueDate: todayISO,
        time: '17:00',
        walletId: 'w_efectivo',
        categoryId: 'c_servicio',
        person: 'Carlos M.',
        note: 'Dejó $20 de abono, paga $35 al retirar',
        settled: false,
        updatedAt: now,
        updatedBy: 'doom2'
      },
      {
        id: 'ob_3',
        title: 'Encomienda Lote Pantallas Switch',
        amount: 18,
        kind: 'upcoming',
        dueDate: daysOffset(2),
        time: '14:00',
        walletId: 'w_binance',
        categoryId: 'c_envios',
        person: 'Courier Internacional',
        note: 'Pago al llegar paquete a agencia',
        settled: false,
        updatedAt: now,
        updatedBy: 'doom1'
      },
      {
        id: 'ob_4',
        title: 'Saldo proveedor repuestos micro-soldadura',
        amount: 22,
        kind: 'debt',
        dueDate: daysOffset(-1),
        time: '12:00',
        walletId: 'w_efectivo',
        categoryId: 'c_insumos',
        person: 'Distribuidora Tech',
        note: 'Pendiente liquidar factura lote estaño/flux',
        settled: false,
        updatedAt: now,
        updatedBy: 'doom2'
      }
    ]
  };
};
