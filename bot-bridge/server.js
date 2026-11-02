/**
 * ============================================================================
 * DOOMLATER.CORP - 24/7 BOT BRIDGE  (v2)
 * WhatsApp (Baileys: QR real o código de 8 dígitos), Instagram DM y
 * Facebook Messenger (Webhook oficial de Meta) + IA Gemini + Firebase RTDB.
 *
 * Nodos de Firebase usados (fuera del workspace para no chocar con la web):
 *   cashew_doom_bot_status    -> estado del servidor / WhatsApp / Meta (lo escribe SOLO el servidor)
 *   cashew_doom_bot_commands  -> órdenes desde la web (pedir código, QR nuevo, desvincular)
 *   cashew_doom_bot_outbox    -> mensajes manuales que la web quiere enviar al cliente
 *   cashew_doom_bot_media     -> imágenes recibidas (capturas de pago, etc.)
 *   cashew_doom_bot_auth      -> sesión de WhatsApp CIFRADA (AES-256-GCM con WA_AUTH_SECRET)
 * ============================================================================
 */

import express from 'express';
import dotenv from 'dotenv';
import qrcode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import makeWASocketImport, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  getContentType,
  downloadMediaMessage,
  isJidGroup,
  isJidBroadcast,
  isJidNewsletter,
  Browsers
} from '@whiskeysockets/baileys';

const makeWASocket = makeWASocketImport.default || makeWASocketImport;

import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config();

/* --------------------------------------------------------------------------
   CONFIGURACIÓN
   -------------------------------------------------------------------------- */
const SERVER_VERSION = '2.1.0';
const PORT = process.env.PORT || 3000;
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || 'https://ok-gogle-c018c-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const ROOT = 'cashew_doom_v1';
const STATUS_PATH = 'cashew_doom_bot_status';
const COMMANDS_PATH = 'cashew_doom_bot_commands';
const OUTBOX_PATH = 'cashew_doom_bot_outbox';
const MEDIA_PATH = 'cashew_doom_bot_media';
const AUTH_PATH = 'cashew_doom_bot_auth';

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'doomlater_meta_secret_2026';
const META_PAGE_TOKEN = process.env.META_PAGE_ACCESS_TOKEN || '';
const IG_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || '';
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const GEMINI_API_KEY_ENV = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL_ENV = process.env.GEMINI_MODEL || '';
const WA_AUTH_SECRET = process.env.WA_AUTH_SECRET || '';
const WA_DISABLED = process.env.WA_DISABLED === '1';
const RENDER_URL = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

const OFFICIAL_WA_NUMBER = (process.env.OFFICIAL_WA_NUMBER || '584245323796').replace(/\D/g, '');
const DEFAULT_REDIRECT = `¡Hola! Gracias por contactarnos en Doomlater.Corp 📱. Para atenderte de inmediato con stock en tiempo real, escríbenos a nuestro WhatsApp oficial: +${OFFICIAL_WA_NUMBER} o toca este enlace: https://wa.me/${OFFICIAL_WA_NUMBER} ¡Te atenderemos enseguida!`;

const INSTANCE_ID = `inst_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
const INSTANCE_HOST = RENDER_URL ? `render (${RENDER_URL})` : `local (${os.hostname()})`;
const STARTED_AT = Date.now();

const logger = pino({ level: 'info' });
const silentLogger = pino({ level: 'silent' });

const app = express();
app.use(express.json({
  limit: '5mb',
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* --------------------------------------------------------------------------
   FIREBASE REST
   -------------------------------------------------------------------------- */
async function fb(method, absPath, data, query = '') {
  const url = `${FIREBASE_DB_URL}/${absPath}.json${query ? `?${query}` : ''}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    if (!res.ok) {
      logger.error({ method, absPath, status: res.status, body: (await res.text()).slice(0, 300) }, 'Firebase error');
      return null;
    }
    return await res.json();
  } catch (err) {
    logger.error({ method, absPath, err: err.message }, 'Firebase request failed');
    return null;
  }
}
const ws = (sub) => `${ROOT}/${sub}`;

/** Timestamp siempre mayor que el anterior (la web resuelve conflictos con updatedAt). */
const stampAfter = (existing) => Math.max(Date.now(), (Number(existing && existing.updatedAt) || 0) + 1);

/** Ids seguros para claves de Firebase. */
const safeId = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 20);

async function touchMeta(label) {
  const now = Date.now();
  await fb('PATCH', ws('meta'), {
    updatedAt: now,
    rev: now,
    lastLabel: label,
    lastClientId: 'bot_bridge',
    updatedBy: 'bot'
  });
}

/* --------------------------------------------------------------------------
   ESTADO PÚBLICO DEL SERVIDOR (lo lee la pestaña "Conectar Canales")
   -------------------------------------------------------------------------- */
let isOwner = false;

async function setWaStatus(data) {
  if (!isOwner) return;
  await fb('PATCH', `${STATUS_PATH}/whatsapp`, { ...data, updatedAt: Date.now() });

  // Mirror to meta/botConfig so the web client gets real-time QR / pairing code / connection status
  const patch = {};
  if (data.connected !== undefined) patch.whatsappConnected = data.connected;
  if (data.qr !== undefined) patch.whatsappQr = data.qr;
  if (data.pairingCode !== undefined) patch.whatsappPairingCode = data.pairingCode;
  if (data.pairingPhone !== undefined) patch.whatsappPairingPhone = data.pairingPhone;
  if (Object.keys(patch).length > 0) {
    await fb('PATCH', ws('meta/botConfig'), patch);
    await touchMeta('Estado de WhatsApp actualizado');
  }
}
async function setMetaStatus(data) {
  await fb('PATCH', `${STATUS_PATH}/meta`, {
    ...data,
    host: INSTANCE_HOST,
    pageTokenConfigured: Boolean(META_PAGE_TOKEN),
    instagramTokenConfigured: Boolean(IG_TOKEN || META_PAGE_TOKEN),
    updatedAt: Date.now()
  });
}

async function claimOwnership(reason) {
  isOwner = true;
  await fb('PATCH', STATUS_PATH, {
    instanceId: INSTANCE_ID,
    host: INSTANCE_HOST,
    version: SERVER_VERSION,
    startedAt: STARTED_AT,
    heartbeatAt: Date.now(),
    claimReason: reason,
    authPersistence: Boolean(WA_AUTH_SECRET)
  });
  logger.info({ reason, INSTANCE_ID }, 'Esta instancia controla WhatsApp');
}

/* --------------------------------------------------------------------------
   PERSISTENCIA CIFRADA DE LA SESIÓN DE WHATSAPP
   (Render borra el disco al reiniciar; sin esto tendrías que vincular cada día)
   -------------------------------------------------------------------------- */
const authFolder = path.resolve(process.env.WA_AUTH_DIR || 'baileys_auth');
const syncMarker = path.join(authFolder, '.synced_at');
let lastBackupHash = null;

function aesKey() {
  return crypto.createHash('sha256').update(WA_AUTH_SECRET).digest();
}
function encryptText(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decryptText(blob) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey(), Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]).toString('utf8');
}
function readAuthFiles() {
  if (!fs.existsSync(authFolder)) return {};
  const files = {};
  for (const f of fs.readdirSync(authFolder)) {
    if (f.endsWith('.json')) files[f] = fs.readFileSync(path.join(authFolder, f), 'utf8');
  }
  return files;
}
function wipeLocalAuth() {
  if (!fs.existsSync(authFolder)) return;
  for (const f of fs.readdirSync(authFolder)) {
    try { fs.unlinkSync(path.join(authFolder, f)); } catch (e) {}
  }
}

async function backupAuthNow() {
  if (!WA_AUTH_SECRET || !isOwner) return;
  const files = readAuthFiles();
  if (!files['creds.json']) return;
  const json = JSON.stringify(files);
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  if (hash === lastBackupHash) return;
  const savedAt = Date.now();
  const ok = await fb('PUT', AUTH_PATH, { ...encryptText(json), savedAt, by: INSTANCE_ID, files: Object.keys(files).length });
  if (ok) {
    lastBackupHash = hash;
    fs.writeFileSync(syncMarker, String(savedAt));
  }
}

async function remoteAuthIsUsable() {
  if (!WA_AUTH_SECRET) return false;
  const blob = await fb('GET', AUTH_PATH);
  if (!blob || !blob.data) return false;
  try { JSON.parse(decryptText(blob)); return true; } catch (e) { return false; }
}

async function restoreAuthIfNewer() {
  if (!WA_AUTH_SECRET) return;
  const blob = await fb('GET', AUTH_PATH);
  if (!blob || !blob.data) return;
  const localSavedAt = fs.existsSync(syncMarker) ? Number(fs.readFileSync(syncMarker, 'utf8')) || 0 : 0;
  const credsPath = path.join(authFolder, 'creds.json');
  const hasLocal = fs.existsSync(credsPath);
  let localIsRegistered = false;
  if (hasLocal) {
    try {
      const c = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      localIsRegistered = Boolean(c && c.me && c.me.id);
    } catch (e) {}
  }
  if (localIsRegistered && localSavedAt >= Number(blob.savedAt || 0)) return;
  let files;
  try {
    const json = decryptText(blob);
    files = JSON.parse(json);
    lastBackupHash = crypto.createHash('sha256').update(json).digest('hex');
  } catch (e) {
    logger.error('No se pudo descifrar la sesión guardada: WA_AUTH_SECRET es distinto al usado al vincular.');
    return;
  }
  fs.mkdirSync(authFolder, { recursive: true });
  wipeLocalAuth();
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(authFolder, path.basename(name)), content);
  }
  fs.writeFileSync(syncMarker, String(blob.savedAt || Date.now()));
  logger.info({ files: Object.keys(files).length }, 'Sesión de WhatsApp restaurada desde Firebase');
}

async function clearAuthEverywhere() {
  wipeLocalAuth();
  lastBackupHash = null;
  await fb('DELETE', AUTH_PATH);
}

/* --------------------------------------------------------------------------
   IA (GEMINI) + RESPALDO POR REGLAS
   -------------------------------------------------------------------------- */
const convHistory = new Map(); // convId -> [{role, text}]
function pushHistory(convId, role, text) {
  const arr = convHistory.get(convId) || [];
  arr.push({ role, text: String(text || '').slice(0, 600) });
  while (arr.length > 12) arr.shift();
  convHistory.set(convId, arr);
}

const DEFAULT_PAYMENT_METHODS = [
  { id: 'pm_1', name: 'Pago Móvil / Banco', details: 'Banco Banesco (0134) • C.I: 12.345.678 • Tlf: 0412-1234567' },
  { id: 'pm_2', name: 'Binance Pay / USDT', details: 'Pay ID: 123456789 • Red TRC20 / Binance Pay' },
  { id: 'pm_3', name: 'Efectivo Divisas ($)', details: 'Entrega personal en tienda física o delivery en divisas exactas' }
];

