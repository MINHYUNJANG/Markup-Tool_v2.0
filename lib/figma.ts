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

const DEFAULT_MARKUP_RULES = `[마크업 규칙]
1. 타이틀은 레벨에 따라 순서대로:
   <h2 class="tit1"></h2>
   <h3 class="tit2"></h3>
   <h4 class="tit3"></h4>

2. 타이틀 하위 내용은 <div class="indent"></div>로 감싸서 들여쓰기

3. 일반 텍스트는 <p></p>

4. 일반 리스트(순서 없음)는 레벨에 따라:
   <ul class="list_st1"></ul>
   <ul class="list_st2"></ul>
   하위 리스트는 상위 <li> 안에 넣기

5. 숫자가 있는 순서 리스트는:
   <ol class="list_ol1"></ol>
   숫자는 <span class="num">1</span> 형식으로 작성

6. 테이블:
   <div class="tbl_st scroll_gr">
     <table>
       <caption>테이블 설명</caption>
       <colgroup><col>...</colgroup>
       <thead>...</thead>
       <tbody>...</tbody>
     </table>
   </div>

7. 디자인에 보이는 텍스트를 정확히 그대로 사용할 것 (수정·요약 금지)

8. section, div로 묶지 말 것 (규칙에 명시된 div 클래스 제외)

9. 모든 소스는 탭(\t) 들여쓰기로 작성`;

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

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
  ]);
}

async function figmaGet(path: string): Promise<any> {
  const resp = await withTimeout(
    fetch(`${FIGMA_API}${path}`, {
      headers: figmaHeaders(),
      cache: 'no-store',
    } as RequestInit),
    30000,
    'Figma API 요청 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.'
  );

  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('Retry-After') ?? '60', 10);
    const err: any = new Error(`FIGMA_RATE_LIMIT:${retryAfter}`);
    err.retryAfter = retryAfter;
    throw err;
  }

  if (!resp.ok) throw new Error(`Figma API error: ${resp.status}`);
  return withTimeout(resp.json(), 10000, 'Figma API 응답 파싱 시간 초과');
}

async function getTopFrameIds(fileKey: string): Promise<string[]> {
  const data = await figmaGet(`/files/${fileKey}?depth=1`);
  const pages = data.document?.children ?? [];
  for (const page of pages) {
    for (const child of page.children ?? []) {
      if (['FRAME', 'COMPONENT', 'COMPONENT_SET', 'GROUP'].includes(child.type)) {
        return [child.id];
      }
    }
  }
  return [];
}

