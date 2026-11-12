// KaTeX in messages: user sizes and macro expansion are capped (src/markdown/katex.ts). Run: npm test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { katexHtml } from '../src/markdown/katex.ts'

test('a giant \\rule is capped to maxSize, a macro bomb stops', () => {
  const html = katexHtml('\\rule{9000em}{9000em}', false)
  assert.doesNotMatch(html, /9000em;/)
  assert.match(html, /border-right-width:10em/)
  const bomb = '\\def\\a{xxxxxxxxxx}\\def\\b{\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a}\\def\\c{\\b\\b\\b\\b\\b\\b\\b\\b\\b\\b}\\c'
  assert.match(katexHtml(bomb, false), /Too many expansions/)
})
