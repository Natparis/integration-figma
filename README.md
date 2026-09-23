# site-to-figma-sync

Construit un fichier Figma **prêt pour la passation à un développeur** à partir
d'un site web, et le **met à jour** à chaque modification du site — sans jamais
recréer le document, donc sans perdre les commentaires ni le travail en cours.

Fonctionne avec l'export ZIP du site, un dossier local, ou l'URL du site en ligne.

---

## Le point d'architecture à connaître

**L'API REST de Figma est en lecture seule pour le contenu d'un fichier.** Aucun
service externe ne peut créer des frames, des textes ou des composants par HTTP.
La seule voie officielle d'écriture est un **plugin Figma**.

Le logiciel se répartit donc en deux moitiés — c'est la bonne architecture, pas un
contournement :

```
  site (ZIP · dossier · URL)
        │
        ▼
  ┌───────────────────┐   Chromium headless : visite chaque page à chaque largeur
  │   extracteur      │   d'écran, relève les styles RÉELLEMENT calculés
  └───────────────────┘
        │  design-spec.json  (tokens + arbre de nœuds + assets)
        ▼
  ┌───────────────────┐   serveur local, lié à 127.0.0.1
  │   relay           │   rien ne sort de votre machine
  └───────────────────┘
        │  http://127.0.0.1:7788
        ▼
  ┌───────────────────┐   écrit et met à jour LE fichier Figma référencé
  │   plugin Figma    │
  └───────────────────┘
```

Un mode **sans serveur** existe aussi : `sfs bundle` produit un fichier unique que
l'on dépose dans l'interface du plugin.

---

## Le plus simple : l'assistant de démarrage

Si vous n'êtes pas à l'aise avec le terminal, tout est automatisé :

| Votre système | Double-cliquez sur |
|---------------|--------------------|
| Windows       | `demarrer.bat`     |
| macOS         | `demarrer.command` |

L'assistant vérifie Node.js, installe ce qu'il faut, télécharge le navigateur de
mesure, vous demande l'adresse de votre site et la clé de votre fichier Figma,
lit le site, puis affiche la marche à suivre dans Figma. Il explique chaque
échec en français.

Le reste de cette page décrit les commandes manuelles, pour qui préfère.

---

## Installation manuelle

Prérequis : **Node.js 20 ou supérieur**.

```bash
npm install
npm run build

# Une seule fois : le navigateur qui servira à visiter le site
npx playwright install chromium

# Vérifie que tout est en place
npm run sfs -- doctor
```

---

## Démarrage en cinq minutes

### 1. Configurer

```bash
npm run sfs -- init
```

Ouvrez `sfs.config.json` et renseignez deux champs :

| Champ            | Où le trouver                                                     |
|------------------|-------------------------------------------------------------------|
| `source.path`    | l'URL du site, le chemin du `.zip`, ou le dossier de l'export      |
| `figma.fileKey`  | dans l'URL du fichier Figma : `figma.com/design/`**`CLÉ`**`/nom`   |

### 2. Extraire le site

```bash
npm run sfs -- extract
```

Le terminal affiche ce qui a été trouvé, et **ce qui n'a pas pu être reproduit
fidèlement**. Lisez ces avertissements : ils décrivent exactement ce que le
développeur devra reprendre à la main.

### 2 bis. Vérifier avant d'ouvrir Figma

L'extraction produit aussi `.sfs/comparaison.html`. Ouvrez-le dans un
navigateur : il montre **côte à côte** une capture de votre site et le rendu de
ce que l'outil en a compris, avec un curseur pour superposer les deux.

C'est le moyen le plus rapide de juger la fidélité — et il sépare deux questions
qu'on confond sinon : *l'outil lit-il mal le site*, ou *écrit-il mal dans
Figma* ? Un écart visible dans ce rapport se retrouvera dans Figma.

### 3. Installer le plugin dans Figma

Une seule fois, sur le poste qui pilotera la synchronisation :

1. assurez-vous d'avoir lancé `npm run build` — le manifeste pointe vers
   `dist/`, qui n'est pas versionné ;
2. Figma (**application de bureau**, l'import de plugin n'existe pas dans le
   navigateur) → menu **Plugins ▸ Développement ▸ Importer un plugin depuis le
   manifeste…** ;
