import Groq from 'groq-sdk';

const FIGMA_API = 'https://api.figma.com/v1';
let groqClient: Groq | null = null;

const NO_VARIANT = new Set(['class-list']);
const TYPE_CHOICES = 'greeting, history, pri-his, symbol, roadmap, class-list, none';

const COMPONENT_STRUCTURES: Record<string, string> = {
  greeting: `
[인사말(greeting) 컴포넌트 전용 구조]
반드시 아래 구조만 사용하세요. 다른 태그나 클래스를 추가하지 마세요.

<div class="lead-wrap">
\t<div class="inner">
\t\t<p>리드 문구 (강조 부분은 <strong>굵게</strong>)</p>
\t\t<div class="bg-text">
\t\t\t<div class="track">
\t\t\t\t<p>배경 텍스트</p>
\t\t\t\t<p>배경 텍스트</p>
\t\t\t</div>
\t\t</div>
\t</div>
</div>
<div class="txt-wrap">
\t<div class="txt">
\t\t<p>본문 단락</p>
\t\t<p>본문 단락</p>
\t</div>
\t<div class="sign">학교명 교장 <strong>홍 길 동</strong></div>
</div>

규칙:
- lead-wrap > inner > p: 상단 인사 리드 문구. 강조 텍스트는 <strong> 사용
- bg-text > track: 배경에 크게 표시되는 텍스트 (보통 학교명 또는 슬로건), <p> 두 개
- txt-wrap > txt: 본문 단락들을 <p>로 나열
- sign: "학교명 교장 <strong>이 름</strong>" 형식, 이름은 한 글자씩 공백으로 띄어쓰기
- 래퍼 div(.greeting, .greeting.tyA 등)는 생성하지 말 것
- 설명·주석·코드블록 없이 HTML만 출력`,
};

function getGroq(): Groq {
  if (!groqClient) groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groqClient;
}

function figmaHeaders(): Record<string, string> {
  const token = process.env.FIGMA_ACCESS_TOKEN;
  if (!token) throw new Error('FIGMA_ACCESS_TOKEN이 설정되지 않았습니다.');
  return { 'X-Figma-Token': token };
}

export function parseFigmaUrl(url: string): [string, string | null] {
  const m = /figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)/.exec(url);
  if (!m) throw new Error('올바른 Figma URL이 아닙니다. (예: https://www.figma.com/design/XXXX/...)');
  const fileKey = m[1];
  const nodeM = /node-id=([^&]+)/.exec(url);
  const nodeId = nodeM ? nodeM[1].replace(/-/g, ':') : null;
  return [fileKey, nodeId];
}