const DEFAULT_FAQ = [
  { id: 'faq_1', question: '¿Qué productos y servicios ofrecen en Doomlater.Corp?', answer: 'En Doomlater.Corp nos especializamos en venta de consolas de videojuegos (PlayStation, Nintendo Switch, Xbox), accesorios, controles, videojuegos, y servicio técnico especializado (mantenimiento preventivo, cambio de pastas térmicas, reparación de controles drift/botones, pantallas y puertos de carga).' },
  { id: 'faq_2', question: '¿Hacen envíos o delivery?', answer: 'Sí, contamos con servicio de delivery en la ciudad y envíos nacionales asegurados a través de MRW, Zoom y Tealca.' },
  { id: 'faq_3', question: '¿Los productos y servicios tienen garantía?', answer: 'Sí, todos nuestros productos cuentan con garantía de 30 días y los servicios técnicos son probados detalladamente antes de la entrega.' },
  { id: 'faq_4', question: '¿Dónde están ubicados y cuál es el horario de atención?', answer: 'Estamos ubicados en nuestro local comercial. Atendemos de Lunes a Sábado de 9:00 AM a 6:00 PM.' }
];

/* --------------------------------------------------------------------------
   SOCIOS / ADMINISTRADORES AUTORIZADOS (Anthony y Socio)
   -------------------------------------------------------------------------- */
const PARTNER_ACCOUNTS = [
  {
    name: 'Anthony',
    profileId: 'doom1',
    phone: '584142005801',
    jids: ['268135210995915@lid', '584142005801@s.whatsapp.net']
  },
  {
    name: 'Socio',
    profileId: 'doom2',
    phone: '584264181643',
    jids: ['584264181643@s.whatsapp.net']
  }
];

const partnerAlertCooldown = new Map();

function isAuthorizedPartner(phoneOrJid) {
  if (!phoneOrJid) return null;
  const raw = String(phoneOrJid).toLowerCase();
  const digits = raw.replace(/\D/g, '');
  for (const p of PARTNER_ACCOUNTS) {
    if (p.jids && p.jids.some(j => raw.includes(j.toLowerCase()))) return p;
    if (digits && (digits.endsWith(p.phone) || (p.phone.endsWith(digits) && digits.length >= 10))) return p;
    if (raw.includes(p.phone)) return p;
  }
  return null;
}

async function notifyPartners(text, alertKey = null) {
  if (!waSock || waState !== 'connected') return;
  if (alertKey) {
    const last = partnerAlertCooldown.get(alertKey) || 0;
    if (Date.now() - last < 15 * 60 * 1000) return; // Cooldown de 15 min para evitar alertas repetidas
    partnerAlertCooldown.set(alertKey, Date.now());
  }

  for (const p of PARTNER_ACCOUNTS) {
    for (const jid of p.jids) {
      try {
        await waSend(jid, { text });
        break; // Enviado con éxito a este socio
      } catch (err) {
        logger.warn({ target: p.name, jid, err: err.message }, 'No se pudo enviar alerta por este JID, probando alternativo');
      }
    }
  }
}

async function notifySinglePartner(target, text) {
  if (!waSock || waState !== 'connected') return;
  const targetLower = String(target || '').toLowerCase();
  const p = PARTNER_ACCOUNTS.find(acc =>
    acc.name.toLowerCase() === targetLower ||
    acc.profileId === targetLower ||
    acc.phone.includes(targetLower)
  );
  if (!p) return;
  for (const jid of p.jids) {
    try {
      await waSend(jid, { text });
      break;
    } catch (err) {
      logger.warn({ target: p.name, jid, err: err.message }, 'No se pudo enviar mensaje directo al socio');
    }
  }
}

async function checkLowStockAndAlert() {
  if (!isOwner || waState !== 'connected') return;
  try {
    const stockRaw = await fb('GET', ws('stockItems'));
    if (!stockRaw) return;
    const items = Object.values(stockRaw).filter(i => i && !i.deleted);
    for (const it of items) {
      const stockNum = Number(it.stock) || 0;
      const minStock = Number(it.minStock) || 2;
      if (stockNum <= minStock) {
        const key = `stock_low_${it.id}_${stockNum}`;
        const last = partnerAlertCooldown.get(key) || 0;
        if (Date.now() - last < 8 * 60 * 60 * 1000) continue; // máximo 1 alerta cada 8 horas por nivel de stock
        partnerAlertCooldown.set(key, Date.now());

        const alertMsg = stockNum <= 0
          ? `🚨 *DOOMLATER ALERT: Producto AGOTADO* 📦\n\nEl producto/insumo *${it.name}* se quedó sin stock (0 unidades).\n👉 _Atento para reposición._`
          : `⚠️ *DOOMLATER ALERT: Stock Crítico* 📦\n\nEl producto/insumo *${it.name}* tiene solo *${stockNum} unidad(es)* disponibles.\n👉 _Atento para reposición._`;

        await notifyPartners(alertMsg, key);
      }
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'Error en chequeo de stock bajo');
  }
}

