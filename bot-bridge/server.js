/**
 * ============================================================================
 * DOOMLATER.CORP - 24/7 CLOUD BOT BRIDGE
 * Multiplatform Omnichannel Assistant: WhatsApp (Baileys QR), Instagram DM,
 * and Facebook Messenger with Gemini 2.0 Flash AI & Firebase Realtime Database.
 * ============================================================================
 */

import express from 'express';
import dotenv from 'dotenv';
import qrcode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

// Baileys WhatsApp Web Multi-Device SDK
import makeWASocketImport, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const makeWASocket = makeWASocketImport.default || makeWASocketImport;

dotenv.config();

const PORT = process.env.PORT || 3000;
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || 'https://ok-gogle-c018c-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const WORKSPACE_PATH = 'cashew_doom_v1';
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'doomlater_meta_secret_2026';
const GEMINI_API_KEY_ENV = process.env.GEMINI_API_KEY || '';

const logger = pino({ level: 'info' });
const app = express();
app.use(express.json());

/* --------------------------------------------------------------------------
   FIREBASE REALTIME DATABASE REST API CLIENT
   -------------------------------------------------------------------------- */
async function fbGet(subPath = '') {
  try {
    const url = `${FIREBASE_DB_URL}/${WORKSPACE_PATH}/${subPath}.json`.replace(/([^:]\/)\/+/g, '$1');
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    logger.error({ err: err.message }, 'Firebase GET error');
    return null;
  }
}

async function fbPatch(subPath = '', data = {}) {
  try {
    const url = `${FIREBASE_DB_URL}/${WORKSPACE_PATH}/${subPath}.json`.replace(/([^:]\/)\/+/g, '$1');
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await res.json();
  } catch (err) {
    logger.error({ err: err.message }, 'Firebase PATCH error');
    return null;
  }
}

async function fbPut(subPath = '', data = {}) {
  try {
    const url = `${FIREBASE_DB_URL}/${WORKSPACE_PATH}/${subPath}.json`.replace(/([^:]\/)\/+/g, '$1');
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await res.json();
  } catch (err) {
    logger.error({ err: err.message }, 'Firebase PUT error');
    return null;
  }
}

/* --------------------------------------------------------------------------
   GOOGLE GEMINI 2.0 FLASH AI ENGINE (100% FREE TIER)
   -------------------------------------------------------------------------- */
async function queryGeminiAI(userMessage, contextData, apiKeyOverride = '') {
  const apiKey = apiKeyOverride || GEMINI_API_KEY_ENV;
  if (!apiKey) {
    logger.warn('No Gemini API Key provided. Using intelligent fallback.');
    return fallbackRuleBasedBot(userMessage, contextData);
  }

  const { stockItems = [], paymentMethods = [], knowledgeBaseFaq = [] } = contextData;

  const stockSummary = stockItems
    .filter(i => !i.deleted && (i.kind === 'para_vender' || i.kind === 'insumo'))
    .map(i => `- ${i.name} (${i.kind === 'insumo' ? 'Insumo/Repuesto' : 'Producto'}): Stock ${i.stock} un. | Precio: $${Number(i.salePrice || i.purchaseCost || 0).toFixed(2)} | Detalle: ${i.extraDetail || i.notes || ''}`)
    .join('\n');

  const faqSummary = knowledgeBaseFaq
    .map(f => `P: ${f.question}\nR: ${f.answer}`)
    .join('\n\n');

  const pmSummary = paymentMethods
    .map(p => `• ${p.name}: ${p.details}`)
    .join('\n');

  const systemPrompt = `
Eres el Asistente Oficial de Atención al Cliente de Doomlater.Corp (especialistas en consolas, videojuegos, accesorios y servicio técnico de micro-electrónica).
Tu objetivo es atender a los clientes de forma amable, humana, rápida y profesional.

REGLAS ESTRICTAS DE RESPUESTA:
1. Responde de forma concisa, cálida y directa en español venezolano o neutro.
2. Usa información EXCLUSIVAMENTE de este catálogo y base de datos:

=== CATÁLOGO DE STOCK EN TIEMPO REAL ===
${stockSummary || '(No hay ítems en stock actualmente)'}

=== BASE DE CONOCIMIENTO (FAQ) ===
${faqSummary || '(Consultar horario y envíos)'}

=== MÉTODOS DE PAGO OFICIALES ===
${pmSummary || 'Pago Móvil, Binance Pay USDT y Efectivo en Divisas.'}

3. Si el cliente pregunta cómo pagar, proporciona los métodos de pago oficiales y recuérdale que envíe el capture/comprobante por acá.
4. Si el cliente dice que ya pagó o envía un capture: agradécele e indícale que el comprobante fue recibido y que los socios doom1 / doom2 lo verificarán en breves instantes. Incluye la etiqueta especial [FLAG_PAGO_REPORTADO].
5. Si el cliente pregunta por un producto o servicio que NO está en el catálogo ni en el FAQ, indícale amablemente que consultarás con el equipo técnico para confirmarle disponibilidad exacta en breves instantes. Incluye la etiqueta especial [FLAG_REQUIERE_HUMANO].
6. NUNCA inventes precios, números de teléfono o productos que no figuren en los datos provistos.
`;

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: systemPrompt },
            { text: `Mensaje del cliente: "${userMessage}"` }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 300
      }
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errTxt = await res.text();
      logger.error({ status: res.status, errTxt }, 'Gemini API call failed');
      return fallbackRuleBasedBot(userMessage, contextData);
    }

    const data = await res.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return parseAIResponseFlags(reply);
  } catch (err) {
    logger.error({ err: err.message }, 'Gemini execution error');
    return fallbackRuleBasedBot(userMessage, contextData);
  }
}