async function getTopFrameIds(fileKey: string): Promise<string[]> {
  const resp = await fetch(`${FIGMA_API}/files/${fileKey}?depth=1`, {
    headers: figmaHeaders(),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Figma API error: ${resp.status}`);
  const data = await resp.json();

  const pages = data.document?.children ?? [];
  const ids: string[] = [];
  for (const page of pages) {
    for (const child of page.children ?? []) {
      if (['FRAME', 'COMPONENT', 'COMPONENT_SET', 'GROUP'].includes(child.type)) {
        ids.push(child.id);
      }
      if (ids.length >= 5) break;
    }
    if (ids.length) break;
  }
  return ids;
}

async function fetchWithRetry(url: string, options: RequestInit = {}, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
    if (resp.status !== 429) return resp;
    if (attempt === maxRetries) break;
    const retryAfter = parseInt(resp.headers.get('Retry-After') ?? '0', 10);
    const wait = retryAfter > 0 ? retryAfter * 1000 : Math.pow(2, attempt) * 1000;
    await new Promise(r => setTimeout(r, wait));
  }
  throw new Error('Figma API 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.');
}

async function exportFigmaFrames(fileKey: string, nodeIds: string[]): Promise<Buffer[]> {
  const idsParam = nodeIds.join(',');
  const resp = await fetchWithRetry(
    `${FIGMA_API}/images/${fileKey}?ids=${encodeURIComponent(idsParam)}&format=png&scale=2`,
    { headers: figmaHeaders() }
  );
  if (!resp.ok) throw new Error(`Figma export error: ${resp.status}`);
  const imageUrls: Record<string, string> = (await resp.json()).images ?? {};

  const results: Buffer[] = [];
  for (const nodeId of nodeIds) {
    const imgUrl = imageUrls[nodeId];
    if (!imgUrl) continue;
    const imgResp = await fetchWithRetry(imgUrl);
    if (imgResp.ok) results.push(Buffer.from(await imgResp.arrayBuffer()));
  }
  return results;
}

async function detectComponent(imageBytes: Buffer): Promise<[string, string]> {
  const b64 = imageBytes.toString('base64');

  const result = await getGroq().chat.completions.create({
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    max_tokens: 20,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        {
          type: 'text',
          text: `Korean school website section. Identify component type and layout variant.\nReply ONLY with: [type] [variant]\n\nTypes: ${TYPE_CHOICES}\n\nVariants (tyA / tyB / tyC):\n- tyA: centered/symmetric layout, big background text or circular elements\n- tyB: split left-right layout, colored background panel\n- tyC: sidebar sticky + main scrollable, or image strip on side\n\nExamples:\ngreeting tyA\nhistory tyB\nclass-list\nnone`,
        },
      ],
    }],
  } as any);

  const raw = (result.choices[0].message.content ?? '').trim().toLowerCase();
  const parts = raw.split(/\s+/);

  let compType = parts[0] ?? 'none';
  const variantRaw = parts[1] ?? '';

  const validTypes = new Set(['greeting', 'history', 'pri-his', 'symbol', 'roadmap', 'class-list', 'none']);
  const variantMap: Record<string, string> = { tya: 'tyA', tyb: 'tyB', tyc: 'tyC' };

  if (!validTypes.has(compType)) compType = 'none';
  let variant = variantMap[variantRaw] ?? '';
  if (NO_VARIANT.has(compType)) variant = '';

  return [compType, variant];
}

function wrapWithComponent(html: string, compType: string, variant: string): string {
  if (!compType || compType === 'none') return html;
  const classes = [compType, variant].filter(Boolean).join(' ');
  return `<div class="${classes}">\n${html}\n</div>`;
}

async function visionToMarkup(imageBytes: Buffer, compType = '', variant = ''): Promise<string> {
  const b64 = imageBytes.toString('base64');

  let system: string;
  let userText: string;

  if (compType && COMPONENT_STRUCTURES[compType]) {
    system = '당신은 HTML 마크업 전문가입니다.\nFigma 디자인 이미지를 분석하여 아래 구조에 맞게 HTML 소스만 반환합니다.\n설명·주석·코드블록 없이 HTML만 출력하세요.\n' + COMPONENT_STRUCTURES[compType];
    userText = '이 Figma 디자인 이미지의 텍스트를 위 구조에 맞게 빠짐없이 채워 HTML로 변환해주세요. 디자인에 보이는 텍스트를 정확히 그대로 사용하세요.';
  } else {
    let compHint = '';
    if (compType && compType !== 'none') {
      const v = variant ? ` ${variant}` : '';
      compHint = `\n이 디자인은 CSS 클래스 '${compType}${v}' 컴포넌트의 내부 콘텐츠입니다. 래퍼 div는 생성하지 말고 내부 콘텐츠만 마크업하세요.`;
    }
    system = `당신은 HTML 마크업 전문가입니다.\nFigma 디자인 이미지를 분석하여 아래 규칙에 따라 HTML 소스만 반환합니다.\n설명·주석·코드블록 없이 HTML만 출력하세요.\n\n[마크업 규칙]\n1. 타이틀은 레벨에 따라 순서대로:\n   <h2 class="tit1"></h2>\n   <h3 class="tit2"></h3>\n   <h4 class="tit3"></h4>\n\n2. 타이틀 하위 내용은 <div class="indent"></div>로 감싸서 들여쓰기\n\n3. 일반 텍스트는 <p></p>\n\n4. 일반 리스트(순서 없음)는 레벨에 따라:\n   <ul class="list_st1"></ul>\n   <ul class="list_st2"></ul>\n   하위 리스트는 상위 <li> 안에 넣기\n\n5. 숫자가 있는 순서 리스트는:\n   <ol class="list_ol1"></ol>\n   숫자는 <span class="num">1</span> 형식으로 작성\n\n6. 테이블:\n   <div class="tbl_st scroll_gr">\n     <table>\n       <caption>테이블 설명</caption>\n       <colgroup><col>...</colgroup>\n       <thead>...</thead>\n       <tbody>...</tbody>\n     </table>\n   </div>\n\n7. 디자인에 보이는 텍스트를 정확히 그대로 사용할 것 (수정·요약 금지)\n\n8. section, div로 묶지 말 것 (규칙에 명시된 div 클래스 제외)\n\n9. 모든 소스는 탭(\\t) 들여쓰기로 작성`;
    userText = `이 Figma 디자인 이미지를 마크업 규칙에 따라 HTML로 변환해주세요. 디자인에 보이는 모든 텍스트와 구조를 빠짐없이 포함하세요.${compHint}`;
  }

  const result = await getGroq().chat.completions.create({
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    max_tokens: 8192,
    messages: [{
      role: 'system',
      content: system,
    }, {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        { type: 'text', text: userText },
      ],
    }],
  } as any);

  return (result.choices[0].message.content ?? '').trim();
}

export interface FigmaMarkupResult {
  html: string;
  frame_count: number;
  file_key: string;
  node_ids: string[];
  detected_type: string;
  detected_variant: string;
}

export async function figmaMarkup(
  figmaUrl: string,
  componentType = 'auto',
  variant = 'auto',
): Promise<FigmaMarkupResult> {
  const [fileKey, nodeId] = parseFigmaUrl(figmaUrl);

  let nodeIds: string[];
  if (nodeId) {
    nodeIds = [nodeId];
  } else {
    nodeIds = await getTopFrameIds(fileKey);
    if (!nodeIds.length) throw new Error('내보낼 프레임을 찾을 수 없습니다. Figma URL에 node-id를 포함해 주세요.');
  }

  const images = await exportFigmaFrames(fileKey, nodeIds);
  if (!images.length) throw new Error('Figma 이미지를 가져오지 못했습니다. 파일 접근 권한을 확인해주세요.');

  const markups: string[] = [];
  let detectedType = '';
  let detectedVariant = '';

  for (const imgBytes of images) {
    let ct: string;
    let cv: string;

    if (componentType === 'auto') {
      [ct, cv] = await detectComponent(imgBytes);
    } else {
      ct = componentType;
      cv = NO_VARIANT.has(ct) ? '' : (variant !== 'auto' ? variant : '');
    }

    if (!detectedType) { detectedType = ct; detectedVariant = cv; }

    const innerHtml = await visionToMarkup(imgBytes, ct, cv);
    const wrapped = wrapWithComponent(innerHtml, ct, cv);
    markups.push(wrapped);
  }

  return {
    html: markups.join('\n'),
    frame_count: images.length,
    file_key: fileKey,
    node_ids: nodeIds,
    detected_type: detectedType,
    detected_variant: detectedVariant,
  };
}
