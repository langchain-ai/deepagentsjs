export type Address =
  | {
      scheme: "local";
      path: string;
    }
  | {
      scheme: "github";
      owner: string;
      repo: string;
      /** Subdirectory within the repo, e.g. "js-next". Defaults to repo root. */
      subPath?: string;
    };
