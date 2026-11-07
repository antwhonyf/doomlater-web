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
import zlib from 'zlib';

import makeWASocketImport, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
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

import { generateDoomDigitalInvoicePdf, generateDoomContractPdf as generateDoomContractPdfEngine } from './doom-pdf-engine.js';

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

/** Modelos de Gemini verificados con razonamiento y ultra-alta velocidad (<800ms) en orden de prioridad */
const WORKING_GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash'
];
const WA_AUTH_SECRET = process.env.WA_AUTH_SECRET || '';
const WA_DISABLED = process.env.WA_DISABLED === '1';
const RENDER_URL = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

const OFFICIAL_WA_NUMBER = (process.env.OFFICIAL_WA_NUMBER || '584245323796').replace(/\D/g, '');
const DEFAULT_REDIRECT = `¡Hola! Gracias por contactarnos en Doomlater 📱. Para atenderte de inmediato con stock en tiempo real, escríbenos a nuestro WhatsApp oficial: +${OFFICIAL_WA_NUMBER} o toca este enlace: https://wa.me/${OFFICIAL_WA_NUMBER} ¡Te atenderemos enseguida!`;

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
  res.header('Access-Control-Allow-Private-Network', 'true');
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

/**
 * Aplica cambios en Firebase RTDB y verifica que se hayan asentado al 100%.
 * Si el primer intento falla o devuelve null, auto-reintenta de inmediato para garantizar la persistencia.
 */
