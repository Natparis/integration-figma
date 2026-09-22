# Fixtures

`design-spec.json` et `design-spec.bundle.json` sont de véritables extractions de
`examples/demo-site`, réduites à 2 pages × 2 breakpoints pour rester légères.

Pour les régénérer après un changement du format ou de l'extracteur :

```bash
npm run build
node packages/sync/dist/cli.js extract \
  --source ./examples/demo-site --out /tmp/fx \
  --breakpoints Desktop:1440,Mobile:390 --max-pages 2
node packages/sync/dist/cli.js bundle --source ./examples/demo-site --out /tmp/fx
cp /tmp/fx/design-spec.json /tmp/fx/design-spec.bundle.json \
   packages/figma-plugin/test/fixtures/
```
