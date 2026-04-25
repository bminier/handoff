const DEFAULT_MAX_LEN = 40;

export function slugify(input: string, opts: { maxLen?: number } = {}): string {
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  if (slug.length === 0) {
    return 'task';
  }

  if (slug.length <= maxLen) {
    return slug;
  }

  const truncated = slug.slice(0, maxLen);
  const lastDash = truncated.lastIndexOf('-');
  if (lastDash > maxLen / 2) {
    return truncated.slice(0, lastDash);
  }
  return truncated.replace(/-+$/, '');
}
