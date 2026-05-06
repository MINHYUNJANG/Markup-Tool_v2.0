import * as cheerio from 'cheerio';
import Groq from 'groq-sdk';

let groqClient: Groq | null = null;
const SUPPORTED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function getGroqClient(): Groq {
  if (!groqClient) groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groqClient;
}

function mimeFromContentType(ct: string): string {
  const base = ct.split(';')[0].trim().toLowerCase();
  if (SUPPORTED_MIME.has(base)) return base;
  if (base.includes('png')) return 'image/png';
  if (base.includes('gif')) return 'image/gif';
  if (base.includes('webp')) return 'image/webp';
  return 'image/jpeg';
}

async function ocrImage(imageUrl: string): Promise<string> {
  try {
    const resp = await fetch(imageUrl, { redirect: 'follow' });
    if (!resp.ok) return '';
    const mediaType = mimeFromContentType(resp.headers.get('content-type') ?? 'image/jpeg');
    const buf = await resp.arrayBuffer();
    const imageData = Buffer.from(buf).toString('base64');

    const result = await getGroqClient().chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageData}` } },
          { type: 'text', text: '이 이미지에 텍스트가 있으면 모두 추출해주세요. 텍스트만 반환하고 설명은 생략하세요. 텍스트가 없으면 빈 문자열을 반환하세요.' },
        ],
      }],
    } as any);
    const text = (result.choices[0].message.content ?? '').trim();
    if (['빈 문자열', '텍스트가 없습니다', '없음', ''].includes(text)) return '';
    return text;
  } catch {
    return '';
  }
}

const SEMANTIC_SELECTORS = ['main', 'article', '[role="main"]'];

const COMMON_SELECTORS = [
  '#content', '#main', '#article', '#post', '#body', '#all_box',
  '.content', '.main', '.article', '.post', '.view',
  '.view_content', '.view_con', '.board_view', '.board-view',
  '.article-body', '.article_body', '.news_body', '.news-body',
  '.cont_wrap', '.cont-wrap', '.sub_content', '.sub-content',
  '.inner_content', '.inner-content', '.page_content',
  '.bbs_content', '.bbs-content', '.detail_content',
];

const INNER_SELECTORS = [
  '.view_content', '.view_con', '.view-content', '.view-con',
  '.board_view', '.board-view', '.board_content', '.board-content',
  '.detail_content', '.detail-content', '.detail_wrap',
  '.article_body', '.article-body', '.article_content',
  '.cont_inner', '.cont-inner', '.cont_body',
  '.tbl_wrap', '.tblWrap', '.tblTy01', '.tbl_st',
  '.bbs_view', '.bbs-view',
  'td.content', 'td#content',
];

const TITLE_SELECTORS = [
  'h1',
  '#title_bar', '.title_bar', '.titleBar',
  '.tit', '.title', '.tit1',
  '.view_title', '.view-title', '.cont_title', '.cont-title',
  '.page_title', '.page-title', '.sub_title', '.sub-title',
  '.board_title', '.board-title',
  'h2',
];

const SKIP_TAGS = new Set(['nav', 'header', 'footer', 'aside']);
const SKIP_CLASS_KEYWORDS = ['nav', 'header', 'footer', 'aside', 'gnb', 'lnb', 'snb', 'menu', 'sidebar'];

const NOISE_TAGS = ['header', 'nav', 'footer', 'aside'];
const NOISE_ID_CLASS = new Set([
  'header', 'footer', 'gnb', 'lnb', 'snb', 'sidebar',
  'nav', 'navigation', 'menu', 'quick', 'banner', 'ad',
  'location', 'breadcrumb', 'sns', 'snsbox', 'share',
  'print', 'toolbar', 'util', 'floating', 'popup',
]);
const CONTAINER_TAGS = new Set(['div', 'section', 'nav', 'aside', 'ul', 'ol', 'header', 'footer']);

function isSkipEl($el: cheerio.Cheerio<any>): boolean {
  const tag = $el.prop('tagName')?.toLowerCase() ?? '';
  if (SKIP_TAGS.has(tag)) return true;
  const cls = ($el.attr('class') ?? '').toLowerCase();
  return SKIP_CLASS_KEYWORDS.some(kw => cls.includes(kw));
}

function scoreEl($: cheerio.CheerioAPI, el: any): number {
  const $el = $(el);
  const fullText = $el.text().trim();
  if (!fullText) return 0;
  let linkText = '';
  $el.find('a').each((_, a) => { linkText += $(a).text().trim(); });
  const linkRatio = linkText.length / fullText.length;
  const childCount = Math.max($el.find('*').length, 1);
  return fullText.length * (1 - linkRatio) / childCount;
}

function drillDown($: cheerio.CheerioAPI, el: any, depth = 3): any {
  if (depth === 0) return el;
  const $el = $(el);
  const parentTextLen = $el.text().trim().length;

  for (const sel of INNER_SELECTORS) {
    const child = $el.find(sel).first();
    if (!child.length) continue;
    const childTextLen = child.text().trim().length;
    if (childTextLen >= parentTextLen * 0.4) return drillDown($, child.get(0), depth - 1);
  }

  let bestChild: any = null;
  let bestScore = 0;
  $el.children('div, section, article, td').each((_, child) => {
    const $child = $(child);
    const childTextLen = $child.text().trim().length;
    if (childTextLen < 200) return;
    let linkText = '';
    $child.find('a').each((_, a) => { linkText += $(a).text().trim(); });
    const linkRatio = linkText.length / Math.max(childTextLen, 1);
    if (linkRatio > 0.5) return;
    const s = scoreEl($, child);
    if (s > bestScore) { bestScore = s; bestChild = child; }
  });

  if (bestChild) {
    const coverage = $(bestChild).text().trim().length / Math.max(parentTextLen, 1);
    if (coverage >= 0.6) return drillDown($, bestChild, depth - 1);
  }
  return el;
}

function inSkipArea($: cheerio.CheerioAPI, el: any): boolean {
  let current = el.parent;
  while (current && current.type === 'tag') {
    const tag = current.tagName?.toLowerCase() ?? '';
    if (tag === 'body' || tag === 'html') break;
    if (SKIP_TAGS.has(tag)) return true;
    const cls = (current.attribs?.class ?? '').toLowerCase();
    if (SKIP_CLASS_KEYWORDS.some(kw => cls.includes(kw))) return true;
    current = current.parent;
  }
  return false;
}

function findByTitle($: cheerio.CheerioAPI): [any, string] {
  let titleEl: any = null;

  outer: for (const sel of TITLE_SELECTORS) {
    const matches = $(sel);
    for (let i = 0; i < matches.length; i++) {
      const el = matches.get(i);
      if ($(el).text().trim().length < 2) continue;
      if (inSkipArea($, el)) continue;
      titleEl = el;
      break outer;
    }
  }
  if (!titleEl) return [null, ''];

  const titleText = $(titleEl).text().trim().slice(0, 20);
  const label = `(타이틀 기반: "${titleText}")`;

  $(titleEl).siblings().each((_, sib) => {
    if (!titleEl) return;
    const $sib = $(sib);
    const sibText = $sib.text().trim();
    if (sibText.length < 100) return;
    let linkText = '';
    $sib.find('a').each((_, a) => { linkText += $(a).text().trim(); });
    const linkRatio = linkText.length / Math.max(sibText.length, 1);
    if (linkRatio < 0.5) { titleEl = { found: sib }; }
  });

  if (titleEl?.found) return [titleEl.found, label];

  let node = titleEl.parent;
  while (node && node.type === 'tag') {
    const tag = node.tagName?.toLowerCase() ?? '';
    if (tag === 'body' || tag === 'html') break;
    if (SKIP_TAGS.has(tag)) { node = node.parent; continue; }
    const cls = (node.attribs?.class ?? '').toLowerCase();
    if (SKIP_CLASS_KEYWORDS.some(kw => cls.includes(kw))) { node = node.parent; continue; }

    const $node = $(node);
    const nodeText = $node.text().trim();
    const nodeImgs = $node.find('img').length;
    let linkText = '';
    $node.find('a').each((_, a) => { linkText += $(a).text().trim(); });
    const linkRatio = linkText.length / Math.max(nodeText.length, 1);

    if (nodeText.length > 200 && linkRatio < 0.4) return [node, label];
    const nonLinkTextLen = nodeText.length - linkText.length;
    if (nodeImgs > 0 && nonLinkTextLen < 50) return [node, label];

    node = node.parent;
  }

  return [titleEl.parent ?? titleEl, label];
}

function removeNoise($: cheerio.CheerioAPI): void {
  $(NOISE_TAGS.join(', ')).remove();
  CONTAINER_TAGS.forEach(tag => {
    $(tag).each((_, el) => {
      const elem = el as any;
      const elId = (elem.attribs?.id ?? '').toLowerCase();
      const elCls = (elem.attribs?.class ?? '').toLowerCase();
      if (Array.from(NOISE_ID_CLASS).some(kw => elId.includes(kw) || elCls.includes(kw))) {
        $(el).remove();
      }
    });
  });
}

function autoDetect($: cheerio.CheerioAPI): [any, string] {
  for (const sel of SEMANTIC_SELECTORS) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 100) return [el.get(0), sel];
  }
  for (const sel of COMMON_SELECTORS) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 100) return [el.get(0), sel];
  }

  const [el, label] = findByTitle($);
  if (el) return [el, label];

  let bestEl: any = null;
  let bestScore = 0;
  $('div, section, td').each((_, tag) => {
    const $tag = $(tag);
    const fullText = $tag.text().trim();
    if (fullText.length < 200) return;
    let linkText = '';
    $tag.find('a').each((_, a) => { linkText += $(a).text().trim(); });
    const linkRatio = linkText.length / Math.max(fullText.length, 1);
    if (linkRatio > 0.5) return;
    const childCount = Math.max($tag.find('*').length, 1);
    const s = fullText.length * (1 - linkRatio) / childCount;
    if (s > bestScore) { bestScore = s; bestEl = tag; }
  });

  if (bestEl) return [bestEl, '(자동 감지)'];
  return [null, ''];
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|td|th|tr|blockquote|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#[0-9]+;/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n');
}

export interface CrawlResult {
  success: boolean;
  html?: string;
  text?: string;
  images?: Array<{ src: string; alt: string; ocr_text: string }>;
  detected_selector?: string;
  error?: string;
}

export async function crawl(url: string, selector = ''): Promise<CrawlResult> {
  console.log('CRAWL start', url);
  let html: string;
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarkupTool/1.0)' },
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return { success: false, error: `페이지 로딩 실패: HTTP ${resp.status}` };
    html = await resp.text();
  } catch (e: any) {
    return { success: false, error: `페이지 로딩 실패: ${e.message}` };
  }

  const $ = cheerio.load(html);
  let element: any = null;
  let detectedSelector = '';

  if (selector) {
    const found = $(selector).first();
    if (!found.length) return { success: false, error: `셀렉터 '${selector}'에 해당하는 요소를 찾을 수 없습니다.` };
    element = found.get(0);
    detectedSelector = selector;
  } else {
    removeNoise($);
    const [el, sel] = autoDetect($);
    if (!el) return { success: false, error: '본문 영역을 자동으로 감지하지 못했습니다. CSS 셀렉터를 직접 입력해주세요.' };
    detectedSelector = sel;
    const refined = drillDown($, el);
    if (refined !== el) {
      const cls = $(refined).attr('class')?.split(/\s+/).join('.') ?? '';
      const rid = $(refined).attr('id') ?? '';
      const label = cls ? `.${cls}` : (rid ? `#${rid}` : (refined as any).tagName?.toLowerCase() ?? '');
      detectedSelector = `${sel} → ${label}`;
      element = refined;
    } else {
      element = el;
    }
  }

  const $el = $(element);
  const imgJobs: Array<{ url: string; alt: string }> = [];
  $el.find('img').each((_, img) => {
    const src = $(img).attr('src') || $(img).attr('data-src') || '';
    if (!src || src.startsWith('data:')) return;
    try {
      const absUrl = new URL(src, url).href;
      imgJobs.push({ url: absUrl, alt: $(img).attr('alt') ?? '' });
    } catch {}
  });

  const ocrResults = await Promise.all(imgJobs.map(j => ocrImage(j.url)));

  const images = imgJobs
    .map((j, i) => ({ src: j.url, alt: j.alt, ocr_text: ocrResults[i] }))
    .filter(img => img.ocr_text);

  return {
    success: true,
    html: $.html($el),
    text: htmlToText($.html($el) ?? ''),
    images,
    detected_selector: detectedSelector,
  };
}
