// Swift makefun-site: a faster drop-in for make.fun's own makefun-site 1.0.0.
//
// run(input) returns, for one case's input, exactly the output tree makefun-site 1.0.0's build
// returns for that site, as a JSON object of every path it writes and that file's text, byte for
// byte. The rules are makefun-site's own (front matter, template dialect, Markdown subset, slug
// rule, report); this file reimplements them from scratch, faster:
//
//   - one scan per character: HTML escaping walks the text once and copies plain runs whole,
//     instead of a regex replace per character;
//   - slugs and long dates are cached per build, with an ASCII fast path for the slug rule
//     (pure-ASCII text needs no Unicode normalisation);
//   - front matter is parsed with index scans, not a line split plus a regex per line;
//   - Markdown is rendered in one pass over its lines (no token objects), and its inline
//     parser works on ranges of one string (no slices for nested marks);
//   - templates are parsed once per build and rendered into a single output array, and each
//     page's card and page records are built once per source.
//
// Nothing is cached from one case to the next: every cache is made inside run().

// ---------------------------------------------------------------- text

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `text` with & < > " and ' escaped. A single scan: plain runs are copied whole, an entity
 * is written only where one of the five characters sits, and a string with none of them is
 * returned as it is.
 */
function escapeHtml(text) {
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    out += text.slice(start, i) + rep;
    start = i + 1;
  }
  return start === 0 ? text : out + text.slice(start);
}

