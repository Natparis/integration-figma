/**
 * Detection des motifs reutilisables et publication en composants Figma.
 *
 * Choix de conception, assume : par defaut on NE remplace PAS le contenu des
 * pages par des instances. Les pages restent un rendu litteral et verifiable du
 * site ; les composants sont publies a part, comme inventaire d'interface.
 *
 * Raison : une detection legerement fausse qui remplace une carte par une
 * instance inexacte rend le fichier moins fiable qu'une frame ordinaire. Le
 * developpeur a besoin d'une verite exacte ET d'un inventaire des motifs — pas
 * d'une abstraction approximative. `components.instantiate` permet d'activer le
 * remplacement quand l'inventaire a ete valide a l'oeil.
 */

import type { ComponentSpec, SpecNode } from '@sfs/spec';
import type { Diagnostic } from '@sfs/spec';

export interface ComponentOptions {
  enabled: boolean;
  minOccurrences: number;
  section: string;
}

/**
 * Signature structurelle d'un sous-arbre : sa forme, sans son contenu.
 *
 * Deux cartes avec des textes differents doivent produire la meme signature ;
 * une carte et un bandeau, non. On retient donc la structure, les roles et les
 * grandes caracteristiques visuelles, mais jamais les chaines de caracteres ni
 * les dimensions exactes.
 */
export function signatureOf(node: SpecNode, depth = 0): string {
  if (depth > 6) return '…';

  const parts: string[] = [node.kind];
  if (node.devNotes?.tag) parts.push(node.devNotes.tag);
  if (node.layout.mode !== 'NONE') {
    parts.push(node.layout.mode[0]!);
    if (node.layout.wrap) parts.push('w');
  }

  const fill = node.style.fills.find((paint) => paint.type === 'SOLID');
  if (fill?.type === 'SOLID') parts.push('f');
  if (node.style.strokes.length > 0) parts.push('s');
  if (node.style.effects.length > 0) parts.push('e');
  // Rayon par palier : 12 px et 14 px designent la meme intention de design.
  const radius = node.style.cornerRadius[0];
  if (radius > 0) parts.push('r' + Math.min(3, Math.floor(radius / 8)));

  if (node.kind === 'TEXT' && node.text) {
    // La taille de police compte (un titre n'est pas une legende), le texte non.
    parts.push('t' + Math.round(node.text.font.size) + node.text.font.style[0]);
  }
  if (node.kind === 'IMAGE') parts.push('img');
  if (node.kind === 'VECTOR') parts.push('vec');

  const children = node.children.map((child) => signatureOf(child, depth + 1)).join(',');
  return `${parts.join('.')}(${children})`;
}

