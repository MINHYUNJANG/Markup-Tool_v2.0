import { NextRequest, NextResponse } from 'next/server';
import { editMarkup } from '@/lib/ai-mapper';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { html, instruction } = await req.json();
    const result = await editMarkup(html, instruction);
    return NextResponse.json({ html: result });
  } catch (e: any) {
    return NextResponse.json({ detail: e.message }, { status: 500 });
  }
}
