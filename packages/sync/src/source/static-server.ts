/**
 * Petit serveur statique pour donner une vraie origine HTTP au site local.
 *
 * On ne charge jamais le site en `file://` : les polices web, `fetch`, les
 * modules ES et les regles CORS s'y comportent differemment de la production.
 * Extraire depuis une origine http garantit que ce qu'on mesure est ce que le
 * visiteur voit.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import type { Server } from 'node:http';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
};

export interface StaticServer {
  origin: string;
  close(): Promise<void>;
}

export async function serveDirectory(root: string, host = '127.0.0.1'): Promise<StaticServer> {
  const absoluteRoot = path.resolve(root);

  const server: Server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        let relative = decodeURIComponent(url.pathname);
        if (relative.endsWith('/')) relative += 'index.html';

        let filePath = path.join(absoluteRoot, relative);
        // Un chemin qui tente de sortir de la racine est refuse.
        if (!filePath.startsWith(absoluteRoot)) {
          res.writeHead(403).end('Forbidden');
          return;
        }

        let info = await stat(filePath).catch(() => null);

        // Les sites « propres » utilisent /contact plutot que /contact.html :
        // on essaie les deux resolutions habituelles avant d'abandonner.
        if (!info) {
          for (const candidate of [filePath + '.html', path.join(filePath, 'index.html')]) {
            const alt = await stat(candidate).catch(() => null);
            if (alt?.isFile()) {
              filePath = candidate;
              info = alt;
              break;
            }
          }
        }
        if (info?.isDirectory()) {
          filePath = path.join(filePath, 'index.html');
          info = await stat(filePath).catch(() => null);
        }
        if (!info?.isFile()) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
          return;
        }

        res.writeHead(200, {
          'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
          'content-length': String(info.size),
          'cache-control': 'no-store',
        });
        createReadStream(filePath).pipe(res);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(error));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });

  const address = server.address();
  if (typeof address === 'string' || address === null) {
    throw new Error('Impossible de determiner le port du serveur statique.');
  }

  return {
    origin: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
