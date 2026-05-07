import { NextRequest, NextResponse } from 'next/server';
import { figmaMarkup } from '@/lib/figma';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { url, component_type = 'auto', variant = 'auto' } = await req.json();
    const result = await figmaMarkup(url, component_type, variant);
    return NextResponse.json(result);
  } catch (e: any) {
    console.error('[figma-markup]', e);
    if (e.message?.startsWith('FIGMA_RATE_LIMIT:')) {
      const retryAfter: number = e.retryAfter ?? 60;
      if (retryAfter > 300) {
        const days = Math.ceil(retryAfter / 86400);
        return NextResponse.json(
          { detail: `Figma API 이미지 렌더링 할당량이 소진되었습니다. 약 ${days}일 후 초기화됩니다. Figma 플랜 업그레이드를 고려해주세요.`, retryAfter: null },
          { status: 429 }
        );
      }
      return NextResponse.json(
        { detail: `Figma API 요청 한도를 초과했습니다. ${retryAfter}초 후 자동으로 재시도합니다.`, retryAfter },
        { status: 429 }
      );
    }
    const status = e.message?.includes('올바른 Figma') || e.message?.includes('FIGMA') ? 400 : 500;
    return NextResponse.json({ detail: e.message ?? '알 수 없는 오류가 발생했습니다.' }, { status });
  }
}
