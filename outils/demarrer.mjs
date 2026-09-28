#!/usr/bin/env node
/**
 * Assistant de demarrage.
 *
 * Public vise : une personne qui n'utilise pas le terminal au quotidien. Le
 * script fait lui-meme tout ce qui peut l'etre, pose le minimum de questions, et
 * explique chaque echec en francais avec la marche a suivre.
 *
 * Aucun prerequis au-dela de Node.js : les dependances, la construction et le
 * navigateur sont installes a la demande.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const C = {
  reset: '\u001b[0m', gras: '\u001b[1m', pale: '\u001b[2m',
  bleu: '\u001b[36m', vert: '\u001b[32m', jaune: '\u001b[33m', rouge: '\u001b[31m',
};
const couleurs = process.stdout.isTTY === true && !process.env.NO_COLOR;
const peindre = (texte, couleur) => (couleurs ? C[couleur] + texte + C.reset : texte);

const dire = (texte = '') => process.stdout.write(texte + '\n');
const titre = (texte) => {
  dire('');
  dire(peindre('── ' + texte + ' ' + '─'.repeat(Math.max(0, 62 - texte.length)), 'bleu'));
};
const bien = (texte) => dire('  ' + peindre('✓', 'vert') + ' ' + texte);
const info = (texte) => dire('  ' + peindre('·', 'pale') + ' ' + texte);
const alerte = (texte) => dire('  ' + peindre('!', 'jaune') + ' ' + texte);
const erreur = (texte) => dire('  ' + peindre('✗', 'rouge') + ' ' + texte);

/** Lance une commande en affichant sa sortie, et attend la fin. */
function executer(commande, args, options = {}) {
  return new Promise((resolve) => {
    // Le shell n'est necessaire que pour les commandes designees par un nom nu
    // (`npm`, `npx`), qui sont des scripts sous Windows. Il est nuisible des que
    // la commande est un chemin : `C:\Program Files\nodejs\node.exe` serait
    // coupe au premier espace, et Windows repondrait « 'C:\Program' n'est pas
    // reconnu ».
    //
    // Le critere est la presence d'un separateur, et non `path.isAbsolute` : ce
    // dernier ignore les lettres de lecteur Windows lorsqu'il s'execute ailleurs,
    // ce qui rendrait la regle intestable hors de Windows.
    const estUnChemin = /[\\/]/.test(commande);
    const besoinShell = process.platform === 'win32' && !estUnChemin;

    const enfant = spawn(commande, args, {
      cwd: RACINE,
      stdio: options.silencieux ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: besoinShell,
      env: {
        ...process.env,
        // Les avertissements de depreciation de Node n'appellent aucune action
        // de la part de l'utilisatrice et noient les lignes qui comptent.
        NODE_NO_WARNINGS: '1',
        ...(options.env ?? {}),
      },
    });
    let sortie = '';
    if (options.silencieux) {
      enfant.stdout?.on('data', (bloc) => (sortie += bloc));
      enfant.stderr?.on('data', (bloc) => (sortie += bloc));
    }
    enfant.on('error', () => resolve({ code: -1, sortie }));
    enfant.on('close', (code) => resolve({ code: code ?? -1, sortie }));
  });
}

