/** Journalisation minimale, lisible dans un terminal. */

const COLORS = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  cyan: '\u001b[36m',
};

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** Une ligne de journal, telle qu'elle peut etre relayee a une interface. */
export interface LigneJournal {
  niveau: 'info' | 'etape' | 'succes' | 'alerte' | 'erreur' | 'brut';
  message: string;
}

export class Logger {
  private readonly color: boolean;
  /**
   * Abonnes aux lignes ecrites.
   *
   * L'interface graphique montre la progression en direct : elle a besoin des
   * memes lignes que le terminal, au moment ou elles sont ecrites. Les diffuser
   * ici, a la source, evite d'avoir deux journalisations a tenir a jour.
   */
  private readonly abonnes = new Set<(ligne: LigneJournal) => void>();

  constructor(private level: LogLevel = 'info') {
    this.color = process.stdout.isTTY === true && !process.env.NO_COLOR;
  }

  /** S'abonne aux lignes ecrites. Rend la fonction de desabonnement. */
  abonner(ecouteur: (ligne: LigneJournal) => void): () => void {
    this.abonnes.add(ecouteur);
    return () => this.abonnes.delete(ecouteur);
  }

  private diffuser(niveau: LigneJournal['niveau'], message: string): void {
    for (const abonne of this.abonnes) {
      try {
        abonne({ niveau, message });
      } catch {
        /* un abonne defaillant ne doit pas interrompre l'extraction */
      }
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private paint(text: string, color: keyof typeof COLORS): string {
    return this.color ? `${COLORS[color]}${text}${COLORS.reset}` : text;
  }

  private write(level: LogLevel, stream: 'out' | 'err', prefix: string, message: string): void {
    if (ORDER[this.level] < ORDER[level]) return;
    const line = `${prefix} ${message}\n`;
    if (stream === 'err') process.stderr.write(line);
    else process.stdout.write(line);
  }

  info(message: string): void {
    this.diffuser('info', message);
    this.write('info', 'out', this.paint('·', 'cyan'), message);
  }

  step(message: string): void {
    this.diffuser('etape', message);
    this.write('info', 'out', this.paint('▸', 'cyan'), message);
  }

  success(message: string): void {
    this.diffuser('succes', message);
    this.write('info', 'out', this.paint('✓', 'green'), message);
  }

  warn(message: string): void {
    this.diffuser('alerte', message);
    this.write('warn', 'err', this.paint('!', 'yellow'), message);
  }

  error(message: string): void {
    this.diffuser('erreur', message);
    this.write('error', 'err', this.paint('✗', 'red'), message);
  }

  debug(message: string): void {
    this.write('debug', 'err', this.paint('  ·', 'dim'), this.paint(message, 'dim'));
  }

  /** Bloc de texte brut, sans prefixe (rapports de diff, aide). */
  plain(message: string): void {
    this.diffuser('brut', message);
    if (ORDER[this.level] < ORDER.info) return;
    process.stdout.write(message + '\n');
  }
}

export const logger = new Logger();