async function commitAndVerifyWebSync(patchUpdates, label = 'Actualización en tiempo real') {
  const now = Date.now();
  patchUpdates['meta/updatedAt'] = now;
  patchUpdates['meta/rev'] = now;
  patchUpdates['meta/lastClientId'] = 'bot_bridge';
  if (!patchUpdates['meta/lastLabel']) {
    patchUpdates['meta/lastLabel'] = label;
  }

  let res = await fb('PATCH', ROOT, patchUpdates);
  if (!res) {
    logger.warn({ label }, 'Primer intento de sincronización con la Web falló, reintentando de inmediato...');
    await new Promise(r => setTimeout(r, 60));
    res = await fb('PATCH', ROOT, patchUpdates);
  }
  return Boolean(res);
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
let lastBackupSavedAt = 0;

function aesKey() {
  return crypto.createHash('sha256').update(WA_AUTH_SECRET).digest();
}
function encryptText(text) {
  const iv = crypto.randomBytes(12);
  const compressedBuf = zlib.gzipSync(Buffer.from(text, 'utf8'));
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
  const data = Buffer.concat([cipher.update(compressedBuf), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'), compressed: true };
}
function decryptText(blob) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey(), Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const rawBuf = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
  return blob.compressed ? zlib.gunzipSync(rawBuf).toString('utf8') : rawBuf.toString('utf8');
}
function readAuthFiles() {
  if (!fs.existsSync(authFolder)) return {};
  const files = {};
  for (const f of fs.readdirSync(authFolder)) {
    // Excluir llaves efímeras de grupos (sender-key-*) que inflaban el ancho de banda a varios GB
    if (!f.endsWith('.json') || f.startsWith('sender-key-')) continue;
    files[f] = fs.readFileSync(path.join(authFolder, f), 'utf8');
  }
  return files;
}
function wipeLocalAuth() {
  if (!fs.existsSync(authFolder)) return;
  for (const f of fs.readdirSync(authFolder)) {
    try { fs.unlinkSync(path.join(authFolder, f)); } catch (e) {}
  }
}

async function backupAuthNow(force = false) {
  if (!WA_AUTH_SECRET || !isOwner) return;
  // Limitar respaldos periódicos a 1 cada 90 min salvo conexión inicial o apagado (ahorro del 99.9% de ancho de banda)
  if (!force && lastBackupSavedAt && Date.now() - lastBackupSavedAt < 90 * 60 * 1000) return;
  const files = readAuthFiles();
  if (!files['creds.json']) return;
  const json = JSON.stringify(files);
  const hash = crypto.createHash('sha256').update(json).digest('hex');
  if (hash === lastBackupHash) {
    lastBackupSavedAt = Date.now();
    return;
  }
  const savedAt = Date.now();
  const ok = await fb('PUT', AUTH_PATH, { ...encryptText(json), savedAt, by: INSTANCE_ID, files: Object.keys(files).length });
  if (ok) {
    lastBackupHash = hash;
    lastBackupSavedAt = savedAt;
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
const convHistoryHydrated = new Set();

function pushHistory(convId, role, text) {
  const arr = convHistory.get(convId) || [];
  arr.push({ role, text: String(text || '').slice(0, 600) });
  while (arr.length > 12) arr.shift();
  convHistory.set(convId, arr);
}

async function ensureConvHistoryLoaded(convId) {
  if (!convId || convHistoryHydrated.has(convId)) return;
  const existingMem = convHistory.get(convId) || [];
  if (existingMem.length >= 3) {
    convHistoryHydrated.add(convId);
    return;
  }
  convHistoryHydrated.add(convId);
  try {
    let rawMsgs = await fb('GET', ws('botMessages'), `orderBy="convId"&equalTo=${encodeURIComponent(JSON.stringify(convId))}`);
    if (!rawMsgs || typeof rawMsgs !== 'object') {
      rawMsgs = await fb('GET', ws('botMessages'), 'orderBy="$key"&limitToLast=250');
    }
    if (!rawMsgs || typeof rawMsgs !== 'object') return;
    const matched = Object.values(rawMsgs)
      .filter(m => m && m.convId === convId && !m.deleted && m.text)
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
      .slice(-10)
      .map(m => ({
        role: m.direction === 'out' ? 'bot' : 'user',
        text: String(m.text || '').slice(0, 600)
      }));
    if (matched.length === 0) return;

    // Evitar duplicar si el último mensaje recién entrante ya se empujó en memoria
    for (const mem of existingMem) {
      const last = matched[matched.length - 1];
      if (!last || last.role !== mem.role || last.text !== mem.text) {
        matched.push(mem);
      }
    }
    convHistory.set(convId, matched.slice(-12));
  } catch (err) {
    logger.warn({ convId, err: err.message }, 'No se pudo hidratar convHistory desde Firebase');
  }
}

const DEFAULT_PAYMENT_METHODS = [
  { id: 'pm_1', name: 'Pago Móvil / Banco', details: 'Banco Banesco (0134) • C.I: 12.345.678 • Tlf: 0412-1234567' },
  { id: 'pm_2', name: 'Binance Pay / USDT', details: 'Pay ID: 123456789 • Red TRC20 / Binance Pay' },
  { id: 'pm_3', name: 'Efectivo Divisas ($)', details: 'Entrega personal en tienda física o delivery en divisas exactas' }
];

const DEFAULT_FAQ = [
  { id: 'faq_1', question: '¿Qué productos y servicios ofrecen en Doomlater?', answer: 'En Doomlater nos especializamos en venta de consolas de videojuegos (PlayStation, Nintendo Switch, Xbox), accesorios, controles, videojuegos, y servicio técnico especializado (mantenimiento preventivo, cambio de pastas térmicas, reparación de controles drift/botones, pantallas y puertos de carga).' },
  { id: 'faq_2', question: '¿Hacen envíos o delivery?', answer: 'Sí, contamos con servicio de delivery en la ciudad y envíos nacionales asegurados a través de MRW, Zoom y Tealca.' },
  { id: 'faq_3', question: '¿Los productos y servicios tienen garantía?', answer: 'Sí, todos nuestros productos cuentan con garantía de 30 días y los servicios técnicos son probados detalladamente antes de la entrega.' },
  { id: 'faq_4', question: '¿Dónde están ubicados y cuál es el horario de atención?', answer: 'Estamos ubicados en nuestro local comercial. Atendemos de Lunes a Sábado de 9:00 AM a 6:00 PM.' }
];

const DEFAULT_SERVICE_INSUMOS_MAP = [
  { id: 'srv_oled_solo', serviceName: 'Instalacion Magia – SOLO (OLED)', insumos: [{ name: 'HwFly', qty: 1 }], defaultInsumoName: 'HwFly', defaultLaborPrice: 50 },
  { id: 'srv_v1v2_combo', serviceName: 'Instalacion Magia + Memoria 128GB + Configuración + Limpieza (V1/V2)', insumos: [{ name: 'Memoria 128Gb ADATA', qty: 1 }, { name: 'HwFly', qty: 1 }], defaultInsumoName: 'Memoria 128Gb ADATA + HwFly', defaultLaborPrice: 35 },
  { id: 'srv_v1v2_solo', serviceName: 'Instalacion Magia – SOLO (V1/V2)', insumos: [{ name: 'HwFly', qty: 1 }], defaultInsumoName: 'HwFly', defaultLaborPrice: 25 },
  { id: 'srv_lite_combo', serviceName: 'Instalacion Magia + Memoria 128GB + Configuración + Limpieza (Lite)', insumos: [{ name: 'HwFly', qty: 1 }], defaultInsumoName: 'HwFly', defaultLaborPrice: 45 },
  { id: 'srv_lite_solo', serviceName: 'Instalacion Magia – SOLO (Lite)', insumos: [{ name: 'HwFly', qty: 1 }], defaultInsumoName: 'HwFly', defaultLaborPrice: 40 },
  { id: 'srv_oled_combo', serviceName: 'Instalacion Magia + Memoria 128GB + Configuración + Limpieza (OLED)', insumos: [{ name: 'HwFly', qty: 1 }], defaultInsumoName: 'HwFly', defaultLaborPrice: 50 }
];

/* --------------------------------------------------------------------------
   SOCIOS / ADMINISTRADORES AUTORIZADOS (Anthony y Sebastián)
   -------------------------------------------------------------------------- */
const PARTNER_ACCOUNTS = [
  {
    name: 'Anthony',
    profileId: 'doom1',
    phone: '584142005801',
    cedula: '25000000',
    jids: ['268135210995915@lid', '584142005801@s.whatsapp.net']
  },
  {
    name: 'Sebastián',
    profileId: 'doom2',
    phone: '584264181643',
    cedula: '32030679',
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

let cachedTgConfig = { data: null, fetchedAt: 0 };
const tgConvCallbackMap = new Map(); // shortKey -> full convId (garantiza <= 64 bytes en callback_data de Telegram)

function makeTgShortConvKey(convId) {
  if (!convId) return '';
  if (Buffer.byteLength(convId, 'utf8') <= 44) return convId;
  const shortKey = 'k_' + crypto.createHash('sha1').update(String(convId)).digest('hex').slice(0, 16);
  tgConvCallbackMap.set(shortKey, convId);
  return shortKey;
}

function resolveTgShortConvKey(shortKey) {
  if (!shortKey) return '';
  return tgConvCallbackMap.get(shortKey) || shortKey;
}

async function getTelegramAndAntiBanConfig(forceRefresh = false) {
  if (!forceRefresh && cachedTgConfig.data && Date.now() - cachedTgConfig.fetchedAt < 4000) {
    return cachedTgConfig.data;
  }
  const cfg = (await fb('GET', ws('meta/botConfig'))) || {};
  const token = String(cfg.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (token && !cfg.telegramBotToken) {
    fb('PATCH', ws('meta/botConfig'), { telegramBotToken: token }).catch(() => {});
  }
  const chatIdsSet = new Set();

  const rawEnvIds = String(process.env.TELEGRAM_CHAT_ID || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  for (const id of rawEnvIds) chatIdsSet.add(id);

  if (cfg.telegramChatId) {
    for (const id of String(cfg.telegramChatId).split(/[,\s]+/).map(s => s.trim()).filter(Boolean)) {
      chatIdsSet.add(id);
    }
  }
  if (cfg.telegramSubscribers && typeof cfg.telegramSubscribers === 'object') {
    for (const sub of Object.values(cfg.telegramSubscribers)) {
      if (sub && sub.chatId) chatIdsSet.add(String(sub.chatId).trim());
    }
  }

  const out = {
    token,
    chatIds: [...chatIdsSet],
    // Modo Anti-Baneo Estricto activo por defecto: NUNCA inicia mensajes de alerta no solicitados por WhatsApp
    antiBanStrictMode: cfg.antiBanStrictMode !== false,
    botConfig: cfg
  };
  cachedTgConfig = { data: out, fetchedAt: Date.now() };
  return out;
}

function buildTelegramInlineButtons(alertKey, options = {}) {
  const key = String(alertKey || '');
  let convId = options.convId || '';
  if (!convId) {
    const m = key.match(/^(?:pay|coord|delivery|human|alert|sale|vo|brandnew|uncorr)_(.+)$/);
    if (m) convId = m[1];
  }
  const cleanPhone = String(options.cleanPhone || '').replace(/\D/g, '');
  const shortId = convId ? makeTgShortConvKey(convId) : '';
  const rows = [];

  if (shortId) {
    if (key.startsWith('pay_')) {
      rows.push([{ text: '✅ Verificar Pago y Avisar al Cliente', callback_data: `vpay:${shortId}` }]);
    } else if (key.startsWith('delivery_')) {
      rows.push([
        { text: '🚚 $2', callback_data: `qdel:${shortId}:2` },
        { text: '🚚 $3', callback_data: `qdel:${shortId}:3` },
        { text: '🚚 $4', callback_data: `qdel:${shortId}:4` },
        { text: '🚚 $5', callback_data: `qdel:${shortId}:5` }
      ]);
    } else if (key.startsWith('coord_')) {
      rows.push([{ text: '📦 Marcar Pedido como Entregado', callback_data: `mdel:${shortId}` }]);
    } else if (/^(?:human|alert|sale|vo|brandnew|uncorr)_/.test(key)) {
      rows.push([{ text: '✅ Quitar Alerta (Ya Atendido)', callback_data: `calr:${shortId}` }]);
    }
  }

  if (cleanPhone && cleanPhone.length >= 10) {
    rows.push([{ text: '💬 Abrir WhatsApp del Cliente', url: `https://wa.me/${cleanPhone}` }]);
  }

  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

async function sendTelegramAlert(text, replyMarkup = undefined, specificChatId = null) {
  try {
    const tg = await getTelegramAndAntiBanConfig();
    if (!tg.token) return false;
    const targets = specificChatId ? [String(specificChatId)] : tg.chatIds;
    if (!targets || targets.length === 0) return false;

    let anySent = false;
    for (const chatId of targets) {
      const payload = {
        chat_id: chatId,
        text: String(text || ''),
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      };
      const res = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify(payload)
      });
      if (res.ok) anySent = true;
      else {
        const errBody = await res.text().catch(() => '');
        logger.warn({ chatId, status: res.status, errBody: errBody.slice(0, 160) }, 'Telegram sendMessage rechazado');
      }
    }
    return anySent;
  } catch (e) {
    logger.warn({ err: e.message }, 'No se pudo enviar alerta por Telegram');
    return false;
  }
}

async function sendTelegramDocument(chatId, pdfBuffer, fileName, caption = '') {
  try {
    const tg = await getTelegramAndAntiBanConfig();
    if (!tg.token || !chatId || !pdfBuffer) return false;
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', String(caption).slice(0, 1020));
    form.append('document', new Blob([pdfBuffer], { type: 'application/pdf' }), fileName || 'Documento_Doomlater.pdf');
    const res = await fetch(`https://api.telegram.org/bot${tg.token}/sendDocument`, {
      method: 'POST',
      signal: AbortSignal.timeout(12000),
      body: form
    });
    return res.ok;
  } catch (e) {
    logger.warn({ err: e.message }, 'No se pudo enviar PDF por Telegram');
    return false;
  }
}

async function notifyPartners(text, alertKey = null, options = {}) {
  const tg = await getTelegramAndAntiBanConfig();

  if (alertKey) {
    const tgCooldownMs = 25 * 1000; // Evita duplicados idénticos en menos de 25s
    const last = partnerAlertCooldown.get(`tg_${alertKey}`) || 0;
    if (Date.now() - last < tgCooldownMs) return;
    partnerAlertCooldown.set(`tg_${alertKey}`, Date.now());
  }

  const replyMarkup = buildTelegramInlineButtons(alertKey, options);
  const sentViaTelegram = await sendTelegramAlert(text, replyMarkup);

  // BLINDAJE ANTI-BANEO TOTAL:
  // Si el Modo Anti-Baneo Estricto está activo (por defecto) o ya se entregó por Telegram,
  // JAMÁS enviamos alertas automáticas salientes por WhatsApp para proteger el número al 100%.
  if (tg.antiBanStrictMode || sentViaTelegram) {
    return;
  }

  if (!waSock || waState !== 'connected') return;
  if (alertKey) {
    const cooldownMs = 15 * 60 * 1000;
    const lastWa = partnerAlertCooldown.get(`wa_${alertKey}`) || 0;
    if (Date.now() - lastWa < cooldownMs) return;
    partnerAlertCooldown.set(`wa_${alertKey}`, Date.now());
  }

  for (let idx = 0; idx < PARTNER_ACCOUNTS.length; idx++) {
    const p = PARTNER_ACCOUNTS[idx];
    if (idx > 0) await new Promise(r => setTimeout(r, 1800));
    for (const jid of p.jids) {
      try {
        await waSend(jid, { text });
        break;
      } catch (err) {
        logger.warn({ target: p.name, jid, err: err.message }, 'No se pudo enviar alerta por este JID');
      }
    }
  }
}

async function notifySinglePartner(target, text) {
  const tg = await getTelegramAndAntiBanConfig();
  if (tg.token && tg.chatIds.length > 0) {
    await sendTelegramAlert(text);
    if (tg.antiBanStrictMode) return { success: true };
  }
  if (tg.antiBanStrictMode) return { success: false, reason: 'anti_ban_strict' };
  return sendPartnerDirectMessage('Doom Bot', target, text);
}

function resolveTargetPartnerTelegramChatIds(tg, fromPartnerName, toTarget) {
  const subs = tg?.botConfig?.telegramSubscribers ? Object.values(tg.botConfig.telegramSubscribers).filter(s => s && s.chatId) : [];
  const targetLower = String(toTarget || '').toLowerCase();
  const wantsSeba = targetLower.includes('seba') || targetLower.includes('doom2')
    || (!targetLower.includes('antho') && !targetLower.includes('doom1') && fromPartnerName === 'Anthony');

  const isAnthonySub = (s) => String(s.chatId) === '1016677286' || /antho/i.test(`${s.name || ''} ${s.username || ''}`);
  const isSebaSub = (s) => /seba/i.test(`${s.name || ''} ${s.username || ''}`) || (!isAnthonySub(s) && s.type === 'private');

  const matched = subs.filter(s => wantsSeba ? isSebaSub(s) : isAnthonySub(s)).map(s => String(s.chatId));
  // También incluir grupos de Telegram vinculados si hicieron un grupo común de socios
  for (const s of subs) {
    if (s.type && s.type !== 'private' && !matched.includes(String(s.chatId))) {
      matched.push(String(s.chatId));
    }
  }
  return { wantsSeba, expectedName: wantsSeba ? 'Sebastián' : 'Anthony', chatIds: matched };
}

/**
 * Envío directo e inmediato de mensajes o documentos PDF a uno de los socios.
 */
async function sendPartnerDirectMessage(fromPartnerName, toTarget, text, pdfAttachment = null) {
  const tg = await getTelegramAndAntiBanConfig(true);
  if (tg.token) {
    const resolved = resolveTargetPartnerTelegramChatIds(tg, fromPartnerName, toTarget);
    if (resolved.chatIds.length > 0) {
      for (const cid of resolved.chatIds) {
        if (pdfAttachment && pdfAttachment.buffer) {
          await sendTelegramDocument(cid, pdfAttachment.buffer, pdfAttachment.fileName, text);
        } else {
          await sendTelegramAlert(text, undefined, cid);
        }
      }
      if (tg.antiBanStrictMode) {
        return { success: true, via: 'Telegram', targetName: resolved.expectedName, targetPhone: 'Telegram' };
      }
    } else if (tg.antiBanStrictMode) {
      return {
        success: false,
        notLinkedYet: true,
        targetName: resolved.expectedName,
        error: `${resolved.expectedName} aún no ha pulsado /start en @Doomlater_Alertas_bot desde su celular.`
      };
    }
  }
  if (tg.antiBanStrictMode) {
    return { success: false, error: 'Modo Anti-Baneo activo: vincula Telegram para envíos directos automáticos.' };
  }
  if (!waSock || waState !== 'connected') {
    return { success: false, error: 'WhatsApp no está conectado' };
  }
  const targetLower = String(toTarget || '').toLowerCase();
  let toPartner = null;
  if (targetLower.includes('seba') || targetLower.includes('socio') || targetLower.includes('doom2') || fromPartnerName === 'Anthony') {
    toPartner = PARTNER_ACCOUNTS[1]; // Sebastián (+584264181643)
  } else {
    toPartner = PARTNER_ACCOUNTS[0]; // Anthony (+584142005801)
  }

  let sent = false;
  let lastErr = null;
  for (const jid of toPartner.jids) {
    try {
      if (pdfAttachment && pdfAttachment.buffer) {
        await waSend(jid, {
          document: pdfAttachment.buffer,
          mimetype: 'application/pdf',
          fileName: pdfAttachment.fileName || 'Reporte_Doomlater.pdf',
          caption: text
        });
      } else {
        await waSend(jid, { text });
      }
      sent = true;
      break;
    } catch (err) {
      lastErr = err;
      logger.warn({ target: toPartner.name, jid, err: err.message }, 'No se pudo enviar mensaje directo al socio');
    }
  }
  return { success: sent, targetName: toPartner.name, targetPhone: toPartner.phone, error: lastErr?.message };
}

/**
 * Generador nativo de documentos PDF multi-página estándar (%PDF-1.4) en puro JavaScript.
 * Sin dependencias externas ni binarios nativos, 100% compatible con Render y WhatsApp.
 */
function buildMultiPagePdf({ title, subtitle, sections }) {
  const sanitize = (str) => {
    if (!str) return '';
    return String(str)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7E]/g, ' ')
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
  };

  const pagesStreams = [];
  let currentStream = '';
  let y = 770;

  const startNewPage = () => {
    if (currentStream) {
      currentStream += 'BT\n/F1 8 Tf\n36 30 Td\n(Doomlater - Documento Oficial Generado por Doom Bot IA) Tj\nET\n';
      pagesStreams.push(currentStream);
    }
    currentStream = '';
    y = 770;

    currentStream += 'BT\n/F2 18 Tf\n36 ' + y + ' Td\n(' + sanitize(title) + ') Tj\nET\n';
    y -= 22;
    if (subtitle) {
      currentStream += 'BT\n/F1 10 Tf\n36 ' + y + ' Td\n(' + sanitize(subtitle) + ') Tj\nET\n';
      y -= 18;
    }
    currentStream += '36 ' + y + ' m 560 ' + y + ' l S\n';
    y -= 25;
  };

  startNewPage();

  for (const sec of sections || []) {
    if (y < 100) startNewPage();
    if (sec.header) {
      currentStream += 'BT\n/F2 12 Tf\n36 ' + y + ' Td\n(' + sanitize(sec.header) + ') Tj\nET\n';
      y -= 18;
    }
    currentStream += '/F1 10 Tf\n';
    for (const line of sec.lines || []) {
      if (y < 60) startNewPage();
      currentStream += 'BT\n36 ' + y + ' Td\n(' + sanitize(line) + ') Tj\nET\n';
      y -= 14;
    }
    y -= 10;
  }

  currentStream += 'BT\n/F1 8 Tf\n36 30 Td\n(Doomlater - Documento Oficial Generado por Doom Bot IA) Tj\nET\n';
  pagesStreams.push(currentStream);

  const numPages = pagesStreams.length;
  const pageObjIds = [];
  for (let i = 0; i < numPages; i++) pageObjIds.push(5 + i * 2);

  const objects = [];
  objects[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  objects[2] = '2 0 obj\n<< /Type /Pages /Kids [' + pageObjIds.map(id => id + ' 0 R').join(' ') + '] /Count ' + numPages + ' >>\nendobj\n';
  objects[3] = '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';
  objects[4] = '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n';

  for (let i = 0; i < numPages; i++) {
    const pageId = 5 + i * 2;
    const streamId = 6 + i * 2;
    const st = pagesStreams[i];
    const len = Buffer.byteLength(st, 'utf8');
    objects[pageId] = pageId + ' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + streamId + ' 0 R >>\nendobj\n';
    objects[streamId] = streamId + ' 0 obj\n<< /Length ' + len + ' >>\nstream\n' + st + 'endstream\nendobj\n';
  }

  const totalObjs = 4 + numPages * 2;
  let offset = 9;
  const xref = ['xref\n0 ' + (totalObjs + 1) + '\n0000000000 65535 f \n'];
  let pdfStr = '%PDF-1.4\n';

  for (let i = 1; i <= totalObjs; i++) {
    const obj = objects[i];
    xref.push(String(offset).padStart(10, '0') + ' 00000 n \n');
    pdfStr += obj;
    offset += Buffer.byteLength(obj, 'utf8');
  }

  const startxref = offset;
  pdfStr += xref.join('');
  pdfStr += 'trailer\n<< /Size ' + (totalObjs + 1) + ' /Root 1 0 R >>\nstartxref\n' + startxref + '\n%%EOF\n';

  return Buffer.from(pdfStr, 'utf8');
}

/**
 * Generador temático de reportes PDF oficiales para Doomlater.Corp
 */
function generateDoomPdf(type, adminCtx, requesterName = 'Socio') {
  const isStock = /(stock|inventario|articulos|productos|insumos)/i.test(String(type || ''));
  const now = new Date();
  const dateStr = now.toLocaleDateString('es-VE', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });

  if (isStock) {
    const linesSellables = (adminCtx.sellables || []).map(i =>
      `* ${i.name} (${i.category || 'Venta'}): Stock ${i.stock} uds | PVP: $${Number(i.salePrice || 0).toFixed(2)} | Costo: $${Number(i.purchaseCost || 0).toFixed(2)}`
    );
    const linesInsumos = (adminCtx.insumos || []).map(i =>
      `* ${i.name} (Insumo Taller): Stock ${i.stock} uds | Costo: $${Number(i.purchaseCost || 0).toFixed(2)}`
    );

    const sections = [
      {
        header: '1. Resumen General del Inventario',
        lines: [
          `Total articulos para la venta: ${adminCtx.sellables.length} producto(s)`,
          `Total insumos para taller y reparaciones: ${adminCtx.insumos.length} insumo(s)`,
          `Articulos en stock critico o agotados: ${adminCtx.lowStock.length} articulo(s)`
        ]
      },
      {
        header: '2. Catalogo de Productos para la Venta',
        lines: linesSellables.length > 0 ? linesSellables : ['(No hay productos de venta registrados)']
      },
      {
        header: '3. Insumos de Taller y Servicio Tecnico',
        lines: linesInsumos.length > 0 ? linesInsumos : ['(No hay insumos de taller registrados)']
      }
    ];

    const buffer = buildMultiPagePdf({
      title: 'Doomlater - Inventario Oficial de Stock',
      subtitle: `Fecha: ${dateStr} - ${timeStr} | Solicitado por: @${requesterName}`,
      sections
    });

    return {
      buffer,
      fileName: `Inventario_Doomlater_${now.toISOString().slice(0, 10)}.pdf`,
      title: 'Inventario Oficial de Stock'
    };
  }

  // Por defecto: Estado de Cuenta Financiero
  const walletsLines = (adminCtx.walletBalances || []).map(w => {
    if (w.isBs) {
      const eq = adminCtx.exchangeRate > 0 ? (w.balance / adminCtx.exchangeRate).toFixed(2) : '0.00';
      return `* ${w.name}: Bs. ${w.balance.toFixed(2)} (~$${eq} USDT a tasa ${adminCtx.exchangeRate} Bs/$)`;
    } else {
      return `* ${w.name}: $${w.balance.toFixed(2)} ${w.currency}`;
    }
  });

  const recentLines = (adminCtx.recentTxs || []).slice(0, 15).map(t =>
    typeof t === 'string' ? t.replace(/^[•*-]\s*/, '') : JSON.stringify(t)
  );

  const sections = [
    {
      header: '1. Resumen Patrimonial Consolidado',
      lines: [
        `GRAN TOTAL CONSOLIDADO: $${adminCtx.grandTotalUsdt.toFixed(2)} USDT`,
        `Fondos Directos en Divisas (Binance + Efectivo): $${adminCtx.totalUsdDirect.toFixed(2)} USDT`,
        `Fondos en Bolivares (Bancos): Bs. ${adminCtx.totalBs.toFixed(2)} (~$${adminCtx.bsConvertedToUsdt.toFixed(2)} USDT)`,
        `Tasa de cambio de referencia: ${adminCtx.exchangeRate} Bs/USD`
      ]
    },
    {
      header: '2. Desglose Detallado por Cuentas y Billeteras',
      lines: walletsLines
    },
    {
      header: '3. Movimientos Registrados Hoy',
      lines: [
        `Ingresos en divisas: +$${adminCtx.todayIncomeUsd.toFixed(2)} USD`,
        `Ingresos en bolivares: +Bs. ${adminCtx.todayIncomeBs.toFixed(2)}`,
        `Ingreso total equivalente hoy: +$${adminCtx.todayTotalIncomeEquivUsdt.toFixed(2)} USDT`,
        `Ganancia neta estimada hoy: +$${adminCtx.todayTotalProfitEquivUsdt.toFixed(2)} USDT`
      ]
    },
    {
      header: '4. Ultimas Transacciones Registradas en el Sistema',
      lines: recentLines.length > 0 ? recentLines : ['(Sin transacciones recientes registradas)']
    }
  ];

  const buffer = buildMultiPagePdf({
    title: 'Doomlater - Estado de Cuenta Financiero',
    subtitle: `Fecha: ${dateStr} - ${timeStr} | Solicitado por: @${requesterName}`,
    sections
  });

  return {
    buffer,
    fileName: `Estado_De_Cuenta_Doomlater_${now.toISOString().slice(0, 10)}.pdf`,
    title: 'Estado de Cuenta Financiero'
  };
}

/**
 * Generador de Facturas Oficiales en PDF (Exclusivo para Socios de Doomlater)
 */
function generateDoomInvoicePdf({ clientName, items, rates, requesterName = 'Socio' }) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('es-VE', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
  const cleanClient = String(clientName || 'Cliente').replace(/[^a-zA-Z0-9]/g, '_');

  let subtotal = 0;
  const itemLines = (items || []).map((it, idx) => {
    const lineTotal = (Number(it.qty) || 1) * (Number(it.price) || 0);
    subtotal += lineTotal;
    return `${idx + 1}. ${it.description || 'Item'} - Cant: ${it.qty || 1} | P.Unit: $${Number(it.price || 0).toFixed(2)} | Subtotal: $${lineTotal.toFixed(2)} USD`;
  });

  const ratePar = rates?.paralelo || 1000;
  const rateBcv = rates?.bcv || 890;
  const totalBs = subtotal * ratePar;
  const totalBcv = rateBcv > 0 ? (totalBs / rateBcv) : subtotal;

  const sections = [
    {
      header: '1. Informacion de la Factura y del Cliente',
      lines: [
        `Empresa Emisora: Doomlater`,
        `Fecha de Emision: ${dateStr} - ${timeStr}`,
        `Cliente: ${clientName}`,
        `Atendido por: @${requesterName} (Equipo Doomlater)`
      ]
    },
    {
      header: '2. Detalle de Productos y Servicios Facturados',
      lines: itemLines.length > 0 ? itemLines : ['(Sin articulos)']
    },
    {
      header: '3. Resumen y Total a Cancelar',
      lines: [
        `TOTAL EN DIVISAS: $${subtotal.toFixed(2)} USD / USDT`,
        `Equivalente en Bolivares (Tasa Paralelo/USDT ${ratePar.toFixed(2)} Bs/$): Bs. ${totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2 })}`,
        `Equivalente a Tasa Oficial BCV (${rateBcv.toFixed(2)} Bs/$): $${totalBcv.toFixed(2)} USD`
      ]
    },
    {
      header: '4. Condiciones de Entrega y Garantia',
      lines: [
        `* Garantia oficial de 30 dias continuos sobre repuestos nuevos y servicios tecnicos.`,
        `* Conserve este comprobante digital oficial emitido por Doomlater.`,
        `* Gracias por su preferencia en Doomlater.`
      ]
    }
  ];

  const buffer = buildMultiPagePdf({
    title: 'Doomlater - Factura Oficial de Venta / Servicio',
    subtitle: `Factura Nro. DLT-${now.getFullYear()}-${Math.floor(1000 + Math.random() * 9000)} | Cliente: ${clientName}`,
    sections
  });

  return {
    buffer,
    fileName: `Factura_Doomlater_${cleanClient}_${now.toISOString().slice(0, 10)}.pdf`,
    title: `Factura Oficial - ${clientName}`,
    subtotal
  };
}

/**
 * Generador de Contratos de Servicio y Garantía en PDF (Exclusivo para Socios de Doomlater)
 */
function generateDoomContractPdf({ clientName, serviceName, equipment, requesterName = 'Socio' }) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('es-VE', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
  const cleanClient = String(clientName || 'Cliente').replace(/[^a-zA-Z0-9]/g, '_');

  const sections = [
    {
      header: '1. Partes del Contrato de Servicio',
      lines: [
        `PRESTADOR DEL SERVICIO: Doomlater (Representado por @${requesterName})`,
        `CLIENTE BENEFICIARIO: ${clientName}`,
        `FECHA: ${dateStr} - ${timeStr}`
      ]
    },
    {
      header: '2. Objeto del Contrato y Especificaciones Tecnicas',
      lines: [
        `Servicio Contratado: ${serviceName || 'Servicio Tecnico Especializado'}`,
        `Equipo / Dispositivo: ${equipment || 'Consola / Accesorio de Videojuegos'}`,
        `Trabajo a Realizar: Diagnostico, mantenimiento, instalacion de piezas e insumos oficiales y pruebas de control de calidad.`
      ]
    },
    {
      header: '3. Cláusulas y Terminos de Garantia',
      lines: [
        `PRIMERA: Doomlater garantiza mano de obra tecnica calificada y materiales de primera calidad.`,
        `SEGUNDA: Se otorga garantia de 30 dias continuos a partir de la entrega del equipo funcional.`,
        `TERCERA: La garantia queda sin efecto ante caidas, derrame de liquidos o intervencion de terceros.`,
        `CUARTA: Entregas acordadas en CC El Lider, La Previsora o Delivery autorizado.`
      ]
    },
    {
      header: '4. Conformidad y Firmas',
      lines: [
        `Por Doomlater: @${requesterName} (Firma Autorizada)`,
        `Por el Cliente: ${clientName} (Firma de Conformidad)`
      ]
    }
  ];

  const buffer = buildMultiPagePdf({
    title: 'Doomlater - Contrato de Servicio Tecnico y Garantia',
    subtitle: `Contrato Oficial DLT-CON-${now.getFullYear()}-${Math.floor(1000 + Math.random() * 9000)} | Cliente: ${clientName}`,
    sections
  });

  return {
    buffer,
    fileName: `Contrato_Doomlater_${cleanClient}_${now.toISOString().slice(0, 10)}.pdf`,
    title: `Contrato de Servicio - ${clientName}`
  };
}

async function checkLowStockAndAlert() {
  if (!isOwner) return;
  try {
    const tg = await getTelegramAndAntiBanConfig();
    if (!tg.token && waState !== 'connected') return;

    const [stockRaw, persistedAlerts] = await Promise.all([
      fb('GET', ws('stockItems')),
      fb('GET', ws('meta/lowStockAlerted'))
    ]);
    if (!stockRaw) return;

    const items = Object.values(stockRaw).filter(i => i && !i.deleted);
    const prevMap = (persistedAlerts && typeof persistedAlerts === 'object') ? persistedAlerts : {};
    const now = Date.now();
    const cooldownMs = 24 * 60 * 60 * 1000; // 1 vez cada 24h persistido en Firebase (inmune a reinicios de Render)
    const triggeredLines = [];
    const patchMap = {};

    for (const it of items) {
      const stockNum = Number(it.stock) || 0;
      const minStock = it.minStock !== undefined ? Number(it.minStock) : 1;
      if (stockNum <= minStock) {
        const key = `${safeId(it.id)}_${stockNum}`;
        const last = Number(prevMap[key] || partnerAlertCooldown.get(`stock_${key}`) || 0);
        if (now - last < cooldownMs) continue;
        partnerAlertCooldown.set(`stock_${key}`, now);
        patchMap[key] = now;
        triggeredLines.push(
          stockNum <= 0
            ? `• 🚨 *AGOTADO:* ${it.name} (0 uds)`
            : `• ⚠️ *Stock bajo:* ${it.name} (${stockNum} ud)`
        );
      }
    }

    if (triggeredLines.length > 0) {
      await fb('PATCH', ws('meta/lowStockAlerted'), patchMap);
      const alertMsg =
        `📦 *DOOMLATER ALERT: Resumen de Inventario Crítico*\n\n` +
        triggeredLines.join('\n') +
        `\n\n👉 _Atento para reposición en el panel de Stock._`;
      await notifyPartners(alertMsg, `stock_batch_${Math.floor(now / 60000)}`);
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'Error en chequeo de stock bajo');
  }
}

let cachedRates = { bcv: 891.10, paralelo: 1004.32, updatedAt: 0 };
async function getLiveExchangeRates() {
  if (Date.now() - cachedRates.updatedAt < 15 * 60 * 1000 && cachedRates.bcv > 0 && cachedRates.paralelo > 0) {
    return cachedRates;
  }
  try {
    const res = await fetch('https://ve.dolarapi.com/v1/dolares', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const ofi = Array.isArray(data) ? data.find(d => d.fuente === 'oficial') : null;
      const par = Array.isArray(data) ? data.find(d => d.fuente === 'paralelo') : null;
      const bcvVal = ofi ? Number(ofi.promedio) : 0;
      const parVal = par ? Number(par.promedio) : (data[0] ? Number(data[0].promedio) : 0);
      if (bcvVal > 0) cachedRates.bcv = Math.round(bcvVal * 100) / 100;
      if (parVal > 0) cachedRates.paralelo = Math.round(parVal * 100) / 100;
      cachedRates.updatedAt = Date.now();
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'No se pudo obtener tasas en vivo de dolarapi');
  }
  return cachedRates;
}

async function getLiveExchangeRate() {
  const rates = await getLiveExchangeRates();
  return rates.paralelo || 1000;
}

async function loadAdminExecutiveContext() {
  const [walletsRaw, stockRaw, txsRaw, convsRaw, botConfigRaw, obligRaw, partnerSalesRaw] = await Promise.all([
    fb('GET', ws('wallets')),
    fb('GET', ws('stockItems')),
    fb('GET', ws('transactions')),
    fb('GET', ws('botConversations')),
    fb('GET', ws('meta/botConfig')),
    fb('GET', ws('obligations')),
    fb('GET', ws('partnerPendingRegistrations'))
  ]);

  const wallets = walletsRaw ? Object.values(walletsRaw).filter(w => w && !w.deleted) : [];
  const stock = stockRaw ? Object.values(stockRaw).filter(i => i && !i.deleted) : [];
  const txs = txsRaw ? Object.values(txsRaw).filter(t => t && !t.deleted) : [];
  const convs = convsRaw ? Object.values(convsRaw).filter(c => c && !c.deleted) : [];
  const botConfig = botConfigRaw || {};
  const obligations = obligRaw ? Object.values(obligRaw).filter(o => o && !o.deleted) : [];
  const partnerSales = partnerSalesRaw ? Object.values(partnerSalesRaw).filter(p => p && !p.deleted && p.status === 'pending') : [];

  const exchangeRate = await getLiveExchangeRate();

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
    const isBs = (
      w.currency === 'VES' ||
      w.currency === 'BS' ||
      String(w.symbol || '').includes('Bs') ||
      w.name.toLowerCase().includes('cuenta') ||
      w.name.toLowerCase().includes('banco')
    );
    return {
      id: w.id,
      name: w.name,
      currency: w.currency || (isBs ? 'VES' : 'USD'),
      symbol: w.symbol || (isBs ? 'Bs.' : '$'),
      isBs,
      balance: bal
    };
  });

  // Totales separados: Divisas vs Bolívares
  let totalUsdDirect = 0;
  let totalBs = 0;
  for (const wb of walletBalances) {
    if (wb.isBs) {
      totalBs += wb.balance;
    } else {
      totalUsdDirect += wb.balance;
    }
  }

  const bsConvertedToUsdt = exchangeRate > 0 ? (totalBs / exchangeRate) : 0;
  const grandTotalUsdt = totalUsdDirect + bsConvertedToUsdt;

  // Movimientos de hoy separados por moneda
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayTxs = txs.filter(t => (t.date === todayStr || (t.createdAt && new Date(t.createdAt).toISOString().slice(0, 10) === todayStr)) && t.paid !== false);

  let todayIncomeUsd = 0;
  let todayIncomeBs = 0;
  let todayProfitUsd = 0;
  let todayProfitBs = 0;

  for (const t of todayTxs) {
    if (t.type !== 'income') continue;
    const amt = Number(t.amount) || 0;
    const profit = Number(t.netProfit !== undefined ? t.netProfit : t.amount) || 0;
    const w = walletBalances.find(wb => wb.id === t.walletId);
    if (w && w.isBs) {
      todayIncomeBs += amt;
      todayProfitBs += profit;
    } else {
      todayIncomeUsd += amt;
      todayProfitUsd += profit;
    }
  }

  const todayIncomeBsConverted = exchangeRate > 0 ? (todayIncomeBs / exchangeRate) : 0;
  const todayTotalIncomeEquivUsdt = todayIncomeUsd + todayIncomeBsConverted;
  const todayTotalProfitEquivUsdt = todayProfitUsd + (exchangeRate > 0 ? (todayProfitBs / exchangeRate) : 0);

  // Últimas 35 transacciones legibles
  const recentTxs = txs
    .sort((a, b) => `${b.date || ''} ${b.time || '00:00'}`.localeCompare(`${a.date || ''} ${a.time || '00:00'}`) || (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 35)
    .map(t => {
      const w = walletBalances.find(wb => wb.id === t.walletId);
      const isBs = w ? w.isBs : false;
      const cur = isBs ? 'Bs.' : '$';
      return `- [${t.date || 'Hoy'}] ${t.type.toUpperCase()}: ${cur} ${Number(t.amount || 0).toFixed(2)} | Concepto: "${t.title || t.name || t.notes || 'Operación'}" | Cuenta: ${w ? w.name : 'Caja'}${t.netProfit !== undefined ? ` | Ganancia neta: $${Number(t.netProfit).toFixed(2)}` : ''}`;
    });

  const sellables = stock.filter(i => i.kind === 'para_vender');
  const insumos = stock.filter(i => i.kind === 'insumo');
  const lowStock = stock.filter(i => (Number(i.stock) || 0) <= (Number(i.minStock) || 2));
  const zeroStock = stock.filter(i => (Number(i.stock) || 0) <= 0);
  const pendingPayments = convs.filter(c => c.pendingPayment);
  const alertConvs = convs.filter(c => !c.deleted && (c.needsAttention || c.pendingPayment));

  return {
    walletBalances,
    exchangeRate,
    totalUsdDirect,
    totalBs,
    bsConvertedToUsdt,
    grandTotalUsdt,
    todayIncomeUsd,
    todayIncomeBs,
    todayTotalIncomeEquivUsdt,
    todayProfitUsd,
    todayProfitBs,
    todayTotalProfitEquivUsdt,
    stock,
    sellables,
    insumos,
    lowStock,
    zeroStock,
    pendingPayments,
    alertConvs,
    recentTxs,
    obligations,
    partnerSales,
    botConfig
  };
}

function buildAdminSystemPrompt(adminCtx, partnerName) {
  const walletsSummary = adminCtx.walletBalances.map(w => {
    if (w.isBs) {
      const equiv = adminCtx.exchangeRate > 0 ? (w.balance / adminCtx.exchangeRate).toFixed(2) : '0.00';
      return `- ${w.name}: Bs. ${w.balance.toFixed(2)} (~$${equiv} USDT a tasa ${adminCtx.exchangeRate} Bs/$)`;
    } else {
      return `- ${w.name}: $${w.balance.toFixed(2)} ${w.currency}`;
    }
  }).join('\n');

  const stockSummary = adminCtx.stock.map(i => {
    const kind = i.kind === 'insumo' ? 'Insumo Taller' : 'Producto Venta';
    return `- ${i.name} (${kind} | ${i.category || 'General'}): stock ${i.stock} uds | PVP: $${Number(i.salePrice || 0).toFixed(2)} | Costo compra: $${Number(i.purchaseCost || 0).toFixed(2)}`;
  }).join('\n');

  const lowStockSummary = adminCtx.lowStock.length > 0
    ? adminCtx.lowStock.map(i => `- ${i.name}: ${i.stock <= 0 ? 'AGOTADO (0 uds)' : `solo ${i.stock} unidad(es)`}`).join('\n')
    : 'Todo el stock en niveles óptimos';

  const pendingSummary = adminCtx.pendingPayments.length > 0
    ? adminCtx.pendingPayments.map(c => `- ${c.customerName || 'Cliente'} (${c.customerPhone || c.platform}): $${Number(c.pendingPaymentAmount || 0).toFixed(2)} por "${c.pendingPaymentItem || 'Servicio/Venta'}"`).join('\n')
    : 'No hay pagos pendientes de verificar';

  const alertsSummary = adminCtx.alertConvs && adminCtx.alertConvs.length > 0
    ? adminCtx.alertConvs.map(c => `- ${c.customerName || 'Cliente'} (${c.customerPhone || c.platform}): ${c.pendingPayment ? `PAGO POR VERIFICAR ($${Number(c.pendingPaymentAmount || 0).toFixed(2)})` : `ATENCIÓN REQUERIDA (${c.attentionReason || 'Consulta sin responder'})`} | Último msj: "${(c.lastMessage || '').slice(0, 70)}"`).join('\n')
    : 'No hay chats con alertas ni clientes esperando en la Web';

  const partnerSalesSummary = adminCtx.partnerSales.length > 0
    ? adminCtx.partnerSales.map(s => `- Venta registrada por ${s.registeredBy || 'Socio'}: ${s.detail} por $${s.amount} (${s.isBs ? 'Bs.' : 'USDT'}, cuenta ${s.targetWalletName || 'Billetera'}) esperando verificación en la web`).join('\n')
    : 'No hay ventas de socios pendientes por verificar';

  const recentTxsSummary = adminCtx.recentTxs.slice(0, 20).join('\n') || '(Sin transacciones recientes)';

  const servicesSummary = (adminCtx.botConfig?.serviceInsumosMap || [])
    .map(s => {
      const insList = (Array.isArray(s.insumos) && s.insumos.length > 0)
        ? s.insumos.map(i => `${i.qty}x ${i.name} ($${Number(i.unitCost || i.cost || 0).toFixed(2)})`).join(' + ')
        : (s.defaultInsumoName || 'Solo mano de obra');
      const labor = Number(s.laborPrice !== undefined ? s.laborPrice : (s.defaultLaborPrice || 0)).toFixed(2);
      const calcInsumosCost = (Array.isArray(s.insumos) && s.insumos.length > 0)
        ? s.insumos.reduce((sum, it) => sum + (Number(it.unitCost || it.cost || 0) * (Number(it.qty) || 1)), 0)
        : 0;
      const insCost = Number(s.insumosCost !== undefined ? s.insumosCost : calcInsumosCost).toFixed(2);
      const opCost = Number(s.operatingCost || s.operationalCost || 0).toFixed(2);
      const total = Number(s.totalCost !== undefined ? s.totalCost : (Number(labor) + Number(insCost) + Number(opCost))).toFixed(2);
      const custom = s.customMessage ? ` | Mensaje cliente: "${s.customMessage}"` : '';
      return `- ${s.serviceName}: TOTAL $${total} USD (Mano de obra: $${labor} USD, Insumos: $${insCost} USD [${insList}], Costos Operativos: $${opCost} USD)${custom}`;
    })
    .join('\n');

  const customRules = adminCtx.botConfig?.customAiRules ? `
=== REGLAS DE NEGOCIO DEFINIDAS EN LA WEB ===
${adminCtx.botConfig.customAiRules}
` : '';

  return `Eres "Doom Bot", el Asistente Ejecutivo Inteligente y Asesor de Operaciones Privado de Doomlater, interactuando en vivo por WhatsApp con uno de los dueños fundadores: ${partnerName} (Anthony = @doom1, Sebastián = @doom2).

REGLA DE IGUALDAD EJECUTIVA: Trata siempre a ambos socios (Anthony y Sebastián) con el mismo respeto, igualdad de condiciones, transparencia y acceso total a todas las herramientas, balances, stock y servicios de la empresa.

CONSULTAS DE SERVICIOS TÉCNICOS Y PRESUPUESTOS (DE FORMA AUTÓNOMA):
- Cuando ${partnerName} o su socio te pregunte por cualquier servicio técnico (ej: "¿cuánto sale la magia de Switch OLED?", "precio de magia V1", "¿cuánto cuesta el mantenimiento?"):
  1. Brinda SIEMPRE el COSTO COMPLETO TOTAL y su desglose detallado con la información oficial de la web y base de datos:
     • 🛠️ Servicio: [Nombre exacto del servicio]
     • 💵 Costo Total: $XX.XX USD
     • 👨‍🔧 Mano de obra: $XX.XX USD
     • 📦 Insumos vinculados: $XX.XX USD (ej: 1x Chip HwFly, 1x Memoria 128Gb)
     • ⚡ Costos Operativos: $XX.XX USD
  2. OPCIÓN SIN MEMORIA / CLIENTE TRAE SU PROPIA MEMORIA:
     • Si el socio te pide el costo o presupuesto SIN MEMORIA (o si el cliente ya tiene su propia memoria microSD):
       - Consulta de forma autónoma la versión SOLO del servicio registrada en la base de datos (por ejemplo: "Instalación Magia/Chipeo (SOLO) - OLED", "Instalacion Magia/Chipeo – SOLO (V1/V2)", "Instalacion Magia/Chipeo – SOLO (Lite)").
       - Informa el costo total sin memoria de forma autónoma y explica qué incluye (chip, instalación, pasta térmica, limpieza y garantía sin suministrar la microSD).

Tu misión: Responder CUALQUIER pregunta que te haga ${partnerName} sobre la base de datos de la empresa (dinero acumulado, stock, precios, insumos, clientes, deudas, transacciones pasadas, etc.) con datos 100% exactos, precisos y sin inventar nada.

REGLA CRÍTICA DE MONEDAS Y MATEMÁTICAS (NUNCA MEZCLAR BS CON USD):
- En Venezuela existen bolívares (Bs) y divisas (USDT/USD).
- Tasa de cambio actual en vivo estimada: ${adminCtx.exchangeRate} Bs/USD.
- Billeteras directas en divisas (Binance USDT + Efectivo Caja): $${adminCtx.totalUsdDirect.toFixed(2)} USDT.
- Billeteras en Bolívares (Cuentas bancarias de Sebastián y Anthony): Bs. ${adminCtx.totalBs.toFixed(2)}.
- Conversión de los Bolívares a USDT: Bs. ${adminCtx.totalBs.toFixed(2)} / ${adminCtx.exchangeRate} = $${adminCtx.bsConvertedToUsdt.toFixed(2)} USDT.
- GRAN TOTAL CONSOLIDADO DEL NEGOCIO: $${adminCtx.grandTotalUsdt.toFixed(2)} USDT.
- NUNCA sumes números de bolívares directamente a los dólares (ej: sumar 5000 Bs + $270 no da $5270, da $275.09 USDT).
- Si el socio te pregunta "¿cuánto hay en total?" o "¿cuánta plata tenemos?", dale siempre el desglose claro y el GRAN TOTAL CONSOLIDADO en USDT explicando la conversión rápida de los Bs.
- Si el socio te dice que te equivocaste o "sumaste mal", discúlpate con cordialidad y muestra el cálculo exacto paso a paso con la tasa del día.

REGLAS DE FORMATO Y ESTILO:
- Escribe en español latino, formato impecable de WhatsApp: negritas (*palabra*), viñetas (•) y emojis pertinentes.
- REGLA DE CONCLUSIÓN: NUNCA dejes una respuesta, reporte o lista a la mitad. Toda respuesta debe estar 100% terminada y concluir con punto final.
- Tono: Colega ejecutivo, proactivo, rápido, gamer, de absoluta confianza.

CAPACIDAD REAL PARA DISPARAR MENSAJES Y ENVIAR REPORTES PDF A LOS SOCIOS:
¡TÚ SÍ TIENES LA CAPACIDAD DE ENVIAR MENSAJES DIRECTOS Y REPORTES PDF POR WHATSAPP AL OTRO SOCIO! NUNCA digas que no puedes enviar mensajes o que no puedes disparar mensajes a otros chats.

Cuando ${partnerName} te pida en lenguaje natural que le envíes algo a su socio (@Sebastián o @Anthony):
1. Si te pide avisarle, recordarle o enviarle un mensaje al socio (ej: "avísale a sebastián que...", "envíale un mensaje a mi socio que revise tal cosa"):
   Inserta en tu respuesta la orden:
   [ACCION_ENVIAR: sebastian | texto exacto que quieres que reciba el socio]
2. Si te pide enviarle un estado de cuenta, balance o inventario en PDF al socio:
   [ACCION_PDF_SOCIO: sebastian | estado_cuenta | Nota o resumen para acompañar el PDF]
3. Si el propio ${partnerName} te pide un PDF para él mismo:
   [ACCION_PDF_LOCAL: estado_cuenta | Nota de entrega]
(Usa "stock" si piden inventario o catálogo, o "estado_cuenta" si piden finanzas o balance).

4. Si te pide generar una Factura Digital (Diseño oficial ItsDoomlater con desglose, abonos, saldo pendiente y garantía):
   [ACCION_PDF_FACTURA_DIGITAL: <cliente> | <detalles de equipos, abonos y precios>]

5. Si te pide generar un Contrato o Acuerdo (Diseño oficial con cláusulas, recuadro de exclusión estricta y firmas):
   [ACCION_PDF_CONTRATO: <nombre> | <cédula> | <título o servicio>]

El servidor interceptará estas órdenes automáticamente, generará el PDF y/o enviará el mensaje al WhatsApp del socio (+584264181643 para Sebastián o +584142005801 para Anthony), y le confirmará a ${partnerName}.

REGISTRO DE TRANSACCIONES DIRECTO AL DASHBOARD EN TIEMPO REAL:
Tanto Anthony (@doom1) como Sebastián (@doom2) pueden agregar transacciones directamente al dashboard contable mediante notas de voz (audio) o mensajes de texto.
Los datos necesarios son:
1. Título / Concepto
2. Monto
3. Moneda (USD, USDT o Bs.)
4. Descripción
5. Fecha (hoy o fecha específica) y Hora (a la que se acordó o se empezó a hablar)
El servidor intercepta y procesa estas transacciones en tiempo real (<100ms) asentándolas bajo el perfil del socio correspondiente. Si el socio solo dice que quiere registrar una transacción sin dar los datos, indícale amablemente los datos requeridos y anímalo a enviarte una sola nota de voz con todo.

ELIMINACIÓN DE TRANSACCIONES DIRECTO DESDE WHATSAPP EN TIEMPO REAL:
¡Tanto Anthony (@doom1) como Sebastián (@doom2) cuentan con permisos ejecutivos de Administrador para ELIMINAR transacciones del Dashboard directamente desde WhatsApp!
NUNCA digas que no cuentas con permisos de base de datos, ni que no puedes ejecutar sentencias DELETE, ni que el historial de transacciones ya asentadas es inmutable o de solo lectura.
Si el socio te consulta si puedes borrar/eliminar transacciones, o si te solicita eliminar una transacción:
- Confírmale de inmediato y con total seguridad que SÍ puedes eliminar transacciones en tiempo real.
- Explícale que para borrarla solo debe indicarte cuál desea eliminar (ej: "Elimina la última transacción", "Borra la transacción de 5$", "Elimina la venta de cargador").
- Explícale que el bot le mostrará siempre una tarjeta de verificación con todos los datos (título, monto, cuenta, fecha y hora) y le solicitará confirmación ("CONFIRMAR" o "CANCELAR") antes de borrarla definitivamente de la Web y revertir el inventario si fue una venta.

REGLA CRÍTICA DE CONFIRMACIÓN 100% EN LA WEB Y VELOCIDAD DE RESPUESTA:
- Si confirmas una orden, instrucción, venta, ajuste de inventario o transacción a los socios por WhatsApp, significa obligatoriamente que la acción ya fue verificada y asentada al 100% en la base de datos de la Web en tiempo real.
- NUNCA des confirmaciones falsas, dudosas o a medias; si confirmas por WhatsApp, la Web ya está 100% actualizada.
- Sé sumamente rápido, conciso, ejecutivo y directo al grano para minimizar los tiempos de respuesta.

=== ESTADO FINANCIERO Y BALANCES EN VIVO ===
• Gran Total Consolidado en USDT: $${adminCtx.grandTotalUsdt.toFixed(2)} USDT
• Subtotal Divisas Directas: $${adminCtx.totalUsdDirect.toFixed(2)} USDT
• Subtotal Bolívares: Bs. ${adminCtx.totalBs.toFixed(2)} (~$${adminCtx.bsConvertedToUsdt.toFixed(2)} USDT a ${adminCtx.exchangeRate} Bs/$)
• Desglose por Cuentas:
${walletsSummary}

• Ingresos hoy:
  - En Divisas: +$${adminCtx.todayIncomeUsd.toFixed(2)} USD
  - En Bolívares: +Bs. ${adminCtx.todayIncomeBs.toFixed(2)} (~$${(adminCtx.todayIncomeBs / (adminCtx.exchangeRate || 1)).toFixed(2)} USDT)
  - Total equivalente hoy: +$${adminCtx.todayTotalIncomeEquivUsdt.toFixed(2)} USDT (Ganancia neta: +$${adminCtx.todayTotalProfitEquivUsdt.toFixed(2)} USDT)

=== INVENTARIO Y STOCK EN VIVO ===
${stockSummary || '(No hay productos registrados en inventario)'}

=== PRODUCTOS O INSUMOS POR AGOTARSE O AGOTADOS ===
${lowStockSummary}

=== PAGOS DE CLIENTES PENDIENTES DE VERIFICAR ===
${pendingSummary}

=== CHATS CON ALERTAS O ATENCIÓN REQUERIDA EN LA WEB ===
${alertsSummary}

=== VENTAS REGISTRADAS POR WHATSAPP PENDIENTES DE VERIFICACIÓN EN WEB ===
${partnerSalesSummary}

=== CATÁLOGO DE SERVICIOS TÉCNICOS Y TARIFAS VINCULADAS ===
${servicesSummary || '(No hay servicios técnicos configurados)'}

=== ÚLTIMAS TRANSACCIONES EN EL SISTEMA ===
${recentTxsSummary}
${customRules}`;
}

function fallbackAdminRuleBased(userText, ctx, partnerName) {
  const q = String(userText || '').toLowerCase().trim();

  // 1. Dinero / Saldo / Balance / Caja / Acumulado / Total
  if (/(dinero|plata|cuanto|cuánto|saldo|balance|caja|acumulado|cuentas|billetera|total)/i.test(q)) {
    const lines = [
      `💼 *Resumen Financiero Doomlater* (${partnerName})`,
      `💰 *GRAN TOTAL CONSOLIDADO:* *$${ctx.grandTotalUsdt.toFixed(2)} USDT*`,
      ``,
      `*Desglose por Cuentas:*`
    ];
    for (const wb of ctx.walletBalances) {
      if (wb.isBs) {
        const equiv = ctx.exchangeRate > 0 ? (wb.balance / ctx.exchangeRate).toFixed(2) : '0.00';
        lines.push(`• *${wb.name}:* Bs. ${wb.balance.toFixed(2)} (~$${equiv} USDT a tasa ${ctx.exchangeRate} Bs/$)`);
      } else {
        lines.push(`• *${wb.name}:* $${wb.balance.toFixed(2)} ${wb.currency}`);
      }
    }
    lines.push(
      ``,
      `*Subtotales:*`,
      `💵 Divisas directas: *$${ctx.totalUsdDirect.toFixed(2)} USDT*`,
      `🇻🇪 Bolívares en bancos: *Bs. ${ctx.totalBs.toFixed(2)}* (equivale a *$${ctx.bsConvertedToUsdt.toFixed(2)} USDT*)`,
      `📈 Tasa de cambio estimada: *${ctx.exchangeRate} Bs/USD*`
    );
    if (ctx.todayTotalIncomeEquivUsdt > 0 || ctx.todayIncomeUsd > 0 || ctx.todayIncomeBs > 0) {
      const parts = [];
      if (ctx.todayIncomeUsd > 0) parts.push(`$${ctx.todayIncomeUsd.toFixed(2)} USD`);
      if (ctx.todayIncomeBs > 0) parts.push(`Bs. ${ctx.todayIncomeBs.toFixed(2)}`);
      lines.push(``, `📈 *Ingresos hoy:* ${parts.join(' + ')} (Equivalente total: *+$${ctx.todayTotalIncomeEquivUsdt.toFixed(2)} USDT*)`);
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
    const lines = [`📦 *Inventario Actual Doomlater:*`, ``];
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

  // 4. Chats con Alertas / Pagos Pendientes / Verificaciones / Atención Requerida
  if (/(?:chat(?:s)?\s*(?:con|en)?\s*alerta|alerta(?:s)?|atenci[oó]n|duda|esperando|pago|pendiente|por verificar|comprobante)/i.test(q)) {
    const alertList = (ctx.alertConvs || []).filter(c => !c.deleted);
    if (alertList.length === 0) {
      return `✅ *¡Bandeja al día!* No hay ningún chat con alertas ni clientes esperando atención en la Web.`;
    }

    const lines = [`⚠️ *Chats con Alertas en la Web (${alertList.length}):*`, ``];
    for (const c of alertList) {
      const isPayment = Boolean(c.pendingPayment);
      const tag = isPayment ? '💳 VERIFICAR PAGO' : '⚠️ ATENCIÓN REQUERIDA';
      const reason = c.attentionReason || (isPayment ? 'Pago reportado por cliente' : 'Consulta fuera de catálogo o caso especial');
      const amtStr = isPayment && c.pendingPaymentAmount ? ` ($${Number(c.pendingPaymentAmount).toFixed(2)})` : '';
      const phone = c.customerPhone ? ` (+${c.customerPhone})` : '';

      lines.push(
        `• *${c.customerName || 'Cliente'}*${phone} [${tag}${amtStr}]:`,
        `  Motivo: ${reason}`,
        `  Último mensaje: "${(c.lastMessage || '').slice(0, 80)}"`,
        ``
      );
    }
    lines.push(`👉 _Entra a la sección "Bot & Inbox" en la Web para responderles o verificar los pagos con 1 clic._`);
    return lines.join('\n');
  }

  // 5. Consultas de Servicios Técnicos y Presupuestos (Desglose de Costos completo o Sin Memoria)
  const servicesMap = ctx.botConfig?.serviceInsumosMap || [];
  if (/(servicio|magia|chipeo|chipear|mantenimiento|reparaci[oó]n|pasta\s*t[eé]rmica)/i.test(q)) {
    const matched = findServiceMatch(q, servicesMap);
    if (matched) {
      const isSolo = /(?:solo|sin memoria|sin la memoria|sin sd|sin microsd|sin tarjeta|ya tengo (?:la )?(?:memoria|sd|microsd)|tengo mi (?:propia )?(?:memoria|sd)|yo pongo la (?:memoria|sd)|solo (?:el )?chip|mano de obra)/i.test(q);
      let targetService = matched;
      if (isSolo && !matched.serviceName.toLowerCase().includes('solo')) {
        const soloVariant = servicesMap.find(s => {
          const sName = (s.serviceName || '').toLowerCase();
          const targetName = (matched.serviceName || '').toLowerCase();
          const model = targetName.includes('oled') ? 'oled' : (targetName.includes('lite') ? 'lite' : 'v1');
          return sName.includes(model) && (sName.includes('solo') || !sName.includes('128gb'));
        });
        if (soloVariant) targetService = soloVariant;
      }

      const labor = Number(targetService.laborPrice !== undefined ? targetService.laborPrice : (targetService.defaultLaborPrice || 0));
      const calcInsumosCost = (Array.isArray(targetService.insumos) && targetService.insumos.length > 0)
        ? targetService.insumos.reduce((sum, it) => sum + (Number(it.unitCost || it.cost || 0) * (Number(it.qty) || 1)), 0)
        : 0;
      const insCost = Number(targetService.insumosCost !== undefined ? targetService.insumosCost : calcInsumosCost);
      const opCost = Number(targetService.operatingCost || targetService.operationalCost || 0);
      const total = Number(targetService.totalCost !== undefined ? targetService.totalCost : (labor + insCost + opCost));

      const insList = (Array.isArray(targetService.insumos) && targetService.insumos.length > 0)
        ? targetService.insumos.map(i => `  • ${i.qty}x ${i.name} ($${Number(i.unitCost || i.cost || 0).toFixed(2)})`).join('\n')
        : '  • (Sin insumos adicionales / Solo mano de obra)';

      return `🔧 *Detalle del Servicio Técnico (Doomlater)*\n\n` +
        `🛠️ *Servicio:* *${targetService.serviceName}*\n` +
        `💵 *COSTO TOTAL:* *$${total.toFixed(2)} USD / USDT*\n\n` +
        `*Desglose de Costos Oficial:*` +
        `\n• 👨‍🔧 *Mano de obra:* $${labor.toFixed(2)} USD` +
        `\n• 📦 *Insumos vinculados:* $${insCost.toFixed(2)} USD\n${insList}` +
        `\n• ⚡ *Costos Operativos:* $${opCost.toFixed(2)} USD` +
        (targetService.customMessage ? `\n\n💬 *Mensaje predeterminado al cliente:*\n"${targetService.customMessage.slice(0, 220)}..."` : '');
    }
  }

  // 6. Búsqueda específica de un producto (ej. "3ds", "cargador", etc.)
  const stopWordsStockSearch = new Set(['chat', 'chats', 'con', 'en', 'alerta', 'alertas', 'hola', 'amigo', 'socio', 'por', 'del', 'los', 'las', 'que', 'queda', 'quedan', 'hay']);
  const words = q.replace(/cuantos|cuántos|quedan|queda|de|hay|en|stock|\?|¿/gi, '').trim().split(/\s+/).filter(w => w.length >= 3 && !stopWordsStockSearch.has(w));
  if (words.length > 0) {
    const matches = ctx.stock.filter(it => {
      const name = String(it.name || '').toLowerCase();
      const cat = String(it.category || '').toLowerCase();
      const extra = String(it.extraDetail || it.notes || '').toLowerCase();
      return words.some(w => name.includes(w) || (w.length >= 4 && cat.includes(w)) || extra.includes(w));
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
  return `👑 *Hola ${partnerName}!* Asistente de Operaciones de Doomlater listo.\n\nPuedes decirme o preguntarme por WhatsApp:\n• _"Agrega una transacción al dashboard"_ (puedes dictarme o escribirme título, monto, moneda, descripción y hora)\n• _"¿Cuánto dinero tenemos acumulado ahorita?"_\n• _"¿Cuánto hay en total con la conversión de Bs a USDT?"_\n• _"Pásame el estado de cuenta en PDF"_\n• _"Genera una factura para [cliente] | [items y precios]"_\n• _"Genera un contrato para [cliente] | [servicio]"_\n• _"Envíale un mensaje de estados de cuenta a mi socio"_\n• _"¿Cuántos cargadores de 3ds quedan?"_\n• _"¿Qué queda en stock?"_\n• _"¿Qué falta o está por agotarse?"_\n• _"¿Hay pagos por verificar?"_\n• _"(número de tlf) pago verificado"_ (para aprobar un pago y quitar la alerta de la Web)\n• _"(número de tlf) delivery (precio)"_ (para cotizarle el delivery a un cliente y sumar su pedido)`;
}

/**
 * Borradores en memoria para recopilación paso a paso de transacciones de socios.
 */
const partnerTxDrafts = new Map();
const partnerDeleteDrafts = new Map();

/**
 * Extractor inteligente de datos de transacción con Gemini 3.5 Flash.
 */
async function extractTransactionWithGemini(userText, partnerName, apiKey, existingDraft = null) {
  if (!userText || !apiKey) return null;
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const timeNowStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });

  const draftContext = existingDraft ? `
Borrador previo en proceso:
- Título actual: ${existingDraft.title || 'Pendiente'}
- Monto actual: ${existingDraft.amount || 'Pendiente'}
- Moneda actual: ${existingDraft.currency || 'Pendiente'}
- Descripción actual: ${existingDraft.description || 'Pendiente'}
- Fecha actual: ${existingDraft.date || 'Pendiente'}
- Hora actual: ${existingDraft.time || 'Pendiente'}
` : '';

  const prompt = `Eres el asistente contable oficial de Doomlater. Tu misión es extraer los datos necesarios para registrar una transacción directamente en el dashboard financiero de la Web.
Socio que envía el mensaje o audio: @${partnerName}.
Fecha de hoy (referencia): ${todayStr}.
Hora actual (referencia): ${timeNowStr}.
${draftContext}

Mensaje o transcripción del socio:
"${userText}"

Analiza si el socio quiere registrar o agregar una transacción (o si está completando los datos de una).
Extrae los campos:
1. "title": Título claro y conciso del concepto (ej: "Venta de Cargador 3DS", "Mantenimiento PS5", "Venta Nintendo Switch", "Compra de Insumos"). Si no se deduce aún, pon null.
2. "amount": Monto numérico mayor a 0 (ej: 15, 45, 120.5). Si no se indica, pon null.
3. "currency": "USD" si son dólares / efectivo, "USDT" si es Binance / cripto, o "VES" si son bolívares / pago móvil. Si no dice moneda, asume "USD".
4. "type": "income" (ingreso, venta o cobro) o "expense" (gasto, compra o pago).
5. "description": Descripción o nota explicativa (cliente, detalles de la venta o trabajo).
6. "date": Fecha en formato YYYY-MM-DD. Si dice "hoy", "la de hoy" o no menciona fecha distinta, pon "${todayStr}".
7. "time": Hora en formato HH:mm (24h). Si el socio menciona la hora a la que se pactó o se empezó a hablar (ej: "a las 2:30", "a las 11 am", "a las 3 de la tarde"), conviértela a 24h. Si no menciona hora, pon "${timeNowStr}".
8. "wallet": "efectivo" | "binance" | "bs" | null.

Devuelve ÚNICAMENTE un JSON válido (sin formato markdown ni \`\`\`):
{
  "isTransactionIntent": true o false,
  "readyToCreate": true o false (debe ser true si se cuenta con al menos un monto válido > 0 y un título entendible),
  "title": string o null,
  "amount": number o null,
  "currency": "USD" | "USDT" | "VES",
  "type": "income" | "expense",
  "description": string o null,
  "date": string,
  "time": string,
  "wallet": string o null,
  "missingFields": ["titulo", "monto", "moneda", "descripcion"]
}

Si el mensaje no tiene ninguna relación con registrar o agregar una transacción, responde:
{"isTransactionIntent": false, "readyToCreate": false}`;

  const models = [...WORKING_GEMINI_MODELS];
  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 400 }
        })
      });
      if (!res.ok) continue;
      const data = await res.json();
      const rawText = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      const cleanJson = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleanJson);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) {
      continue;
    }
  }
  return null;
}

