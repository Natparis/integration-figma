# Conventions de travail sur ce dépôt

## Avec qui l'on travaille

Nathalie Vasseur n'est pas développeuse. Elle pilote un projet pour son client
(LVMH, « Les Ateliers de Savoir-Faire ») et doit lui livrer un fichier Figma
exploitable par un développeur.

Conséquences pratiques :

- **Écrire en français**, sans jargon, et nommer les gestes précisément :
  « double-cliquez sur `demarrer` », et non « lancez le build ».
- **Un message, une action à faire.** Les listes d'options la bloquent ; trancher
  à sa place et dire ce qu'on a choisi.
- Devant un message d'erreur, **dire d'abord ce qu'il signifie**, ensuite quoi
  faire.
- Ne pas lui faire porter un diagnostic : le logiciel écrit
  `.sfs/comparaison.html` et `.sfs/releve.txt` pour ça.

## Autorisation permanente

*Enregistré le 28 septembre 2026, à sa demande explicite : « j'autorise
toujours ».*

Elle autorise par avance les actions nécessaires à l'avancement de ce projet :
lire et écrire dans ce dépôt, publier sur ses dépôts GitHub, exécuter du code
dans ses fichiers Figma via le serveur MCP Figma. **Ne pas redemander
confirmation à chaque étape** — agir, puis rendre compte de ce qui a été fait.

Cette autorisation ne couvre pas : supprimer son travail sans prévenir, changer
la visibilité d'un dépôt, ni agir en dehors de ce projet. Pour ces cas-là,
demander.

## Ce qui ne se néglige pas

- **Ne jamais annoncer qu'une correction fonctionne sans l'avoir vérifiée.** Un
  test qui ne tombe pas quand on retire le correctif ne prouve rien : le
  vérifier dans les deux sens, systématiquement.
- **Le rapport de comparaison passe avant Figma.** Un écart visible dans
  `.sfs/comparaison.html` se retrouvera dans la maquette ; le corriger avant de
  synchroniser, plutôt que de remplir Figma avec du faux.
- Les commentaires de code expliquent **pourquoi**, en citant le symptôme réel
  qui a motivé la règle. Voir `docs/ARCHITECTURE.md` pour le ton attendu.

## Deux voies vers Figma

1. **Le plugin, sur son poste** — `outils/demarrer.mjs`, puis `sfs app`. Voie
   normale : pleine résolution, auto-layout, mise à jour calque par calque sans
   rien détruire.
2. **La passerelle à distance** — `outils/vers-figma.mjs` avec le serveur MCP
   Figma, pour construire sans accès à son poste. Limites établies par l'essai :
   positionnement absolu au lieu de l'auto-layout ; `fetch` n'existe pas dans le
   bac à sable Figma ; l'hôte d'envoi d'images est refusé depuis
   l'environnement ; `figma.createImage` accepte en revanche des octets
   embarqués, donc les images voyagent en base64 dans des scripts plafonnés à
   50 000 caractères — et doivent être redimensionnées.
