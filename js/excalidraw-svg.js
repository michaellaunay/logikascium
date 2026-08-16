/* excalidraw-svg.js — rendu d'un dessin Excalidraw en SVG, sans dépendance.
 *
 * Le greffon Excalidraw d'Obsidian range le dessin dans un bloc ```json placé
 * sous un titre « # Drawing », et les textes dans une section « # Text Elements ».
 * Ce module lit ce format et produit un SVG autonome.
 *
 * Il ne réimplémente pas Excalidraw : il couvre les types réellement employés
 * dans des schémas de notes — rectangle, ellipse, losange, flèche, ligne, texte,
 * trait libre, image — et ignore proprement le reste. C'est suffisant pour rendre
 * un schéma consultable et cliquable dans un navigateur, ce qui est le but.
 *
 * Élément lié : un élément dont `link` vaut `[[Note]]` devient un lien cliquable,
 * ce qui rend les cartes d'index navigables.
 */
(function () {
  "use strict";

  const POLICES = {
    1: "Virgil, Segoe UI, Comic Sans MS, cursive",
    2: "Helvetica, Arial, sans-serif",
    3: "Cascadia, Consolas, monospace",
    5: "Excalifont, Virgil, cursive",
  };

  /* Le greffon Obsidian ne met pas les images dans le JSON : il les laisse dans
   * le coffre et note la correspondance sous « # Embedded files » :
   *
   *     e70207d5…: [[robot_codant_en_python.png]]
   *
   * Sans lire cette section, tous les éléments `image` sont vides — ce qui donne
   * un schéma de rectangles de couleur sans son contenu. */
  function extraireFichiersIntegres(brut) {
    const table = {};
    // Attention au drapeau `m` : avec lui, `$` vaut fin de *ligne*, et la
    // capture s'arrêterait donc à la première entrée. On ferme sur « fin de
    // chaîne » explicitement.
    const bloc = brut.match(
      /^#[ \t]*Embedded files[ \t]*\n([\s\S]*?)(?=\n%%|\n#[ \t]|\n```|(?![\s\S]))/m);
    if (!bloc) return table;
    const re = /^([0-9a-f]{8,}):\s*(?:\[\[(.+?)\]\]|(\S+))\s*$/gim;
    let m;
    while ((m = re.exec(bloc[1])) !== null) {
      table[m[1]] = (m[2] || m[3] || "").trim();
    }
    return table;
  }

  function extraireJSON(brut) {
    let m = brut.match(/```json\s*\n([\s\S]*?)\n```/);
    if (m) return JSON.parse(m[1]);
    m = brut.match(/```compressed-json\s*\n([\s\S]*?)\n```/);
    if (m) {
      throw new Error(
        "dessin enregistré en « compressed-json ». Dans Obsidian : réglages du " +
        "greffon Excalidraw → Compatibility → décocher la compression, puis " +
        "rouvrir et sauvegarder le dessin.");
    }
    try {
      return JSON.parse(brut);
    } catch (e) {
      throw new Error("aucun bloc de dessin trouvé");
    }
  }

  const ech = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  function boite(elements) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of elements) {
      if (e.isDeleted) continue;
      const w = e.width || 0, h = e.height || 0;
      x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y);
      x1 = Math.max(x1, e.x + w); y1 = Math.max(y1, e.y + h);
      for (const [px, py] of e.points || []) {
        x0 = Math.min(x0, e.x + px); y0 = Math.min(y0, e.y + py);
        x1 = Math.max(x1, e.x + px); y1 = Math.max(y1, e.y + py);
      }
    }
    if (!isFinite(x0)) return { x: 0, y: 0, w: 100, h: 100 };
    const m = 24;
    return { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
  }

  function traits(e) {
    const op = e.opacity == null ? 100 : e.opacity;
    const tirets = e.strokeStyle === "dashed" ? ' stroke-dasharray="10 6"'
      : e.strokeStyle === "dotted" ? ' stroke-dasharray="2 6" stroke-linecap="round"' : "";
    const fond = e.backgroundColor && e.backgroundColor !== "transparent"
      ? e.backgroundColor : "none";
    const remplissage = fond === "none" ? 1
      : e.fillStyle === "hachure" || e.fillStyle === "cross-hatch" ? 0.35 : 1;
    return `fill="${fond}" fill-opacity="${remplissage}" stroke="${e.strokeColor || "#1e1e1e"}" ` +
      `stroke-width="${e.strokeWidth || 1}" stroke-linejoin="round" ` +
      `opacity="${op / 100}"${tirets}`;
  }

  function rotation(e) {
    if (!e.angle) return "";
    const cx = e.x + (e.width || 0) / 2, cy = e.y + (e.height || 0) / 2;
    return ` transform="rotate(${(e.angle * 180) / Math.PI} ${cx} ${cy})"`;
  }

  function texte(e) {
    const taille = e.fontSize || 20;
    const famille = POLICES[e.fontFamily] || POLICES[1];
    const ancre = e.textAlign === "center" ? "middle" : e.textAlign === "right" ? "end" : "start";
    const x = e.textAlign === "center" ? e.x + (e.width || 0) / 2
      : e.textAlign === "right" ? e.x + (e.width || 0) : e.x;
    const lignes = String(e.text || "").split("\n");
    const interligne = taille * 1.25;
    const tspans = lignes.map((l, i) =>
      `<tspan x="${x}" dy="${i === 0 ? taille * 0.9 : interligne}">${ech(l)}</tspan>`).join("");
    return `<text x="${x}" y="${e.y}" font-family="${famille}" font-size="${taille}" ` +
      `fill="${e.strokeColor || "#1e1e1e"}" text-anchor="${ancre}" ` +
      `opacity="${(e.opacity == null ? 100 : e.opacity) / 100}"${rotation(e)}>${tspans}</text>`;
  }

  function chemin(e, ferme) {
    const pts = (e.points || []).map(([px, py]) => [e.x + px, e.y + py]);
    if (pts.length < 2) return "";
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")
      + (ferme ? " Z" : "");
    const fleche = e.endArrowhead && e.endArrowhead !== "none"
      ? ' marker-end="url(#np-fleche)"' : "";
    const debut = e.startArrowhead && e.startArrowhead !== "none"
      ? ' marker-start="url(#np-fleche-debut)"' : "";
    return `<path d="${d}" fill="${ferme ? (e.backgroundColor || "none") : "none"}" ` +
      `stroke="${e.strokeColor || "#1e1e1e"}" stroke-width="${e.strokeWidth || 1}" ` +
      `stroke-linecap="round" stroke-linejoin="round" ` +
      `opacity="${(e.opacity == null ? 100 : e.opacity) / 100}"${fleche}${debut}/>`;
  }

  /** Cadre de remplacement pour une image que l'on n'a pas su résoudre.
   *  Mieux vaut un cadre nommé qu'un trou : on voit qu'il manque quelque chose,
   *  et on sait quoi. */
  function cadreAbsent(e, nom) {
    const etiquette = nom ? nom.split("/").pop() : "image absente";
    return `<g${rotation(e)}><rect x="${e.x}" y="${e.y}" width="${e.width}" ` +
      `height="${e.height}" rx="6" fill="#f1f3f5" stroke="#adb5bd" ` +
      `stroke-width="1" stroke-dasharray="6 4"/>` +
      `<text x="${e.x + e.width / 2}" y="${e.y + e.height / 2}" font-size="13" ` +
      `font-family="Helvetica, sans-serif" fill="#868e96" text-anchor="middle">` +
      `${ech(etiquette)}</text></g>`;
  }

  /** Les éléments « embeddable » sont des pages web incrustées. On ne peut pas
   *  les charger ici — la plupart des sites refusent d'être placés en cadre — et
   *  on ne veut pas exécuter du tiers dans la page. On rend donc une vignette
   *  cliquable qui ouvre la ressource dans un nouvel onglet. */
  function cadreEmbarque(e) {
    const url = e.link || "";
    let hote = "";
    try { hote = url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch (err) { hote = url; }
    const corps =
      `<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" rx="8" ` +
      `fill="#ffffff" stroke="#4dabf7" stroke-width="1.5"/>` +
      `<rect x="${e.x}" y="${e.y}" width="${e.width}" height="26" rx="8" fill="#e7f5ff"/>` +
      `<text x="${e.x + 10}" y="${e.y + 18}" font-size="12" ` +
      `font-family="Helvetica, sans-serif" fill="#1971c2">${ech(hote || "lien")}</text>` +
      `<text x="${e.x + e.width / 2}" y="${e.y + e.height / 2 + 8}" font-size="14" ` +
      `font-family="Helvetica, sans-serif" fill="#495057" text-anchor="middle">` +
      `Ouvrir la ressource</text>`;
    return url
      ? `<a href="${ech(url)}" target="_blank" rel="noopener" class="np-noeud">${corps}</a>`
      : corps;
  }

  function dessiner(e, fichiers) {
    switch (e.type) {
      case "rectangle": {
        const r = Math.min(e.roundness ? 16 : 0, (e.width || 0) / 4, (e.height || 0) / 4);
        return `<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" ` +
          `rx="${r}" ${traits(e)}${rotation(e)}/>`;
      }
      case "ellipse":
        return `<ellipse cx="${e.x + e.width / 2}" cy="${e.y + e.height / 2}" ` +
          `rx="${e.width / 2}" ry="${e.height / 2}" ${traits(e)}${rotation(e)}/>`;
      case "diamond": {
        const p = [[e.x + e.width / 2, e.y], [e.x + e.width, e.y + e.height / 2],
                   [e.x + e.width / 2, e.y + e.height], [e.x, e.y + e.height / 2]];
        return `<polygon points="${p.map((c) => c.join(",")).join(" ")}" ` +
          `${traits(e)}${rotation(e)}/>`;
      }
      case "arrow":
      case "line":
        return chemin(e, e.type === "line" && e.polygon);
      case "freedraw":
        return chemin(e, false);
      case "text":
        return texte(e);
      case "image": {
        const f = fichiers && fichiers[e.fileId];
        const url = (f && f.dataURL) || (f && f.url) || null;
        if (!url) return cadreAbsent(e, f && f.nom);
        const clip = `clip-${e.id}`;
        return `<clipPath id="${clip}"><rect x="${e.x}" y="${e.y}" ` +
          `width="${e.width}" height="${e.height}" rx="6"/></clipPath>` +
          `<image x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" ` +
          `preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})" ` +
          `href="${ech(url)}"${rotation(e)}/>`;
      }
      case "embeddable":
        return cadreEmbarque(e);
      default:
        return "";
    }
  }

  /** Convertit le contenu d'un `.excalidraw.md` en SVG.
   *  @param {string} brut  contenu du fichier
   *  @param {{lien?: (chemin:string)=>string}} options
   *  @returns {string} SVG prêt à insérer */
  function excalidrawVersSVG(brut, options) {
    options = options || {};
    const versLien = options.lien || ((c) => "?note=" + encodeURIComponent(c));
    const versFichier = options.fichier || (() => null);
    const doc = extraireJSON(brut);
    const elements = (doc.elements || []).filter((e) => !e.isDeleted);

    // Les images du coffre l'emportent sur `files`, qui est vide dans les
    // fichiers produits par Obsidian.
    const fichiers = Object.assign({}, doc.files || {});
    const integres = extraireFichiersIntegres(brut);
    for (const [id, nom] of Object.entries(integres)) {
      const url = versFichier(nom);
      fichiers[id] = Object.assign({ nom: nom }, fichiers[id] || {}, url ? { url: url } : {});
    }
    const b = boite(elements);
    const fond = (doc.appState && doc.appState.viewBackgroundColor) || "#ffffff";

    const corps = elements.map((e) => {
      const svg = dessiner(e, fichiers);
      if (!svg) return "";
      const brutLien = e.link || "";
      const m = brutLien.match(/^\[\[(.+?)(?:\|.*)?\]\]$/);
      if (m) {
        const cible = m[1].trim();
        const url = versLien(cible.endsWith(".md") ? cible : cible + ".md");
        return `<a href="${ech(url)}" class="np-noeud">${svg}</a>`;
      }
      if (/^https?:/.test(brutLien)) {
        return `<a href="${ech(brutLien)}" target="_blank" rel="noopener" class="np-noeud">${svg}</a>`;
      }
      return svg;
    }).join("\n");

    const fleche = (id, retourne) =>
      `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" ` +
      `markerHeight="6" orient="auto-start-reverse">` +
      `<path d="${retourne ? "M10,0 L0,5 L10,10" : "M0,0 L10,5 L0,10"}" ` +
      `fill="none" stroke="context-stroke" stroke-width="1.5"/></marker>`;

    return `<svg class="np-svg" xmlns="http://www.w3.org/2000/svg" role="img" ` +
      `viewBox="${b.x.toFixed(1)} ${b.y.toFixed(1)} ${b.w.toFixed(1)} ${b.h.toFixed(1)}" ` +
      `style="background:${fond}">` +
      `<defs>${fleche("np-fleche", false)}${fleche("np-fleche-debut", true)}</defs>` +
      corps + `</svg>`;
  }

  window.excalidrawVersSVG = excalidrawVersSVG;
})();