async function loadAdminExecutiveContext() {
  const [walletsRaw, stockRaw, txsRaw, convsRaw] = await Promise.all([
    fb('GET', ws('wallets')),
    fb('GET', ws('stockItems')),
    fb('GET', ws('transactions')),
    fb('GET', ws('botConversations'))
  ]);

  const wallets = walletsRaw ? Object.values(walletsRaw).filter(w => w && !w.deleted) : [];
  const stock = stockRaw ? Object.values(stockRaw).filter(i => i && !i.deleted) : [];
  const txs = txsRaw ? Object.values(txsRaw).filter(t => t && !t.deleted) : [];
  const convs = convsRaw ? Object.values(convsRaw).filter(c => c && !c.deleted) : [];

  const walletBalances = wallets.map(w => {
    let bal = Number(w.startingBalance) || 0;
    for (const t of txs) {
      if (t.paid === false) continue;
      const amt = Number(t.amount) || 0;
      if (t.walletId === w.id) {
        if (t.type === 'income') bal += amt;
        else if (t.type === 'expense') bal -= amt;
        else if (t.type === 'transfer') bal -= amt;
      }
      if (t.destinationWalletId === w.id && t.type === 'transfer') {
        bal += Number(t.destinationAmount || amt);
      }
    }
    return {
      id: w.id,
      name: w.name,
      currency: w.currency || 'USD',
      symbol: w.symbol || '$',
      balance: bal
    };
  });

  let totalUsd = 0;
  for (const wb of walletBalances) {
    if (wb.currency === 'USDT' || wb.currency === 'USD' || wb.name.toLowerCase().includes('usd') || wb.name.toLowerCase().includes('binance') || wb.name.toLowerCase().includes('efectivo')) {
      totalUsd += wb.balance;
    }
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayTxs = txs.filter(t => (t.date === todayStr || (t.createdAt && new Date(t.createdAt).toISOString().slice(0, 10) === todayStr)) && t.paid !== false);
  const todayIncome = todayTxs.filter(t => t.type === 'income').reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const todayProfit = todayTxs.filter(t => t.type === 'income').reduce((s, t) => s + (Number(t.netProfit || t.amount) || 0), 0);

  const sellables = stock.filter(i => i.kind === 'para_vender');
  const insumos = stock.filter(i => i.kind === 'insumo');
  const lowStock = stock.filter(i => (Number(i.stock) || 0) <= (Number(i.minStock) || 2));
  const zeroStock = stock.filter(i => (Number(i.stock) || 0) <= 0);
  const pendingPayments = convs.filter(c => c.pendingPayment);

  return {
    walletBalances,
    totalUsd,
    todayIncome,
    todayProfit,
    stock,
    sellables,
    insumos,
    lowStock,
    zeroStock,
    pendingPayments
  };
}

function buildAdminSystemPrompt(adminCtx, partnerName) {
  const walletsSummary = adminCtx.walletBalances.map(w => {
    const isBs = w.currency === 'VES' || w.name.toLowerCase().includes('cuenta');
    const val = isBs ? `Bs. ${w.balance.toFixed(2)}` : `$${w.balance.toFixed(2)} ${w.currency}`;
    return `- ${w.name}: ${val}`;
  }).join('\n');

  const stockSummary = adminCtx.stock.map(i => {
    const kind = i.kind === 'insumo' ? 'Insumo Taller' : 'Venta Producto';
    return `- ${i.name} (${kind} | ${i.category || 'General'}): stock ${i.stock} unidades | precio $${Number(i.salePrice || 0).toFixed(2)} | costo compra $${Number(i.purchaseCost || 0).toFixed(2)}`;
  }).join('\n');

  const lowStockSummary = adminCtx.lowStock.length > 0
    ? adminCtx.lowStock.map(i => `- ${i.name}: ${i.stock <= 0 ? 'AGOTADO (0 uds)' : `solo ${i.stock} unidad(es)`}`).join('\n')
    : 'Todo el stock en niveles óptimos';

  const pendingSummary = adminCtx.pendingPayments.length > 0
    ? adminCtx.pendingPayments.map(c => `- ${c.customerName || 'Cliente'} (${c.customerPhone || c.platform}): $${Number(c.pendingPaymentAmount || 0).toFixed(2)} por ${c.pendingPaymentItem || 'Servicio/Venta'}`).join('\n')
    : 'No hay pagos pendientes de verificar';

  return `Eres el Asistente Ejecutivo Inteligente Privado de Doomlater.Corp exclusivo para el socio fundador: ${partnerName}.
Tu función es responderle a los dueños por WhatsApp con información ejecutiva, precisa, rápida y clara sobre las finanzas, dinero acumulado, stock y estado del negocio.
Usa formato limpio de WhatsApp: negritas (*palabra*), viñetas (•) y emojis para que se lea impecable en el teléfono.

=== BALANCES Y DINERO ACUMULADO EN TIEMPO REAL ===
Total acumulado en divisas: $${adminCtx.totalUsd.toFixed(2)} USD
Cuentas y Billeteras:
${walletsSummary}

Ingresos registrados hoy: +$${adminCtx.todayIncome.toFixed(2)} USD
Ganancia neta registrada hoy: +$${adminCtx.todayProfit.toFixed(2)} USD

=== INVENTARIO Y STOCK EN VIVO ===
${stockSummary || '(No hay productos registrados en stock)'}

=== PRODUCTOS O INSUMOS POR AGOTARSE (STOCK CRÍTICO) ===
${lowStockSummary}

=== PAGOS PENDIENTES DE VERIFICACIÓN ===
${pendingSummary}

Instrucciones:
1. Si pregunta cuánto dinero tenemos o acumulado o saldo o balance o caja: Indícale el Total Acumulado en divisas y el desglose de cada billetera/cuenta.
2. Si pregunta por un producto específico (ej: "¿cuántos cargadores de 3ds quedan?"): Busca en la lista y dile exactamente cuántas unidades quedan, su precio de venta y su costo de compra.
3. Si pregunta qué queda en stock: da un resumen categorizado de los productos para la venta e insumos.
4. Si pregunta qué falta o qué está por acabarse: lista los que tienen stock bajo o agotado.
5. Si pregunta por pagos pendientes: dile si hay clientes con comprobante en espera de verificación.
6. Habla con confianza, tono de socio colaborador, ágil y directo.`;
}

function fallbackAdminRuleBased(userText, ctx, partnerName) {
  const q = String(userText || '').toLowerCase().trim();

  // 1. Dinero / Saldo / Balance / Caja / Acumulado
  if (/(dinero|plata|cuanto|cuánto|saldo|balance|caja|acumulado|cuentas|billetera)/i.test(q)) {
    const lines = [
      `💼 *Resumen Financiero Doomlater.Corp* (${partnerName})`,
      `💵 *Total Acumulado en Divisas:* $${ctx.totalUsd.toFixed(2)} USD`,
      ``,
      `*Desglose por Cuentas:*`
    ];
    for (const wb of ctx.walletBalances) {
      const isBs = wb.currency === 'VES' || wb.name.toLowerCase().includes('cuenta');
      const valStr = isBs ? `Bs. ${wb.balance.toFixed(2)}` : `$${wb.balance.toFixed(2)} ${wb.currency}`;
      lines.push(`• *${wb.name}:* ${valStr}`);
    }
    if (ctx.todayIncome > 0) {
      lines.push(``, `📈 *Ingresos hoy:* +$${ctx.todayIncome.toFixed(2)} (Ganancia neta: +$${ctx.todayProfit.toFixed(2)})`);
    }
    return lines.join('\n');
  }

  // 2. Faltantes / Por agotarse / Stock bajo
  if (/(falta|por acabarse|agotad|bajo|terminar|reponer)/i.test(q)) {
    if (ctx.lowStock.length === 0) {
      return `✅ *Todo el stock en orden!*\nNo hay productos ni insumos con stock crítico en este momento.`;
    }
    const lines = [`⚠️ *Productos e Insumos por Agotarse:*`, ``];
    for (const it of ctx.lowStock) {
      const tag = (Number(it.stock) || 0) <= 0 ? '🚨 AGOTADO (0 uds)' : `⚠️ Solo ${it.stock} ud(s)`;
      lines.push(`• *${it.name}* (${it.category || (it.kind === 'insumo' ? 'Insumo' : 'Producto')}): ${tag} | PVP: $${Number(it.salePrice || 0).toFixed(2)} | Costo: $${Number(it.purchaseCost || 0).toFixed(2)}`);
    }
    return lines.join('\n');
  }

  // 3. Stock general / Qué queda en stock / Inventario
  if (/(que queda|qué queda|todo el stock|inventario|lista de stock|cat[aá]logo)/i.test(q)) {
    const lines = [`📦 *Inventario Actual Doomlater.Corp:*`, ``];
    if (ctx.sellables.length > 0) {
      lines.push(`*🛍️ Para la Venta:*`);
      for (const it of ctx.sellables) {
        lines.push(`• *${it.name}:* ${it.stock} uds (PVP: $${Number(it.salePrice || 0).toFixed(2)} | Costo: $${Number(it.purchaseCost || 0).toFixed(2)})`);
      }
    }
    if (ctx.insumos.length > 0) {
      lines.push(``, `*🔧 Insumos de Taller:*`);
      for (const it of ctx.insumos) {
        lines.push(`• *${it.name}:* ${it.stock} uds (Costo: $${Number(it.purchaseCost || 0).toFixed(2)})`);
      }
    }
    if (ctx.stock.length === 0) {
      lines.push(`(No hay artículos registrados en stock aún)`);
    }
    return lines.join('\n');
  }

  // 4. Pagos pendientes / Verificaciones
  if (/(pago|pendiente|por verificar|comprobante)/i.test(q)) {
    if (ctx.pendingPayments.length === 0) {
      return `✅ *Al día!* No hay pagos pendientes por verificar en la bandeja.`;
    }
    const lines = [`🧾 *Pagos Pendientes por Verificar (${ctx.pendingPayments.length}):*`, ``];
    for (const c of ctx.pendingPayments) {
      lines.push(`• *${c.customerName || 'Cliente'}* (${c.customerPhone || c.platform}): $${Number(c.pendingPaymentAmount || 0).toFixed(2)} por ${c.pendingPaymentItem || 'Servicio/Venta'}`);
    }
    lines.push(``, `👉 _Puedes verificarlos desde la web para sumarlos a caja._`);
    return lines.join('\n');
  }

  // 5. Búsqueda específica de un producto (ej. "3ds", "cargador", etc.)
  const words = q.replace(/cuantos|cuántos|quedan|queda|de|hay|en|stock|\?|¿/gi, '').trim().split(/\s+/).filter(w => w.length >= 2);
  if (words.length > 0) {
    const matches = ctx.stock.filter(it => {
      const name = String(it.name || '').toLowerCase();
      const cat = String(it.category || '').toLowerCase();
      const extra = String(it.extraDetail || it.notes || '').toLowerCase();
      return words.some(w => name.includes(w) || cat.includes(w) || extra.includes(w));
    });

    if (matches.length > 0) {
      const lines = [`📦 *Resultado de búsqueda en Stock:*`, ``];
      for (const it of matches) {
        const estado = (Number(it.stock) || 0) <= 0 ? '🚨 AGOTADO' : `✅ Quedan *${it.stock} unidad(es)*`;
        lines.push(`• *${it.name}* (${it.category || 'Stock'}):\n  ${estado}\n  💰 Precio de venta: *$${Number(it.salePrice || 0).toFixed(2)}*\n  🏷️ Costo de compra: $${Number(it.purchaseCost || 0).toFixed(2)}`);
      }
      return lines.join('\n\n');
    }
  }

  // 6. Saludo / Ayuda por defecto
  return `👑 *Hola ${partnerName}!* Asistente de Operaciones de Doomlater.Corp listo.\n\nPuedes decirme o preguntarme por WhatsApp:\n• _"Vendí un cargador de 3DS en 15$"_ (lo registraré para verificación en la Web)\n• _"A las 4pm recuérdale a mi socio que entregue la Switch"_\n• _"¿Cuánto dinero tenemos acumulado ahorita?"_\n• _"¿Cuántos cargadores de 3ds quedan?"_\n• _"¿Qué queda en stock?"_\n• _"¿Qué falta o está por agotarse?"_\n• _"¿Hay pagos por verificar?"_`;
}

async function handlePartnerCommands(userText, adminCtx, partnerName) {
  const text = String(userText || '').trim();
  const lower = text.toLowerCase();

  // 1. REGISTRAR VENTA O COBRO POR WHATSAPP
  if (/(vend[ií]|se vendi[oó]|vendimos|registra(?:r)? venta|anota(?:r)? venta|cobr[eé]|cobramos)/i.test(lower)) {
    // Detect Amount
    const amtMatch = text.match(/(?:\$|bs\.?|usd)?\s*(\d+(?:[.,]\d{1,2})?)\s*(?:\$|usd|d[oó]lares|bs\.?|bol[ií]vares)?/i);
    let amount = amtMatch ? parseFloat(amtMatch[1].replace(',', '.')) : 0;
    if (amount <= 0) {
      const bareMatch = text.match(/(?:en|por)\s+(\d+(?:[.,]\d{1,2})?)/i);
      if (bareMatch) amount = parseFloat(bareMatch[1].replace(',', '.'));
    }

    // Detect Quantity
    let qty = 1;
    const qtyMatch = text.match(/(\d+)\s*(?:unidades?|uds?|piezas?|cargadores?|pantallas?|consolas?|juegos?)/i);
    if (qtyMatch) qty = parseInt(qtyMatch[1], 10) || 1;

    // Detect Currency & Target Wallet
    const isBs = /(bs|bol[ií]vares|pago m[oó]vil|pagomovil)/i.test(lower);
    const mentionsAnthony = /(anthony|m[ií]a|mio|doom1)/i.test(lower);
    const mentionsSocio = /(socio|doom2)/i.test(lower);

    let targetWallet = null;
    const wallets = adminCtx.walletBalances || [];

    if (isBs) {
      if (mentionsAnthony || (partnerName === 'Anthony' && !mentionsSocio)) {
        targetWallet = wallets.find(w => w.name.toLowerCase().includes('anthony') || (w.currency === 'VES' && w.name.toLowerCase().includes('doom1'))) ||
                       wallets.find(w => w.currency === 'VES') || wallets[0];
      } else {
        targetWallet = wallets.find(w => w.name.toLowerCase().includes('socio') || (w.currency === 'VES' && w.name.toLowerCase().includes('doom2'))) ||
                       wallets.find(w => w.currency === 'VES') || wallets[0];
      }
    } else {
      targetWallet = wallets.find(w => w.name.toLowerCase().includes('conjunt') || w.name.toLowerCase().includes('$') || w.currency === 'USD' || w.currency === 'USDT') || wallets[0];
    }

    if (!targetWallet) targetWallet = { id: 'w_usd_main', name: 'Cuenta Conjunta ($)', currency: 'USD' };

    // Search matching item in stock
    const cleanItemName = text
      .replace(/(?:vend[ií]|se vendi[oó]|vendimos|registra(?:r)? venta|anota(?:r)? venta|cobr[eé]|cobramos)/gi, '')
      .replace(/(?:en|por|a|de|un|una|el|la|los|las|\$|usd|d[oó]lares|bs\.?|bol[ií]vares|\d+(?:[.,]\d{1,2})?)/gi, '')
      .replace(/(?:cuenta|billetera|socio|anthony|m[ií]a|m[ií]o|conjunta)/gi, '')
      .trim();

    const queryWords = cleanItemName.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
    let matchedItem = null;
    let bestScore = 0;

    for (const it of adminCtx.stock) {
      const itName = String(it.name || '').toLowerCase();
      let score = 0;
      for (const w of queryWords) {
        if (itName.includes(w)) score += 2;
      }
      if (score > bestScore) {
        bestScore = score;
        matchedItem = it;
      }
    }

    if (amount <= 0 && matchedItem) {
      amount = (Number(matchedItem.salePrice) || 40) * qty;
    }
    if (amount <= 0) amount = 40.00;

    const unitCost = matchedItem ? (Number(matchedItem.purchaseCost) || 0) : 0;
    const costBasis = unitCost * qty;
    const netProfit = Math.max(0, amount - costBasis);
    const itemTitle = matchedItem ? matchedItem.name : (cleanItemName || 'Artículo de tienda');

    const regId = 'reg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const registeredBy = partnerName === 'Anthony' ? 'doom1' : 'doom2';
    const targetReviewer = partnerName === 'Anthony' ? 'doom2' : 'doom1';
    const nowIso = new Date().toISOString();
    const todayDate = nowIso.slice(0, 10);
    const nowTime = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

    const regData = {
      id: regId,
      registeredBy,
      registeredByName: partnerName,
      targetReviewer,
      type: matchedItem && matchedItem.kind === 'insumo' ? 'servicio' : 'venta',
      itemTitle,
      stockItemId: matchedItem ? matchedItem.id : null,
      qty,
      amount,
      costBasis,
      netProfit,
      walletId: targetWallet.id,
      walletName: targetWallet.name,
      currency: targetWallet.currency || 'USD',
      date: todayDate,
      time: nowTime,
      createdAt: Date.now(),
      status: 'pending'
    };

    await fb('PUT', ws(`partnerPendingRegistrations/${regId}`), regData);
    await touchMeta(`Venta registrada por @${partnerName} vía WhatsApp`);

    // Notify the other partner directly on WhatsApp
    const alertOther = `🔔 *DOOMLATER: Venta por Confirmar*\n\n` +
      `Tu socio *${partnerName}* (@${registeredBy}) registró por WhatsApp:\n` +
      `• *Artículo:* ${qty}x *${itemTitle}*\n` +
      `• *Cobrado:* $${amount.toFixed(2)} (${targetWallet.name})\n` +
      `• *Ganancia Neta:* +$${netProfit.toFixed(2)} (Costo: -$${costBasis.toFixed(2)})\n` +
      `• *Fecha/Hora:* ${todayDate} a las ${nowTime}\n\n` +
      `👉 _Entra a la Web para verificarla y sumarla a las transacciones oficiales._`;
    notifySinglePartner(targetReviewer, alertOther).catch(() => {});

    return `✅ *¡Venta registrada exitosamente @${partnerName}!* 🛍️\n\n` +
      `• *Artículo:* ${qty}x *${itemTitle}*\n` +
      `• *Monto Cobrado:* $${amount.toFixed(2)}\n` +
      `• *Costo de Reinversión:* -$${costBasis.toFixed(2)}\n` +
      `• *Ganancia Neta:* *+$${netProfit.toFixed(2)}*\n` +
      `• *Destino:* ${targetWallet.name}\n` +
      `• *Fecha y Hora:* ${todayDate} a las ${nowTime}\n\n` +
      `⏳ *Pendiente de verificación:* Tu socio @${targetReviewer} debe entrar a la Web para verificar y asentar la transacción en caja y stock.`;
  }

  // 2. PROGRAMAR RECORDATORIO A SOCIO
  if (/(recu[eé]rdale|recuerda a mi socio|av[ií]sale|dile a mi socio|recordatorio)/i.test(lower)) {
    const targetPartner = partnerName === 'Anthony' ? 'Socio' : 'Anthony';
    const targetPhone = partnerName === 'Anthony' ? '584264181643' : '584142005801';
    const targetJid = `${targetPhone}@s.whatsapp.net`;

    let reminderText = text
      .replace(/(?:recu[eé]rdale|recuerda a mi socio|av[ií]sale|dile a mi socio|a mi socio que|que)/gi, '')
      .replace(/(?:a las \d+(?::\d+)?\s*(?:am|pm)?|en \d+\s*(?:horas?|minutos?)|mañana)/gi, '')
      .trim();
    if (!reminderText) reminderText = 'Revisar pendientes de Doomlater.Corp';

    let delayMs = 30 * 60 * 1000;
    let timeLabel = 'en 30 minutos';

    const minMatch = lower.match(/en\s+(\d+)\s*min/);
    if (minMatch) {
      const m = parseInt(minMatch[1], 10) || 30;
      delayMs = m * 60 * 1000;
      timeLabel = `en ${m} minuto(s)`;
    }

    const hrMatch = lower.match(/en\s+(\d+)\s*hora/);
    if (hrMatch) {
      const h = parseInt(hrMatch[1], 10) || 1;
      delayMs = h * 3600 * 1000;
      timeLabel = `en ${h} hora(s)`;
    }

    const atTimeMatch = lower.match(/a las\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    let triggerAt = Date.now() + delayMs;
    if (atTimeMatch) {
      let hours = parseInt(atTimeMatch[1], 10);
      const mins = atTimeMatch[2] ? parseInt(atTimeMatch[2], 10) : 0;
      const meridiem = atTimeMatch[3] ? atTimeMatch[3].toLowerCase() : null;
      if (meridiem === 'pm' && hours < 12) hours += 12;
      if (meridiem === 'am' && hours === 12) hours = 0;

      const d = new Date();
      d.setHours(hours, mins, 0, 0);
      if (d.getTime() <= Date.now()) {
        d.setDate(d.getDate() + 1);
      }
      triggerAt = d.getTime();
      timeLabel = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    }

    const remId = 'rem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const remData = {
      id: remId,
      from: partnerName,
      fromProfile: partnerName === 'Anthony' ? 'doom1' : 'doom2',
      to: targetPartner,
      toPhone: targetPhone,
      toJid: targetJid,
      text: reminderText,
      triggerAt,
      timeStr: timeLabel,
      createdAt: Date.now(),
      sent: false
    };

    await fb('PUT', ws(`partnerReminders/${remId}`), remData);
    await touchMeta(`Recordatorio programado para @${targetPartner}`);

    return `⏰ *¡Recordatorio programado!* 🔔\n\nA las *${timeLabel}* le enviaré este mensaje por WhatsApp a tu socio @${targetPartner}:\n\n` +
      `👉 "${reminderText}"`;
  }

  return null;
}

async function checkPartnerReminders() {
  if (!isOwner || !waSock || waState !== 'connected') return;
  try {
    const raw = await fb('GET', ws('partnerReminders'));
    if (!raw || typeof raw !== 'object') return;
    const now = Date.now();
    for (const [key, rem] of Object.entries(raw)) {
      if (!rem || rem.sent || !rem.triggerAt) continue;
      if (now >= Number(rem.triggerAt)) {
        rem.sent = true;
        rem.sentAt = now;
        await fb('PATCH', ws(`partnerReminders/${key}`), { sent: true, sentAt: now });

        const msgText = `🔔 *RECORDATORIO DE TU SOCIO @${rem.from}:*\n\n"${rem.text}"\n\n_Enviado automáticamente por el Asistente Doomlater._`;
        const destJid = rem.toJid || `${rem.toPhone}@s.whatsapp.net`;
        await waSend(destJid, { text: msgText });

        const confirmSender = `✅ *Recordatorio entregado:* Ya le envié el mensaje a tu socio @${rem.to}:\n"${rem.text}"`;
        notifySinglePartner(rem.from, confirmSender).catch(() => {});
        await touchMeta(`Recordatorio entregado a @${rem.to}`);
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Error al procesar recordatorios de socios');
  }
}

async function queryAdminAI(convId, userMessage, adminCtx, partnerName) {
  // Primero revisa si es un comando ejecutable directo (venta o recordatorio)
  try {
    const commandReply = await handlePartnerCommands(userMessage, adminCtx, partnerName);
    if (commandReply) return { reply: commandReply, isPayment: false, needsHuman: false };
  } catch (cmdErr) {
    logger.error({ err: cmdErr.message }, 'Error procesando comando de socio');
  }

  const apiKey = (await fb('GET', ws('meta/botConfig')))?.geminiApiKey || GEMINI_API_KEY_ENV;
  if (!apiKey) return { reply: fallbackAdminRuleBased(userMessage, adminCtx, partnerName), isPayment: false, needsHuman: false };

  const models = [
    'gemini-3.5-flash',
    'gemini-3.8-flash',
    'gemini-3-flash-preview',
    'gemini-flash-latest'
  ];

  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildAdminSystemPrompt(adminCtx, partnerName) }] },
          contents: [{ role: 'user', parts: [{ text: userMessage }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 500 }
        })
      });
      if (res.status === 404) continue;
      if (!res.ok) continue;
      const data = await res.json();
      const reply = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (reply) return { reply, isPayment: false, needsHuman: false };
    } catch (e) {
      continue;
    }
  }

  return { reply: fallbackAdminRuleBased(userMessage, adminCtx, partnerName), isPayment: false, needsHuman: false };
}

