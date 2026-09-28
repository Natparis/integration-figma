/**
 * La page de l'application.
 *
 * Elle tient dans une seule fenetre et ne demande que deux choses : ou est le
 * site, et quel fichier Figma recevra la maquette. Tout le reste — extraction,
 * verification, envoi, mise a jour — se lit et se declenche depuis ici.
 *
 * Le parti pris visuel est celui des marques qu'elle sert : beaucoup de blanc,
 * une seule couleur d'accent, des majuscules espacees pour les intitules, et
 * aucune icone decorative. La sobriete n'est pas de l'austerite : c'est ce qui
 * permet de voir tout de suite ou on en est.
 */

export const PAGE = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site vers Figma</title>
<style>
  :root {
    --encre: #121212;
    --doux: #6b6b6b;
    --tres-doux: #9a9a9a;
    --bord: #e4e2de;
    --fond: #faf9f7;
    --carte: #ffffff;
    --accent: #1d4ed8;
    --vert: #0f7b46;
    --ambre: #a86a0b;
    --rouge: #b42318;
    --rayon: 10px;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --encre: #f2f0ed; --doux: #a8a49e; --tres-doux: #7c7872;
      --bord: #2e2c29; --fond: #131211; --carte: #1b1a18;
      --accent: #7aa2f7; --vert: #5bbd8b; --ambre: #d9a441; --rouge: #e5787a;
    }
  }
  :root[data-theme="dark"] {
    --encre: #f2f0ed; --doux: #a8a49e; --tres-doux: #7c7872;
    --bord: #2e2c29; --fond: #131211; --carte: #1b1a18;
    --accent: #7aa2f7; --vert: #5bbd8b; --ambre: #d9a441; --rouge: #e5787a;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--fond); color: var(--encre);
    font: 15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .page { max-width: 780px; margin: 0 auto; padding: 48px 16px 96px; }

  header { margin-bottom: 40px; }
  .marque {
    font-size: 11px; letter-spacing: .22em; text-transform: uppercase;
    color: var(--tres-doux); margin-bottom: 14px;
  }
  h1 { font-size: 30px; line-height: 1.2; font-weight: 500; margin: 0 0 10px; letter-spacing: -.01em; }
  .chapo { color: var(--doux); margin: 0; max-width: 56ch; }

  .carte {
    background: var(--carte); border: 1px solid var(--bord);
    border-radius: var(--rayon); padding: 24px; margin-bottom: 20px;
  }
  .carte h2 {
    font-size: 11px; letter-spacing: .18em; text-transform: uppercase;
    color: var(--tres-doux); margin: 0 0 18px; font-weight: 600;
  }

  label { display: block; margin-bottom: 18px; }
  label span.intitule { display: block; font-weight: 500; margin-bottom: 4px; }
  label span.aide { display: block; color: var(--doux); font-size: 13px; margin-bottom: 8px; }
  input[type="text"] {
    width: 100%; padding: 11px 13px; font: inherit; font-size: 14px;
    color: var(--encre); background: var(--fond);
    border: 1px solid var(--bord); border-radius: 8px;
  }
  input[type="text"]:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }

  .rangee { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  button {
    font: inherit; font-weight: 500; padding: 11px 22px; border-radius: 8px;
    border: 1px solid transparent; cursor: pointer;
  }
  button.principal { background: var(--encre); color: var(--fond); }
  button.principal:hover:not(:disabled) { opacity: .88; }
  button.second { background: transparent; color: var(--encre); border-color: var(--bord); }
  button.second:hover:not(:disabled) { border-color: var(--doux); }
  button:disabled { opacity: .45; cursor: default; }

  .etat { color: var(--doux); font-size: 13px; }
  .etat b { color: var(--encre); font-weight: 500; }

  #journal {
    display: none; margin-top: 18px; max-height: 280px; overflow-y: auto;
    background: var(--fond); border: 1px solid var(--bord); border-radius: 8px;
    padding: 14px 16px; font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 12.5px; line-height: 1.7;
  }
  #journal.visible { display: block; }
  #journal div { white-space: pre-wrap; word-break: break-word; }
  .l-etape { color: var(--encre); font-weight: 600; }
  .l-succes { color: var(--vert); }
  .l-alerte { color: var(--ambre); }
  .l-erreur { color: var(--rouge); }
  .l-info, .l-brut { color: var(--doux); }

  .etapes { counter-reset: pas; margin: 0; padding: 0; list-style: none; }
  .etapes li {
    counter-increment: pas; position: relative; padding-left: 34px; margin-bottom: 14px;
  }
  .etapes li::before {
    content: counter(pas); position: absolute; left: 0; top: 1px;
    width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--bord);
    display: grid; place-items: center; font-size: 12px; color: var(--doux);
  }
  code {
    background: var(--fond); border: 1px solid var(--bord); border-radius: 5px;
    padding: 1px 6px; font-family: ui-monospace, Consolas, monospace; font-size: 13px;
  }
  .adresse { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
  .adresse code { flex: 1; padding: 8px 10px; }

  .bilan { display: flex; gap: 28px; flex-wrap: wrap; margin-bottom: 4px; }
  .bilan div { min-width: 92px; }
  .bilan b { display: block; font-size: 22px; font-weight: 500; }
  .bilan span { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--tres-doux); }

  .avertissement {
    margin: 0; padding: 12px 14px; border-radius: 8px; font-size: 13.5px;
    background: color-mix(in srgb, var(--ambre) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--ambre) 35%, transparent);
  }
  .masque { display: none; }
  footer { color: var(--tres-doux); font-size: 12.5px; text-align: center; margin-top: 8px; }