function parseAIResponseFlags(text) {
  let isPayment = false;
  let needsHuman = false;
  let cleanText = text;

  if (cleanText.includes('[FLAG_PAGO_REPORTADO]')) {
    isPayment = true;
    cleanText = cleanText.replace(/\[FLAG_PAGO_REPORTADO\]/g, '').trim();
  }
  if (cleanText.includes('[FLAG_REQUIERE_HUMANO]')) {
    needsHuman = true;
    cleanText = cleanText.replace(/\[FLAG_REQUIERE_HUMANO\]/g, '').trim();
  }

  return {
    reply: cleanText,
    isPayment,
    needsHuman
  };
}

/* Fallback rule-based engine when API key is not yet configured */
function fallbackRuleBasedBot(userMessage, contextData) {
  const msg = (userMessage || '').toLowerCase();
  const { stockItems = [], paymentMethods = [], knowledgeBaseFaq = [] } = contextData;

  // 1. Payment detection
  if (msg.includes('ya pague') || msg.includes('ya pagué') || msg.includes('transferí') || msg.includes('transferi') || msg.includes('comprobante') || msg.includes('capture')) {
    return {
      reply: '¡Muchísimas gracias por tu pago! 🧾 Tu comprobante ha sido recibido exitosamente. Los socios de Doomlater.Corp están verificando la acreditación en este momento para confirmarte de inmediato. ¡Un momento por favor!',
      isPayment: true,
      needsHuman: true
    };
  }

  // 2. Payment methods inquiry
  if (msg.includes('metodo') || msg.includes('método') || msg.includes('como pagar') || msg.includes('cómo pagar') || msg.includes('datos') || msg.includes('cuenta') || msg.includes('pago movil') || msg.includes('binance')) {
    const pmText = paymentMethods.map(p => `• *${p.name}*: ${p.details}`).join('\n\n');
    return {
      reply: `¡Hola! Con gusto. Nuestros métodos de pago oficiales en Doomlater.Corp son:\n\n${pmText || '• Binance Pay USDT\n• Pago Móvil / Banco\n• Efectivo Divisas'}\n\nPor favor envíanos tu comprobante por aquí una vez realizada la transferencia para procesar tu orden.`,
      isPayment: false,
      needsHuman: false
    };
  }

  // 3. FAQ search
  for (const f of knowledgeBaseFaq) {
    const qWords = f.question.toLowerCase().split(' ').filter(w => w.length > 3);
    const matches = qWords.filter(w => msg.includes(w)).length;
    if (matches >= 2 || msg.includes(f.question.toLowerCase())) {
      return {
        reply: f.answer,
        isPayment: false,
        needsHuman: false
      };
    }
  }

  // 4. Stock search
  const foundItem = stockItems.find(i => !i.deleted && msg.includes(i.name.toLowerCase()));
  if (foundItem) {
    const price = Number(foundItem.salePrice || foundItem.purchaseCost || 0).toFixed(2);
    return {
      reply: `¡Hola! Sí, tenemos disponible *${foundItem.name}* en stock. Cuenta con ${foundItem.stock} unidad(es) disponibles a un precio de *$${price}*. ¿Deseas coordinar entrega o método de pago?`,
      isPayment: false,
      needsHuman: false
    };
  }

  // 5. Default escalation to human partner
  return {
    reply: '¡Hola! He recibido tu consulta con éxito. Para darte una respuesta exacta con todos los detalles de stock y taller, le he notificado a nuestro equipo. En breves minutos te responderemos directamente por acá. ¡Muchas gracias por tu paciencia!',
    isPayment: false,
    needsHuman: true
  };
}

