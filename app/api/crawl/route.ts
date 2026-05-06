import { NextRequest, NextResponse } from 'next/server';
import { crawl } from '@/lib/crawler';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { url, selector = '' } = await req.json();
    const result = await crawl(url, selector);
    if (!result.success) return NextResponse.json({ detail: result.error }, { status: 400 });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ detail: e.message }, { status: 500 });
  }
}
