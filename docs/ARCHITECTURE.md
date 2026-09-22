# Architecture et décisions de conception

Ce document explique **pourquoi** le logiciel est fait ainsi. Chaque décision
notable y est accompagnée de la contrainte qui l'impose — de quoi reprendre le
code sans avoir à redécouvrir les impasses.

---

## 1. Pourquoi un plugin, et pas un service

L'API REST de Figma **ne permet pas d'écrire le contenu d'un fichier**. Elle lit
les nœuds, écrit les commentaires, et — sur les offres Entreprise — les
variables. Elle ne crée ni frame, ni texte, ni composant.

Écrire dans un document Figma passe obligatoirement par la **Plugin API**, qui
s'exécute dans l'application Figma. D'où la coupure :

- ce qui peut être automatisé sans Figma (visiter le site, mesurer, analyser,
  comparer) vit dans le CLI ;
- ce qui exige Figma (écrire) vit dans le plugin ;
- un format d'échange versionné (`design-spec`) les relie.

**Conséquence assumée :** la synchronisation n'est pas entièrement sans
intervention. Le CLI détecte seul qu'un site a changé et prépare la mise à jour ;
l'écriture demande un clic dans Figma. C'est le maximum que Figma autorise.

---

## 2. Pourquoi mesurer le rendu plutôt que lire le CSS

Analyser des feuilles de style pour en déduire une mise en page reviendrait à
réécrire un moteur de rendu — cascade, spécificité, héritage, requêtes média,
polices de repli, contenu réel. On ferait moins bien qu'un navigateur.

On charge donc chaque page dans Chromium à chaque largeur d'écran, et on relève
`getComputedStyle` et `getBoundingClientRect`. **Ce qu'on transpose est ce que le
visiteur voit.**

### La stabilisation, étape décisive

Un site moderne cache une grande partie de son contenu derrière des animations
d'apparition au défilement. Capturer sans précaution donnerait une maquette à
moitié vide. Avant toute mesure, l'extracteur :

1. force le chargement immédiat des images différées (`loading="lazy"`) ;
2. injecte une feuille qui met animations et transitions à `0s` ;
3. émule `prefers-reduced-motion: reduce` ;
4. **parcourt toute la page de haut en bas**, ce qui déclenche les
   `IntersectionObserver`, puis revient au sommet ;
5. attend `document.fonts.ready`, puis un délai de repos configurable.

---

## 3. Le piège des styles calculés : `width`

Chromium renvoie `width: 1440px` pour un simple `<header>` qui occupe la largeur
de son parent. **La valeur calculée ne distingue pas une largeur imposée par
l'auteur d'une largeur simplement occupée.**

S'y fier produisait une maquette où **tout** était en taille fixe : un fichier
Figma où rien ne s'adapte, inutilisable pour un développeur.

La solution combine trois sources :

1. **la valeur déclarée**, lue dans les feuilles de style. On pré-filtre les
   sélecteurs qui déclarent `width`, `height`, `max-width` ou `flex` — une
   poignée sur un site typique — puis on teste chaque élément contre ce petit
   ensemble. Les règles dans un `@media` non satisfait sont ignorées ;
2. **la géométrie** : l'élément occupe-t-il exactement la largeur de contenu de
   son parent ?
3. **le niveau de rendu** : bloc ou ligne.

Cas particulier traité à part : `max-width` + `margin: 0 auto`, le motif le plus
répandu du web. Sa largeur vient de sa contrainte, pas de son contenu → **Remplir
le conteneur, plafonné à `max-width`**.

Ces règles sont verrouillées par des tests dans `packages/sync/src/build/layout.test.ts`.

---

## 4. Les couleurs : pourquoi un parseur maison

Chromium **ne normalise pas tout en `rgb()`**. Une couleur déclarée en `oklch()`
— le format par défaut de Tailwind 4 et des générateurs de palettes récents —
ressort telle quelle dans les styles calculés. Figma, lui, ne travaille qu'en
sRGB.

Sans conversion, **toutes les couleurs d'un site moderne arriveraient fausses**.