/* --------------------------------------------------------------------------
   WHATSAPP BAILEYS CLIENT (MULTI-DEVICE QR CODE)
   -------------------------------------------------------------------------- */
let waSock = null;
const authFolder = path.resolve('baileys_auth');

async function startWhatsAppBot() {
  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  waSock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['Doomlater Corp Cloud', 'Chrome', '1.0.0']
  });

  waSock.ev.on('creds.update', saveCreds);

  waSock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('Nuevo código QR de WhatsApp generado');
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        await fbPatch('meta/botConfig', {
          whatsappQr: qrDataUrl,
          whatsappConnected: false
        });
      } catch (err) {
        logger.error({ err: err.message }, 'Error saving QR to Firebase');
      }
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      logger.warn({ shouldReconnect }, 'Conexión de WhatsApp cerrada');
      await fbPatch('meta/botConfig', { whatsappConnected: false });
      if (shouldReconnect) {
        setTimeout(startWhatsAppBot, 5000);
      }
    } else if (connection === 'open') {
      logger.info('¡WhatsApp conectado con éxito a Doomlater.Corp!');
      await fbPatch('meta/botConfig', {
        whatsappConnected: true,
        whatsappQr: null
      });
    }
  });

  // Incoming WhatsApp message handler
  waSock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages?.[0];
    if (!msg || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

    const jid = msg.key.remoteJid;
    const phone = jid.replace('@s.whatsapp.net', '');
    const pushName = msg.pushName || `Cliente ${phone.slice(-4)}`;

    const text = msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      (msg.message?.imageMessage ? '[Imagen enviada]' : '');

    logger.info({ phone, pushName, text }, 'Mensaje de WhatsApp entrante recibido');

    // 1. Fetch current workspace data from Firebase
    const workspace = await fbGet('') || {};
    const meta = workspace.meta || {};
    const botConfig = meta.botConfig || {};
    const stockItems = workspace.stockItems ? Object.values(workspace.stockItems) : [];
    const paymentMethods = botConfig.paymentMethods || [];
    const knowledgeBaseFaq = botConfig.knowledgeBaseFaq || [];

    const delaySec = Number(botConfig.typingDelaySec) || 3.5;
    const showTyping = botConfig.showTypingIndicator !== false;

    // 2. Register/update conversation in Firebase
    const convId = `conv_wa_${phone}`;
    const now = Date.now();

    const existingConv = workspace.botConversations?.[convId] || {
      id: convId,
      platform: 'whatsapp',
      platformAccount: 'shared',
      customerName: pushName,
      customerPhone: `+${phone}`,
      customerAvatar: '',
      unreadCount: 0,
      needsAttention: false,
      botActive: true,
      createdAt: now
    };

    const newInMsg = {
      id: `bmsg_wa_in_${now}`,
      convId,
      direction: 'in',
      text: text || '[Archivo multimedia]',
      sentBy: pushName,
      createdAt: now
    };

    await fbPut(`botMessages/${newInMsg.id}`, newInMsg);

    // 3. If bot is active for this chat, process AI reply
    if (existingConv.botActive !== false) {
      if (showTyping) {
        try {
          await waSock.sendPresenceUpdate('composing', jid);
        } catch (e) {}
      }

      // Realistic delay of 3 to 4 seconds
      await new Promise(r => setTimeout(r, delaySec * 1000));

      const aiResult = await queryGeminiAI(text, {
        stockItems,
        paymentMethods,
        knowledgeBaseFaq
      }, botConfig.geminiApiKey);

      if (showTyping) {
        try {
          await waSock.sendPresenceUpdate('paused', jid);
        } catch (e) {}
      }

      // Send response via WhatsApp
      await waSock.sendMessage(jid, { text: aiResult.reply });

      const newOutMsg = {
        id: `bmsg_wa_out_${Date.now()}`,
        convId,
        direction: 'out',
        text: aiResult.reply,
        sentBy: 'bot',
        createdAt: Date.now()
      };
      await fbPut(`botMessages/${newOutMsg.id}`, newOutMsg);

      // Update conversation with attention status if required
      const updatedConv = {
        ...existingConv,
        lastMessage: aiResult.reply,
        lastMessageAt: Date.now(),
        needsAttention: Boolean(aiResult.isPayment || aiResult.needsHuman || existingConv.needsAttention),
        pendingPayment: Boolean(aiResult.isPayment || existingConv.pendingPayment),
        attentionReason: aiResult.isPayment
          ? 'El cliente reportó un pago. Requiere verificación de la cuenta bancaria/Binance.'
          : (aiResult.needsHuman ? 'Consulta fuera del catálogo o caso especial.' : existingConv.attentionReason || ''),
        updatedAt: Date.now()
      };

      await fbPut(`botConversations/${convId}`, updatedConv);
    } else {
      // Manual mode: just update conversation preview
      await fbPut(`botConversations/${convId}`, {
        ...existingConv,
        lastMessage: text,
        lastMessageAt: now,
        unreadCount: (existingConv.unreadCount || 0) + 1,
        updatedAt: now
      });
    }
  });
}

