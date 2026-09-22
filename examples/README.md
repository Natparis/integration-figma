# Site de démonstration

`demo-site/` est un site statique volontairement représentatif de ce que produit
un outil de design moderne : variables `:root` en `oklch()`, mode sombre par
`data-theme`, flexbox et grilles CSS, cartes répétées, icônes SVG en ligne, image
bitmap, formulaire, et trois paliers de media queries.

Il sert à exercer le pipeline de bout en bout sans dépendre d'un site en ligne :

```bash
npm run sfs -- extract --source ./examples/demo-site --out /tmp/demo
npm run sfs -- bundle  --source ./examples/demo-site --out /tmp/demo
```

Il porte aussi un défaut **volontairement conservé** : le `<button>` de la page
contact n'hérite pas de `font-family` et s'affiche donc en Arial au milieu d'un
site en Inter. L'extracteur le détecte et le signale — c'est exactement le genre
d'anomalie qu'une relecture humaine laisse passer et qu'une maquette générée rend
visible.