/**
 * Extractor de respaldo por reglas y expresiones regulares.
 */
function fallbackExtractTransaction(userText, partnerName, existingDraft = null) {
  const text = String(userText || '').trim();
  const lower = text.toLowerCase();
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const timeNowStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });

  const isTx = /(transacci[oó]n|agregar|registrar|asentar|vend[ií]|cobr[eé]|ingreso|gasto)/i.test(lower) || Boolean(existingDraft);
  if (!isTx) return { isTransactionIntent: false, readyToCreate: false };

  // Monto
  let amount = existingDraft?.amount || null;
  const amtMatch = text.match(/(?:\$|bs\.?|usd)?\s*(\d+(?:[.,]\d{1,2})?)\s*(?:\$|usd|d[oó]lares|bs\.?|bol[ií]vares)?/i);
  if (amtMatch) amount = parseFloat(amtMatch[1].replace(',', '.'));

  // Moneda
  let currency = existingDraft?.currency || 'USD';
  if (/(bs|bol[ií]vares|pago m[oó]vil|pagomovil)/i.test(lower)) currency = 'VES';
  else if (/(usdt|binance|tether)/i.test(lower)) currency = 'USDT';
  else if (/(\$|usd|d[oó]lar|efectivo)/i.test(lower)) currency = 'USD';

  // Tipo
  const type = /(gasto|compra|pagu[eé]|pagamos)/i.test(lower) ? 'expense' : 'income';

  // Hora
  let time = existingDraft?.time || timeNowStr;
  const timeMatch = text.match(/(?:a\s*las|hora)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeMatch) {
    let h = parseInt(timeMatch[1], 10);
    const m = timeMatch[2] ? timeMatch[2] : '00';
    const ampm = timeMatch[3] ? timeMatch[3].toLowerCase() : null;
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    time = `${String(h).padStart(2, '0')}:${m}`;
  }

  // Título
  let title = existingDraft?.title || null;
  if (!title) {
    const titleMatch = text.match(/(?:t[ií]tulo|concepto)[:\s]+([^,\n\.]+)/i);
    if (titleMatch) {
      title = titleMatch[1].trim();
    } else {
      const clean = text
        .replace(/(?:agrega|registra|asienta|nueva|un|una|transacci[oó]n|al\s*dashboard|por\s*whatsapp|vend[ií]|cobr[eé])/gi, '')
        .replace(/(?:\$|bs\.?|usd)?\s*\d+(?:[.,]\d{1,2})?\s*(?:\$|usd|d[oó]lares|bs\.?|bol[ií]vares)?/gi, '')
        .replace(/(?:hoy|la\s*de\s*hoy|a\s*las\s*\d+.*)/gi, '')
        .trim();
      if (clean.length >= 3) title = clean.charAt(0).toUpperCase() + clean.slice(1);
    }
  }

  // Descripción
  let description = existingDraft?.description || '';
  const descMatch = text.match(/(?:descripci[oó]n|detalle|nota)[:\s]+([^,\n]+)/i);
  if (descMatch) description = descMatch[1].trim();
  else if (!description) description = title || 'Transacción registrada vía WhatsApp';

  const readyToCreate = Boolean(amount && amount > 0 && title && title.length >= 3);
  return {
    isTransactionIntent: true,
    readyToCreate,
    title,
    amount,
    currency,
    type,
    description,
    date: todayStr,
    time,
    wallet: currency === 'VES' ? 'bs' : (currency === 'USDT' ? 'binance' : 'efectivo'),
    missingFields: readyToCreate ? [] : ['titulo', 'monto']
  };
}

/**
 * Crea la transacción directamente en Firebase Realtime Database para que
 * aparezca reflejada al instante (<100ms) en el Dashboard de la Web.
 */
async function executeCreateTransactionInDashboard({
  partnerName,
  title,
  amount,
  currency,
  type = 'income',
  description = '',
  date = null,
  time = null,
  walletNameOrId = null,
  matchedStockItem = null,
  qty = 1
}) {
  const isAnthony = partnerName === 'Anthony';
  const profileUser = isAnthony ? 'doom1' : 'doom2';
  const profileId = isAnthony ? 'profile_1' : 'profile_2';
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const timeNowStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });

  const finalDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayStr;
  const finalTime = (time && /^\d{1,2}:\d{2}$/.test(time)) ? time : timeNowStr;
  const finalAmount = Math.abs(Number(amount)) || 0;
  const finalCur = String(currency || 'USD').toUpperCase();
  const isBs = finalCur === 'VES' || finalCur === 'BS' || finalCur.includes('BOL');

  // Match wallet in Firebase
  const walletsRaw = await fb('GET', ws('wallets'));
  const wallets = walletsRaw ? Object.values(walletsRaw).filter(w => w && !w.deleted) : [];

  let chosenWallet = null;
  if (walletNameOrId) {
    const qW = String(walletNameOrId).toLowerCase();
    chosenWallet = wallets.find(w => w.id === walletNameOrId || w.name.toLowerCase().includes(qW));
  }

  if (!chosenWallet) {
    if (isBs) {
      if (isAnthony) {
        chosenWallet = wallets.find(w => w.name.toLowerCase().includes('anthony') || (w.currency === 'VES' && w.name.toLowerCase().includes('doom1'))) ||
                       wallets.find(w => w.currency === 'VES');
      } else {
        chosenWallet = wallets.find(w => w.name.toLowerCase().includes('sebasti') || w.name.toLowerCase().includes('socio') || (w.currency === 'VES' && w.name.toLowerCase().includes('doom2'))) ||
                       wallets.find(w => w.currency === 'VES');
      }
    } else if (finalCur === 'USDT' || String(walletNameOrId || '').toLowerCase().includes('binance')) {
      chosenWallet = wallets.find(w => w.currency === 'USDT' || w.name.toLowerCase().includes('binance'));
    } else {
      chosenWallet = wallets.find(w => w.name.toLowerCase().includes('efectivo') || w.name.toLowerCase().includes('$') || w.currency === 'USD');
    }
  }

  if (!chosenWallet && wallets.length > 0) chosenWallet = wallets[0];
  const walletId = chosenWallet ? chosenWallet.id : 'w_efectivo';
  const walletName = chosenWallet ? chosenWallet.name : 'Efectivo Caja ($)';
  const curSymbol = isBs ? 'Bs.' : '$';

  // Category mapping
  let categoryId = 'c_ventas';
  const lowerTitle = (title || '').toLowerCase();
  if (type === 'expense') {
    categoryId = lowerTitle.includes('insumo') ? 'c_insumos' : (lowerTitle.includes('envio') || lowerTitle.includes('delivery') ? 'c_envios' : 'c_operativo');
  } else if (lowerTitle.includes('servicio') || lowerTitle.includes('mantenimiento') || lowerTitle.includes('reparac') || lowerTitle.includes('cambio') || lowerTitle.includes('pantalla')) {
    categoryId = 'c_servicio';
  } else {
    categoryId = 'c_ventas';
  }

  const txId = 'tx_wa_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  const txData = {
    id: txId,
    title: title || 'Transacción registrada por WhatsApp',
    amount: finalAmount,
    type: type || 'income',
    categoryId,
    walletId,
    date: finalDate,
    time: finalTime,
    paid: true,
    note: description ? `${description} (Registrado vía WhatsApp por @${profileUser})` : `Registrado vía WhatsApp por @${profileUser}`,
    createdBy: profileUser,
    updatedBy: profileUser,
    profileId,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  const patchUpdates = {
    [`transactions/${txId}`]: txData,
    'meta/updatedAt': Date.now(),
    'meta/rev': Date.now(),
    'meta/lastLabel': `Transacción "${txData.title}" creada por @${profileUser}`,
    'meta/lastClientId': 'bot_bridge',
    'meta/updatedBy': profileUser
  };

  // Si coincide con un artículo del stock, descontar inventario y registrar movimiento de kardex
  if (matchedStockItem && type === 'income') {
    const currentStock = Number(matchedStockItem.stock) || 0;
    const newStock = Math.max(0, currentStock - (qty || 1));
    patchUpdates[`stockItems/${matchedStockItem.id}/stock`] = newStock;
    patchUpdates[`stockItems/${matchedStockItem.id}/updatedAt`] = Date.now();

    const smId = 'sm_wa_' + Date.now().toString(36) + '_' + crypto.randomBytes(2).toString('hex');
    patchUpdates[`stockMovements/${smId}`] = {
      id: smId,
      stockItemId: matchedStockItem.id,
      stockItemName: matchedStockItem.name,
      type: 'out',
      quantity: qty || 1,
      reason: 'sale',
      notes: `Venta registrada por WhatsApp por @${profileUser}`,
      date: finalDate,
      time: finalTime,
      createdBy: profileUser,
      createdAt: Date.now()
    };
  }

  await commitAndVerifyWebSync(patchUpdates, `Transacción "${txData.title}" creada por @${profileUser}`);

  return {
    success: true,
    tx: txData,
    walletName,
    curSymbol,
    finalCur,
    profileUser
  };
}

function wordsMatch(w1, w2) {
  if (!w1 || !w2) return false;
  if (w1 === w2) return true;
  if (w1.length >= 3 && w2.length >= 3) {
    if (w1.startsWith(w2) || w2.startsWith(w1)) return true;
    if (w1.endsWith('s') && w1.slice(0, -1) === w2) return true;
    if (w2.endsWith('s') && w2.slice(0, -1) === w1) return true;
    if (w1.endsWith('es') && w1.slice(0, -2) === w2) return true;
    if (w2.endsWith('es') && w2.slice(0, -2) === w1) return true;
  }
  return false;
}

/**
 * Localiza con máxima precisión un artículo en el inventario/stock según el texto del socio.
 * Tolera singular/plural (cargador/cargadores, memoria/memorias), acentos, modelos (3ds, oled, hwfly, ps5)
 * y frases como "se vendio un cargador del Stock".
 */
