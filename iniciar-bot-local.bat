@echo off
title Doomlater.Corp - Bot Bridge Multicanal Local
cd /d "%~dp0bot-bridge"
echo =====================================================================
echo       DOOMLATER.CORP - BOT BRIDGE MULTICANAL LOCAL (WHATSAPP + IA)
echo =====================================================================
echo.
echo NOTA: Tu bot ya se encuentra desplegado y activo 24/7 en Render Cloud.
echo Solo ejecuta esta ventana local si deseas realizar pruebas en tu PC o
echo vincular un nuevo dispositivo si la nube esta detenida.
echo.
echo Conectando con Firebase Realtime Database y WhatsApp...
echo.
node server.js
pause
