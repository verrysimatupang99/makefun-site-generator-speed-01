// A faster drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Reimplements build() from the vendor README + reference code, byte-identical
// in output, with the hot paths rewritten:
//  - Markdown inline rendering scans in bulk (indexOf for the next structural
//    char, escapeHtml on whole plain runs) instead of escapeHtml per character.
//  - Markdown blocks render straight to HTML, no token objects.
//  - Front matter is located with indexOf; only its (small) region is split.
//  - slugify has an ASCII fast path and a per-build cache; longDate is cached.
//  - Templates are compiled once per build to JS functions (new Function) that
//    push into an output array; lookup is inlined with own-property checks.
//  - cards reuse the cached post card instead of rebuilding it.
// No imports at all; no cross-case state (every cache lives inside build()).
// Node 22 compatible only.

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;

function escapeHtml(text) {
  if (!ESCAPE_TEST.test(text)) return text;
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDateRaw(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The slug of `text` (README "Text"). `cache` is a per-build Map. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out;
  // Fast path: pure ASCII. NFKD is the identity on ASCII and there are no
  // combining marks, so the loop below is the whole rule.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) {
    let s = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      let keep = null;
      if (c >= 'A' && c <= 'Z') keep = c.toLowerCase();
      else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) keep = c;
      if (keep === null) {
        gap = s.length > 0;
        continue;
      }
      if (gap) s += '-';
      gap = false;
      s += keep;
    }
    out = s.slice(0, 64).replace(/-+$/, '');
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let s = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = s.length > 0;
        continue;
      }
      if (gap) s += '-';
      gap = false;
      s += keep;
    }
    out = s.slice(0, 64).replace(/-+$/, '');
  }
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace.
 * Allocation-free: counts whitespace -> non-whitespace transitions by code
 * unit, using JavaScript's own \s set (ASCII whitespace plus U+00A0, U+1680,
 * U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws =
      c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 ||
      c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
      c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` from the directory whose parts are `parts`, or null when it climbs out of the root. */
function resolvePath(parts, rel) {
  const out = parts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A line of only spaces/tabs (or empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A line trimmed of spaces and tabs at either end. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function fmDaysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmStringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > fmDaysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * `text` has "\n" line ends. Only the front-matter region is split; the body
 * is sliced out of the original text.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // The closing line is a line exactly '---': either "\n---\n" or "\n---" at the end.
  let regionEnd = -1; // index of the '\n' just before the closing line (or text.length-4)
  let bodyStart = -1;
  const p = text.indexOf('\n---\n', 3);
  if (p !== -1) {
    regionEnd = p;
    bodyStart = p + 5;
  } else if (text.endsWith('\n---')) {
    regionEnd = text.length - 4;
    bodyStart = text.length;
  } else {
    return { error: 'the front matter is not closed' };
  }
  const region = text.slice(4, regionEnd);
  const lines = region === '' ? [] : region.split('\n');
  const data = {};
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    if (isBlank(line) || line[0] === '#') continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;
const CONTINUED = /^ {2,}\S/;

function isLangChar(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-';
}

/** A fence's language, or null when `line` does not open one. */
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  while (i < line.length && isLangChar(line[i])) i++;
  let j = i;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  if (j !== line.length) return null;
  return line.slice(3, i);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let i = 0;
  while (i < line.length && line[i] === '#') i++;
  if (i === 0 || i > 6) return null;
  if (i >= line.length || (line[i] !== ' ' && line[i] !== '\t')) return null;
  let j = i;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  let e = line.length;
  while (e > j && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  if (e === j) return null;
  return { depth: i, text: line.slice(j, e) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (line[0] !== '-' && line[0] !== '*') return false;
  const ch = line[0];
  if (line[1] !== ch || line[2] !== ch) return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** A list item's marker, or null. { ordered, start, text } */
function listMarker(line) {
  const c0 = line[0];
  if ((c0 === '-' || c0 === '*') && line[1] === ' ') return { ordered: false, start: 1, text: line.slice(2) };
  if (c0 >= '0' && c0 <= '9') {
    let i = 0;
    while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
    if (i >= 1 && i <= 9 && line[i] === '.' && line[i + 1] === ' ') {
      return { ordered: true, start: Number(line.slice(0, i)), text: line.slice(i + 2) };
    }
  }
  return null;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break.
 * Only lines opening on '`', '#', '-', '*', a space/tab or empty can be one. */
