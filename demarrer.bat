@echo off
chcp 65001 >nul
title Site vers Figma - assistant de demarrage
cd /d "%~dp0"

rem Les blocs entre parentheses de cmd.exe sont fragiles des qu'ils
rem contiennent de la ponctuation. On passe par des etiquettes : c'est
rem verbeux, mais cela ne casse jamais.

where node >nul 2>nul
if errorlevel 1 goto pas_de_node

node "outils\demarrer.mjs" %*
goto fin

:pas_de_node
echo.
echo   Node.js n'est pas installe sur cet ordinateur.
echo.
echo   C'est le seul logiciel a installer. Il est gratuit et officiel.
echo.
echo     1. la page de telechargement va s'ouvrir
echo     2. choisissez le gros bouton LTS, la version stable
echo     3. installez en laissant toutes les options par defaut
echo     4. FERMEZ cette fenetre, puis relancez demarrer.bat
echo.
pause
start "" https://nodejs.org/fr
goto fin

:fin
echo.
echo   -- Fenetre terminee. Appuyez sur une touche pour fermer. --
pause >nul
