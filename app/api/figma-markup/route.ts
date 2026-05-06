import { NextRequest, NextResponse } from 'next/server';
import { figmaMarkup } from '@/lib/figma';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { url, component_type = 'auto', variant = 'auto' } = await req.json();
    const result = await figmaMarkup(url, component_type, variant);
    return NextResponse.json(result);
  } catch (e: any) {
    const status = e.message?.includes('올바른 Figma') || e.message?.includes('FIGMA') ? 400 : 500;
    return NextResponse.json({ detail: e.message }, { status });
  }
}