/* --------------------------------------------------------------------------
   META WEBHOOK (INSTAGRAM DM & FACEBOOK MESSENGER)
   -------------------------------------------------------------------------- */
app.get('/webhook/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    logger.info('Meta Webhook verificado con éxito');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook/meta', async (req, res) => {
  const body = req.body;

  if (body.object === 'page' || body.object === 'instagram') {
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry || []) {
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        if (!event.message || event.message.is_echo) continue;

        const senderId = event.sender.id;
        const text = event.message.text || '';
        const isInstagram = body.object === 'instagram';
        const isMessenger = body.object === 'page';

        logger.info({ isInstagram, isMessenger, senderId, text }, 'Evento Meta recibido');

        const workspace = await fbGet('') || {};
        const meta = workspace.meta || {};
        const botConfig = meta.botConfig || {};
        const now = Date.now();

        if (isMessenger) {
          /* ================================================================
             FACEBOOK MESSENGER EXCLUSIVE RULE:
             Sends strictly ONE single redirect message to WhatsApp!
             ================================================================ */
          const convId = `conv_fb_${senderId}`;
          const existingConv = workspace.botConversations?.[convId];

          if (!existingConv || !existingConv.messengerRedirectSent) {
            const redirectText = botConfig.messengerRedirectMessage ||
              '¡Hola! Gracias por contactarnos en Doomlater.Corp 📱. Para brindarte atención inmediata con stock en tiempo real y coordinar envíos o entregas, por favor escríbenos directamente a nuestro WhatsApp oficial: +58 412 0000000 o toca este enlace: https://wa.me/584120000000 ¡Te atenderemos de inmediato!';

            // Determine if assigned to doom1 or doom2
            const assignedAccount = (existingConv && existingConv.platformAccount) || 'doom1';

            const newConv = {
              id: convId,
              platform: 'messenger',
              platformAccount: assignedAccount,
              profileId: assignedAccount === 'doom2' ? 'profile_2' : 'profile_1',
              customerName: `Cliente Facebook (${senderId.slice(-4)})`,
              customerAvatar: '',
              lastMessage: redirectText,
              lastMessageAt: now,
              unreadCount: 0,
              needsAttention: false,
              messengerRedirectSent: true,
              botActive: true,
              createdAt: now,
              updatedAt: now
            };

            await fbPut(`botConversations/${convId}`, newConv);
            await fbPut(`botMessages/bmsg_fb_in_${now}`, {
              id: `bmsg_fb_in_${now}`,
              convId,
              direction: 'in',
              text,
              sentBy: newConv.customerName,
              createdAt: now
            });
            await fbPut(`botMessages/bmsg_fb_out_${now + 100}`, {
              id: `bmsg_fb_out_${now + 100}`,
              convId,
              direction: 'out',
              text: redirectText,
              sentBy: 'bot',
              createdAt: now + 100
            });

            logger.info({ senderId }, 'Mensaje de redirección única de Messenger enviado a WhatsApp');
          }
        } else if (isInstagram) {
          /* Instagram Direct Message (Shared between doom1 and doom2) */
          const convId = `conv_ig_${senderId}`;
          const existingConv = workspace.botConversations?.[convId] || {
            id: convId,
            platform: 'instagram',
            platformAccount: 'shared',
            customerName: `Usuario Instagram (@${senderId.slice(-4)})`,
            customerAvatar: '',
            unreadCount: 0,
            needsAttention: false,
            botActive: true,
            createdAt: now
          };

          const delaySec = Number(botConfig.typingDelaySec) || 3.5;
          await new Promise(r => setTimeout(r, delaySec * 1000));

          const aiResult = await queryGeminiAI(text, {
            stockItems: workspace.stockItems ? Object.values(workspace.stockItems) : [],
            paymentMethods: botConfig.paymentMethods || [],
            knowledgeBaseFaq: botConfig.knowledgeBaseFaq || []
          }, botConfig.geminiApiKey);

          await fbPut(`botConversations/${convId}`, {
            ...existingConv,
            lastMessage: aiResult.reply,
            lastMessageAt: Date.now(),
            needsAttention: Boolean(aiResult.isPayment || aiResult.needsHuman || existingConv.needsAttention),
            pendingPayment: Boolean(aiResult.isPayment || existingConv.pendingPayment),
            updatedAt: Date.now()
          });
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});

/* --------------------------------------------------------------------------
   OUTGOING REPLIES RELAY (From Web App to WhatsApp)
   -------------------------------------------------------------------------- */
setInterval(async () => {
  if (!waSock) return;
  try {
    const pendingMsgs = await fbGet('botMessagesPendingOut');
    if (pendingMsgs) {
      for (const [key, msg] of Object.entries(pendingMsgs)) {
        if (msg && msg.phone && msg.text) {
          const jid = `${msg.phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
          await waSock.sendMessage(jid, { text: msg.text });
          await fbPatch(`botMessagesPendingOut/${key}`, null);
          logger.info({ jid, text: msg.text }, 'Mensaje manual de operador enviado por WhatsApp');
        }
      }
    }
  } catch (err) {
    // Ignore polling tick errors
  }
}, 4000);

/* --------------------------------------------------------------------------
   HEALTHCHECK & SERVER START
   -------------------------------------------------------------------------- */
app.get('/', (_req, res) => {
  res.json({
    status: 'online',
    app: 'Doomlater.Corp 24/7 Cloud Bot Bridge',
    time: new Date().toISOString(),
    endpoints: {
      metaWebhook: '/webhook/meta',
      health: '/healthz'
    }
  });
});

app.get('/healthz', (_req, res) => res.send('OK'));

app.listen(PORT, () => {
  logger.info(`Servidor Bot Bridge ejecutándose en el puerto ${PORT}`);
  startWhatsAppBot().catch(err => logger.error({ err }, 'Error iniciando WhatsApp Baileys'));
});