function findMatchingStockItem(rawText, stockList) {
  if (!rawText || !Array.isArray(stockList) || stockList.length === 0) return null;
  const clean = String(rawText || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();

  const stopWords = new Set([
    'mira', 'se', 'vendio', 'vendi', 'vendimos', 'vendo', 'venta', 'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas',
    'stock', 'apartado', 'tienda', 'taller', 'conseguimos', 'consegui', 'traje', 'trajimos', 'llegaron', 'llego', 'compre', 'compramos',
    'entran', 'entraron', 'resta', 'quita', 'descuenta', 'por', 'para', 'en', 'al', 'uds', 'unidad', 'unidades', 'piezas', 'dolares', 'bolivares',
    'hoy', 'ayer', 'ahorita', 'favor', 'porfa', 'doom1', 'doom2', 'socio', 'hermano', 'amigo'
  ]);

  const rawWords = clean.split(/\s+/).filter(w => w.length >= 2 && !stopWords.has(w));
  if (rawWords.length === 0) return null;

  let bestItem = null;
  let bestScore = 0;

  for (const it of stockList) {
    if (!it || !it.name || it.deleted) continue;
    const itClean = String(it.name || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ');
    const itWords = itClean.split(/\s+/).filter(w => w.length >= 2);

    let score = 0;

    for (const w of rawWords) {
      for (const iw of itWords) {
        if (wordsMatch(w, iw)) {
          score += 10;
          if (['3ds', 'dsi', 'ds', 'oled', 'switch', 'ps5', 'ps4', 'hwfly', 'rpi', 'adata', 'microsd', 'sd'].includes(w)) {
            score += 5;
          }
        }
      }
    }

    if (itClean.includes(clean)) score += 20;

    if (score > bestScore) {
      bestScore = score;
      bestItem = it;
    }
  }

  return bestScore >= 5 ? bestItem : null;
}

/**
 * Parsea el texto del socio para extraer datos de la Factura Digital (ItsDoomlater)
 */
function parseInvoiceInputText(rawText) {
  const facturaMatch = rawText.match(/^(?:genera(?:r)?\s+)?factura(?:\s+(?:digital|para|a|de))?\s+([^\|]+)(?:\|(.*))?$/i);
  const clientName = (facturaMatch && facturaMatch[1] ? facturaMatch[1] : 'Cliente').trim();
  const rest = (facturaMatch && facturaMatch[2] ? facturaMatch[2] : rawText.replace(/^(?:genera(?:r)?\s+)?factura[^\:]*:/i, '')).trim();

  const items = [];
  if (rest && rest !== clientName) {
    const parts = rest.split(/[,;\n]/).map(p => p.trim()).filter(Boolean);
    for (const part of parts) {
      const colorMatch = part.match(/\b(verde|amarillo|azul|rojo|negro|blanco|gris|morado|naranja)\b/i);
      const tag = colorMatch ? 'COLOR ' + colorMatch[1].toUpperCase() : '';

      const isPendiente = /pendiente/i.test(part);
      const isPagado = /(pagad[oa]|abonad[oa]|listo)/i.test(part);

      const nums = Array.from(part.matchAll(/\$?(\d+(?:[\.,]\d+)?)/g), m => parseFloat(m[1].replace(',', '.'))).filter(n => !isNaN(n));

      let total = nums[0] !== undefined ? nums[0] : 15;
      let abonado = 0;

      if (isPendiente) {
        abonado = 0;
      } else if (isPagado) {
        abonado = total;
      } else if (nums.length >= 2) {
        total = nums[0];
        abonado = nums[1];
      } else {
        abonado = total;
      }

      const cleanTitle = part
        .replace(/\$?(\d+(?:[\.,]\d+)?)/g, '')
        .replace(/\b(verde|amarillo|azul|rojo|negro|blanco|pendiente|pagado|abonado|hoy|usd|\$)\b/gi, '')
        .replace(/[()\-:]/g, '')
        .trim();

      items.push({
        title: cleanTitle.length > 2 ? cleanTitle : 'Reparación de Control / Consola',
        tag,
        desc: isPendiente
          ? 'Servicio de reparación técnica, reemplazo/ajuste de componentes internos, calibración y pruebas de funcionamiento. (Queda pendiente por pagar).'
          : 'Servicio de reparación y mantenimiento técnico integral. (Ya pagado / abonado el día de hoy).',
        status: isPendiente ? 'Pendiente por Pagar' : 'Abonado / Pagado Hoy',
        abonado,
        total
      });
    }
  }

  if (items.length === 0) {
    items.push({
      title: 'Reparación de Control PowerA',
      tag: 'COLOR VERDE',
      desc: 'Servicio de reparación técnica, reemplazo/ajuste de componentes internos, calibración y pruebas de funcionamiento. (Queda pendiente por pagar).',
      status: 'Pendiente por Pagar',
      abonado: 0,
      total: 30
    });
    items.push({
      title: 'Reparación de Control PowerA',
      tag: 'COLOR AMARILLO',
      desc: 'Servicio de reparación y mantenimiento técnico integral. (Ya pagado / abonado el día de hoy).',
      status: 'Abonado / Pagado Hoy',
      abonado: 15,
      total: 15
    });
  }

  return { clientName, items };
}

/**
 * Parsea el texto del socio para extraer datos del Acuerdo / Contrato Oficial
 */
function parseContractInputText(rawText) {
  const contratoMatch = rawText.match(/^(?:genera(?:r)?\s+)?contrato(?:\s+(?:para|a|de))?\s+([^\|]+)(?:\|(.*))?$/i);
  const personPart = (contratoMatch && contratoMatch[1] ? contratoMatch[1] : rawText).trim();
  const titlePart = (contratoMatch && contratoMatch[2] ? contratoMatch[2] : '').trim();

  let personName = personPart;
  let personId = 'V-33.267.135';
  const ciMatch = personPart.match(/(?:(?:c\.?i\.?|v-?|c[eé]dula|identidad)\s*:?\s*)?([ve]-?\d{1,2}(?:\.\d{3}){2}|[ve]-?\d{6,9}|\d{1,2}(?:\.\d{3}){2})/i);
  if (ciMatch) {
    let cleanId = ciMatch[0].trim().replace(/^(?:c\.?i\.?|c[eé]dula)\s*:?\s*/i, '');
    if (!cleanId.toUpperCase().startsWith('V-') && !cleanId.toUpperCase().startsWith('E-')) {
      cleanId = `V-${cleanId}`;
    }
    personId = cleanId;
    personName = personPart.replace(ciMatch[0], '').replace(/(?:c\.?i\.?|c[eé]dula)\s*:?/i, '').trim();
  }

  const title = titlePart.length > 3
    ? titlePart
    : 'ACUERDO DE ASOCIACIÓN DE VENTAS Y CAPACITACIÓN TÉCNICA';

  return { personName, personId, title };
}

async function handlePartnerCommands(userText, adminCtx, partnerName, apiKey = null) {
  const text = String(userText || '').trim();
  const lower = text.toLowerCase();

  // 0. CANCELAR TRANSACCIÓN EN CURSO SI EL SOCIO LO SOLICITA O EJECUTA COMANDO DIRECTO DE STOCK
  const isDirectStockCmd = /(?:vend[ií]|se\s*vendi[oó]|vendimos|sali[oó]|despach|consegu(?:imos|í)|traj(?:e|imos)|lleg(?:aron|ó)|compr(?:é|amos)|resta|quita|descuenta)\b/i.test(lower);
  if (partnerTxDrafts.has(partnerName)) {
    const draft = partnerTxDrafts.get(partnerName);
    if (isDirectStockCmd || (draft && Date.now() - (draft.startedAt || 0) > 3 * 60 * 1000)) {
      partnerTxDrafts.delete(partnerName);
    }
  }

  if (partnerTxDrafts.has(partnerName) && /(cancelar|olv[ií]dalo|no\s*importa|deja\s*eso|ya\s*no)/i.test(lower)) {
    partnerTxDrafts.delete(partnerName);
    return `❌ *Registro de transacción cancelado.* Cuando desees agregar una nueva transacción al dashboard, solo dímelo por aquí.`;
  }

  // 0.00. CONSULTA DIRECTA DE CHATS CON ALERTAS O ATENCIÓN PENDIENTE EN LA WEB
  if (/(?:chat(?:s)?\s*(?:con|en)?\s*alerta|alerta(?:s)?|atenci[oó]n\s*pendiente|clientes?\s*esperando|duda(?:s)?|pagos?\s*por\s*verificar)/i.test(lower)) {
    const alertList = (adminCtx.alertConvs || []).filter(c => !c.deleted);
    if (alertList.length === 0) {
      return `✅ *¡Bandeja al día!* No hay ningún chat con alertas ni clientes esperando atención en la Web.`;
    }

    const lines = [
      `⚠️ *Chats con Alertas en la Web (${alertList.length}):*`,
      ``
    ];

    for (const c of alertList) {
      const isPayment = Boolean(c.pendingPayment);
      const tag = isPayment ? '💳 VERIFICAR PAGO' : '⚠️ ATENCIÓN REQUERIDA';
      const reason = c.attentionReason || (isPayment ? 'Pago reportado por cliente' : 'Consulta fuera de catálogo o caso especial');
      const amtStr = isPayment && c.pendingPaymentAmount ? ` ($${Number(c.pendingPaymentAmount).toFixed(2)})` : '';
      const phone = c.customerPhone ? ` (+${c.customerPhone})` : '';

      lines.push(
        `• *${c.customerName || 'Cliente'}*${phone} [${tag}${amtStr}]:`,
        `  Motivo: ${reason}`,
        `  Último mensaje: "${(c.lastMessage || '').slice(0, 80)}"`,
        ``
      );
    }

    lines.push(`👉 _Entra a la sección "Bot & Inbox" en la Web para responderles o verificar los pagos con 1 clic._`);
    return lines.join('\n');
  }

  // 0.000. VERIFICACIÓN DE PAGO VIA WHATSAPP POR EL SOCIO
  // Sintaxis: "(número) pago verificado", "pago verificado (número)", o simplemente "pago verificado"
  const verifyPaymentMatch = lower.match(/(?:(?:(\+?58\d{10}|0?4\d{9,10})\s+pago\s*verificado)|(?:pago\s*verificado\s+(\+?58\d{10}|0?4\d{9,10}))|^pago\s*verificado$)/i);
  if (verifyPaymentMatch) {
    const rawPhone = verifyPaymentMatch[1] || verifyPaymentMatch[2] || '';
    const cleanDigits = rawPhone.replace(/\D/g, '');
    const convsRaw = await fb('GET', ws('botConversations'));
    const allConvs = convsRaw ? Object.values(convsRaw).filter(c => c && !c.deleted) : [];

    let targetConv = null;
    if (cleanDigits) {
      const last10 = cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;
      targetConv = allConvs.find(c => {
        const cPhone = String(c.customerPhone || '').replace(/\D/g, '');
        const cJid = String(c.customerJid || '').replace(/\D/g, '');
        return cPhone.endsWith(last10) || last10.endsWith(cPhone) || cJid.includes(last10) || String(c.id || '').includes(last10);
      });
    } else {
      const candidates = allConvs.filter(c => c.pendingPayment || c.needsAttention)
        .sort((a, b) => (b.lastMessageAt || b.updatedAt || 0) - (a.lastMessageAt || a.updatedAt || 0));
      targetConv = candidates[0];
    }

    if (!targetConv) {
      return `⚠️ No encontré ninguna conversación pendiente ${cleanDigits ? `con el número *${cleanDigits}*` : 'con pagos por verificar'}.\nRevisa los chats en la Web o escribe el número completo (ej: *04141234567 pago verificado*).`;
    }

    const amt = Number(targetConv.pendingPaymentAmount) || 0;
    const cur = targetConv.pendingPaymentCurrency || 'USD';
    const formattedAmt = cur === 'VES'
      ? `Bs. ${amt.toLocaleString('es-VE', { minimumFractionDigits: 2 })}`
      : (cur === 'USDT' ? `${amt.toFixed(2)} USDT` : `$${amt.toFixed(2)}`);

    const isAnthony = partnerName === 'Anthony';
    const profileUser = isAnthony ? 'doom1' : 'doom2';
    const now = Date.now();

    const patchUpdates = {
      [`botConversations/${targetConv.id}/needsAttention`]: false,
      [`botConversations/${targetConv.id}/pendingPayment`]: false,
      [`botConversations/${targetConv.id}/attentionReason`]: null,
      [`botConversations/${targetConv.id}/paymentVerified`]: true,
      [`botConversations/${targetConv.id}/paymentVerifiedAt`]: now,
      [`botConversations/${targetConv.id}/updatedAt`]: now,
      'meta/updatedAt': now,
      'meta/rev': now,
      'meta/lastLabel': `Pago de ${targetConv.customerName || 'Cliente'} verificado por @${profileUser} vía WhatsApp`,
      'meta/lastClientId': 'bot_bridge',
      'meta/updatedBy': profileUser
    };

    if (amt > 0) {
      const txId = `tx_wa_vpay_${now.toString(36)}`;
      const targetWallet = targetConv.pendingPaymentWalletId || (cur === 'VES' ? 'w_banco' : (cur === 'USDT' ? 'w_binance' : 'w_efectivo'));
      patchUpdates[`transactions/${txId}`] = {
        id: txId,
        title: `Pago verificado: ${targetConv.customerName || 'Cliente'}`,
        amount: amt,
        currency: cur,
        type: 'income',
        walletId: targetWallet,
        category: 'cat_ventas',
        description: `Pago verificado vía WhatsApp por @${partnerName}. Ref: ${targetConv.pendingPaymentRef || 'S/N'}. Cliente: ${targetConv.customerName || 'Cliente'} (${targetConv.customerPhone || 'N/A'})`,
        date: new Date(now).toISOString().slice(0, 10),
        time: new Date(now).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false }),
        createdAt: now,
        createdBy: profileUser
      };
    }

    await commitAndVerifyWebSync(patchUpdates, `Pago de ${targetConv.customerName} verificado`);
    alertedConvsTrack.delete(`pay_${targetConv.id}`);
    alertedConvsTrack.delete(`alert_${targetConv.id}`);

    const clientConfirmMsg = `✅ ¡Tu pago de ${formattedAmt} ha sido verificado con éxito por nuestro equipo! Hemos procesado tu orden con éxito. ¡Muchas gracias por tu compra en Doomlater! ✨`;

    if (targetConv.customerJid && waSock && waState === 'connected') {
      try {
        await waPresence('composing', targetConv.customerJid);
        await new Promise(r => setTimeout(r, 700));
        await waSend(targetConv.customerJid, { text: clientConfirmMsg });
        await waPresence('paused', targetConv.customerJid);
      } catch (e) {
        logger.warn({ err: e.message }, 'No se pudo enviar mensaje de confirmación al cliente por WhatsApp');
      }
    }
    pushHistory(targetConv.id, 'bot', clientConfirmMsg);
    await recordOutgoing(targetConv.id, {
      id: `bmsg_wa_payverif_${Date.now()}`,
      text: clientConfirmMsg,
      sentBy: 'Doomlater Bot',
      createdAt: Date.now()
    });

    return `✅ *¡Listo, ${partnerName}! Pago VERIFICADO con éxito* 🎉\n\n` +
      `• *Cliente:* ${targetConv.customerName || 'Cliente'} (${targetConv.customerPhone || 'N/A'})\n` +
      `• *Monto Acreditado:* *${formattedAmt}*\n` +
      `• *Referencia:* ${targetConv.pendingPaymentRef || 'S/N'}\n\n` +
      `👉 *Acciones ejecutadas:*\n` +
      `  1. Se quitó la etiqueta de alerta en la Web.\n` +
      `  2. Se sumó el ingreso al Dashboard y a la caja.\n` +
      `  3. Se le envió la confirmación oficial al cliente en su chat.`;
  }

  // 0.0001. COTIZACIÓN DE DELIVERY VIA WHATSAPP O TELEGRAM POR EL SOCIO
  // Sintaxis: "(número) delivery (precio)" o "delivery (número) (precio)"
  const deliveryCmdMatch = lower.match(/(?:(?:(\+?58\d{10}|0?4\d{9,10})\s+delivery\s+([\d\.,]+))|(?:delivery\s+(\+?58\d{10}|0?4\d{9,10})\s+([\d\.,]+)))/i);
  if (deliveryCmdMatch) {
    const rawPhone = deliveryCmdMatch[1] || deliveryCmdMatch[3] || '';
    const rawPrice = deliveryCmdMatch[2] || deliveryCmdMatch[4] || '0';
    const deliveryFee = Number(String(rawPrice).replace(',', '.')) || 0;
    const cleanDigits = rawPhone.replace(/\D/g, '');

    const convsRaw = await fb('GET', ws('botConversations'));
    const allConvs = convsRaw ? Object.values(convsRaw).filter(c => c && !c.deleted) : [];

    let targetConv = null;
    if (cleanDigits) {
      const last10 = cleanDigits.length >= 10 ? cleanDigits.slice(-10) : cleanDigits;
      targetConv = allConvs.find(c => {
        const cPhone = String(c.customerPhone || '').replace(/\D/g, '');
        const cJid = String(c.customerJid || '').replace(/\D/g, '');
        return cPhone.endsWith(last10) || last10.endsWith(cPhone) || cJid.includes(last10) || String(c.id || '').includes(last10);
      });
    }

    if (!targetConv) {
      return `⚠️ No encontré ninguna conversación con el número *${cleanDigits || 'indicado'}* para enviar la cotización del delivery.\nVerifica el número o el chat en la Web (ej: *04141234567 delivery 5*).`;
    }

    const rates = await getLiveExchangeRates();
    const rateParalelo = rates.paralelo || 1000;
    const rateBcv = rates.bcv || 890;

    await ensureConvHistoryLoaded(targetConv.id);
    const hist = convHistory.get(targetConv.id) || [];
    const histTexts = hist.map(h => h.text);
    const orderItemStr = detectWhatCustomerBought(targetConv, histTexts, (adminCtx && adminCtx.sellables) || [], adminCtx?.botConfig?.serviceInsumosMap || []);

    let baseUsdt = Number(targetConv.expectedOrderUsdt) || 0;
    if (baseUsdt <= 0) {
      const priceMatch = orderItemStr.match(/\$(\d+(?:\.\d+)?)/);
      if (priceMatch) baseUsdt = parseFloat(priceMatch[1]);
    }
    const totalUsdt = (baseUsdt > 0 ? baseUsdt : 0) + deliveryFee;
    const totalBs = +(totalUsdt * rateParalelo).toFixed(2);
    const totalBcv = rateBcv > 0 ? +(totalBs / rateBcv).toFixed(2) : totalUsdt;

    const clientMsg = `¡Hola! Nuestro equipo ha calculado el costo de delivery para tu zona:\n\n` +
      `• *Costo de Delivery:* *$${deliveryFee.toFixed(2)} USD*\n` +
      (baseUsdt > 0 ? `• *Pedido:* ${orderItemStr} ($${baseUsdt.toFixed(2)} USD)\n` : '') +
      `• *Total a Cancelar:* *$${totalUsdt.toFixed(2)} USDT* (Bs. ${totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | $${totalBcv.toFixed(2)} a tasa BCV)\n\n` +
      `¿Nos confirmas por favor el día y la hora exacta que más te convenga para agendar tu entrega? 🙌`;

    if (targetConv.customerJid && waSock && waState === 'connected') {
      try {
        await waPresence('composing', targetConv.customerJid);
        await new Promise(r => setTimeout(r, 800));
        await waSend(targetConv.customerJid, { text: clientMsg });
        await waPresence('paused', targetConv.customerJid);
      } catch (e) {
        logger.warn({ err: e.message }, 'No se pudo enviar mensaje de delivery al cliente');
      }
    }

    pushHistory(targetConv.id, 'bot', clientMsg);
    alertedConvsTrack.delete(`alert_${targetConv.id}`);

    await recordOutgoing(targetConv.id, {
      id: `bmsg_wa_delivery_${Date.now()}`,
      text: clientMsg,
      sentBy: 'Doomlater Bot',
      createdAt: Date.now()
    });

    await fb('PATCH', ws(`botConversations/${targetConv.id}`), {
      deliveryQuotedFee: deliveryFee,
      deliveryQuotedTotalUsdt: totalUsdt,
      expectedOrderUsdt: totalUsdt,
      expectedOrderBs: totalBs,
      deliveryStatus: 'quoted',
      needsAttention: false,
      attentionReason: null,
      updatedAt: Date.now()
    });

    return `🚚 *¡Listo, ${partnerName}! Cotización de Delivery Enviada* ✅\n\n` +
      `• *Cliente:* *${targetConv.customerName || 'Cliente'}* (+${cleanDigits})\n` +
      `• *Tarifa de Delivery:* *$${deliveryFee.toFixed(2)} USD*\n` +
      `• *Total Calculado:* *$${totalUsdt.toFixed(2)} USD* (Bs. ${totalBs.toLocaleString('es-VE', { minimumFractionDigits: 2 })})\n\n` +
      `👉 _Se le envió el mensaje al cliente solicitando confirmación de día y hora. En cuanto confirme te avisaré con la alerta DOOM ALERT ENTREGA._`;
  }

  // 0.0002. FACTURAS DIGITALES EN PDF PARA SOCIOS (DISEÑO OFICIAL ITSDOOMLATER)
  // Sintaxis: "factura [cliente] | [items y precios]" o "genera factura digital para [cliente]..."
  const facturaMatch = text.match(/^(?:genera(?:r)?\s+)?factura(?:\s+(?:digital|para|a|de))?\s+([^\|]+)(?:\|(.*))?$/i);
  if (facturaMatch && (lower.includes('|') || /(?:por|\$|\d+|abono|pendiente|control|consola|reparaci[oó]n)/i.test(text))) {
    const parsed = parseInvoiceInputText(text);
    const rates = await getLiveExchangeRates();
    const invoicePdfBuffer = await generateDoomDigitalInvoicePdf({
      clientName: parsed.clientName,
      items: parsed.items,
      bcvRate: rates.bcv
    });

    const valorTotal = parsed.items.reduce((acc, i) => acc + (i.total || 0), 0);
    const abonoTotal = parsed.items.reduce((acc, i) => acc + (i.abonado || 0), 0);
    const saldoPendiente = Math.max(0, valorTotal - abonoTotal);

    const pdfAttachment = {
      buffer: invoicePdfBuffer,
      fileName: `Factura_Digital_ItsDoomlater_${safeId(parsed.clientName)}_${Date.now()}.pdf`,
      title: `Factura Digital - ${parsed.clientName}`,
      subtotal: valorTotal
    };

    return {
      reply: `📄 *¡Factura Digital Oficial Generada!* ✅\n\n` +
        `• *Cliente:* *${parsed.clientName}*\n` +
        `• *Total Servicios:* *$${valorTotal.toFixed(2)} USD* (~Bs. ${(valorTotal * (rates.bcv || 890)).toLocaleString('es-VE', { minimumFractionDigits: 2 })})\n` +
        `• *Abono Registrado Hoy:* *$${abonoTotal.toFixed(2)} USD*\n` +
        (saldoPendiente > 0 ? `• *Saldo Pendiente:* *$${saldoPendiente.toFixed(2)} USD* (a tasa oficial BCV)\n` : `• *Estado:* Cancelado en su totalidad\n`) +
        `• *Emisor:* ItsDoomlater (Atendido por @${partnerName})\n\n` +
        `_Adjunto el documento en PDF con el diseño oficial de ItsDoomlater._`,
      pdfAttachment
    };
  }

  // 0.0003. CONTRATOS Y ACUERDOS EN PDF PARA SOCIOS (DISEÑO OFICIAL CON CLÁUSULAS Y FIRMAS)
  // Sintaxis: "contrato [cliente/asociado] | [servicio o acuerdo]"
  const contratoMatch = text.match(/^(?:genera(?:r)?\s+)?contrato(?:\s+(?:para|a|de))?\s+([^\|]+)(?:\|(.*))?$/i);
  if (contratoMatch && (lower.includes('|') || /(?:asociaci|capacita|servicio|garant|acuerdo)/i.test(text))) {
    const parsed = parseContractInputText(text);
    const contractPdfBuffer = await generateDoomContractPdfEngine({
      personName: parsed.personName,
      personId: parsed.personId,
      title: parsed.title
    });

    const pdfAttachment = {
      buffer: contractPdfBuffer,
      fileName: `Contrato_Doomlater_${safeId(parsed.personName)}_${Date.now()}.pdf`,
      title: `Contrato - ${parsed.personName}`
    };

    return {
      reply: `📜 *¡Documento Contractual Oficial Generado!* ✅\n\n` +
        `• *Titular:* *${parsed.personName}*\n` +
        `• *Cédula:* *${parsed.personId}*\n` +
        `• *Documento:* ${parsed.title}\n` +
        `• *Emisor:* Doomlater (Por @${partnerName})\n\n` +
        `_Adjunto el documento oficial en PDF con cláusulas, recuadro de exclusión/nota estricta y espacios para firma._`,
      pdfAttachment
    };
  }

  // 0.0. CONFIRMACIÓN O CANCELACIÓN DE ELIMINACIÓN DE TRANSACCIÓN PENDIENTE
  if (partnerDeleteDrafts.has(partnerName)) {
    const pendingDel = partnerDeleteDrafts.get(partnerName);
    // Expirar borrador de eliminación si pasaron más de 10 minutos
    if (Date.now() - (pendingDel.startedAt || 0) > 10 * 60 * 1000) {
      partnerDeleteDrafts.delete(partnerName);
    } else if (/(?:cancelar|olv[ií]dalo|no\s*importa|deja\s*eso|ya\s*no|no\s*la\s*borres|\bno\b)/i.test(lower) && !/(?:elimina|borra|otra|cambia)/i.test(lower)) {
      partnerDeleteDrafts.delete(partnerName);
      return `❌ *Eliminación cancelada.* La transacción *"${pendingDel.tx.title}"* se mantiene intacta en el Dashboard.`;
    } else if (/(?:^|\b)(?:s[ií]|confirm(?:ar|o)?|elimina(?:r)?|borra(?:r)?|dale|procede|hazlo)(?:\b|$)/i.test(lower) && !/(?:otra|distinta|diferente|\$|\b\d+)/i.test(lower)) {
      partnerDeleteDrafts.delete(partnerName);
      const isAnthony = partnerName === 'Anthony';
      const profileUser = isAnthony ? 'doom1' : 'doom2';
      const tx = pendingDel.tx;

      const patchUpdates = {
        [`transactions/${tx.id}/deleted`]: true,
        [`transactions/${tx.id}/deletedAt`]: Date.now(),
        [`transactions/${tx.id}/deletedBy`]: profileUser,
        'meta/updatedAt': Date.now(),
        'meta/rev': Date.now(),
        'meta/lastLabel': `Transacción "${tx.title}" eliminada por @${profileUser}`,
        'meta/lastClientId': 'bot_bridge',
        'meta/updatedBy': profileUser
      };

      // Si la transacción tenía stock vinculado, restaurar el inventario (+1 o cantidad vendida)
      let restoredStockMsg = '';
      if (tx.stockId) {
        const stockItemsRaw = await fb('GET', ws('stockItems'));
        const stockItem = stockItemsRaw ? stockItemsRaw[tx.stockId] : null;
        if (stockItem && !stockItem.deleted) {
          let qtyToRestore = 1;
          const qtyMatch = String(tx.title || '').match(/Venta\s*\((\d+)x\)/i);
          if (qtyMatch && parseInt(qtyMatch[1], 10)) {
            qtyToRestore = parseInt(qtyMatch[1], 10);
          }
          const curStock = Number(stockItem.stock) || 0;
          const restoredStock = curStock + qtyToRestore;
          patchUpdates[`stockItems/${stockItem.id}/stock`] = restoredStock;
          patchUpdates[`stockItems/${stockItem.id}/updatedAt`] = Date.now();
          restoredStockMsg = `\n📦 *Stock restaurado:* Se devolvió ${qtyToRestore} ud(s) a *${stockItem.name}* (Quedan: ${restoredStock} uds).`;
        }
      }

      await commitAndVerifyWebSync(patchUpdates, `Transacción "${tx.title}" eliminada por @${profileUser}`);

      return `🗑️ *¡Transacción Eliminada con Éxito!* ✅\n\n` +
        `💯 *Confirmado y Verificado al 100% en la Web en Tiempo Real*\n` +
        `• *Concepto:* *${tx.title}*\n` +
        `• *Monto:* ${curSymbol} ${Number(tx.amount || 0).toFixed(2)}\n` +
        `• *Eliminada por:* @${profileUser} (${partnerName})${restoredStockMsg}\n\n` +
        `🌐 _El Dashboard de la Web se actualizó al instante en vivo sin recargar la página._`;
    } else if (/(?:elimina|borra|otra|cambia)/i.test(lower)) {
      // Si el socio decide cambiar de transacción a borrar sin cancelar explícitamente
      partnerDeleteDrafts.delete(partnerName);
    } else {
      const curSymbol = (pendingDel.tx.currency === 'VES' || (pendingDel.tx.walletId && String(pendingDel.tx.walletId).includes('bs'))) ? 'Bs.' : '$';
      return `⚠️ *Tienes una eliminación pendiente de confirmación:*\n\n` +
        `• *Transacción:* *${pendingDel.tx.title}* (${curSymbol} ${Number(pendingDel.tx.amount || 0).toFixed(2)})\n\n` +
        `👉 Para confirmar y borrarla de la Web, responde: *"CONFIRMAR"* o *"ELIMINAR"*\n` +
        `👉 Para no borrarla, responde: *"CANCELAR"*`;
    }
  }

  // 0.01. CONSULTA DE PERMISOS / CÓMO ELIMINAR TRANSACCIONES
  const isGeneralDeleteQuestion = /(?:pued(?:es|e|o)|se\s+pued(?:e|en)|c[oó]mo)\b.*?\b(?:elimina(?:r|ndo|do)?|elimino|borra(?:r|ndo|do)?|borro|anula(?:r)?|anulo|quita(?:r)?|quito)\b.*?(?:transacci[oó]n|transacciones)/i.test(lower) &&
                                  !/(?:[uú]ltim|\$|\b\d+(?:[.,]\d+)?\s*(?:\$|usd|usdt|bs)\b|esta|esa|este|ese)/i.test(lower);
  if (isGeneralDeleteQuestion) {
    partnerTxDrafts.delete(partnerName);
    const isAnthony = partnerName === 'Anthony';
    const profileUser = isAnthony ? 'doom1' : 'doom2';
    return `🗑️ *¡Sí, claro! Puedes eliminar transacciones directamente desde WhatsApp.* ✅\n\n` +
      `Tanto tú (@${profileUser}) como tu socio tienen permisos ejecutivos completos para borrar transacciones del Dashboard en tiempo real.\n\n` +
      `👉 *¿Cómo hacerlo?*\n` +
      `• *Última transacción:* Escribe *"Elimina la última transacción"*\n` +
      `• *Por monto:* Escribe *"Borra la transacción de 5$"* o *"Elimina la de $40"*\n` +
      `• *Por concepto:* Escribe *"Elimina la transacción de cargador"*\n\n` +
      `🔒 *Verificación:* Antes de borrarla, el bot te mostrará los datos completos (título, monto, cuenta, fecha y hora) para que verifiques que es la correcta y te pedirá confirmación (*CONFIRMAR* o *CANCELAR*) antes de ejecutarlo en la Web.`;
  }

  // 0.02. SOLICITUD DE ELIMINACIÓN DE TRANSACCIÓN ("eliminar transacción", "borra la última transacción", "elimina la de 5$", etc.)
  const isDeleteTxIntent = /(?:elimina|eliminar|eliminame|elimíname|elimino|borra|borrar|borrame|bórrame|borro|anula|anular|anulo|quita|quitar|quito)\b.*?(?:transacci[oó]n|transacciones|venta|ventas|gasto|gastos|ingreso|ingresos|cobro|cobros|registro|registros|[uú]ltim[ao]|\$|\b\d+(?:[.,]\d+)?\s*(?:\$|usd|usdt|bs)\b)/i.test(lower) ||
                           /(?:elimina(?:r)?|borra(?:r)?|anula(?:r)?)\s+(?:la\s+)?(?:[uú]ltim[ao]\s+)?(?:transacci[oó]n|transacciones|venta|gasto|ingreso|cobro)/i.test(lower);

  if (isDeleteTxIntent) {
    partnerTxDrafts.delete(partnerName);
    const isAnthony = partnerName === 'Anthony';
    const profileUser = isAnthony ? 'doom1' : 'doom2';

    // Obtener transacciones activas de Firebase
    const txsRaw = await fb('GET', ws('transactions'));
    const allTxs = txsRaw ? Object.values(txsRaw).filter(t => t && !t.deleted) : [];

    if (allTxs.length === 0) {
      return `⚠️ No hay transacciones activas registradas en el Dashboard para eliminar.`;
    }

    // Ordenar de más reciente a más antigua
    allTxs.sort((a, b) => {
      const timeA = `${a.date || ''} ${a.time || '00:00'}`;
      const timeB = `${b.date || ''} ${b.time || '00:00'}`;
      return timeB.localeCompare(timeA) || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
    });

    let targetTx = null;

    // 1. Si el socio especificó un monto (ej: "elimina la de 5$", "borra la transacción de 40 USD")
    const amtMatch = text.match(/\b(\d+(?:[.,]\d+)?)\s*(?:\$|usd|usdt|bs\.?)?/i);
    if (amtMatch && amtMatch[1]) {
      const seekAmt = parseFloat(amtMatch[1].replace(',', '.'));
      targetTx = allTxs.find(t => Math.abs(Number(t.amount || 0) - seekAmt) < 0.05);
    }

    // 2. Si no encontró por monto o no se indicó monto, buscar por palabras clave en título
    if (!targetTx) {
      const cleanWords = lower
        .replace(/(?:elimina(?:r)?|borra(?:r)?|anula(?:r)?|quita(?:r)?|la|el|de|del|por|favor|porfa|transacci[oó]n|transacciones|dashboard|\$)/gi, '')
        .trim().split(/\s+/).filter(w => w.length >= 3);

      if (cleanWords.length > 0 && !cleanWords.includes('ultima') && !cleanWords.includes('ultimo')) {
        targetTx = allTxs.find(t => {
          const title = String(t.title || '').toLowerCase();
          return cleanWords.every(w => title.includes(w));
        });
      }
    }

    // 3. Si no se especificó o es "última", seleccionar la más reciente
    if (!targetTx) targetTx = allTxs[0];

    // Cargar billeteras para mostrar el nombre real
    const walletsRaw = await fb('GET', ws('wallets'));
    const wallets = walletsRaw ? Object.values(walletsRaw).filter(w => w && !w.deleted) : [];
    const w = wallets.find(x => x.id === targetTx.walletId);
    const walletName = w ? w.name : 'Caja Principal';
    const curSymbol = (targetTx.currency === 'VES' || (w && w.currency === 'VES')) ? 'Bs.' : '$';

    let stockNotice = '';
    if (targetTx.stockId) {
      let qtyToRestore = 1;
      const qtyMatch = String(targetTx.title || '').match(/Venta\s*\((\d+)x\)/i);
      if (qtyMatch && parseInt(qtyMatch[1], 10)) {
        qtyToRestore = parseInt(qtyMatch[1], 10);
      }
      stockNotice = `\n📦 *Aviso de Stock:* Esta venta está asociada a un producto de inventario. Al confirmarla, se devolverán automáticamente *${qtyToRestore}* ud(s) al stock disponible.`;
    }

    partnerDeleteDrafts.set(partnerName, {
      tx: targetTx,
      startedAt: Date.now()
    });

    return `⚠️ *Confirmación para Eliminar Transacción* 🗑️\n\n` +
      `¿Estás seguro de que deseas eliminar esta transacción del Dashboard?\n\n` +
      `• *Concepto / Título:* *${targetTx.title}*\n` +
      `• *Monto:* ${curSymbol} ${Number(targetTx.amount || 0).toFixed(2)}\n` +
      `• *Tipo:* ${targetTx.type === 'expense' ? 'Gasto 🔴' : 'Ingreso 🟢'}\n` +
      `• *Cuenta / Billetera:* ${walletName}\n` +
      `• *Fecha y Hora:* ${targetTx.date} a las ${targetTx.time || '00:00'}\n` +
      `• *Registrado originalmente por:* @${targetTx.createdBy || 'socio'}\n` +
      `• *Socio que solicita borrar:* @${profileUser} (${partnerName})${stockNotice}\n\n` +
      `⚠️ *Para confirmar la eliminación definitiva en la Web, responde:* 👉 *"CONFIRMAR"* o *"ELIMINAR"*\n` +
      `_(O responde *"CANCELAR"* si no deseas borrarla)_`;
  }

  // 0.A. SIMULACIÓN DE PRUEBA DE VERIFICACIÓN DE PAGO (SOLICITADA POR SOCIO)
  if (/(?:prob(?:ar|emos)?|simul(?:ar|a)?|test(?:ear)?)\s*(?:el)?\s*(?:verificar\s*pago|pago|verificaci[oó]n)/i.test(lower) ||
      /(?:vamos\s*a\s*probar|prueba|hazme\s*una\s*prueba\s*de)\s*(?:el)?\s*(?:verificar\s*pago|pago|verificaci[oó]n)/i.test(lower)) {
    const isAnthony = partnerName === 'Anthony';
    const partnerPhone = isAnthony ? '584142005801' : '584264181643';
    const convId = 'conv_wa_' + partnerPhone;

    // Extraer monto si se indicó (ej. "prueba verificar pago de 30$" o default 40$)
    const amtMatch = text.match(/(?:\$|bs\.?|monto\s*(?:de)?\s*)?\s*(\d+(?:[.,]\d+)?)\s*(?:\$|usd|usdt|bs\.?)?/i);
    let testAmt = 40.0;
    if (amtMatch && amtMatch[1]) {
      const parsed = parseFloat(amtMatch[1].replace(',', '.'));
      if (!isNaN(parsed) && parsed > 0 && parsed < 100000) testAmt = parsed;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const convPatch = {
      needsAttention: true,
      attentionReason: 'Simulación de prueba de verificación de pago solicitada por socio',
      pendingPayment: true,
      pendingPaymentAmount: testAmt,
      pendingPaymentCurrency: 'USD',
      pendingPaymentItem: 'Instalación Magia Switch OLED / Servicio de Taller',
      pendingPaymentDate: todayStr,
      pendingPaymentPhone: partnerPhone,
      pendingPaymentRef: 'TEST-' + Math.floor(100000 + Math.random() * 900000),
      pendingPaymentWalletId: isAnthony ? 'w_bs_anthony' : 'w_bs_socio',
      lastMessage: '🔔 [SIMULACIÓN] Prueba de verificación de pago lista en la Web',
      lastMessageAt: Date.now(),
      unreadCount: 1
    };

    await fb('PATCH', ws(`botConversations/${convId}`), convPatch);

    return `👑 *¡Prueba de Verificación Activada con Éxito!* 🔔\n\n` +
      `• *Chat marcado:* @${isAnthony ? 'doom1' : 'doom2'} (${partnerName})\n` +
      `• *Etiqueta:* ⚠️ *ALERTA* activada\n` +
      `• *Tarjeta:* *Verificar Pago* ($${testAmt.toFixed(2)})\n` +
      `• *Concepto:* Instalación Magia Switch OLED\n\n` +
      `👉 *Ahora entra a la sección "Bot & Inbox" en la Web:* Verás tu chat con la etiqueta *⚠️ Alerta* y abajo la tarjeta dorada con el botón *[Verificar Pago]*. Al darle clic podrás probar la selección de insumos múltiples, la cuenta destino y la suma a caja en tiempo real.`;
  }

  // 0.B. VENTA DIRECTA DE STOCK (SIMULACIÓN DEL BOTÓN "Confirmar Venta y Sumar a Finanzas")
  const isSaleIntent = /(?:se\s*vendi[oó]|vend[ií]|vendimos|sali[oó]\s*(?:del?\s*stock)?|despach(?:amos|aron|[eé])|confirmar\s*venta|venta\s+de)\b/i.test(lower);
  const matchedStockSale = isSaleIntent ? findMatchingStockItem(text, adminCtx.stock) : null;

  if (matchedStockSale) {
    partnerTxDrafts.delete(partnerName);
    const isAnthony = partnerName === 'Anthony';
    const profileUser = isAnthony ? 'doom1' : 'doom2';
    const profileId = isAnthony ? 'profile_1' : 'profile_2';

    // 1. Cantidad a vender (por defecto 1 ud si dice "un cargador", "cargador", o número específico)
    let qty = 1;
    const qtyMatch = text.match(/\b(\d+)\s*(?:uds?|unidades?|piezas?)?\b/i);
    if (qtyMatch) {
      const q = parseInt(qtyMatch[1], 10);
      if (!isNaN(q) && q > 0 && q <= 1000) qty = q;
    }

    // 2. Precio de venta unitario ($)
    let unitPriceUSD = Number(matchedStockSale.salePrice) || 0;
    if (unitPriceUSD <= 0) unitPriceUSD = 5.0; // Respaldo seguro
    const priceMatch = text.match(/(?:en|por|a|precio(?:\s*de)?)\s*(?:\$|bs\.?|usd)?\s*(\d+(?:[.,]\d+)?)\s*(?:\$|usd|usdt|bs\.?|bol[ií]vares)?/i);
    if (priceMatch && priceMatch[1]) {
      const p = parseFloat(priceMatch[1].replace(',', '.'));
      if (!isNaN(p) && p > 0 && p < 100000) unitPriceUSD = p;
    }

    // 3. Moneda y Cuenta destino
    const isBs = /(?:bs|bol[ií]vares|pago\s*m[oó]vil|pagomovil)/i.test(lower);
    const isUsdt = /(?:usdt|binance|cripto)/i.test(lower);
    const isEfectivo = /(?:efectivo|cash|f[ií]sico)/i.test(lower);

    const walletsRaw = await fb('GET', ws('wallets'));
    const wallets = walletsRaw ? Object.values(walletsRaw).filter(w => w && !w.deleted) : [];

    let chosenWallet = null;
    if (isBs) {
      if (isAnthony) {
        chosenWallet = wallets.find(w => w.name.toLowerCase().includes('anthony') || (w.currency === 'VES' && w.name.toLowerCase().includes('doom1'))) ||
                       wallets.find(w => w.currency === 'VES');
      } else {
        chosenWallet = wallets.find(w => w.name.toLowerCase().includes('sebasti') || w.name.toLowerCase().includes('socio') || (w.currency === 'VES' && w.name.toLowerCase().includes('doom2'))) ||
                       wallets.find(w => w.currency === 'VES');
      }
    } else if (isUsdt) {
      chosenWallet = wallets.find(w => w.currency === 'USDT' || w.name.toLowerCase().includes('binance'));
    } else if (isEfectivo) {
      chosenWallet = wallets.find(w => w.name.toLowerCase().includes('efectivo') || w.name.toLowerCase().includes('$') || w.currency === 'USD');
    }

    if (!chosenWallet) {
      chosenWallet = wallets.find(w => w.currency === 'USDT' || w.name.toLowerCase().includes('binance')) ||
                     wallets.find(w => w.currency === 'USD') ||
                     wallets[0];
    }

    const curStock = Number(matchedStockSale.stock) || 0;
    const newStock = Math.max(0, curStock - qty);
    const unitCostUSD = (Number(matchedStockSale.purchaseCost) || 0) + (Number(matchedStockSale.extraCost) || 0);
    const totalSaleUSD = qty * unitPriceUSD;
    const totalCostUSD = qty * unitCostUSD;
    const netProfitUSD = totalSaleUSD - totalCostUSD;

    const rate = adminCtx.exchangeRate || 998;
    const txAmount = isBs ? Math.round(totalSaleUSD * rate * 100) / 100 : totalSaleUSD;
    const costBasis = isBs ? Math.round(totalCostUSD * rate * 100) / 100 : totalCostUSD;
    const curSymbol = isBs ? 'Bs.' : '$';
    const curCode = isBs ? 'VES' : (chosenWallet ? chosenWallet.currency : 'USDT');
    const walletName = chosenWallet ? chosenWallet.name : (isBs ? 'Cuenta Bs' : 'Binance (USDT)');
    const walletId = chosenWallet ? chosenWallet.id : (isBs ? (isAnthony ? 'wal_mvyqjfw2_qtw8' : 'w_banco') : 'w_binance');

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });

    const smId = 'sm_wa_' + Date.now().toString(36) + '_' + crypto.randomBytes(2).toString('hex');
    const txId = 'tx_wa_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');

    const patchUpdates = {
      [`stockItems/${matchedStockSale.id}/stock`]: newStock,
      [`stockItems/${matchedStockSale.id}/updatedAt`]: Date.now(),
      [`stockItems/${matchedStockSale.id}/updatedBy`]: profileUser,
      [`stockMovements/${smId}`]: {
        id: smId,
        stockId: matchedStockSale.id,
        stockItemId: matchedStockSale.id,
        itemName: matchedStockSale.name,
        stockItemName: matchedStockSale.name,
        action: 'venta',
        type: 'out',
        reason: 'sale',
        quantity: qty,
        qtyChange: -qty,
        newStock,
        unitPrice: unitPriceUSD,
        profit: netProfitUSD,
        note: `Venta de ${qty} ud(s) vía WhatsApp por @${profileUser}`,
        date: dateStr,
        time: timeStr,
        createdBy: profileUser,
        createdAt: Date.now()
      },
      [`transactions/${txId}`]: {
        id: txId,
        title: `Venta (${qty}x) ${matchedStockSale.name}`,
        amount: txAmount,
        type: 'income',
        categoryId: 'c_ventas',
        walletId,
        date: dateStr,
        time: timeStr,
        paid: true,
        stockId: matchedStockSale.id,
        costBasis,
        note: `Venta de ${qty} ud(s) • Costo: $${totalCostUSD.toFixed(2)} USD • Ganancia neta: +$${netProfitUSD.toFixed(2)} USD (Confirmada vía WhatsApp por @${profileUser})`,
        createdBy: profileUser,
        updatedBy: profileUser,
        profileId,
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      'meta/updatedAt': Date.now(),
      'meta/rev': Date.now(),
      'meta/lastLabel': `Venta ${qty}x ${matchedStockSale.name} confirmada por @${profileUser}`,
      'meta/lastClientId': 'bot_bridge',
      'meta/updatedBy': profileUser
    };

    await commitAndVerifyWebSync(patchUpdates, `Venta ${qty}x ${matchedStockSale.name} confirmada por @${profileUser}`);

    return `🛍️ *¡Venta de Stock Confirmada y Sumada a Finanzas!* 🟢\n\n` +
      `💯 *Confirmado y Verificado al 100% en la Web en Tiempo Real*\n` +
      `👤 *Registrado por:* @${profileUser} (${partnerName})\n` +
      `📦 *Producto:* *${matchedStockSale.name}*\n` +
      `🔢 *Cantidad:* ${qty} ud(s)\n` +
      `💰 *Total Cobrado:* *${curSymbol} ${txAmount.toFixed(2)} ${curCode}*\n` +
      `🏷️ *Costo Insumo (Reinversión):* $${totalCostUSD.toFixed(2)} USD\n` +
      `📈 *Ganancia Neta:* *+$${netProfitUSD.toFixed(2)} ${curCode}*\n` +
      `🏦 *Cuenta acreditada:* *${walletName}*\n` +
      `📊 *Stock restante:* *${newStock}* unidad(es) disponible(s)\n` +
      `📅 *Fecha y Hora:* ${dateStr} a las ${timeStr}\n\n` +
      `✨ _Simulación idéntica al botón [Confirmar Venta y Sumar a Finanzas]. Se sumaron +${curSymbol}${txAmount.toFixed(2)} ${curCode} a tu cuenta y se descontó de stock en vivo sin recargar._`;
  }

  // 0.C. REPOSICIÓN / AUMENTO DE STOCK ("conseguimos", "traje", "llegaron", "compré", "entran", "agrega al stock", "suma al stock")
  const isRestockIntent = /(?:consegu(?:imos|í|e)|traj(?:e|imos)|lleg(?:aron|ó)|compr(?:é|amos)|entr(?:aron|ó)|agreg(?:ar?|a)|sum(?:ar?|a)|reposici[oó]n|aument(?:ar?|a))\b/i.test(lower);
  const matchedStockRestock = isRestockIntent ? findMatchingStockItem(text, adminCtx.stock) : null;

  if (matchedStockRestock) {
    partnerTxDrafts.delete(partnerName);
    const isAnthony = partnerName === 'Anthony';
    const profileUser = isAnthony ? 'doom1' : 'doom2';

    let qty = 1;
    const numMatch = text.match(/\b(\d+)\b/);
    if (numMatch) {
      const q = parseInt(numMatch[1], 10);
      if (!isNaN(q) && q > 0 && q <= 5000) qty = q;
    }

    const curStock = Number(matchedStockRestock.stock) || 0;
    const newStock = curStock + qty;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });

    const smId = 'sm_wa_' + Date.now().toString(36) + '_' + crypto.randomBytes(2).toString('hex');
    const patchUpdates = {
      [`stockItems/${matchedStockRestock.id}/stock`]: newStock,
      [`stockItems/${matchedStockRestock.id}/updatedAt`]: Date.now(),
      [`stockItems/${matchedStockRestock.id}/updatedBy`]: profileUser,
      [`stockMovements/${smId}`]: {
        id: smId,
        stockId: matchedStockRestock.id,
        stockItemId: matchedStockRestock.id,
        itemName: matchedStockRestock.name,
        stockItemName: matchedStockRestock.name,
        action: 'reposicion',
        type: 'in',
        reason: 'restock',
        quantity: qty,
        qtyChange: qty,
        newStock,
        notes: `Reposición de ${qty} ud(s) registrada por WhatsApp (@${profileUser})`,
        date: dateStr,
        time: timeStr,
        createdBy: profileUser,
        createdAt: Date.now()
      },
      'meta/updatedAt': Date.now(),
      'meta/rev': Date.now(),
      'meta/lastLabel': `Stock "${matchedStockRestock.name}" aumentado (+${qty}) por @${profileUser}`,
      'meta/lastClientId': 'bot_bridge',
      'meta/updatedBy': profileUser
    };

    await commitAndVerifyWebSync(patchUpdates, `Stock "${matchedStockRestock.name}" aumentado (+${qty}) por @${profileUser}`);

    return `📦 *¡Stock Aumentado con Éxito!* ✅\n\n` +
      `💯 *Confirmado y Verificado al 100% en la Web en Tiempo Real*\n` +
      `👤 *Registrado por:* @${profileUser} (${partnerName})\n` +
      `• *Artículo:* *${matchedStockRestock.name}*\n` +
      `• *Cantidad añadida:* *+${qty}* ud(s)\n` +
      `• *Stock anterior:* ${curStock} uds\n` +
      `• *Nuevo stock disponible:* *${newStock}* unidad(es)\n\n` +
      `🌐 _Actualizado en tiempo real en la Web y registrado en el Kardex._`;
  }

  // 0.D. DESCUENTO / AJUSTE DE STOCK ("resta", "quita", "descuenta", "saca del stock")
  const isSubIntent = /(?:resta(?:r)?|quita(?:r)?|descuenta|descontar|disminuye|disminuir|saca(?:r)?)\b/i.test(lower);
  const matchedStockSub = isSubIntent ? findMatchingStockItem(text, adminCtx.stock) : null;

  if (matchedStockSub) {
    partnerTxDrafts.delete(partnerName);
    const isAnthony = partnerName === 'Anthony';
    const profileUser = isAnthony ? 'doom1' : 'doom2';

    let qty = 1;
    const numMatch = text.match(/\b(\d+)\b/);
    if (numMatch) {
      const q = parseInt(numMatch[1], 10);
      if (!isNaN(q) && q > 0 && q <= 5000) qty = q;
    }

    const curStock = Number(matchedStockSub.stock) || 0;
    const newStock = Math.max(0, curStock - qty);
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hour12: false });

    const smId = 'sm_wa_' + Date.now().toString(36) + '_' + crypto.randomBytes(2).toString('hex');
    const patchUpdates = {
      [`stockItems/${matchedStockSub.id}/stock`]: newStock,
      [`stockItems/${matchedStockSub.id}/updatedAt`]: Date.now(),
      [`stockItems/${matchedStockSub.id}/updatedBy`]: profileUser,
      [`stockMovements/${smId}`]: {
        id: smId,
        stockId: matchedStockSub.id,
        stockItemId: matchedStockSub.id,
        itemName: matchedStockSub.name,
        stockItemName: matchedStockSub.name,
        action: 'ajuste',
        type: 'out',
        reason: 'adjustment',
        quantity: qty,
        qtyChange: -qty,
        newStock,
        notes: `Salida / Ajuste de ${qty} ud(s) registrado por WhatsApp (@${profileUser})`,
        date: dateStr,
        time: timeStr,
        createdBy: profileUser,
        createdAt: Date.now()
      },
      'meta/updatedAt': Date.now(),
      'meta/rev': Date.now(),
      'meta/lastLabel': `Stock "${matchedStockSub.name}" descontado (-${qty}) por @${profileUser}`,
      'meta/lastClientId': 'bot_bridge',
      'meta/updatedBy': profileUser
    };

    await commitAndVerifyWebSync(patchUpdates, `Stock "${matchedStockSub.name}" descontado (-${qty}) por @${profileUser}`);

    return `📦 *¡Stock Actualizado en Tiempo Real!* ✅\n\n` +
      `💯 *Confirmado y Verificado al 100% en la Web en Tiempo Real*\n` +
      `👤 *Registrado por:* @${profileUser} (${partnerName})\n` +
      `• *Artículo:* *${matchedStockSub.name}*\n` +
      `• *Movimiento:* -${qty} uds descontadas del stock\n` +
      `• *Stock anterior:* ${curStock} uds\n` +
      `• *Nuevo stock disponible:* *${newStock}* unidades\n\n` +
      `🌐 _Actualizado en tiempo real en la Web y registrado en el Kardex._`;
  }

  // 1. REGISTRAR O AGREGAR TRANSACCIONES AL DASHBOARD EN TIEMPO REAL
  const hasActiveDraft = partnerTxDrafts.has(partnerName);
  const isTxIntent = (hasActiveDraft ||
    /(?:transacci[oó]n|agregar\s+transacci[oó]n|registrar\s+transacci[oó]n|nueva\s+transacci[oó]n|asentar|meter\s+transacci[oó]n|anota(?:r)?\s+transacci[oó]n|vend[ií]|se vendi[oó]|vendimos|cobr[eé]|cobramos|ingreso|gasto)/i.test(lower)) &&
    !/(?:elimina|borra|anula|quita)/i.test(lower);

  if (isTxIntent) {
    const activeDraft = partnerTxDrafts.get(partnerName) || null;
    let extracted = await extractTransactionWithGemini(userText, partnerName, apiKey, activeDraft);
    if (!extracted || typeof extracted !== 'object') {
      extracted = fallbackExtractTransaction(userText, partnerName, activeDraft);
    }

    if (extracted && extracted.isTransactionIntent) {
      const isAnthony = partnerName === 'Anthony';
      const profileUser = isAnthony ? 'doom1' : 'doom2';

      // Combinar con borrador previo si existía
      if (activeDraft) {
        if (!extracted.title && activeDraft.title) extracted.title = activeDraft.title;
        if ((!extracted.amount || extracted.amount <= 0) && activeDraft.amount) extracted.amount = activeDraft.amount;
        if (!extracted.currency && activeDraft.currency) extracted.currency = activeDraft.currency;
        if (!extracted.description && activeDraft.description) extracted.description = activeDraft.description;
        if (!extracted.date && activeDraft.date) extracted.date = activeDraft.date;
        if (!extracted.time && activeDraft.time) extracted.time = activeDraft.time;
        if (!extracted.wallet && activeDraft.wallet) extracted.wallet = activeDraft.wallet;
        if (extracted.amount > 0 && extracted.title) extracted.readyToCreate = true;
      }

      if (extracted.readyToCreate && extracted.amount > 0 && extracted.title) {
        partnerTxDrafts.delete(partnerName);

        // Buscar coincidencia de artículo de stock para rebajar inventario
        let matchedStock = null;
        const queryWords = (extracted.title || '').toLowerCase().split(/\s+/).filter(w => w.length >= 3);
        let bestScore = 0;
        for (const it of adminCtx.stock || []) {
          const itName = String(it.name || '').toLowerCase();
          let score = 0;
          for (const w of queryWords) {
            if (itName.includes(w)) score += 2;
          }
          if (score > bestScore) {
            bestScore = score;
            matchedStock = it;
          }
        }

        const res = await executeCreateTransactionInDashboard({
          partnerName,
          title: extracted.title,
          amount: extracted.amount,
          currency: extracted.currency || 'USD',
          type: extracted.type || 'income',
          description: extracted.description || '',
          date: extracted.date,
          time: extracted.time,
          walletNameOrId: extracted.wallet,
          matchedStockItem: bestScore >= 4 ? matchedStock : null,
          qty: 1
        });

        const stockNote = (bestScore >= 4 && matchedStock)
          ? `\n📦 *Stock actualizado:* Se descontó 1 ud de *${matchedStock.name}* (Quedan: ${Math.max(0, (Number(matchedStock.stock) || 0) - 1)} uds).`
          : '';

        const nowIso = new Date().toISOString().slice(0, 10);
        const isToday = res.tx.date === nowIso;

        return `✅ *¡Transacción Registrada en el Dashboard en Tiempo Real!* 📊\n\n` +
          `👤 *Creada desde perfil:* @${res.profileUser} (${partnerName})\n` +
          `🏷️ *Título:* ${res.tx.title}\n` +
          `💰 *Monto:* ${res.curSymbol} ${res.tx.amount.toFixed(2)} ${res.finalCur}\n` +
          `🏦 *Billetera / Cuenta:* ${res.walletName}\n` +
          `📅 *Fecha:* ${res.tx.date} ${isToday ? '(Hoy)' : ''}\n` +
          `⏰ *Hora:* ${res.tx.time} ${extracted.time ? '(Hora acordada)' : '(Hora actual)'}\n` +
          `📝 *Descripción:* ${extracted.description || res.tx.title}${stockNote}\n\n` +
          `✨ _El dashboard de la Web se actualizó al instante en vivo sin recargar la página._`;
      } else {
        // Guardar borrador y pedir campos faltantes
        partnerTxDrafts.set(partnerName, {
          ...activeDraft,
          ...extracted,
          startedAt: Date.now()
        });

        const hasAmount = extracted.amount && extracted.amount > 0;
        const hasTitle = extracted.title && extracted.title.length > 2;

        return `📋 *Registro de Nueva Transacción en el Dashboard:*\n\n` +
          `¡Listo @${partnerName}! Para registrar la transacción en tiempo real a tu perfil (@${profileUser}), indícame:\n\n` +
          `1️⃣ *Título:* (ej: Venta de Control PS5 o Reparación de Switch)${hasTitle ? ` 👉 *Captado:* ${extracted.title}` : ''}\n` +
          `2️⃣ *Monto:* (ej: $40 o Bs. 4000)${hasAmount ? ` 👉 *Captado:* $${extracted.amount}` : ''}\n` +
          `3️⃣ *Moneda:* (USD, USDT o Bs.)\n` +
          `4️⃣ *Descripción:* (detalle del cliente, trabajo o producto)\n` +
          `5️⃣ *Fecha y Hora:* (¿Es con fecha de hoy y a qué hora se acordó?)\n\n` +
          `🎙️ *Tip de audio:* ¡Puedes enviarme una sola *nota de voz* con todos estos datos juntos y el bot la creará en el dashboard al instante!`;
      }
    }
  }

  // 2. GENERAR Y ENVIAR PDF LOCAL AL SOCIO QUE LO SOLICITA
  if (/(?:generar|env[ií]ame|p[aá]same|m[aá]ndame|crear|descargar|dame)?\s*(?:un)?\s*(?:archivo\s*)?pdf\b/i.test(lower) && !/(?:a\s*(?:mi\s*socio|sebastian|sebastián|anthony|doom1|doom2)|al\s*socio)/i.test(lower)) {
    const type = /(stock|inventario|articulos|insumos)/i.test(lower) ? 'stock' : 'estado_cuenta';
    const pdfAttachment = generateDoomPdf(type, adminCtx, partnerName);
    return {
      reply: `📄 *¡Aquí tienes tu archivo PDF listo!* 🧾\n\nAdjunto el documento oficial de *${pdfAttachment.title}* generado en vivo con los datos actuales de Doomlater.`,
      pdfAttachment
    };
  }

  // 3. ENVIAR MENSAJE, AVISO O REPORTE DIRECTO AL OTRO SOCIO
  const mentionsPartner = /(?:a\s*(?:mi\s*socio|sebastian|sebastián|anthony|doom1|doom2)|al\s*socio)/i.test(lower);
  const isSendAction = /(?:env[ií](?:ale|ar)?|m[aá]nda(?:le|r)?|p[aá]sa(?:le|r)?|escr[ií]be(?:le|r)?|dile|av[ií]sa(?:le|r)?|notifica(?:r|le)?)/i.test(lower);

  if (mentionsPartner && isSendAction) {
    const targetPartnerName = partnerName === 'Anthony' ? 'Sebastián' : 'Anthony';
    const targetPhone = partnerName === 'Anthony' ? '584264181643' : '584142005801';
    const wantsPdf = lower.includes('pdf');

    // Subcaso A: Enviar estado de cuenta / balance / finanzas
    if (/(?:estado(?:s)?\s*de\s*cuenta|balance|saldo|cuanto hay|finanzas|dinero)/i.test(lower)) {
      const walletsSummary = (adminCtx.walletBalances || []).map(w => {
        if (w.isBs) {
          const equiv = adminCtx.exchangeRate > 0 ? (w.balance / adminCtx.exchangeRate).toFixed(2) : '0.00';
          return `• *${w.name}:* Bs. ${w.balance.toFixed(2)} (~$${equiv} USDT)`;
        } else {
          return `• *${w.name}:* $${w.balance.toFixed(2)} ${w.currency}`;
        }
      }).join('\n');

      const partnerMsg = `💼 *ESTADO DE CUENTA - DOOMLATER*\n` +
        `_Enviado en directo por tu socio @${partnerName}_\n\n` +
        `💰 *GRAN TOTAL CONSOLIDADO:* *$${adminCtx.grandTotalUsdt.toFixed(2)} USDT*\n` +
        `💵 *Divisas Directas:* $${adminCtx.totalUsdDirect.toFixed(2)} USDT\n` +
        `🇻🇪 *Bolívares en Bancos:* Bs. ${adminCtx.totalBs.toFixed(2)} (~$${adminCtx.bsConvertedToUsdt.toFixed(2)} USDT)\n` +
        `📈 *Tasa de cambio:* ${adminCtx.exchangeRate} Bs/USD\n\n` +
        `*Desglose por Cuentas:*\n${walletsSummary}\n\n` +
        `📈 *Ingresos hoy:* +$${adminCtx.todayTotalIncomeEquivUsdt.toFixed(2)} USDT equiv.\n\n` +
        `_Enviado automáticamente vía Doom Bot IA._`;

      const pdfAttachment = wantsPdf ? generateDoomPdf('estado_cuenta', adminCtx, partnerName) : null;
      const sendRes = await sendPartnerDirectMessage(partnerName, targetPartnerName, partnerMsg, pdfAttachment);
      if (sendRes && sendRes.notLinkedYet) {
        return `⚠️ *${sendRes.targetName}* todavía no ha tocado *Iniciar (/start)* en *@Doomlater_Alertas_bot* desde su celular.\n\n👉 Pídele que abra https://t.me/Doomlater_Alertas_bot y pulse *Iniciar* una sola vez para que le lleguen tus avisos y PDFs directo a su Telegram.`;
      }

      return `✅ *¡Listo ${partnerName}!* Ya le envié el estado de cuenta ${wantsPdf ? 'y el documento PDF ' : ''}directo por Telegram a tu socio *@${targetPartnerName}*.`;
    }

    // Subcaso B: Enviar inventario / stock
    if (/(?:stock|inventario|catalogo)/i.test(lower)) {
      const stockMsg = `📦 *INVENTARIO GENERAL - DOOMLATER*\n` +
        `_Enviado en directo por tu socio @${partnerName}_\n\n` +
        `• Productos para la venta: *${adminCtx.sellables.length}*\n` +
        `• Insumos de taller: *${adminCtx.insumos.length}*\n` +
        `• Stock crítico / agotados: *${adminCtx.lowStock.length}*\n\n` +
        `_Enviado automáticamente vía Doom Bot IA._`;

      const pdfAttachment = wantsPdf ? generateDoomPdf('stock', adminCtx, partnerName) : null;
      const sendRes = await sendPartnerDirectMessage(partnerName, targetPartnerName, stockMsg, pdfAttachment);
      if (sendRes && sendRes.notLinkedYet) {
        return `⚠️ *${sendRes.targetName}* todavía no ha tocado *Iniciar (/start)* en *@Doomlater_Alertas_bot* desde su celular.\n\n👉 Pídele que abra https://t.me/Doomlater_Alertas_bot y pulse *Iniciar* una sola vez para que le lleguen tus avisos y PDFs directo a su Telegram.`;
      }

      return `✅ *¡Listo ${partnerName}!* Ya le envié el inventario ${wantsPdf ? 'y el archivo PDF ' : ''}directo por Telegram a tu socio *@${targetPartnerName}*.`;
    }

    // Subcaso C: Mensaje directo o recordatorio
    const hasScheduledTime = /(?:a\s*las\s*\d+|en\s*\d+\s*(?:horas?|minutos?)|mañana)/i.test(lower);
    if (!hasScheduledTime) {
      let directText = text
        .replace(/(?:env[ií](?:ale|ar)?|m[aá]nda(?:le|r)?|p[aá]sa(?:le|r)?|escr[ií]be(?:le|r)?|dile|av[ií]sa(?:le|r)?)\s*(?:un)?\s*(?:mensaje|aviso|recordatorio)?\s*(?:a|al)\s*(?:mi\s*socio|sebastian|sebastián|anthony|doom1|doom2)?(?:\s*que|\s*diciendo(?:\s*que)?)?/gi, '')
        .trim();
      if (!directText) directText = 'Atento a los pendientes de Doomlater';

      const partnerMsg = `🔔 *MENSAJE DE TU SOCIO @${partnerName}:*\n\n"${directText}"\n\n_Enviado en directo vía Doom Bot IA._`;
      const sendRes = await sendPartnerDirectMessage(partnerName, targetPartnerName, partnerMsg);
      if (sendRes && sendRes.notLinkedYet) {
        return `⚠️ *${sendRes.targetName}* todavía no ha tocado *Iniciar (/start)* en *@Doomlater_Alertas_bot* desde su celular.\n\n👉 Pídele que abra https://t.me/Doomlater_Alertas_bot y pulse *Iniciar* una sola vez; apenas lo haga, todos tus avisos le llegarán directo a su Telegram.`;
      }

      return `✅ *Mensaje enviado directo por Telegram a tu socio @${targetPartnerName}:*\n\n👉 "${directText}"`;
    }
  }

  // 4. PROGRAMAR RECORDATORIO A SOCIO
  if (/(recu[eé]rdale|recuerda a mi socio|av[ií]sale|dile a mi socio|recordatorio)/i.test(lower)) {
    const targetPartner = partnerName === 'Anthony' ? 'Socio' : 'Anthony';
    const targetPhone = partnerName === 'Anthony' ? '584264181643' : '584142005801';
    const targetJid = `${targetPhone}@s.whatsapp.net`;

    let reminderText = text
      .replace(/(?:recu[eé]rdale|recuerda a mi socio|av[ií]sale|dile a mi socio|a mi socio que|que)/gi, '')
      .replace(/(?:a las \d+(?::\d+)?\s*(?:am|pm)?|en \d+\s*(?:horas?|minutos?)|mañana)/gi, '')
      .trim();
    if (!reminderText) reminderText = 'Revisar pendientes de Doomlater';

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

    return `⏰ *¡Recordatorio programado!* 🔔\n\nA las *${timeLabel}* le enviaré este mensaje directo por Telegram a tu socio @${targetPartner === 'Socio' ? 'Sebastián' : targetPartner}:\n\n` +
      `👉 "${reminderText}"`;
  }

  return null;
}