/** Whether a UTF-16 code unit is whitespace in JavaScript's \s sense. */
function isSpace(code) {
  if (code <= 32) return code === 32 || (code >= 9 && code <= 13);
  if (code < 160) return false;
  return code === 160 || code === 5760 || (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}

/**
 * The words of a body: its runs of characters other than whitespace. The whitespace test is
 * ordered for the common case: a code unit from 33 to 159 is never whitespace, so a letter
 * costs two comparisons.
 */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let sp;
    if (c <= 32) sp = c === 32 || (c >= 9 && c <= 13);
    else if (c < 160) sp = false;
    else sp = c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (sp) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other
 * than a-z and 0-9 one "-", none at either end, at most SLUG_MAX characters (a "-" left at the cut
 * dropped), and "untitled" when nothing is left. Pure-ASCII text takes the fast path: NFKD is the
 * identity on it and it holds no combining marks.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    // The first SLUG_MAX characters of the full slug, built char by char: a kept character
    // after a gap adds '-' and then itself, and either half may fill the last slot.
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) {
        if (out.length === SLUG_MAX) break;
        out += '-';
        gap = false;
        if (out.length === SLUG_MAX) break;
      }
      out += String.fromCharCode(keep);
      if (out.length === SLUG_MAX) break;
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
      if (out.length >= SLUG_MAX) break;
    }
    out = out.slice(0, SLUG_MAX);
  }
  while (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date, cache) {
  const hit = cache.get(date);
  if (hit !== undefined) return hit;
  const out = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  cache.set(date, out);
  return out;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with its trailing spaces and tabs dropped. */
function rtrimSpacesTabs(line) {
  let end = line.length;
  while (end > 0) {
    const c = line.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return end === line.length ? line : line.slice(0, end);
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    let start = 1;
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw.slice(start, i) + n;
        i++;
        start = i + 1;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
    }
    return { value: out + raw.slice(start, raw.length - 1) };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `s` is a template name (a-z, 0-9 and `-`). */
function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug (a-z and 0-9, single `-` between), at most 64 characters. */
function isSlug(s) {
  if (s.length === 0 || s.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
    else return false;
  }
  return !prevDash;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let y = 0;
      let mo = 0;
      let d = 0;
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (let k = 0; k < tags.length; k++) {
        const t = tags[k];
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is
 * refused. `text` has "\n" line ends. Lines are walked with index scans, never split.
 */
function parseFrontMatter(text) {
  // The first line must be exactly `---`.
  let nl = text.indexOf('\n');
  const firstEnd = nl === -1 ? text.length : nl;
  if (firstEnd !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  // The closing `---`: the next line that is exactly `---`.
  let closeLine = -1;
  let closeStart = -1;
  let lineStart = nl === -1 ? text.length : nl + 1;
  let lineNo = 1;
  while (lineStart <= text.length) {
    const end = text.indexOf('\n', lineStart);
    const lineEnd = end === -1 ? text.length : end;
    if (lineEnd - lineStart === 3 && text.charCodeAt(lineStart) === 45 && text.charCodeAt(lineStart + 1) === 45 && text.charCodeAt(lineStart + 2) === 45) {
      closeLine = lineNo;
      closeStart = lineStart;
      break;
    }
    if (end === -1) break;
    lineStart = end + 1;
    lineNo++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let ls = firstEnd + 1;
  for (let ln = 1; ln < closeLine; ln++) {
    const end = text.indexOf('\n', ls);
    const lineEnd = end === -1 ? text.length : end;
    const line = text.slice(ls, lineEnd);
    ls = end + 1;
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    // `key: value`: a key of a-z and `_`, a colon, one space and the value.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      k++;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${ln + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = rtrimSpacesTabs(line.slice(k + 2));
    else return { error: `line ${ln + 1} is not "key: value"` };
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const closeEnd = text.indexOf('\n', closeStart);
  return { data, body: closeEnd === -1 ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

/** A fence's language when `line` opens one ("" for a bare fence), else null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  let s = n;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  if (s === n) return null;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: n, text: line.slice(s, e) };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text when `line` opens one, else null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return trimLine(line.slice(2));
  return null;
}

/** An ordered item's number and text when `line` opens one, else null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && i < 9) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: line.slice(0, i), text: trimLine(line.slice(i + 2)) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i === line.length) return false;
  return !isSpace(line.charCodeAt(i));
}

/** Whether a backslash escapes this code unit. */
function isEscapable(code) {
  return (
    code === 92 ||
    code === 96 ||
    code === 42 ||
    code === 95 ||
    code === 91 ||
    code === 93 ||
    code === 40 ||
    code === 41 ||
    code === 35 ||
    code === 43 ||
    code === 45 ||
    code === 46 ||
    code === 33 ||
    code === 62
  );
}

/** The first index from `from` (under `to`) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, to) {
  const wlen = what.length;
  for (let j = from; j <= to - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < to && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (under `to`, one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < to && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether `s` holds any whitespace. */
function hasSpace(s) {
  for (let i = 0; i < s.length; i++) if (isSpace(s.charCodeAt(i))) return true;
  return false;
}

/** The characters inline parsing acts on: backslash, backtick, star, bracket and the five HTML escapes. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/**
 * The range s[lo, hi) rendered inline, exactly as makefun-site's inline renders that text:
 * code spans, strong, emphasis, links and backslash escapes, everything else escaped.
 * Plain runs are copied whole (the regex jumps straight to the next character that matters);
 * a construct is only entered when its closer is really there. The HTML is built by string
 * concatenation, which V8 keeps as a rope until it is read.
 */
function inlineRange(s, lo, hi, link) {
  let out = '';
  let i = lo;
  let run = lo;
  while (true) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    const j = m === null || m.index >= hi ? -1 : m.index;
    if (j === -1) {
      if (hi > run) out += s.slice(run, hi);
      return out;
    }
    i = j;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < hi && isEscapable(s.charCodeAt(i + 1))) {
        if (i > run) out += s.slice(run, i);
        const n = s.charCodeAt(i + 1);
        out += n === 62 ? '&gt;' : s[i + 1];
        i += 2;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < hi && k > i + 1) {
        if (i > run) out += s.slice(run, i);
        out += '<code>' + escapeHtml(s.slice(i + 1, k)) + '</code>';
        i = k + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2, hi);
        if (k > i + 2) {
          if (i > run) out += s.slice(run, i);
          out += '<strong>' + inlineRange(s, i + 2, k, link) + '</strong>';
          i = k + 2;
          run = i;
          continue;
        }
        i += 2;
        continue;
      }
      const k = findSingleStar(s, i + 1, hi);
      if (k > i + 1) {
        if (i > run) out += s.slice(run, i);
        out += '<em>' + inlineRange(s, i + 1, k, link) + '</em>';
        i = k + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, hi);
      let m2 = -1;
      if (k !== -1 && k + 1 < hi && s.charCodeAt(k + 1) === 40) {
        m2 = s.indexOf(')', k + 2);
        if (m2 === -1 || m2 >= hi) m2 = -1;
      }
      if (m2 !== -1) {
        const target = s.slice(k + 2, m2);
        if (target !== '' && !hasSpace(target)) {
          if (i > run) out += s.slice(run, i);
          out += '<a href="' + escapeHtml(link(target)) + '">' + inlineRange(s, i + 1, k, link) + '</a>';
          i = m2 + 1;
          run = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (i > run) out += s.slice(run, i);
    out += c === 38 ? '&amp;' : c === 60 ? '&lt;' : c === 62 ? '&gt;' : c === 34 ? '&quot;' : '&#39;';
    i++;
    run = i;
  }
}

/** `s` rendered inline; `link(target)` is a link's href. */
function inlineStr(s, link) {
  return inlineRange(s, 0, s.length, link);
}

/**
 * `src` rendered in one pass over its lines: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading: level, id and its inline
 * HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, slugCache) {
  const ids = new Set();
  let out = '';
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    // One dispatch on the first character: a block kind is fixed by it, so a line is
    // tested for only the kinds it could be (an indented line is always paragraph text).
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1 || c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        let code = '';
        for (let k = 0; k < body.length; k++) code += escapeHtml(body[k]) + '\n';
        out += `<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>${code}</code></pre>\n`;
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text, slugCache), ids);
        const html = inlineStr(hd.text, link);
        out += `<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`;
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out += '<hr>\n';
        i++;
        continue;
      }
      const b = bulletOf(line);
      if (b !== null) {
        const items = [];
        while (i < n) {
          const m = bulletOf(lines[i]);
          if (m !== null) {
            items.push([m]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        let listHtml = '<ul>\n';
        for (let k = 0; k < items.length; k++) listHtml += `<li>${inlineStr(items[k].join('\n'), link)}</li>\n`;
        listHtml += '</ul>';
        out += listHtml + '\n';
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
      }
      out += (body.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(body.join('\n'), link)}</p>\n</blockquote>`) + '\n';
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o = orderedOf(line);
      if (o !== null) {
        const items = [];
        const start = Number(o.num);
        while (i < n) {
          const m = orderedOf(lines[i]);
          if (m !== null) {
            items.push([m.text]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        let listHtml = `${open}\n`;
        for (let k = 0; k < items.length; k++) listHtml += `<li>${inlineStr(items[k].join('\n'), link)}</li>\n`;
        listHtml += '</ol>';
        out += listHtml + '\n';
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line, a fence, a heading or a break.
    const body = [trimLine(line)];
    i++;
    while (i < n) {
      const l2 = lines[i];
      const d0 = l2.length === 0 ? -1 : l2.charCodeAt(0);
      let stop = false;
      if (d0 === -1 || d0 === 32 || d0 === 9) stop = isBlank(l2);
      else if (d0 === 96) stop = fenceOpen(l2) !== null;
      else if (d0 === 35) stop = headingOf(l2) !== null;
      else if (d0 === 45 || d0 === 42) stop = isHr(l2);
      if (stop) break;
      body.push(trimLine(lines[i++]));
    }
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out += `<p>${html}</p>\n`;
  }
  return { html: out, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether the slice s[a, b) is spaces and tabs only. */
function isSpacesTabs(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Node kinds: 0 text, 1 var, 2 raw, 3 if, 4 for, 5 include. */
const K_TEXT = 0;
const K_VAR = 1;
const K_RAW = 2;
const K_IF = 3;
const K_FOR = 4;
const K_INCLUDE = 5;

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
    const standalone = isSpacesTabs(src, lineStart, open) && isSpacesTabs(src, end, lineEnd);
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
    if (tok.t === 'text') body.push({ k: K_TEXT, text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ k: tok.t === 'var' ? K_VAR : K_RAW, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: K_FOR, kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: K_IF, kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.els ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: K_INCLUDE, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
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

/**
 * `nodes` rendered in `scope` ({ vars, parent }), as one string. `ctx` holds the parsed
 * templates (`templates`, a Map of name to nodes), and the include depth.
 */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.k) {
      case K_TEXT:
        out += node.text;
        break;
      case K_VAR:
        out += escapeHtml(textOf(lookup(scope, node.path)));
        break;
      case K_RAW:
        out += textOf(lookup(scope, node.path));
        break;
      case K_IF: {
        const v = truthy(lookup(scope, node.path));
        const branch = v !== node.not ? node.then : node.els;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case K_FOR: {
        const xs = lookup(scope, node.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [node.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(node.body, { vars, parent: scope }, ctx, depth);
        }
        break;
      }
      case K_INCLUDE: {
        const t = ctx.templates.get(node.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens on a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text. Nothing is cached from one case to the next. */
export function run(input) {
  const slugCache = new Map();
  const dateCache = new Map();
  const cardCache = new Map();
  const pageCache = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');

  // Templates, parsed in code-unit order of their name; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
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
  sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // The records templates read. A card and a page are built once per source: the same values
  // are rendered for every page, index and tag list that shows them.
  /** A page's link record as templates read it. */
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache) };
  /** A post's card, as lists show it. */
  const cardOf = (s) => {
    let card = cardCache.get(s);
    if (card === undefined) {
      card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, card);
    }
    return card;
  };
  /** A page as its layout reads it. */
  const pageOf = (s) => {
    let page = pageCache.get(s);
    if (page === undefined) {
      page = {
        ...cardOf(s),
        slug: s.slug,
        content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      };
      pageCache.set(s, page);
    }
    return page;
  };
  /** A tag as templates read it (its posts as cards). */
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const ctx = { templates };
  // Compiled templates, one render function per template that parsed; when compiling is
  // not available the tree-walk renderer runs instead.
  let compiled = null;
  try {
    compiled = new Map();
    for (const [name, nodes] of templates) compiled.set(name, compileTemplate(nodes)(compiled, lookup, textOf, escapeHtml, truthy));
  } catch {
    compiled = null;
  }
  // One top scope, reused by every render: its page, posts, pager and tag slots are set
  // to the render's values (or undefined where that render has none), which reads exactly
  // as an absent key does — a template sees undefined for a name it was not given either
  // way — and the object's shape never changes.
  const topVars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const topScope = { vars: topVars, parent: null };
  const render = (name, vars) => {
    topVars.page = vars.page;
    topVars.posts = vars.posts;
    topVars.pager = vars.pager;
    topVars.tag = vars.tag;
    if (compiled !== null) {
      const fn = compiled.get(name);
      if (fn === undefined) return null;
      try {
        return fn(topScope, 0);
      } catch {
        // A compiled template that fails renders through the tree-walk instead.
        const nodes = templates.get(name);
        if (nodes === undefined) return null;
        return renderNodes(nodes, topScope, ctx, 0);
      }
    }
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, topScope, ctx, 0);
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

// ---------------------------------------------------------------- template compilation

/**
 * Compile a parsed template (node tree) to a render function, or throw when compiling
 * is not available. The generated function behaves exactly as renderNodes does: it
 * returns the rendered string, in scope `S`, at include depth `depth`. Paths are
 * hoisted as constants, text as string literals, and every for gets its own scope and
 * loop variables, so nested loops never shadow each other. The factory closes over
 * the template map and the lookup/text/escape/truthy helpers; includes resolve through
 * the map at render time, so a template may include one compiled after it.
 */
function compileTemplate(nodes) {
  const paths = [];
  const pathIndex = new Map();
  const pathOf = (p) => {
    const key = p.join('.');
    let idx = pathIndex.get(key);
    if (idx === undefined) {
      idx = paths.length;
      paths.push(p);
      pathIndex.set(key, idx);
    }
    return `P${idx}`;
  };
  let counter = 0;
  const gen = (ns, scope) => {
    let code = '';
    for (const node of ns) {
      switch (node.k) {
        case K_TEXT:
          code += `out+=${JSON.stringify(node.text)};`;
          break;
        case K_VAR:
          code += `out+=E(T(L(${scope},${pathOf(node.path)})));`;
          break;
        case K_RAW:
          code += `out+=T(L(${scope},${pathOf(node.path)}));`;
          break;
        case K_IF: {
          const not = node.not ? 'true' : 'false';
          code += `if(TR(L(${scope},${pathOf(node.path)}))!==${not}){${gen(node.then, scope)}}`;
          if (node.els !== null) code += `else{${gen(node.els, scope)}}`;
          break;
        }
        case K_FOR: {
          const n = counter++;
          code += `{const x${n}=L(${scope},${pathOf(node.path)});if(Array.isArray(x${n})){for(let k${n}=0;k${n}<x${n}.length;k${n}++){const s${n}={vars:{[${JSON.stringify(node.name)}]:x${n}[k${n}],loop:{index:k${n}+1,first:k${n}===0,last:k${n}===x${n}.length-1,length:x${n}.length}},parent:${scope}};${gen(node.body, `s${n}`)}}}}`;
          break;
        }
        case K_INCLUDE:
          code += `if(depth<${INCLUDE_DEPTH}){const f=F.get(${JSON.stringify(node.name)});if(f!==undefined)out+=f(${scope},depth+1);}`;
          break;
      }
    }
    return code;
  };
  const body = gen(nodes, 'S');
  const decls = paths.map((p, i) => `P${i}=${JSON.stringify(p)}`).join(',');
  const factory = new Function('F', 'L', 'T', 'E', 'TR', `return function(S,depth){let out='';${decls ? `const ${decls};` : ''}${body}return out;}`);
  return factory;
}
