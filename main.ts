// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file split into lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileParts {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const fin = text.endsWith(br);
  if (fin) lines.pop();
  return { lines, br, fin };
}

function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.fin ? f.br : '');
}

/** Leading spaces and tabs of a line. */
function leadOf(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

function trimEndWs(s: string): string {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i -= 1;
  return s.slice(0, i);
}

function trimWs(s: string): string {
  let a = 0;
  while (a < s.length && (s[a] === ' ' || s[a] === '\t')) a += 1;
  let b = s.length;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b -= 1;
  return s.slice(a, b);
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions at or after `from` where O matches lines at one tier (SPEC.md section 5). */
function occAt(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = Math.max(0, from); i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier at which O occurs at or after `from`, with its positions; null when none. */
function findTier(O: string[], lines: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occAt(O, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line (its index into O) or a fresh line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** Replace O at `at` with N. Context lines come from the file; at tier 2 the rest are re-indented. */
function applyReplace(lines: string[], at: number, O: string[], N: NewLine[], tier: number): string[] {
  const matched = lines.slice(at, at + O.length);
  const p = O.length > 0 ? leadOf(O[0]!) : '';
  const f = matched.length > 0 ? leadOf(matched[0]!) : '';
  const out = N.map((item) => {
    if (item.ctx !== null) return matched[item.ctx]!;
    const s = item.text;
    if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(p)) return f + s.slice(p.length);
    return s;
  });
  return [...lines.slice(0, at), ...out, ...lines.slice(at + O.length)];
}

/** Split body lines into old lines O and new lines N (context lines point back into O). */
function splitBodyItems(items: Array<{ kind: ' ' | '-' | '+'; text: string }>): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const it of items) {
    if (it.kind === ' ') {
      O.push(it.text);
      N.push({ text: it.text, ctx: O.length - 1 });
    } else if (it.kind === '-') O.push(it.text);
    else N.push({ text: it.text, ctx: null });
  }
  return { O, N };
}

/** One hunk body line: context, old or new text, and whether a `\` line follows it. */
interface HunkItem {
  kind: ' ' | '-' | '+';
  text: string;
  noNl: boolean;
}

interface Hunk {
  a: number;
  items: HunkItem[];
}

/** One unified section: its named paths (null below means `/dev/null`) and its hunks. */
interface UniSection {
  start: number;
  diffA: string | null;
  diffB: string | null;
  headOld: { path: string } | null | undefined;
  headNew: { path: string } | null | undefined;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;

/** Path after `--- ` or `+++ `: up to the first tab, spaces removed, `a/`/`b/` stripped; null is `/dev/null`. */
function headerPath(line: string): { path: string } | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return { path: raw.slice(2) };
  return { path: raw };
}

function isDiffGit(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

/** Read unified diffs (SPEC.md section 6) into one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let hunk: Hunk | null = null;
  const closeHunk = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.items.pop();
        else break;
      }
      cur.hunks.push(hunk);
    }
    hunk = null;
  };
  const startSection = (at: number, a: string | null, b: string | null): UniSection => {
    const s: UniSection = {
      start: at, diffA: a, diffB: b, headOld: undefined, headNew: undefined, hasPair: false,
      renameFrom: null, renameTo: null, create: false, del: false, hunks: [],
    };
    sections.push(s);
    return s;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeHunk();
      } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '' || line.startsWith('\\')) {
        if (line.startsWith('\\')) {
          const last = hunk.items[hunk.items.length - 1];
          if (last !== undefined) last.noNl = true;
        } else {
          hunk.items.push({ kind: line === '' ? ' ' : (line[0] as ' ' | '-' | '+'), text: line === '' ? '' : line.slice(1), noNl: false });
        }
        continue;
      } else {
        closeHunk();
      }
    }
    if (isDiffGit(line)) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection(i, m[1]!, m[2]!);
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
          cur.headOld = headerPath(line);
          cur.headNew = headerPath(lines[i + 1]!);
          cur.hasPair = true;
        } else {
          cur = startSection(i, null, null);
          cur.headOld = headerPath(line);
          cur.headNew = headerPath(lines[i + 1]!);
          cur.hasPair = true;
        }
        i += 1;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && cur.headNew === undefined) cur.headNew = headerPath(line);
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), items: [] };
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
    }
  }
  closeHunk();
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One unified section as an edit: create, delete, move or change (SPEC.md section 6). */
function unifiedEdit(s: UniSection, strict: boolean): Edit {
  let oldP: string | null | undefined;
  let newP: string | null | undefined;
  if (s.hasPair) {
    oldP = s.headOld === null ? null : s.headOld?.path;
    newP = s.headNew === null ? null : s.headNew?.path;
  } else {
    oldP = s.renameFrom !== null ? s.renameFrom : s.diffA ?? undefined;
    if (s.headNew !== undefined) newP = s.headNew === null ? null : s.headNew.path;
    else newP = s.renameTo !== null ? s.renameTo : s.diffB ?? undefined;
  }
  if (oldP === undefined) oldP = newP;
  if (newP === undefined) newP = oldP;
  if (oldP === undefined || newP === undefined) throw new Exit2(`error: parse ${s.start + 1}`);
  const isCreate = oldP === null || s.create;
  const isDelete = !isCreate && (newP === null || s.del);
  if ((isCreate && newP === null) || (isDelete && oldP === null)) throw new Exit2(`error: parse ${s.start + 1}`);
  return (tree) => {
    if (isCreate) {
      const p = newP as string;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noNl = false;
      for (const h of s.hunks) {
        for (const it of h.items) {
          if (it.kind === '+') {
            plus.push(it.text);
            noNl = it.noNl;
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : `${plus.join('\n')}${noNl ? '' : '\n'}`);
      return;
    }
    if (isDelete) {
      const p = oldP as string;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldPath = oldP as string;
    const newPath = newP as string;
    const isMove = oldPath !== newPath;
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (isMove && !safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const f = splitFile(before);
    let lines = [...f.lines];
    let fin = f.fin;
    let d = 0;
    for (const h of s.hunks) {
      const { O, N } = splitBodyItems(h.items);
      let tailNoNl = false;
      for (let k = h.items.length - 1; k >= 0; k -= 1) {
        const it = h.items[k]!;
        if (it.kind === ' ' || it.kind === '+') {
          tailNoNl = it.noNl;
          break;
        }
      }
      if (O.length === 0) {
        const at = Math.min(Math.max(h.a + d, 0), lines.length);
        const atEnd = at === lines.length;
        lines.splice(at, 0, ...N.map((x) => x.text));
        if (atEnd) fin = !tailNoNl;
        d += N.length;
        continue;
      }
      const found = findTier(O, lines, 0, strict);
      if (found === null) throw new Fail('no-match', oldPath);
      const target = h.a - 1 + d;
      let at = found.pos[0]!;
      let best = Math.abs(at - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < best) {
          best = dist;
          at = p;
        }
      }
      const atEnd = at + O.length === lines.length;
      lines = applyReplace(lines, at, O, N, found.tier);
      if (atEnd) fin = !tailNoNl;
      d += N.length - O.length;
    }
    const out = joinFile({ lines, br: f.br, fin });
    if (isMove) {
      tree.now.set(newPath, out);
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
    } else {
      tree.now.set(oldPath, out);
    }
  };
}

/** One SEARCH/REPLACE block as an edit (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(oldLines, f.lines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const nItems: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const out = applyReplace(f.lines, found.pos[0]!, oldLines, nItems, found.tier);
    tree.now.set(path, joinFile({ lines: out, br: f.br, fin: f.fin }));
  };
}

/** Read SEARCH/REPLACE blocks (SPEC.md section 7) into one edit per block. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevEnd = rep + 1;
    prevPath = path;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: an optional anchor, an end-of-file mark, and its body lines. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: Array<{ kind: ' ' | '-' | '+'; text: string }>;
}

function v4aAdd(path: string, addLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, addLines.length === 0 ? '' : `${addLines.join('\n')}\n`);
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** One V4A Update File section as an edit (SPEC.md section 8). */
function v4aUpdate(path: string, moveTo: string | undefined, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let lines = [...f.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier([ch.anchor], lines, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      const { O, N } = splitBodyItems(ch.items);
      if (O.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines.splice(at, 0, ...N.map((x) => x.text));
        cursor = at + N.length;
        continue;
      }
      const found = findTier(O, lines, cursor, strict);
      if (found === null) throw new Fail('no-match', path);
      const at = found.pos[0]!;
      if (ch.eof && at + O.length !== lines.length) throw new Fail('no-match', path);
      lines = applyReplace(lines, at, O, N, found.tier);
      cursor = at + N.length;
    }
    const out = joinFile({ lines, br: f.br, fin: f.fin });
    if (moveTo !== undefined) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Read V4A patches (SPEC.md section 8) into one edit per section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice(17).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice(17).trim();
    } else throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i;
    i += 1;
    const content: Array<{ text: string; idx: number }> = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      content.push({ text: lines[i]!, idx: i });
      i += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const c of content) {
        if (c.text.startsWith('+')) addLines.push(c.text.slice(1));
        else if (blank(c.text)) addLines.push('');
        else throw new Exit2(`error: parse ${c.idx + 1}`);
      }
      edits.push(v4aAdd(path, addLines));
    } else if (kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.idx + 1}`);
      edits.push(v4aDelete(path));
    } else {
      let moveTo: string | undefined;
      let rest = content;
      if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
        moveTo = rest[0]!.text.slice(13).trim();
        rest = rest.slice(1);
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      let afterEof = false;
      const pushChunk = (): void => {
        if (chunk !== null) {
          chunks.push(chunk);
          chunk = null;
        }
      };
      for (const c of rest) {
        const t = c.text;
        if (t.startsWith('@@')) {
          pushChunk();
          afterEof = false;
          const anchor = t.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
        } else if (t === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${c.idx + 1}`);
          chunk.eof = true;
          pushChunk();
          afterEof = true;
        } else if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (afterEof) throw new Exit2(`error: parse ${c.idx + 1}`);
          if (chunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${c.idx + 1}`);
            chunk = { anchor: null, eof: false, items: [] };
          }
          chunk.items.push({ kind: t === '' ? ' ' : (t[0] as ' ' | '-' | '+'), text: t === '' ? '' : t.slice(1) });
        } else {
          throw new Exit2(`error: parse ${c.idx + 1}`);
        }
      }
      pushChunk();
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${secLine + 1}`);
      edits.push(v4aUpdate(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      const di = rows.findIndex((r) => r.line === `D ${o}`);
      if (di >= 0) rows.splice(di, 1);
      const ai = rows.findIndex((r) => r.line === `A ${n}`);
      if (ai >= 0) rows.splice(ai, 1);
      rows.push({ key: n, line: `R ${o} -> ${n}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
