/* notes-viewer.js — lecteur des NotesPubliques.
 *
 * Successeur de md_to_html.js. Ce qu'il ajoute :
 *
 *   - frontmatter YAML lu et affiché comme fiche d'identité de la note ;
 *   - liens [[wiki]] résolus via un index construit une fois, donc corrects
 *     même quand la cible est dans un autre dossier ;
 *   - assainissement du HTML (DOMPurify) : le Markdown vient d'un dépôt,
 *     donc de données ;
 *   - coloration syntaxique, Mermaid, tables ;
 *   - rendu des dessins Excalidraw d'Obsidian, en note entière comme en
 *     transclusion ![[schema.excalidraw]], qu'ils soient enregistrés en
 *     « .excalidraw.md » ou en JSON brut « .excalidraw » ;
 *   - transclusion de notes et de sections, ![[Note]] et ![[Note#Section]],
 *     telle qu'Obsidian l'affiche — c'est ainsi que sont composés les
 *     « Livres de cours » ;
 *   - callouts Obsidian (> [!info] Titre) rendus comme des encadrés ;
 *   - index hiérarchique pour les dossiers à sous-dossiers (un livre par
 *     sous-dossier, son sommaire en tête) ;
 *   - sommaire, recherche plein texte, navigation clavier.
 *
 * Aucune étape de compilation : le fichier se charge tel quel dans la page.
 */