3. choisissez `packages/figma-plugin/manifest.json`.

### 4. Synchroniser

```bash
npm run sfs -- sync
```

Puis, dans Figma : ouvrez le fichier cible, lancez **Plugins ▸ Développement ▸
Site → Figma Sync**, et cliquez sur **Synchroniser**.

> **« Le port 7788 est déjà occupé »** n'arrête plus rien. Si le relais déjà en
> place sert la même extraction, celui-ci s'y raccroche et vous garde la même
> adresse ; sinon il glisse au port suivant et vous l'annonce — c'est alors
> cette nouvelle adresse qu'il faut coller dans le plugin.

### 5. Plus tard, quand le site change

```bash
npm run sfs -- diff     # ce qui a changé depuis la dernière fois
npm run sfs -- sync     # ré-extrait, puis relancez le plugin
```

La seconde synchronisation **met à jour les couches existantes**. Elle n'en
recrée aucune : les commentaires de revue, les liens de prototype et les
sélections du développeur restent en place.

---

## Ce que contient le fichier Figma produit

| Page Figma          | Contenu                                                                    |
|---------------------|----------------------------------------------------------------------------|
| `Site / 01 · Accueil`, … | Une page par page du site. Une frame par largeur d'écran, côte à côte. |
| `Composants`        | Inventaire des motifs répétés du site (cartes, boutons, en-tête…), avec leurs variantes. |
| `Documentation`     | La note de passation : source, date, mode d'emploi, tokens, **et les limites**. |

Et, dans les bibliothèques du fichier :

- **Variables** (design tokens) reprenant **les noms de votre CSS**
  (`--color-brand-600` → `color/brand/600`), avec les modes clair et sombre, et
  les **alias** du CSS reproduits comme alias Figma ;
- **Styles de texte** nommés par rôle (`Titre/H1`, `Corps/Paragraphe`,
  `Titre/H1 · Mobile`) ;
- **Styles de peinture et d'effet** (`Elevation/md`…).

### Pourquoi ce fichier est exploitable par un développeur

- **Tout est en auto-layout.** Direction, espacements, marges intérieures et
  alignements viennent du CSS réel, pas d'une approximation à la souris.
- **Les tailles sont justes.** « Remplir le conteneur » pour un élément de bloc,
  « Ajuster au contenu » pour un élément de niveau ligne, « Fixe » uniquement
  quand l'auteur a réellement déclaré une dimension. Les `max-width` sont
  conservés : la maquette reste adaptable.
- **Les couches portent des noms lisibles** issus de la sémantique HTML :
  `En-tête`, `Navigation principale`, `H2 · Six domaines d'expertise`,
  `Bouton · Prendre rendez-vous` — pas « Frame 1247 ».
- **Le Dev Mode affiche le sélecteur CSS d'origine** et les propriétés calculées
  sur les couches structurantes : le pont direct entre la maquette et le code.
- **Les couleurs sont liées aux variables.** Changer un token met à jour toute la
  maquette, comme en CSS.

---

## Commandes

| Commande            | Effet                                                             |
|---------------------|-------------------------------------------------------------------|
| `sfs init`          | crée `sfs.config.json`                                            |
| `sfs doctor`        | vérifie Node, Chromium et la configuration                        |
| `sfs extract`       | visite le site, produit `.sfs/design-spec.json`                   |
| `sfs diff`          | compare le site à la dernière extraction                          |
| `sfs compare`       | rapport HTML : votre site face à ce qui en a été compris          |
| `sfs bundle`        | spec autonome, assets incorporés — aucun serveur nécessaire        |
| `sfs serve`         | lance le relay local pour le plugin                               |
| `sfs sync`          | `extract` puis `serve`                                            |
| `sfs watch`         | ré-extrait automatiquement quand le site change                   |

Options utiles :

```bash
sfs extract --source ./export-site.zip
sfs extract --source https://projet.exemple.fr/
sfs extract --source http://localhost:8080/      # site servi en local
sfs extract --breakpoints 1440,834,390
sfs extract --max-pages 60
sfs extract --no-annotations                     # spec nettement plus léger
sfs watch  --interval 30
```

---

## Configuration (`sfs.config.json`)

