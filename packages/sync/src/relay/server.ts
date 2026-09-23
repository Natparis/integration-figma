/**
 * Relay HTTP local : le pont entre le CLI et le plugin Figma.
 *
 * Le plugin ne peut pas lire le disque. Il lui faut une URL. Ce serveur, lie a
 * 127.0.0.1, expose le spec et les assets a destination du seul plugin — rien ne
 * sort de la machine.
 */

import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { DesignSpec } from '@sfs/spec';
import type { Logger } from '../logger.js';

export interface RelayOptions {
  host: string;
  port: number;
  /** Dossier contenant `design-spec.json` et `assets/`. */
  outputDir: string;
  log: Logger;
}

export interface RelayHandle {
  url: string;
  close(): Promise<void>;
  /** Derniers comptes-rendus envoyes par le plugin. */
  reports: SyncReport[];
  /**
   * Vrai quand un relay tournait deja sur ce port et servait la meme
   * extraction : on s'y raccroche au lieu d'echouer. Les comptes-rendus du
   * plugin partent alors dans l'autre fenetre, pas dans celle-ci.
   */
  reused?: boolean;
  /** Vrai quand le port configure etait pris et qu'on a du en changer. */
  movedFrom?: number;
}

export interface SyncReport {
  at: string;
  revision: string;
  status: 'started' | 'done' | 'error';
  created?: number;
  updated?: number;
  removed?: number;
  skipped?: number;
  durationMs?: number;
  message?: string;
  warnings?: string[];
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

export async function startRelay(options: RelayOptions): Promise<RelayHandle> {
  const outputDir = path.resolve(options.outputDir);
  const reports: SyncReport[] = [];

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      send(res, 500, { error: String(error) });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Le plugin Figma emet depuis une origine qu'on ne controle pas : sans CORS,
    // toutes les requetes seraient bloquees par le navigateur.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/health') {
      const spec = await loadSpec(outputDir);
      send(res, 200, {
        ok: true,
        revision: spec?.revision ?? null,
        generatedAt: spec?.generatedAt ?? null,
        pages: spec?.stats.pages ?? 0,
        assets: spec?.stats.assets ?? 0,
      });
      return;
    }

    if (url.pathname === '/spec') {
      const file = path.join(outputDir, 'design-spec.json');
      const info = await stat(file).catch(() => null);
      if (!info) {
        send(res, 404, {
          error: "Aucun design-spec.json. Lancez d'abord `sfs extract`.",
        });
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
      });
      res.end(body);
      return;
    }

    if (url.pathname.startsWith('/asset/')) {
      const id = decodeURIComponent(url.pathname.slice('/asset/'.length));
      const spec = await loadSpec(outputDir);
      const asset = spec?.assets.find((candidate) => candidate.id === id);
      if (!asset) {
        send(res, 404, { error: `Asset inconnu : ${id}` });
        return;
      }
      // Le chemin vient du spec, pas de la requete : aucune traversee possible.
      const file = path.join(outputDir, asset.file);
      const body = await readFile(file).catch(() => null);
      if (!body) {
        send(res, 404, { error: `Fichier manquant : ${asset.file}` });
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(asset.file).toLowerCase()] ?? asset.mime,
        'content-length': String(body.length),
      });
      res.end(body);
      return;
    }

    if (url.pathname === '/report' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      try {
        const report = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SyncReport;
        report.at = new Date().toISOString();
        reports.push(report);
        logReport(options.log, report);
      } catch {
        options.log.warn('Compte-rendu du plugin illisible.');
      }
      send(res, 200, { ok: true });
      return;
    }

    send(res, 404, { error: 'Route inconnue' });
  }

  // Un port occupe n'est pas une raison d'abandonner : le plus souvent c'est
  // NOTRE propre relay, reste ouvert dans une autre fenetre. On le reconnait et
  // on s'y raccroche ; sinon on se decale d'un port et on le dit clairement.
  const attendu = (await loadSpec(outputDir))?.revision ?? null;
  let port = -1;
  for (let candidat = options.port; candidat <= options.port + PORTS_A_ESSAYER; candidat++) {
    if (await tenterEcoute(server, options.host, candidat)) {
      port = candidat;
      break;
    }
    const deja = await sonderRelay(options.host, candidat);
    if (deja && (attendu === null || deja.revision === attendu)) {
      options.log.info(
        `Un relay tourne deja sur le port ${candidat} et sert la meme extraction : on le reutilise.`,
      );
      return {
        url: `http://${options.host}:${candidat}`,
        reports,
        reused: true,
        close: async () => {},
      };
    }
    options.log.warn(
      deja
        ? `Le port ${candidat} est pris par un relay d un autre dossier (revision ${deja.revision ?? 'inconnue'}).`
        : `Le port ${candidat} est deja occupe par un autre programme.`,
    );
  }

  if (port === -1) {
    throw new RelayPortError(
      `Aucun port libre entre ${options.port} et ${options.port + PORTS_A_ESSAYER}.\n` +
        'Fermez la fenetre qui fait tourner l ancienne synchronisation, ' +
        'ou changez `relay.port` dans sfs.config.json.',
    );
  }

  return {
    url: `http://${options.host}:${port}`,
    reports,
    movedFrom: port === options.port ? undefined : options.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Nombre de ports testes apres celui demande. */
const PORTS_A_ESSAYER = 9;

/** Erreur d installation, pas un bug : affichee sans pile d appels. */
export class RelayPortError extends Error {
  override readonly name = 'RelayPortError';
}

/**
 * Tente d'ecouter. Rend `true` si le port est pris, `false` s'il est occupe.
 * Toute autre erreur remonte : elle signale un vrai probleme (permission, host
 * introuvable) qu'il ne faut pas masquer en changeant de port.
 */
async function tenterEcoute(
  server: http.Server,
  host: string,
  port: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const surErreur = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', surSucces);
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(false);
        return;
      }
      reject(error);
    };
    const surSucces = (): void => {
      server.removeListener('error', surErreur);
      resolve(true);
    };
    server.once('error', surErreur);
    server.once('listening', surSucces);
    server.listen(port, host);
  });
}

/**
 * Demande a ce qui occupe le port s'il s'agit d'un relay a nous. Un programme
 * quelconque ne repondra pas `ok` sur /health : aucun risque de confusion.
 */
async function sonderRelay(
  host: string,
  port: number,
): Promise<{ revision: string | null } | null> {
  try {
    const reponse = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!reponse.ok) return null;
    const corps = (await reponse.json()) as { ok?: boolean; revision?: string | null };
    if (corps?.ok !== true) return null;
    return { revision: corps.revision ?? null };
  } catch {
    return null;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

async function loadSpec(outputDir: string): Promise<DesignSpec | null> {
  try {
    return JSON.parse(
      await readFile(path.join(outputDir, 'design-spec.json'), 'utf8'),
    ) as DesignSpec;
  } catch {
    return null;
  }
}

function logReport(log: Logger, report: SyncReport): void {
  if (report.status === 'started') {
    log.step(`Plugin : synchronisation de la revision ${report.revision} demarree…`);
    return;
  }
  if (report.status === 'error') {
    log.error(`Plugin : ${report.message ?? 'erreur inconnue'}`);
    return;
  }
  log.success(
    `Plugin : ${report.created ?? 0} crees, ${report.updated ?? 0} mis a jour, ${report.removed ?? 0} retires, ${report.skipped ?? 0} inchanges` +
      (report.durationMs ? ` en ${(report.durationMs / 1000).toFixed(1)} s.` : '.'),
  );
  for (const warning of report.warnings ?? []) log.warn(`Plugin : ${warning}`);
}
