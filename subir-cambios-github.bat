@echo off
title Subir Cambios a GitHub (Doomlater Bot)
cd /d "%~dp0"
echo ========================================================
echo   DOOMLATER.CORP - SUBIR ACTUALIZACION A GITHUB
echo ========================================================
echo.
set "PATH=C:\Users\Usuario\mingit\cmd;%PATH%"
git add bot-bridge/server.js bot-bridge/package.json bot-bridge/Dockerfile bot-bridge/Procfile bot-bridge/render.yaml js/ css/ index.html .gitignore
git commit -m "Actualizar bot bridge: pairing code WhatsApp, webhooks Meta Business Suite y toggle IA"
git push origin main
echo.
echo ========================================================
echo  Completado! Render desplegara la actualizacion en la nube.
echo ========================================================
pause