</style>
</head>
<body>
<div class="page">

<header>
  <div class="marque">Site &rarr; Figma</div>
  <h1>Votre site, en maquette Figma</h1>
  <p class="chapo">
    Indiquez où se trouve le site et quel fichier Figma doit le recevoir.
    Les fois suivantes, un seul bouton suffira pour reprendre vos modifications.
  </p>
</header>

<section class="carte">
  <h2>La source</h2>
  <label>
    <span class="intitule">Votre site</span>
    <span class="aide">Un dépôt GitHub, l'adresse du site publié, ou un dossier sur cet ordinateur.</span>
    <input type="text" id="source" placeholder="https://github.com/mon-compte/mon-site" spellcheck="false">
  </label>
  <label>
    <span class="intitule">Votre fichier Figma</span>
    <span class="aide">Le lien du fichier qui recevra la maquette. Ouvrez-le dans Figma et copiez la barre d'adresse.</span>
    <input type="text" id="figma" placeholder="https://www.figma.com/design/…" spellcheck="false">
  </label>
  <div class="rangee">
    <button class="principal" id="lancer">Lancer l'intégration</button>
    <span class="etat" id="etat"></span>
  </div>
  <div id="journal"></div>
</section>

<section class="carte masque" id="carte-resultat">
  <h2>Ce qui a été lu</h2>
  <div class="bilan" id="bilan"></div>
  <p class="etat" id="changements"></p>
  <div class="rangee" style="margin-top:18px">
    <button class="second" id="voir-rapport">Vérifier la lecture</button>
    <span class="etat">Votre site et ce qui en a été compris, côte à côte.</span>
  </div>
  <p class="etat" style="margin-bottom:6px">
    Le rapport est aussi un fichier sur votre disque : ouvrez-le directement si
    cette fenêtre ne répond plus.
  </p>
  <div class="adresse">
    <code id="chemin-rapport"></code>
    <button class="second" id="copier-rapport">Copier</button>
  </div>
</section>

<section class="carte masque" id="carte-figma">
  <h2>Envoyer dans Figma</h2>
  <ol class="etapes">
    <li>
      Dans Figma, ouvrez le fichier de destination, puis appuyez sur <code>Ctrl + /</code>
      et tapez <code>Site</code>.
    </li>
    <li>
      Lancez <b>Site &rarr; Figma Sync</b>. Collez cette adresse si elle n'y est pas déjà,
      puis cliquez sur <b>Synchroniser</b>.
      <div class="adresse">
        <code id="adresse-relais"></code>
        <button class="second" id="copier">Copier</button>
      </div>
    </li>
    <li>Laissez cette fenêtre ouverte pendant la synchronisation.</li>
  </ol>
  <p class="etat" id="retour-plugin"></p>
</section>

<section class="carte masque" id="carte-plugin">
  <h2>Première fois seulement</h2>
  <p class="avertissement">
    À faire dans l'<b>application Figma installée sur votre ordinateur</b>, pas dans
    le navigateur : Figma sur le web ne sait pas importer un plugin.
    Elle se télécharge sur <b>figma.com/downloads</b>.
  </p>
  <ol class="etapes" style="margin-top:16px">
    <li>Ouvrez votre fichier dans l'application Figma (il est dans « Brouillons »).</li>
    <li>
      Appuyez sur <code>Ctrl + /</code> et tapez <code>manifeste</code>
      (ou <code>manifest</code> si votre Figma est en anglais).
    </li>
    <li>
      Choisissez <b>Importer un plugin depuis le manifeste…</b>, puis
      sélectionnez ce fichier :
      <div class="adresse">
        <code id="chemin-manifeste"></code>
        <button class="second" id="copier-manifeste">Copier</button>
      </div>
    </li>
  </ol>
</section>

<footer id="pied"></footer>