async function loadAiContext() {
  const [botConfig, stockRaw] = await Promise.all([fb('GET', ws('meta/botConfig')), fb('GET', ws('stockItems'))]);
  const cfg = botConfig || {};
  const pms = Array.isArray(cfg.paymentMethods) && cfg.paymentMethods.length > 0 ? cfg.paymentMethods : DEFAULT_PAYMENT_METHODS;
  const faqs = Array.isArray(cfg.knowledgeBaseFaq) && cfg.knowledgeBaseFaq.length > 0 ? cfg.knowledgeBaseFaq : DEFAULT_FAQ;
  return {
    botConfig: cfg,
    stockItems: stockRaw ? Object.values(stockRaw).filter(Boolean) : [],
    paymentMethods: pms,
    knowledgeBaseFaq: faqs
  };
}

function buildSystemPrompt({ stockItems, paymentMethods, knowledgeBaseFaq, botConfig = {} }) {
  const stock = stockItems
    .filter(i => !i.deleted && (i.kind === 'para_vender' || i.kind === 'insumo'))
    .map(i => `- ${i.name}: stock ${i.stock} | precio $${Number(i.salePrice || i.purchaseCost || 0).toFixed(2)}${i.extraDetail || i.notes ? ` | ${i.extraDetail || i.notes}` : ''}`)
    .join('\n');
  const faq = knowledgeBaseFaq.map(f => `P: ${f.question}\nR: ${f.answer}`).join('\n\n');
  const pm = paymentMethods.map(p => `• ${p.name}: ${p.details}`).join('\n');

  const customRules = botConfig.customAiRules ? `
=== REGLAS Y FILTROS ESTRICTOS DEFINIDOS POR LOS DUEÑOS EN LA WEB ===
${botConfig.customAiRules}
` : '';

  return `Eres el asistente oficial de atención al cliente de Doomlater.Corp.
Nos especializamos en consolas de videojuegos (PlayStation, Nintendo, Xbox), accesorios, videojuegos, servicio técnico y mantenimiento.
Responde siempre en español, con tono amable, cálido, profesional y conciso (máximo 3-4 frases).
No digas que eres una IA salvo que te lo pregunten directamente.
${customRules}
=== INFORMACIÓN Y PREGUNTAS FRECUENTES ===
${faq}

=== MÉTODOS DE PAGO ===
${pm}

=== STOCK DISPONIBLE ACTUAL ===
${stock || '(Catálogo general de consolas, accesorios y servicio técnico bajo consulta de modelo)'}

Instrucciones de respuesta:
1. Saludos o bienvenida: Saluda con entusiasmo y presenta brevemente lo que ofrece Doomlater.Corp (consolas, videojuegos, accesorios y servicio técnico).
2. Preguntas sobre métodos de pago o cómo pagar: Brinda los métodos de pago disponibles y solicita el comprobante de pago por este chat.
3. Si el cliente indica que ya pagó o envía un comprobante/capture: Agradece, indícale que el equipo lo está verificando y finaliza tu mensaje con [FLAG_PAGO_REPORTADO].
4. Preguntas sobre productos en stock: Si el producto está en la lista de stock, informa el precio y disponibilidad. Si preguntan por un modelo o producto específico que no está en la lista de stock, indícale amablemente qué servicios o modelos manejamos en Doomlater.Corp, ofrécele consultar la disponibilidad exacta con el equipo y finaliza con [FLAG_REQUIERE_HUMANO].
5. Si preguntan sobre servicio técnico, envíos, garantía o ubicación: Responde con la información de Preguntas Frecuentes.
6. Nunca inventes precios específicos que no conozcas.
7. Información interna, financiera o administrativa: Si un cliente pregunta cuánto dinero tiene la empresa, saldos bancarios, ganancias o costos internos, indícale amablemente que esa información es estrictamente confidencial de la administración y que con gusto le brindas información sobre precios de venta, disponibilidad de consolas o servicio técnico.`;
}

