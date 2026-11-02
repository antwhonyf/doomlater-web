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

/** Modelos de Gemini verificados y ultra-rápidos en orden de prioridad */
const WORKING_GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.5-flash',
  'gemini-3.7-flash'
];
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

async function notifyPartners(text, alertKey = null) {
  if (!waSock || waState !== 'connected') return;
  if (alertKey) {
    const isAlert = String(alertKey).startsWith('pay_') || String(alertKey).startsWith('human_') || String(alertKey).startsWith('alert_');
    const cooldownMs = isAlert ? 30 * 1000 : (15 * 60 * 1000);
    const last = partnerAlertCooldown.get(alertKey) || 0;
    if (Date.now() - last < cooldownMs) return; // Cooldown de 30s para alertas críticas, 15 min para otras
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
  return sendPartnerDirectMessage('Doom Bot', target, text);
}

/**
 * Envío directo e inmediato de mensajes o documentos PDF a uno de los socios.
 */
async function sendPartnerDirectMessage(fromPartnerName, toTarget, text, pdfAttachment = null) {
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
      currentStream += 'BT\n/F1 8 Tf\n36 30 Td\n(Doomlater.Corp - Documento Oficial Generado por Doom Bot IA) Tj\nET\n';
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

  currentStream += 'BT\n/F1 8 Tf\n36 30 Td\n(Doomlater.Corp - Documento Oficial Generado por Doom Bot IA) Tj\nET\n';
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
      title: 'Doomlater.Corp - Inventario Oficial de Stock',
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
    title: 'Doomlater.Corp - Estado de Cuenta Financiero',
    subtitle: `Fecha: ${dateStr} - ${timeStr} | Solicitado por: @${requesterName}`,
    sections
  });

  return {
    buffer,
    fileName: `Estado_De_Cuenta_Doomlater_${now.toISOString().slice(0, 10)}.pdf`,
    title: 'Estado de Cuenta Financiero'
  };
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