async function checkPartnerReminders() {
  if (!isOwner) return;
  try {
    const tg = await getTelegramAndAntiBanConfig();
    const canSendTg = Boolean(tg.token && tg.chatIds.length > 0);
    const canSendWa = Boolean(!tg.antiBanStrictMode && waSock && waState === 'connected');
    if (!canSendTg && !canSendWa) return;

    const raw = await fb('GET', ws('partnerReminders'));
    if (!raw || typeof raw !== 'object') return;
    const now = Date.now();
    for (const [key, rem] of Object.entries(raw)) {
      if (!rem || rem.sent || !rem.triggerAt) continue;
      if (now >= Number(rem.triggerAt)) {
        rem.sent = true;
        rem.sentAt = now;
        await fb('PATCH', ws(`partnerReminders/${key}`), { sent: true, sentAt: now });

        const msgText = `🔔 *RECORDATORIO DE TU SOCIO @${rem.from} PARA @${rem.to === 'Socio' ? 'Sebastián' : rem.to}:*\n\n"${rem.text}"\n\n_Enviado automáticamente por el Asistente Doomlater._`;
        if (canSendTg) {
          const resolved = resolveTargetPartnerTelegramChatIds(tg, rem.from || 'Anthony', rem.to || '');
          if (resolved.chatIds.length > 0) {
            for (const cid of resolved.chatIds) await sendTelegramAlert(msgText, undefined, cid);
          } else {
            await sendTelegramAlert(msgText);
          }
        } else if (canSendWa) {
          const destJid = rem.toJid || `${rem.toPhone}@s.whatsapp.net`;
          await waSend(destJid, { text: msgText });
          const confirmSender = `✅ *Recordatorio entregado:* Ya le envié el mensaje a tu socio @${rem.to}:\n"${rem.text}"`;
          notifySinglePartner(rem.from, confirmSender).catch(() => {});
        }
        await touchMeta(`Recordatorio entregado a @${rem.to}`);
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Error al procesar recordatorios de socios');
  }
}

async function queryAdminAI(convId, userMessage, adminCtx, partnerName, mediaAttachment = null) {
  const apiKey = adminCtx?.botConfig?.geminiApiKey || GEMINI_API_KEY_ENV;

  // Primero revisa si es un comando ejecutable directo (transacción al dashboard, recordatorio, pdf local o mensaje a socio)
  try {
    const commandReply = await handlePartnerCommands(userMessage, adminCtx, partnerName, apiKey);
    if (commandReply) {
      if (typeof commandReply === 'object' && commandReply.reply) {
        return { reply: commandReply.reply, pdfAttachment: commandReply.pdfAttachment || null, isPayment: false, needsHuman: false };
      }
      return { reply: commandReply, isPayment: false, needsHuman: false };
    }
  } catch (cmdErr) {
    logger.error({ err: cmdErr.message }, 'Error procesando comando de socio');
  }

  if (!apiKey) {
    return { reply: fallbackAdminRuleBased(userMessage, adminCtx, partnerName), isPayment: false, needsHuman: false };
  }

  // Construir historial multi-turno para mantener contexto completo de la conversación
  const history = (convHistory.get(convId) || []).slice(-10);
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

  // Construir turno de usuario actual, adjuntando imagen si fue enviada (Visión Multimodal)
  const currentTurnParts = [];
  if (mediaAttachment && mediaAttachment.buffer) {
    currentTurnParts.push({
      inlineData: {
        mimeType: mediaAttachment.mimeType || 'image/jpeg',
        data: mediaAttachment.buffer.toString('base64')
      }
    });
  }
  currentTurnParts.push({ text: userMessage || (mediaAttachment ? '¿Qué opinas de esta imagen?' : 'Hola') });

  // Asegurar que el último turno sea del usuario con el mensaje actual
  if (contents.length === 0 || contents[contents.length - 1].role !== 'user') {
    contents.push({ role: 'user', parts: currentTurnParts });
  } else {
    // Si ya había turno de usuario, reemplazar o concatenar
    if (mediaAttachment && mediaAttachment.buffer) {
      contents[contents.length - 1].parts.unshift({
        inlineData: {
          mimeType: mediaAttachment.mimeType || 'image/jpeg',
          data: mediaAttachment.buffer.toString('base64')
        }
      });
    }
    if (userMessage && !contents[contents.length - 1].parts.some(p => p.text && p.text.includes(userMessage))) {
      contents[contents.length - 1].parts.push({ text: userMessage });
    }
  }

  // Gemini exige que el primer turno sea de usuario
  while (contents.length > 0 && contents[0].role !== 'user') {
    contents.shift();
  }

  const models = [
    adminCtx?.botConfig?.geminiModel,
    GEMINI_MODEL_ENV,
    ...WORKING_GEMINI_MODELS
  ].filter(Boolean);

  for (const model of [...new Set(models)]) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(6000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildAdminSystemPrompt(adminCtx, partnerName) }] },
          contents,
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
        })
      });
      if (res.status === 404 || res.status === 429) continue;
      if (!res.ok) continue;
      const data = await res.json();
      let reply = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (!reply) continue;

      let localPdf = null;

      // Interceptar etiquetas de acción ejecutables generadas por la IA
      // 1. Enviar mensaje directo a socio
      const sendMatch = reply.match(/\[ACCION_ENVIAR:\s*([^\|\]]+)\|\s*([^\]]+)\]/i);
      if (sendMatch) {
        const target = sendMatch[1].trim();
        const textToSend = sendMatch[2].trim();
        const partnerMsg = `🔔 *MENSAJE DE TU SOCIO @${partnerName}:*\n\n"${textToSend}"\n\n_Enviado en directo vía Doom Bot IA._`;
        const sendRes = await sendPartnerDirectMessage(partnerName, target, partnerMsg).catch(e => ({ success: false, error: e.message }));
        reply = reply.replace(sendMatch[0], '').trim();
        if (sendRes && sendRes.notLinkedYet) {
          reply = `⚠️ *${sendRes.targetName}* todavía no ha pulsado *Iniciar (/start)* en *@Doomlater_Alertas_bot* desde su celular.\n\n👉 Pídele que entre a https://t.me/Doomlater_Alertas_bot y toque *Iniciar* una sola vez para poder escribirle directo por Telegram.`;
        }
      }

      // 2. Generar y enviar PDF al socio
      const pdfSocioMatch = reply.match(/\[ACCION_PDF_SOCIO:\s*([^\|\]]+)\|\s*([^\|\]]+)(?:\|\s*([^\]]*))?\]/i);
      if (pdfSocioMatch) {
        const target = pdfSocioMatch[1].trim();
        const pdfType = pdfSocioMatch[2].trim();
        const note = (pdfSocioMatch[3] || '').trim();
        const pdfAttachment = generateDoomPdf(pdfType, adminCtx, partnerName);
        const caption = note ? `🔔 *REPORTE DE TU SOCIO @${partnerName}:*\n\n${note}` : `🔔 *REPORTE OFICIAL DOOMLATER*\nEnviado por tu socio @${partnerName}`;
        const sendRes = await sendPartnerDirectMessage(partnerName, target, caption, pdfAttachment).catch(e => ({ success: false, error: e.message }));
        reply = reply.replace(pdfSocioMatch[0], '').trim();
        if (sendRes && sendRes.notLinkedYet) {
          reply = `⚠️ *${sendRes.targetName}* todavía no ha pulsado *Iniciar (/start)* en *@Doomlater_Alertas_bot* desde su celular.\n\n👉 Pídele que entre a https://t.me/Doomlater_Alertas_bot y toque *Iniciar* una sola vez para recibir reportes PDF en su Telegram.`;
        }
      }

      // 3. Generar PDF para el socio que lo solicitó directamente en este chat
      const pdfLocalMatch = reply.match(/\[ACCION_PDF_LOCAL:\s*([^\|\]]+)(?:\|\s*([^\]]*))?\]/i);
      if (pdfLocalMatch) {
        const pdfType = pdfLocalMatch[1].trim();
        localPdf = generateDoomPdf(pdfType, adminCtx, partnerName);
        reply = reply.replace(pdfLocalMatch[0], '').trim();
      }

      // 4. Generar Factura Digital oficial (ItsDoomlater)
      const facturaDigMatch = reply.match(/\[ACCION_PDF_FACTURA_DIGITAL:\s*([^\|\]]+)(?:\|\s*([^\]]*))?\]/i);
      if (facturaDigMatch) {
        const clientName = (facturaDigMatch[1] || 'Cliente').trim();
        const detailsRaw = (facturaDigMatch[2] || '').trim();
        const parsed = parseInvoiceInputText(`factura ${clientName} | ${detailsRaw}`);
        const rates = await getLiveExchangeRates();
        const buf = await generateDoomDigitalInvoicePdf({
          clientName: parsed.clientName,
          items: parsed.items,
          bcvRate: rates.bcv
        });
        localPdf = {
          buffer: buf,
          fileName: `Factura_Digital_ItsDoomlater_${safeId(clientName)}_${Date.now()}.pdf`,
          title: `Factura Digital - ${clientName}`
        };
        reply = reply.replace(facturaDigMatch[0], '').trim();
      }

      // 5. Generar Contrato / Acuerdo oficial (Doomlater)
      const contratoDigMatch = reply.match(/\[ACCION_PDF_CONTRATO:\s*([^\|\]]+)(?:\|\s*([^\|\]]*))?(?:\|\s*([^\]]*))?\]/i);
      if (contratoDigMatch) {
        const personPart = (contratoDigMatch[1] || 'Asociado').trim();
        const idPart = (contratoDigMatch[2] || '').trim();
        const titlePart = (contratoDigMatch[3] || '').trim();
        const parsed = parseContractInputText(`contrato ${personPart} ${idPart} | ${titlePart}`);
        const buf = await generateDoomContractPdfEngine({
          personName: parsed.personName,
          personId: parsed.personId,
          title: parsed.title
        });
        localPdf = {
          buffer: buf,
          fileName: `Contrato_Doomlater_${safeId(parsed.personName)}_${Date.now()}.pdf`,
          title: `Contrato - ${parsed.personName}`
        };
        reply = reply.replace(contratoDigMatch[0], '').trim();
      }

      return { reply, pdfAttachment: localPdf, isPayment: false, needsHuman: false };
    } catch (e) {
      continue;
    }
  }

  return { reply: fallbackAdminRuleBased(userMessage, adminCtx, partnerName), isPayment: false, needsHuman: false };
}

async function loadAiContext() {
  const [botConfig, stockRaw, rates] = await Promise.all([
    fb('GET', ws('meta/botConfig')),
    fb('GET', ws('stockItems')),
    getLiveExchangeRates()
  ]);
  const cfg = botConfig || {};
  const pms = Array.isArray(cfg.paymentMethods) && cfg.paymentMethods.length > 0 ? cfg.paymentMethods : DEFAULT_PAYMENT_METHODS;
  const faqs = Array.isArray(cfg.knowledgeBaseFaq) && cfg.knowledgeBaseFaq.length > 0 ? cfg.knowledgeBaseFaq : DEFAULT_FAQ;
  const srvs = Array.isArray(cfg.serviceInsumosMap) && cfg.serviceInsumosMap.length > 0 ? cfg.serviceInsumosMap : DEFAULT_SERVICE_INSUMOS_MAP;
  return {
    botConfig: { ...cfg, serviceInsumosMap: srvs },
    stockItems: stockRaw ? Object.values(stockRaw).filter(Boolean) : [],
    paymentMethods: pms,
    knowledgeBaseFaq: faqs,
    rates: rates || { paralelo: 1000, bcv: 890 },
    exchangeRate: rates?.paralelo || 1000
  };
}

function buildSystemPrompt({ stockItems, paymentMethods, knowledgeBaseFaq, botConfig = {}, exchangeRate = 1000, rates = {} }) {
  // SOLO exponer productos comerciales para la venta con stock > 0 (NUNCA insumos internos de taller como chips HwFly o memorias de taller)
  const stock = stockItems
    .filter(i => !i.deleted && i.kind === 'para_vender' && Number(i.stock) > 0)
    .map(i => `- ${i.name}: disponible (${i.stock} en stock) | Precio: $${Number(i.salePrice || 0).toFixed(2)} USDT${i.extraDetail || i.notes ? ` | ${i.extraDetail || i.notes}` : ''}`)
    .join('\n');
  const outOfStock = stockItems
    .filter(i => !i.deleted && i.kind === 'para_vender' && Number(i.stock) <= 0)
    .map(i => `- ${i.name} (agotado temporalmente)`)
    .join('\n');
  const faq = knowledgeBaseFaq.map(f => `P: ${f.question}\nR: ${f.answer}`).join('\n\n');
  const pm = paymentMethods.map(p => `• ${p.name}: ${p.details}`).join('\n');

  const services = (botConfig.serviceInsumosMap || [])
    .map(s => {
      const insList = (Array.isArray(s.insumos) && s.insumos.length > 0)
        ? s.insumos.map(i => `${i.qty}x ${i.name}`).join(' + ')
        : (s.defaultInsumoName || 'Solo mano de obra');
      const labor = Number(s.laborPrice !== undefined ? s.laborPrice : (s.defaultLaborPrice || 0)).toFixed(2);
      const total = Number(s.totalCost !== undefined ? s.totalCost : labor).toFixed(2);
      const customMsg = s.customMessage ? ` | Mensaje oficial personalizado para responder: "${s.customMessage}"` : '';
      return `- ${s.serviceName}: Presupuesto $${total} USDT (Mano de obra $${labor} USD, Incluye: ${insList})${customMsg}`;
    })
    .join('\n');

  const customRules = botConfig.customAiRules ? `
=== REGLAS Y FILTROS ESTRICTOS DEFINIDOS POR LOS DUEÑOS EN LA WEB ===
${botConfig.customAiRules}
` : '';

  const rateParalelo = Number(rates?.paralelo || exchangeRate || 1000);
  const rateBcv = Number(rates?.bcv || 890);

  return `Eres el asistente oficial de ventas y atención al cliente de Doomlater.
Nos especializamos en consolas de videojuegos (PlayStation, Nintendo Switch, Xbox), accesorios, videojuegos, servicio técnico y mantenimiento.
Responde siempre en español, con tono amable, cálido, ágil, profesional y resolutivo, enfocado en cerrar la venta o agendar el servicio de principio a fin sin necesitar intervención humana salvo en los casos estrictos indicados abajo.
REGLA CRÍTICA DE CONCLUSIÓN: NUNCA dejes oraciones, frases o explicaciones a la mitad. Toda respuesta debe estar 100% terminada y concluir con punto final o emoji apropiado.
No digas que eres una IA salvo que te lo pregunten directamente.
${customRules}
=== INFORMACIÓN Y PREGUNTAS FRECUENTES ===
${faq}

=== MÉTODOS DE PAGO Y CUENTAS OFICIALES ===
${pm}

=== TASAS DE CAMBIO OFICIALES DEL DÍA ===
• 1 USDT = ${rateParalelo.toFixed(2)} Bs. (Tasa Paralelo / USDT en la Web)
• 1 USD BCV = ${rateBcv.toFixed(2)} Bs. (Tasa Oficial Banco Central de Venezuela)

=== SERVICIOS TÉCNICOS Y PRESUPUESTOS OFICIALES ===
${services || '(Consulta de presupuestos técnicos con el equipo)'}

=== PRODUCTOS PARA LA VENTA EN STOCK ACTUAL ===
${stock || '(Sin productos físicos cargados en inventario comercial)'}
${outOfStock ? `\n=== PRODUCTOS AGOTADOS TEMPORALMENTE (NO VENDER COMO DISPONIBLES) ===\n${outOfStock}` : ''}

Instrucciones de cierre autónomo y comportamiento:
0. REGLA ESTRICTA DE IDENTIDAD (OBLIGATORIA):
   - La empresa se llama única y exclusivamente *Doomlater*.
   - Habla SIEMPRE en nombre de "nuestro equipo", "nuestro equipo técnico" o "el equipo de Doomlater". NUNCA menciones nombres propios (como Anthony o Sebastián) a los clientes.
1. Saludos, cortesía y seguimiento natural:
   - Saluda con calidez y pregunta en qué consola, accesorio o servicio técnico puedes ayudarle.
   - Saludos, agradecimientos ("gracias", "dale", "ok", "perfecto", "entendido") y despedidas NUNCA llevan [FLAG_REQUIERE_HUMANO].
2. PROHIBICIÓN ESTRICTA DE LA PALABRA "ALERTA":
   - ¡BAJO NINGUNA CIRCUNSTANCIA escribas la palabra "Alerta" ni "Doom Alert" en tus mensajes al cliente!
3. FLUJO AUTÓNOMO DE CIERRE DE VENTA (DE PRINCIPIO A FIN):
   - Paso A (Cotización): Al informar el precio de un producto en stock o servicio técnico oficial, invita cordialmente al cliente a concretar preguntándole si desea adquirirlo/agendarlo y qué método de pago prefiere (Pago Móvil, Binance USDT o Efectivo $) o si prefiere entrega gratuita en *La Previsora* / *CC El Líder*.
   - Paso B (Si elige Efectivo $): Indícale amablemente que aceptamos efectivo en divisas en buen estado al momento de la entrega personal gratuita en *La Previsora* o *CC El Líder*, y pregúntale qué punto, día y hora le conviene para agendarlo enseguida (NO uses ninguna etiqueta de alerta todavía mientras solo estés preguntando día/hora).
   - Paso C (Si pide datos de pago / elige Pago Móvil o Binance):
     • REGLA CONDICIONAL ESTRICTA: Si el cliente SOLO preguntó de forma genérica qué métodos de pago aceptamos y AÚN NO ha elegido ni cotizado un producto o servicio concreto, envía ÚNICAMENTE los métodos de pago oficiales SIN [SEPARADOR_MENSAJE] ni monto.
     • Si el cliente SÍ tiene un producto o servicio concreto cotizado o confirmado en la conversación y pide pagar o saber cuánto es en Bolívares / BCV:
       1. En la primera parte escribe los datos oficiales de pago (Pago Móvil y/o Binance según solicitó).
       2. Escribe exactamente la etiqueta [SEPARADOR_MENSAJE] y al final incluye [MONTO_ORDEN_USDT: <numero_total_en_usdt>] (ejemplo: [MONTO_ORDEN_USDT: 5] o [MONTO_ORDEN_USDT: 100]; si lleva varias unidades multiplica cantidad por precio unitario).
       3. Después de [SEPARADOR_MENSAJE], nuestro sistema formateará automáticamente al centavo el desglose exacto en Bs (multiplicado por ${rateParalelo.toFixed(2)}), en $ a tasa BCV (dividido entre ${rateBcv.toFixed(2)}) y en USDT.
4. COORDINACIÓN DE ENTREGA EN PERSONA O DELIVERY:
   - Puntos de encuentro gratuitos: *La Previsora* (Sabana Grande) y *CC El Líder* (La California). También realizamos envíos nacionales cobro en destino por MRW, Zoom y Tealca.
   - Si el cliente confirma lugar + día/hora en La Previsora o CC El Líder (ej: "En La Previsora mañana a las 2pm"): confirma cordialmente que nuestro equipo queda agendado para ese punto, día y hora, y coloca al final [FLAG_COORDINACION_ENTREGA].
   - Si el cliente solicita delivery a domicilio o en otra zona fuera de La Previsora / CC El Líder: indícale amablemente que con gusto coordinamos el delivery y que nuestro equipo calculará la tarifa exacta para su zona enseguida 🙌, y coloca al final [FLAG_DELIVERY_EXTERNO: <zona indicada>].
5. REPORTE DE PAGO / COMPROBANTE:
   - Si el cliente envía comprobante o avisa que ya realizó el pago, responde:
     "¡Muchas gracias! 📄 Hemos recibido tu comprobante de pago. Nuestro equipo estará revisando la transacción y te confirmamos en breve 🙌"
     y coloca al final [FLAG_PAGO_REPORTADO].
6. OFERTAS DE VENTA DE CONSOLAS O EQUIPOS USADOS POR PARTE DEL CLIENTE:
   - Si el cliente ofrece VENDER su consola, juego o equipo (o darlo como parte de pago):
     Responde cordialmente: "¡Excelente! Con gusto evaluamos tu equipo. Por favor indícanos el modelo exacto, estado físico/funcional y accesorios con los que cuenta; nuestro equipo lo estará verificando para darte una cotización en breve 🙌" y finaliza con [FLAG_VENTA_EQUIPO].
7. TRATO ANTE INSULTOS O AGRESIVIDAD:
   - Si el cliente insulta o escribe con hostilidad, responde SIEMPRE con serenidad absoluta, educación impecable y léxico de alto nivel profesional.
8. SERVICIOS TÉCNICOS OFICIALES (CON Y SIN MEMORIA):
   - Cuando consulten por chipeo/magia (Switch OLED, Lite, V1/V2) o mantenimiento:
     • Si el cliente dice que YA TIENE su propia memoria SD / pide solo instalación sin memoria, usa el servicio "(SOLO)" correspondiente.
     • Si pregunta por mejora a memoria de 256GB, suma el adicional indicado en Preguntas Frecuentes (+$15 USDT).
     • Si el servicio tiene un "Mensaje oficial personalizado para responder", úsalo respetando íntegramente sus precios y condiciones.
     • NUNCA uses [FLAG_REQUIERE_HUMANO] para servicios que están en la lista oficial o en las FAQs.
9. CUÁNDO LLAMAR A UN HUMANO ([FLAG_REQUIERE_HUMANO]):
   - NUNCA uses [FLAG_REQUIERE_HUMANO] para dudas ya cubiertas en Stock, Servicios, FAQs, garantía, horarios, puntos de entrega, envíos nacionales o métodos de pago.
   - ÚNICAMENTE usa [FLAG_REQUIERE_HUMANO] cuando el cliente pregunte por un producto agotado/inexistente en el catálogo o una falla técnica muy específica que NO esté en Servicios ni FAQs, indicando amablemente que consultarás con nuestro equipo técnico para confirmarle enseguida.
10. PRECIOS FIJOS Y CONFIDENCIALIDAD:
   - NUNCA ofrezcas ni aceptes descuentos o rebajas; todos los precios son fijos.
   - NUNCA reveles saldos, ganancias, márgenes ni insumos internos de taller.`;
}

