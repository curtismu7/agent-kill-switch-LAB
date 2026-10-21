// Redaction: anything secret-looking is removed before a record is stored or returned.
const SECRET_KEY = /(authorization|cookie|token|secret|passw(?:or)?d|api[-_]?key|client[-_]?secret|signature|credential)/i;
const MARK = '[REDACTED]';

export function redactUrl(value) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) url.searchParams.delete(key);
    }
    // An OAuth implicit-flow redirect carries the token in the fragment: drop secret pairs there too.
    if (url.hash.length > 1) {
      const kept = url.hash.slice(1).split('&').filter((pair) => {
        let key = pair.split('=')[0];
        try { key = decodeURIComponent(key); } catch { /* keep raw */ }
        return !SECRET_KEY.test(key);
      });
      url.hash = kept.join('&');
    }
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value;
  }
}

const NAME = '[\\w-]*(?:api[-_]?key|token|secret|passw(?:or)?d|passwd|credential)[\\w-]*';
const VALUE = '("[^"]*"|\'[^\']*\'|[^\\s,;]+)';

export function redactText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/-----BEGIN ([A-Z ]+)-----[\s\S]*?(?:-----END \1-----|$)/g, MARK)
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (m) => redactUrl(m))
    .replace(/\b(Set-Cookie|Cookie)(\s*:\s*)(?!\[REDACTED\])[^\s][^\r\n]*/gi, `$1$2${MARK}`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${MARK}`)
    .replace(/(--?[\w-]*(?:api[-_]?key|token|secret|passw(?:or)?d)[\w-]*)([=\s]+)(?!\[REDACTED\])("[^"]*"|'[^']*'|[^\s]+)/gi, `$1$2${MARK}`)
    .replace(new RegExp(`\\b(${NAME})(=)(?!\\[REDACTED\\])${VALUE}`, 'gi'), `$1$2${MARK}`)
    .replace(new RegExp(`\\b(${NAME})(["']?\\s*:\\s*)(?!["']?\\[REDACTED\\])${VALUE}`, 'gi'), `$1$2${MARK}`)
    .replace(/\b(Proxy-)?Authorization(\s*:\s*)(?!(?:(?:Bearer|Basic)\s+)?\[REDACTED\])[^\s][^\r\n]*/gi, `$1Authorization$2${MARK}`)
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, MARK)
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MARK)
    .replace(/\b(?:sk|pk|ghp|gho|xox[bap])[-_][A-Za-z0-9_-]{16,}/g, MARK);
}
