import { NextRequest, NextResponse } from 'next/server';
import { crawl } from '@/lib/crawler';
import { autoMarkup } from '@/lib/ai-mapper';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const { url, selector = '' } = await req.json();
    const crawled = await crawl(url, selector);
    if (!crawled.success) return NextResponse.json({ detail: crawled.error }, { status: 400 });
    const html = await autoMarkup(crawled);
    return NextResponse.json({ html, crawled });
  } catch (e: any) {
    return NextResponse.json({ detail: e.message }, { status: 500 });
  }
}
