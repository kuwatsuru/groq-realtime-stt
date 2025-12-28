'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Mic, Square, Loader2, AlertCircle, BookOpen, Clock } from 'lucide-react';

type Status = 'idle' | 'recording' | 'error' | 'rate-limited';
type AnnotationStatus = 'idle' | 'loading' | 'done' | 'error' | 'rate-limited';

interface TranscribeResponse {
  text?: string;
  error?: string;
  retryAfter?: number;
  details?: unknown;
}

interface Annotation {
  surface: string;
  katakana: string;
  gloss?: string;
}

interface AnnotateResponse {
  annotations: Annotation[];
  wait_seconds?: number;
  error?: string;
}

// チャンク送信間隔オプション（秒）
const CHUNK_INTERVAL_OPTIONS = [2, 3, 4, 5, 6];
const DEFAULT_CHUNK_INTERVAL = 4;

export default function Home() {
  const [status, setStatus] = useState<Status>('idle');
  const [transcription, setTranscription] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [countdown, setCountdown] = useState<number>(0);
  const [recordingTime, setRecordingTime] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  // アノテーション関連
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationStatus, setAnnotationStatus] = useState<AnnotationStatus>('idle');
  const [annotationEnabled, setAnnotationEnabled] = useState<boolean>(true);
  const [annotationCountdown, setAnnotationCountdown] = useState<number>(0);

  // チャンク間隔（秒）
  const [chunkInterval, setChunkInterval] = useState<number>(DEFAULT_CHUNK_INTERVAL);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const chunkIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const annotationCountdownRef = useRef<NodeJS.Timeout | null>(null);
  const mimeTypeRef = useRef<string>('');
  const isRecordingRef = useRef<boolean>(false);
  const pendingAnnotationRef = useRef<string>('');

  // カウントダウン処理
  useEffect(() => {
    if (countdown > 0) {
      countdownIntervalRef.current = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            if (countdownIntervalRef.current) {
              clearInterval(countdownIntervalRef.current);
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
      }
    };
  }, [countdown]);

  // アノテーションカウントダウン
  useEffect(() => {
    if (annotationCountdown > 0) {
      annotationCountdownRef.current = setInterval(() => {
        setAnnotationCountdown((prev) => {
          if (prev <= 1) {
            if (annotationCountdownRef.current) {
              clearInterval(annotationCountdownRef.current);
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => {
      if (annotationCountdownRef.current) {
        clearInterval(annotationCountdownRef.current);
      }
    };
  }, [annotationCountdown]);

  // クリーンアップ
  useEffect(() => {
    return () => {
      stopAllTimers();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const stopAllTimers = () => {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (chunkIntervalRef.current) {
      clearInterval(chunkIntervalRef.current);
      chunkIntervalRef.current = null;
    }
  };

  // アノテーションを取得
  const fetchAnnotations = useCallback(async (text: string) => {
    if (!annotationEnabled || !text.trim()) return;

    setAnnotationStatus('loading');

    try {
      const response = await fetch('/api/annotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      const data: AnnotateResponse = await response.json();

      if (response.status === 429) {
        setAnnotationStatus('rate-limited');
        const waitTime = data.wait_seconds || 5;
        setAnnotationCountdown(waitTime);
        pendingAnnotationRef.current = text;
      } else if (response.ok && data.annotations) {
        setAnnotations(prev => {
          // 重複を避けて追加
          const existingSurfaces = new Set(prev.map(a => a.surface.toLowerCase()));
          const newAnnotations = data.annotations.filter(
            a => !existingSurfaces.has(a.surface.toLowerCase())
          );
          return [...prev, ...newAnnotations];
        });
        setAnnotationStatus('done');
      } else {
        setAnnotationStatus('error');
      }
    } catch (err) {
      console.error('Annotation error:', err);
      setAnnotationStatus('error');
    }
  }, [annotationEnabled]);

  // 音声をAPIに送信
  const sendAudioForTranscription = useCallback(async (audioBlob: Blob) => {
    if (audioBlob.size < 5000) {
      console.log(`Skipping small chunk: ${audioBlob.size} bytes`);
      return;
    }

    console.log(`Sending audio: ${audioBlob.size} bytes, type: ${audioBlob.type}`);
    setIsProcessing(true);

    try {
      const extension = mimeTypeRef.current.includes('webm') ? 'webm'
        : mimeTypeRef.current.includes('mp4') ? 'm4a'
          : 'wav';

      const formData = new FormData();
      formData.append('audio', audioBlob, `recording.${extension}`);

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
      });

      const data: TranscribeResponse = await response.json();

      if (response.ok && data.text) {
        const newText = data.text.trim();
        if (newText) {
          setTranscription(prev => {
            const updated = prev ? `${prev} ${newText}` : newText;
            // アノテーションを非同期で取得
            setTimeout(() => fetchAnnotations(updated), 100);
            return updated;
          });
        }
        setError('');
      } else if (response.status === 429) {
        const waitTime = data.retryAfter || 5;
        setCountdown(waitTime);
        setError(`レート制限: ${waitTime}秒後に再開します`);
      } else {
        if (response.status !== 400) {
          setError(`${data.error || 'API Error'} (${response.status})`);
        }
      }
    } catch (err) {
      console.error('Transcription error:', err);
      setError(`通信エラー: ${err instanceof Error ? err.message : 'Unknown'}`);
    } finally {
      setIsProcessing(false);
    }
  }, [fetchAnnotations]);

  // MediaRecorderを開始する関数
  const startMediaRecorder = useCallback((stream: MediaStream, onComplete: (blob: Blob) => void) => {
    const mimeType = mimeTypeRef.current;
    const mediaRecorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      if (chunks.length > 0) {
        const audioBlob = new Blob(chunks, { type: mimeType });
        onComplete(audioBlob);
      }
    };

    mediaRecorder.start();
    return mediaRecorder;
  }, []);

  // 録音開始
  const startRecording = useCallback(async () => {
    try {
      setError('');
      setTranscription('');
      setAnnotations([]);
      setRecordingTime(0);
      isRecordingRef.current = true;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        }
      });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : 'audio/wav';

      mimeTypeRef.current = mimeType;
      console.log('Using MIME type:', mimeType);

      mediaRecorderRef.current = startMediaRecorder(stream, sendAudioForTranscription);
      setStatus('recording');

      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);

      chunkIntervalRef.current = setInterval(() => {
        if (!isRecordingRef.current || !streamRef.current) return;

        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }

        mediaRecorderRef.current = startMediaRecorder(streamRef.current, sendAudioForTranscription);
      }, chunkInterval * 1000);

    } catch (err) {
      console.error('Recording error:', err);
      setStatus('error');
      isRecordingRef.current = false;
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setError('マイクへのアクセスが拒否されました。ブラウザの設定を確認してください。');
      } else {
        setError('マイクの初期化に失敗しました');
      }
    }
  }, [startMediaRecorder, sendAudioForTranscription, chunkInterval]);

  // 録音停止
  const stopRecording = useCallback(() => {
    isRecordingRef.current = false;
    stopAllTimers();

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }

    setStatus('idle');
  }, []);

  const handleButtonClick = () => {
    if (status === 'recording') {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const handleClear = () => {
    setTranscription('');
    setAnnotations([]);
    setAnnotationStatus('idle');
  };

  const handleRetryAnnotation = () => {
    if (pendingAnnotationRef.current) {
      fetchAnnotations(pendingAnnotationRef.current);
    } else if (transcription) {
      fetchAnnotations(transcription);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // テキストをルビ付きでレンダリング
  const renderTextWithRuby = () => {
    if (!transcription) return null;
    if (!annotationEnabled || annotations.length === 0) {
      return <span>{transcription}</span>;
    }

    // アノテーションをマップに変換（小文字キー）
    const annotationMap = new Map<string, Annotation>();
    for (const ann of annotations) {
      annotationMap.set(ann.surface.toLowerCase(), ann);
    }

    // トークン分割（単語と区切り文字を保持）
    const tokens = transcription.split(/(\s+|[.,!?;:'"()-])/);

    return (
      <>
        {tokens.map((token, index) => {
          const ann = annotationMap.get(token.toLowerCase());
          if (ann && ann.gloss) {
            return (
              <ruby key={index} title={`${ann.katakana}`} className="ruby-annotation">
                {token}
                <rt>{ann.gloss}</rt>
              </ruby>
            );
          }
          return <span key={index}>{token}</span>;
        })}
      </>
    );
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl bg-slate-800/50 backdrop-blur-xl border-slate-700 shadow-2xl">
        <CardHeader className="text-center pb-2">
          <CardTitle className="text-3xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
            🎙️ Real-time Transcription
          </CardTitle>
          <p className="text-slate-400 mt-2">
            Tap to start/stop recording • Text appears in real-time (English)
          </p>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* 録音ボタン */}
          <div className="flex justify-center gap-4">
            <Button
              onClick={handleButtonClick}
              disabled={countdown > 0}
              size="lg"
              className={`
                w-40 h-40 rounded-full text-lg font-semibold
                transition-all duration-300 transform
                ${status === 'recording'
                  ? 'bg-red-500 hover:bg-red-600 animate-pulse shadow-lg shadow-red-500/50'
                  : countdown > 0
                    ? 'bg-slate-600 cursor-not-allowed'
                    : 'bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 hover:scale-105 shadow-lg shadow-purple-500/30'
                }
              `}
            >
              {status === 'recording' ? (
                <div className="flex flex-col items-center gap-2">
                  <Square className="w-10 h-10" />
                  <span className="text-2xl">{formatTime(recordingTime)}</span>
                  {isProcessing && <Loader2 className="w-4 h-4 animate-spin" />}
                </div>
              ) : countdown > 0 ? (
                <div className="flex flex-col items-center gap-2">
                  <span className="text-3xl font-bold">{countdown}</span>
                  <span className="text-sm">Wait...</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Mic className="w-10 h-10" />
                  <span>Start</span>
                </div>
              )}
            </Button>
          </div>

          {/* リアルタイムインジケーター */}
          {status === 'recording' && (
            <div className="flex justify-center items-center gap-2 text-green-400">
              <span className="w-3 h-3 bg-green-400 rounded-full animate-pulse"></span>
              <span>Live transcription every {chunkInterval}s</span>
              {isProcessing && <Loader2 className="w-4 h-4 animate-spin ml-2" />}
            </div>
          )}

          {/* チャンク間隔セレクター（録音中は非表示）*/}
          {status !== 'recording' && (
            <div className="flex items-center justify-between px-2">
              <div className="flex items-center gap-2 text-slate-300">
                <Clock className="w-4 h-4" />
                <span className="text-sm">文字起こし間隔</span>
              </div>
              <select
                value={chunkInterval}
                onChange={(e) => setChunkInterval(Number(e.target.value))}
                className="bg-slate-700 border border-slate-600 text-white rounded px-3 py-1 text-sm"
              >
                {CHUNK_INTERVAL_OPTIONS.map((sec) => (
                  <option key={sec} value={sec}>
                    {sec}秒
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* エラー表示 */}
          {(status === 'error' || error) && (
            <Alert variant="destructive" className="bg-red-900/50 border-red-700">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>エラー</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* ルビ機能トグル */}
          <div className="flex items-center justify-between px-2">
            <div className="flex items-center gap-2 text-slate-300">
              <BookOpen className="w-4 h-4" />
              <span className="text-sm">難しい単語にルビ表示</span>
            </div>
            <button
              onClick={() => setAnnotationEnabled(!annotationEnabled)}
              className={`w-12 h-6 rounded-full transition-colors ${annotationEnabled ? 'bg-purple-500' : 'bg-slate-600'
                }`}
            >
              <div
                className={`w-5 h-5 bg-white rounded-full transition-transform ${annotationEnabled ? 'translate-x-6' : 'translate-x-0.5'
                  }`}
              />
            </button>
          </div>

          {/* アノテーションステータス */}
          {annotationEnabled && (
            <div className="flex items-center justify-center gap-2 text-sm">
              {annotationStatus === 'loading' && (
                <span className="text-yellow-400 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Annotating...
                </span>
              )}
              {annotationStatus === 'done' && annotations.length > 0 && (
                <span className="text-green-400">
                  ✓ {annotations.length} words annotated
                </span>
              )}
              {annotationStatus === 'rate-limited' && (
                <span className="text-orange-400 flex items-center gap-2">
                  Rate limited: wait {annotationCountdown}s
                  {annotationCountdown === 0 && (
                    <Button size="sm" variant="outline" onClick={handleRetryAnnotation}>
                      Retry
                    </Button>
                  )}
                </span>
              )}
            </div>
          )}

          {/* 結果表示 */}
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <label className="text-sm font-medium text-slate-300">
                Transcription Result
              </label>
              {transcription && (
                <Button
                  onClick={handleClear}
                  variant="ghost"
                  size="sm"
                  className="text-slate-400 hover:text-white"
                >
                  Clear
                </Button>
              )}
            </div>
            <div className="min-h-[200px] p-4 bg-slate-900/50 border border-slate-600 rounded-md text-white text-lg leading-relaxed">
              {transcription ? (
                renderTextWithRuby()
              ) : (
                <span className="text-slate-500">Start recording to see transcription...</span>
              )}
            </div>
          </div>

          {/* 使い方 */}
          <div className="text-center text-slate-500 text-xs space-y-1">
            <p>💡 録音中は選択した間隔で自動で文字起こし</p>
            <p>🎤 マイクへのアクセス許可が必要です</p>
          </div>
        </CardContent>
      </Card>

      {/* Ruby用CSS */}
      <style jsx global>{`
        .ruby-annotation {
          position: relative;
          cursor: help;
        }
        .ruby-annotation rt {
          font-size: 0.6em;
          color: #a78bfa;
          font-weight: normal;
        }
        .ruby-annotation:hover {
          background-color: rgba(167, 139, 250, 0.2);
          border-radius: 2px;
        }
      `}</style>
    </main>
  );
}