let cachedRate = { rate: 998, updatedAt: 0 };
async function getLiveExchangeRate() {
  if (Date.now() - cachedRate.updatedAt < 15 * 60 * 1000 && cachedRate.rate > 0) {
    return cachedRate.rate;
  }
  try {
    const res = await fetch('https://ve.dolarapi.com/v1/dolares', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const par = Array.isArray(data) ? data.find(d => d.fuente === 'paralelo') : null;
      const rateVal = par ? Number(par.promedio) : (data[0] ? Number(data[0].promedio) : 0);
      if (rateVal > 0) {
        cachedRate = { rate: Math.round(rateVal * 100) / 100, updatedAt: Date.now() };
        return cachedRate.rate;
      }
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'No se pudo obtener tasa en vivo de dolarapi, usando fallback');
  }
  return cachedRate.rate || 998;
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
        ? s.insumos.map(i => `${i.qty}x ${i.name}`).join(' + ')
        : (s.defaultInsumoName || 'Insumo taller');
      return `- ${s.serviceName}: $${Number(s.defaultLaborPrice || 0).toFixed(2)} USD (Insumos requeridos: ${insList})`;
    })
    .join('\n');

  const customRules = adminCtx.botConfig?.customAiRules ? `
=== REGLAS DE NEGOCIO DEFINIDAS EN LA WEB ===
${adminCtx.botConfig.customAiRules}
` : '';

  return `Eres "Doom Bot", el Asistente Ejecutivo Inteligente y Asesor de Operaciones Privado de Doomlater.Corp, interactuando en vivo por WhatsApp exclusivamente con uno de los dueños fundadores: ${partnerName} (Anthony = @doom1, Sebastián = @doom2).

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
      `💼 *Resumen Financiero Doomlater.Corp* (${partnerName})`,
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

  // 5. Búsqueda específica de un producto (ej. "3ds", "cargador", etc.)
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
  return `👑 *Hola ${partnerName}!* Asistente de Operaciones de Doomlater.Corp listo.\n\nPuedes decirme o preguntarme por WhatsApp:\n• _"Agrega una transacción al dashboard"_ (puedes dictarme o escribirme título, monto, moneda, descripción y hora)\n• _"¿Cuánto dinero tenemos acumulado ahorita?"_\n• _"¿Cuánto hay en total con la conversión de Bs a USDT?"_\n• _"Pásame el estado de cuenta en PDF"_\n• _"Envíale un mensaje de estados de cuenta a mi socio"_\n• _"¿Cuántos cargadores de 3ds quedan?"_\n• _"¿Qué queda en stock?"_\n• _"¿Qué falta o está por agotarse?"_\n• _"¿Hay pagos por verificar?"_`;
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

  const prompt = `Eres el asistente contable oficial de Doomlater.Corp. Tu misión es extraer los datos necesarios para registrar una transacción directamente en el dashboard financiero de la Web.
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
        signal: AbortSignal.timeout(2500),
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
      reply: `📄 *¡Aquí tienes tu archivo PDF listo!* 🧾\n\nAdjunto el documento oficial de *${pdfAttachment.title}* generado en vivo con los datos actuales de Doomlater.Corp.`,
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

      const partnerMsg = `💼 *ESTADO DE CUENTA - DOOMLATER.CORP*\n` +
        `_Enviado en directo por tu socio @${partnerName}_\n\n` +
        `💰 *GRAN TOTAL CONSOLIDADO:* *$${adminCtx.grandTotalUsdt.toFixed(2)} USDT*\n` +
        `💵 *Divisas Directas:* $${adminCtx.totalUsdDirect.toFixed(2)} USDT\n` +
        `🇻🇪 *Bolívares en Bancos:* Bs. ${adminCtx.totalBs.toFixed(2)} (~$${adminCtx.bsConvertedToUsdt.toFixed(2)} USDT)\n` +
        `📈 *Tasa de cambio:* ${adminCtx.exchangeRate} Bs/USD\n\n` +
        `*Desglose por Cuentas:*\n${walletsSummary}\n\n` +
        `📈 *Ingresos hoy:* +$${adminCtx.todayTotalIncomeEquivUsdt.toFixed(2)} USDT equiv.\n\n` +
        `_Enviado automáticamente vía Doom Bot IA._`;

      const pdfAttachment = wantsPdf ? generateDoomPdf('estado_cuenta', adminCtx, partnerName) : null;
      await sendPartnerDirectMessage(partnerName, targetPartnerName, partnerMsg, pdfAttachment);

      return `✅ *¡Listo ${partnerName}!* Ya le envié el estado de cuenta ${wantsPdf ? 'y el documento PDF ' : ''}por WhatsApp a tu socio @${targetPartnerName} (+${targetPhone}).`;
    }

    // Subcaso B: Enviar inventario / stock
    if (/(?:stock|inventario|catalogo)/i.test(lower)) {
      const stockMsg = `📦 *INVENTARIO GENERAL - DOOMLATER.CORP*\n` +
        `_Enviado en directo por tu socio @${partnerName}_\n\n` +
        `• Productos para la venta: *${adminCtx.sellables.length}*\n` +
        `• Insumos de taller: *${adminCtx.insumos.length}*\n` +
        `• Stock crítico / agotados: *${adminCtx.lowStock.length}*\n\n` +
        `_Enviado automáticamente vía Doom Bot IA._`;

      const pdfAttachment = wantsPdf ? generateDoomPdf('stock', adminCtx, partnerName) : null;
      await sendPartnerDirectMessage(partnerName, targetPartnerName, stockMsg, pdfAttachment);

      return `✅ *¡Listo ${partnerName}!* Ya le envié el inventario ${wantsPdf ? 'y el archivo PDF ' : ''}por WhatsApp a tu socio @${targetPartnerName} (+${targetPhone}).`;
    }

    // Subcaso C: Mensaje directo o recordatorio
    const hasScheduledTime = /(?:a\s*las\s*\d+|en\s*\d+\s*(?:horas?|minutos?)|mañana)/i.test(lower);
    if (!hasScheduledTime) {
      let directText = text
        .replace(/(?:env[ií](?:ale|ar)?|m[aá]nda(?:le|r)?|p[aá]sa(?:le|r)?|escr[ií]be(?:le|r)?|dile|av[ií]sa(?:le|r)?)\s*(?:un)?\s*(?:mensaje|aviso|recordatorio)?\s*(?:a|al)\s*(?:mi\s*socio|sebastian|sebastián|anthony|doom1|doom2)?(?:\s*que|\s*diciendo(?:\s*que)?)?/gi, '')
        .trim();
      if (!directText) directText = 'Atento a los pendientes de Doomlater.Corp';

      const partnerMsg = `🔔 *MENSAJE DE TU SOCIO @${partnerName}:*\n\n"${directText}"\n\n_Enviado en directo vía Doom Bot IA._`;
      await sendPartnerDirectMessage(partnerName, targetPartnerName, partnerMsg);

      return `✅ *Mensaje enviado con éxito a tu socio @${targetPartnerName} (+${targetPhone}):*\n\n👉 "${directText}"`;
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
        signal: AbortSignal.timeout(2800),
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
        sendPartnerDirectMessage(partnerName, target, partnerMsg).catch(e => logger.warn({ err: e.message }, 'Error enviando accion directa'));
        reply = reply.replace(sendMatch[0], '').trim();
      }

      // 2. Generar y enviar PDF al socio
      const pdfSocioMatch = reply.match(/\[ACCION_PDF_SOCIO:\s*([^\|\]]+)\|\s*([^\|\]]+)(?:\|\s*([^\]]*))?\]/i);
      if (pdfSocioMatch) {
        const target = pdfSocioMatch[1].trim();
        const pdfType = pdfSocioMatch[2].trim();
        const note = (pdfSocioMatch[3] || '').trim();
        const pdfAttachment = generateDoomPdf(pdfType, adminCtx, partnerName);
        const caption = note ? `🔔 *REPORTE DE TU SOCIO @${partnerName}:*\n\n${note}` : `🔔 *REPORTE OFICIAL DOOMLATER.CORP*\nEnviado por tu socio @${partnerName}`;
        sendPartnerDirectMessage(partnerName, target, caption, pdfAttachment).catch(e => logger.warn({ err: e.message }, 'Error enviando PDF a socio'));
        reply = reply.replace(pdfSocioMatch[0], '').trim();
      }

      // 3. Generar PDF para el socio que lo solicitó directamente en este chat
      const pdfLocalMatch = reply.match(/\[ACCION_PDF_LOCAL:\s*([^\|\]]+)(?:\|\s*([^\]]*))?\]/i);
      if (pdfLocalMatch) {
        const pdfType = pdfLocalMatch[1].trim();
        localPdf = generateDoomPdf(pdfType, adminCtx, partnerName);
        reply = reply.replace(pdfLocalMatch[0], '').trim();
      }

      return { reply, pdfAttachment: localPdf, isPayment: false, needsHuman: false };
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

  const services = (botConfig.serviceInsumosMap || [])
    .map(s => {
      const insList = (Array.isArray(s.insumos) && s.insumos.length > 0)
        ? s.insumos.map(i => `${i.qty}x ${i.name}`).join(' + ')
        : (s.defaultInsumoName || 'Insumos de taller');
      return `- ${s.serviceName}: Presupuesto $${Number(s.defaultLaborPrice || 0).toFixed(2)} USD (Incluye / Requiere: ${insList})`;
    })
    .join('\n');

  const customRules = botConfig.customAiRules ? `
=== REGLAS Y FILTROS ESTRICTOS DEFINIDOS POR LOS DUEÑOS EN LA WEB ===
${botConfig.customAiRules}
` : '';

  return `Eres el asistente oficial de atención al cliente de Doomlater.Corp.
Nos especializamos en consolas de videojuegos (PlayStation, Nintendo, Xbox), accesorios, videojuegos, servicio técnico y mantenimiento.
Responde siempre en español, con tono amable, cálido, profesional y completo.
REGLA CRÍTICA DE CONCLUSIÓN: NUNCA dejes oraciones, frases o explicaciones a la mitad. Toda respuesta debe estar 100% terminada y concluir con punto final.
No digas que eres una IA salvo que te lo pregunten directamente.
${customRules}
=== INFORMACIÓN Y PREGUNTAS FRECUENTES ===
${faq}

=== MÉTODOS DE PAGO ===
${pm}

=== SERVICIOS TÉCNICOS Y PRESUPUESTOS OFICIALES ===
${services || '(Consulta de presupuestos técnicos con Anthony y Sebastián)'}

=== STOCK DISPONIBLE ACTUAL ===
${stock || '(Catálogo general de consolas, accesorios y servicio técnico bajo consulta de modelo)'}

Instrucciones de respuesta y comportamiento:
1. Saludos o bienvenida: Saluda con entusiasmo y presenta brevemente lo que ofrece Doomlater.Corp (consolas de videojuegos, accesorios y servicio técnico especializado).
2. Métodos de pago (Pestaña 2): Cuando el cliente pregunte por métodos de pago, cómo pagar, datos de transferencias, Pago Móvil o Binance, busca y responde ÚNICAMENTE con la información oficial de la sección "MÉTODOS DE PAGO". Solicita amablemente el comprobante una vez realizado el pago.
3. Preguntas frecuentes (Pestaña 2): Si el cliente formula preguntas sobre envíos, garantías, ubicación física, horarios o tasa de cambio, busca una pregunta idéntica o similar en "INFORMACIÓN Y PREGUNTAS FRECUENTES" y contesta basándote fielmente en su respuesta.
4. Servicios Técnicos e Insumos (Pestaña 3): Cuando un cliente consulte por un servicio técnico específico (ej: "Instalación Magia SOLO OLED", "Magia Lite", "Magia V1/V2", memorias micro SD, mantenimiento o limpieza), responde ÚNICAMENTE con los detalles, presupuesto exacto en USD ($) e insumos que incluye ESE servicio consultado según la sección "SERVICIOS TÉCNICOS Y PRESUPUESTOS OFICIALES". No ofrezcas otros paquetes que no haya pedido a menos que el cliente pregunte abiertamente por todas las opciones disponibles.
5. REGLA ESTRICTA DE PREGUNTAS SIN RESPUESTA O FUERA DE CATÁLOGO: Si ninguna de las Preguntas Frecuentes, Métodos de Pago, Servicios Técnicos ni Productos en Stock contesta de forma precisa la pregunta del cliente: ¡BAJO NINGUNA CIRCUNSTANCIA INVENTES O CONTESTES CUALQUIER COSA AL AZAR! Responde con cortesía y amabilidad: "Con gusto, voy a consultar ese detalle directamente con nuestros técnicos Anthony y Sebastián para darte la respuesta exacta en unos momentos 🙌" y debes finalizar tu mensaje obligatoriamente con la etiqueta [FLAG_REQUIERE_HUMANO]. Esto activará la alerta en la Web (en color amarillo-mostaza) y notificará a los socios por WhatsApp para que ellos respondan manualmente.
6. Reporte de Pago: Si el cliente indica que ya realizó el pago, envía un comprobante, foto, capture o número de referencia: Agradece, indícale que los socios Anthony y Sebastián lo están verificando y finaliza obligatoriamente tu mensaje con [FLAG_PAGO_REPORTADO].
7. Productos en stock: Si el producto está en la lista de stock, informa el precio y disponibilidad. Si preguntan por un modelo o producto específico que no está en la lista de stock, infórmale con amabilidad que no está en existencia o que consultarás con los técnicos y finaliza con [FLAG_REQUIERE_HUMANO].
8. Reglas de Negocio y Descuentos: NUNCA ofrezcas, prometas ni admitas ningún tipo de descuento o rebaja en productos ni servicios bajo ninguna circunstancia. Todos los precios son fijos.
9. Información confidencial: Si preguntan cuánto dinero tiene la empresa, saldos bancarios o márgenes internos, indícales con cortesía que es información confidencial administrativa y ofréceles información de productos o servicios.`;
}

