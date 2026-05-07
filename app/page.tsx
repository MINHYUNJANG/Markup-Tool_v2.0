'use client';

import { useState, useEffect, useRef } from 'react';

type Mode = 'url' | 'batch' | 'figma';
type Tab = 'html' | 'crawl' | 'ocr';

interface CrawlData {
  html?: string;
  text?: string;
  images?: Array<{ src: string; alt: string; ocr_text: string }>;
  detected_selector?: string;
}

interface BatchRow {
  url: string;
  selector: string;
}

interface BatchResult {
  status: 'pending' | 'loading' | 'done' | 'error';
  html?: string;
  error?: string;
  url: string;
}

const COMPONENT_TYPES = [
  { value: 'auto', label: '자동 감지' },
  { value: 'greeting', label: '인사말 (greeting)' },
  { value: 'history', label: '연혁 (history)' },
  { value: 'pri-his', label: '개인정보+연혁 (pri-his)' },
  { value: 'symbol', label: '상징 (symbol)' },
  { value: 'roadmap', label: '로드맵 (roadmap)' },
  { value: 'class-list', label: '학급 목록 (class-list)' },
  { value: 'none', label: '일반 (none)' },
];

const VARIANTS = ['auto', 'tyA', 'tyB', 'tyC'];
const VARIANT_LABELS: Record<string, string> = {
  auto: '자동',
  tyA: 'tyA',
  tyB: 'tyB',
  tyC: 'tyC',
};

const THEMES = [
  { value: 'purple', color: '#6600BF', label: '퍼플' },
  { value: 'blue',   color: '#2870FF', label: '블루' },
  { value: 'green',  color: '#057734', label: '그린' },
  { value: 'navy',   color: '#002454', label: '네이비' },
  { value: 'mint',   color: '#268F87', label: '민트' },
  { value: 'orange', color: '#E56C01', label: '오렌지' },
];

function buildPreviewDoc(html: string, theme: string): string {
  return `<!DOCTYPE html>
<html lang="ko" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/theme.css">
<link rel="stylesheet" href="/basic.css">
<link rel="stylesheet" href="/con_com.css">
<link rel="stylesheet" href="/sub_com.css">
<style>
  :root { --box-radius: 0.5rem; --margin-default: 3rem; }
  body { padding: 2rem 3rem; }
</style>
</head>
<body>${html}</body>
</html>`;
}