function parseAIResponseFlags(text) {
  let clean = String(text || '');
  const isPayment = clean.includes('[FLAG_PAGO_REPORTADO]');
  const needsHuman = clean.includes('[FLAG_REQUIERE_HUMANO]');
  clean = clean.replace(/\[FLAG_PAGO_REPORTADO\]/g, '').replace(/\[FLAG_REQUIERE_HUMANO\]/g, '').trim();
  return { reply: clean, isPayment, needsHuman };
}

async function queryAI(convId, userMessage, ctx) {
  const apiKey = ctx.botConfig.geminiApiKey || GEMINI_API_KEY_ENV;
  if (!apiKey) return fallbackRuleBasedBot(userMessage, ctx);

  const history = (convHistory.get(convId) || []).slice(-10);
  
  // Merge consecutive turns with same role so Gemini alternating turn rule is NEVER violated
  const contents = [];
  for (const h of history) {
    if (!h.text || !h.text.trim()) continue;
    const role = h.role === 'bot' ? 'model' : 'user';
    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts[0].text += '\n' + h.text;
    } else {
      contents.push({ role, parts: [{ text: h.text }] });
    }
  }

  // Ensure last turn is user with the new message
  if (contents.length === 0 || contents[contents.length - 1].role !== 'user') {
    contents.push({ role: 'user', parts: [{ text: userMessage || 'Hola' }] });
  } else if (userMessage && !contents[contents.length - 1].parts[0].text.includes(userMessage)) {
    contents[contents.length - 1].parts[0].text += '\n' + userMessage;
  }

  // Ensure first turn is from user (Gemini requirement)
  while (contents.length > 0 && contents[0].role !== 'user') {
    contents.shift();
  }

  const models = [
    ctx.botConfig.geminiModel,
    GEMINI_MODEL_ENV,
    'gemini-3.5-flash',
    'gemini-3.8-flash',
    'gemini-3-flash-preview',
    'gemini-flash-latest',
    'gemini-4-argon'
  ].filter(Boolean);
  for (const model of [...new Set(models)]) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemPrompt(ctx) }] },
          contents,
          generationConfig: { temperature: 0.4, maxOutputTokens: 350 }
        })
      });
      if (res.status === 404) continue;
      if (!res.ok) {
        logger.error({ model, status: res.status, body: (await res.text()).slice(0, 300) }, 'Gemini falló con este modelo, intentando siguiente');
        continue;
      }
      const data = await res.json();
      const reply = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (reply) return parseAIResponseFlags(reply);
    } catch (err) {
      logger.error({ model, err: err.message }, 'Gemini error');
      continue;
    }
  }
  return fallbackRuleBasedBot(userMessage, ctx);
}