function parseAIResponseFlags(text) {
  let clean = String(text || '');
  const isPayment = clean.includes('[FLAG_PAGO_REPORTADO]');
  const needsHuman = clean.includes('[FLAG_REQUIERE_HUMANO]');
  clean = clean.replace(/\[FLAG_PAGO_REPORTADO\]/g, '').replace(/\[FLAG_REQUIERE_HUMANO\]/g, '').trim();
  return { reply: clean, isPayment, needsHuman };
}

async function queryAI(convId, userMessage, ctx, mediaAttachment = null) {
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
        signal: AbortSignal.timeout(2800),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemPrompt(ctx) }] },
          contents,
          generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
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

function fallbackRuleBasedBot(userMessage, { stockItems = [], paymentMethods = [], knowledgeBaseFaq = [], botConfig = {} }) {
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
  const servicesMap = botConfig.serviceInsumosMap || [];
  for (const s of servicesMap) {
    const sName = String(s.serviceName || '').toLowerCase();
    const cleanSName = sName.replace(/[^a-z0-9]/g, ' ');
    const sWords = cleanSName.split(/\s+/).filter(w => w.length >= 4);
    if (sWords.length > 0 && sWords.filter(w => msg.includes(w)).length >= 2) {
      const insList = (Array.isArray(s.insumos) && s.insumos.length > 0)
        ? s.insumos.map(i => `${i.qty}x ${i.name}`).join(' + ')
        : (s.defaultInsumoName || 'Insumos de taller');
      return {
        reply: `¡Hola! El presupuesto para *${s.serviceName}* es de *$${Number(s.defaultLaborPrice || 0).toFixed(2)} USD* (Incluye: ${insList}). ¿Te gustaría agendar cita o traer tu consola a nuestro local comercial? ✨`,
        isPayment: false,
        needsHuman: false
      };
    }
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
        signal: AbortSignal.timeout(3500),
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
        signal: AbortSignal.timeout(3500),
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
                text: `Analiza esta imagen con precisión quirúrgica. Si es un comprobante de pago, capture de pantalla de Pago Móvil, transferencia bancaria, recibo o comprobante de Binance/USDT:
Extrae los datos exactos del pago y responde ÚNICAMENTE con un JSON válido (sin markdown, solo el objeto JSON):
{
  "isPayment": true,
  "amount": <monto numérico pagado, ej: 40 o 2500.50>,
  "currency": "VED" si son Bolívares o "USD" si son dólares / USDT / Binance,
  "reference": "<número de referencia, confirmación o comprobante>",
  "targetPhoneOrId": "<número de teléfono o cédula/cuenta destino al que se envió el dinero, ej: 04142005801, 32030679, etc.>",
  "paymentDate": "<fecha que aparece impresa en el comprobante en formato YYYY-MM-DD (ej: 2026-11-02), o null si no se distingue>",
  "bank": "<nombre del banco emisor o receptor si figura>"
}
Si la imagen NO es un comprobante de pago o capture de transferencia, responde estrictamente: {"isPayment": false}`
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
        logger.info({ parsed }, 'Comprobante analizado con éxito por Gemini Vision');
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
  let conv, aiCtx, adminCtx;
  if (q.ctx.isPartner) {
    // Para socios cargamos directamente el contexto ejecutivo sin llamadas innecesarias al contexto de clientes
    [conv, adminCtx] = await Promise.all([
      fb('GET', ws(`botConversations/${convId}`)),
      loadAdminExecutiveContext()
    ]);
  } else {
    // Revisa interruptores antes de responder a clientes
    [conv, aiCtx] = await Promise.all([
      fb('GET', ws(`botConversations/${convId}`)),
      loadAiContext()
    ]);
    if (!conv || conv.deleted) return;
    if (aiCtx.botConfig.globalBotEnabled === false || conv.botActive === false) {
      if (q.ctx.platform === 'whatsapp') await waPresence('paused', q.ctx.jid);
      return;
    }
  }

  const userText = q.texts.join('\n').trim();
  const mediaAttachment = q.ctx.imageBuffer ? { buffer: q.ctx.imageBuffer, mimeType: q.ctx.imageMime } : null;

  let result;
  if (q.ctx.isPartner) {
    result = await queryAdminAI(convId, userText || 'hola', adminCtx, q.ctx.partnerName || 'Socio', mediaAttachment);
  } else if (q.ctx.paymentAnalysis && q.ctx.paymentAnalysis.isPayment) {
    const pa = q.ctx.paymentAnalysis;
    const curSymbol = pa.currency === 'VED' ? 'Bs.' : '$';
    const refStr = pa.reference ? ` (Ref: ${pa.reference})` : '';
    result = {
      reply: `¡Muchas gracias! 🧾 Recibimos tu comprobante de pago por ${curSymbol}${pa.amount || ''}${refStr}. Anthony y Sebastián lo están verificando y te confirmamos en breve.`,
      isPayment: true,
      needsHuman: true
    };
  } else if (q.hasImage && !/[a-z]{4,}/i.test(userText) && (!mediaAttachment || !mediaAttachment.buffer)) {
    result = {
      reply: '¡Gracias! 🧾 Recibimos tu imagen/comprobante. Los socios de Doomlater.Corp lo verifican y te confirman en breve.',
      isPayment: true,
      needsHuman: true
    };
  } else {
    result = await queryAI(convId, userText || '(el cliente envió una imagen o archivo)', aiCtx, mediaAttachment);
    if (q.hasImage) { result.isPayment = true; result.needsHuman = true; }
  }

  // Si el cliente indica explícitamente que ya pagó o adjuntó pago por texto
  const paymentTextRegex = /(?:ya\s*(?:hice\s*el\s*pago|realic[eé]\s*el\s*pago|pagu[eé]|transfer[ií]|te\s*pagu[eé]|te\s*transfer[ií]|cancel[eé]|le\s*di)|pago\s*(?:listo|realizado|hecho|enviado)|listo\s*(?:amigo\s*)?(?:ya\s*)?(?:pagu[eé]|transfer[ií])|acabo\s*de\s*(?:pagar|transferir)|comprobante\s*(?:de\s*pago)?|capture\s*(?:del?\s*pago)?)/i;
  if (!q.ctx.isPartner && paymentTextRegex.test(userText)) {
    result.isPayment = true;
    result.needsHuman = true;
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
          if (result.pdfAttachment && result.pdfAttachment.buffer) {
            await waSend(targetJid, {
              document: result.pdfAttachment.buffer,
              mimetype: 'application/pdf',
              fileName: result.pdfAttachment.fileName || 'Reporte_Doomlater.pdf',
              caption: result.reply
            });
          } else {
            await waSend(targetJid, { text: result.reply });
          }
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
  if (!q.ctx.isPartner) {
    if (result.isPayment) {
      const pa = q.ctx.paymentAnalysis;
      const refStr = pa && pa.reference ? `\n*Referencia:* ${pa.reference}` : (conv.pendingPaymentRef ? `\n*Referencia:* ${conv.pendingPaymentRef}` : '');
      const phoneStr = pa && pa.targetPhoneOrId ? `\n*Destino:* ${pa.targetPhoneOrId} (${q.ctx.destWalletName || 'Cuenta'})` : '';
      const dateStr = pa && pa.paymentDate ? `\n*Fecha Comprobante:* ${pa.paymentDate}` : '';
      const amtStr = pa && pa.amount ? `${pa.currency === 'VED' ? 'Bs.' : '$'} ${pa.amount}` : (conv.pendingPaymentAmount ? `$${Number(conv.pendingPaymentAmount).toFixed(2)}` : 'Por verificar');

      const alertMsg = `🔔 *DOOMLATER ALERT: Pago por Verificar* 🧾\n\n` +
        `Cliente: *${conv.customerName || 'Cliente'}* (${conv.customerPhone || 'WhatsApp'})\n` +
        `Monto: *${amtStr}*${refStr}${phoneStr}${dateStr}\n\n` +
        `👉 _Entra a la Web para verificarlo y sumarlo a caja con un clic._`;
      notifyPartners(alertMsg, `pay_${convId}`).catch(() => {});
    } else if (result.needsHuman) {
      const alertMsg = `⚠️ *DOOMLATER ALERT: Atención Requerida*\n\n` +
        `Cliente: *${conv.customerName || 'Cliente'}* (${conv.customerPhone || 'WhatsApp'})\n` +
        `Mensaje: "${userText.slice(0, 100)}"\n\n` +
        `👉 _Se requiere la intervención de un socio en el chat._`;
      notifyPartners(alertMsg, `human_${convId}`).catch(() => {});
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
  let caption = waTextOf(content);
  const label = WA_LABELS[ctype] || '';
  let text = caption ? (label && ctype !== 'extendedTextMessage' && ctype !== 'conversation' ? `${label}: ${caption}` : caption) : (label || '[Mensaje]');
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
            const targetDigits = String(paymentAnalysis.targetPhoneOrId || '').replace(/\D/g, '');
            if (targetDigits.includes('32030679') || targetDigits.includes('4264181643') || String(paymentAnalysis.targetPhoneOrId || '').toLowerCase().includes('sebasti')) {
              destWalletId = 'w_bs_socio';
              destWalletName = 'Cuenta en Bs de Sebastián (@doom2)';
            } else if (targetDigits.includes('04142005801') || targetDigits.includes('4142005801') || String(paymentAnalysis.targetPhoneOrId || '').toLowerCase().includes('anthony')) {
              destWalletId = 'w_bs_anthony';
              destWalletName = 'Cuenta en Bs de Anthony (@doom1)';
            } else if (paymentAnalysis.currency === 'USD') {
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

  logger.info({ convId, pushName, text }, 'WhatsApp entrante');
  pushHistory(convId, 'user', caption || label);

  const incomingBase = {
    platform: 'whatsapp',
    platformAccount: 'shared',
    customerName: pushName || (phone ? `+${phone}` : 'Cliente WhatsApp'),
    genericName: !pushName,
    customerPhone: phone ? `+${phone}` : '',
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
    incomingBase.attentionReason = `Comprobante detectado: Ref ${paymentAnalysis.reference || 'S/N'} de ${paymentAnalysis.currency === 'VED' ? 'Bs.' : '$'} ${paymentAnalysis.amount} al número ${paymentAnalysis.targetPhoneOrId || 'N/A'}`;
  }

  const conv = await recordIncoming({
    convId,
    base: incomingBase,
    msg: { id: msgId, text, sentBy: pushName || 'Cliente', createdAt: tsMs, platform: 'whatsapp', ...(mediaKey ? { mediaKey, mediaType: ctype === 'audioMessage' ? 'audio' : 'image' } : {}) },
    label: `💬 ${pushName || phone || 'Cliente'} (WhatsApp): ${text.slice(0, 60)}`
  });

  const partner = isAuthorizedPartner(jid) || isAuthorizedPartner(phone) || (convId === 'conv_wa_584142005801' ? PARTNER_ACCOUNTS[0] : null);
  if (botConfig.globalBotEnabled !== false && conv.botActive !== false) {
    if (botConfig.showTypingIndicator !== false) await waPresence('composing', jid);
    scheduleAiReply(convId, caption, {
      platform: 'whatsapp',
      jid,
      phone,
      hasImage: Boolean(mediaKey) || ctype === 'imageMessage',
      imageBuffer: downloadedImageBuffer,
      imageMime: downloadedImageMime,
      paymentAnalysis: paymentAnalysis && paymentAnalysis.isPayment ? paymentAnalysis : null,
      destWalletId,
      destWalletName,
      delayMs: partner ? 150 : typingDelayMs(botConfig),
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
   MONITOR PROACTIVO DE CHATS EN ALERTA (WEB Y BOT)
   -------------------------------------------------------------------------- */
const alertedConvsTrack = new Set();

async function checkAttentionAlertsAndNotify() {
  if (!waSock || waState !== 'connected') return;
  try {
    const convsRaw = await fb('GET', ws('botConversations'));
    if (!convsRaw) return;
    const convs = Object.values(convsRaw).filter(c => c && !c.deleted);

    for (const c of convs) {
      if (c.needsAttention || c.pendingPayment) {
        // Excluir chats directos entre socios a menos que sea una simulación
        const isPartnerPhone = c.customerPhone === '584142005801' || c.customerPhone === '584264181643';
        if (isPartnerPhone && !String(c.attentionReason || '').includes('Simulación')) continue;

        const trackKey = `${c.id}_${Boolean(c.needsAttention)}_${Boolean(c.pendingPayment)}_${c.lastMessageAt || c.updatedAt || 0}`;
        if (alertedConvsTrack.has(trackKey)) continue;
        alertedConvsTrack.add(trackKey);

        const isPayment = Boolean(c.pendingPayment);
        const alertTag = isPayment ? '💳 Pago por Verificar' : '⚠️ Atención Requerida (Chat en Alerta)';
        const custName = c.customerName || 'Cliente';
        const custPhone = c.customerPhone ? ` (+${c.customerPhone})` : '';
        const amtStr = isPayment && c.pendingPaymentAmount ? `\n• *Monto:* $${Number(c.pendingPaymentAmount).toFixed(2)}` : '';
        const reason = c.attentionReason ? `\n• *Motivo:* ${c.attentionReason}` : '';
        const lastMsg = c.lastMessage ? `\n• *Último mensaje:* "${String(c.lastMessage).slice(0, 80)}"` : '';

        const alertMsg = `🔔 *DOOMLATER ALERT: ${alertTag}* 🌐\n\n` +
          `• *Cliente:* *${custName}*${custPhone}\n` +
          `• *Plataforma:* ${c.platform || 'WhatsApp'}${amtStr}${reason}${lastMsg}\n\n` +
          `👉 _El chat está marcado con **Alerta** en la Web. Entra a "Bot & Inbox" para responder o verificar._`;

        await notifyPartners(alertMsg, `alert_${c.id}`);
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

  setInterval(() => heartbeat().catch(() => {}), 15000);
  setInterval(() => pollCommands().catch(() => {}), 3000);
  setInterval(() => processOutbox().catch(() => {}), 3000);
  setInterval(() => backupAuthNow().catch(() => {}), 30000);
  setInterval(() => checkLowStockAndAlert().catch(() => {}), 5 * 60 * 1000);
  setInterval(() => checkPartnerReminders().catch(() => {}), 20000);
  setInterval(() => checkAttentionAlertsAndNotify().catch(() => {}), 5000);

  // Render (plan gratis) se duerme tras 15 min sin tráfico: nos auto-visitamos cada 10 min.
  if (RENDER_URL) {
    setInterval(() => fetch(`${RENDER_URL}/healthz`).catch(() => {}), 10 * 60 * 1000);
  }
});
