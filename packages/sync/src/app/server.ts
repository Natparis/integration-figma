/**
 * L'application : une fenetre, deux champs, un bouton.
 *
 * Elle reunit ce qui etait jusqu'ici disperse entre un assistant en ligne de
 * commande et un relais separe. Le meme serveur sert la page, lance la lecture
 * du site, expose le rapport de comparaison et parle au plugin Figma — un seul
 * port, une seule fenetre a garder ouverte.
 *
 * La progression est diffusee telle quelle depuis le journal : l'interface
 * n'invente aucun message, elle montre ce que fait reellement le logiciel.
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { DesignSpec } from '@sfs/spec';
import { diffSpecs } from '@sfs/spec';
import { DEFAULT_CONFIG, type SfsConfig } from '../config.js';
import type { LigneJournal, Logger } from '../logger.js';
import { PAGE } from './page.js';

export interface OptionsApp {
  racine: string;
  cheminConfig: string;
  config: SfsConfig;
  host: string;
  port: number;
  log: Logger;
  /** Lance une extraction avec la configuration courante. */
  extraire(config: SfsConfig): Promise<void>;
}

interface Abonne {
  res: http.ServerResponse;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

export async function demarrerApp(options: OptionsApp): Promise<{ url: string; fermer(): Promise<void> }> {
  const dossierSortie = path.resolve(options.racine, options.config.output.dir);
  const abonnes = new Set<Abonne>();
  let config = options.config;
  let occupe = false;

  const diffuser = (evenement: string, donnees: unknown): void => {
    const charge = `event: ${evenement}\ndata: ${JSON.stringify(donnees)}\n\n`;
    for (const abonne of abonnes) abonne.res.write(charge);
  };

  const desabonner = options.log.abonner((ligne: LigneJournal) => {
    if (ligne.message.trim()) diffuser('ligne', ligne);
  });

  const serveur = http.createServer((req, res) => {
    void router(req, res).catch((error) => {
      envoyer(res, 500, { erreur: String(error) });
    });
  });

  async function router(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Le plugin Figma emet depuis une origine qu'on ne controle pas.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }

    if (url.pathname === '/etat') {
      envoyer(res, 200, await lireEtat());
      return;
    }

    if (url.pathname === '/flux') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        connection: 'keep-alive',
      });
      res.write(': flux ouvert\n\n');
      const abonne: Abonne = { res };
      abonnes.add(abonne);
      req.on('close', () => abonnes.delete(abonne));
      return;
    }

    if (url.pathname === '/lancer' && req.method === 'POST') {
      if (occupe) { envoyer(res, 409, { ok: false, erreur: 'Une lecture est deja en cours.' }); return; }
      const corps = (await lireCorps(req)) as { source?: string; figma?: string };
      occupe = true;
      try {
        config = await enregistrerConfig(corps.source ?? '', corps.figma ?? '');
        const precedent = await lireSpec();
        await options.extraire(config);
        const etat = await lireEtat(precedent);
        envoyer(res, 200, { ok: true, etat });
      } catch (error) {
        options.log.error(error instanceof Error ? error.message : String(error));
        envoyer(res, 200, { ok: false, erreur: String(error) });
      } finally {
        occupe = false;
      }
      return;
    }

    if (url.pathname === '/rapport' || url.pathname.startsWith('/rapport/')) {
      const relatif = url.pathname === '/rapport'
        ? 'comparaison.html'
        : decodeURIComponent(url.pathname.slice('/rapport/'.length));
      await servirFichier(res, dossierSortie, relatif);
      return;
    }

    /* ------------------- points d'entree du plugin Figma ------------------ */

    if (url.pathname === '/health') {
      const spec = await lireSpec();
      envoyer(res, 200, {
        ok: true,
        revision: spec?.revision ?? null,
        pages: spec?.stats.pages ?? 0,
        assets: spec?.stats.assets ?? 0,
      });
      return;
    }

    if (url.pathname === '/spec') {
      await servirFichier(res, dossierSortie, 'design-spec.json');
      return;
    }

    if (url.pathname.startsWith('/asset/')) {
      const id = decodeURIComponent(url.pathname.slice('/asset/'.length));
      const spec = await lireSpec();
      const asset = spec?.assets.find((candidat) => candidat.id === id);
      if (!asset) { envoyer(res, 404, { erreur: `Asset inconnu : ${id}` }); return; }
      // Le chemin vient du spec, pas de la requete : aucune traversee possible.
      await servirFichier(res, dossierSortie, asset.file, asset.mime);
      return;
    }

    if (url.pathname === '/report' && req.method === 'POST') {
      const rapport = (await lireCorps(req)) as {
        status?: string; created?: number; updated?: number; removed?: number;
        skipped?: number; message?: string;
      };
      diffuser('plugin', { texte: resumerRapportPlugin(rapport) });
      if (rapport.status === 'done') {
        options.log.success(
          `Figma : ${rapport.created ?? 0} créées, ${rapport.updated ?? 0} mises à jour, ${rapport.removed ?? 0} retirées.`,
        );
      }
      envoyer(res, 200, { ok: true });
      return;
    }

    envoyer(res, 404, { erreur: 'Route inconnue' });
  }

  /* ------------------------------- lectures ------------------------------- */

  async function lireSpec(): Promise<DesignSpec | null> {
    try {
      return JSON.parse(await readFile(path.join(dossierSortie, 'design-spec.json'), 'utf8')) as DesignSpec;
    } catch {
      return null;
    }
  }

  async function lireEtat(precedent?: DesignSpec | null): Promise<Record<string, unknown>> {
    const spec = await lireSpec();
    const base = {
      source: config.source.path,
      figma: config.figma.fileKey ? `https://www.figma.com/design/${config.figma.fileKey}/` : '',
      relais: `http://${options.host}:${options.port}`,
      manifeste: path.join(options.racine, 'packages', 'figma-plugin', 'manifest.json'),
      // Chemins sur le disque : un rapport ne doit pas dependre du serveur pour
      // etre lu. La fenetre fermee, le bouton ne repond plus — le fichier, si.
      rapportFichier: path.join(dossierSortie, 'comparaison.html'),
      releveFichier: path.join(dossierSortie, 'releve.txt'),
    };
    if (!spec) return base;

    let changements = '';
    if (precedent) {
      const diff = diffSpecs(precedent, spec);
      const r = diff.summary;
      changements = diff.unchanged
        ? 'Votre site n’a pas changé depuis la dernière lecture.'
        : `Depuis la dernière lecture : ${r.nodesAdded} calques ajoutés, ${r.nodesModified} modifiés, ` +
          `${r.nodesMoved} déplacés, ${r.nodesRemoved} retirés. ` +
          'La synchronisation ne touchera que ceux-là.';
    }

    return {
      ...base,
      revision: spec.revision,
      pages: spec.stats.pages,
      calques: spec.stats.nodes,
      assets: spec.stats.assets,
      quand: new Date(spec.generatedAt).toLocaleString('fr-FR'),
      changements,
    };
  }

  /** Ecrit la configuration : les reponses de l'utilisatrice doivent survivre. */
  async function enregistrerConfig(source: string, figma: string): Promise<SfsConfig> {
    const cle = extraireCleFigma(figma);
    const suivante: SfsConfig = {
      ...config,
      source: { ...config.source, path: source || config.source.path },
      figma: { ...config.figma, fileKey: cle ?? config.figma.fileKey },
    };
    await writeFile(options.cheminConfig, JSON.stringify(suivante, null, 2) + '\n', 'utf8');
    return suivante;
  }

  async function servirFichier(
    res: http.ServerResponse,
    racine: string,
    relatif: string,
    type?: string,
  ): Promise<void> {
    // Normalisation puis verification d'appartenance : un `..` dans l'URL ne
    // doit pas permettre de sortir du dossier de sortie.
    const cible = path.resolve(racine, relatif);
    if (cible !== racine && !cible.startsWith(racine + path.sep)) {
      envoyer(res, 403, { erreur: 'Chemin refuse' });
      return;
    }
    const info = await stat(cible).catch(() => null);
    if (!info?.isFile()) {
      envoyer(res, 404, { erreur: `Fichier absent : ${relatif}. Lancez d’abord une lecture du site.` });
      return;
    }
    const corps = await readFile(cible);
    res.writeHead(200, {
      'content-type': type ?? TYPES[path.extname(cible).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(corps.length),
    });
    res.end(corps);
  }

  await new Promise<void>((resolve, reject) => {
    serveur.once('error', reject);
    serveur.listen(options.port, options.host, () => resolve());
  });

  return {
    url: `http://${options.host}:${options.port}`,
    fermer: () =>
      new Promise<void>((resolve) => {
        desabonner();
        for (const abonne of abonnes) abonne.res.end();
        serveur.close(() => resolve());
      }),
  };
}