function parseAIResponseFlags(text) {
  let clean = String(text || '');
  const isPayment = clean.includes('[FLAG_PAGO_REPORTADO]');
  const needsHuman = clean.includes('[FLAG_REQUIERE_HUMANO]');
  const isCoordination = clean.includes('[FLAG_COORDINACION_ENTREGA]');
  const isEquipmentSale = clean.includes('[FLAG_VENTA_EQUIPO]');
  const deliveryExternMatch = clean.match(/\[FLAG_DELIVERY_EXTERNO:\s*([^\]]+)\]/i);
  const deliveryExternalZone = deliveryExternMatch ? deliveryExternMatch[1].trim() : null;

  let orderAmountUsdt = null;
  const montoTagMatch = clean.match(/\[MONTO_ORDEN_USDT:\s*\$?([\d.,]+)\]/i);
  if (montoTagMatch) {
    const parsedAmt = parseFloat(String(montoTagMatch[1]).replace(',', '.'));
    if (Number.isFinite(parsedAmt) && parsedAmt > 0) orderAmountUsdt = parsedAmt;
  } else if (clean.includes('[SEPARADOR_MENSAJE]')) {
    const fallbackUsdtMatch = clean.match(/Precio\s+base\s+en\s+USDT:\s*\*?\$?([\d.,]+)\s*USDT/i);
    if (fallbackUsdtMatch) {
      const parsedAmt = parseFloat(String(fallbackUsdtMatch[1]).replace(',', '.'));
      if (Number.isFinite(parsedAmt) && parsedAmt > 0) orderAmountUsdt = parsedAmt;
    }
  }

  clean = clean
    .replace(/\[FLAG_PAGO_REPORTADO\]/g, '')
    .replace(/\[FLAG_REQUIERE_HUMANO\]/g, '')
    .replace(/\[FLAG_COORDINACION_ENTREGA\]/g, '')
    .replace(/\[FLAG_VENTA_EQUIPO\]/g, '')
    .replace(/\[FLAG_DELIVERY_EXTERNO:[^\]]+\]/g, '')
    .replace(/\[MONTO_ORDEN_USDT:[^\]]+\]/gi, '')
    .trim();

  // Limpieza estricta: retirar cualquier residuo de palabra "Alerta", ". Alerta", "Alerta.", etc.
  clean = clean.replace(/(?:[\.\s,]+|\b)(?:Alerta|Doom Alert|ALERTA)[\.\s]*$/i, '.').trim();
  clean = clean.replace(/\.\s*\.$/, '.');
  return { reply: clean, isPayment, needsHuman, isCoordination, isEquipmentSale, deliveryExternalZone, orderAmountUsdt };
}

/**
 * Detecta si el mensaje es únicamente un saludo, agradecimiento, confirmación o despedida de cortesía
 */
function isGreetingOrSmallTalk(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[¡!¿?,.;:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  const tokens = clean.split(/\s+/);
  const politeWords = new Set([
    'hola', 'buenas', 'buenos', 'dias', 'tardes', 'noches', 'saludos', 'que', 'tal', 'como', 'estas', 'estan',
    'hey', 'epa', 'epale', 'buen', 'dia', 'alo', 'ok', 'okay', 'gracias', 'muchas', 'vale', 'dale',
    'perfecto', 'listo', 'entendido', 'amigo', 'amiga', 'amigos', 'equipo', 'doomlater', 'chico', 'chica', 'chicos', 'gente', 'compa'
  ]);
  return tokens.length <= 4 && tokens.every(t => politeWords.has(t));
}

/**
 * Busca coincidencia exacta o inteligente de servicios técnicos configurados en la pestaña "Servicios"
 */
function findServiceMatch(userMsg, services) {
  if (!userMsg || !Array.isArray(services) || services.length === 0) return null;
  const clean = String(userMsg).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const hasMagiaOrChip = /(?:magia|chipeo|chipear|chipean|chip|flasheo|hack|mod)/.test(clean);
  const isSolo = /(?:solo|sin memoria|sin la memoria|sin sd|sin microsd|sin tarjeta|ya tengo (?:la )?(?:memoria|sd|microsd)|tengo mi (?:propia )?(?:memoria|sd)|yo pongo la (?:memoria|sd)|solo (?:el )?chip|mano de obra)/i.test(clean);

  if (hasMagiaOrChip) {
    if (clean.includes('oled')) {
      const match = services.find(s => {
        const name = (s.serviceName || '').toLowerCase();
        return name.includes('oled') && (isSolo ? (name.includes('solo') || !name.includes('128gb')) : (name.includes('128gb') || !name.includes('solo')));
      }) || services.find(s => (s.serviceName || '').toLowerCase().includes('oled'));
      if (match) return match;
    }
    if (clean.includes('lite')) {
      const match = services.find(s => {
        const name = (s.serviceName || '').toLowerCase();
        return name.includes('lite') && (isSolo ? (name.includes('solo') || !name.includes('128gb')) : (name.includes('128gb') || !name.includes('solo')));
      }) || services.find(s => (s.serviceName || '').toLowerCase().includes('lite'));
      if (match) return match;
    }
    if (/(?:v1|v2|normal|clasica|clasico|estandar)/.test(clean)) {
      const match = services.find(s => {
        const name = (s.serviceName || '').toLowerCase();
        return (name.includes('v1') || name.includes('v2')) && (isSolo ? (name.includes('solo') || !name.includes('128gb')) : (name.includes('128gb') || !name.includes('solo')));
      }) || services.find(s => (s.serviceName || '').toLowerCase().includes('v1') || (s.serviceName || '').toLowerCase().includes('v2'));
      if (match) return match;
    }
  }

  // Búsqueda por palabras clave del nombre del servicio
  for (const s of services) {
    const sName = String(s.serviceName || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const cleanSName = sName.replace(/[^a-z0-9]/g, ' ');
    const sWords = cleanSName.split(/\s+/).filter(w => w.length >= 4);
    if (sWords.length > 0 && sWords.filter(w => clean.includes(w)).length >= 2) {
      return s;
    }
  }
  return null;
}

/**
 * Busca coincidencia con preguntas frecuentes (FAQs) con filtrado de stopwords y puntuación precisa
 */
function findFaqMatch(userMsg, faqs) {
  if (!userMsg || !Array.isArray(faqs) || faqs.length === 0) return null;
  const clean = String(userMsg).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[¡!¿?,.;:]/g, ' ').trim();
  const stopWords = new Set([
    'que', 'los', 'las', 'por', 'para', 'con', 'del', 'el', 'la', 'un', 'una', 'en', 'es', 'son', 'al', 'se', 'a',
    'tienen', 'tiene', 'hacen', 'hace', 'venden', 'vende', 'hay', 'dan', 'da', 'cuentan', 'cuenta', 'pueden', 'puede'
  ]);
  const words = clean.split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));
  if (words.length === 0) return null;

  let bestFaq = null;
  let bestScore = 0;

  for (const f of faqs) {
    const qClean = String(f.question || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[¡!¿?,.;:]/g, ' ').trim();
    const qWords = qClean.split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));

    let score = 0;
    for (const w of words) {
      if (qWords.some(qw => qw === w || (qw.length >= 4 && (qw.includes(w) || w.includes(qw))))) {
        score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestFaq = f;
    }
  }

  // Coincidencia sólida (al menos 1 palabra de tema específico o 2 palabras clave)
  if (bestScore >= 1) return bestFaq;
  return null;
}

/**
 * Extrae con alta fidelidad los detalles de coordinación de entrega (Lugar, Fecha/Hora, Modalidad)
 * Filtra preguntas informativas genéricas para no alertar prematuramente.
 */
function parseCoordinationDetails(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Si solo está preguntando dónde entregan o qué puntos hay, NO es coordinación aún
  const isJustAsking = /(?:d[oó]nde|d[oó]nde\s*podemos|c[oó]mo\s*podemos|cu[aá]les\s*son|qu[eé]\s*lugares|en\s*d[oó]nde|qu[eé]\s*sitios)\s*(?:vernos|entregar|entregas|entregan|hacen)/i.test(clean);
  if (isJustAsking && !/(?:a\s*las?\s*\d|\d{1,2}\s*(?:pm|am)|ma[nñ]ana|hoy|el\s*(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo))/i.test(clean)) {
    return null;
  }

  // Detectar lugar
  let lugar = null;
  let modalidad = 'Entrega Gratuita en punto de encuentro';
  if (/previsora/i.test(clean)) {
    lugar = 'La Previsora (Sabana Grande)';
  } else if (/(?:el\s*)?l[ií]der/i.test(clean)) {
    lugar = 'CC El Líder (La California)';
  } else if (/delivery|domicilio|env[ií]o/i.test(clean)) {
    lugar = 'Delivery a domicilio / Dirección cliente';
    modalidad = 'Servicio de Delivery';
  }

  // Buscar combinación directa completa (ej: "el día de mañana a las 2pm", "mañana a las 2:00 PM")
  const comboMatch = text.match(/(?:(?:el\s*d[ií]a\s*)?(?:de\s*)?(?:ma[nñ]ana|hoy|pasado\s*ma[nñ]ana|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo))\s*(?:a\s*las?\s*\d{1,2}(?::\d{2})?\s*(?:pm|am)?|\d{1,2}\s*(?:pm|am)|\d{1,2}:\d{2})/i);

  const dateMatch = text.match(/(?:(?:el\s*d[ií]a\s*)?(?:de\s*)?(?:ma[nñ]ana|hoy|pasado\s*ma[nñ]ana)|(?:el\s*)?(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)(?:\s*\d{1,2})?|\d{1,2}\s*de\s*[a-záéíóú]+)/i);

  const timeMatch = text.match(/(?:a\s*las?\s*)?\d{1,2}(?::\d{2})?\s*(?:pm|am|p\.m\.|a\.m\.)|(?:a\s*las?\s*)\d{1,2}(?::\d{2})?|(?:en\s*la\s*|por\s*la\s*)(?:ma[nñ]ana|tarde|noche)|mediod[ií]a/i);

  let fechaHora = 'Por confirmar con cliente';
  if (comboMatch) {
    fechaHora = comboMatch[0].trim();
  } else if (dateMatch && timeMatch) {
    fechaHora = `${dateMatch[0].trim()} ${timeMatch[0].trim()}`;
  } else if (dateMatch) {
    fechaHora = `${dateMatch[0].trim()} (hora por confirmar)`;
  } else if (timeMatch) {
    fechaHora = timeMatch[0].trim();
  }

  const hasSpecificCoordination = Boolean(lugar || comboMatch || (dateMatch && timeMatch));
  if (!hasSpecificCoordination) return null;

  return {
    lugar: lugar || 'La Previsora / CC El Líder (Punto por definir)',
    modalidad,
    fechaHora: fechaHora.charAt(0).toUpperCase() + fechaHora.slice(1)
  };
}

function isClientOfferingEquipmentForSale(text) {
  if (!text || typeof text !== 'string') return false;
  const clean = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /(?:les?\s*vendo|te\s*vendo|quiero\s*vender(?:les|te)?|estoy\s*vendiendo|(?:tengo|poseo)\s*(?:una?|mi)\s*(?:ps[2345]|play\s*(?:station)?\s*[2345]?|switch|nintendo|xbox|consola|control|wii|3ds|psp|vita)[^?.!]{0,45}(?:en\s*venta|para\s*vender|por\s*si\s*(?:la\s*)?compran)|compran\s*(?:consolas?|ps[2345]|switch|xbox|equipos?|controles?|juegos?\s*usados?)|aceptan\s*(?:consolas?|ps[2345]|switch|xbox|equipos?)?\s*como\s*parte\s*de\s*pago)/i.test(clean);
}

async function queryAI(convId, userMessage, ctx, mediaAttachment = null) {
  // Respuesta inmediata para saludos simples (sin necesidad de llamar a la API ni alertar)
  if (!mediaAttachment && isGreetingOrSmallTalk(userMessage)) {
    const isThanks = /^(?:gracias|muchas gracias|vale|ok|okay|dale|listo|perfecto|entendido|graciass?)/i.test(String(userMessage || '').trim());
    if (isThanks) {
      return {
        reply: '¡A la orden! Con muchísimo gusto 🙌 Si deseas concretar tu pedido o tienes cualquier otra consulta sobre nuestras consolas y servicios técnicos, aquí estamos para ayudarte.',
        isPayment: false,
        needsHuman: false
      };
    }
    return {
      reply: '¡Hola! Bienvenido a Doomlater 🎮. Con gusto te atendemos. ¿En qué producto, consola o servicio técnico podemos ayudarte hoy? 🙌',
      isPayment: false,
      needsHuman: false
    };
  }

  // Hidratar historial desde Firebase si Render se reinició recientemente
  await ensureConvHistoryLoaded(convId);

  // Respuesta inmediata con el mensaje personalizado SOLO si es consulta simple del servicio (sin preguntas compuestas de pago, 256gb, entrega, etc.)
  const hasCompoundFollowup = /(?:256|512|pago|efectivo|binance|bol[ií]vares|\bbs\b|previsora|l[ií]der|delivery|garant[ií]a|env[ií]o|mrw|zoom|tealca|cu[aá]nto\s*tarda|tiempo|quiero\s*hacerlo|agendar)/i.test(String(userMessage || ''));
  const directService = findServiceMatch(userMessage, ctx.botConfig?.serviceInsumosMap || []);
  if (!mediaAttachment && !hasCompoundFollowup && !isClientOfferingEquipmentForSale(userMessage) && directService && directService.customMessage && directService.customMessage.trim() && String(userMessage || '').trim().length < 90) {
    return { reply: directService.customMessage.trim(), isPayment: false, needsHuman: false };
  }

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

  // Construct current turn parts (including image vision if attached)
  const currentTurnParts = [];
  if (mediaAttachment && mediaAttachment.buffer) {
    currentTurnParts.push({
      inlineData: {
        mimeType: mediaAttachment.mimeType || 'image/jpeg',
        data: mediaAttachment.buffer.toString('base64')
      }
    });
  }
  currentTurnParts.push({ text: userMessage || (mediaAttachment ? '¿Qué producto, servicio o presupuesto aplica para esto?' : 'Hola') });

  // Ensure last turn is user with the new message
  if (contents.length === 0 || contents[contents.length - 1].role !== 'user') {
    contents.push({ role: 'user', parts: currentTurnParts });
  } else {
    if (mediaAttachment && mediaAttachment.buffer) {
      contents[contents.length - 1].parts.unshift({
        inlineData: {
          mimeType: mediaAttachment.mimeType || 'image/jpeg',
          data: mediaAttachment.buffer.toString('base64')
        }
      });
    }
    if (userMessage && !contents[contents.length - 1].parts.some(p => p.text && p.text.includes(userMessage))) {
      contents[contents.length - 1].parts.push({ text: userMessage });
    }
  }

  // Ensure first turn is from user (Gemini requirement)
  while (contents.length > 0 && contents[0].role !== 'user') {
    contents.shift();
  }

  const models = [
    ctx.botConfig.geminiModel,
    GEMINI_MODEL_ENV,
    ...WORKING_GEMINI_MODELS
  ].filter(Boolean);
  for (const model of [...new Set(models)]) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(6000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemPrompt(ctx) }] },
          contents,
          generationConfig: { temperature: 0.25, maxOutputTokens: 1024 }
        })
      });
      if (res.status === 404) continue;
      if (!res.ok) {
        logger.error({ model, status: res.status, body: (await res.text()).slice(0, 300) }, 'Gemini falló con este modelo, intentando siguiente');
        continue;
      }
      const data = await res.json();
      const reply = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (reply) {
        const parsed = parseAIResponseFlags(reply);
        if (isClientOfferingEquipmentForSale(userMessage)) {
          parsed.isEquipmentSale = true;
          parsed.needsHuman = true;
        }
        return parsed;
      }
    } catch (err) {
      logger.error({ model, err: err.message }, 'Gemini error');
      continue;
    }
  }
  return fallbackRuleBasedBot(userMessage, ctx);
}

function fallbackRuleBasedBot(userMessage, { stockItems = [], paymentMethods = [], knowledgeBaseFaq = [], botConfig = {} }) {
  const msg = String(userMessage || '').toLowerCase();
  const cleanMsg = msg.replace(/[¡!¿?,.;:]/g, ' ').trim();

  // 1. Saludos y confirmaciones de cortesía (NUNCA requieren humano ni alertan)
  if (isGreetingOrSmallTalk(userMessage)) {
    const isThanks = /^(?:gracias|muchas gracias|vale|ok|okay|dale|listo|perfecto|entendido|graciass?)/i.test(cleanMsg);
    if (isThanks) {
      return {
        reply: '¡A la orden! Con muchísimo gusto 🙌 Si tienes alguna otra duda o consulta de nuestras consolas o servicios técnicos, aquí estamos para ayudarte.',
        isPayment: false,
        needsHuman: false
      };
    }
    return {
      reply: '¡Hola! Bienvenido a Doomlater 🎮. Con gusto te atendemos. ¿En qué producto, consola o servicio técnico podemos ayudarte hoy? 🙌',
      isPayment: false,
      needsHuman: false
    };
  }

  // 2. Información confidencial
  if (/(dinero|saldo|balance|cuánto tienen|cuanto tienen|cuanto dinero|cuánto dinero|ganancia)/i.test(msg)) {
    return {
      reply: 'Esa es información interna y confidencial de la administración de Doomlater. Si tienes dudas sobre nuestras consolas, productos o servicios técnicos con gusto te ayudamos. ✨',
      isPayment: false,
      needsHuman: false
    };
  }

  // 2.5. Cliente ofrece vender su consola o equipo
  if (isClientOfferingEquipmentForSale(userMessage)) {
    return {
      reply: '¡Excelente! Con gusto evaluamos tu equipo. Por favor indícanos el modelo exacto, estado físico/funcional y accesorios con los que cuenta; nuestro equipo lo estará verificando para darte una cotización en breve 🙌',
      isPayment: false,
      needsHuman: true,
      isEquipmentSale: true
    };
  }

  // 3. Comprobantes de pago
  if (/(ya pagu|ya pagué|transfer|comprobante|capture|pago realizado)/.test(msg)) {
    return { reply: '¡Muchas gracias! 📄 Hemos recibido tu comprobante de pago. Nuestro equipo estará revisando la transacción y te confirmamos en breve 🙌', isPayment: true, needsHuman: true };
  }

  // 4. Métodos de pago
  if (/(m[eé]todo|c[oó]mo pag|datos de pago|pago m[oó]vil|binance|zelle|cuenta)/.test(msg)) {
    const pm = paymentMethods.map(p => `• ${p.name}: ${p.details}`).join('\n');
    return { reply: `¡Claro! Nuestros métodos de pago son:\n\n${pm || '• Pago Móvil\n• Binance Pay\n• Efectivo'}\n\nCuando pagues, envíanos el comprobante por aquí 🙌`, isPayment: false, needsHuman: false };
  }

  // 5. Servicios Técnicos (Pestaña "Servicios"): Usar mensaje personalizado si está configurado
  const servicesMap = botConfig.serviceInsumosMap || [];
  const matchedService = findServiceMatch(userMessage, servicesMap);
  if (matchedService) {
    if (matchedService.customMessage && matchedService.customMessage.trim()) {
      return { reply: matchedService.customMessage.trim(), isPayment: false, needsHuman: false };
    }
    const insList = (Array.isArray(matchedService.insumos) && matchedService.insumos.length > 0)
      ? matchedService.insumos.map(i => `${i.qty}x ${i.name}`).join(' + ')
      : (matchedService.defaultInsumoName || 'Insumos de taller');
    const total = matchedService.totalCost !== undefined ? matchedService.totalCost : (matchedService.defaultLaborPrice || 0);
    return {
      reply: `¡Hola! El presupuesto para *${matchedService.serviceName}* es de *$${Number(total || 0).toFixed(2)} USDT* (Incluye: ${insList}). ¿Te gustaría agendar tu entrega en La Previsora o CC El Líder? ✨`,
      isPayment: false,
      needsHuman: false
    };
  }

  // 6. Preguntas Frecuentes (FAQs)
  const matchedFaq = findFaqMatch(userMessage, knowledgeBaseFaq);
  if (matchedFaq) {
    return { reply: matchedFaq.answer, isPayment: false, needsHuman: false };
  }

  // 7. Productos comerciales en stock (estrictamente para_vender)
  const item = stockItems.find(i => !i.deleted && i.kind === 'para_vender' && i.name && msg.includes(String(i.name).toLowerCase()));
  if (item) {
    if (Number(item.stock) > 0) {
      return { reply: `¡Sí! Tenemos *${item.name}* disponible (${item.stock} en stock) a *$${Number(item.salePrice || 0).toFixed(2)} USDT*. ¿Deseas adquirirlo con Pago Móvil, Binance o Efectivo? 🙌`, isPayment: false, needsHuman: false };
    }
    return { reply: `Por el momento *${item.name}* se encuentra agotado temporalmente, pero ya le consulto a nuestro equipo si nos llega nueva mercancía pronto 🙌`, isPayment: false, needsHuman: true };
  }

  // 8. Fallback: SOLO si es una pregunta explícita que no sabemos responder se alerta al equipo
  const isExplicitQuestion = /\?/.test(userMessage) || /^(?:cu[aá]nto|tienen|hacen|venden|hay|precio|costo|d[oó]nde|horario|reparan)/i.test(cleanMsg);
  if (isExplicitQuestion) {
    const fallbackText = botConfig.unknownQuestionFallbackMessage || '¡Hola! Recibimos tu consulta 🙌 Ya le avisé a nuestro equipo para darte la respuesta exacta en unos momentos.';
    return { reply: fallbackText, isPayment: false, needsHuman: true };
  }

  return {
    reply: '¡Hola! Bienvenido a Doomlater 🎮. Con gusto te atendemos. ¿En qué producto, consola o servicio técnico podemos ayudarte hoy? 🙌',
    isPayment: false,
    needsHuman: false
  };
}

/* --------------------------------------------------------------------------
   INTELIGENCIA ARTIFICIAL MULTIMODAL: AUDIO (VOZ A TEXTO) Y VISIÓN (OCR PAGOS)
   -------------------------------------------------------------------------- */
async function transcribeAndProcessAudio(audioBuffer, mimeType, apiKey) {
  if (!audioBuffer || !apiKey) return null;
  const cleanMime = String(mimeType || 'audio/ogg').split(';')[0].trim();
  const base64Audio = audioBuffer.toString('base64');

  const models = [...WORKING_GEMINI_MODELS];

  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(6000),
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: cleanMime,
                  data: base64Audio
                }
              },
              {
                text: 'Transcribe con máxima fidelidad lo que dice esta nota de voz en español. Devuelve ÚNICAMENTE la transcripción textual de lo que dice la persona, sin comillas, sin introducciones ni comentarios adicionales.'
              }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048
          }
        })
      });

      if (!res.ok) continue;
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (text) {
        logger.info({ transcription: text.slice(0, 100) }, 'Nota de voz transcrita con éxito por Gemini');
        return text;
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

/**
 * Identifica si un mensaje contiene ÚNICAMENTE emojis (Unicode) o emoticonos de texto (:), :D, XD, etc.)
 */
function isOnlyEmojisOrEmoticons(str) {
  if (!str || typeof str !== 'string') return false;
  const trimmed = str.trim();
  if (!trimmed) return false;
  const emoticonRegex = /^(?:[:;=8][\-o']?[\)\]\(\[dDpP/:\}{@|\\]|<3|<\/3|[Xx][Dd]|\s)+$/;
  if (emoticonRegex.test(trimmed)) return true;
  try {
    const stripped = trimmed.replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier_Base}|\p{Emoji_Modifier}|\p{Emoji_Component}|\s|[:;=8][\-o']?[\)\]\(\[dDpP/:\}{@|\\]|<3|<\/3|[Xx][Dd]/gu, '');
    return stripped.length === 0;
  } catch (e) {
    return false;
  }
}

async function analyzePaymentCaptureWithGemini(imageBuffer, mimeType, apiKey) {
  if (!imageBuffer || !apiKey) return null;
  const cleanMime = String(mimeType || 'image/jpeg').split(';')[0].trim();
  const base64Image = imageBuffer.toString('base64');

  const models = [...WORKING_GEMINI_MODELS];

  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(6000),
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: cleanMime,
                  data: base64Image
                }
              },
              {
                text: `Analiza esta imagen con precisión quirúrgica para Doomlater (tienda y servicio técnico de consolas de videojuegos).
Determina cuál de estas categorías describe mejor la imagen:
1. Comprobante de pago o capture de transferencia bancaria, Pago Móvil, Binance Pay, USDT, Zelle, efectivo o recibo.
2. Foto de un lugar de encuentro o entrega (ej: estación de metro, CC El Líder, Torre La Previsora, local comercial o captura de mapa/ubicación).
3. Foto de una consola de videojuegos, control, accesorio, componente electrónico o equipo para servicio técnico o venta por parte del cliente (ej: PS4, PS5, Nintendo Switch, Xbox, etc.).
4. Otra imagen no relacionada / no correlacionada con pagos, entregas o consolas.

Responde ÚNICAMENTE con un JSON válido (sin markdown, solo el objeto JSON):
{
  "isPayment": true o false,
  "isLocationOrMeetingPlace": true o false,
  "isConsoleOrEquipment": true o false,
  "isRelevant": true si es pago, lugar de encuentro o consola/equipo; false si es una imagen totalmente no correlacionada o irrelevante,
  "description": "<breve descripción en 1 frase de lo que muestra la imagen>",
  "amount": <monto numérico si es pago, o null>,
  "currency": "VES" si son Bolívares (Pago Móvil / Banco), "USDT" si es Binance / Cripto / USDT, "USD" si son dólares / Zelle / efectivo, "EUR" si son Euros, o null,
  "reference": "<número de referencia o comprobante si es pago, o null>",
  "targetPhone": "<número de teléfono destino al que se envió o null>",
  "targetCedula": "<número de cédula o RIF destino o null>",
  "targetBank": "<código o nombre del banco receptor o null>",
  "targetPhoneOrId": "<número de teléfono, cédula o Pay ID destino general o null>",
  "paymentDate": "<fecha del comprobante en formato YYYY-MM-DD o null>",
  "bank": "<nombre del banco emisor o receptor si figura>",
  "senderName": "<nombre del pagador o emisor si figura o null>"
}`
              }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1024
          }
        })
      });

      if (!res.ok) continue;
      const data = await res.json();
      const rawText = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      const cleanJson = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleanJson);
      if (parsed && typeof parsed === 'object') {
        logger.info({ parsed }, 'Imagen analizada con éxito por Gemini Vision');
        return parsed;
      }
    } catch (e) {
      continue;
    }
  }
  return null;
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
    lastCustomerMessage: msg.text,
    lastCustomerMessageAt: msg.createdAt,
    unreadCount: (Number(existing?.unreadCount) || 0) + 1,
    deleted: false,
    deletedAt: null,
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

