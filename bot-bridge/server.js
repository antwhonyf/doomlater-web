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
  const hasLocal = fs.existsSync(path.join(authFolder, 'creds.json'));
  if (hasLocal && localSavedAt >= Number(blob.savedAt || 0)) return;
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
  if (isOwner) await fb('DELETE', AUTH_PATH);
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

async function loadAiContext() {
  const [botConfig, stockRaw] = await Promise.all([fb('GET', ws('meta/botConfig')), fb('GET', ws('stockItems'))]);
  const cfg = botConfig || {};
  return {
    botConfig: cfg,
    stockItems: stockRaw ? Object.values(stockRaw).filter(Boolean) : [],
    paymentMethods: Array.isArray(cfg.paymentMethods) ? cfg.paymentMethods : [],
    knowledgeBaseFaq: Array.isArray(cfg.knowledgeBaseFaq) ? cfg.knowledgeBaseFaq : []
  };
}

function buildSystemPrompt({ stockItems, paymentMethods, knowledgeBaseFaq }) {
  const stock = stockItems
    .filter(i => !i.deleted && (i.kind === 'para_vender' || i.kind === 'insumo'))
    .map(i => `- ${i.name}: stock ${i.stock} | precio $${Number(i.salePrice || i.purchaseCost || 0).toFixed(2)}${i.extraDetail || i.notes ? ` | ${i.extraDetail || i.notes}` : ''}`)
    .join('\n');
  const faq = knowledgeBaseFaq.map(f => `P: ${f.question}\nR: ${f.answer}`).join('\n\n');
  const pm = paymentMethods.map(p => `• ${p.name}: ${p.details}`).join('\n');
  return `Eres el asistente de atención al cliente de Doomlater.Corp (consolas, videojuegos, accesorios y servicio técnico).
Responde en español, breve, cálido y humano (máximo 4 frases). No digas que eres una IA salvo que te lo pregunten.
Usa SOLO estos datos:

=== STOCK ===
${stock || '(sin datos de stock)'}

=== PREGUNTAS FRECUENTES ===
${faq || '(sin FAQ)'}

=== MÉTODOS DE PAGO ===
${pm || '(consultar con el equipo)'}

Reglas:
- Si preguntan cómo pagar: da los métodos de pago y pide el comprobante por este chat.
- Si dicen que ya pagaron o envían comprobante: agradece, di que los socios lo verifican en breve y agrega al final [FLAG_PAGO_REPORTADO].
- Si preguntan algo que no está en los datos: di que consultas con el equipo y responden en breve, y agrega al final [FLAG_REQUIERE_HUMANO].
- Nunca inventes precios, productos ni datos.`;
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
  if (q.hasImage && !/[a-z]{4,}/i.test(userText)) {
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
      const cleanPhone = String(q.ctx.phone || '').replace(/\D/g, '');
      if (cleanPhone && cleanPhone.length >= 8) candidateJids.push(`${cleanPhone}@s.whatsapp.net`);
      if (q.ctx.jid && !candidateJids.includes(q.ctx.jid)) candidateJids.push(q.ctx.jid);
      if (candidateJids.length === 0) candidateJids.push(q.ctx.jid);

      let sentOk = false;
      let lastErr = null;
      for (const targetJid of candidateJids) {
        try {
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

  const patch = {};
  if (result.isPayment || result.needsHuman) {
    patch.needsAttention = true;
    patch.attentionReason = result.isPayment
      ? 'El cliente reportó un pago o envió un comprobante. Verifícalo.'
      : 'Consulta fuera del catálogo o caso especial.';
  }
  if (result.isPayment) patch.pendingPayment = true;
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

function rememberSent(id) {
  if (!id) return;
  botSentIds.add(id);
  if (botSentIds.size > 500) botSentIds.delete(botSentIds.values().next().value);
}

async function waSend(jid, content) {
  if (!waSock || waState !== 'connected') throw new Error('WhatsApp no está conectado en este momento.');
  const sent = await waSock.sendMessage(jid, content);
  rememberSent(sent?.key?.id);
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
    markOnlineOnConnect: false,          // tu teléfono sigue recibiendo notificaciones
    syncFullHistory: false,
    generateHighQualityLinkPreview: false
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
        logger.warn('La sesión fue cerrada desde el teléfono.');
        wipeLocalAuth();
        await setWaStatus({ state: 'logged_out', connected: false, qr: null, lastError: 'Sesión desvinculada desde el teléfono.' });
        scheduleWaRestart(3000);
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
  // Solo mensajes nuevos (nunca responder al historial antiguo al vincular)
  if (type !== 'notify' && !msg.key.fromMe) return;
  if (Date.now() - tsMs > 3 * 60 * 1000) return;

  const pnJid = jid.endsWith('@s.whatsapp.net') ? jid : (msg.key.senderPn || '');
  const phone = pnJid ? pnJid.split('@')[0].split(':')[0] : '';
  const convId = `conv_wa_${phone || `lid_${jid.split('@')[0].split(':')[0]}`}`;
  const caption = waTextOf(content);
  const label = WA_LABELS[ctype] || '';
  const text = caption ? (label && ctype !== 'extendedTextMessage' && ctype !== 'conversation' ? `${label}: ${caption}` : caption) : (label || '[Mensaje]');
  const msgId = `bmsg_wa_${safeId(msg.key.id)}`;

  // Mensajes que TÚ escribes desde el teléfono: se guardan en el inbox (no los que envió el bot)
  if (msg.key.fromMe) {
    if (botSentIds.has(msg.key.id)) return;
    const existing = await fb('GET', ws(`botConversations/${convId}`));
    if (!existing) return;
    await recordOutgoing(convId, { id: msgId, text, sentBy: 'Teléfono' });
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

  const botConfig = (await fb('GET', ws('meta/botConfig'))) || {};
  if (botConfig.globalBotEnabled !== false && conv.botActive !== false) {
    if (botConfig.showTypingIndicator !== false) await waPresence('composing', jid);
    scheduleAiReply(convId, caption, {
      platform: 'whatsapp',
      jid,
      phone,
      hasImage: Boolean(mediaKey) || ctype === 'imageMessage',
      delayMs: typingDelayMs(botConfig)
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

function resolveWaJids(item) {
  const jids = [];
  const rawPhone = item.phone || item.customerPhone || (item.to && !item.to.includes('@') ? item.to : '') || '';
  let phoneDigits = String(rawPhone || '').replace(/\D/g, '');
  if (!phoneDigits && item.convId && item.convId.startsWith('conv_wa_')) {
    const extracted = item.convId.replace('conv_wa_', '');
    if (/^\d{8,16}$/.test(extracted)) phoneDigits = extracted;
  }
  // 1. Phone JID is the most universal and reliable destination for WhatsApp users
  if (phoneDigits && phoneDigits.length >= 8) {
    jids.push(`${phoneDigits}@s.whatsapp.net`);
  }
  // 2. Explicit JID if provided (e.g. LID or group)
  if (item.jid && item.jid.includes('@') && !jids.includes(item.jid)) {
    jids.push(item.jid);
  }
  if (item.to && item.to.includes('@') && !jids.includes(item.to)) {
    jids.push(item.to);
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
        const media = dataUrlToBuffer(item.mediaUrl);
        let sentOk = false;
        let lastErr = null;
        for (const targetJid of candidateJids) {
          try {
            if (media) {
              const kind = media.mime.startsWith('video') ? 'video' : 'image';
              await waSend(targetJid, { [kind]: media.buffer, caption: item.text || undefined, mimetype: media.mime });
            } else if (item.mediaUrl && /^https?:/.test(item.mediaUrl)) {
              await waSend(targetJid, { image: { url: item.mediaUrl }, caption: item.text || undefined });
            } else {
              await waSend(targetJid, { text: item.text || '' });
            }
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
  const st = await fb('GET', STATUS_PATH, undefined, 'shallow=true');
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

  // Render (plan gratis) se duerme tras 15 min sin tráfico: nos auto-visitamos cada 10 min.
  if (RENDER_URL) {
    setInterval(() => fetch(`${RENDER_URL}/healthz`).catch(() => {}), 10 * 60 * 1000);
  }
});
