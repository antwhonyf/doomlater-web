@echo off
chcp 65001 >nul
title Doomlater.Corp - Bot Activo en PC (WhatsApp + Telegram + IA)
cd /d "%~dp0bot-bridge"
echo =====================================================================
echo     DOOMLATER.CORP - MOTOR DEL BOT ACTIVO EN TU PC (MODO LOCAL)
echo =====================================================================
echo.
echo  - WhatsApp + IA Gemini + Alertas Telegram (@Doomlater_Alertas_bot)
echo  - Puedes minimizar esta ventana y seguir usando tu PC normalmente.
echo  - NO cierres esta ventana mientras quieras que el bot responda.
echo.
:loop
echo [%date% %time%] Conectando con Firebase, WhatsApp y Telegram...
node server.js
echo.
echo [AVISO] El proceso se detuvo. Reiniciando automaticamente en 5 segundos...
timeout /t 5 /nobreak >nul
goto loop
