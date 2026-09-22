#!/bin/bash
# Assistant de demarrage pour macOS : double-cliquez ce fichier.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js n'est pas installe sur cet ordinateur."
  echo
  echo "  C'est le seul logiciel a installer. Il est gratuit et officiel."
  echo
  echo "  1. la page de telechargement va s'ouvrir"
  echo "  2. choisissez le bouton « LTS » (la version stable)"
  echo "  3. installez en laissant toutes les options par defaut"
  echo "  4. FERMEZ cette fenetre, puis relancez demarrer.command"
  echo
  read -r -p "  Appuyez sur Entree pour ouvrir la page de telechargement..."
  open https://nodejs.org/fr
  exit 1
fi

node "outils/demarrer.mjs"
echo
echo "  ── Termine. Vous pouvez fermer cette fenetre. ──"
read -r -p "  Appuyez sur Entree..."