async function principal() {
  dire('');
  dire(peindre('  Site → Figma — assistant de demarrage', 'gras'));
  dire(peindre('  Ce script prepare tout. Laissez-le travailler.', 'pale'));

  /* --------------------------- 1. Node.js ------------------------------- */

  titre('1/6  Verification de Node.js');
  const versionMajeure = Number(process.versions.node.split('.')[0]);
  if (versionMajeure < 20) {
    erreur(`Node.js ${process.versions.node} est trop ancien (il faut au moins la version 20).`);
    dire('');
    dire('    Installez la version « LTS » depuis  https://nodejs.org/fr');
    dire('    puis relancez ce script.');
    return 1;
  }
  bien(`Node.js ${process.versions.node}`);

  /* ------------------------ 2. Dependances ------------------------------ */

  titre('2/6  Installation des dependances');
  if (existsSync(path.join(RACINE, 'node_modules', 'playwright-core'))) {
    bien('Deja installees.');
  } else {
    info('Premiere installation — comptez une a deux minutes.');
    const { code } = await executer('npm', [
      'install', '--no-audit', '--no-fund', '--loglevel=error',
    ]);
    if (code !== 0) {
      erreur("L'installation a echoue.");
      dire('');
      dire('    Cause la plus frequente : pas de connexion, ou un proxy d entreprise.');
      dire('    Reessayez, et si cela persiste envoyez-moi le message ci-dessus.');
      return 1;
    }
    bien('Dependances installees.');
  }

  /* -------------------------- 3. Construction --------------------------- */

  titre('3/6  Construction du logiciel');
  const { code: codeBuild } = await executer('npm', ['run', 'build'], { silencieux: true });
  if (codeBuild !== 0) {
    erreur('La construction a echoue.');
    dire('    Relancez ce script ; si le probleme persiste, signalez-le-moi.');
    return 1;
  }
  bien('Logiciel construit (le plugin Figma est pret a etre importe).');

  /* --------------------------- 4. Navigateur ---------------------------- */

  titre('4/6  Navigateur de mesure');
  const cliSync = path.join('packages', 'sync', 'dist', 'cli.js');

  /** Interroge `doctor` : quel navigateur est utilisable, s'il y en a un ? */
  const chercherNavigateur = async () => {
    const sonde = await executer(process.execPath, [cliSync, 'doctor'], { silencieux: true });
    const ligne = /✓ (Chromium [^\n]*)/.exec(sonde.sortie);
    if (ligne) return ligne[1].trim();
    // Distinguer « aucun navigateur » d'« impossible de poser la question » :
    // confondre les deux envoie chercher un probleme la ou il n'est pas.
    if (!/Verification de l environnement/.test(sonde.sortie)) {
      alerte('La verification du navigateur n a pas pu s executer :');
      for (const ligneSortie of sonde.sortie.trim().split('\n').slice(0, 4)) {
        dire('      ' + ligneSortie);
      }
    }
    return null;
  };

  let navigateur = await chercherNavigateur();
  if (navigateur) {
    // Cas le plus frequent : Chrome ou Edge est deja installe. Rien a
    // telecharger, et c'est tant mieux.
    bien(navigateur);
  } else {
    info('Aucun navigateur detecte. Telechargement de Chromium — environ 150 Mo.');
    info('C est le navigateur qui visitera votre site pour le mesurer.');

    // On utilise le Playwright DEJA installe dans le projet, et non `npx`, qui
    // en telechargerait une seconde copie dans son propre cache.
    const { code } = await executer(
      process.execPath,
      [path.join('node_modules', 'playwright-core', 'cli.js'), 'install', 'chromium'],
      {
        // 30 s par requete est trop court sur une connexion lente : c'est la
        // cause la plus frequente d'echec de ce telechargement.
        env: { PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: '180000' },
      },
    );

    navigateur = code === 0 ? await chercherNavigateur() : null;
    if (navigateur) {
      bien(navigateur);
    } else {
      dire('');
      erreur('Le telechargement du navigateur a echoue.');
      dire('');
      dire('    Cause la plus frequente : votre reseau bloque cdn.playwright.dev');
      dire('    (pare-feu d entreprise, antivirus, ou connexion instable).');
      dire('');
      dire(peindre('    La solution la plus simple : installer Google Chrome.', 'gras'));
      dire('    Ce logiciel sait s en servir directement, sans rien telecharger d autre.');
      dire('');
      dire('      https://www.google.com/intl/fr/chrome/');
      dire('');
      dire('    Microsoft Edge convient aussi, et il est deja sur tous les Windows.');
      dire('    S il est installe sans etre trouve, indiquez son emplacement :');
      dire('');
      dire('      set SFS_CHROMIUM_PATH=C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
      dire('      node outils\\demarrer.mjs');
      dire('');
      return 1;
    }
  }

  /* --------------------------- 5. Raccourci ----------------------------- */

  titre('5/6  Raccourci sur le Bureau');
  if (process.platform === 'win32') {
    const { code } = await executer(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(RACINE, 'outils', 'raccourci.ps1')],
      { silencieux: true },
    );
    if (code === 0) bien('« Site vers Figma » est sur votre Bureau.');
    else info('Raccourci non cree — sans importance, ce fichier suffit a demarrer.');
  } else {
    info('Raccourci Bureau : Windows uniquement.');
  }

  /* -------------------------- 6. Application ---------------------------- */

  titre('6/6  Ouverture de l application');
  dire('');
  dire('  La fenetre de votre navigateur va s ouvrir.');
  dire('  Vous y indiquez votre site et votre fichier Figma, puis vous cliquez.');
  dire('');
  dire(peindre('  Laissez CETTE fenetre noire ouverte TANT QUE vous travaillez.', 'jaune'));
  dire(peindre('  La fermer arrete tout : la page ne repondra plus, et Figma non plus.', 'jaune'));
  dire(peindre('  Pour reprendre ensuite : le raccourci « Site vers Figma » du Bureau.', 'pale'));
  dire('');

  const cli = path.join('packages', 'sync', 'dist', 'cli.js');
  const { code } = await executer(process.execPath, [cli, 'app']);
  if (code !== 0) {
    dire('');
    erreur("L application n a pas pu s ouvrir.");
    dire('');
    dire('    Le message ci-dessus indique la cause. Envoyez-le-moi si besoin.');
    return 1;
  }
  return 0;
}

principal()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    dire('');
    erreur(e instanceof Error ? e.message : String(e));
    dire('');
    dire('    Copiez ce message et envoyez-le-moi : je vous dirai quoi faire.');
    process.exit(1);
  });
