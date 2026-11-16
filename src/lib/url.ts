/** Prefix a public/ path with the site base (e.g. "/RuWebsite/"). */
export const asset = (path: string) =>
  `${import.meta.env.BASE_URL.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
