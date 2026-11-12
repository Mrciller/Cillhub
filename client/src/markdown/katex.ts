import katex from 'katex'

// maxSize caps every positive user size (\rule, \hspace, \raisebox) in em; negative ones are not capped, the CSS clips
// them (.md-katex-*). maxExpand stops macro bombs.
export const KATEX_LIMITS = { maxSize: 10, maxExpand: 100 }

export const katexHtml = (tex: string, displayMode: boolean) =>
  katex.renderToString(tex, { displayMode, throwOnError: false, output: 'htmlAndMathml', ...KATEX_LIMITS })
