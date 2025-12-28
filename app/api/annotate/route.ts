import { NextRequest, NextResponse } from 'next/server';
import { isStopword } from '@/lib/stopwords-en';

// インメモリロック（同時リクエスト制限）
let isProcessing = false;

// インメモリキャッシュ（TTL: 10分）
const cache = new Map<string, { data: AnnotationResult; timestamp: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10分

// Groq API設定
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.1-8b-instant';

// リトライ設定
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

interface Annotation {
    surface: string;
    katakana: string;
    gloss?: string;
}

interface AnnotationResult {
    annotations: Annotation[];
    wait_seconds?: number;
}

/**
 * テキストから候補語を抽出
 * - 7文字以上
 * - stopwords除外
 * - 重複除去
 * - 上位25語
 */
function extractCandidateWords(text: string): string[] {
    const words = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    const seen = new Set<string>();
    const candidates: string[] = [];

    for (const word of words) {
        const lower = word.toLowerCase();

        // 7文字未満はスキップ
        if (lower.length < 7) continue;

        // stopwordはスキップ
        if (isStopword(lower)) continue;

        // 重複はスキップ
        if (seen.has(lower)) continue;

        seen.add(lower);
        candidates.push(word); // 元の大文字小文字を保持
    }

    // 長さ順でソート（長い方が専門用語の可能性が高い）
    candidates.sort((a, b) => b.length - a.length);

    return candidates.slice(0, 25);
}

/**
 * 指数バックオフ＋ジッターでディレイを計算
 */
function calculateBackoff(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs) return retryAfterMs;
    const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt);
    const jitter = Math.random() * 500;
    return exponentialDelay + jitter;
}

/**
 * スリープ関数
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Groq LLMを呼び出してアノテーションを取得
 */
async function callGroqLLM(text: string, candidates: string[]): Promise<AnnotationResult> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        throw new Error('GROQ_API_KEY is not configured');
    }

    if (candidates.length === 0) {
        return { annotations: [] };
    }

    const systemPrompt = 'You produce JSON only. No markdown. No extra keys.';

    const userPrompt = `Text:
<<<${text}>>>

Candidate words:
[${candidates.join(', ')}]

Task:
候補語の中から、CEFR B2レベル以上（上級者向け）の英単語を最大8語選んでください。
日本人のビジネス利用者が知らなそうな専門用語や難語を優先してください。

各単語について以下を返してください：
- surface: テキスト中と同じ表記
- katakana: 短いカタカナ読み
- gloss: 簡潔な日本語訳（必須、8文字以内）

JSON形式で返却：
{"annotations":[{"surface":"...", "katakana":"...", "gloss":"..."}]}`;

    let lastRetryAfter: number | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(GROQ_API_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: MODEL,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    temperature: 0,
                    max_tokens: 500,
                }),
            });

            // 429または5xxの場合はリトライ
            if (response.status === 429 || response.status >= 500) {
                const retryAfterHeader = response.headers.get('retry-after');
                const retryAfterMs = retryAfterHeader
                    ? parseInt(retryAfterHeader, 10) * 1000
                    : undefined;

                if (attempt === MAX_RETRIES) {
                    lastRetryAfter = retryAfterMs ? retryAfterMs / 1000 : 5;
                    return { annotations: [], wait_seconds: lastRetryAfter };
                }

                const delay = calculateBackoff(attempt, retryAfterMs);
                await sleep(delay);
                continue;
            }

            if (!response.ok) {
                const errorText = await response.text();
                console.error('Groq LLM error:', response.status, errorText);
                return { annotations: [] };
            }

            const result = await response.json();
            const content = result.choices?.[0]?.message?.content || '';

            // JSONをパース
            try {
                // JSON部分を抽出（余計なテキストがある場合に対応）
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (!jsonMatch) {
                    console.error('No JSON found in LLM response:', content);
                    return { annotations: [] };
                }

                const parsed = JSON.parse(jsonMatch[0]);
                const annotations: Annotation[] = [];

                if (Array.isArray(parsed.annotations)) {
                    for (const item of parsed.annotations) {
                        if (item.surface && item.katakana) {
                            annotations.push({
                                surface: String(item.surface),
                                katakana: String(item.katakana),
                                gloss: item.gloss ? String(item.gloss).slice(0, 8) : undefined,
                            });
                        }
                    }
                }

                return { annotations };
            } catch (parseError) {
                console.error('Failed to parse LLM response:', content, parseError);
                return { annotations: [] };
            }
        } catch (error) {
            console.error('Groq LLM request error:', error);
            if (attempt === MAX_RETRIES) {
                return { annotations: [] };
            }
            const delay = calculateBackoff(attempt);
            await sleep(delay);
        }
    }

    return { annotations: [] };
}

/**
 * キャッシュをクリーンアップ
 */
function cleanupCache() {
    const now = Date.now();
    for (const [key, value] of cache.entries()) {
        if (now - value.timestamp > CACHE_TTL_MS) {
            cache.delete(key);
        }
    }
}

export async function POST(request: NextRequest) {
    // 同時リクエスト制限チェック
    if (isProcessing) {
        return NextResponse.json(
            { annotations: [], wait_seconds: 2 },
            { status: 429, headers: { 'Retry-After': '2' } }
        );
    }

    isProcessing = true;

    try {
        const body = await request.json();
        const text = body.text as string;

        if (!text || typeof text !== 'string') {
            return NextResponse.json(
                { error: 'Text is required', annotations: [] },
                { status: 400 }
            );
        }

        // キャッシュチェック
        cleanupCache();
        const cacheKey = text.slice(0, 500); // 最初の500文字をキーに
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
            console.log('Cache hit for annotation');
            return NextResponse.json(cached.data);
        }

        // 候補語を抽出
        const candidates = extractCandidateWords(text);
        console.log(`Extracted ${candidates.length} candidate words:`, candidates.slice(0, 10));

        if (candidates.length === 0) {
            const result = { annotations: [] };
            cache.set(cacheKey, { data: result, timestamp: Date.now() });
            return NextResponse.json(result);
        }

        // LLMを呼び出し
        const result = await callGroqLLM(text, candidates);
        console.log('Annotation result:', result);

        // キャッシュに保存
        if (!result.wait_seconds) {
            cache.set(cacheKey, { data: result, timestamp: Date.now() });
        }

        if (result.wait_seconds) {
            return NextResponse.json(result, {
                status: 429,
                headers: { 'Retry-After': String(result.wait_seconds) },
            });
        }

        return NextResponse.json(result);
    } catch (error) {
        console.error('Annotation error:', error);
        return NextResponse.json(
            { error: 'Internal server error', annotations: [] },
            { status: 500 }
        );
    } finally {
        isProcessing = false;
    }
}

export const runtime = 'nodejs';
