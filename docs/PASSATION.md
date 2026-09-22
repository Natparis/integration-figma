# Note de passation — à transmettre au développeur

> Ce document accompagne le fichier Figma. Son équivalent est également généré
> **dans** le fichier, sur la page `Documentation`, avec les valeurs réelles de
> la dernière synchronisation.

## D'où vient ce fichier

Il n'a pas été dessiné : il a été **généré depuis le site en ligne** par
`site-to-figma-sync`. Chaque page a été chargée dans Chromium à trois largeurs
d'écran, et les styles réellement calculés ont été transposés en Figma.

Conséquence utile : **ce que vous voyez correspond au rendu du site**, pas à une
intention de maquette. Là où le site a un défaut, la maquette le reproduit — et
la page `Documentation` le signale.

## Comment lire le fichier

| Élément Figma                    | Origine dans le site                              |
|----------------------------------|---------------------------------------------------|
| Une page Figma                   | une page du site                                  |
| Une frame par page               | une largeur d'écran (1440 / 834 / 390 px)         |
| Auto-layout vertical             | flux de blocs, `flex-direction: column`, grille 1 colonne |
| Auto-layout horizontal           | `flex-direction: row`, grille 1 ligne             |
| Auto-layout + retour à la ligne  | `flex-wrap: wrap`, ou grille multi-colonnes       |
| « Remplir le conteneur »         | élément de bloc, `flex: 1`, ou `width: 100%`      |
| « Ajuster au contenu »           | élément de niveau ligne, ou `fit-content`         |
| « Fixe »                         | dimension réellement déclarée par l'auteur        |
| Largeur max sur une frame        | `max-width` déclaré                               |
| Couche en position absolue       | `position: absolute` / `fixed` / `sticky`         |

Les marges intérieures Figma **incluent l'épaisseur de bordure** : `getBoundingClientRect`
est en border-box, alors qu'un contour « intérieur » Figma ne prend pas de place.
Sans cette compensation, le contenu serait décalé.

## Les variables sont vos tokens

La collection `Design Tokens` reprend **les noms de vos variables CSS** :
`--color-brand-600` → `color/brand/600`. Les alias sont conservés : si votre CSS
écrit `--color-text: var(--color-neutral-900)`, la variable Figma `color/text`
est un **alias** de `color/neutral/900`, pas une copie.

Les variables marquées « Déduite par analyse » n'existaient pas dans le CSS :
elles ont été inférées à partir des valeurs récurrentes. Traitez-les comme une
proposition, pas comme une source.

## Dev Mode

Les couches structurantes (repères HTML, sections, éléments interactifs, titres)
portent une annotation avec **le sélecteur CSS d'origine** et les propriétés
calculées qui comptent. C'est le pont direct entre la maquette et le code
existant.

Toutes les couches, annotées ou non, portent ces données en `pluginData` :
`sfs:selector` et `sfs:css`.

## Ce que la maquette ne montre pas

- **États au survol, focus, actifs** — le navigateur n'en rend qu'un à la fois.
- **Animations et transitions** — neutralisées pour mesurer l'état final.
- **Éléments collés** — placés à leur position de repos.
- **Grilles à colonnes inégales** — rendues en auto-layout avec retour à la
  ligne ; les largeurs de colonnes sont à redéclarer.
- **Carrousels, onglets, accordéons** — seul l'état initial est capturé.

## Le fichier sera mis à jour

Quand le site évolue, une nouvelle synchronisation **met à jour les couches
existantes**. Elle n'en recrée aucune : vos commentaires, vos liens de prototype
et vos sélections restent en place.

Deux conséquences pratiques :

- **Ne renommez pas les couches gérées** si vous voulez que la correspondance
  reste lisible. Le renommage ne casse pas la synchronisation (l'appariement se
  fait sur un identifiant stocké, pas sur le nom), mais rend les diffs confus.
- **Ne travaillez pas dans la page `Documentation`** : elle est reconstruite à
  chaque synchronisation.

Si une couche apparaît dans la frame `⚠︎ Retirés du site`, c'est que sa
contrepartie a disparu du site. Vérifiez que ce n'est pas un incident de
publication avant de la supprimer.
