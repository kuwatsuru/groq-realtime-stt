'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Mic, Square, Loader2, AlertCircle } from 'lucide-react';

type Status = 'idle' | 'recording' | 'error' | 'rate-limited';

interface TranscribeResponse {
  text?: string;
  error?: string;
  retryAfter?: number;
  details?: unknown;
}

// チャンク送信間隔（ミリ秒）- 4秒に設定
const CHUNK_INTERVAL_MS = 4000;

export default function Home() {
  const [status, setStatus] = useState<Status>('idle');
  const [transcription, setTranscription] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [countdown, setCountdown] = useState<number>(0);
  const [recordingTime, setRecordingTime] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const chunkIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const mimeTypeRef = useRef<string>('');
  const isRecordingRef = useRef<boolean>(false);

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

  // 音声をAPIに送信
  const sendAudioForTranscription = useCallback(async (audioBlob: Blob) => {
    // 小さすぎるチャンクはスキップ（5KB未満）
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
        setTranscription(prev => {
          const newText = data.text?.trim();
          if (!newText) return prev;
          return prev ? `${prev} ${newText}` : newText;
        });
        setError('');
      } else if (response.status === 429) {
        const waitTime = data.retryAfter || 5;
        setCountdown(waitTime);
        setError(`レート制限: ${waitTime}秒後に再開します`);
      } else {
        const errorDetail = data.details ? JSON.stringify(data.details) : '';
        console.error('API Error:', response.status, data.error, errorDetail);
        // 400エラーは無音の可能性があるので表示しない
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
  }, []);

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
      setRecordingTime(0);
      isRecordingRef.current = true;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        }
      });
      streamRef.current = stream;

      // 対応フォーマットを検出
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : 'audio/wav';

      mimeTypeRef.current = mimeType;
      console.log('Using MIME type:', mimeType);

      // 最初のMediaRecorderを開始
      mediaRecorderRef.current = startMediaRecorder(stream, sendAudioForTranscription);
      setStatus('recording');

      // 録音時間カウンター
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);

      // 定期的にMediaRecorderを再起動して完全な音声ファイルを作成
      chunkIntervalRef.current = setInterval(() => {
        if (!isRecordingRef.current || !streamRef.current) return;

        // 現在のMediaRecorderを停止（これでonstopが呼ばれてBlobが送信される）
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }

        // 新しいMediaRecorderを開始
        mediaRecorderRef.current = startMediaRecorder(streamRef.current, sendAudioForTranscription);
      }, CHUNK_INTERVAL_MS);

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
  }, [startMediaRecorder, sendAudioForTranscription]);

  // 録音停止
  const stopRecording = useCallback(() => {
    isRecordingRef.current = false;
    stopAllTimers();

    // 最後のチャンクを送信
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    // ストリームを停止
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }

    setStatus('idle');
  }, []);

  // ボタンクリック処理
  const handleButtonClick = () => {
    if (status === 'recording') {
      stopRecording();
    } else {
      startRecording();
    }
  };

  // クリアボタン
  const handleClear = () => {
    setTranscription('');
  };

  // フォーマット：秒を MM:SS に
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
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
              <span>Live transcription every {CHUNK_INTERVAL_MS / 1000}s</span>
              {isProcessing && <Loader2 className="w-4 h-4 animate-spin ml-2" />}
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
            <Textarea
              value={transcription}
              placeholder="Start recording to see transcription..."
              readOnly
              className="min-h-[200px] bg-slate-900/50 border-slate-600 text-white text-lg leading-relaxed resize-none"
            />
          </div>

          {/* 使い方 */}
          <div className="text-center text-slate-500 text-xs space-y-1">
            <p>💡 録音中は{CHUNK_INTERVAL_MS / 1000}秒ごとに自動で文字起こし</p>
            <p>🎤 マイクへのアクセス許可が必要です</p>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
