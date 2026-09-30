import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCss, sanitizeSvg } from '../shared/svg.ts';

const clean = (body: string, open = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">') => sanitizeSvg(`${open}${body}</svg>`);
/** Nothing in the output that could run or load: the forms the sanitiser exists to stop, case-insensitively. */
function assertInert(out: string) {
  assert.doesNotMatch(out, /<script|<foreignobject|<iframe|<a[\s>]|<animate|<set[\s>/]|<handler|<!doctype|<!entity|<\?|<!--/i);
  assert.doesNotMatch(out, /\son\w+\s*=/i, 'an event handler');
  assert.doesNotMatch(out, /javascript:|vbscript:/i);
  for (const m of out.matchAll(/href="([^"]*)"/g)) assert.ok(m[1].startsWith('#') || /^data:image\/(png|jpe?g|gif|webp);base64,/.test(m[1]), `href ${m[1]}`);
  for (const m of out.matchAll(/url\(([^)]*)\)/gi)) assert.match(m[1], /^\s*['"]?#/, `url(${m[1]})`);
}

test('svg: drawing survives, as the same markup', () => {
  const body =
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
    '<g transform="translate(1 1)"><rect width="5" height="5" fill="url(#g)" style="stroke: #000; stroke-width: 0.5"/>' +
    '<text x="1" y="8" font-size="2">a &lt; b &amp; c</text><use href="#g"/></g>';
  const out = clean(body);
  assert.equal(out, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`);
  assertInert(out);
});

test('svg: scripts, handlers, foreignObject, animation and links are gone, with what is in them', () => {
  const out = clean(
    '<script>alert(1)</script><SCRIPT>alert(2)</SCRIPT><script><![CDATA[alert(3)]]></script>' +
      '<rect width="1" height="1" onload="alert(4)" ONCLICK="alert(5)"/>' +
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(6)"/></div></foreignObject>' +
      '<a href="javascript:alert(7)"><circle r="1"/></a>' +
      '<animate attributeName="href" to="javascript:alert(8)"/><set attributeName="onload" to="alert(9)"/>' +
      '<iframe src="https://evil.example"/><circle r="2"/>',
  );
  assertInert(out);
  assert.doesNotMatch(out, /alert/);
  assert.match(out, /<circle r="2"\/>/, 'the drawing after them is kept');
});

test('svg: nothing outside the file is referenced', () => {
  const out = clean(
    '<image href="https://evil.example/pixel.png" width="1" height="1"/>' +
      '<image xlink:href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>' +
      '<use href="https://evil.example/sprite.svg#x"/><use xlink:href="#ok"/>' +
      '<rect fill="url(https://evil.example/x)" width="1" height="1"/>' +
      '<rect style="fill: url(//evil.example/y); stroke: red" width="1" height="1"/>' +
      '<rect filter="url( #f )" width="1" height="1"/>' +
      '<style>@import url(https://evil.example/a.css); rect { fill: url("https://evil.example/b") } circle { fill: url(#g) }</style>' +
      '<style>rect { background: u\\72l(https://evil.example/c) }</style>',
  );
  assertInert(out);
  assert.doesNotMatch(out, /evil/);
  assert.match(out, /<image href="data:image\/png;base64,iVBORw0KGgo=" width="1" height="1"\/>/, 'an embedded raster image is kept (xlink:href becomes href)');
  assert.match(out, /<use href="#ok"\/>/);
  assert.match(out, /circle \{ fill: url\(#g\) \}/);
  assert.match(out, /<style><\/style>/, 'CSS with an escape is dropped whole');
});

test('svg: encoded tricks are decoded before they are judged, and re-escaped after', () => {
  const out = clean(
    '<a href="jav&#x61;script:alert(1)"/><image href="&#106;avascript:alert(2)"/>' +
      '<rect fill="u&#x72;l(https://evil.example/x)" width="1" height="1"/>' +
      '<text>&lt;script&gt;alert(3)&lt;/script&gt; &unknown; &#0;</text>' +
      '<title>"quoted" &apos;x&apos;</title>',
  );
  assertInert(out);
  assert.doesNotMatch(out, /evil/);
  assert.match(out, /<text>&lt;script&gt;alert\(3\)&lt;\/script&gt; &amp;unknown; <\/text>/, 'text stays text');
});

test('svg: prologue, DOCTYPE entities, comments and foreign namespaces are dropped', () => {
  const out = sanitizeSvg(
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>">]><!-- note -->' +
      '<svg xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="10" inkscape:label="l">' +
      '<sodipodi:namedview/><inkscape:perspective><rect/></inkscape:perspective><metadata>m</metadata>&x;<circle r="1"/></svg>' +
      '<script>after the root</script>',
  );
  assertInert(out);
  assert.equal(out, '<svg xmlns="http://www.w3.org/2000/svg" width="10">&amp;x;<circle r="1"/></svg>');
  assert.equal(
    sanitizeSvg('<svg xmlns="http://www.w3.org/1999/xhtml"><g xmlns="http://www.w3.org/1999/xhtml" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script><rect/></g></svg>'),
    '<svg xmlns="http://www.w3.org/2000/svg"><g><rect/></g></svg>',
    'only the SVG namespace, whatever the file declares',
  );
  assert.equal(sanitizeSvg('<svg><use xlink:href="#a" href="#b"/></svg>'), '<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/></svg>', 'one href');
});

test('svg: broken markup ends closed, and something that is not an SVG is refused', () => {
  assert.equal(sanitizeSvg('<svg><g><rect width="1"/>'), '<svg xmlns="http://www.w3.org/2000/svg"><g><rect width="1"/></g></svg>');
  assert.equal(sanitizeSvg('<svg><g></svg>'), '<svg xmlns="http://www.w3.org/2000/svg"><g></g></svg>');
  assert.equal(sanitizeSvg('<svg><script><g></script><rect/></svg>'), '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
  assert.equal(sanitizeSvg('<svg>1 < 2</svg>'), '<svg xmlns="http://www.w3.org/2000/svg">1 &lt; 2</svg>');
  assert.throws(() => sanitizeSvg('<html><body>hi</body></html>'), /not an SVG/);
  assert.throws(() => sanitizeSvg('<script>alert(1)</script>'), /not an SVG/);
  assert.throws(() => sanitizeSvg(''), /not an SVG/);
});

test('svg: CSS keeps only references into the document', () => {
  assert.equal(sanitizeCss('rect { fill: url(#a) } .b { stroke: red }'), 'rect { fill: url(#a) } .b { stroke: red }');
  assert.equal(sanitizeCss('rect { fill: url(x.png) }'), 'rect { fill: none }');
  assert.equal(sanitizeCss('@import "x.css"; rect { fill: red }'), ' rect { fill: red }');
  for (const bad of ['a{b:expression(alert(1))}', '@font-face{src:url(x)}', 'a{b:image-set("x.png" 1x)}', 'a{/**/b:c}', 'a{-moz-binding:url(x)}', 'a{b:url(x}']) assert.equal(sanitizeCss(bad), '', bad);
});