function endsParagraph(line) {
  const c0 = line[0];
  if (c0 === '`') return fenceLang(line) !== null;
  if (c0 === '#') return headingOf(line) !== null;
  if (c0 === '-' || c0 === '*') return isHr(line);
  if (c0 === ' ' || c0 === '\t' || c0 === undefined) return isBlank(line);
  return false;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1.
 * Jumps with indexOf instead of walking every character: a backslash before the
 * next candidate is either an escape pair (skipped whole) or a lone backslash. */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1) return -1;
    const b = s.indexOf('\\', j);
    if (b !== -1 && b < k) {
      j = b + 1 < s.length && ESCAPABLE.has(s[b + 1]) ? b + 2 : b + 1;
      continue;
    }
    return k;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    const b = s.indexOf('\\', j);
    if (b !== -1 && b < k) {
      j = b + 1 < s.length && ESCAPABLE.has(s[b + 1]) ? b + 2 : b + 1;
      continue;
    }
    if (s[k + 1] === '*') {
      j = k + 2;
      continue;
    }
    return k;
  }
}

/** `s` rendered inline; `env.link(target)` is a link's href.
 * One regex pass finds every character that matters (a structural one, or
 * one HTML escapes); the plain runs between them hold neither, so they are
 * pushed raw — no separate escape scan, no per-character escaping. The
 * regex is shared: each call starts it at 0, and every loop iteration
 * re-sets its lastIndex after any recursive call, so recursion is safe. */
const INLINE_RE = /[\\`*[&<>"']/g;

function inline(s, env) {
  const n = s.length;
  INLINE_RE.lastIndex = 0;
  const out = [];
  let plain = 0;
  let m;
  while ((m = INLINE_RE.exec(s)) !== null) {
    const j = m.index;
    const c = s[j];
    const esc = ESCAPES[c];
    if (esc !== undefined) {
      if (j > plain) out.push(s.slice(plain, j));
      out.push(esc);
      plain = j + 1;
      INLINE_RE.lastIndex = plain;
      continue;
    }
    let next;
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        if (j > plain) out.push(s.slice(plain, j));
        const e = s[j + 1];
        out.push(ESCAPES[e] ?? e);
        plain = j + 2;
      }
      next = plain > j + 1 ? plain : j + 1;
    } else if (c === '`') {
      const k2 = s.indexOf('`', j + 1);
      if (k2 > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<code>', escapeHtml(s.slice(j + 1, k2)), '</code>');
        plain = k2 + 1;
      }
      next = plain > j + 1 ? plain : j + 1;
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k2 = findUnescaped(s, '**', j + 2);
        if (k2 > j + 2) {
          if (j > plain) out.push(s.slice(plain, j));
          out.push('<strong>', inline(s.slice(j + 2, k2), env), '</strong>');
          plain = k2 + 2;
          next = plain;
        } else {
          next = j + 2; // a failed '**' is literal text
        }
      } else {
        const k2 = findSingleStar(s, j + 1);
        if (k2 > j + 1) {
          if (j > plain) out.push(s.slice(plain, j));
          out.push('<em>', inline(s.slice(j + 1, k2), env), '</em>');
          plain = k2 + 1;
          next = plain;
        } else {
          next = j + 1;
        }
      }
    } else {
      // '['
      const k2 = findUnescaped(s, ']', j + 1);
      const mm = k2 !== -1 && s[k2 + 1] === '(' ? s.indexOf(')', k2 + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k2 + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(j + 1, k2), env), '</a>');
        plain = mm + 1;
        next = plain;
      } else {
        next = j + 1;
      }
    }
    INLINE_RE.lastIndex = next;
  }
  if (out.length === 0) return s;
  out.push(s.slice(plain));
  return out.join('');
}

/**
 * `src` rendered: its HTML, its table of contents and its excerpt.
 * Lines are walked by indexOf, blocks emit HTML directly (no tokens).
 */