```jsonc
{
  "source": {
    "path": "https://projet.exemple.fr/",
    "entries": ["/"],                  // routes de départ du parcours
    "exclude": ["/admin", "/^\\/api/"], // sous-chaîne ou /expression régulière/
    "maxPages": 40,
    "settleMs": 400                    // attente après chargement
  },
  "breakpoints": [
    { "name": "Desktop", "width": 1440, "height": 1024 },
    { "name": "Tablet",  "width": 834,  "height": 1112 },
    { "name": "Mobile",  "width": 390,  "height": 844  }
  ],
  "figma": {
    "fileKey": "",                     // figma.com/design/<CLÉ>/<nom>
    "pagePrefix": "Site",
    "componentsPage": "Composants",
    "documentationPage": "Documentation"
  },
  "tokens": {
    "useCssVariables": true,           // vos variables :root font autorité
    "inferMissing": true,              // compléter par analyse si le CSS n'en déclare pas
    "darkMode": true,
    "themeAttribute": "data-theme",
    "collectionName": "Design Tokens"
  },
  "components": { "enabled": true, "minOccurrences": 3 },
  "output":     { "dir": ".sfs", "devAnnotations": true, "pretty": false },
  "relay":      { "host": "127.0.0.1", "port": 7788 },
  "sync":       { "onRemoved": "archive" }
}
```

> **Sur `networkAccess.allowedDomains` du manifeste du plugin.** Figma refuse
> une adresse IP suivie d'un port (`http://127.0.0.1:7788`) dans cette liste :
> elle est donc déclarée en générique (`*`). Le code du plugin, lui, n'appelle
> qu'une seule adresse — celle saisie dans son interface, le relay local. Vous
> pouvez ainsi changer `relay.port` sans toucher au manifeste.

---

## Ce que la maquette ne peut pas montrer

Ces limites sont inhérentes à la capture d'un site rendu, pas à l'outil. Elles
sont rappelées sur la page `Documentation` du fichier Figma pour que le
développeur les ait sous les yeux.

- **États au survol, au focus et actifs** : le navigateur n'en rend qu'un à la
  fois ; la capture est faite au repos.
- **Animations et transitions** : neutralisées volontairement, pour mesurer
  l'état final et non une image intermédiaire.
- **Vidéos** : rendues par **une image fixe extraite de la lecture** — celle que
  voit le visiteur à cet instant. Le mouvement est à réimplémenter en code. Une
  vidéo servie depuis un autre domaine sans en-tête CORS ne peut pas être
  capturée : le navigateur l'interdit, et c'est signalé.
- **Éléments collés** (`position: sticky` / `fixed`) : placés à leur position de
  repos, en couche absolue.
- **Contenus repliés** (accordéons fermés, diapositives hors cadre) : **exclus**,
  puisqu'ils ne sont pas visibles. La maquette montre l'état initial de la page,
  comme un visiteur qui arrive dessus.
- **Shadow DOM fermé** : inaccessible, même au navigateur qui l'affiche. Les
  arbres ouverts sont parcourus normalement ; les fermés sont signalés.
- **Grilles CSS à colonnes inégales** : rendues en auto-layout avec retour à la
  ligne ; les largeurs de colonnes sont à redéclarer en CSS.
- **`<canvas>`, `<iframe>`** : rendus comme boîtes vides — leur contenu n'est pas
  extractible.

---

## Confidentialité

Rien ne quitte votre machine, à trois exceptions près, toutes nécessaires :

- l'extracteur visite votre site (comme le ferait un visiteur) ;
- le relay écoute sur `127.0.0.1` uniquement ;
- le plugin écrit dans votre fichier Figma, via votre propre session Figma.

Aucun service tiers n'est appelé.

---

## Développement

```bash
npm run build       # les trois paquets
npm test            # 143 tests
npm run typecheck
npm run verify-colors   # compare le parseur de couleurs au rasteriseur de Chromium
```

Structure :

| Paquet                    | Rôle                                                       |
|---------------------------|------------------------------------------------------------|
| `packages/spec`           | format `design-spec`, identifiants stables, diff, validation |
| `packages/sync`           | extracteur Chromium, tokens, composants, CLI, relay         |
| `packages/figma-plugin`   | plugin Figma : variables, styles, réconciliation, passation  |

Voir [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) pour les décisions de
conception et leurs raisons.
