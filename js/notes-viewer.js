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
 *     transclusion ![[schema.excalidraw]] ;
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
  const BRUT = `https://raw.githubusercontent.com/${DEPOT.proprietaire}/${DEPOT.nom}/${DEPOT.branche}/`;
  const API = `https://api.github.com/repos/${DEPOT.proprietaire}/${DEPOT.nom}/git/trees/${DEPOT.branche}?recursive=1`;
  const ACCUEIL = "_INDEX PRINCIPAL.md";

  /* ------------------------------------------------------------ index ---- */
  let INDEX = null; // [{chemin, nom, dossier}]

  async function chargerIndex() {
    if (INDEX) return INDEX;
    const cache = sessionStorage.getItem("np-index");
    if (cache) {
      INDEX = JSON.parse(cache);
      return INDEX;
    }
    const rep = await fetch(API);
    if (!rep.ok) throw new Error(`index indisponible (HTTP ${rep.status})`);
    const arbre = await rep.json();
    INDEX = (arbre.tree || [])
      .filter((n) => n.type === "blob" && n.path.endsWith(".md"))
      .map((n) => ({
        chemin: n.path,
        nom: n.path.replace(/\.md$/, "").split("/").pop(),
        dossier: n.path.includes("/") ? n.path.split("/").slice(0, -1).join("/") : "",
      }));
    try {
      sessionStorage.setItem("np-index", JSON.stringify(INDEX));
    } catch (e) {
      /* quota dépassé : on se passe du cache */
    }
    return INDEX;
  }

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
    // transclusion d'image ou de dessin : ![[fichier]]
    md = md.replace(/!\[\[([^\]|#]+?)(?:\|([^\]]*))?\]\]/g, (m, cible, alias) => {
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
      return chemin ? `[${alias || propre}](?note=${encodeURIComponent(chemin)})` : `*${alias || propre}*`;
    });
    // lien simple : [[cible|alias]]
    md = md.replace(/\[\[([^\]|#]+?)(?:#([^\]|]+))?(?:\|([^\]]*))?\]\]/g, (m, cible, ancre, alias) => {
      const chemin = resoudre(cible.trim(), dossier);
      const texte = alias || cible.trim();
      if (!chemin) return `<span class="np-lien-mort" title="note non publiée">${texte}</span>`;
      const frag = ancre ? "#" + encodeURIComponent(ancre.trim().toLowerCase().replace(/\s+/g, "-")) : "";
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
      if (!h.id) h.id = h.textContent.trim().toLowerCase().replace(/[^\w\u00C0-\u017F]+/g, "-");
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
    const morceaux = chemin.replace(/\.md$/, "").split("/");
    const nom = morceaux.pop();
    const dossiers = morceaux.map((d) => `<a href="?dossier=${encodeURIComponent(d)}">${d}</a>`).join(" › ");
    return `<p class="np-ariane"><a href="?">Notes</a>${dossiers ? " › " + dossiers : ""} › <b>${nom}</b></p>`;
  }

  async function afficherNote(chemin) {
    const cible = document.getElementById("np-contenu");
    cible.innerHTML = '<p class="np-attente">Chargement…</p>';
    const dossier = chemin.includes("/") ? chemin.split("/").slice(0, -1).join("/") : "";
    let texte;
    try {
      texte = await lire(chemin);
    } catch (e) {
      cible.innerHTML = `<div class="np-erreur"><h2>Note indisponible</h2><p>${e.message}</p>
        <p>Cette note n'est peut-être pas publiée : <code>NotesPubliques</code> est un
        sous-ensemble filtré des notes privées.</p><p><a href="?">Revenir à l'index</a></p></div>`;
      return;
    }

    if (/\.excalidraw\.md$/i.test(chemin)) {
      cible.innerHTML = fildAriane(chemin) + '<div class="np-excalidraw" data-src="' + chemin + '"></div>';
      await rendreExcalidraw(cible);
      return;
    }

    const { meta, corps } = separerFrontmatter(texte);
    const md = transformerLiensObsidian(corps, dossier);
    const html = DOMPurify.sanitize(marked.parse(md), {
      ADD_TAGS: ["foreignObject"],
      ADD_ATTR: ["target", "data-src"],
    });

    const titre = (meta && meta.titre) || chemin.replace(/\.md$/, "").split("/").pop();
    document.title = `${titre} — Notes | Logikascium`;

    const article = document.createElement("article");
    article.className = "np-note";
    article.innerHTML = html;
    reecrireImagesRelatives(article, dossier);

    cible.innerHTML = fildAriane(chemin) + carteMeta(meta) + sommaire(article) + article.outerHTML;

    const rendu = cible.querySelector(".np-note");
    if (window.mermaid) {
      rendu.querySelectorAll("pre code.language-mermaid, pre code.mermaid").forEach((c, i) => {
        const d = document.createElement("div");
        d.className = "mermaid";
        d.textContent = c.textContent;
        c.closest("pre").replaceWith(d);
      });
      try { mermaid.run({ querySelector: ".np-note .mermaid" }); } catch (e) { /* ignore */ }
    }
    await rendreExcalidraw(cible);
    if (location.hash) {
      const c = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (c) c.scrollIntoView();
    }
  }

  async function rendreExcalidraw(racine) {
    for (const noeud of racine.querySelectorAll(".np-excalidraw[data-src]")) {
      try {
        const brut = await lire(noeud.dataset.src);
        noeud.innerHTML = window.excalidrawVersSVG(brut, { lien: (c) => "?note=" + encodeURIComponent(c) });
      } catch (e) {
        noeud.innerHTML = `<p class="np-erreur">Dessin illisible : ${e.message}</p>`;
      }
    }
  }

  /* ------------------------------------------------- index et recherche -- */
  const RUBRIQUES = {
    cours: "Cours", informatique: "Informatique", sciences: "Sciences",
    "réflexions": "Réflexions", "Idées et concepts": "Idées et concepts",
    meetup: "Meetups", templates: "Modèles",
  };

  async function afficherIndex(filtreDossier) {
    const cible = document.getElementById("np-contenu");
    cible.innerHTML = '<p class="np-attente">Chargement de l’index…</p>';
    await chargerIndex();
    document.title = "Notes publiques | Logikascium";

    const parDossier = {};
    for (const n of INDEX) {
      if (n.nom.startsWith("_") && !n.nom.startsWith("_INDEX")) continue;
      const racine = n.dossier.split("/")[0] || "(racine)";
      if (filtreDossier && racine !== filtreDossier) continue;
      (parDossier[racine] = parDossier[racine] || []).push(n);
    }

    const blocs = Object.keys(parDossier).sort().map((d) => {
      const notes = parDossier[d]
        .sort((a, b) => a.nom.localeCompare(b.nom, "fr"))
        .map((n) => `<li><a href="?note=${encodeURIComponent(n.chemin)}">${n.nom}</a></li>`)
        .join("");
      const carte = INDEX.find((n) => n.dossier === d && /^_INDEX/i.test(n.nom));
      const vueGraphe = INDEX.find((n) => n.chemin === `${d}/_INDEX_${d}.excalidraw.md`);
      const liens = [
        carte ? `<a class="np-carte" href="?note=${encodeURIComponent(carte.chemin)}">index thématique</a>` : "",
        vueGraphe ? `<a class="np-carte" href="?note=${encodeURIComponent(vueGraphe.chemin)}">vue graphique</a>` : "",
      ].filter(Boolean).join(" · ");
      return `<section class="np-rubrique"><h2>${RUBRIQUES[d] || d}
        <span class="np-compte">${parDossier[d].length}</span></h2>
        ${liens ? `<p class="np-liens-index">${liens}</p>` : ""}
        <ul class="np-liste">${notes}</ul></section>`;
    });

    cible.innerHTML = `
      <p class="np-ariane"><b>Notes publiques</b> — ${INDEX.length} notes issues du dépôt
        <a href="https://github.com/${DEPOT.proprietaire}/${DEPOT.nom}" rel="noopener">NotesPubliques</a></p>
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
  async function router() {
    const p = new URLSearchParams(location.search);
    const note = p.get("note") || p.get("file");
    try {
      await chargerIndex();
    } catch (e) {
      document.getElementById("np-contenu").innerHTML =
        `<div class="np-erreur"><h2>Index indisponible</h2><p>${e.message}</p></div>`;
      return;
    }
    if (note) {
      const chemin = note.endsWith(".md") ? note : note + ".md";
      await afficherNote(resoudre(chemin, "") || chemin);
    } else if (p.get("dossier")) {
      await afficherIndex(p.get("dossier"));
    } else {
      const accueil = INDEX.find((n) => n.chemin === ACCUEIL);
      accueil ? await afficherNote(ACCUEIL) : await afficherIndex(null);
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