function fallbackRuleBasedBot(userMessage, { stockItems = [], paymentMethods = [], knowledgeBaseFaq = [] }) {
  const msg = String(userMessage || '').toLowerCase();
  if (/(dinero|saldo|balance|cuánto tienen|cuanto tienen|cuanto dinero|cuánto dinero|ganancia)/i.test(msg)) {
    return {
      reply: 'Esa es información interna y confidencial de la administración de Doomlater.Corp. Si tienes dudas sobre nuestras consolas, productos o servicios técnicos con gusto te ayudamos. ✨',
      isPayment: false,
      needsHuman: false
    };
  }
  if (/(ya pagu|ya pagué|transfer|comprobante|capture|pago realizado)/.test(msg)) {
    return { reply: '¡Muchas gracias! 🧾 Recibimos tu comprobante. Los socios de Doomlater.Corp lo están verificando y te confirman en breve.', isPayment: true, needsHuman: true };
  }
  if (/(m[eé]todo|c[oó]mo pag|datos de pago|pago m[oó]vil|binance|zelle|cuenta)/.test(msg)) {
    const pm = paymentMethods.map(p => `• ${p.name}: ${p.details}`).join('\n');
    return { reply: `¡Claro! Nuestros métodos de pago son:\n\n${pm || '• Pago Móvil\n• Binance Pay\n• Efectivo'}\n\nCuando pagues, envíanos el comprobante por aquí.`, isPayment: false, needsHuman: false };
  }
  for (const f of knowledgeBaseFaq) {
    const words = String(f.question || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    if (words.filter(w => msg.includes(w)).length >= 2) return { reply: f.answer, isPayment: false, needsHuman: false };
  }
  const item = stockItems.find(i => !i.deleted && i.name && msg.includes(String(i.name).toLowerCase()));
  if (item) {
    return { reply: `¡Sí! Tenemos ${item.name} (${item.stock} disponible(s)) a $${Number(item.salePrice || 0).toFixed(2)}. ¿Te lo apartamos?`, isPayment: false, needsHuman: false };
  }
  return { reply: '¡Hola! Recibimos tu mensaje 🙌 Ya le avisé al equipo para darte la información exacta. Te respondemos en breve.', isPayment: false, needsHuman: true };
}

/* --------------------------------------------------------------------------
   CONVERSACIONES (compartido por WhatsApp / Instagram / Messenger)
   -------------------------------------------------------------------------- */
async function saveMedia(key, mime, buffer) {
  if (!buffer || buffer.length > 2.5 * 1024 * 1024) return null;
  const ok = await fb('PUT', `${MEDIA_PATH}/${key}`, {
    data: `data:${mime || 'image/jpeg'};base64,${buffer.toString('base64')}`,
    createdAt: Date.now()
  });
  return ok ? key : null;
}

/**
 * Registra un mensaje entrante y actualiza la conversación en una sola escritura.
 * Devuelve la conversación resultante.
 */
async function recordIncoming({ convId, base, msg, label }) {
  const existing = await fb('GET', ws(`botConversations/${convId}`));
  const now = Date.now();
  const conv = {
    platformAccount: 'shared',
    botActive: true,
    needsAttention: false,
    unreadCount: 0,
    createdAt: now,
    ...(existing || {}),
    ...base,
    id: convId,
    lastMessage: msg.text,
    lastMessageAt: msg.createdAt,
    unreadCount: (Number(existing?.unreadCount) || 0) + 1,
    deleted: false,
    updatedAt: stampAfter(existing),
    updatedBy: 'bot'
  };
  // Conserva un nombre real si ya lo teníamos y el nuevo es genérico.
  if (existing?.customerName && base.genericName) conv.customerName = existing.customerName;
  delete conv.genericName;

  await fb('PATCH', ROOT, {
    [`botMessages/${msg.id}`]: { ...msg, convId, direction: 'in', updatedAt: now },
    [`botConversations/${convId}`]: conv,
    'meta/updatedAt': now,
    'meta/rev': now,
    'meta/lastLabel': label,
    'meta/lastClientId': 'bot_bridge',
    'meta/updatedBy': 'bot'
  });
  return conv;
}

async function recordOutgoing(convId, { id, text, sentBy = 'bot', deliveryStatus = 'sent', deliveryError = '', mediaKey = null }, convPatch = {}) {
  const now = Date.now();
  const existing = await fb('GET', ws(`botConversations/${convId}`));
  const updates = {
    [`botMessages/${id}`]: {
      id, convId, direction: 'out', text, sentBy, createdAt: now, updatedAt: now,
      deliveryStatus, ...(deliveryError ? { deliveryError } : {}), ...(mediaKey ? { mediaKey, mediaType: 'image' } : {})
    },
    'meta/updatedAt': now,
    'meta/rev': now,
    'meta/lastLabel': `🤖 Respuesta enviada`,
    'meta/lastClientId': 'bot_bridge',
    'meta/updatedBy': 'bot'
  };
  if (existing) {
    updates[`botConversations/${convId}`] = {
      ...existing,
      lastMessage: text,
      lastMessageAt: now,
      ...convPatch,
      updatedAt: stampAfter(existing),
      updatedBy: 'bot'
    };
  }
  await fb('PATCH', ROOT, updates);
}

/* Agrupa mensajes seguidos del cliente y responde una sola vez tras el retraso "escribiendo..." */
const replyQueue = new Map();
function scheduleAiReply(convId, text, ctx) {
  const q = replyQueue.get(convId) || { texts: [], hasImage: false };
  clearTimeout(q.timer);
  if (text) q.texts.push(text);
  q.hasImage = q.hasImage || Boolean(ctx.hasImage);
  q.ctx = ctx;
  q.timer = setTimeout(() => {
    replyQueue.delete(convId);
    runAiReply(convId, q).catch(err => logger.error({ err: err.message, convId }, 'Error respondiendo con IA'));
  }, ctx.delayMs);
  replyQueue.set(convId, q);
}

async function runAiReply(convId, q) {
  // Revisa de nuevo los interruptores justo antes de responder (por si los pausaste durante la espera)
  const [conv, aiCtx] = await Promise.all([fb('GET', ws(`botConversations/${convId}`)), loadAiContext()]);
  if (!conv || conv.deleted) return;
  if (aiCtx.botConfig.globalBotEnabled === false || conv.botActive === false) {
    if (q.ctx.platform === 'whatsapp') await waPresence('paused', q.ctx.jid);
    return;
  }

  const userText = q.texts.join('\n').trim();
  let result;
  if (q.ctx.isPartner) {
    const adminCtx = await loadAdminExecutiveContext();
    result = await queryAdminAI(convId, userText || 'hola', adminCtx, q.ctx.partnerName || 'Socio');
  } else if (q.hasImage && !/[a-z]{4,}/i.test(userText)) {
    result = {
      reply: '¡Gracias! 🧾 Recibimos tu imagen/comprobante. Los socios de Doomlater.Corp lo verifican y te confirman en breve.',
      isPayment: true,
      needsHuman: true
    };
  } else {
    result = await queryAI(convId, userText || '(el cliente envió un archivo)', aiCtx);
    if (q.hasImage) { result.isPayment = true; result.needsHuman = true; }
  }

  let deliveryStatus = 'sent';
  let deliveryError = '';
  try {
    if (q.ctx.platform === 'whatsapp') {
      const candidateJids = [];
      if (q.ctx.jid) candidateJids.push(q.ctx.jid);
      const cleanPhone = String(q.ctx.phone || '').replace(/\D/g, '');
      if (cleanPhone && cleanPhone.length >= 8) {
        const pnJid = `${cleanPhone}@s.whatsapp.net`;
        if (!candidateJids.includes(pnJid)) candidateJids.push(pnJid);
      }
      if (candidateJids.length === 0 && q.ctx.jid) candidateJids.push(q.ctx.jid);

      let sentOk = false;
      let lastErr = null;
      for (const targetJid of candidateJids) {
        try {
          await waPresence('composing', targetJid);
          await waSend(targetJid, { text: result.reply });
          await waPresence('paused', targetJid);
          sentOk = true;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!sentOk && lastErr) throw lastErr;
    } else {
      await graphSend(q.ctx.platform, q.ctx.recipientId, { text: result.reply });
    }
  } catch (err) {
    deliveryStatus = 'error';
    deliveryError = err.message;
    logger.error({ err: err.message, convId }, 'No se pudo enviar la respuesta automática');
  }
  pushHistory(convId, 'bot', result.reply);

  // Alertas proactivas a los socios cuando un cliente reporta pago o solicita atención
  if (!q.ctx.isPartner && deliveryStatus === 'sent') {
    if (result.isPayment) {
      const alertMsg = `🔔 *DOOMLATER ALERT: Pago por Verificar* 🧾\n\n` +
        `Cliente: *${conv.customerName || 'Cliente'}* (${conv.customerPhone || 'WhatsApp'})\n` +
        `Concepto: *${conv.pendingPaymentItem || 'Servicio Técnico / Venta'}*\n` +
        `Monto reportado: *${conv.pendingPaymentAmount ? `$${Number(conv.pendingPaymentAmount).toFixed(2)}` : 'Por verificar'}*\n\n` +
        `👉 _Entra a la web para verificarlo y sumarlo a caja._`;
      notifyPartners(alertMsg, `pay_${convId}_${Math.floor(Date.now() / (10 * 60 * 1000))}`).catch(() => {});
    } else if (result.needsHuman) {
      const alertMsg = `⚠️ *DOOMLATER ALERT: Atención Requerida*\n\n` +
        `Cliente: *${conv.customerName || 'Cliente'}* (${conv.customerPhone || 'WhatsApp'})\n` +
        `Mensaje: "${userText.slice(0, 100)}"\n\n` +
        `👉 _Se requiere la intervención de un socio en el chat._`;
      notifyPartners(alertMsg, `human_${convId}_${Math.floor(Date.now() / (10 * 60 * 1000))}`).catch(() => {});
    }
  }

  const patch = {};
  if (!q.ctx.isPartner) {
    if (result.isPayment || result.needsHuman) {
      patch.needsAttention = true;
      patch.attentionReason = result.isPayment
        ? 'El cliente reportó un pago o envió un comprobante. Verifícalo.'
        : 'Consulta fuera del catálogo o caso especial.';
    }
    if (result.isPayment) patch.pendingPayment = true;
  }
  await recordOutgoing(convId, {
    id: `bmsg_bot_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`,
    text: result.reply,
    deliveryStatus,
    deliveryError
  }, patch);
}

function typingDelayMs(botConfig) {
  const sec = Number(botConfig && botConfig.typingDelaySec);
  return Math.min(15, Math.max(1, Number.isFinite(sec) && sec > 0 ? sec : 3.5)) * 1000;
}

/* --------------------------------------------------------------------------
   WHATSAPP (Baileys = el mismo protocolo de WhatsApp Web / "Dispositivos vinculados")
   -------------------------------------------------------------------------- */
let waSock = null;
let waState = 'idle';
let waStopped = true;
let waGeneration = 0;
let waReconnectTimer = null;
const botSentIds = new Set();
const sentMessagesStore = new Map();

function saveSentMessage(id, message) {
  if (!id || !message) return;
  sentMessagesStore.set(id, message);
  if (sentMessagesStore.size > 2000) {
    const oldest = sentMessagesStore.keys().next().value;
    sentMessagesStore.delete(oldest);
  }
}

function rememberSent(id) {
  if (!id) return;
  botSentIds.add(id);
  if (botSentIds.size > 500) botSentIds.delete(botSentIds.values().next().value);
}

async function waSend(jid, content) {
  if (!waSock || waState !== 'connected') throw new Error('WhatsApp no está conectado en este momento.');
  const sent = await waSock.sendMessage(jid, content);
  rememberSent(sent?.key?.id);
  if (sent?.key?.id && sent?.message) {
    saveSentMessage(sent.key.id, sent.message);
  }
  return sent;
}
async function waPresence(type, jid) {
  try { if (waSock && waState === 'connected' && jid) await waSock.sendPresenceUpdate(type, jid); } catch (e) {}
}

function stopWhatsApp(reason) {
  waStopped = true;
  waGeneration++;
  clearTimeout(waReconnectTimer);
  if (waSock) {
    try { waSock.end(new Error(reason)); } catch (e) {}
  }
  waSock = null;
  waState = 'standby';
  logger.warn({ reason }, 'WhatsApp detenido en esta instancia');
}

function scheduleWaRestart(ms) {
  clearTimeout(waReconnectTimer);
  waReconnectTimer = setTimeout(() => startWhatsApp().catch(err => logger.error({ err: err.message }, 'Error reiniciando WhatsApp')), ms);
}

async function startWhatsApp() {
  if (WA_DISABLED || !isOwner) return;
  waStopped = false;
  const gen = ++waGeneration;
  clearTimeout(waReconnectTimer);

  fs.mkdirSync(authFolder, { recursive: true });
  await restoreAuthIfNewer();
  if (gen !== waGeneration) return;

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) {}

  waState = 'connecting';
  await setWaStatus({ state: 'connecting', connected: false });

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
    logger: silentLogger,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: true,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => {
      const found = sentMessagesStore.get(key.id);
      return found || undefined;
    }
  });
  waSock = sock;

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    setTimeout(() => backupAuthNow().catch(() => {}), 1500);
  });

  sock.ev.on('connection.update', async (u) => {
    if (gen !== waGeneration) return;
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      waState = 'qr';
      try {
        const dataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
        await setWaStatus({ state: 'qr', connected: false, qr: dataUrl, qrAt: Date.now() });
        logger.info('QR real de WhatsApp listo (también puedes usar el código de 8 dígitos)');
      } catch (err) {
        logger.error({ err: err.message }, 'No se pudo generar la imagen QR');
      }
    }

    if (connection === 'open') {
      waState = 'connected';
      const me = sock.user || {};
      await setWaStatus({
        state: 'connected', connected: true, qr: null, qrAt: null,
        pairingCode: null, pairingError: null, lastError: null,
        me: { id: me.id || '', name: me.name || me.verifiedName || '' },
        connectedAt: Date.now()
      });
      logger.info({ me: me.id }, '¡WhatsApp conectado!');
      backupAuthNow().catch(() => {});
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || '';
      waSock = null;
      waState = 'disconnected';
      if (waStopped || !isOwner) return;

      if (code === DisconnectReason.loggedOut) {
        logger.warn('La sesión fue cerrada desde el teléfono. Limpiando credenciales para generar nuevo QR/código.');
        await clearAuthEverywhere();
        await setWaStatus({ state: 'logged_out', connected: false, qr: null, pairingCode: null, lastError: 'Sesión desvinculada desde el teléfono.' });
        scheduleWaRestart(2000);
      } else if (code === DisconnectReason.connectionReplaced) {
        await setWaStatus({ state: 'replaced', connected: false, lastError: 'Otra copia abrió esta sesión. Reintentando en 15 s.' });
        scheduleWaRestart(15000);
      } else {
        await setWaStatus({ state: 'reconnecting', connected: false, lastError: `${code || ''} ${reason}`.trim() });
        scheduleWaRestart(code === DisconnectReason.restartRequired ? 500 : 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (gen !== waGeneration) return;
    for (const m of messages || []) {
      if (m.key?.id && m.message) saveSentMessage(m.key.id, m.message);
      try { await handleWaMessage(m, type); } catch (err) { logger.error({ err: err.message }, 'Error procesando mensaje de WhatsApp'); }
    }
  });
}

function waTextOf(c) {
  return c.conversation
    || c.extendedTextMessage?.text
    || c.imageMessage?.caption
    || c.videoMessage?.caption
    || c.documentMessage?.caption
    || c.buttonsResponseMessage?.selectedDisplayText
    || c.listResponseMessage?.title
    || c.templateButtonReplyMessage?.selectedDisplayText
    || '';
}
const WA_LABELS = {
  imageMessage: '📷 Imagen', videoMessage: '🎥 Video', audioMessage: '🎤 Nota de voz', stickerMessage: '🏷️ Sticker',
  documentMessage: '📄 Documento', locationMessage: '📍 Ubicación', liveLocationMessage: '📍 Ubicación en vivo',
  contactMessage: '👤 Contacto', contactsArrayMessage: '👥 Contactos'
};
const WA_IGNORED = new Set(['protocolMessage', 'senderKeyDistributionMessage', 'reactionMessage', 'pollUpdateMessage', 'messageContextInfo', 'editedMessage']);

async function handleWaMessage(msg, type) {
  if (!msg?.message || !msg.key) return;
  const jid = msg.key.remoteJid || '';
  if (!jid || jid === 'status@broadcast' || isJidGroup(jid) || isJidBroadcast(jid) || (isJidNewsletter && isJidNewsletter(jid))) return;

  const content = normalizeMessageContent(msg.message);
  const ctype = content ? getContentType(content) : null;
  if (!ctype || WA_IGNORED.has(ctype)) return;

  const tsMs = (Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;
  // Solo mensajes nuevos entrantes (nunca responder al historial antiguo al vincular)
  if (!msg.key.fromMe) {
    if (type !== 'notify') return;
    if (Date.now() - tsMs > 3 * 60 * 1000) return;
  }

  const pnJid = jid.endsWith('@s.whatsapp.net') ? jid : (msg.key.senderPn || '');
  const phone = pnJid ? pnJid.split('@')[0].split(':')[0] : '';
  const convId = `conv_wa_${phone || `lid_${jid.split('@')[0].split(':')[0]}`}`;
  const caption = waTextOf(content);
  const label = WA_LABELS[ctype] || '';
  const text = caption ? (label && ctype !== 'extendedTextMessage' && ctype !== 'conversation' ? `${label}: ${caption}` : caption) : (label || '[Mensaje]');
  const msgId = `bmsg_wa_${safeId(msg.key.id)}`;

  // Mensajes que Tú o tu socio escriben desde la aplicación de WhatsApp (móvil):
  // Se reflejan de inmediato en la Web y en Firebase
  if (msg.key.fromMe) {
    if (botSentIds.has(msg.key.id)) return;

    let mediaKey = null;
    if (ctype === 'imageMessage' || ctype === 'stickerMessage') {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: silentLogger, reuploadRequest: waSock?.updateMediaMessage });
        mediaKey = await saveMedia(msgId, content[ctype]?.mimetype || 'image/jpeg', buffer);
      } catch (err) {}
    }

    let existing = await fb('GET', ws(`botConversations/${convId}`));
    if (!existing) {
      existing = {
        id: convId,
        platform: 'whatsapp',
        platformAccount: 'shared',
        customerName: phone ? `+${phone}` : 'Cliente WhatsApp',
        customerPhone: phone ? `+${phone}` : '',
        customerJid: jid,
        botActive: false, // El operador humano tomó el control desde el teléfono
        needsAttention: false,
        unreadCount: 0,
        createdAt: tsMs || Date.now()
      };
      await fb('PUT', ws(`botConversations/${convId}`), existing);
    }

    await recordOutgoing(convId, {
      id: msgId,
      text,
      sentBy: 'WhatsApp (Móvil)',
      deliveryStatus: 'sent',
      mediaKey
    }, {
      botActive: false
    });
    return;
  }

  let mediaKey = null;
  if (ctype === 'imageMessage' || ctype === 'stickerMessage') {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: silentLogger, reuploadRequest: waSock?.updateMediaMessage });
      mediaKey = await saveMedia(msgId, content[ctype]?.mimetype || 'image/jpeg', buffer);
    } catch (err) {
      logger.warn({ err: err.message }, 'No se pudo descargar la imagen');
    }
  }

  const pushName = msg.pushName || '';
  logger.info({ convId, pushName, text }, 'WhatsApp entrante');
  pushHistory(convId, 'user', caption || label);

  const conv = await recordIncoming({
    convId,
    base: {
      platform: 'whatsapp',
      platformAccount: 'shared',
      customerName: pushName || (phone ? `+${phone}` : 'Cliente WhatsApp'),
      genericName: !pushName,
      customerPhone: phone ? `+${phone}` : '',
      customerJid: jid
    },
    msg: { id: msgId, text, sentBy: pushName || 'Cliente', createdAt: tsMs, platform: 'whatsapp', ...(mediaKey ? { mediaKey, mediaType: 'image' } : {}) },
    label: `💬 ${pushName || phone || 'Cliente'} (WhatsApp): ${text.slice(0, 60)}`
  });

  const partner = isAuthorizedPartner(jid) || isAuthorizedPartner(phone) || (convId === 'conv_wa_584142005801' ? PARTNER_ACCOUNTS[0] : null);
  const botConfig = (await fb('GET', ws('meta/botConfig'))) || {};
  if (botConfig.globalBotEnabled !== false && conv.botActive !== false) {
    if (botConfig.showTypingIndicator !== false) await waPresence('composing', jid);
    scheduleAiReply(convId, caption, {
      platform: 'whatsapp',
      jid,
      phone,
      hasImage: Boolean(mediaKey) || ctype === 'imageMessage',
      delayMs: partner ? 800 : typingDelayMs(botConfig),
      isPartner: Boolean(partner),
      partnerName: partner ? partner.name : null
    });
  }
}

