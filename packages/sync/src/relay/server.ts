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

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Le port ${options.port} est deja occupe. Changez \`relay.port\` dans sfs.config.json, ou arretez l autre instance.`,
          ),
        );
        return;
      }
      reject(error);
    });
    server.listen(options.port, options.host, () => resolve());
  });

  return {
    url: `http://${options.host}:${options.port}`,
    reports,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
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
