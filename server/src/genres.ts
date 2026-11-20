// Genres are stored as ",Action,Drama," so `LIKE '%,Drama,%'` finds them. One spelling per genre, whichever source:
// providers write "Sci-Fi", TMDB "Science Fiction" for movies and "Sci-Fi & Fantasy" for TV.
const SAME: Record<string, string> = { 'Sci-Fi': 'Science Fiction' };

export function encodeGenres(names: string | string[] | null | undefined): string | null {
  const list = (Array.isArray(names) ? names : [names ?? '']).flatMap((n) => String(n).split(/\s*[,/&]\s*/)).filter(Boolean).map((g) => SAME[g] ?? g);
  const unique = [...new Set(list)];
  return unique.length ? `,${unique.join(',')},` : null;
}
export const genreLike = (g: string) => `%,${g},%`;
