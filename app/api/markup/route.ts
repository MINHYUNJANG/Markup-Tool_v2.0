import { NextRequest, NextResponse } from 'next/server';
import { crawl } from '@/lib/crawler';
import { mapToTemplate } from '@/lib/ai-mapper';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { url, selector = '', template_html } = await req.json();
    const crawled = await crawl(url, selector);
    if (!crawled.success) return NextResponse.json({ detail: crawled.error }, { status: 400 });
    const html = await mapToTemplate(template_html, crawled);
    return NextResponse.json({ html });
  } catch (e: any) {
    return NextResponse.json({ detail: e.message }, { status: 500 });
  }
}
