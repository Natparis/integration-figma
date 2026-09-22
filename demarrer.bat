@echo off
chcp 65001 >nul
title Site vers Figma - assistant de demarrage
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js n'est pas installe sur cet ordinateur.
  echo.
  echo   C'est le seul logiciel a installer. Il est gratuit et officiel.
  echo.
  echo   1. la page de telechargement va s'ouvrir
  echo   2. choisissez le bouton "LTS" ^(la version stable^)
  echo   3. installez en laissant toutes les options par defaut
  echo   4. FERMEZ cette fenetre, puis relancez demarrer.bat
  echo.
  pause
  start https://nodejs.org/fr
  exit /b 1
)

node "outils\demarrer.mjs"
echo.
echo   ── Fenetre terminee. Appuyez sur une touche pour fermer. ──
pause >nul