function envoyer(res: http.ServerResponse, statut: number, corps: unknown): void {
  const charge = JSON.stringify(corps);
  res.writeHead(statut, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(charge)),
  });
  res.end(charge);
}

async function lireCorps(req: http.IncomingMessage): Promise<unknown> {
  const morceaux: Buffer[] = [];
  for await (const morceau of req) morceaux.push(morceau as Buffer);
  if (morceaux.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(morceaux).toString('utf8'));
  } catch {
    return {};
  }
}

/** Resume lisible d'un compte-rendu du plugin, pour la page. */
export function resumerRapportPlugin(rapport: {
  status?: string; created?: number; updated?: number; removed?: number; message?: string;
}): string {
  if (rapport.status === 'started') return 'Synchronisation en cours dans Figma…';
  if (rapport.status === 'error') return `Figma a signalé une erreur : ${rapport.message ?? 'cause inconnue'}`;
  return (
    `Terminé : ${rapport.created ?? 0} calques créés, ${rapport.updated ?? 0} mis à jour, ` +
    `${rapport.removed ?? 0} retirés. Les commentaires et les liens de prototype sont restés en place.`
  );
}

/** Accepte un lien Figma complet, ou une clé déjà isolée. */
export function extraireCleFigma(entree: string): string | null {
  if (!entree) return null;
  const parLien = /figma\.com\/(?:design|file|board|slides)\/([0-9a-zA-Z]{22,128})/.exec(entree);
  if (parLien) return parLien[1]!;
  const nu = entree.trim();
  return /^[0-9a-zA-Z]{22,128}$/.test(nu) ? nu : null;
}

export const CONFIG_PAR_DEFAUT = DEFAULT_CONFIG;