function renderMarkdown(src, env, cx) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  const len = src.length;
  let pos = 0;
  const nextLine = () => {
    if (pos >= len) return null;
    const e = src.indexOf('\n', pos);
    if (e === -1) {
      const l = src.slice(pos);
      pos = len;
      return l;
    }
    const l = src.slice(pos, e);
    pos = e + 1;
    return l;
  };
  let cur = nextLine();
  while (cur !== null) {
    const c0 = cur[0];
    if (c0 === '`') {
      const lang = fenceLang(cur);
      if (lang !== null) {
        const body = [];
        cur = nextLine();
        while (cur !== null && !isFenceClose(cur)) {
          body.push(cur);
          cur = nextLine();
        }
        if (cur !== null) cur = nextLine(); // consume the closing fence
        out.push(`<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>${body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`}</code></pre>\n`);
        continue;
      }
    } else if (c0 === '#') {
      const hd = headingOf(cur);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text, cx.slugCache), ids);
        const html = inline(hd.text, env);
        out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        cur = nextLine();
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (isHr(cur)) {
        out.push('<hr>\n');
        cur = nextLine();
        continue;
      }
      const first = listMarker(cur);
      if (first !== null) {
        const isOrdered = first.ordered;
        const start = first.start;
        const items = [];
        while (cur !== null) {
          const m = listMarker(cur);
          if (m !== null && m.ordered === isOrdered) {
            items.push([trimLine(m.text)]);
            cur = nextLine();
          } else if (CONTINUED.test(cur)) {
            items[items.length - 1].push(trimLine(cur));
            cur = nextLine();
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
        let html = `${open}\n`;
        for (const parts of items) html += `<li>${inline(parts.join('\n'), env)}</li>\n`;
        out.push(`${html}</${tag}>\n`);
        continue;
      }
    } else if (c0 === '>') {
      const body = [];
      while (cur !== null && cur[0] === '>') {
        let rest = cur.slice(1);
        if (rest[0] === ' ') rest = rest.slice(1);
        body.push(trimLine(rest));
        cur = nextLine();
      }
      const lines = body.filter((l) => l !== '');
      out.push(lines.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(lines.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= '0' && c0 <= '9') {
      const first = listMarker(cur);
      if (first !== null) {
        const start = first.start;
        const items = [];
        while (cur !== null) {
          const m = listMarker(cur);
          if (m !== null && m.ordered) {
            items.push([trimLine(m.text)]);
            cur = nextLine();
          } else if (CONTINUED.test(cur)) {
            items[items.length - 1].push(trimLine(cur));
            cur = nextLine();
          } else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        let html = `${open}\n`;
        for (const parts of items) html += `<li>${inline(parts.join('\n'), env)}</li>\n`;
        out.push(`${html}</ol>\n`);
        continue;
      }
    } else if (c0 === ' ' || c0 === '\t' || c0 === undefined) {
      if (isBlank(cur)) {
        cur = nextLine();
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const body = [trimLine(cur)];
    cur = nextLine();
    while (cur !== null && !endsParagraph(cur)) {
      body.push(trimLine(cur));
      cur = nextLine();
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// --- template codegen: a parsed tree becomes a function fn(R, B, D, O, T,
// esc, txt, truthy). R is the page's root vars, B the flat bindings of the
// loops in scope at an include (null when there are none), D the include
// depth, O the output array. Loop variables become real JS locals, so a
// lookup inside a loop body is a local read plus own-property checks — no
// scope-chain walk. An include flattens the caller's loop bindings (outer
// first, so inner bindings win, and each scope's `loop` info wins over an
// element of the same name) into one object, which the included template
// reads the same way the reference's scope chain would.

function compileTemplate(nodes) {
  let uid = 0;
  // `scopes`: [{name, el, loop}] outermost to innermost, lexically in scope.
  const lookup = (path, scopes) => {
    const first = path[0];
    const v = `__v${uid++}`;
    let s;
    if (first === 'loop' && scopes.length > 0) {
      s = `let ${v}=${scopes[scopes.length - 1].loop};`;
    } else {
      let found = null;
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (scopes[i].name === first) { found = scopes[i].el; break; }
      }
      if (found !== null) {
        s = `let ${v}=${found};`;
      } else {
        const key = JSON.stringify(first);
        s = `let ${v}=(B!==null&&Object.hasOwn(B,${key}))?B[${key}]:Object.hasOwn(R,${key})?R[${key}]:undefined;`;
      }
    }
    for (let k = 1; k < path.length; k++) {
      const key = JSON.stringify(path[k]);
      s += `if(${v}!==null&&typeof ${v}==="object"&&Object.hasOwn(${v},${key})){${v}=${v}[${key}];}else{${v}=undefined;}`;
    }
    return { src: s, v };
  };
  const gen = (ns, scopes) => {
    let src = '';
    for (const n of ns) {
      if (n.kind === 'text') {
        src += `O.push(${JSON.stringify(n.text)});`;
      } else if (n.kind === 'var' || n.kind === 'raw') {
        const l = lookup(n.path, scopes);
        src += l.src;
        src += n.kind === 'var' ? `O.push(esc(txt(${l.v})));` : `O.push(txt(${l.v}));`;
      } else if (n.kind === 'if') {
        const l = lookup(n.path, scopes);
        src += l.src;
        src += `if(truthy(${l.v})!==${n.not}){${gen(n.then, scopes)}}`;
        if (n.else !== null) src += `else{${gen(n.else, scopes)}}`;
      } else if (n.kind === 'for') {
        const l = lookup(n.path, scopes);
        const xs = `__x${uid++}`;
        const kk = `__k${uid++}`;
        const nn = `__n${uid++}`;
        const el = `__e${uid++}`;
        const lp = `__l${uid++}`;
        src += l.src;
        src += `if(Array.isArray(${l.v})){const ${xs}=${l.v};const ${nn}=${xs}.length;for(let ${kk}=0;${kk}<${nn};${kk}++){const ${el}=${xs}[${kk}];const ${lp}={index:${kk}+1,first:${kk}===0,last:${kk}===${nn}-1,length:${nn}};${gen(n.body, [...scopes, { name: n.name, el, loop: lp }])}}}`;
      } else if (n.kind === 'include') {
        const t = `__t${uid++}`;
        const flat = scopes.length === 0
          ? 'B'
          : `{...B${scopes.map((sc) => `,[${JSON.stringify(sc.name)}]:${sc.el},loop:${sc.loop}`).join('')}}`;
        src += `if(D<${INCLUDE_DEPTH}){const ${t}=T.get(${JSON.stringify(n.name)});if(${t}!==undefined)${t}(R,${flat},D+1,O,T,esc,txt,truthy);}`;
      }
    }
    return src;
  };
  const body = gen(nodes, []);
  return new Function('R', 'B', 'D', 'O', 'T', 'esc', 'txt', 'truthy', body);
}

// ---------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];

/** One site's output tree: path -> text. */
function build(input) {
  const cx = { slugCache: new Map(), dateCache: new Map() };
  const longDate = (date) => {
    let hit = cx.dateCache.get(date);
    if (hit === undefined) {
      hit = longDateRaw(date);
      cx.dateCache.set(date, hit);
    }
    return hit;
  };

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter.
  let kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  const srcs = kept;
  kept = null;

  // 3. Each page's output directory and url.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of srcs) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, cx.slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of srcs) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const linkCache = new Map();
    const env = {
      link: (target) => {
        let href = linkCache.get(target);
        if (href !== undefined) return href;
        // A scheme needs a ':'; most targets have none.
        if (target.indexOf(':') !== -1 && schemeRe.test(target)) href = target;
        else if (target.startsWith('/') || target.startsWith('#')) href = target;
        else {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dirParts, rel);
          if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
          else {
            broken.add(`broken-link ${s.path} -> ${target}`);
            href = target;
          }
        }
        linkCache.set(target, href);
        return href;
      },
    };
    const md = renderMarkdown(s.body, env, cx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug.
  const posts = srcs.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const slug = slugify(name, cx.slugCache);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, cx.slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of srcs) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, cx.slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const O = [];
    fn({ site, tags: allTags, recent, ...vars }, null, 0, O, templates, escapeHtml, textOf, truthy);
    return O.join('');
  };
  for (const s of srcs) {
    const page = s.post
      ? { ...cards.get(s), slug: s.slug, content: s.html, toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })), newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post }
      : { ...cardOf(s), slug: s.slug, content: s.html, toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })), newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = srcs.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
