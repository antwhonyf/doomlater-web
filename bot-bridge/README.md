# 🤖 Doomlater.Corp - Servidor Cloud 24/7 (Bot Multicanal WhatsApp, Instagram & Messenger)

Este microservicio se encarga de mantener conectado tu **Bot de Inteligencia Artificial** las 24 horas del día, los 365 días del año en la nube de forma **100% gratuita** ($0 costo), sin necesidad de tener tu computadora encendida.

---

## 🚀 Despliegue en 3 Minutos en Render (100% Gratuito)

Render ofrece **750 horas al mes gratuitas** en su plan Free, lo que cubre las 24 horas de cada mes.

### Paso 1: Subir a GitHub
1. Si no lo has hecho, sube la carpeta `doomlater/web` (o sólo la subcarpeta `bot-bridge`) a un repositorio en tu GitHub (puede ser privado o público).

### Paso 2: Crear el servicio en Render
1. Ve a [Render.com](https://render.com) e inicia sesión con tu cuenta de GitHub.
2. Haz clic en **New +** y selecciona **Web Service**.
3. Selecciona tu repositorio de GitHub.
4. En la configuración:
   - **Name**: `doomlater-bot`
   - **Region**: Oregon (US West) o Frankfurt
   - **Branch**: `main`
   - **Root Directory**: `bot-bridge` (o déjalo en blanco si subiste solo la carpeta del bot)
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: **Free** ($0 / month)
5. En la sección **Environment Variables** (Variables de entorno), agrega:
   - `FIREBASE_DB_URL`: `https://ok-gogle-c018c-default-rtdb.firebaseio.com`
   - `META_VERIFY_TOKEN`: `doomlater_meta_secret_2026`
   - `GEMINI_API_KEY`: *(Tu clave gratuita de [Google AI Studio](https://aistudio.google.com/app/apikey))*
6. Haz clic en **Create Web Service**.

¡Listo! En menos de 2 minutos Render compilará el servidor y te dará una URL pública tipo `https://doomlater-bot.onrender.com`.

---

## 📱 Cómo Vincular WhatsApp

1. Abre tu panel de control de Doomlater.Corp en tu navegador o teléfono.
2. Entra a la pestaña **Bot & Inbox** > **Conectar Canales**.
3. Verás el **Código QR** generado automáticamente por Baileys.
4. Abre WhatsApp en tu teléfono > **Dispositivos vinculados** > **Vincular un dispositivo** y escanea la pantalla.
5. ¡Listo! El bot estará conectado 24/7 atendiendo clientes y respondiendo con tu stock real y métodos de pago.

---

## 💬 Cómo Funciona Cada Red Social

| Red Social | Tipo de Conexión | Compartido / Privado | Comportamiento del Bot |
| :--- | :--- | :--- | :--- |
| **WhatsApp** | Código QR (Baileys) | **Compartido** (`doom1` y `doom2`) | Responde dudas con stock real, FAQ y métodos de pago en 3.5s simulando tipeo humano. Si reportan pago, activa alerta mostaza para verificarlo. |
| **Instagram** | Webhook Meta | **Compartido** (`doom1` y `doom2`) | Responde DMs con stock real e IA Gemini. |
| **Messenger** | Credenciales separadas | **Privado** por perfil (`doom1` ve su FB, `doom2` ve su FB) | **Envía un único mensaje exclusivo** con tu número y enlace de redirección a WhatsApp para concentrar las ventas allí. |

---

## 🛠️ Ejecución Local (Opcional para pruebas)

Si deseas probar el bot en tu propia máquina antes de subirlo a la nube:

```bash
cd bot-bridge
npm install
npm start
```