/** Cle visuelle : ce qui distingue deux variantes d'un meme motif. */
function visualKey(node: SpecNode): string {
  const fill = node.style.fills.find((paint) => paint.type === 'SOLID');
  const stroke = node.style.strokes.find((paint) => paint.type === 'SOLID');
  const hex = (paint: typeof fill): string => {
    if (!paint || paint.type !== 'SOLID') return '-';
    if (paint.variable) return paint.variable;
    const part = (v: number): string => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${part(paint.color.r)}${part(paint.color.g)}${part(paint.color.b)}`;
  };
  return `${hex(fill)}|${hex(stroke)}`;
}

function countNodes(node: SpecNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

/** « carte-metier » -> « Carte metier ». */
function humanizeClass(cls: string): string {
  const words = cls
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return '';
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/**
 * Nom du composant.
 *
 * La classe CSS prime sur le nom du calque : un calque de page se nomme d'apres
 * son contenu (« Organisation d'atelier »), ce qui est juste pour ce calque mais
 * faux pour le composant, qui vaut pour les six cartes. `carte-metier` decrit le
 * motif, pas une occurrence.
 */
function componentName(node: SpecNode): string {
  const cls = node.devNotes?.cls;
  if (cls) {
    const humanized = humanizeClass(cls);
    if (humanized) return humanized;
  }
  const name = node.name;
  // « Lien · Accueil » -> « Lien » : le composant vaut pour tous les liens.
  const separator = name.indexOf(' · ');
  if (separator > 0) return name.slice(0, separator);
  // « Carte metier 3 » -> « Carte metier ».
  return name.replace(/\s+\d+$/, '');
}

interface Candidate {
  signature: string;
  nodes: SpecNode[];
}

export interface ComponentResult {
  components: ComponentSpec[];
  /** sid -> cle de composant, pour instancier si l'option est active. */
  instanceMap: Map<string, { key: string; variant?: Record<string, string> }>;
}

/** Le noeud a-t-il une presence visuelle propre ? Un simple conteneur n'en a pas. */
function hasVisualPresence(node: SpecNode): boolean {
  return (
    node.style.fills.length > 0 ||
    node.style.strokes.length > 0 ||
    node.style.effects.length > 0 ||
    node.style.cornerRadius.some((r) => r > 0)
  );
}

/**
 * Cherche les motifs repetes dans les frames racines fournies.
 *
 * N'analyser qu'un seul breakpoint est volontaire : le meme bouton vu en
 * desktop, tablette et mobile n'est pas trois motifs, et le compter trois fois
 * ferait passer le seuil d'occurrences a n'importe quoi.
 *
 * Deux regles ont ete apprises a l'usage sur un site reel :
 *
 *  1. **Exclure les bandes pleine largeur.** Une section de page (heros, bandeau
 *     de chiffres, pied) se repete sur chaque page et passait donc le seuil, en
 *     eclipsant les vrais composants qu'elle contient. Une section n'est pas un
 *     composant reutilisable.
 *  2. **Ne pas « reserver » les descendants.** Un bouton dans une carte est un
 *     composant a part entiere : l'inventaire doit contenir les deux. Figma gere
 *     parfaitement les instances imbriquees.
 */
export function detectComponents(
  roots: SpecNode[],
  options: ComponentOptions,
  diagnostics: Diagnostic[],
): ComponentResult {
  const empty: ComponentResult = { components: [], instanceMap: new Map() };
  if (!options.enabled || roots.length === 0) return empty;

  const rootWidth = Math.max(...roots.map((root) => root.box.w));
  const bySignature = new Map<string, Candidate>();

  const walk = (node: SpecNode, depth: number): void => {
    const size = countNodes(node);
    const eligible =
      // Profondeur >= 2 : jamais la frame de page ni le body.
      depth >= 2 &&
      // Un bouton ne fait que deux noeuds (cadre + libelle) : c'est le composant
      // le plus important d'une interface, il ne faut pas l'exclure par sa taille.
      (size >= 3 || (size >= 2 && hasVisualPresence(node))) &&
      size <= 40 &&
      node.box.w > 24 &&
      node.box.h > 12 &&
      node.kind !== 'TEXT' &&
      // Bandes pleine largeur : ce sont des sections de page.
      node.box.w < rootWidth * 0.95 &&
      !(node.box.w > rootWidth * 0.75 && node.box.h > 250) &&
      // Conteneur de transport : un seul enfant et aucune presence visuelle.
      (node.children.length >= 2 || hasVisualPresence(node)) &&
      // Un motif sans nom de classe ET sans presence visuelle n'est qu'un
      // echafaudage de mise en page (`<div>`, `<span>` d'habillage). L'inventaire
      // doit lister des composants reconnaissables, pas des conteneurs anonymes.
      (node.devNotes?.cls !== undefined || hasVisualPresence(node));

    if (eligible) {
      const signature = signatureOf(node);
      const candidate = bySignature.get(signature);
      if (candidate) candidate.nodes.push(node);
      else bySignature.set(signature, { signature, nodes: [node] });
    }
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);

  /* ----------------------------- selection ------------------------------- */

  const promoted = [...bySignature.values()]
    .filter((candidate) => candidate.nodes.length >= options.minOccurrences)
    // Le plus repete d'abord — c'est la mesure d'utilite la plus honnete ; a
    // egalite, le motif le plus riche.
    .sort(
      (a, b) =>
        b.nodes.length - a.nodes.length || countNodes(b.nodes[0]!) - countNodes(a.nodes[0]!),
    );

  const components: ComponentSpec[] = [];
  const instanceMap = new Map<string, { key: string; variant?: Record<string, string> }>();
  const usedNames = new Set<string>();

  for (const candidate of promoted) {
    const occurrences = candidate.nodes;
    const representative = pickRepresentative(occurrences);
    let name = componentName(representative);
    if (usedNames.has(name)) {
      let suffix = 2;
      while (usedNames.has(`${name} ${suffix}`)) suffix++;
      name = `${name} ${suffix}`;
    }
    usedNames.add(name);

    const key = `cmp_${name.replace(/\W+/g, '-').toLowerCase()}`;

    // Variantes : regroupement par cle visuelle. Un bouton principal et un
    // bouton secondaire ont la meme structure mais pas la meme couleur.
    const groups = new Map<string, SpecNode[]>();
    for (const node of occurrences) {
      const visual = visualKey(node);
      const list = groups.get(visual) ?? [];
      list.push(node);
      groups.set(visual, list);
    }

    const component: ComponentSpec = {
      key,
      name,
      section: options.section,
      node: representative,
      occurrences: occurrences.length,
      description: [
        `${occurrences.length} occurrences detectees sur le site.`,
        groups.size > 1 ? `${groups.size} variantes visuelles.` : null,
        `${countNodes(representative)} couches.`,
      ]
        .filter(Boolean)
        .join(' '),
    };

    if (groups.size > 1 && groups.size <= 8) {
      const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
      component.variants = ordered.map(([visual, nodes]) => ({
        properties: { Style: variantLabel(visual) },
        node: pickRepresentative(nodes),
      }));
      component.node = component.variants[0]!.node;
      for (const [visual, nodes] of ordered) {
        for (const node of nodes) {
          instanceMap.set(node.sid, { key, variant: { Style: variantLabel(visual) } });
        }
      }
    } else {
      for (const node of occurrences) instanceMap.set(node.sid, { key });
    }

    components.push(component);
    // Au-dela de 30 composants, l'inventaire devient plus lourd a relire qu'utile.
    if (components.length >= 30) break;
  }

  if (components.length > 0) {
    diagnostics.push({
      level: 'info',
      code: 'components-detected',
      message: `${components.length} motifs reutilisables publies dans « ${options.section} » : ${components.map((c) => `${c.name} (${c.occurrences})`).join(', ')}.`,
      hint: 'Les pages restent un rendu litteral du site ; ces composants forment l inventaire d interface.',
    });
  }

  return { components, instanceMap };
}

function variantLabel(visual: string): string {
  const [fill] = visual.split('|');
  if (!fill || fill === '-') return 'Neutre';
  // Un nom de token est plus parlant qu'un code hexadecimal.
  if (!fill.startsWith('#')) return fill.split('/').slice(-2).join('-');
  return fill;
}

/** Representant : celui de taille mediane, le moins susceptible d'etre un cas limite. */
function pickRepresentative(nodes: SpecNode[]): SpecNode {
  const sorted = [...nodes].sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h);
  return sorted[Math.floor(sorted.length / 2)]!;
}