async function recordOutgoing(convId, { id, text, sentBy = 'bot', deliveryStatus = 'sent', deliveryError = '', mediaKey = null, createdAt = null }, convPatch = {}) {
  const now = Date.now();
  const msgTime = createdAt || now;
  const existing = await fb('GET', ws(`botConversations/${convId}`));
  const updates = {
    [`botMessages/${id}`]: {
      id, convId, direction: 'out', text, sentBy, createdAt: msgTime, updatedAt: now,
      deliveryStatus, ...(deliveryError ? { deliveryError } : {}), ...(mediaKey ? { mediaKey, mediaType: 'image' } : {})
    },
    'meta/updatedAt': now,
    'meta/rev': now,
    'meta/lastLabel': sentBy === 'WhatsApp (Móvil)' ? '📱 Mensaje desde WhatsApp' : '🤖 Respuesta enviada',
    'meta/lastClientId': 'bot_bridge',
    'meta/updatedBy': 'bot'
  };
  if (existing) {
    updates[`botConversations/${convId}`] = {
      ...existing,
      deleted: false,
      deletedAt: null,
      lastMessage: text,
      lastMessageAt: msgTime,
      lastCustomerMessage: existing.lastCustomerMessage || (existing.lastMessage && existing.updatedBy !== 'bot' ? existing.lastMessage : ''),
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
  const q = replyQueue.get(convId) || { texts: [], hasImage: false, ctx: null };
  clearTimeout(q.timer);
  if (text) q.texts.push(text);
  q.hasImage = q.hasImage || Boolean(ctx.hasImage);
  const prevCtx = q.ctx || {};
  const incomingIsPay = Boolean(ctx.paymentAnalysis && ctx.paymentAnalysis.isPayment);
  const prevIsPay = Boolean(prevCtx.paymentAnalysis && prevCtx.paymentAnalysis.isPayment);

  q.ctx = {
    ...prevCtx,
    ...ctx,
    wasBrandNewConv: Boolean(prevCtx.wasBrandNewConv || ctx.wasBrandNewConv),
    previousExpectedBs: prevCtx.previousExpectedBs || ctx.previousExpectedBs || 0,
    previousExpectedUsdt: prevCtx.previousExpectedUsdt || ctx.previousExpectedUsdt || 0,
    imageBuffer: ctx.imageBuffer || prevCtx.imageBuffer || null,
    imageMime: ctx.imageBuffer ? ctx.imageMime : (prevCtx.imageMime || ctx.imageMime || 'image/jpeg'),
    paymentAnalysis: incomingIsPay
      ? ctx.paymentAnalysis
      : (prevIsPay ? prevCtx.paymentAnalysis : (ctx.paymentAnalysis || prevCtx.paymentAnalysis || null)),
    destWalletId: incomingIsPay ? ctx.destWalletId : (prevIsPay ? prevCtx.destWalletId : (ctx.destWalletId || prevCtx.destWalletId)),
    destWalletName: incomingIsPay ? ctx.destWalletName : (prevIsPay ? prevCtx.destWalletName : (ctx.destWalletName || prevCtx.destWalletName))
  };

  q.timer = setTimeout(() => {
    replyQueue.delete(convId);
    runAiReply(convId, q).catch(err => logger.error({ err: err.message, convId }, 'Error respondiendo con IA'));
  }, q.ctx.delayMs);
  replyQueue.set(convId, q);
}

function validateReceiptTargetAccount(pa) {
  if (!pa) return { matched: false, name: null };
  const targetPhone = String(pa.targetPhone || pa.targetPhoneOrId || '').replace(/\D/g, '');
  const targetCedula = String(pa.targetCedula || pa.targetPhoneOrId || '').replace(/\D/g, '');
  const targetBank = String(pa.targetBank || pa.bank || '').toLowerCase();
  const cur = String(pa.currency || '').toUpperCase();

  if (cur === 'USDT' || String(pa.targetPhoneOrId || '').includes('1193191459')) {
    return { matched: true, name: 'Binance Pay (ID 1193191459)' };
  }
  if (targetPhone.endsWith('4142005801') || targetCedula.includes('32296961')) {
    return { matched: true, name: 'Mercantil Anthony (0414-2005801 / C.I. 32.296.961)' };
  }
  if (targetPhone.endsWith('4264181643') || targetCedula.includes('32030679')) {
    return { matched: true, name: 'Mercantil Sebastián (0426-4181643 / C.I. 32.030.679)' };
  }
  if (targetBank.includes('0105') || targetBank.includes('mercantil')) {
    return { matched: true, name: 'Banco Mercantil (0105)' };
  }
  return { matched: false, name: null };
}

function detectWhatCustomerBought(conv, historyTexts, stockItems = [], services = []) {
  const allText = (historyTexts || []).join(' ').toLowerCase();

  // Priorizar estrictamente productos comerciales para la venta (nunca insumos internos de taller)
  const retailItems = (stockItems || []).filter(it => it && !it.deleted && it.kind === 'para_vender');
  for (const it of retailItems) {
    const nameLow = String(it.name || '').toLowerCase();
    const cleanName = nameLow.replace(/[^a-z0-9]/g, ' ');
    const words = cleanName.split(/\s+/).filter(w => w.length >= 4);
    if (words.some(w => allText.includes(w)) || (nameLow && allText.includes(nameLow))) {
      const price = Number(it.salePrice || 0).toFixed(2);
      const stock = it.stock !== undefined ? it.stock : 'N/A';
      return `${it.name} (Precio: $${price} USD c/u | Stock disponible: ${stock})`;
    }
  }

  if (allText.includes('cargador')) {
    return 'Cargador (Precio: $5.00 USD c/u)';
  }

  // Buscar primero con findServiceMatch para respetar variantes con/sin memoria (SOLO)
  const matchedSrv = findServiceMatch(allText, services || []);
  if (matchedSrv) {
    const srvPrice = Number(matchedSrv.totalCost !== undefined ? matchedSrv.totalCost : (matchedSrv.laborPrice !== undefined ? matchedSrv.laborPrice : (matchedSrv.defaultLaborPrice || 0))).toFixed(2);
    return `Servicio Técnico: ${matchedSrv.serviceName} ($${srvPrice} USD)`;
  }

  for (const s of services || []) {
    if (!s) continue;
    const sName = String(s.serviceName || '').toLowerCase();
    const words = sName.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length >= 4);
    if (words.some(w => allText.includes(w))) {
      const srvPrice = Number(s.totalCost !== undefined ? s.totalCost : (s.laborPrice !== undefined ? s.laborPrice : (s.defaultLaborPrice || 0))).toFixed(2);
      return `Servicio Técnico: ${s.serviceName} ($${srvPrice} USD)`;
    }
  }
  if (/(magia|chipeo|instalaci[oó]n|mantenimiento)/i.test(allText)) {
    return 'Servicio Técnico / Chipeo Magia';
  }

  if (/(env[ií]o\s*(?:de|desde)?\s*usa|casillero|paquete\s*usa)/i.test(allText)) {
    return 'Envío de USA / Casillero';
  }

  return 'Producto o Servicio general (ver chat en Web)';
}

async function runAiReply(convId, q) {
  let conv, aiCtx, adminCtx;
  if (q.ctx.isPartner) {
    // Para socios cargamos directamente el contexto ejecutivo sin llamadas innecesarias al contexto de clientes
    [conv, adminCtx] = await Promise.all([
      fb('GET', ws(`botConversations/${convId}`)),
      loadAdminExecutiveContext()
    ]);
  } else {
    // Revisa interruptores e hidrata historial antes de responder a clientes
    [conv, aiCtx] = await Promise.all([
      fb('GET', ws(`botConversations/${convId}`)),
      loadAiContext(),
      ensureConvHistoryLoaded(convId)
    ]);
    if (!conv || conv.deleted) return;
    if (aiCtx.botConfig.globalBotEnabled === false || conv.botActive === false) {
      if (q.ctx.platform === 'whatsapp') await waPresence('paused', q.ctx.jid);
      return;
    }
  }

  const userText = q.texts.join('\n').trim();
  const mediaAttachment = q.ctx.imageBuffer ? { buffer: q.ctx.imageBuffer, mimeType: q.ctx.imageMime } : null;

  const prevBotTurns = (convHistory.get(convId) || []).filter(h => h.role === 'bot').length;
  const isBrandNewChat = Boolean(q.ctx.wasBrandNewConv) || (prevBotTurns === 0 && (!conv?.createdAt || Date.now() - Number(conv.createdAt) < 45000));
  const onlyPhotosNoText = q.hasImage && (!userText || !/[a-zA-Z0-9]{3,}/.test(userText));
  const isBrandNewPhotoChat = !q.ctx.isPartner && isBrandNewChat && onlyPhotosNoText && !(q.ctx.paymentAnalysis && q.ctx.paymentAnalysis.isPayment);

  let result;
  if (q.ctx.isPartner) {
    result = await queryAdminAI(convId, userText || 'hola', adminCtx, q.ctx.partnerName || 'Socio', mediaAttachment);
  } else if (q.ctx.paymentAnalysis && q.ctx.paymentAnalysis.isPayment) {
    const pa = q.ctx.paymentAnalysis;
    const acctCheck = validateReceiptTargetAccount(pa);
    let replyText = '';
    if (!acctCheck.matched) {
      replyText = `Hemos recibido tu comprobante, pero notamos que los datos destino (cédula/teléfono/banco) no parecen coincidir con las cuentas oficiales de Doomlater. Nuestro equipo estará revisando la transacción para verificarla contigo en breve 🙌`;
    } else {
      replyText = aiCtx?.botConfig?.paymentReceiptReplyMessage || `¡Muchas gracias! 📄 Hemos recibido tu comprobante de pago. Nuestro equipo estará revisando la transacción y te confirmamos en breve 🙌`;
    }

    result = {
      reply: replyText,
      isPayment: true,
      needsHuman: true,
      acctCheck
    };
  } else if (isBrandNewPhotoChat) {
    // Chat totalmente nuevo enviando fotos sin texto tras el debounce de 2.5s
    result = {
      reply: '¡Hola! Te damos una cordial bienvenida a Doomlater 🎮. Hemos recibido tus fotos; en breve uno de nuestros asesores técnicos las estará revisando para atenderte. Si deseas comentarnos alguna duda o lo que necesitas, con gusto puedes escribirnos mientras te atendemos 🙌',
      needsHuman: true,
      isBrandNewPhotoNotice: true
    };
  } else if (!q.ctx.isPartner && q.hasImage && q.ctx.paymentAnalysis && q.ctx.paymentAnalysis.isRelevant === false && !q.ctx.paymentAnalysis.isLocationOrMeetingPlace && !q.ctx.paymentAnalysis.isConsoleOrEquipment && (!userText || userText.length < 5)) {
    // Imagen sin correlación alguna con pagos, lugares ni consolas: No responder y alertar a los socios
    result = {
      reply: '',
      needsHuman: true,
      isUncorrelatedImage: true,
      imageDescription: q.ctx.paymentAnalysis.description || 'Imagen no relacionada con la tienda'
    };
  } else if (q.hasImage && !/[a-z]{4,}/i.test(userText) && (!mediaAttachment || !mediaAttachment.buffer)) {
    result = {
      reply: '¡Muchas gracias! 📄 Hemos recibido tu comprobante de pago. Nuestro equipo estará revisando la transacción y te confirmamos en breve 🙌',
      isPayment: true,
      needsHuman: true
    };
  } else {
    result = await queryAI(convId, userText || '(el cliente envió una imagen o archivo)', aiCtx, mediaAttachment);
    if (q.hasImage && !result.reply) {
      result.isPayment = true;
      result.needsHuman = true;
      if (aiCtx?.botConfig?.paymentReceiptReplyMessage) {
        result.reply = aiCtx.botConfig.paymentReceiptReplyMessage;
      }
    }
  }

  // Saludos, bienvenidas, agradecimientos o confirmaciones de cortesía NUNCA son preguntas sin respuesta ni requieren humano
  const isGreetingOrPolite = isGreetingOrSmallTalk(userText);
  if (isGreetingOrPolite && !q.hasImage) {
    result.needsHuman = false;
    result.isPayment = false;
  }

  // Cálculo determinista exacto en JS cuando hay orden cotizada para pago (Bs / BCV / USDT)
  let quotedOrderUsdtToSave = null;
  let quotedOrderBsToSave = null;
  if (!q.ctx.isPartner && result.orderAmountUsdt && Number(result.orderAmountUsdt) > 0) {
    const rateParalelo = Number(aiCtx?.rates?.paralelo || aiCtx?.exchangeRate || 1000);
    const rateBcv = Number(aiCtx?.rates?.bcv || 890);
    const orderUsdt = +Number(result.orderAmountUsdt).toFixed(2);
    const exactBs = +(orderUsdt * rateParalelo).toFixed(2);
    const exactBcv = rateBcv > 0 ? +(exactBs / rateBcv).toFixed(2) : orderUsdt;
    quotedOrderUsdtToSave = orderUsdt;
    quotedOrderBsToSave = exactBs;

    const breakdownBlock =
      `📌 *Detalle de tu Pedido:*\n` +
      `• Monto a transferir en Bs: *Bs. ${exactBs.toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}*\n` +
      `• Monto en $ (a tasa oficial BCV): *$${exactBcv.toFixed(2)}*\n` +
      `• Precio base en USDT: *${orderUsdt.toFixed(2)} USDT*\n\n` +
      `Una vez realizado el pago, envíanos el comprobante por aquí para verificarlo enseguida 🙌`;

    if (result.reply && result.reply.includes('[SEPARADOR_MENSAJE]')) {
      const firstPart = result.reply.split('[SEPARADOR_MENSAJE]')[0].trim();
      result.reply = firstPart ? `${firstPart}\n[SEPARADOR_MENSAJE]\n${breakdownBlock}` : breakdownBlock;
    } else if (result.reply) {
      result.reply = `${result.reply.trim()}\n[SEPARADOR_MENSAJE]\n${breakdownBlock}`;
    } else {
      result.reply = breakdownBlock;
    }
  }

  // Si a una pregunta no se le sabe la respuesta y se configuró mensaje personalizado de fallback
  if (!q.ctx.isPartner && result.needsHuman && !isGreetingOrPolite && !result.isPayment && !result.isCoordination && !result.isEquipmentSale && !result.deliveryExternalZone && !result.isUncorrelatedImage && !result.isBrandNewPhotoNotice) {
    if (aiCtx?.botConfig?.unknownQuestionFallbackMessage) {
      result.reply = aiCtx.botConfig.unknownQuestionFallbackMessage;
    }
  }

  // Sanitizar respuesta frente a clientes para que NUNCA aparezcan nombres propios de los dueños ni coletilla "Alerta"
  if (!q.ctx.isPartner && result.reply) {
    result.reply = result.reply
      .replace(/\bAnthony\s*(?:y|\&)\s*Sebasti[aá]n\b/gi, 'nuestro equipo')
      .replace(/\bSebasti[aá]n\s*(?:y|\&)\s*Anthony\b/gi, 'nuestro equipo')
      .replace(/\bAnthony\b/gi, 'nuestro equipo')
      .replace(/\bSebasti[aá]n\b/gi, 'nuestro equipo')
      .replace(/\bDoomlate\b/gi, 'Doomlater')
      .replace(/\bDoomlater\.Corp\b/gi, 'Doomlater')
      .replace(/\bDoomlaterCorp\b/gi, 'Doomlater');
    // Limpieza estricta: retirar cualquier residuo de palabra "Alerta"
    result.reply = result.reply
      .replace(/(?:[\.\s,]+|\b)(?:Alerta|Doom Alert|Doomlater Alert|ALERTA)[\.\s!]*$/gi, '.')
      .replace(/\b(?:Alerta|ALERTA)\b(?!\s+(?:de\s+estafa|bancaria|naranja|roja))/gi, '')
      .trim();
    result.reply = result.reply.replace(/\.\s*\.$/, '.');
  }

  // Si el cliente indica explícitamente que ya pagó o adjuntó pago por texto
  const paymentTextRegex = /(?:ya\s*(?:hice\s*el\s*pago|realic[eé]\s*el\s*pago|pagu[eé]|transfer[ií]|te\s*pagu[eé]|te\s*transfer[ií]|cancel[eé]|le\s*di)|pago\s*(?:listo|realizado|hecho|enviado)|listo\s*(?:amigo\s*)?(?:ya\s*)?(?:pagu[eé]|transfer[ií])|acabo\s*de\s*(?:pagar|transferir)|comprobante\s*(?:de\s*pago)?|capture\s*(?:del?\s*pago)?)/i;
  if (!q.ctx.isPartner && paymentTextRegex.test(userText)) {
    result.isPayment = true;
    result.needsHuman = true;
  }

  // Desglosar mensajes si contiene [SEPARADOR_MENSAJE] para enviar datos y presupuesto por separado
  const messagesToSend = [];
  if (result.reply && result.reply.includes('[SEPARADOR_MENSAJE]')) {
    const parts = result.reply.split('[SEPARADOR_MENSAJE]').map(p => p.trim()).filter(Boolean);
    messagesToSend.push(...parts);
  } else if (result.reply && result.reply.trim()) {
    messagesToSend.push(result.reply.trim());
  }

  let deliveryStatus = 'sent';
  let deliveryError = '';
  if (messagesToSend.length > 0) {
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

        for (let idx = 0; idx < messagesToSend.length; idx++) {
          const textPart = messagesToSend[idx];
          if (idx > 0) {
            await new Promise(r => setTimeout(r, 800)); // Breve pausa entre mensajes separados
          }
          let sentOk = false;
          let lastErr = null;
          for (const targetJid of candidateJids) {
            try {
              await waPresence('composing', targetJid);
              const typingMs = Math.min(1600, Math.max(500, Math.floor(textPart.length * 8)));
              await new Promise(r => setTimeout(r, typingMs)); // Pausa natural simulando escritura humana
              if (idx === 0 && result.pdfAttachment && result.pdfAttachment.buffer) {
                await waSend(targetJid, {
                  document: result.pdfAttachment.buffer,
                  mimetype: 'application/pdf',
                  fileName: result.pdfAttachment.fileName || 'Reporte_Doomlater.pdf',
                  caption: textPart
                });
              } else {
                await waSend(targetJid, { text: textPart });
              }
              await waPresence('paused', targetJid);
              sentOk = true;
              break;
            } catch (e) {
              lastErr = e;
            }
          }
          if (!sentOk && lastErr) throw lastErr;
        }
      } else {
        for (let idx = 0; idx < messagesToSend.length; idx++) {
          const textPart = messagesToSend[idx];
          if (idx > 0) await new Promise(r => setTimeout(r, 600));
          await graphSend(q.ctx.platform, q.ctx.recipientId, { text: textPart });
        }
      }
    } catch (err) {
      deliveryStatus = 'error';
      deliveryError = err.message;
      logger.error({ err: err.message, convId }, 'No se pudo enviar la respuesta automática');
    }
    pushHistory(convId, 'bot', result.reply);
  }

  // Alertas proactivas a los socios cuando un cliente reporta pago o solicita atención / coordina entrega
  if (!q.ctx.isPartner) {
    const cleanPhone = String(conv.customerPhone || q.ctx.phone || '').replace(/\D/g, '');
    const platformName = (conv.platform || q.ctx.platform || 'WhatsApp').toUpperCase();

    if (result.isBrandNewPhotoNotice) {
      const brandNewAlert =
        `🚨 *DOOMLATER ALERT: Cliente nuevo envió fotos* 📷\n\n` +
        `• *Cliente:* *${conv.customerName || 'Cliente'}* (+${cleanPhone})\n` +
        `• *Plataforma:* ${platformName}\n` +
        `• *Detalle:* Chat totalmente nuevo que envió imágenes sin texto. Se le envió bienvenida y espera por un asesor.\n` +
        `💡 _El bot continúa 100% activo y responderá con normalidad a cualquier texto que el cliente envíe._`;
      alertedConvsTrack.add(`alert_${convId}`);
      notifyPartners(brandNewAlert, `brandnew_${convId}`, { convId, cleanPhone }).catch(() => {});
    } else if (result.isUncorrelatedImage) {
      const uncorrAlert =
        `🚨 *DOOMLATER ALERT: Imagen no correlacionada* 🖼️\n\n` +
        `• *Cliente:* *${conv.customerName || 'Cliente'}* (+${cleanPhone})\n` +
        `• *Plataforma:* ${platformName}\n` +
        `• *Detalle:* El cliente envió una imagen sin correlación con pagos, lugares ni equipos: "${result.imageDescription}". No se envió respuesta automática.\n\n` +
        `👉 _El chat está marcado con alerta en la Web para revisar qué sucede._`;
      alertedConvsTrack.add(`alert_${convId}`);
      notifyPartners(uncorrAlert, `uncorr_${convId}`, { convId, cleanPhone }).catch(() => {});
    } else if (result.isPayment) {
      const pa = q.ctx.paymentAnalysis || {};
      const amt = Number(pa.amount || conv.pendingPaymentAmount || 0);
      const cur = (pa.currency === 'VED' || pa.currency === 'VES') ? 'VES' : (pa.currency || 'USD');
      let montoStr = '';
      if (cur === 'VES') {
        montoStr = `Bs. ${amt.toLocaleString('es-VE', { minimumFractionDigits: 2 })}`;
      } else if (cur === 'USDT') {
        montoStr = `${amt.toFixed(2)} USDT`;
      } else {
        montoStr = `Efectivo $${amt.toFixed(2)}`;
      }

      let montoVerifStr = '';
      const expectedBsToCheck = Number(q.ctx.previousExpectedBs || conv.expectedOrderBs || 0);
      const expectedUsdtToCheck = Number(q.ctx.previousExpectedUsdt || conv.expectedOrderUsdt || 0);
      if (cur === 'VES' && expectedBsToCheck > 0) {
        const diff = Math.abs(amt - expectedBsToCheck);
        if (diff <= 1.50) {
          montoVerifStr = `\n• *Verificación de Monto:* ✅ Coincide con la orden (Esperado: Bs. ${expectedBsToCheck.toFixed(2)} | Dif: Bs. ${diff.toFixed(2)} dentro de ±1.50 Bs)`;
        } else {
          montoVerifStr = `\n• *Verificación de Monto:* ⚠️ Revisar: Pagó Bs. ${amt.toFixed(2)} vs esperado Bs. ${expectedBsToCheck.toFixed(2)} (Diferencia: Bs. ${diff.toFixed(2)})`;
        }
      } else if (cur === 'USDT' && expectedUsdtToCheck > 0) {
        const diffUsdt = Math.abs(amt - expectedUsdtToCheck);
        if (diffUsdt <= 0.05) {
          montoVerifStr = `\n• *Verificación de Monto:* ✅ Coincide con la orden (${expectedUsdtToCheck.toFixed(2)} USDT)`;
        } else {
          montoVerifStr = `\n• *Verificación de Monto:* ⚠️ Revisar: Pagó ${amt.toFixed(2)} USDT vs esperado ${expectedUsdtToCheck.toFixed(2)} USDT`;
        }
      }

      const historyArr = (convHistory.get(convId) || []).map(h => h.text);
      if (userText) historyArr.push(userText);
      const queCompro = detectWhatCustomerBought(conv, historyArr, aiCtx?.stockItems, aiCtx?.botConfig?.serviceInsumosMap);

      const acctCheck = validateReceiptTargetAccount(pa);
      const cuentaValStr = acctCheck.matched
        ? `• *Datos Destino:* ✅ Coinciden con cuenta oficial (${acctCheck.name})`
        : `• *Datos Destino:* ⚠️ Revisar: Destino no coincide con cuentas oficiales`;

      const refStr = pa.reference ? ` (Ref: ${pa.reference})` : (conv.pendingPaymentRef ? ` (Ref: ${conv.pendingPaymentRef})` : '');

      const alertMsg =
        `🚨 *DOOMLATER ALERT: Pago por verificar* 🧾\n\n` +
        `• *Cliente:* *${conv.customerName || 'Cliente'}* (+${cleanPhone})\n` +
        `• *Plataforma:* ${platformName}\n` +
        `• *Monto:* *${montoStr}*${refStr}${montoVerifStr}\n` +
        `• *Motivo:* El cliente reportó un pago o envió un comprobante. Verifícalo\n` +
        `• *Qué compró:* ${queCompro}\n` +
        `${cuentaValStr}\n\n` +
        `💡 _Toca el botón *✅ Verificar Pago* aquí abajo (o escribe *${cleanPhone} pago verificado*) para aprobarlo, registrar el ingreso y avisar al cliente automáticamente._`;

      alertedConvsTrack.add(`pay_${convId}`);
      alertedConvsTrack.add(`alert_${convId}`);
      notifyPartners(alertMsg, `pay_${convId}`, { convId, cleanPhone }).catch(() => {});
    } else if (result.isEquipmentSale) {
      const saleAlertMsg =
        `🎮 *DOOMLATER ALERT: Cliente ofrece vender equipo/consola* 🕹️\n\n` +
        `• *Cliente:* *${conv.customerName || 'Cliente'}* (+${cleanPhone})\n` +
        `• *Plataforma:* ${platformName}\n` +
        `• *Mensaje del Cliente:* "${userText.slice(0, 150)}"\n\n` +
        `💡 _El bot le indicó que nuestro equipo estará evaluándolo para darle una cotización._`;
      alertedConvsTrack.add(`alert_${convId}`);
      notifyPartners(saleAlertMsg, `sale_${convId}`, { convId, cleanPhone }).catch(() => {});
      result.needsHuman = true;
    } else if (result.deliveryExternalZone) {
      const deliveryAlertMsg =
        `🚚 *DOOMLATER ALERT: Solicitud de Delivery Externo* 📦\n\n` +
        `• *Cliente:* *${conv.customerName || 'Cliente'}* (+${cleanPhone})\n` +
        `• *Plataforma:* ${platformName}\n` +
        `• *Zona Solicitada:* *${result.deliveryExternalZone}*\n` +
        `• *Mensaje:* "${userText.slice(0, 120)}"\n\n` +
        `💡 _Toca un monto rápido abajo o escribe aquí mismo:_\n` +
        `*${cleanPhone} delivery <precio>*  (ej: *${cleanPhone} delivery 3*)`;
      alertedConvsTrack.add(`alert_${convId}`);
      notifyPartners(deliveryAlertMsg, `delivery_${convId}`, { convId, cleanPhone }).catch(() => {});
      result.needsHuman = true;
    } else {
      // Detección precisa de coordinación de entrega (Lugar + Fecha/Hora escogida)
      const coord = parseCoordinationDetails(userText);
      const isCoordination = Boolean(coord || result.isCoordination);

      if (isCoordination) {
        const lugar = coord?.lugar || result.deliveryLugar || 'La Previsora / CC El Líder';
        const modalidad = coord?.modalidad || 'Entrega Gratuita en punto de encuentro';
        const fechaHora = coord?.fechaHora || result.deliveryFechaHora || 'Por confirmar con cliente';

        const coordAlertMsg =
          `📦 *DOOM ALERT ENTREGA* 🚚\n\n` +
          `• *Cliente:* *${conv.customerName || 'Cliente'}* (+${cleanPhone})\n` +
          `• *Plataforma:* ${platformName}\n` +
          `• *IMPORTANTE:* Coordiné con la persona para:\n` +
          `  - *Lugar:* *${lugar}*\n` +
          `  - *Modalidad:* ${modalidad}\n` +
          `  - *Fecha y Hora:* *${fechaHora}*\n` +
          `• *Último mensaje del Cliente:* "${userText.slice(0, 160)}"\n\n` +
          `⚠️ _El chat queda marcado con alerta de Entrega hasta tocar "Marcar Pedido como Entregado"._`;

        alertedConvsTrack.add(`coord_${convId}`);
        alertedConvsTrack.add(`alert_${convId}`);
        notifyPartners(coordAlertMsg, `coord_${convId}`, { convId, cleanPhone }).catch(() => {});
        result.needsHuman = true;
        result.isCoordination = true;
        result.deliveryLugar = lugar;
        result.deliveryFechaHora = fechaHora;
      } else if (result.needsHuman && !isGreetingOrPolite) {
        const alertMsg = `⚠️ *DOOMLATER ALERT: Atención Requerida*\n\n` +
          `• *Cliente:* *${conv.customerName || 'Cliente'}* (+${cleanPhone})\n` +
          `• *Plataforma:* ${platformName}\n` +
          `• *Último mensaje del Cliente:* "${userText.slice(0, 140)}"\n\n` +
          `👉 _Consulta fuera del catálogo o requiere respuesta directa de un socio._`;
        alertedConvsTrack.add(`human_${convId}`);
        alertedConvsTrack.add(`alert_${convId}`);
        notifyPartners(alertMsg, `human_${convId}`, { convId, cleanPhone }).catch(() => {});
      }
    }
  }

  const patch = {};
  if (!q.ctx.isPartner) {
    patch.lastCustomerMessage = userText;
    if (result.isPayment || (result.needsHuman && !isGreetingOrPolite)) {
      patch.needsAttention = true;
      patch.attentionReason = result.isPayment
        ? 'El cliente reportó un pago o envió un comprobante. Verifícalo.'
        : (result.isCoordination ? `🚚 Entrega coordinada pendiente: ${result.deliveryLugar || 'Punto oficial'} (${result.deliveryFechaHora || 'Por confirmar'})`
        : (result.deliveryExternalZone ? `Solicitud de delivery en zona: ${result.deliveryExternalZone}`
        : (result.isEquipmentSale ? 'Cliente ofrece equipo o consola en venta.'
        : (result.isUncorrelatedImage ? `Imagen sin correlación recibida: ${result.imageDescription}`
        : (result.isBrandNewPhotoNotice ? 'Cliente nuevo envió fotos sin texto. Espera asesor.' : 'Consulta fuera del catálogo o caso especial.')))));
    }
    if (result.isCoordination) {
      patch.deliveryStatus = 'pending_delivery';
    }
    if (result.isBrandNewPhotoNotice) {
      patch.botActive = true; // El bot nunca se desactiva en este caso
    }
    if (quotedOrderUsdtToSave !== null && quotedOrderBsToSave !== null) {
      patch.expectedOrderUsdt = quotedOrderUsdtToSave;
      patch.expectedOrderBs = quotedOrderBsToSave;
    }
    if (result.isPayment) {
      patch.pendingPayment = true;
      if (q.ctx.paymentAnalysis) {
        const pa = q.ctx.paymentAnalysis;
        patch.pendingPaymentAmount = Number(pa.amount) || conv.pendingPaymentAmount || 0;
        patch.pendingPaymentCurrency = pa.currency || 'USD';
        patch.pendingPaymentRef = pa.reference || conv.pendingPaymentRef || '';
        patch.pendingPaymentPhone = pa.targetPhoneOrId || conv.pendingPaymentPhone || '';
        patch.pendingPaymentDate = pa.paymentDate || conv.pendingPaymentDate || null;
        patch.pendingPaymentWalletId = q.ctx.destWalletId || conv.pendingPaymentWalletId || 'w_banco';
        patch.pendingPaymentWalletName = q.ctx.destWalletName || conv.pendingPaymentWalletName || '';
        patch.pendingPaymentBank = pa.bank || '';
      }
    }
  }
  if (result.reply && result.reply.trim()) {
    await recordOutgoing(convId, {
      id: `bmsg_bot_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`,
      text: result.reply,
      deliveryStatus,
      deliveryError
    }, patch);
  } else if (Object.keys(patch).length > 0) {
    await fb('PATCH', ws(`botConversations/${convId}`), { ...patch, updatedAt: Date.now() });
  }
}

function typingDelayMs(botConfig) {
  const sec = Number(botConfig && botConfig.typingDelaySec);
  return Math.min(15, Math.max(1, Number.isFinite(sec) && sec > 0 ? sec : 2.5)) * 1000;
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
  if (botSentIds.size > 2000) botSentIds.delete(botSentIds.values().next().value);
}

let lastGlobalWaSendAt = 0;
let waSendChain = Promise.resolve();