</div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var source = $('source'), figma = $('figma'), lancer = $('lancer');
  var etat = $('etat'), journal = $('journal');
  var enCours = false, aDejaUneMaquette = false;

  function afficher(id, visible) { $(id).classList.toggle('masque', !visible); }

  function ecrire(niveau, message) {
    journal.classList.add('visible');
    var ligne = document.createElement('div');
    ligne.className = 'l-' + niveau;
    ligne.textContent = message;
    journal.appendChild(ligne);
    journal.scrollTop = journal.scrollHeight;
  }

  function majBouton() {
    lancer.textContent = aDejaUneMaquette ? 'Reprendre les modifications du site' : "Lancer l'intégration";
  }

  function montrerBilan(e) {
    if (!e.revision) return;
    aDejaUneMaquette = true;
    majBouton();
    afficher('carte-resultat', true);
    afficher('carte-figma', true);
    afficher('carte-plugin', true);
    $('bilan').innerHTML =
      '<div><b>' + e.pages + '</b><span>pages</span></div>' +
      '<div><b>' + e.calques + '</b><span>calques</span></div>' +
      '<div><b>' + e.assets + '</b><span>images</span></div>';
    $('changements').textContent = e.changements || '';
    $('adresse-relais').textContent = e.relais;
    $('chemin-rapport').textContent = e.rapportFichier || '';
    $('chemin-manifeste').textContent = e.manifeste;
    $('pied').textContent = e.quand ? 'Dernière lecture : ' + e.quand : '';
  }

  function copier(bouton, source) {
    bouton.addEventListener('click', function () {
      navigator.clipboard.writeText($(source).textContent).then(function () {
        var avant = bouton.textContent;
        bouton.textContent = 'Copié';
        setTimeout(function () { bouton.textContent = avant; }, 1400);
      });
    });
  }
  copier($('copier'), 'adresse-relais');
  copier($('copier-manifeste'), 'chemin-manifeste');
  copier($('copier-rapport'), 'chemin-rapport');

  /*
   * Surveillance du serveur.
   *
   * Si la fenetre noire est fermee, la page reste affichee mais ses boutons ne
   * mènent plus nulle part : le navigateur repond « ce site est inaccessible »,
   * message qui n'aide personne. Mieux vaut le dire ici, avec la marche a
   * suivre.
   */
  var perdu = false;
  function signalerPerte() {
    if (perdu) return;
    perdu = true;
    etat.textContent = '';
    var alerte = document.createElement('div');
    alerte.className = 'carte';
    alerte.style.borderColor = 'var(--ambre)';
    alerte.innerHTML =
      '<h2 style="color:var(--ambre)">La fenêtre de travail est fermée</h2>' +
      '<p class="etat" style="margin-top:0">Le programme qui fait tourner cette page ne répond plus. ' +
      'Vos fichiers sont intacts : le rapport reste lisible depuis le disque, à l’adresse indiquée plus haut.</p>' +
      '<p class="etat">Pour reprendre : double-cliquez sur le raccourci ' +
      '<b>Site vers Figma</b> de votre Bureau, puis revenez ici et actualisez la page.</p>';
    document.querySelector('.page').insertBefore(alerte, document.querySelector('.carte'));
    lancer.disabled = true;
  }

  $('voir-rapport').addEventListener('click', function () {
    // On verifie que le serveur repond AVANT d'ouvrir un onglet : un onglet
    // « site inaccessible » laisse croire que le rapport n'existe pas.
    fetch('/health')
      .then(function () { window.open('/rapport', '_blank'); })
      .catch(signalerPerte);
  });

  fetch('/etat').then(function (r) { return r.json(); }).then(function (e) {
    source.value = e.source || '';
    figma.value = e.figma || '';
    montrerBilan(e);
    majBouton();
  });

  lancer.addEventListener('click', function () {
    if (enCours) return;
    if (!source.value.trim()) { etat.textContent = "Indiquez d'abord où se trouve votre site."; source.focus(); return; }
    enCours = true;
    lancer.disabled = true;
    etat.textContent = 'Lecture du site en cours — comptez une minute.';
    journal.innerHTML = '';
    journal.classList.add('visible');

    fetch('/lancer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: source.value.trim(), figma: figma.value.trim() }),
    }).then(function (r) { return r.json(); }).then(function (reponse) {
      enCours = false;
      lancer.disabled = false;
      if (reponse.ok) {
        etat.textContent = 'Lecture terminée.';
        montrerBilan(reponse.etat);
      } else {
        etat.textContent = 'La lecture n\\'a pas abouti.';
      }
    }).catch(function () {
      enCours = false; lancer.disabled = false;
      etat.textContent = 'La lecture a été interrompue.';
    });
  });

  var flux = new EventSource('/flux');
  flux.addEventListener('error', function () {
    // Une extraction longue ne coupe pas le flux : seule la disparition du
    // serveur le ferme definitivement.
    if (flux.readyState === EventSource.CLOSED) signalerPerte();
  });
  flux.addEventListener('ligne', function (e) {
    var d = JSON.parse(e.data);
    ecrire(d.niveau, d.message);
  });
  flux.addEventListener('plugin', function (e) {
    var d = JSON.parse(e.data);
    $('retour-plugin').textContent = d.texte;
  });
})();
</script>
</body>
</html>`;