export default function HomePage() {
  const [mode, setMode] = useState<Mode>('url');

  // URL mode
  const [url, setUrl] = useState('');
  const [selector, setSelector] = useState('');
  const [urlError, setUrlError] = useState('');

  // Figma mode
  const [figmaUrl, setFigmaUrl] = useState('');
  const [figmaUrlError, setFigmaUrlError] = useState('');
  const [componentType, setComponentType] = useState('auto');
  const [variant, setVariant] = useState('auto');
  const [figmaRetryCountdown, setFigmaRetryCountdown] = useState<number | null>(null);
  const figmaShouldRetry = useRef(false);

  // Batch mode
  const [batchRows, setBatchRows] = useState<BatchRow[]>([
    { url: '', selector: '' },
    { url: '', selector: '' },
  ]);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);

  // Result state
  const [markupHtml, setMarkupHtml] = useState('');
  const [crawledData, setCrawledData] = useState<CrawlData | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('html');
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [error, setError] = useState('');
  const [fallbackSelector, setFallbackSelector] = useState('');
  const [fallbackLoading, setFallbackLoading] = useState(false);

  // Edit mode
  const [editMode, setEditMode] = useState(false);
  const [editedHtml, setEditedHtml] = useState('');
  const [editInstruction, setEditInstruction] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  // UI state
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewTheme, setPreviewTheme] = useState('purple');

  const displayHtml = editMode ? editedHtml : markupHtml;
  const hasResult = !!markupHtml || !!crawledData;
  const hasOcr = (crawledData?.images ?? []).some(img => img.ocr_text);

  useEffect(() => {
    if (figmaRetryCountdown === null) return;
    if (figmaRetryCountdown <= 0) {
      setFigmaRetryCountdown(null);
      figmaShouldRetry.current = true;
      return;
    }
    const t = setTimeout(() => setFigmaRetryCountdown(c => (c ?? 1) - 1), 1000);
    return () => clearTimeout(t);
  }, [figmaRetryCountdown]);

  useEffect(() => {
    if (!figmaShouldRetry.current) return;
    figmaShouldRetry.current = false;
    handleFigmaMarkup();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [figmaRetryCountdown]);

  function resetResult() {
    setMarkupHtml('');
    setCrawledData(null);
    setError('');
    setEditMode(false);
    setEditedHtml('');
    setEditInstruction('');
    setActiveTab('html');
  }

  function validateUrl(val: string): string {
    if (!val.trim()) return 'URL을 입력해주세요.';
    try { new URL(val); return ''; } catch { return '올바른 URL 형식이 아닙니다.'; }
  }

  async function handleAutoMarkup() {
    const err = validateUrl(url);
    if (err) { setUrlError(err); return; }
    setUrlError('');
    resetResult();
    setLoading(true);
    setLoadingMsg('페이지 크롤링 및 마크업 생성 중...');
    try {
      const res = await fetch('/api/auto-markup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, selector }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail ?? '마크업 생성에 실패했습니다.');
      } else {
        setMarkupHtml(data.html ?? '');
        setCrawledData(data.crawled ?? null);
        setActiveTab('html');
      }
    } catch (e: any) {
      setError(e.message ?? '요청에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCrawl() {
    const err = validateUrl(url);
    if (err) { setUrlError(err); return; }
    setUrlError('');
    resetResult();
    setLoading(true);
    setLoadingMsg('페이지 크롤링 중...');
    try {
      const res = await fetch('/api/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, selector }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail ?? '크롤링에 실패했습니다.');
      } else {
        setCrawledData(data);
        setMarkupHtml('');
        setActiveTab('crawl');
      }
    } catch (e: any) {
      setError(e.message ?? '요청에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  async function handleFallbackCrawl() {
    if (!fallbackSelector.trim()) return;
    setFallbackLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auto-markup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, selector: fallbackSelector }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail ?? '마크업 생성에 실패했습니다.');
      } else {
        setMarkupHtml(data.html ?? '');
        setCrawledData(data.crawled ?? null);
        setActiveTab('html');
      }
    } catch (e: any) {
      setError(e.message ?? '요청에 실패했습니다.');
    } finally {
      setFallbackLoading(false);
    }
  }

  async function handleFigmaMarkup() {
    if (!figmaUrl.trim()) { setFigmaUrlError('Figma URL을 입력해주세요.'); return; }
    if (!figmaUrl.includes('figma.com')) { setFigmaUrlError('올바른 Figma URL이 아닙니다.'); return; }
    setFigmaUrlError('');
    resetResult();
    setLoading(true);
    setLoadingMsg('Figma 디자인 분석 중...');
    try {
      const res = await fetch('/api/figma-markup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: figmaUrl, component_type: componentType, variant }),
      });
      let data: any;
      try {
        data = await res.json();
      } catch {
        setError(res.status === 504 ? '서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.' : `서버 오류가 발생했습니다. (${res.status})`);
        return;
      }
      if (res.status === 429) {
        setError(data.detail ?? 'Figma API 요청 한도를 초과했습니다.');
        if (data.retryAfter) setFigmaRetryCountdown(data.retryAfter);
      } else if (!res.ok) {
        setError(data.detail ?? 'Figma 마크업 생성에 실패했습니다.');
      } else {
        setMarkupHtml(data.html ?? '');
        setActiveTab('html');
      }
    } catch (e: any) {
      setError(e.message ?? '요청에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  async function handleEditMarkup() {
    if (!editInstruction.trim()) return;
    setEditLoading(true);
    try {
      const res = await fetch('/api/edit-markup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: displayHtml, instruction: editInstruction }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail ?? 'AI 수정에 실패했습니다.');
      } else {
        setEditedHtml(data.html ?? '');
        setEditInstruction('');
      }
    } catch (e: any) {
      setError(e.message ?? '요청에 실패했습니다.');
    } finally {
      setEditLoading(false);
    }
  }

  async function handleBatchRun() {
    const validRows = batchRows.filter(r => r.url.trim());
    if (!validRows.length) return;
    setBatchRunning(true);
    const results: BatchResult[] = validRows.map(r => ({ status: 'pending', url: r.url }));
    setBatchResults([...results]);

    for (let i = 0; i < validRows.length; i++) {
      results[i] = { ...results[i], status: 'loading' };
      setBatchResults([...results]);
      try {
        const res = await fetch('/api/auto-markup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: validRows[i].url, selector: validRows[i].selector }),
        });
        const data = await res.json();
        if (!res.ok) {
          results[i] = { ...results[i], status: 'error', error: data.detail ?? '실패' };
        } else {
          results[i] = { ...results[i], status: 'done', html: data.html };
        }
      } catch (e: any) {
        results[i] = { ...results[i], status: 'error', error: e.message };
      }
      setBatchResults([...results]);
    }
    setBatchRunning(false);
  }

  function copyToClipboard(html: string) {
    navigator.clipboard.writeText(html).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function openPreview(html: string) {
    setPreviewHtml(buildPreviewDoc(html, previewTheme));
    setShowPreview(true);
  }

  function toggleEditMode() {
    if (!editMode) setEditedHtml(markupHtml);
    setEditMode(!editMode);
  }

  function switchMode(m: Mode) {
    setMode(m);
    resetResult();
  }

  return (
    <div className="app">
      <div className="header">
        <h1>마크업 도구</h1>
        <p>URL 또는 Figma 디자인을 HTML 마크업으로 변환합니다</p>
      </div>

      <div className="main">
        {/* 모드 토글 */}
        <div className="mode-toggle">
          <button
            className={`mode-btn${mode === 'url' ? ' active' : ''}`}
            onClick={() => switchMode('url')}
          >URL</button>
          <button
            className={`mode-btn${mode === 'batch' ? ' active' : ''}`}
            onClick={() => switchMode('batch')}
          >일괄 처리</button>
          <button
            className={`mode-btn${mode === 'figma' ? ' active' : ''}`}
            onClick={() => switchMode('figma')}
          >Figma</button>
        </div>

        {/* URL 모드 */}
        {mode === 'url' && (
          <div className="input-section">
            <div className="input-group">
              <label>페이지 URL</label>
              <input
                type="url"
                placeholder="https://example.com/page"
                value={url}
                onChange={e => { setUrl(e.target.value); if (urlError) setUrlError(''); }}
                className={urlError ? 'input-error' : ''}
                onKeyDown={e => e.key === 'Enter' && !loading && handleAutoMarkup()}
              />
              {urlError && <span className="field-error">{urlError}</span>}
            </div>
            <div className="input-group">
              <label>CSS 셀렉터 <span style={{ fontWeight: 400, color: '#aaa' }}>(선택)</span></label>
              <input
                type="text"
                placeholder="#content, .article, main 등 (비워두면 자동 감지)"
                value={selector}
                onChange={e => setSelector(e.target.value)}
              />
            </div>
            <div className="btn-group">
              <button className="crawl-btn" onClick={handleCrawl} disabled={loading}>
                크롤링만
              </button>
              <button className="markup-btn" onClick={handleAutoMarkup} disabled={loading}>
                마크업 생성
              </button>
            </div>
          </div>
        )}

        {/* Figma 모드 */}
        {mode === 'figma' && (
          <div className="input-section">
            <div className="input-group">
              <label>Figma URL</label>
              <input
                type="url"
                placeholder="https://www.figma.com/design/..."
                value={figmaUrl}
                onChange={e => { setFigmaUrl(e.target.value); if (figmaUrlError) setFigmaUrlError(''); }}
                className={figmaUrlError ? 'input-error' : ''}
              />
              {figmaUrlError && <span className="field-error">{figmaUrlError}</span>}
              <p className="figma-hint">특정 프레임을 지정하려면 URL에 node-id 파라미터를 포함해주세요.</p>
            </div>
            <div className="figma-comp-row">
              <div className="figma-comp-group">
                <span className="figma-comp-label">컴포넌트</span>
                <select
                  className="figma-comp-select"
                  value={componentType}
                  onChange={e => setComponentType(e.target.value)}
                >
                  {COMPONENT_TYPES.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
              {componentType !== 'class-list' && (
                <div className="figma-comp-group">
                  <span className="figma-comp-label">변형</span>
                  <div className="figma-variant-btns">
                    {VARIANTS.map(v => (
                      <button
                        key={v}
                        className={`figma-variant-btn${variant === v ? ' active' : ''}`}
                        onClick={() => setVariant(v)}
                      >
                        {VARIANT_LABELS[v]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="btn-group">
              <button
                className="markup-btn"
                onClick={handleFigmaMarkup}
                disabled={loading}
                style={{ flex: 1 }}
              >
                {loading ? '분석 중...' : 'Figma 마크업 생성'}
              </button>
            </div>
          </div>
        )}

        {/* 일괄 처리 모드 */}
        {mode === 'batch' && (
          <div className="input-section">
            <div className="batch-header-row">
              <span>페이지 URL</span>
              <span>CSS 셀렉터 (선택)</span>
            </div>
            <div className="batch-rows">
              {batchRows.map((row, i) => (
                <div key={i} className="batch-row">
                  <span className="batch-row-num">{i + 1}</span>
                  <div className="batch-row-fields">
                    <div className="batch-field">
                      <input
                        type="url"
                        placeholder="https://example.com/page"
                        value={row.url}
                        disabled={batchRunning}
                        onChange={e => {
                          const r = [...batchRows];
                          r[i] = { ...r[i], url: e.target.value };
                          setBatchRows(r);
                        }}
                      />
                    </div>
                    <div className="batch-field">
                      <input
                        type="text"
                        placeholder="#content (선택)"
                        value={row.selector}
                        disabled={batchRunning}
                        onChange={e => {
                          const r = [...batchRows];
                          r[i] = { ...r[i], selector: e.target.value };
                          setBatchRows(r);
                        }}
                      />
                    </div>
                  </div>
                  <button
                    className="batch-remove-btn"
                    onClick={() => setBatchRows(batchRows.filter((_, j) => j !== i))}
                    disabled={batchRows.length <= 1 || batchRunning}
                  >×</button>
                </div>
              ))}
            </div>
            <div className="batch-footer">
              <button
                className="batch-add-btn"
                onClick={() => setBatchRows([...batchRows, { url: '', selector: '' }])}
                disabled={batchRunning}
              >+ URL 추가</button>
              <button
                className="markup-btn"
                style={{ flex: 'none', padding: '12px 24px' }}
                onClick={handleBatchRun}
                disabled={batchRunning || !batchRows.some(r => r.url.trim())}
              >
                {batchRunning ? '처리 중...' : '일괄 마크업 생성'}
              </button>
            </div>
          </div>
        )}

        {/* 에러 박스 */}
        {error && (
          <div className="error-box">
            <div>{error}</div>
            {figmaRetryCountdown !== null && (
              <div className="retry-countdown">{figmaRetryCountdown}초 후 자동 재시도...</div>
            )}
            {mode === 'url' && (
              <div className="fallback-selector">
                <input
                  type="text"
                  placeholder="CSS 셀렉터 직접 입력 (#content, .article 등)"
                  value={fallbackSelector}
                  onChange={e => setFallbackSelector(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !fallbackLoading && handleFallbackCrawl()}
                />
                <button
                  onClick={handleFallbackCrawl}
                  disabled={fallbackLoading || !fallbackSelector.trim()}
                >
                  {fallbackLoading ? '처리 중...' : '셀렉터로 재시도'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* 로딩 (결과 없을 때) */}
        {loading && !hasResult && (
          <div className="result-section" style={{ minHeight: 160 }}>
            <div className="loading-overlay">
              <div className="spinner" />
              <span>{loadingMsg}</span>
            </div>
          </div>
        )}

        {/* 결과 섹션 (URL / Figma 모드) */}
        {(mode === 'url' || mode === 'figma') && hasResult && (
          <div className={`result-section${loading ? ' is-loading' : ''}`}>
            {loading && (
              <div className="loading-overlay">
                <div className="spinner" />
                <span>{loadingMsg}</span>
              </div>
            )}

            {/* 액션 버튼 */}
            {markupHtml && (
              <div className="markup-actions">
                <button className="reset-btn" onClick={resetResult}>초기화</button>
                <button
                  className={`edit-mode-btn${editMode ? ' active' : ''}`}
                  onClick={toggleEditMode}
                >
                  {editMode ? '편집 종료' : '편집 모드'}
                </button>
                <div className="theme-picker">
                  {THEMES.map(t => (
                    <button
                      key={t.value}
                      className={`theme-swatch${previewTheme === t.value ? ' active' : ''}`}
                      style={{ background: t.color }}
                      title={t.label}
                      onClick={() => setPreviewTheme(t.value)}
                    />
                  ))}
                </div>
                <button
                  className={`copy-btn${copied ? ' copied' : ''}`}
                  onClick={() => copyToClipboard(displayHtml)}
                >
                  {copied ? '복사됨!' : '복사'}
                </button>
                <button className="preview-btn" onClick={() => openPreview(displayHtml)}>
                  미리보기
                </button>
              </div>
            )}

            {/* 편집 모드 */}
            {editMode ? (
              <div className="tab-content">
                <textarea
                  className="markup-editor"
                  value={editedHtml}
                  onChange={e => setEditedHtml(e.target.value)}
                />
                <div className="prompt-edit-section">
                  <div className="prompt-edit-label">AI 수정 지시사항</div>
                  <div className="prompt-edit-row">
                    <input
                      className="edit-prompt-input"
                      type="text"
                      placeholder="예: 첫 번째 리스트를 ol로 변경해주세요"
                      value={editInstruction}
                      disabled={editLoading}
                      onChange={e => setEditInstruction(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !editLoading && editInstruction.trim()) {
                          handleEditMarkup();
                        }
                      }}
                    />
                    <button
                      className="edit-prompt-btn"
                      onClick={handleEditMarkup}
                      disabled={editLoading || !editInstruction.trim()}
                    >
                      {editLoading ? '수정 중...' : '수정'}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {/* 탭 */}
                <div className="tabs">
                  {markupHtml && (
                    <button
                      className={`tab${activeTab === 'html' ? ' active' : ''}`}
                      onClick={() => setActiveTab('html')}
                    >마크업 HTML</button>
                  )}
                  {crawledData?.text && (
                    <button
                      className={`tab${activeTab === 'crawl' ? ' active' : ''}`}
                      onClick={() => setActiveTab('crawl')}
                    >크롤 결과</button>
                  )}
                  {hasOcr && (
                    <button
                      className={`tab${activeTab === 'ocr' ? ' active' : ''}`}
                      onClick={() => setActiveTab('ocr')}
                    >이미지/OCR</button>
                  )}
                </div>

                {/* 탭 콘텐츠 */}
                <div className="tab-content">
                  {activeTab === 'html' && markupHtml && (
                    <pre className="result-html">{markupHtml}</pre>
                  )}
                  {activeTab === 'crawl' && crawledData && (
                    <div>
                      {crawledData.detected_selector && (
                        <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
                          감지된 셀렉터: <code>{crawledData.detected_selector}</code>
                        </p>
                      )}
                      <pre className="result-text">{crawledData.text}</pre>
                    </div>
                  )}
                  {activeTab === 'ocr' && crawledData?.images && (
                    <div className="ocr-results">
                      {crawledData.images
                        .filter(img => img.ocr_text)
                        .map((img, i) => (
                          <div key={i} className="ocr-item">
                            <div className="ocr-meta">
                              <img
                                src={img.src}
                                alt={img.alt}
                                className="ocr-thumb"
                                onError={e => {
                                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                                }}
                              />
                              <span className="ocr-alt">{img.alt || '(alt 없음)'}</span>
                            </div>
                            <div className="ocr-text">{img.ocr_text}</div>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* 일괄 처리 결과 */}
        {mode === 'batch' && batchResults.length > 0 && (
          <div className="batch-results">
            {batchResults.map((r, i) => (
              <div key={i} className="batch-result-item">
                <div className="batch-result-header">
                  <span className="batch-result-num">{i + 1}</span>
                  <span className="batch-result-url" title={r.url}>{r.url}</span>
                  <span className={`batch-result-badge ${r.status}`}>
                    {r.status === 'loading' && <span className="spinner-sm" />}
                    {r.status === 'pending' && '대기'}
                    {r.status === 'loading' && '처리 중'}
                    {r.status === 'done' && '완료'}
                    {r.status === 'error' && '오류'}
                  </span>
                  {r.status === 'done' && r.html && (
                    <button
                      className="copy-btn"
                      style={{ padding: '4px 12px', fontSize: 12 }}
                      onClick={() => copyToClipboard(r.html!)}
                    >복사</button>
                  )}
                </div>
                {r.status === 'error' && (
                  <div className="batch-result-error">{r.error}</div>
                )}
                {r.status === 'done' && r.html && (
                  <div className="batch-result-body">
                    <pre className="result-html" style={{ maxHeight: 300 }}>{r.html}</pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 미리보기 모달 */}
      {showPreview && (
        <div className="modal-overlay" onClick={() => setShowPreview(false)}>
          <div className="modal-container" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>미리보기</span>
              <button className="modal-close" onClick={() => setShowPreview(false)}>✕</button>
            </div>
            <iframe
              srcDoc={previewHtml}
              className="modal-iframe"
              title="미리보기"
              sandbox="allow-same-origin allow-scripts"
            />
          </div>
        </div>
      )}
    </div>
  );
}