async function downloadBuffer(url: string, timeoutMs = 20000): Promise<Buffer> {
  return withTimeout(
    fetch(url, { cache: 'no-store' } as RequestInit).then(async r => {
      if (!r.ok) throw new Error(`이미지 다운로드 실패: ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    }),
    timeoutMs,
    `이미지 다운로드 시간 초과 (${timeoutMs / 1000}초)`
  );
}

async function exportFigmaFrames(fileKey: string, nodeIds: string[]): Promise<Buffer[]> {
  const idsParam = nodeIds.join(',');
  console.log('[figma] 이미지 URL 요청 중...');

  const exportData = await figmaGet(
    `/images/${fileKey}?ids=${encodeURIComponent(idsParam)}&format=png&scale=0.75`
  );
  const imageUrls: Record<string, string> = exportData.images ?? {};
  console.log('[figma] 이미지 URL 수신:', Object.keys(imageUrls).length, '개');

  const results: Buffer[] = [];
  for (const nodeId of nodeIds) {
    const imgUrl = imageUrls[nodeId];
    if (!imgUrl) {
      console.warn('[figma] nodeId에 대한 이미지 URL 없음:', nodeId);
      continue;
    }
    console.log('[figma] 이미지 다운로드 중:', nodeId);
    const buffer = await downloadBuffer(imgUrl, 20000);
    results.push(buffer);
    console.log('[figma] 이미지 다운로드 완료:', nodeId, `(${buffer.length} bytes)`);
  }
  return results;
}

function groqWithTimeout<T>(call: Promise<T>, ms = 50000): Promise<T> {
  return Promise.race([
    call,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Groq API 응답 시간 초과 (${ms / 1000}초)`)), ms)
    ),
  ]);
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 3000): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const isRateLimit =
        err?.status === 429 ||
        err?.error?.code === 'rate_limit_exceeded' ||
        err?.message?.includes('rate_limit') ||
        err?.message?.includes('429');
      if (!isRateLimit || attempt === maxRetries) {
        if (isRateLimit) {
          throw new Error('Groq API 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.');
        }
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.log(`[figma] Rate limit 감지, ${delay / 1000}초 후 재시도... (${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// detectComponent + visionToMarkup를 1회 Groq 호출로 통합 (auto 모드 전용)
async function detectAndMarkupAuto(imageBytes: Buffer): Promise<{
  html: string;
  detectedType: string;
  detectedVariant: string;
}> {
  const b64 = imageBytes.toString('base64');

  console.log('[figma] Groq API 호출 시작 (auto 감지+마크업)');
  const result = await withRetry(() => groqWithTimeout(getGroq().chat.completions.create({
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    max_tokens: 4096,
    messages: [{
      role: 'system',
      content: `당신은 한국 학교 웹사이트 전문 HTML 마크업 전문가입니다.
Figma 디자인 이미지를 분석하여 컴포넌트 타입을 식별하고 HTML 마크업을 한 번에 생성합니다.

[컴포넌트 타입]: ${TYPE_CHOICES}

[변형 (tyA/tyB/tyC)]:
- tyA: 중앙 정렬/대칭 레이아웃, 배경 대형 텍스트 또는 원형 요소
- tyB: 좌우 분할 레이아웃, 색상 배경 패널
- tyC: 사이드바 고정 + 메인 스크롤, 또는 측면 이미지

[출력 형식 - 반드시 준수]:
COMPONENT: [type] [variant]
HTML:
[html 소스만, 설명·주석·코드블록 없이]

[greeting 타입인 경우 전용 구조 사용]${COMPONENT_STRUCTURES['greeting']}

[greeting 외 타입인 경우]
${DEFAULT_MARKUP_RULES}`,
    }, {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        { type: 'text', text: '이 Figma 디자인의 컴포넌트 타입을 식별하고 HTML 마크업을 생성해주세요. 디자인에 보이는 텍스트를 정확히 그대로 사용하세요.' },
      ],
    }],
  } as any)));
  console.log('[figma] Groq API 응답 완료');

  const content = (result.choices[0].message.content ?? '').trim();

  const componentMatch = content.match(/^COMPONENT:\s*(\S+)(?:\s+(\S+))?/im);
  const htmlMatch = content.match(/^HTML:\s*\n([\s\S]*)/im);

  let detectedType = 'none';
  let detectedVariant = '';

  if (componentMatch) {
    const typeRaw = componentMatch[1].toLowerCase();
    const variantRaw = (componentMatch[2] ?? '').toLowerCase();
    const validTypes = new Set(['greeting', 'history', 'pri-his', 'symbol', 'roadmap', 'class-list', 'none']);
    const variantMap: Record<string, string> = { tya: 'tyA', tyb: 'tyB', tyc: 'tyC' };
    detectedType = validTypes.has(typeRaw) ? typeRaw : 'none';
    detectedVariant = NO_VARIANT.has(detectedType) ? '' : (variantMap[variantRaw] ?? '');
  }

  const innerHtml = htmlMatch ? htmlMatch[1].trim() : content;
  const html = wrapWithComponent(innerHtml, detectedType, detectedVariant);

  return { html, detectedType, detectedVariant };
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
    system = `당신은 HTML 마크업 전문가입니다.\nFigma 디자인 이미지를 분석하여 아래 규칙에 따라 HTML 소스만 반환합니다.\n설명·주석·코드블록 없이 HTML만 출력하세요.\n\n${DEFAULT_MARKUP_RULES}`;
    userText = `이 Figma 디자인 이미지를 마크업 규칙에 따라 HTML로 변환해주세요. 디자인에 보이는 모든 텍스트와 구조를 빠짐없이 포함하세요.${compHint}`;
  }

  console.log('[figma] Groq API 호출 시작 (지정 타입:', compType || 'none', ')');
  const result = await withRetry(() => groqWithTimeout(getGroq().chat.completions.create({
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    max_tokens: 4096,
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
  } as any)));
  console.log('[figma] Groq API 응답 완료');

  return (result.choices[0].message.content ?? '').trim();
}

function wrapWithComponent(html: string, compType: string, variant: string): string {
  if (!compType || compType === 'none') return html;
  const classes = [compType, variant].filter(Boolean).join(' ');
  return `<div class="${classes}">\n${html}\n</div>`;
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
  console.log('[figma] fileKey:', fileKey, 'nodeId:', nodeId);

  let nodeIds: string[];
  if (nodeId) {
    nodeIds = [nodeId];
  } else {
    console.log('[figma] 프레임 ID 조회 중...');
    nodeIds = await getTopFrameIds(fileKey);
    if (!nodeIds.length) throw new Error('내보낼 프레임을 찾을 수 없습니다. Figma URL에 node-id를 포함해 주세요.');
  }
  console.log('[figma] nodeIds:', nodeIds);

  console.log('[figma] 이미지 export 중...');
  const images = await exportFigmaFrames(fileKey, nodeIds);
  if (!images.length) throw new Error('Figma 이미지를 가져오지 못했습니다. 파일 접근 권한을 확인해주세요.');
  console.log('[figma] 이미지', images.length, '장 다운로드 완료');

  const results: Array<{ html: string; detectedType: string; detectedVariant: string }> = [];
  for (const imgBytes of images) {
    if (componentType === 'auto') {
      results.push(await detectAndMarkupAuto(imgBytes));
    } else {
      const ct = componentType;
      const cv = NO_VARIANT.has(ct) ? '' : (variant !== 'auto' ? variant : '');
      const innerHtml = await visionToMarkup(imgBytes, ct, cv);
      results.push({
        html: wrapWithComponent(innerHtml, ct, cv),
        detectedType: ct,
        detectedVariant: cv,
      });
    }
  }

  return {
    html: results.map(r => r.html).join('\n'),
    frame_count: images.length,
    file_key: fileKey,
    node_ids: nodeIds,
    detected_type: results[0]?.detectedType ?? '',
    detected_variant: results[0]?.detectedVariant ?? '',
  };
}
