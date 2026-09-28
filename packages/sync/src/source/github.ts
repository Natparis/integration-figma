/**
 * Source GitHub : un depot devient un site servi localement.
 *
 * Coller l'adresse d'un depot est le geste le plus naturel pour qui publie son
 * site depuis GitHub — et c'est aussi la source la plus fidele, puisqu'on lit ce
 * qui sera publie, sans dependre de l'hebergement.
 *
 * On passe par l'archive du depot plutot que par `git clone` : aucune dependance
 * a installer, aucun historique a telecharger, et le chemin d'extraction rejoint
 * celui, deja eprouve, des archives `.zip`.
 */

export interface DepotGitHub {
  owner: string;
  repo: string;
  /** Branche demandee, ou `null` si l'adresse n'en nomme aucune. */
  branch: string | null;
  /** Sous-dossier du depot ou se trouve le site, ex. `docs` ou `dist`. */
  subdir: string | null;
}

/**
 * Reconnait une adresse de depot GitHub.
 *
 * Accepte ce qu'on obtient en copiant la barre d'adresse du navigateur :
 * la page d'accueil du depot, une branche (`/tree/ma-branche`), un sous-dossier
 * (`/tree/main/docs`), l'adresse de clonage (`.git`), et la forme courte
 * `github:owner/repo`. Rend `null` pour tout le reste — une adresse de site
 * publie n'est pas un depot et doit continuer d'etre lue en direct.
 */
export function reconnaitreDepot(entree: string): DepotGitHub | null {
  const texte = entree.trim();
  if (!texte) return null;

  const court = /^github:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(texte);
  if (court) {
    return { owner: court[1]!, repo: court[2]!, branch: null, subdir: null };
  }

  let url: URL;
  try {
    url = new URL(texte);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== 'github.com' && url.hostname.toLowerCase() !== 'www.github.com') {
    return null;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, '');

  // `/tree/<branche>/<sous-dossier...>` : tout ce qui suit `tree` decrit ou
  // regarder dans le depot.
  if (parts[2] === 'tree' && parts.length >= 4) {
    return {
      owner,
      repo,
      branch: decodeURIComponent(parts[3]!),
      subdir: parts.length > 4 ? parts.slice(4).map(decodeURIComponent).join('/') : null,
    };
  }

  return { owner, repo, branch: null, subdir: null };
}

/** Adresse de l'archive d'une branche. */
export function urlArchive(depot: DepotGitHub, branche: string): string {
  return `https://codeload.github.com/${encodeURIComponent(depot.owner)}/${encodeURIComponent(
    depot.repo,
  )}/zip/refs/heads/${branche.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Branches essayees quand l'adresse n'en nomme pas.
 *
 * L'ordre compte : `main` d'abord, c'est le defaut depuis 2020 ; `master` reste
 * majoritaire sur les depots anciens.
 */
export const BRANCHES_PAR_DEFAUT = ['main', 'master'] as const;
