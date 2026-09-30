/**
 * An agent-written SVG, rebuilt from an allowlist so it cannot run code or reach out when the portal shows it:
 * no scripts, event handlers, foreignObject, animation (it can rewrite an href), links, or references to anything
 * outside the file (only `#fragment` hrefs and `url(#id)`, and raster `data:` images inside <image>). Comments,
 * processing instructions and the DOCTYPE (entity declarations) are dropped; the output is serialised afresh, so
 * nothing the input's markup smuggles survives as markup. Shared by the server (files it serves or keeps) and the
 * web page (`data:image/svg+xml` URIs in agent messages).
 */

const ELEMENTS = new Set(
  (
    'svg g defs symbol use title desc path rect circle ellipse line polyline polygon text tspan textPath ' +
    'linearGradient radialGradient stop pattern clipPath mask marker image style switch view ' +
    'filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap ' +
    'feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology ' +
    'feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence'
  ).split(' '),
);

const RASTER_DATA = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]*$/i;
const TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>?|<\/\s*([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|</gi;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML character references and the five predefined entities; any other `&name;` stays literal text. */
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');

/** CSS that references only the document itself, or '' when it could reach out or hide what it does. */
export function sanitizeCss(css: string): string {
  // Escapes and comments can spell "url(" without those letters; the rest load or run things.
  if (/\\|\/\*|expression\s*\(|-moz-binding|behavior\s*:|javascript:|image-set|@font-face|@namespace/i.test(css)) return '';
  const out = css.replace(/@import[^;]*;?/gi, '').replace(/url\s*\(\s*(['"]?)([^)]*?)\1\s*\)/gi, (m, _q, u: string) => (u.trim().startsWith('#') ? m : 'none'));
  return /url\s*\((?!\s*['"]?#)|@import/i.test(out) ? '' : out;
}

/** An attribute's value as kept, or undefined to drop it. */
function keepAttr(el: string, name: string, value: string): string | undefined {
  const n = name.toLowerCase();
  if (n.startsWith('on')) return undefined;
  // Only the SVG namespace, set on the root: a declaration could turn an allowed name into another language's element.
  if (n === 'xmlns' || n.startsWith('xmlns:')) return undefined;
  if (n === 'href' || n === 'xlink:href') {
    const v = value.trim();
    if (v.startsWith('#')) return v;
    return el === 'image' && RASTER_DATA.test(v) ? v : undefined;
  }
  if (name.includes(':') && n !== 'xml:space' && n !== 'xml:lang') return undefined;
  if (n === 'style') return sanitizeCss(value) || undefined;
  const flat = value.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
  if (/javascript:|vbscript:|data:/.test(flat)) return undefined;
  if (/url\(/.test(flat) && !/^url\(['"]?#[^)]*\)$/.test(flat)) return undefined;
  return value;
}

/** A safe copy of `input`; throws when it holds no <svg> root. */
export function sanitizeSvg(input: string): string {
  const out: string[] = [];
  const open: string[] = [];
  const dropped: string[] = []; // open elements left out with everything in them
  let rooted = false;
  let css: string[] | null = null; // the text of an open <style>, sanitised as a whole when it closes

  const text = (s: string) => {
    if (dropped.length || !rooted) return;
    if (css) css.push(s);
    else out.push(escText(s));
  };
  const close = () => {
    const name = open.pop()!;
    if (name === 'style' && css) {
      out.push(escText(sanitizeCss(css.join(''))));
      css = null;
    }
    out.push(`</${name}>`);
    return name;
  };

  for (const m of input.matchAll(TOKEN)) {
    const [whole, cdata, endName, startName, attrs, selfClose, chars] = m;
    if (chars !== undefined) text(decode(chars));
    else if (cdata !== undefined) text(cdata);
    else if (endName !== undefined) {
      if (dropped.length) {
        const i = dropped.lastIndexOf(endName);
        if (i >= 0) dropped.length = i;
      } else if (open.includes(endName)) while (close() !== endName);
    } else if (startName !== undefined) {
      if (dropped.length || css || !ELEMENTS.has(startName) || (!rooted && startName !== 'svg')) {
        if (!selfClose) dropped.push(startName);
        continue;
      }
      rooted = true;
      const kept = new Map<string, string>();
      if (!open.length) kept.set('xmlns', 'http://www.w3.org/2000/svg');
      for (const a of (attrs ?? '').matchAll(ATTR)) {
        const v = keepAttr(startName, a[1], decode(a[2] ?? a[3] ?? ''));
        const name = a[1] === 'xlink:href' ? 'href' : a[1];
        if (v !== undefined && !kept.has(name)) kept.set(name, v);
      }
      const attrText = [...kept].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
      out.push(`<${startName}${attrText}${selfClose ? '/' : ''}>`);
      if (!selfClose) {
        open.push(startName);
        if (startName === 'style') css = [];
      }
    } else if (whole === '<') text('<');
    if (rooted && !open.length) break; // the root closed: anything after it is not part of the image
  }
  if (!rooted) throw new Error('not an SVG image');
  while (open.length) close();
  return out.join('');
}