async function waSend(jid, content) {
  if (!waSock || waState !== 'connected') throw new Error('WhatsApp no está conectado en este momento.');
  // Cola anti-ráfaga (Anti-Ban): garantiza separación humana natural entre envíos consecutivos
  const run = async () => {
    if (!waSock || waState !== 'connected') throw new Error('WhatsApp no está conectado en este momento.');
    const minGapMs = 950 + Math.floor(Math.random() * 450);
    const elapsed = Date.now() - lastGlobalWaSendAt;
    if (elapsed < minGapMs) {
      await new Promise(r => setTimeout(r, minGapMs - elapsed));
    }
    const sent = await waSock.sendMessage(jid, content);
    lastGlobalWaSendAt = Date.now();
    rememberSent(sent?.key?.id);
    if (sent?.key?.id && sent?.message) {
      saveSentMessage(sent.key.id, sent.message);
    }
    return sent;
  };
  const next = waSendChain.then(run, run);
  waSendChain = next.catch(() => {});
  return next;
}
async function waPresence(type, jid) {
  try { if (waSock && waState === 'connected' && jid) await waSock.sendPresenceUpdate(type, jid); } catch (e) {}
}
async function waRead(key, humanDelay = false) {
  if (!waSock || waState !== 'connected' || !key) return;
  try {
    if (humanDelay) {
      const jitterMs = 750 + Math.floor(Math.random() * 900);
      await new Promise(r => setTimeout(r, jitterMs));
    }
    if (waSock && waState === 'connected') {
      await waSock.readMessages([key]);
    }
  } catch (e) {}
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
  try {
    if (typeof fetchLatestWaWebVersion === 'function') {
      const wv = await fetchLatestWaWebVersion({});
      if (wv && Array.isArray(wv.version)) version = wv.version;
    }
  } catch (e) {}
  if (!version) {
    try { ({ version } = await fetchLatestBaileysVersion()); } catch (e) {}
  }

  waState = 'connecting';
  await setWaStatus({ state: 'connecting', connected: false });

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
    logger: silentLogger,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
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
      backupAuthNow(true).catch(() => {});
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

  const isEdited = Boolean(
    msg.message?.editedMessage ||
    content?.editedMessage ||
    content?.protocolMessage?.type === 14 ||
    content?.protocolMessage?.editedMessage ||
    ctype === 'editedMessage'
  );
  if (isEdited) {
    logger.info({ jid }, 'Mensaje editado recibido en WhatsApp, se omite respuesta del bot');
    return;
  }

  const isViewOnce = Boolean(
    msg.message?.viewOnceMessage ||
    msg.message?.viewOnceMessageV2 ||
    msg.message?.viewOnceMessageV2Extension ||
    content?.viewOnceMessage ||
    content?.viewOnceMessageV2
  );

  const tsMs = (Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;
  // Solo mensajes nuevos entrantes (nunca responder al historial antiguo al vincular)
  if (!msg.key.fromMe) {
    if (type !== 'notify' && type !== 'append') return;
    if (Date.now() - tsMs > 10 * 60 * 1000) return;
    waRead(msg.key, true).catch(() => {}); // Pausa humana realista (0.75s - 1.65s) antes del doble check azul
  }

  const pnJid = jid.endsWith('@s.whatsapp.net') ? jid : (msg.key.senderPn || '');
  const phone = pnJid ? pnJid.split('@')[0].split(':')[0] : '';
  const partner = isAuthorizedPartner(jid) || isAuthorizedPartner(phone);

  const rawConvId = `conv_wa_${phone || `lid_${jid.split('@')[0].split(':')[0]}`}`;
  let targetConvId = partner ? `conv_wa_${partner.phone}` : rawConvId;
  let targetPhone = partner ? partner.phone : phone;

  // Resolver conversación correspondiente existente (incluso si fue borrada previamente)
  const existingConvs = (await fb('GET', ws('botConversations'))) || {};
  if (!partner) {
    for (const [cId, c] of Object.entries(existingConvs)) {
      if (c) {
        if (c.customerJid === jid || (phone && String(c.customerPhone || '').replace(/\D/g, '').endsWith(phone))) {
          targetConvId = cId;
          break;
        }
      }
    }
  }

  let caption = waTextOf(content);
  const label = WA_LABELS[ctype] || '';
  let text = caption ? (label && ctype !== 'extendedTextMessage' && ctype !== 'conversation' ? `${label}: ${caption}` : caption) : (label || '[Mensaje]');
  const msgId = `bmsg_wa_${safeId(msg.key.id)}`;

  // Mensajes que Tú o tu socio escriben desde la aplicación de WhatsApp (móvil):
  // Se reflejan de inmediato en la Web y en Firebase en el mismo chat
  if (msg.key.fromMe) {
    if (botSentIds.has(msg.key.id)) return;

    let mediaKey = null;
    if (ctype === 'imageMessage' || ctype === 'stickerMessage') {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: silentLogger, reuploadRequest: waSock?.updateMediaMessage });
        mediaKey = await saveMedia(msgId, content[ctype]?.mimetype || 'image/jpeg', buffer);
      } catch (err) {}
    }

    let existing = existingConvs[targetConvId];
    if (!existing) {
      existing = {
        id: targetConvId,
        platform: 'whatsapp',
        platformAccount: 'shared',
        customerName: partner ? partner.name : (targetPhone ? `+${targetPhone}` : 'Cliente WhatsApp'),
        customerPhone: targetPhone ? `+${targetPhone}` : '',
        customerJid: jid,
        botActive: true,
        needsAttention: false,
        unreadCount: 0,
        deleted: false,
        deletedAt: null,
        createdAt: tsMs || Date.now()
      };
      await fb('PUT', ws(`botConversations/${targetConvId}`), existing);
    } else if (existing.deleted) {
      existing.deleted = false;
      existing.deletedAt = null;
      await fb('PATCH', ws(`botConversations/${targetConvId}`), { deleted: false, deletedAt: null });
    }

    if (text) pushHistory(targetConvId, 'bot', text);

    const manualPatch = {};
    if (!partner && existing && existing.needsAttention && !existing.pendingPayment && existing.deliveryStatus !== 'pending_delivery') {
      manualPatch.needsAttention = false;
      manualPatch.attentionReason = null;
    }

    await recordOutgoing(targetConvId, {
      id: msgId,
      text,
      sentBy: partner ? partner.name : 'WhatsApp (Móvil)',
      deliveryStatus: 'sent',
      mediaKey,
      createdAt: tsMs || Date.now()
    }, manualPatch);
    return;
  }

  let mediaKey = null;
  let voiceTranscription = null;
  let paymentAnalysis = null;
  let downloadedImageBuffer = null;
  let downloadedImageMime = 'image/jpeg';
  let destWalletId = 'w_banco';
  let destWalletName = 'Pago Móvil / Banco';

  const botConfig = (await fb('GET', ws('meta/botConfig'))) || {};
  const apiKey = botConfig.geminiApiKey || GEMINI_API_KEY_ENV;

  if (ctype === 'imageMessage' || ctype === 'stickerMessage') {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: silentLogger, reuploadRequest: waSock?.updateMediaMessage });
      mediaKey = await saveMedia(msgId, content[ctype]?.mimetype || 'image/jpeg', buffer);
      if (buffer && ctype === 'imageMessage') {
        downloadedImageBuffer = buffer;
        downloadedImageMime = content[ctype]?.mimetype || 'image/jpeg';
        if (apiKey) {
          paymentAnalysis = await analyzePaymentCaptureWithGemini(buffer, downloadedImageMime, apiKey);
          if (paymentAnalysis && paymentAnalysis.isPayment) {
            const rawCur = String(paymentAnalysis.currency || 'USD').toUpperCase();
            const cur = (rawCur === 'VED' || rawCur === 'VES') ? 'VES' : rawCur;
            paymentAnalysis.currency = cur;
            const targetDigits = String(paymentAnalysis.targetPhoneOrId || '').replace(/\D/g, '');
            if (cur === 'USDT') {
              destWalletId = 'w_binance';
              destWalletName = 'Binance (USDT)';
            } else if (cur === 'VES') {
              if (targetDigits.includes('32030679') || targetDigits.includes('4264181643') || String(paymentAnalysis.targetPhoneOrId || '').toLowerCase().includes('sebasti')) {
                destWalletId = 'w_bs_socio';
                destWalletName = 'Cuenta Sebastián (VES)';
              } else if (targetDigits.includes('04142005801') || targetDigits.includes('4142005801') || String(paymentAnalysis.targetPhoneOrId || '').toLowerCase().includes('anthony')) {
                destWalletId = 'w_bs_anthony';
                destWalletName = 'Banesco Anthony (VES)';
              } else {
                destWalletId = 'w_banco';
                destWalletName = 'Pago Móvil / Banco (VES)';
              }
            } else if (cur === 'USD') {
              destWalletId = 'w_efectivo';
              destWalletName = 'Divisas Efectivo ($)';
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'No se pudo descargar o analizar la imagen');
    }
  } else if (ctype === 'audioMessage') {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: silentLogger, reuploadRequest: waSock?.updateMediaMessage });
      mediaKey = await saveMedia(msgId, content[ctype]?.mimetype || 'audio/ogg', buffer);
      if (buffer && apiKey) {
        voiceTranscription = await transcribeAndProcessAudio(buffer, content[ctype]?.mimetype || 'audio/ogg', apiKey);
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'No se pudo descargar o transcribir la nota de voz');
    }
  }

  const pushName = msg.pushName || '';
  if (voiceTranscription) {
    caption = voiceTranscription;
    text = `🎤 Nota de voz: "${voiceTranscription}"`;
  } else if (caption) {
    text = (label && ctype !== 'extendedTextMessage' && ctype !== 'conversation' ? `${label}: ${caption}` : caption);
  } else {
    text = (label || '[Mensaje]');
  }

  logger.info({ convId: targetConvId, pushName, text }, 'WhatsApp entrante');
  pushHistory(targetConvId, 'user', caption || label);

  const prevConvState = existingConvs[targetConvId] || null;
  const wasBrandNewConv = !prevConvState;
  const previousExpectedBs = Number(prevConvState?.expectedOrderBs || 0);
  const previousExpectedUsdt = Number(prevConvState?.expectedOrderUsdt || 0);

  const incomingBase = {
    platform: 'whatsapp',
    platformAccount: 'shared',
    customerName: partner ? partner.name : (pushName || (targetPhone ? `+${targetPhone}` : 'Cliente WhatsApp')),
    genericName: !pushName && !partner,
    customerPhone: targetPhone ? `+${targetPhone}` : '',
    customerJid: jid
  };

  if (paymentAnalysis && paymentAnalysis.isPayment) {
    incomingBase.pendingPayment = true;
    incomingBase.pendingPaymentAmount = Number(paymentAnalysis.amount) || 0;
    incomingBase.pendingPaymentCurrency = paymentAnalysis.currency || 'USD';
    incomingBase.pendingPaymentRef = paymentAnalysis.reference || '';
    incomingBase.pendingPaymentPhone = paymentAnalysis.targetPhoneOrId || '';
    incomingBase.pendingPaymentDate = paymentAnalysis.paymentDate || null;
    incomingBase.pendingPaymentWalletId = destWalletId;
    incomingBase.pendingPaymentWalletName = destWalletName;
    incomingBase.pendingPaymentBank = paymentAnalysis.bank || '';
    incomingBase.needsAttention = true;
    incomingBase.attentionReason = `Comprobante detectado: Ref ${paymentAnalysis.reference || 'S/N'} de ${(paymentAnalysis.currency === 'VED' || paymentAnalysis.currency === 'VES') ? 'Bs.' : '$'} ${paymentAnalysis.amount} al número ${paymentAnalysis.targetPhoneOrId || 'N/A'}`;
  }

  // 1. Detección de Stickers: Responder "¡Estamos a la orden! 🙌" con pausa humana natural
  if (ctype === 'stickerMessage' && !partner) {
    const conv = await recordIncoming({
      convId: targetConvId,
      base: incomingBase,
      msg: { id: msgId, text: '🏷️ Sticker', sentBy: pushName || 'Cliente', createdAt: tsMs || Date.now(), platform: 'whatsapp', ...(mediaKey ? { mediaKey, mediaType: 'image' } : {}) },
      label: `🏷️ ${pushName || targetPhone || 'Cliente'} (WhatsApp): Sticker`
    });

    if (botConfig.globalBotEnabled !== false && conv.botActive !== false) {
      try {
        if (botConfig.showTypingIndicator !== false) await waPresence('composing', jid);
        await new Promise(r => setTimeout(r, 650 + Math.floor(Math.random() * 400)));
        await waSend(jid, { text: '¡Estamos a la orden! 🙌' });
        await waPresence('paused', jid);
        pushHistory(targetConvId, 'bot', '¡Estamos a la orden! 🙌');
        await recordOutgoing(targetConvId, {
          id: `bmsg_bot_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`,
          text: '¡Estamos a la orden! 🙌',
          deliveryStatus: 'sent'
        });
      } catch (e) {
        logger.warn({ err: e.message }, 'No se pudo responder al sticker');
      }
    }
    return;
  }

  // 2. Detección de Archivos en modo Ver Una Sola Vez (x1)
  if (isViewOnce && !partner) {
    const cleanPhone = String(targetPhone || phone || '').replace(/\D/g, '');
    if (!caption || !caption.trim()) {
      incomingBase.needsAttention = true;
      incomingBase.attentionReason = 'El cliente envió un archivo en modo ver una sola vez (x1).';
      await recordIncoming({
        convId: targetConvId,
        base: incomingBase,
        msg: { id: msgId, text: '📷 Archivo en modo ver una sola vez (x1)', sentBy: pushName || 'Cliente', createdAt: tsMs || Date.now(), platform: 'whatsapp' },
        label: `📷 ${pushName || targetPhone || 'Cliente'} (WhatsApp): Archivo x1`
      });

      const voAlert =
        `🚨 *DOOMLATER ALERT: Archivo de una sola vez (x1)* 📸\n\n` +
        `• *Cliente:* *${pushName || targetPhone || 'Cliente'}* (+${cleanPhone})\n` +
        `• *Detalle:* El cliente envió una foto, audio o video en modo "ver una sola vez" (x1). No se envió respuesta automática al cliente.\n\n` +
        `👉 _Revisa el chat directamente en tu teléfono para ver el contenido antes de que expire._`;
      alertedConvsTrack.add(`alert_${targetConvId}`);
      notifyPartners(voAlert, `vo_${targetConvId}`, { convId: targetConvId, cleanPhone }).catch(() => {});
      return;
    } else {
      const voAlert =
        `🚨 *DOOMLATER ALERT: Archivo de una sola vez (x1) con texto* 📸\n\n` +
        `• *Cliente:* *${pushName || targetPhone || 'Cliente'}* (+${cleanPhone})\n` +
        `• *Texto del cliente:* "${caption}"\n\n` +
        `👉 _El bot responderá al texto con normalidad, pero revisa el archivo x1 en tu teléfono antes de que expire._`;
      alertedConvsTrack.add(`alert_${targetConvId}`);
      notifyPartners(voAlert, `vo_${targetConvId}`, { convId: targetConvId, cleanPhone }).catch(() => {});
    }
  }

  // 2.5. Detección de GIF animado sin texto: Registrar silenciosamente sin responder ni alertar
  const isGifWithoutCaption = ctype === 'videoMessage' && Boolean(content?.videoMessage?.gifPlayback) && (!caption || !caption.trim());
  if (!partner && isGifWithoutCaption) {
    await recordIncoming({
      convId: targetConvId,
      base: incomingBase,
      msg: { id: msgId, text: '🎞️ GIF', sentBy: pushName || 'Cliente', createdAt: tsMs || Date.now(), platform: 'whatsapp' },
      label: `🎞️ ${pushName || targetPhone || 'Cliente'} (WhatsApp): GIF`
    });
    return;
  }

  // 3. Detección de Solo Emojis o Emoticonos: Registrar en la conversación pero no responder nada
  if (!partner && (isOnlyEmojisOrEmoticons(caption) || (ctype !== 'imageMessage' && isOnlyEmojisOrEmoticons(text)))) {
    logger.info({ targetConvId, caption, text }, 'Mensaje con solo emojis/emoticonos detectado, se registra sin responder');
    await recordIncoming({
      convId: targetConvId,
      base: incomingBase,
      msg: { id: msgId, text: caption || text, sentBy: pushName || 'Cliente', createdAt: tsMs || Date.now(), platform: 'whatsapp' },
      label: `💬 ${pushName || targetPhone || 'Cliente'} (WhatsApp): ${caption || text}`
    });
    return;
  }

  const conv = await recordIncoming({
    convId: targetConvId,
    base: incomingBase,
    msg: { id: msgId, text, sentBy: partner ? partner.name : (pushName || 'Cliente'), createdAt: tsMs || Date.now(), platform: 'whatsapp', ...(mediaKey ? { mediaKey, mediaType: ctype === 'audioMessage' ? 'audio' : 'image' } : {}) },
    label: `💬 ${partner ? partner.name : (pushName || targetPhone || 'Cliente')} (WhatsApp): ${text.slice(0, 60)}`
  });

  const shouldReply = partner ? (botConfig.globalBotEnabled !== false) : (botConfig.globalBotEnabled !== false && conv.botActive !== false);
  if (shouldReply) {
    if (botConfig.showTypingIndicator !== false) await waPresence('composing', jid);
    scheduleAiReply(targetConvId, caption, {
      platform: 'whatsapp',
      jid,
      phone: targetPhone,
      hasImage: Boolean(mediaKey) || ctype === 'imageMessage',
      imageBuffer: downloadedImageBuffer,
      imageMime: downloadedImageMime,
      paymentAnalysis: paymentAnalysis || null,
      destWalletId,
      destWalletName,
      wasBrandNewConv,
      previousExpectedBs,
      previousExpectedUsdt,
      delayMs: partner ? 100 : typingDelayMs(botConfig),
      isPartner: Boolean(partner),
      partnerName: partner ? partner.name : null
    });
  }
}

let lastPairingReq = { phone: '', code: '', at: 0, gen: -1 };
async function requestPairingCode(phoneRaw) {
  const phone = String(phoneRaw || '').replace(/\D/g, '');
  if (phone.length < 10) throw new Error('Escribe el número completo con código de país, sin + ni espacios (ej: 584245323796).');
  if (!isOwner) throw new Error('Esta copia del servidor está en espera (otra copia controla WhatsApp).');
  if (waState === 'connected') throw new Error('WhatsApp ya está conectado.');
  // Evitar doble solicitud simultánea (HTTP localhost + Firebase pollCommands) que invalida el primer código
  if (lastPairingReq.gen === waGeneration && lastPairingReq.phone === phone && lastPairingReq.code && (Date.now() - lastPairingReq.at) < 45000) {
    logger.info({ phone, code: lastPairingReq.code }, 'Reutilizando código de vinculación activo (evitando doble generación)');
    return lastPairingReq.code;
  }
  await fb('PATCH', ws('meta/botConfig'), { requestPairingPhone: null }).catch(() => {});
  // Espera a que el socket esté listo (estado "qr") hasta 20 s
  for (let i = 0; i < 40 && waState !== 'qr'; i++) await new Promise(r => setTimeout(r, 500));
  if (!waSock || waState !== 'qr') throw new Error('WhatsApp aún está iniciando. Intenta de nuevo en unos segundos.');
  const raw = await waSock.requestPairingCode(phone);
  const code = String(raw || '').toUpperCase().match(/.{1,4}/g)?.join('-') || raw;
  lastPairingReq = { phone, code, at: Date.now(), gen: waGeneration };
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

  const [profile, botConfigRaw, prevMetaConv] = await Promise.all([
    metaProfile(platform, senderId),
    fb('GET', ws('meta/botConfig')),
    fb('GET', ws(`botConversations/${convId}`))
  ]);
  const botConfig = botConfigRaw || {};
  const apiKey = botConfig.geminiApiKey || GEMINI_API_KEY_ENV;

  const attachments = ev.message.attachments || [];
  let mediaKey = null;
  let downloadedImageBuffer = null;
  let downloadedImageMime = 'image/jpeg';
  let paymentAnalysis = null;
  let destWalletId = 'w_banco';
  let destWalletName = 'Pago Móvil / Banco';

  const img = attachments.find(a => a.type === 'image' && a.payload?.url);
  if (img) {
    try {
      const r = await fetch(img.payload.url);
      if (r.ok) {
        downloadedImageMime = r.headers.get('content-type') || 'image/jpeg';
        downloadedImageBuffer = Buffer.from(await r.arrayBuffer());
        mediaKey = await saveMedia(msgId, downloadedImageMime, downloadedImageBuffer);
        if (platform === 'instagram' && apiKey && downloadedImageBuffer) {
          paymentAnalysis = await analyzePaymentCaptureWithGemini(downloadedImageBuffer, downloadedImageMime, apiKey);
          if (paymentAnalysis && paymentAnalysis.isPayment) {
            const rawCur = String(paymentAnalysis.currency || 'USD').toUpperCase();
            paymentAnalysis.currency = (rawCur === 'VED' || rawCur === 'VES') ? 'VES' : rawCur;
            if (paymentAnalysis.currency === 'USDT') {
              destWalletId = 'w_binance';
              destWalletName = 'Binance (USDT)';
            }
          }
        }
      }
    } catch (e) {}
  }
  const caption = ev.message.text || '';
  const text = caption || (attachments.length ? `📎 ${attachments.map(a => a.type).join(', ')}` : '[Mensaje]');

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

  if (!img && isOnlyEmojisOrEmoticons(caption)) return;

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

  scheduleAiReply(convId, caption, {
    platform: 'instagram',
    recipientId: senderId,
    hasImage: Boolean(img),
    imageBuffer: downloadedImageBuffer,
    imageMime: downloadedImageMime,
    paymentAnalysis: paymentAnalysis || null,
    destWalletId,
    destWalletName,
    wasBrandNewConv: !prevMetaConv,
    previousExpectedBs: Number(prevMetaConv?.expectedOrderBs || 0),
    previousExpectedUsdt: Number(prevMetaConv?.expectedOrderUsdt || 0),
    delayMs: typingDelayMs(botConfig)
  });
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
        if (item.whatsappKey && waSock && waState === 'connected') {
          await waSock.sendMessage(item.to, { delete: item.whatsappKey });
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
            const humanDelay = Math.min(1400, Math.max(450, Math.floor(String(item.text || '').length * 8)));
            await new Promise(r => setTimeout(r, humanDelay));
            if (mediaPayload) {
              await waSend(targetJid, mediaPayload);
            } else {
              await waSend(targetJid, { text: item.text || '' });
            }
            await waPresence('paused', targetJid);
            if (item.convId && item.text) pushHistory(item.convId, 'bot', item.text);
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
let lastPolledCmdRev = 0;
async function pollCommands() {
  if (!isOwner) return;
  const cmds = await fb('GET', COMMANDS_PATH);
  if (cmds) {
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
  }

  // Solo descargar botConfig si meta/rev (13 bytes) cambió desde la última revisión
  const currentRev = Number(await fb('GET', ws('meta/rev'))) || 0;
  if (currentRev && currentRev === lastPolledCmdRev) return;
  lastPolledCmdRev = currentRev;
  cachedTgConfig.fetchedAt = 0; // refrescar config cuando la Web guarda cambios

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
    if (botCfg.requestTelegramTest) {
      await fb('PATCH', ws('meta/botConfig'), { requestTelegramTest: null });
      await runTelegramConnectionDiagnostic();
    }
  }
}

async function runTelegramConnectionDiagnostic() {
  const tg = await getTelegramAndAntiBanConfig(true);
  if (!tg.token) {
    await fb('PATCH', ws('meta/botConfig'), {
      telegramStatus: { ok: false, error: 'Falta pegar el Token del Bot de Telegram.', checkedAt: Date.now() }
    });
    return;
  }
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${tg.token}/getMe`, { signal: AbortSignal.timeout(8000) });
    const meJson = await meRes.json().catch(() => ({}));
    if (!meRes.ok || !meJson.ok) {
      await fb('PATCH', ws('meta/botConfig'), {
        telegramStatus: { ok: false, error: meJson.description || 'Token inválido en Telegram.', checkedAt: Date.now() }
      });
      return;
    }
    const botUser = meJson.result?.username || '';
    const botName = meJson.result?.first_name || 'Doomlater Bot';
    let sent = false;
    if (tg.chatIds.length > 0) {
      sent = await sendTelegramAlert(
        `🛡️ *DOOMLATER ANTI-BAN ACTIVO* ✅\n\n` +
        `• *Bot:* @${botUser} (${botName})\n` +
        `• *Dispositivos vinculados:* ${tg.chatIds.length}\n` +
        `• *WhatsApp Blindado:* Cero alertas salientes por WhatsApp.\n\n` +
        `Aquí recibirás al instante pagos, entregas coordinadas y consultas especiales con botones de 1 toque.`
      );
    }
    await fb('PATCH', ws('meta/botConfig'), {
      telegramBotUsername: botUser,
      telegramStatus: {
        ok: true,
        username: botUser,
        name: botName,
        subscribersCount: tg.chatIds.length,
        testSent: sent,
        checkedAt: Date.now()
      }
    });
  } catch (err) {
    await fb('PATCH', ws('meta/botConfig'), {
      telegramStatus: { ok: false, error: err.message, checkedAt: Date.now() }
    });
  }
}

/* --------------------------------------------------------------------------
   TELEGRAM: AUTO-VINCULACIÓN, BOTONES DE 1 TOQUE Y COMANDOS EJECUTIVOS
   -------------------------------------------------------------------------- */
let tgUpdateOffset = 0;
let tgLastInitializedToken = '';
let tgPollingBusy = false;

async function answerTgCallback(token, callbackQueryId, text, showAlert = false) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: String(text || '').slice(0, 190), show_alert: showAlert })
    });
  } catch (e) {}
}

async function handleTelegramCallbackAction(tg, cq) {
  const data = String(cq.data || '');
  const chatId = cq.message?.chat?.id;
  const fromName = cq.from?.first_name || cq.from?.username || 'Socio';
  const partnerName = /seba/i.test(fromName) ? 'Sebastián' : 'Anthony';

  if (data.startsWith('vpay:')) {
    const convId = resolveTgShortConvKey(data.slice(5));
    const conv = await fb('GET', ws(`botConversations/${convId}`));
    if (!conv) {
      await answerTgCallback(tg.token, cq.id, 'No se encontró la conversación.', true);
      return;
    }
    const cleanDigits = String(conv.customerPhone || '').replace(/\D/g, '');
    const adminCtx = await loadAdminExecutiveContext();
    const cmdText = cleanDigits ? `${cleanDigits} pago verificado` : 'pago verificado';
    const reply = await handlePartnerCommands(cmdText, adminCtx, partnerName);
    await answerTgCallback(tg.token, cq.id, '✅ ¡Pago verificado y cliente notificado!');
    if (chatId && reply) {
      await sendTelegramAlert(typeof reply === 'string' ? reply : reply.reply, undefined, chatId);
    }
    return;
  }

  if (data.startsWith('qdel:')) {
    const parts = data.slice(5).split(':');
    const fee = parts.pop();
    const convId = resolveTgShortConvKey(parts.join(':'));
    const conv = await fb('GET', ws(`botConversations/${convId}`));
    if (!conv) {
      await answerTgCallback(tg.token, cq.id, 'No se encontró la conversación.', true);
      return;
    }
    const cleanDigits = String(conv.customerPhone || '').replace(/\D/g, '');
    if (!cleanDigits) {
      await answerTgCallback(tg.token, cq.id, 'Este chat no tiene teléfono válido para comando automático.', true);
      return;
    }
    const adminCtx = await loadAdminExecutiveContext();
    const reply = await handlePartnerCommands(`${cleanDigits} delivery ${fee}`, adminCtx, partnerName);
    await answerTgCallback(tg.token, cq.id, `🚚 Delivery $${fee} cotizado al cliente!`);
    if (chatId && reply) {
      await sendTelegramAlert(typeof reply === 'string' ? reply : reply.reply, undefined, chatId);
    }
    return;
  }

  if (data.startsWith('mdel:')) {
    const convId = resolveTgShortConvKey(data.slice(5));
    const conv = await fb('GET', ws(`botConversations/${convId}`));
    if (!conv) {
      await answerTgCallback(tg.token, cq.id, 'No se encontró la conversación.', true);
      return;
    }
    const now = Date.now();
    await commitAndVerifyWebSync({
      [`botConversations/${convId}/deliveryStatus`]: 'delivered',
      [`botConversations/${convId}/deliveredAt`]: now,
      [`botConversations/${convId}/needsAttention`]: false,
      [`botConversations/${convId}/attentionReason`]: null,
      [`botConversations/${convId}/updatedAt`]: now,
      'meta/updatedAt': now,
      'meta/rev': now,
      'meta/lastLabel': `Pedido de ${conv.customerName || 'Cliente'} marcado entregado desde Telegram`
    }, 'Entrega completada');
    alertedConvsTrack.delete(`coord_${convId}`);
    alertedConvsTrack.delete(`alert_${convId}`);
    await answerTgCallback(tg.token, cq.id, '📦 ¡Pedido marcado como entregado!');
    if (chatId) {
      await sendTelegramAlert(`✅ *Pedido marcado como ENTREGADO*\n• Cliente: ${conv.customerName || 'Cliente'} (${conv.customerPhone || ''})\n• Alerta retirada de la Web.`, undefined, chatId);
    }
    return;
  }

  if (data.startsWith('calr:')) {
    const convId = resolveTgShortConvKey(data.slice(5));
    const conv = await fb('GET', ws(`botConversations/${convId}`));
    const now = Date.now();
    await fb('PATCH', ROOT, {
      [`botConversations/${convId}/needsAttention`]: false,
      [`botConversations/${convId}/attentionReason`]: null,
      [`botConversations/${convId}/updatedAt`]: now,
      'meta/updatedAt': now,
      'meta/rev': now
    });
    alertedConvsTrack.delete(`alert_${convId}`);
    alertedConvsTrack.delete(`human_${convId}`);
    await answerTgCallback(tg.token, cq.id, '✅ Alerta retirada de la Web.');
    if (chatId) {
      await sendTelegramAlert(`✅ Alerta retirada para *${conv?.customerName || convId}* (por ${fromName}).`, undefined, chatId);
    }
  }
}

async function pollTelegramUpdates() {
  if (!isOwner || tgPollingBusy) return;
  const tg = await getTelegramAndAntiBanConfig();
  if (!tg.token) return;

  tgPollingBusy = true;
  try {
    if (tgLastInitializedToken !== tg.token) {
      tgLastInitializedToken = tg.token;
      await fetch(`https://api.telegram.org/bot${tg.token}/deleteWebhook`, { signal: AbortSignal.timeout(6000) }).catch(() => {});
      await runTelegramConnectionDiagnostic().catch(() => {});
    }

    const url = `https://api.telegram.org/bot${tg.token}/getUpdates?timeout=0&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'callback_query']))}${tgUpdateOffset ? `&offset=${tgUpdateOffset}` : ''}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const json = await res.json().catch(() => ({}));
    if (!json.ok || !Array.isArray(json.result) || json.result.length === 0) return;

    for (const upd of json.result) {
      tgUpdateOffset = Math.max(tgUpdateOffset, Number(upd.update_id) + 1);

      if (upd.callback_query) {
        await handleTelegramCallbackAction(tg, upd.callback_query).catch(err => logger.warn({ err: err.message }, 'Error en callback de Telegram'));
        continue;
      }

      const msg = upd.message;
      if (!msg || !msg.chat) continue;
      const chatId = String(msg.chat.id);
      const text = String(msg.text || msg.caption || '').trim();
      if (!text) continue;

      const fromFirst = msg.from?.first_name || '';
      const fromUser = msg.from?.username || '';
      const chatTitle = msg.chat.title || `${fromFirst} ${msg.from?.last_name || ''}`.trim() || fromUser || 'Socio';

      // Auto-vinculación inmediata con /start o /vincular
      if (/^\/(?:start|vincular)\b/i.test(text)) {
        const subEntry = {
          chatId,
          name: chatTitle,
          username: fromUser,
          type: msg.chat.type || 'private',
          linkedAt: Date.now()
        };
        await fb('PUT', ws(`meta/botConfig/telegramSubscribers/tg_${safeId(chatId)}`), subEntry);
        cachedTgConfig.fetchedAt = 0; // refrescar caché inmediata
        const freshTg = await getTelegramAndAntiBanConfig(true);
        await fb('PATCH', ws('meta/botConfig/telegramStatus'), {
          ok: true,
          subscribersCount: freshTg.chatIds.length,
          lastLinkedName: chatTitle,
          checkedAt: Date.now()
        });

        await sendTelegramAlert(
          `✅ *¡Dispositivo vinculado a Doomlater con éxito!*\n\n` +
          `👤 *Socio / Chat:* ${chatTitle}\n` +
          `🛡️ *Blindaje Anti-Baneo:* Activo (Tu WhatsApp ya NO enviará alertas automáticas salientes).\n\n` +
          `*¿Qué puedes hacer aquí mismo en Telegram?*\n` +
          `• Recibirás al instante pagos, entregas coordinadas y dudas con *botones de 1 toque*.\n` +
          `• Consultar cualquier servicio (con o sin memoria), stock o saldos.\n` +
          `• Escribir *0414... pago verificado* o *0414... delivery 4*.\n` +
          `• Pedir *facturas* y *contratos* en PDF directo aquí.`,
          undefined,
          chatId
        );
        continue;
      }

      // Solo responder consultas ejecutivas a chats ya vinculados (seguridad total)
      const refreshedTg = await getTelegramAndAntiBanConfig();
      if (!refreshedTg.chatIds.includes(chatId)) {
        await sendTelegramAlert(`🔒 Envía */start* primero para vincular este chat como socio de Doomlater.`, undefined, chatId);
        continue;
      }

      const partnerName = /seba/i.test(`${fromFirst} ${fromUser}`) ? 'Sebastián' : 'Anthony';
      const adminCtx = await loadAdminExecutiveContext();
      const aiRes = await queryAdminAI(`conv_tg_${safeId(chatId)}`, text, adminCtx, partnerName);
      if (aiRes?.pdfAttachment?.buffer) {
        await sendTelegramDocument(chatId, aiRes.pdfAttachment.buffer, aiRes.pdfAttachment.fileName, aiRes.reply || '');
      } else if (aiRes?.reply) {
        await sendTelegramAlert(aiRes.reply, undefined, chatId);
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Error en pollTelegramUpdates');
  } finally {
    tgPollingBusy = false;
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
  if (process.env.VERCEL || process.env.NOW_BUILDER || WA_DISABLED) {
    logger.warn('Entorno Vercel Serverless: no toma control de WhatsApp.');
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
    app: 'Doomlater Bot Bridge',
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
   MONITOR PROACTIVO DE CHATS EN ALERTA (WEB Y BOT)
   -------------------------------------------------------------------------- */
const alertedConvsTrack = new Set();
let initialAlertScanDone = false;
let lastCheckedAlertRev = 0;

async function checkAttentionAlertsAndNotify() {
  if (!isOwner) return;
  const tg = await getTelegramAndAntiBanConfig();
  const canSendTg = Boolean(tg.token && tg.chatIds.length > 0);
  const canSendWa = Boolean(!tg.antiBanStrictMode && waSock && waState === 'connected');
  if (!canSendTg && !canSendWa) return;

  try {
    // Ahorro extremo de ancho de banda: revisar primero meta/rev (13 bytes) antes de descargar conversaciones
    const rev = Number(await fb('GET', ws('meta/rev'))) || 0;
    if (initialAlertScanDone && rev && rev === lastCheckedAlertRev) return;
    lastCheckedAlertRev = rev;

    const convsRaw = await fb('GET', ws('botConversations'));
    if (!convsRaw) return;
    const convs = Object.values(convsRaw).filter(c => c && !c.deleted);

    // En el primer escaneo tras iniciar el servidor, registramos alertas viejas ya existentes
    // para NUNCA re-disparar alertas antiguas en cada reinicio de Render.
    if (!initialAlertScanDone) {
      for (const c of convs) {
        if (c.needsAttention || c.pendingPayment) {
          alertedConvsTrack.add(`alert_${c.id}`);
          alertedConvsTrack.add(`${c.id}_${Boolean(c.needsAttention)}_${Boolean(c.pendingPayment)}`);
          if (c.pendingPayment) alertedConvsTrack.add(`pay_${c.id}`);
          if (c.deliveryStatus === 'pending_delivery') alertedConvsTrack.add(`coord_${c.id}`);
        }
      }
      initialAlertScanDone = true;
      return;
    }

    for (const c of convs) {
      if (!c.needsAttention && !c.pendingPayment && c.deliveryStatus !== 'pending_delivery') {
        alertedConvsTrack.delete(`alert_${c.id}`);
        alertedConvsTrack.delete(`coord_${c.id}`);
        alertedConvsTrack.delete(`pay_${c.id}`);
        alertedConvsTrack.delete(`human_${c.id}`);
        alertedConvsTrack.delete(`${c.id}_true_false`);
        alertedConvsTrack.delete(`${c.id}_true_true`);
        alertedConvsTrack.delete(`${c.id}_false_true`);
        continue;
      }

      if (c.needsAttention || c.pendingPayment) {
        // Excluir chats directos entre socios a menos que sea una simulación
        const isPartnerPhone = c.customerPhone === '584142005801' || c.customerPhone === '584264181643';
        if (isPartnerPhone && !String(c.attentionReason || '').includes('Simulación')) continue;

        // Evitar duplicar alertas que ya fueron enviadas de forma inmediata por DOOM ALERT ENTREGA o Reporte de Pago
        if (alertedConvsTrack.has(`coord_${c.id}`) || alertedConvsTrack.has(`pay_${c.id}`) || alertedConvsTrack.has(`alert_${c.id}`)) {
          continue;
        }
        if (c.deliveryStatus === 'pending_delivery' || String(c.attentionReason || '').includes('Entrega coordinada')) {
          continue;
        }

        const trackKey = `${c.id}_${Boolean(c.needsAttention)}_${Boolean(c.pendingPayment)}`;
        if (alertedConvsTrack.has(trackKey) || alertedConvsTrack.has(`alert_${c.id}`)) continue;
        alertedConvsTrack.add(trackKey);
        alertedConvsTrack.add(`alert_${c.id}`);

        const isPayment = Boolean(c.pendingPayment);
        const alertTag = isPayment ? 'Pago por verificar' : 'Atención Requerida (Chat en Alerta)';
        const custName = c.customerName || 'Cliente';
        const cleanCustPhone = String(c.customerPhone || '').replace(/\D/g, '');
        const custPhone = cleanCustPhone ? ` (+${cleanCustPhone})` : '';
        const cur = (c.pendingPaymentCurrency === 'VED' || c.pendingPaymentCurrency === 'VES') ? 'VES' : (c.pendingPaymentCurrency || 'USD');
        let amtStr = '';
        if (isPayment && c.pendingPaymentAmount) {
          const amt = Number(c.pendingPaymentAmount) || 0;
          amtStr = cur === 'VES'
            ? `\n• *Monto:* Bs. ${amt.toLocaleString('es-VE', { minimumFractionDigits: 2 })}`
            : (cur === 'USDT' ? `\n• *Monto:* ${amt.toFixed(2)} USDT` : `\n• *Monto:* Efectivo $${amt.toFixed(2)}`);
        }
        const reason = c.attentionReason ? `\n• *Motivo:* ${c.attentionReason}` : '';
        const custMsgText = c.lastCustomerMessage || (c.lastMessage && c.updatedBy !== 'bot' ? c.lastMessage : '');
        const lastMsg = custMsgText ? `\n• *Último mensaje del Cliente:* "${String(custMsgText).slice(0, 140)}"` : '';

        const alertMsg = `🚨 *DOOMLATER ALERT: ${alertTag}* 🧾\n\n` +
          `• *Cliente:* *${custName}*${custPhone}\n` +
          `• *Plataforma:* ${(c.platform || 'WhatsApp').toUpperCase()}${amtStr}${reason}${lastMsg}\n\n` +
          `⚠️ _El chat está marcado con alerta en la Web._` +
          (isPayment ? `\n💡 _Toca *✅ Verificar Pago* abajo${cleanCustPhone ? ` o escribe *${cleanCustPhone} pago verificado*` : ''} para aprobarlo automáticamente._` : '');

        await notifyPartners(alertMsg, isPayment ? `pay_${c.id}` : `alert_${c.id}`, { convId: c.id, cleanPhone: cleanCustPhone });
      }
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Error en monitor de chats en alerta');
  }
}

/* --------------------------------------------------------------------------
   ARRANQUE
   -------------------------------------------------------------------------- */
app.listen(PORT, async () => {
  logger.info(`Bot Bridge v${SERVER_VERSION} escuchando en el puerto ${PORT} (${INSTANCE_HOST})`);
  if (!WA_AUTH_SECRET) logger.warn('WA_AUTH_SECRET no configurado: la sesión de WhatsApp NO sobrevivirá a reinicios de Render.');
  if (!META_PAGE_TOKEN) logger.warn('META_PAGE_ACCESS_TOKEN no configurado: se reciben mensajes de Meta pero no se puede responder.');

  await setMetaStatus({ serverSeenAt: Date.now() });
  await decideOwnershipAtStartup().catch(err => logger.error({ err: err.message }, 'Error al iniciar WhatsApp'));

  setInterval(() => heartbeat().catch(() => {}), 30000);
  setInterval(() => pollCommands().catch(() => {}), 5000);
  setInterval(() => processOutbox().catch(() => {}), 3500);
  setInterval(() => pollTelegramUpdates().catch(() => {}), 3000);
  setInterval(() => backupAuthNow().catch(() => {}), 5 * 60 * 1000);
  setInterval(() => checkLowStockAndAlert().catch(() => {}), 15 * 60 * 1000);
  setInterval(() => checkPartnerReminders().catch(() => {}), 30000);
  setInterval(() => checkAttentionAlertsAndNotify().catch(() => {}), 8000);

  // Render (plan gratis) se duerme tras 15 min sin tráfico: nos auto-visitamos cada 10 min.
  if (RENDER_URL) {
    setInterval(() => fetch(`${RENDER_URL}/healthz`).catch(() => {}), 10 * 60 * 1000);
  }
});

async function handleGracefulShutdown(signal) {
  logger.info({ signal }, 'Apagado detectado: guardando sesión de WhatsApp antes de cerrar...');
  try {
    await backupAuthNow(true);
  } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));