async function requestPairingCode(phoneRaw) {
  const phone = String(phoneRaw || '').replace(/\D/g, '');
  if (phone.length < 10) throw new Error('Escribe el número completo con código de país, sin + ni espacios (ej: 584245323796).');
  if (!isOwner) throw new Error('Esta copia del servidor está en espera (otra copia controla WhatsApp).');
  if (waState === 'connected') throw new Error('WhatsApp ya está conectado.');
  // Espera a que el socket esté listo (estado "qr") hasta 20 s
  for (let i = 0; i < 40 && waState !== 'qr'; i++) await new Promise(r => setTimeout(r, 500));
  if (!waSock || waState !== 'qr') throw new Error('WhatsApp aún está iniciando. Intenta de nuevo en unos segundos.');
  const raw = await waSock.requestPairingCode(phone);
  const code = String(raw || '').toUpperCase().match(/.{1,4}/g)?.join('-') || raw;
  await setWaStatus({ pairingCode: code, pairingPhone: phone, pairingAt: Date.now(), pairingError: null });
  logger.info({ phone, code }, 'Código de vinculación generado');
  return code;
}

async function resetWhatsAppSession() {
  if (!isOwner) return;
  try { if (waSock) await waSock.logout(); } catch (e) {}
  stopWhatsApp('reset');
  await clearAuthEverywhere();
  await setWaStatus({ state: 'logged_out', connected: false, qr: null, pairingCode: null, me: null, lastError: null });
  waStopped = false;
  scheduleWaRestart(1500);
}

/* --------------------------------------------------------------------------
   META: INSTAGRAM DM + FACEBOOK MESSENGER
   -------------------------------------------------------------------------- */
async function graphSend(platform, recipientId, { text, imageUrl }) {
  const message = imageUrl
    ? { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: false } } }
    : { text: String(text || '').slice(0, 1990) };
  const body = { recipient: { id: recipientId }, message };
  let url;
  const headers = { 'Content-Type': 'application/json' };
  if (platform === 'instagram' && IG_TOKEN) {
    url = `https://graph.instagram.com/${GRAPH_VERSION}/me/messages`;
    headers.Authorization = `Bearer ${IG_TOKEN}`;
  } else {
    if (!META_PAGE_TOKEN) throw new Error('Falta META_PAGE_ACCESS_TOKEN en el servidor (Render > Environment). Sin ese token Meta no deja responder.');
    if (platform === 'messenger') body.messaging_type = 'RESPONSE';
    url = `https://graph.facebook.com/${GRAPH_VERSION}/me/messages?access_token=${encodeURIComponent(META_PAGE_TOKEN)}`;
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const msg = json.error?.message || `HTTP ${res.status}`;
    await setMetaStatus({ lastSendError: msg, lastSendErrorAt: Date.now() });
    throw new Error(msg);
  }
  return json;
}

const profileCache = new Map();
async function metaProfile(platform, id) {
  if (profileCache.has(id)) return profileCache.get(id);
  let out = { name: '', avatar: '' };
  try {
    let url;
    if (platform === 'instagram') {
      url = IG_TOKEN
        ? `https://graph.instagram.com/${GRAPH_VERSION}/${id}?fields=name,username,profile_pic&access_token=${encodeURIComponent(IG_TOKEN)}`
        : (META_PAGE_TOKEN ? `https://graph.facebook.com/${GRAPH_VERSION}/${id}?fields=name,username,profile_pic&access_token=${encodeURIComponent(META_PAGE_TOKEN)}` : '');
    } else if (META_PAGE_TOKEN) {
      url = `https://graph.facebook.com/${GRAPH_VERSION}/${id}?fields=first_name,last_name,profile_pic&access_token=${encodeURIComponent(META_PAGE_TOKEN)}`;
    }
    if (url) {
      const j = await (await fetch(url)).json();
      if (!j.error) {
        out = {
          name: j.name || [j.first_name, j.last_name].filter(Boolean).join(' ') || (j.username ? `@${j.username}` : ''),
          avatar: j.profile_pic || ''
        };
      }
    }
  } catch (e) {}
  profileCache.set(id, out);
  return out;
}

function verifyMetaSignature(req) {
  if (!META_APP_SECRET) return true;
  const sig = req.get('x-hub-signature-256') || '';
  if (!sig || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch (e) { return false; }
}

const processedMids = new Set();

app.get('/webhook/meta', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === META_VERIFY_TOKEN) {
    logger.info('Webhook de Meta verificado');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook/meta', async (req, res) => {
  const body = req.body || {};
  if (!verifyMetaSignature(req)) {
    logger.warn('Firma de Meta inválida: revisa META_APP_SECRET');
    return res.sendStatus(403);
  }
  if (body.object !== 'page' && body.object !== 'instagram') return res.sendStatus(404);
  res.status(200).send('EVENT_RECEIVED');

  await setMetaStatus({
    lastWebhookAt: Date.now(),
    lastObject: body.object,
    lastPayload: JSON.stringify(body).slice(0, 1200)
  });

  for (const entry of body.entry || []) {
    const events = [...(entry.messaging || []), ...(entry.standby || [])];
    for (const ev of events) {
      try { await handleMetaEvent(body.object, entry, ev); } catch (err) { logger.error({ err: err.message }, 'Error procesando evento de Meta'); }
    }
  }
});

async function handleMetaEvent(object, entry, ev) {
  if (!ev.message || ev.message.is_echo || !ev.sender?.id) return;
  const mid = ev.message.mid || `${ev.sender.id}_${ev.timestamp}`;
  if (processedMids.has(mid)) return;
  processedMids.add(mid);
  if (processedMids.size > 1000) processedMids.delete(processedMids.values().next().value);

  const platform = object === 'instagram' ? 'instagram' : 'messenger';
  const senderId = ev.sender.id;
  const pageId = entry.id || ev.recipient?.id || '';
  const convId = `conv_${platform === 'instagram' ? 'ig' : 'fb'}_${senderId}`;
  const msgId = `bmsg_${platform === 'instagram' ? 'ig' : 'fb'}_${safeId(mid)}`;
  const createdAt = Number(ev.timestamp) || Date.now();

  const attachments = ev.message.attachments || [];
  let mediaKey = null;
  const img = attachments.find(a => a.type === 'image' && a.payload?.url);
  if (img) {
    try {
      const r = await fetch(img.payload.url);
      if (r.ok) mediaKey = await saveMedia(msgId, r.headers.get('content-type') || 'image/jpeg', Buffer.from(await r.arrayBuffer()));
    } catch (e) {}
  }
  const caption = ev.message.text || '';
  const text = caption || (attachments.length ? `📎 ${attachments.map(a => a.type).join(', ')}` : '[Mensaje]');

  const profile = await metaProfile(platform, senderId);
  const botConfig = (await fb('GET', ws('meta/botConfig'))) || {};

  let platformAccount = 'shared';
  if (platform === 'messenger') {
    const owners = botConfig.messengerPageOwners || {};
    platformAccount = owners[pageId] || 'doom1';
  }

  pushHistory(convId, 'user', caption || text);
  const conv = await recordIncoming({
    convId,
    base: {
      platform,
      platformAccount,
      ...(platform === 'messenger' ? { profileId: platformAccount === 'doom2' ? 'profile_2' : 'profile_1' } : {}),
      pageId,
      customerName: profile.name || (platform === 'instagram' ? `Instagram ${senderId.slice(-4)}` : `Facebook ${senderId.slice(-4)}`),
      genericName: !profile.name,
      ...(profile.avatar ? { customerAvatar: profile.avatar } : {}),
      customerPlatformId: senderId
    },
    msg: { id: msgId, text, sentBy: profile.name || 'Cliente', createdAt, platform, ...(mediaKey ? { mediaKey, mediaType: 'image' } : {}) },
    label: `💬 ${profile.name || 'Cliente'} (${platform === 'instagram' ? 'Instagram' : 'Messenger'}): ${text.slice(0, 60)}`
  });
  logger.info({ platform, convId, text }, 'Mensaje de Meta guardado en el inbox');

  const aiOn = botConfig.globalBotEnabled !== false && conv.botActive !== false;
  if (!aiOn) return;

  if (platform === 'messenger') {
    // Regla: Messenger solo envía UNA redirección a WhatsApp, nunca más.
    if (conv.messengerRedirectSent) return;
    let redirect = botConfig.messengerRedirectMessage || DEFAULT_REDIRECT;
    if (redirect.includes('584120000000') || redirect.includes('412 0000000')) redirect = DEFAULT_REDIRECT;
    let deliveryStatus = 'sent';
    let deliveryError = '';
    try { await graphSend('messenger', senderId, { text: redirect }); } catch (err) { deliveryStatus = 'error'; deliveryError = err.message; }
    await recordOutgoing(convId, { id: `bmsg_fb_redirect_${safeId(senderId)}`, text: redirect, deliveryStatus, deliveryError }, { messengerRedirectSent: deliveryStatus === 'sent' });
    return;
  }

  scheduleAiReply(convId, caption, { platform: 'instagram', recipientId: senderId, hasImage: Boolean(img), delayMs: typingDelayMs(botConfig) });
}

/* --------------------------------------------------------------------------
   BANDEJA DE SALIDA: respuestas manuales escritas en la web
   -------------------------------------------------------------------------- */
const outboxBusy = new Set();
function dataUrlToBuffer(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl || ''));
  return m ? { mime: m[1], buffer: Buffer.from(m[2], 'base64') } : null;
}

