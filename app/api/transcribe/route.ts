import { NextRequest, NextResponse } from 'next/server';

// インメモリロック（同時リクエスト制限）
let isProcessing = false;

// Groq APIエンドポイント
const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// リトライ設定
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

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
 * Groq APIにリクエストを送信（リトライ付き）
 */
async function callGroqApi(formData: FormData): Promise<Response> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        throw new Error('GROQ_API_KEY is not configured');
    }

    let lastError: Error | null = null;
    let lastRetryAfter: number | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(GROQ_API_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                },
                body: formData,
            });

            // 成功またはリトライ不要なエラー
            if (response.ok || (response.status !== 429 && response.status < 500)) {
                return response;
            }

            // 429または5xxの場合はリトライ
            const retryAfterHeader = response.headers.get('retry-after');
            const retryAfterMs = retryAfterHeader
                ? parseInt(retryAfterHeader, 10) * 1000
                : undefined;

            // 最後のリトライ後は失敗レスポンスを返す
            if (attempt === MAX_RETRIES) {
                lastRetryAfter = retryAfterMs ? retryAfterMs / 1000 : null;
                return response;
            }

            const delay = calculateBackoff(attempt, retryAfterMs);
            await sleep(delay);
        } catch (error) {
            lastError = error as Error;
            if (attempt === MAX_RETRIES) break;
            const delay = calculateBackoff(attempt);
            await sleep(delay);
        }
    }

    // 全リトライ失敗
    throw lastError || new Error('Failed to call Groq API after retries');
}

export async function POST(request: NextRequest) {
    // 同時リクエスト制限チェック
    if (isProcessing) {
        return NextResponse.json(
            {
                error: 'Server is busy. Please try again later.',
                retryAfter: 2,
            },
            {
                status: 429,
                headers: { 'Retry-After': '2' },
            }
        );
    }

    isProcessing = true;

    try {
        // フォームデータからファイルを取得
        const incomingFormData = await request.formData();
        const audioFile = incomingFormData.get('audio') as File | null;

        if (!audioFile) {
            return NextResponse.json(
                { error: 'No audio file provided' },
                { status: 400 }
            );
        }

        // ファイルサイズチェック
        console.log(`Audio file: ${audioFile.name}, size: ${audioFile.size} bytes, type: ${audioFile.type}`);

        if (audioFile.size < 1000) {
            return NextResponse.json(
                { error: 'Audio file too small', details: `Size: ${audioFile.size} bytes` },
                { status: 400 }
            );
        }

        // Groq APIに送信するフォームデータを作成
        const groqFormData = new FormData();
        groqFormData.append('file', audioFile);
        groqFormData.append('model', 'whisper-large-v3-turbo');
        groqFormData.append('language', 'en');
        groqFormData.append('temperature', '0');
        groqFormData.append('response_format', 'json');

        // Groq APIを呼び出し
        const groqResponse = await callGroqApi(groqFormData);

        // レスポンス処理
        if (!groqResponse.ok) {
            const errorText = await groqResponse.text();
            let errorJson;
            try {
                errorJson = JSON.parse(errorText);
            } catch {
                errorJson = { message: errorText };
            }

            const retryAfterHeader = groqResponse.headers.get('retry-after');
            const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 5;

            if (groqResponse.status === 429) {
                return NextResponse.json(
                    {
                        error: 'Rate limit exceeded. Please wait.',
                        retryAfter,
                        details: errorJson,
                    },
                    {
                        status: 429,
                        headers: { 'Retry-After': String(retryAfter) },
                    }
                );
            }

            return NextResponse.json(
                {
                    error: 'Transcription failed',
                    status: groqResponse.status,
                    details: errorJson,
                },
                { status: groqResponse.status }
            );
        }

        // 成功レスポンス
        const result = await groqResponse.json();
        return NextResponse.json({ text: result.text });
    } catch (error) {
        console.error('Transcription error:', error);
        const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
            { error: 'Internal server error', details: errorMessage },
            { status: 500 }
        );
    } finally {
        isProcessing = false;
    }
}

export const runtime = 'nodejs';