`packages/sync/src/build/color.ts` couvre hex, `rgb()`, `hsl()`, `hwb()`,
`lab()`, `lch()`, `oklab()`, `oklch()`, `color()` dans six espaces, et les
couleurs nommées — chaque espace avec **sa propre fonction de transfert**
(appliquer la courbe sRGB à ProPhoto donnait 37/255 d'erreur).

La vérification est inhabituelle et vaut d'être signalée : `npm run verify-colors`
peint chaque couleur sur un `<canvas>` dans Chromium et relit les octets sRGB
réels. **33 cas, écart maximal 2/255** — la marge d'arrondi de sRGB 8 bits. Les
valeurs attendues des tests unitaires viennent de ce relevé, pas d'une
estimation.

---

## 5. Les tokens : le CSS fait autorité

Un site construit avec des variables `:root` **porte déjà son système de
design, noms compris**. On le transpose tel quel plutôt que de le deviner :
`--color-brand-600` devient `color/brand/600`.

Bénéfice direct : le développeur retrouve dans Figma le vocabulaire de son code.

Trois raffinements :

- **Les alias sont reproduits.** `--color-text: var(--color-neutral-900)` devient
  un alias de variable Figma, pas une copie de la couleur. Modifier la cible met
  à jour tout ce qui en dépend — comme en CSS.
- **Le découpage hiérarchique n'est appliqué que si le nom le porte.**
  `--max-width` donne `size/max-width`, pas `size/max/width` : deux niveaux de
  groupe pour une seule valeur rendraient le panneau Figma illisible.
- **Les collisions préfèrent la palette à l'alias sémantique.** Deux tokens de
  même valeur : lier un fond à `color/text` serait trompeur.

Bug corrigé en cours de route, à connaître : le relevé des variables prenait les
déclarations de `:root[data-theme="dark"]` **même quand ce sélecteur ne
s'applique pas**. Les valeurs sombres fuitaient dans le mode clair. Toute règle
est désormais testée avec `documentElement.matches(selectorText)`.

---

## 6. Les composants : inventaire, pas abstraction

**Les pages ne sont pas transformées en instances.** Elles restent un rendu
littéral et vérifiable du site ; les composants sont publiés à part.

Raison : une détection légèrement fausse qui remplace une carte par une instance
inexacte rend le fichier **moins** fiable qu'une frame ordinaire. Un développeur
a besoin d'une vérité exacte **et** d'un inventaire des motifs — pas d'une
abstraction approximative posée sur ses pages.

Deux règles apprises à l'usage sur un site réel :

- **Exclure les bandes pleine largeur.** Une section de page (héros, bandeau de
  chiffres, pied) se répète sur chaque page et passait donc le seuil, en
  éclipsant les vrais composants qu'elle contient.
- **Ne pas « réserver » les descendants.** Un bouton dans une carte est un
  composant à part entière : l'inventaire doit contenir les deux. Figma gère
  parfaitement les instances imbriquées.

Le nom vient de la **classe CSS**, pas du calque : le titre d'une carte
(« Organisation d'atelier ») nomme bien un calque de page, mais nomme mal un
composant qui vaut pour les six cartes. `carte-metier` décrit le motif.

---

## 7. L'idempotence : ce qui fait la valeur de l'outil

Chaque nœud Figma porte, dans ses données de plugin, l'identifiant stable (`sid`)
de sa contrepartie dans le site. Une seconde synchronisation retrouve les mêmes
nœuds et les met à jour **sur place**.

Sans cette garantie, chaque exécution détruirait les commentaires de revue, les
liens de prototype et le travail du développeur.

### Construction du `sid`

```
sid = <breakpoint>.<étiquette>.<hash(route | breakpoint | chemin DOM)>
```

Le chemin DOM **repart de zéro à chaque `id` HTML rencontré**. Conséquence :
insérer une bannière en haut de page ne change pas le `sid` des sections
ancrées — elles ne sont donc pas recréées dans Figma.

### Appariement en trois niveaux

1. `sid` identique — le cas normal ;
2. même type + même nom + même empreinte de contenu — rattrape un décalage
   d'indices sur un nœud sans `id` ;
3. même type à la même position — dernier recours.

### Mise à jour différentielle

Chaque nœud porte deux empreintes : `hash` (lui seul) et `subtreeHash` (lui et sa
descendance). Si le `subtreeHash` stocké dans Figma égale celui du spec, **tout
le sous-arbre est sauté**. Sur un site de plusieurs milliers de nœuds dont trois
mots ont changé, c'est la différence entre une synchronisation instantanée et une
réécriture complète.

### Les nœuds disparus sont archivés

La suppression n'est pas le comportement par défaut : un nœud qui disparaît peut
aussi venir d'une page temporairement en erreur. Ils sont déplacés dans une frame
`⚠︎ Retirés du site`, et leur `sid` est effacé — sinon la synchronisation suivante
les ressusciterait.

---

## 8. L'ordre d'écriture dans Figma n'est pas négociable

Figma **lève une exception** — il n'ignore pas silencieusement — quand :

- on écrit du texte dans une police non chargée ;
- on demande « Remplir le conteneur » hors d'un parent en auto-layout ;
- on demande « Ajuster au contenu » sur un nœud sans auto-layout propre.

Une exception au milieu de l'écriture laisserait le document de la cliente à
moitié synchronisé — le pire cas. D'où :

1. **toutes** les polices sont résolues et chargées **avant** la première
   écriture, substitutions comprises ;
2. le `design-spec` est **validé intégralement** avant que le plugin ne touche au
   document ;
3. un nœud est rattaché à son parent, puis reçoit ses enfants, **et seulement
   ensuite** son dimensionnement ;
4. chaque écriture risquée est encadrée et remontée comme avertissement plutôt
   que comme échec.

---

## 9. Comment le plugin est testé sans Figma

Figma n'est pas scriptable hors de son application. La réconciliation — le cœur
du système — ne pouvait pas rester sans test pour autant.

`packages/figma-plugin/test/fake-figma.mjs` implémente en mémoire la partie de
l'API qu'utilise le plugin, **y compris les règles qui lèvent une exception** :
polices non chargées, `FILL` hors auto-layout, `HUG` sans auto-layout propre.

Les 20 tests exercent le **vrai** code du plugin sur un `design-spec` réel et
vérifient notamment :

- une seconde synchronisation identique ne crée **aucune** couche ;
- les identifiants Figma des nœuds sont **préservés** (donc les commentaires) ;
- le document ne gonfle pas d'une synchronisation à l'autre ;
- un texte modifié ne rouvre que sa branche ;
- une couche disparue est archivée, `sid` effacé ;
- une police absente du poste déclenche une substitution, pas un échec ;
- la collection de tokens n'accumule pas de modes à chaque passage.

**Ce que cela ne remplace pas :** le plugin n'a pas encore été exécuté dans Figma
lui-même. La logique est validée, le typage l'est contre `@figma/plugin-typings`,
mais la première exécution réelle reste à faire.