async function resolveMediaPayload(mediaUrl, text) {
  if (!mediaUrl) return null;
  const data = dataUrlToBuffer(mediaUrl);
  if (data) {
    const kind = data.mime.startsWith('video') ? 'video' : 'image';
    return { [kind]: data.buffer, caption: text || undefined, mimetype: data.mime };
  }
  if (/^https?:/.test(mediaUrl)) {
    try {
      const res = await fetch(mediaUrl);
      if (res.ok) {
        const mime = res.headers.get('content-type') || 'image/jpeg';
        const buf = Buffer.from(await res.arrayBuffer());
        const kind = mime.startsWith('video') ? 'video' : 'image';
        return { [kind]: buf, caption: text || undefined, mimetype: mime };
      }
    } catch (e) {}
    return { image: { url: mediaUrl }, caption: text || undefined };
  }
  return null;
}

function resolveWaJids(item) {
  const jids = [];
  // 1. Explicit conversation JID (LID or group) takes HIGHEST PRIORITY
  // because that is the exact thread the client is viewing!
  if (item.jid && item.jid.includes('@')) {
    jids.push(item.jid);
  }
  if (item.to && item.to.includes('@') && !jids.includes(item.to)) {
    jids.push(item.to);
  }
  // 2. Phone number JID as alternative / fallback
  const rawPhone = item.phone || item.customerPhone || (item.to && !item.to.includes('@') ? item.to : '') || '';
  let phoneDigits = String(rawPhone || '').replace(/\D/g, '');
  if (!phoneDigits && item.convId && item.convId.startsWith('conv_wa_')) {
    const extracted = item.convId.replace('conv_wa_', '');
    if (/^\d{8,16}$/.test(extracted)) phoneDigits = extracted;
  }
  if (phoneDigits && phoneDigits.length >= 8) {
    const pnJid = `${phoneDigits}@s.whatsapp.net`;
    if (!jids.includes(pnJid)) jids.push(pnJid);
  }
  if (jids.length === 0 && item.to) {
    const d = String(item.to).replace(/\D/g, '');
    if (d) jids.push(`${d}@s.whatsapp.net`);
  }
  return jids;
}

async function processOutbox() {
  if (!isOwner) return;
  const items = await fb('GET', OUTBOX_PATH);
  if (!items || typeof items !== 'object') return;
  for (const [key, item] of Object.entries(items)) {
    if (!item || outboxBusy.has(key)) continue;

    if (item.type === 'delete_message') {
      outboxBusy.add(key);
      try {
        if (item.whatsappKey && sock) {
          await sock.sendMessage(item.to, { delete: item.whatsappKey });
        }
      } catch (delErr) {
        logger.warn({ err: delErr.message }, 'No se pudo eliminar mensaje en WhatsApp remotamente');
      }
      await fb('DELETE', `${OUTBOX_PATH}/${key}`);
      outboxBusy.delete(key);
      continue;
    }

    if (item.platform === 'whatsapp' && waState !== 'connected') {
      if (Date.now() - (Number(item.createdAt) || 0) < 10 * 60 * 1000) continue; // espera a que reconecte
    }
    outboxBusy.add(key);
    let deliveryStatus = 'sent';
    let deliveryError = '';
    try {
      if (item.platform === 'whatsapp') {
        const candidateJids = resolveWaJids(item);
        if (candidateJids.length === 0) throw new Error('Destinatario de WhatsApp inválido (sin número ni JID).');
        const mediaPayload = await resolveMediaPayload(item.mediaUrl, item.text);
        let sentOk = false;
        let lastErr = null;
        for (const targetJid of candidateJids) {
          try {
            await waPresence('composing', targetJid);
            if (mediaPayload) {
              await waSend(targetJid, mediaPayload);
            } else {
              await waSend(targetJid, { text: item.text || '' });
            }
            await waPresence('paused', targetJid);
            sentOk = true;
            break;
          } catch (err) {
            lastErr = err;
            logger.warn({ targetJid, err: err.message }, 'Fallo al enviar a JID candidato, probando siguiente');
          }
        }
        if (!sentOk && lastErr) throw lastErr;
      } else if (item.platform === 'instagram' || item.platform === 'messenger') {
        if (item.text) await graphSend(item.platform, item.to, { text: item.text });
        if (item.mediaUrl && /^https?:/.test(item.mediaUrl)) await graphSend(item.platform, item.to, { imageUrl: item.mediaUrl });
        else if (item.mediaUrl) deliveryError = 'Las fotos subidas desde la PC aún no se pueden enviar por Instagram/Messenger; se envió solo el texto.';
      } else {
        throw new Error(`Plataforma desconocida: ${item.platform}`);
      }
    } catch (err) {
      deliveryStatus = 'error';
      deliveryError = err.message;
    }
    if (item.msgId) {
      await fb('PATCH', ws(`botMessages/${item.msgId}`), {
        deliveryStatus,
        deliveryError: deliveryError || null,
        deliveredAt: Date.now(),
        updatedAt: Math.max(Date.now(), (Number(item.msgUpdatedAt) || 0) + 1)
      });
      await touchMeta(deliveryStatus === 'sent' ? '📤 Mensaje entregado' : '⚠️ Mensaje no enviado');
    }
    await fb('DELETE', `${OUTBOX_PATH}/${key}`);
    outboxBusy.delete(key);
    logger.info({ key, platform: item.platform, deliveryStatus, deliveryError }, 'Mensaje manual procesado');
  }
}

/* --------------------------------------------------------------------------
   ÓRDENES DESDE LA WEB (Firebase) + CONTROL DE INSTANCIAS
   -------------------------------------------------------------------------- */
async function pollCommands() {
  if (!isOwner) return;
  const cmds = await fb('GET', COMMANDS_PATH);
  if (!cmds) return;
  if (cmds.pair && cmds.pair.phone) {
    await fb('DELETE', `${COMMANDS_PATH}/pair`);
    try {
      await requestPairingCode(cmds.pair.phone);
    } catch (err) {
      await setWaStatus({ pairingCode: null, pairingError: err.message, pairingAt: Date.now() });
    }
  }
  if (cmds.newQr) {
    await fb('DELETE', `${COMMANDS_PATH}/newQr`);
    if (waState !== 'connected') {
      stopWhatsApp('nuevo QR');
      waStopped = false;
      scheduleWaRestart(500);
    }
  }
  if (cmds.reset) {
    await fb('DELETE', `${COMMANDS_PATH}/reset`);
    await resetWhatsAppSession();
  }

  // Also check meta/botConfig in case web app posted there
  const botCfg = await fb('GET', ws('meta/botConfig'));
  if (botCfg) {
    if (botCfg.requestPairingPhone && waState !== 'connected') {
      const p = botCfg.requestPairingPhone;
      await fb('PATCH', ws('meta/botConfig'), { requestPairingPhone: null });
      try {
        await requestPairingCode(p);
      } catch (err) {
        await setWaStatus({ pairingCode: null, pairingError: err.message, pairingAt: Date.now() });
      }
    }
    if (botCfg.requestRefreshQr && waState !== 'connected') {
      await fb('PATCH', ws('meta/botConfig'), { requestRefreshQr: null });
      stopWhatsApp('nuevo QR');
      waStopped = false;
      scheduleWaRestart(500);
    }
  }
}

async function heartbeat() {
  const st = await fb('GET', STATUS_PATH);
  if (isOwner) {
    if (st && st.instanceId && st.instanceId !== INSTANCE_ID) {
      isOwner = false;
      stopWhatsApp('Otra copia del servidor tomó el control de WhatsApp');
      return;
    }
    await fb('PATCH', STATUS_PATH, { heartbeatAt: Date.now(), version: SERVER_VERSION, host: INSTANCE_HOST });
  } else if (!WA_DISABLED) {
    const stale = !st || !st.heartbeatAt || Date.now() - Number(st.heartbeatAt) > 90000;
    if (stale) {
      await claimOwnership('la otra copia dejó de responder');
      startWhatsApp().catch(err => logger.error({ err: err.message }, 'Error iniciando WhatsApp'));
    }
  }
}

async function decideOwnershipAtStartup() {
  if (WA_DISABLED) {
    logger.warn('WA_DISABLED=1: esta copia solo atiende Instagram/Messenger.');
    return;
  }
  const st = await fb('GET', STATUS_PATH);
  const otherAlive = st && st.instanceId && st.instanceId !== INSTANCE_ID && Date.now() - Number(st.heartbeatAt || 0) < 60000;
  const otherConnected = Boolean(st && st.whatsapp && st.whatsapp.connected);
  if (otherAlive && otherConnected && !(await remoteAuthIsUsable())) {
    logger.warn('Otra copia ya tiene WhatsApp conectado y aquí no hay WA_AUTH_SECRET válido: quedo en espera.');
    return;
  }
  await claimOwnership(otherAlive ? 'relevo' : 'inicio');
  await startWhatsApp();
}

/* --------------------------------------------------------------------------
   API HTTP
   -------------------------------------------------------------------------- */
app.get('/', (_req, res) => {
  res.json({
    status: 'online',
    app: 'Doomlater.Corp Bot Bridge',
    version: SERVER_VERSION,
    host: INSTANCE_HOST,
    instanceId: INSTANCE_ID,
    controlsWhatsApp: isOwner,
    whatsapp: waState,
    metaPageToken: Boolean(META_PAGE_TOKEN),
    authPersistence: Boolean(WA_AUTH_SECRET),
    time: new Date().toISOString()
  });
});
app.get('/healthz', (_req, res) => res.send('OK'));

app.post('/api/whatsapp/pair', async (req, res) => {
  try {
    res.json({ success: true, code: await requestPairingCode(req.body?.phone) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/whatsapp/reset', async (_req, res) => {
  await resetWhatsAppSession();
  res.json({ success: true });
});

/* --------------------------------------------------------------------------
   ARRANQUE
   -------------------------------------------------------------------------- */
app.listen(PORT, async () => {
  logger.info(`Bot Bridge v${SERVER_VERSION} escuchando en el puerto ${PORT} (${INSTANCE_HOST})`);
  if (!WA_AUTH_SECRET) logger.warn('WA_AUTH_SECRET no configurado: la sesión de WhatsApp NO sobrevivirá a reinicios de Render.');
  if (!META_PAGE_TOKEN) logger.warn('META_PAGE_ACCESS_TOKEN no configurado: se reciben mensajes de Meta pero no se puede responder.');

  await setMetaStatus({ serverSeenAt: Date.now() });
  await decideOwnershipAtStartup().catch(err => logger.error({ err: err.message }, 'Error al iniciar WhatsApp'));

  setInterval(() => heartbeat().catch(() => {}), 15000);
  setInterval(() => pollCommands().catch(() => {}), 3000);
  setInterval(() => processOutbox().catch(() => {}), 3000);
  setInterval(() => backupAuthNow().catch(() => {}), 30000);
  setInterval(() => checkLowStockAndAlert().catch(() => {}), 5 * 60 * 1000);
  setInterval(() => checkPartnerReminders().catch(() => {}), 20000);

  // Render (plan gratis) se duerme tras 15 min sin tráfico: nos auto-visitamos cada 10 min.
  if (RENDER_URL) {
    setInterval(() => fetch(`${RENDER_URL}/healthz`).catch(() => {}), 10 * 60 * 1000);
  }
});