(function () {
  "use strict";

  const DEPOT = {
    proprietaire: "michaellaunay",
    nom: "NotesPubliques",
    branche: "master",
  };
  const RACINE_API = `https://api.github.com/repos/${DEPOT.proprietaire}/${DEPOT.nom}`;
  // Sentinelle de fraîcheur : le type de média « sha » fait renvoyer le seul SHA
  // du dernier commit, en texte brut — une quarantaine d'octets, contre plusieurs
  // centaines de kilo-octets pour l'arbre complet.
  const API_SHA = `${RACINE_API}/commits/${DEPOT.branche}`;
  const arbreDe = (ref) => `${RACINE_API}/git/trees/${ref}?recursive=1`;
  const brutDe = (ref) =>
    `https://raw.githubusercontent.com/${DEPOT.proprietaire}/${DEPOT.nom}/${ref}/`;

  // Repointé sur le SHA du commit dès que celui-ci est connu. Une URL portant un
  // SHA désigne un contenu immuable : le « cache-control: max-age=300 » de
  // raw.githubusercontent.com ne peut alors plus servir une version périmée,
  // puisque c'est l'URL elle-même qui change quand le dépôt change.
  let BRUT = brutDe(DEPOT.branche);
  const ACCUEIL = "_INDEX PRINCIPAL.md";
  // Fichiers présents dans le dépôt mais qui ne sont pas des notes du coffre.
  const HORS_COFFRE = /^(README|LICENSE|CNAME|Versions)$/i;

  // Le greffon Excalidraw d'Obsidian enregistre ses dessins en « .excalidraw.md »,
  // mais il sait aussi conserver le fichier JSON brut « .excalidraw » — et
  // excalidraw-svg.js lit les deux. Un dessin brut doit donc être indexé comme
  // une note : c'est la seule façon pour qu'un lien [[Schéma.excalidraw]] se
  // résolve, au lieu d'être rendu grisé comme « note non publiée ».
  const estNote = (chemin) => /\.(md|excalidraw)$/i.test(chemin);
  const estDessin = (chemin) => /\.excalidraw(\.md)?$/i.test(chemin);

  /* ------------------------------------------------------------ index ---- */
  let INDEX = null;    // [{chemin, nom, dossier}]
  let FICHIERS = null; // {nomDeFichier: [chemins]}

  // La clé porte un numéro de version. Sans lui, un cache écrit par une version
  // antérieure — un simple tableau, là où l'on attend maintenant
  // {sha, index, fichiers} — laisse INDEX à undefined, et la première boucle lève
  // une TypeError qui fige la page sur « Chargement… ». Changer la forme d'un
  // cache impose de changer sa clé.
  //
  // v3 : le cache est désormais estampillé par le SHA du commit qui l'a produit,
  // et conservé dans localStorage. Les versions précédentes cachaient l'index
  // dans sessionStorage sans aucune marque de fraîcheur : tant que l'onglet
  // restait ouvert, l'index survivait à un Ctrl+Maj+R (le rechargement forcé vide
  // le cache HTTP, jamais le sessionStorage) et le dépôt pouvait changer sans que
  // la page s'en aperçoive jamais. Seule une fenêtre privée, dont le stockage est
  // vierge, montrait le dépôt à jour — c'était exactement le symptôme observé.
  const CLE_CACHE = "np-index-v3";
  const CLES_OBSOLETES = ["np-index", "np-index-v2"];

  function cacheValide(c) {
    return c && typeof c.sha === "string" && c.sha
      && Array.isArray(c.index) && c.fichiers && typeof c.fichiers === "object";
  }

  function purgerAnciensCaches() {
    for (const cle of CLES_OBSOLETES) {
      try { localStorage.removeItem(cle); } catch (e) { /* indisponible */ }
      try { sessionStorage.removeItem(cle); } catch (e) { /* indisponible */ }
    }
  }

  function lireCache() {
    try {
      const brut = localStorage.getItem(CLE_CACHE);
      if (!brut) return null;
      const c = JSON.parse(brut);
      if (cacheValide(c)) return c;
      localStorage.removeItem(CLE_CACHE); // forme inattendue : on repart de zéro
    } catch (e) {
      /* stockage indisponible ou JSON corrompu : on rechargera depuis le réseau */
    }
    return null;
  }

  function ecrireCache(sha, index, fichiers) {
    try {
      localStorage.setItem(CLE_CACHE, JSON.stringify({ sha, index, fichiers }));
    } catch (e) {
      /* quota dépassé : on se passe du cache */
    }
  }

  /** SHA du dernier commit de la branche suivie.
   *
   *  `cache: "no-store"` n'est pas décoratif : sans lui, le cache HTTP du
   *  navigateur peut resservir un ancien SHA, et la sentinelle validerait alors
   *  un index tout aussi périmé — on aurait déplacé le bogue, pas corrigé. */
  async function shaDistant() {
    const rep = await fetch(API_SHA, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github.sha" },
    });
    if (!rep.ok) throw new Error(`HTTP ${rep.status}`);
    const sha = (await rep.text()).trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("réponse inattendue");
    return sha;
  }

  /** Bandeau discret signalant que l'on affiche un index dont on n'a pas pu
   *  vérifier la fraîcheur (quota API atteint, réseau coupé). */
  function signalerIndexNonVerifie() {
    if (document.getElementById("np-avis-cache")) return;
    const avis = document.createElement("p");
    avis.id = "np-avis-cache";
    avis.className = "np-erreur";
    avis.textContent = "Index affiché depuis le cache local : sa fraîcheur n'a pas "
      + "pu être vérifiée auprès de GitHub (quota horaire ou réseau).";
    const cible = document.querySelector("main");
    if (cible) cible.insertBefore(avis, cible.firstChild);
  }

  function adopter(sha, index, fichiers) {
    BRUT = brutDe(sha);
    INDEX = index;
    FICHIERS = fichiers;
    return INDEX;
  }

  async function chargerIndex() {
    if (INDEX) return INDEX;
    purgerAnciensCaches();
    const cache = lireCache();

    // 1. Sentinelle : une requête minuscule qui dit si le dépôt a bougé.
    let sha = null;
    try {
      sha = await shaDistant();
    } catch (e) {
      // Sentinelle injoignable. Un index un peu vieux vaut mieux qu'une page
      // vide : on repart du cache s'il en existe un, en le disant.
      if (cache) {
        signalerIndexNonVerifie();
        return adopter(cache.sha, cache.index, cache.fichiers);
      }
    }

    // 2. Dépôt inchangé depuis le calcul du cache : rien à retélécharger.
    if (sha && cache && cache.sha === sha) return adopter(sha, cache.index, cache.fichiers);

    // 3. Dépôt modifié (ou premier chargement) : on reconstruit l'index.
    const ref = sha || DEPOT.branche;
    const rep = await fetch(arbreDe(ref), { cache: "no-store" });
    if (!rep.ok) {
      if (cache) {
        signalerIndexNonVerifie();
        return adopter(cache.sha, cache.index, cache.fichiers);
      }
      throw new Error(rep.status === 403 || rep.status === 429
        ? "l'API GitHub a temporairement limité les requêtes depuis cette adresse "
          + "(quota horaire). Réessayez dans quelques minutes."
        : `index indisponible (HTTP ${rep.status})`);
    }
    const arbre = await rep.json();
    const blobs = (arbre.tree || []).filter((n) => n.type === "blob");
    const index = blobs
      .filter((n) => estNote(n.path))
      .map((n) => ({
        chemin: n.path,
        nom: n.path.replace(/\.md$/, "").split("/").pop(),
        dossier: n.path.includes("/") ? n.path.split("/").slice(0, -1).join("/") : "",
      }));
    // Les pièces jointes doivent être indexées elles aussi : les dessins
    // Excalidraw référencent leurs images par nom de fichier, pas par chemin.
    const fichiers = {};
    for (const n of blobs) {
      if (estNote(n.path)) continue;
      const nom = n.path.split("/").pop();
      if (!(nom in fichiers)) fichiers[nom] = [];
      fichiers[nom].push(n.path);
    }
    // Sans SHA on ne sait pas estampiller le cache : mieux vaut ne rien écrire
    // que d'écrire un index qu'on ne saura jamais invalider.
    if (sha) ecrireCache(sha, index, fichiers);
    return adopter(ref, index, fichiers);
  }

  // Trappe de secours, utile depuis la console en cas de doute.
  window.npViderCache = function () {
    try { localStorage.removeItem(CLE_CACHE); } catch (e) { /* indisponible */ }
    purgerAnciensCaches();
    location.reload();
  };

  /** Résout un lien [[Nom]] ou [[dossier/Nom]] vers un chemin réel.
   *  En cas d'homonymie, la note du même dossier que la note courante gagne :
   *  c'est la règle d'Obsidian, et elle évite d'ouvrir la mauvaise fiche. */
  function resoudre(cible, dossierCourant) {
    if (!INDEX) return null;
    const propre = cible.replace(/\.md$/, "").trim();
    const exact = INDEX.find((n) => n.chemin.replace(/\.md$/, "") === propre);
    if (exact) return exact.chemin;
    const candidats = INDEX.filter((n) => n.nom === propre);
    if (!candidats.length) return null;
    if (candidats.length === 1) return candidats[0].chemin;
    const local = candidats.find((n) => n.dossier === dossierCourant);
    return (local || candidats[0]).chemin;
  }

  /** Résout une pièce jointe (image, dessin) vers son URL brute.
   *  Comme pour les notes, l'homonymie est tranchée par la proximité de dossier. */
  function resoudreFichier(cible, dossierCourant) {
    if (!FICHIERS || !cible) return null;
    let nom = cible.replace(/^!?\[\[|\]\]$/g, "").trim();
    if (/\.excalidraw$/i.test(nom)) nom += ".md";
    const direct = nom.includes("/") ? nom : null;
    let chemin = null;
    if (direct && (FICHIERS[direct.split("/").pop()] || []).includes(direct)) {
      chemin = direct;
    } else {
      const candidats = FICHIERS[nom.split("/").pop()] || [];
      if (!candidats.length) return null;
      chemin = candidats.find((c) => c.startsWith(dossierCourant + "/")) ||
        candidats.find((c) => c.split("/").slice(0, -1).join("/").startsWith(dossierCourant)) ||
        candidats[0];
    }
    return BRUT + chemin.split("/").map(encodeURIComponent).join("/");
  }

  /* ---------------------------------------------------------- ancres ---- */
  /** Une seule règle d'ancre pour les liens [[Note#Section]], les identifiants
   *  des titres et le sommaire : sans cela, un lien vers une section n'atterrit
   *  jamais au bon endroit. Les accents sont conservés (ce sont des ids valides). */
  function slug(texte) {
    return String(texte).trim().toLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/[^\w\u00C0-\u017F]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function attr(valeur) {
    return String(valeur).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  /** Donne un id à chaque titre ; un préfixe sépare les titres d'une note
   *  transcluse de ceux de la note hôte. */
  function identifierTitres(racine, prefixe) {
    racine.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
      if (!h.id) h.id = (prefixe ? prefixe + "--" : "") + slug(h.textContent);
    });
  }

  /* ------------------------------------------------------- frontmatter ---- */
  function separerFrontmatter(texte) {
    if (!texte.startsWith("---\n")) return { meta: null, corps: texte };
    const fin = texte.indexOf("\n---\n", 3);
    if (fin === -1) return { meta: null, corps: texte };
    let meta = null;
    try {
      meta = jsyaml.load(texte.slice(4, fin + 1));
    } catch (e) {
      meta = null;
    }
    return { meta, corps: texte.slice(fin + 5) };
  }

  const ETIQUETTES = {
    type: "Type", statut: "Statut", niveau: "Niveau", langue: "Langue",
    date_creation: "Créée le", date_modification: "Modifiée le",
    date_verification: "Vérifiée le", source_type: "Support",
  };

  function carteMeta(meta) {
    if (!meta) return "";
    const puces = [];
    for (const [cle, libelle] of Object.entries(ETIQUETTES)) {
      if (meta[cle]) puces.push(`<span class="np-tag"><b>${libelle}</b> ${meta[cle]}</span>`);
    }
    for (const t of meta.themes || []) puces.push(`<span class="np-theme">${t}</span>`);
    const resume = meta.resume ? `<p class="np-resume">${meta.resume}</p>` : "";
    const auteurs = (meta.source_auteurs || []).join(", ");
    const src = meta.source_url && meta.source_url.length
      ? `<p class="np-source">Source : <a href="${meta.source_url[0]}" rel="noopener">${meta.source_titre || meta.source_url[0]}</a>${auteurs ? ` — ${auteurs}` : ""}</p>`
      : "";
    return `<aside class="np-meta">${resume}<div class="np-tags">${puces.join("")}</div>${src}</aside>`;
  }

  /* ------------------------------------------------------------ rendu ---- */
  function preparerMarked() {
    marked.setOptions({
      gfm: true,
      breaks: false,
      headerIds: true,
      mangle: false,
      highlight(code, lang) {
        if (lang === "mermaid") return code;
        if (window.hljs && lang && hljs.getLanguage(lang)) {
          try { return hljs.highlight(code, { language: lang }).value; } catch (e) { /* ignore */ }
        }
        return window.hljs ? hljs.highlightAuto(code).value : code;
      },
    });
  }

  /** Les liens et transclusions Obsidian sont traités AVANT Markdown,
   *  sinon `[[a|b]]` est mangé par l'analyseur de liens standard. */
  function transformerLiensObsidian(md, dossier) {
    // transclusion : ![[fichier]] pour une image ou un dessin, ![[Note]] ou
    // ![[Note#Section]] pour du contenu, rendu après coup par rendreTransclusions
    md = md.replace(/!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (m, cibleBrute, alias) => {
      const [cible, ancre] = cibleBrute.split("#");
      const propre = cible.trim();
      if (/\.excalidraw(\.md)?$/i.test(propre)) {
        const chemin = resoudre(propre.endsWith(".md") ? propre : propre + ".md", dossier);
        return chemin ? `\n<div class="np-excalidraw" data-src="${chemin}"></div>\n` : `*(dessin introuvable : ${propre})*`;
      }
      if (/\.(png|jpe?g|gif|svg|webp)$/i.test(propre)) {
        const rel = propre.includes("/") ? propre : (dossier ? dossier + "/" + propre : propre);
        return `![${alias || propre}](${BRUT}${rel.split("/").map(encodeURIComponent).join("/")})`;
      }
      const chemin = resoudre(propre, dossier);
      if (!chemin) return `*(note non publiée : ${propre}${ancre ? " › " + ancre.trim() : ""})*`;
      const a = ancre ? ` data-ancre="${attr(ancre.trim())}"` : "";
      return `\n<div class="np-transclusion" data-note="${attr(chemin)}"${a}></div>\n`;
    });
    // lien simple : [[cible|alias]]
    md = md.replace(/\[\[([^\]|#]+?)(?:#([^\]|]+))?(?:\|([^\]]*))?\]\]/g, (m, cible, ancre, alias) => {
      const chemin = resoudre(cible.trim(), dossier);
      const texte = alias || cible.trim();
      if (!chemin) return `<span class="np-lien-mort" title="note non publiée">${texte}</span>`;
      const frag = ancre ? "#" + encodeURIComponent(slug(ancre)) : "";
      return `[${texte}](?note=${encodeURIComponent(chemin)}${frag})`;
    });
    return md;
  }

  function reecrireImagesRelatives(racine, dossier) {
    racine.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (/^(https?:|data:)/.test(src)) return;
      const rel = src.startsWith("/") ? src.slice(1) : (dossier ? dossier + "/" + src : src);
      img.src = BRUT + rel.split("/").map(encodeURIComponent).join("/");
      img.loading = "lazy";
    });
  }

  function sommaire(racine) {
    const titres = [...racine.querySelectorAll("h2, h3")];
    if (titres.length < 3) return "";
    const items = titres.map((h) => {
      if (!h.id) h.id = slug(h.textContent);
      const cls = h.tagName === "H3" ? ' class="np-toc-3"' : "";
      return `<li${cls}><a href="#${h.id}">${h.textContent}</a></li>`;
    });
    return `<nav class="np-toc"><b>Sommaire</b><ul>${items.join("")}</ul></nav>`;
  }

  /* ------------------------------------------------------ chargement ---- */
  async function lire(chemin) {
    const url = BRUT + chemin.split("/").map(encodeURIComponent).join("/");
    const rep = await fetch(url);
    if (!rep.ok) throw new Error(`${chemin} — HTTP ${rep.status}`);
    return rep.text();
  }

  function fildAriane(chemin) {
    const morceaux = chemin.replace(/\.excalidraw(\.md)?$|\.md$/i, "").split("/");
    const nom = morceaux.pop();
    const dossiers = morceaux.map((d, i) =>
      `<a href="?dossier=${encodeURIComponent(morceaux.slice(0, i + 1).join("/"))}">${d}</a>`).join(" › ");
    return `<p class="np-ariane"><a href="?">Notes</a>${dossiers ? " › " + dossiers : ""} › <b>${nom}</b></p>`;
  }

  async function afficherNote(chemin) {
    const cible = document.getElementById("np-contenu");
    cible.innerHTML = '<p class="np-attente">Chargement…</p>';
    const dossier = chemin.includes("/") ? chemin.split("/").slice(0, -1).join("/") : "";

    // Un dessin se rend directement : rendreExcalidraw lit le fichier lui-même,
    // et le lire une première fois ici doublerait le téléchargement — un plan de
    // cours avec ses images pèse plusieurs mégaoctets.
    if (estDessin(chemin)) {
      document.title = `${chemin.replace(/\.excalidraw(\.md)?$/i, "").split("/").pop()} — Notes | Logikascium`;
      cible.innerHTML = fildAriane(chemin) + '<div class="np-excalidraw" data-src="' + attr(chemin) + '"></div>';
      await rendreExcalidraw(cible);
      return;
    }

    let texte;
    try {
      texte = await lire(chemin);
    } catch (e) {
      cible.innerHTML = `<div class="np-erreur"><h2>Note indisponible</h2><p>${e.message}</p>
        <p>Cette note n'est peut-être pas publiée : <code>NotesPubliques</code> est un
        sous-ensemble filtré des notes privées.</p><p><a href="?">Revenir à l'index</a></p></div>`;
      return;
    }

    const { meta, corps } = separerFrontmatter(texte);

    // Garde-fou : une note qui traverse encore le filtre de publication ne doit
    // pas s'afficher ici. Ce n'est pas une protection — le fichier reste dans le
    // dépôt et dans son historique — mais cela évite qu'une note retirée reste
    // lisible par son URL directe entre deux réécritures d'historique.
    if (meta && (meta.confidentialite !== "publique"
                 || !(meta.publication || []).includes("notes-publiques"))) {
      cible.innerHTML = fildAriane(chemin) + `<div class="np-erreur">
        <h2>Note non publiée</h2>
        <p>Cette note porte <code>confidentialite: ${meta.confidentialite || "—"}</code>
           et n'est pas destinée au domaine public.</p>
        <p><a href="?">Revenir à l'index</a></p></div>`;
      document.title = "Note non publiée — Logikascium";
      return;
    }
    const md = transformerLiensObsidian(corps, dossier);
    const html = assainir(marked.parse(md));

    const titre = (meta && meta.titre) || chemin.replace(/\.md$/, "").split("/").pop();
    document.title = `${titre} — Notes | Logikascium`;

    const article = document.createElement("article");
    article.className = "np-note";
    article.innerHTML = html;
    reecrireImagesRelatives(article, dossier);
    identifierTitres(article, "");
    rendreCallouts(article);

    cible.innerHTML = fildAriane(chemin) + carteMeta(meta) + sommaire(article) + article.outerHTML;

    const rendu = cible.querySelector(".np-note");
    await rendreTransclusions(rendu, [chemin]);
    rendreMermaid(rendu);
    await rendreExcalidraw(cible);
    rendreFormules(rendu);
    if (location.hash) {
      const c = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (c) c.scrollIntoView();
    }
  }

  function assainir(html) {
    return DOMPurify.sanitize(html, {
      ADD_TAGS: ["foreignObject"],
      ADD_ATTR: ["target", "data-src", "data-note", "data-ancre"],
    });
  }

  function rendreMermaid(racine) {
    if (!window.mermaid || !racine) return;
    racine.querySelectorAll("pre code.language-mermaid, pre code.mermaid").forEach((c) => {
      const d = document.createElement("div");
      d.className = "mermaid";
      d.textContent = c.textContent;
      c.closest("pre").replaceWith(d);
    });
    try { mermaid.run({ querySelector: ".np-note .mermaid" }); } catch (e) { /* ignore */ }
  }

  /* ---------------------------------------------------------- callouts ---- */
  const CALLOUTS = {
    info: "Info", tip: "Conseil", note: "Note", abstract: "Résumé", summary: "Résumé",
    warning: "Attention", danger: "Danger", error: "Erreur", example: "Exemple",
    quote: "Citation", question: "Question", success: "Succès", failure: "Échec",
    bug: "Bogue", todo: "À faire",
  };

  /** Un callout Obsidian est une citation dont la première ligne est
   *  « [!type] Titre ». Markdown en fait un blockquote ordinaire ; on le
   *  transforme en encadré typé après assainissement. */
  function rendreCallouts(racine) {
    racine.querySelectorAll("blockquote").forEach((bq) => {
      const p = bq.querySelector(":scope > p");
      if (!p) return;
      const m = p.innerHTML.match(/^\[!([\w-]+)\][+-]?[ \t]*([^<\n]*)(?:\n|<br\s*\/?>\n?|$)/i);
      if (!m) return;
      const type = m[1].toLowerCase();
      const titre = (m[2] || "").trim() || CALLOUTS[type] || type;
      p.innerHTML = p.innerHTML.slice(m[0].length);
      if (!p.innerHTML.trim()) p.remove();
      const div = document.createElement("div");
      div.className = `np-callout np-callout-${type}`;
      div.innerHTML = `<p class="np-callout-titre">${titre}</p>`;
      while (bq.firstChild) div.appendChild(bq.firstChild);
      bq.replaceWith(div);
    });
  }

  /* ---------------------------------------------------- transclusions ---- */
  const CACHE_NOTES = new Map();

  function lireEnCache(chemin) {
    if (!CACHE_NOTES.has(chemin)) CACHE_NOTES.set(chemin, lire(chemin));
    return CACHE_NOTES.get(chemin);
  }

  /** La section « ancre » d'une note : du titre correspondant jusqu'au
   *  prochain titre de niveau égal ou supérieur, blocs de code exclus de la
   *  détection. null si le titre n'existe pas. */
  function extraireSection(corps, ancre) {
    const lignes = corps.split("\n");
    const voulu = slug(ancre);
    let dansCode = false, debut = -1, niveau = 0;
    for (let i = 0; i < lignes.length; i++) {
      const l = lignes[i];
      if (/^\s*```/.test(l)) { dansCode = !dansCode; continue; }
      if (dansCode) continue;
      const m = l.match(/^(#{1,6})\s+(.*)$/);
      if (!m) continue;
      if (debut === -1) {
        if (slug(m[2]) === voulu) { debut = i; niveau = m[1].length; }
      } else if (m[1].length <= niveau) {
        return lignes.slice(debut, i).join("\n");
      }
    }
    return debut === -1 ? null : lignes.slice(debut).join("\n");
  }

  /** Remplace chaque emplacement ![[Note]] / ![[Note#Section]] par le contenu
   *  rendu de la note, avec un en-tête qui mène à la source. La pile des notes
   *  en cours empêche les boucles ; la profondeur est bornée. */
  async function rendreTransclusions(racine, pile) {
    for (const noeud of racine.querySelectorAll(".np-transclusion[data-note]")) {
      if (noeud.dataset.rendu) continue;
      noeud.dataset.rendu = "1";
      const chemin = noeud.dataset.note;
      const ancre = noeud.dataset.ancre || "";
      const nom = chemin.replace(/\.md$/, "").split("/").pop();
      const dossier = chemin.includes("/") ? chemin.split("/").slice(0, -1).join("/") : "";
      if (pile.includes(chemin) || pile.length > 3) {
        noeud.innerHTML = `<p class="np-erreur">Transclusion circulaire ou trop profonde : ${nom}</p>`;
        continue;
      }
      let texte;
      try {
        texte = await lireEnCache(chemin);
      } catch (e) {
        noeud.innerHTML = `<p class="np-erreur">Note transcluse indisponible : ${e.message}</p>`;
        continue;
      }
      const { meta, corps } = separerFrontmatter(texte);
      if (meta && (meta.confidentialite !== "publique"
                   || !(meta.publication || []).includes("notes-publiques"))) {
        noeud.innerHTML = `<p class="np-erreur">Note non publiée : ${nom}</p>`;
        continue;
      }
      const md = ancre ? extraireSection(corps, ancre) : corps;
      if (md === null) {
        noeud.innerHTML = `<p class="np-erreur">Section « ${ancre} » introuvable dans ${nom}</p>`;
        continue;
      }
      const lien = `?note=${encodeURIComponent(chemin)}${ancre ? "#" + encodeURIComponent(slug(ancre)) : ""}`;
      noeud.innerHTML = `<p class="np-transclusion-source">↪ <a href="${lien}">${nom}${ancre ? " › " + ancre : ""}</a></p>`
        + `<div class="np-transclusion-corps">${assainir(marked.parse(transformerLiensObsidian(md, dossier)))}</div>`;
      const bloc = noeud.querySelector(".np-transclusion-corps");
      reecrireImagesRelatives(bloc, dossier);
      identifierTitres(bloc, slug(nom));
      rendreCallouts(bloc);
      await rendreTransclusions(bloc, [...pile, chemin]);
      rendreMermaid(bloc);
      await rendreExcalidraw(bloc);
      rendreFormules(bloc);
    }
  }

  /** Rend les formules LaTeX après le passage de Markdown.
   *
   *  L'ordre importe : appliquer KaTeX avant Markdown lui ferait avaler les
   *  underscores et les accolades comme de l'emphase. On assainit d'abord, on
   *  compose les formules ensuite — DOMPurify laisserait de toute façon passer
   *  le HTML produit par KaTeX, qui est du balisage de présentation.
   *
   *  Les blocs de code sont exclus : « $x$ » dans un exemple shell est un nom de
   *  variable, pas une formule.
   */
  function rendreFormules(racine) {
    if (!racine || typeof renderMathInElement !== "function") return;
    try {
      renderMathInElement(racine, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
        ],
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
        throwOnError: false,
        errorColor: "#b8472d",
      });
    } catch (e) {
      console.warn("KaTeX indisponible :", e);
    }
  }

  async function rendreExcalidraw(racine) {
    for (const noeud of racine.querySelectorAll(".np-excalidraw[data-src]")) {
      const src = noeud.dataset.src;
      const dossier = src.includes("/") ? src.split("/").slice(0, -1).join("/") : "";
      try {
        const brut = await lire(src);
        noeud.innerHTML = window.excalidrawVersSVG(brut, {
          // Un nœud du dessin peut viser une note (avec ou sans section), une
          // pièce jointe, ou une note restée privée. Dans ce dernier cas on ne
          // pose pas de lien : un « ?note=… » mort afficherait une page
          // d'erreur et publierait le titre de la note dans le HTML.
          lien: (cible, ancre) => {
            const chemin = resoudre(cible, dossier);
            if (chemin) {
              // Une référence de bloc « ^id » n'a pas d'équivalent dans le
              // rendu ; on ouvre la note en tête. Une section, elle, se
              // retrouve : les titres portent le même slug que les liens.
              const frag = ancre && !ancre.startsWith("^") ? "#" + encodeURIComponent(slug(ancre)) : "";
              return "?note=" + encodeURIComponent(chemin) + frag;
            }
            return resoudreFichier(cible, dossier);
          },
          fichier: (nom) => resoudreFichier(nom, dossier),
        });
        adapterGrandDessin(noeud);
      } catch (e) {
        noeud.innerHTML = `<p class="np-erreur">Dessin illisible : ${e.message}</p>`;
      }
    }
  }

  /** Un dessin trop grand pour la page est illisible une fois réduit : le plan
   *  de cours fait 4 700 × 80 000 px, et ajusté à la largeur ses textes de
   *  16 px passent sous 4 px. Quand l'ajustement tomberait sous 55 % de la
   *  taille réelle, on renonce à l'image d'un bloc : le dessin est posé dans un
   *  panneau qui défile, avec un réglage de zoom, comme on le parcourt dans
   *  Obsidian. Départ à la largeur de la page si cela reste lisible, à la
   *  taille réelle sinon. Les petits dessins ne sont pas touchés. */
  function adapterGrandDessin(noeud) {
    const svg = noeud.querySelector("svg.np-svg");
    if (!svg) return;
    const vb = (svg.getAttribute("viewBox") || "").split(/\s+/).map(Number);
    if (vb.length !== 4 || !(vb[2] > 0) || !(vb[3] > 0)) return;
    const w = vb[2], h = vb[3];
    const largeur = noeud.clientWidth || 1000;
    const ajuste = Math.min(largeur / w, (0.78 * window.innerHeight) / h);
    if (ajuste >= 0.55) return;

    let z = largeur / w >= 0.3 ? largeur / w : 1;
    const panneau = document.createElement("div");
    panneau.className = "np-dessin-defilant";
    const barre = document.createElement("div");
    barre.className = "np-zoom";
    barre.innerHTML =
      '<button type="button" data-zoom="-" title="Réduire">−</button>' +
      '<span class="np-zoom-valeur"></span>' +
      '<button type="button" data-zoom="+" title="Agrandir">+</button>' +
      '<button type="button" data-zoom="largeur" title="Ajuster à la largeur de la page">Largeur</button>' +
      '<button type="button" data-zoom="1" title="Taille réelle">100 %</button>';
    const valeur = barre.querySelector(".np-zoom-valeur");
    const appliquer = () => {
      svg.style.width = Math.round(w * z) + "px";
      svg.style.height = Math.round(h * z) + "px";
      valeur.textContent = Math.round(z * 100) + " %";
    };
    barre.addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-zoom]");
      if (!b) return;
      const a = b.dataset.zoom;
      z = a === "+" ? Math.min(z * 1.25, 4)
        : a === "-" ? Math.max(z / 1.25, 0.05)
        : a === "largeur" ? largeur / w : 1;
      appliquer();
    });
    svg.classList.add("np-svg-grand");
    panneau.appendChild(svg);
    noeud.appendChild(barre);
    noeud.appendChild(panneau);
    appliquer();
  }

  /* ------------------------------------------------- index et recherche -- */
  const RUBRIQUES = {
    cours: "Cours", informatique: "Informatique", sciences: "Sciences",
    "réflexions": "Réflexions", "Idées et concepts": "Idées et concepts",
    meetup: "Meetups", templates: "Modèles", "Livres de cours": "Livres de cours",
  };

  function trierNotes(a, b) {
    // le sommaire d'un livre d'abord, puis l'ordre des chapitres (01, 02, … 10)
    const sa = / — Sommaire$/.test(a.nom), sb = / — Sommaire$/.test(b.nom);
    if (sa !== sb) return sa ? -1 : 1;
    return a.nom.localeCompare(b.nom, "fr", { numeric: true });
  }

  /** Liste d'une rubrique. Quand la rubrique contient des sous-dossiers — un
   *  livre par sous-dossier — chacun forme un groupe titré, son sommaire en tête. */
  function listerRubrique(racineDossier, notes) {
    const sous = {};
    for (const n of notes) (sous[n.dossier] = sous[n.dossier] || []).push(n);
    const cles = Object.keys(sous).sort((a, b) => a.localeCompare(b, "fr"));
    // Un dessin s'affiche sans son extension, avec une étiquette : c'est un
    // support de cours au même titre qu'une note, mais on doit savoir avant de
    // cliquer qu'on ouvre un schéma et non un texte.
    const entree = (n) => estDessin(n.chemin)
      ? `<li class="np-dessin-item"><a href="?note=${encodeURIComponent(n.chemin)}">${n.nom.replace(/\.excalidraw$/i, "")}</a>`
        + ` <span class="np-etiquette">dessin</span></li>`
      : `<li><a href="?note=${encodeURIComponent(n.chemin)}">${n.nom}</a></li>`;
    const liste = (ns) => `<ul class="np-liste">${ns.sort(trierNotes).map(entree).join("")}</ul>`;
    if (cles.length === 1 && cles[0] === racineDossier) return liste(sous[racineDossier]);
    return cles.map((d) => {
      const titre = d === racineDossier ? "" : `<h3>${d.split("/").slice(1).join(" › ")}</h3>`;
      return `<div class="np-livre">${titre}${liste(sous[d])}</div>`;
    }).join("");
  }

  async function afficherIndex(filtreDossier) {
    const cible = document.getElementById("np-contenu");
    cible.innerHTML = '<p class="np-attente">Chargement de l’index…</p>';
    await chargerIndex();
    document.title = "Notes publiques | Logikascium";

    const parDossier = {};
    for (const n of INDEX) {
      // les index — cartes graphiques comprises — ne sont pas des notes : ils
      // sont proposés séparément, en tête de rubrique. Les autres dessins sont
      // listés avec les notes : un plan de cours en est le support.
      if (n.nom.startsWith("_")) continue;
      if (HORS_COFFRE.test(n.nom)) continue;
      const racine = n.dossier.split("/")[0] || "(racine)";
      // le filtre accepte une rubrique ou un sous-dossier (un livre)
      if (filtreDossier && n.dossier !== filtreDossier && !n.dossier.startsWith(filtreDossier + "/")
          && racine !== filtreDossier) continue;
      (parDossier[racine] = parDossier[racine] || []).push(n);
    }

    const blocs = Object.keys(parDossier).sort().map((d) => {
      const notes = listerRubrique(d, parDossier[d]);
      const carte = INDEX.find((n) => n.dossier === d && /^_INDEX/i.test(n.nom));
      const vueGraphe = INDEX.find((n) => n.chemin === `${d}/_INDEX_${d}.excalidraw.md`);
      const liens = [
        carte ? `<a class="np-carte" href="?note=${encodeURIComponent(carte.chemin)}">index thématique</a>` : "",
        vueGraphe ? `<a class="np-carte" href="?note=${encodeURIComponent(vueGraphe.chemin)}">vue graphique</a>` : "",
      ].filter(Boolean).join(" · ");
      return `<section class="np-rubrique"><h2>${RUBRIQUES[d] || d}
        <span class="np-compte">${parDossier[d].length}</span></h2>
        ${liens ? `<p class="np-liens-index">${liens}</p>` : ""}
        ${notes}</section>`;
    });

    const compte = Object.values(parDossier).reduce((s, v) => s + v.length, 0);
    const principal = INDEX.find((n) => n.chemin === ACCUEIL)
      ? ` · <a href="?note=${encodeURIComponent(ACCUEIL)}">index principal</a>` : "";
    cible.innerHTML = `
      <p class="np-ariane"><b>Notes publiques</b> — ${compte} notes issues du dépôt
        <a href="https://github.com/${DEPOT.proprietaire}/${DEPOT.nom}" rel="noopener">NotesPubliques</a>${principal}</p>`.trim() + `
      <input id="np-recherche" class="np-recherche" type="search"
             placeholder="Filtrer les notes…" autocomplete="off">
      ${blocs.join("")}`;

    const champ = document.getElementById("np-recherche");
    champ.addEventListener("input", () => {
      const q = champ.value.trim().toLowerCase();
      cible.querySelectorAll(".np-liste li").forEach((li) => {
        li.hidden = q && !li.textContent.toLowerCase().includes(q);
      });
      cible.querySelectorAll(".np-rubrique").forEach((s) => {
        s.hidden = ![...s.querySelectorAll("li")].some((li) => !li.hidden);
      });
    });
  }

  /* ------------------------------------------------------------ route ---- */
  function afficherPanne(titre, message) {
    document.getElementById("np-contenu").innerHTML =
      `<div class="np-erreur"><h2>${titre}</h2><p>${message}</p>
       <p>Les fichiers restent lisibles sur
          <a href="https://github.com/${DEPOT.proprietaire}/${DEPOT.nom}"
             rel="noopener">GitHub</a>.</p></div>`;
  }

  async function router() {
    try {
      await routerInterne();
    } catch (e) {
      // Filet de sécurité : une exception non rattrapée laisserait la page
      // bloquée sur « Chargement… », ce qui est le pire des messages d'erreur.
      console.error(e);
      afficherPanne("Une erreur est survenue", e.message || String(e));
    }
  }

  async function routerInterne() {
    const p = new URLSearchParams(location.search);
    const note = p.get("note") || p.get("file");
    try {
      await chargerIndex();
    } catch (e) {
      afficherPanne("Index indisponible", e.message);
      return;
    }
    if (note) {
      const chemin = estNote(note) ? note : note + ".md";
      await afficherNote(resoudre(chemin, "") || chemin);
    } else if (p.get("dossier")) {
      await afficherIndex(p.get("dossier"));
    } else {
      // L'accueil est le listing construit depuis le dépôt, et non
      // « _INDEX PRINCIPAL.md ». Cet index est généré à partir du coffre privé :
      // il renvoie vers des dossiers qui ne sont pas publiés, et afficherait donc
      // une majorité de liens morts. Le listing, lui, ne peut montrer que ce qui
      // existe réellement ici.
      await afficherIndex(null);
    }
  }

  window.addEventListener("popstate", router);
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href^='?']");
    if (!a || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    history.pushState({}, "", a.getAttribute("href"));
    router();
  });

  document.addEventListener("DOMContentLoaded", () => {
    preparerMarked();
    if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: "neutral" });
    router();
  });
})();
