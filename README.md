# Groq STT PoC

iPhone（WebKit）向けに最適化された「録音→テキスト変換」Webアプリです。Groqの高速Whisperモデルを使用しています。

## セットアップ

1.  **依存関係のインストール**:
    ```bash
    npm install
    ```

2.  **環境変数の設定**:
    `.env.example` を `.env` にコピーし、Groq APIキーを設定してください。
    ```env
    GROQ_API_KEY=gsk_...
    ```

3.  **開発サーバーの起動**:
    ```bash
    npm run dev
    ```
    [http://localhost:3000](http://localhost:3000) を開いてください（モバイルテストにはローカルIPを使用）。

## アーキテクチャ

- **フロントエンド**: Next.js App Router, Tailwind CSS, ShadCN/UI
- **バックエンド**: Next.js Route Handler (`/api/transcribe`)
- **音声認識**: Groq API (whisper-large-v3-turbo)

## 注意事項

- **クライアント側制限**: 送信中はボタンを無効化し、連打を防止（最低2秒間）
- **サーバー側制限**: インメモリロックで同時リクエストを1つに制限
- **レート制限対応**: 429エラー時は `Retry-After` ヘッダーを読み取り、待ち時間を表示

## 今後の改善案

- [ ] getUserMedia/MediaRecorderによるリアルタイム録音
- [ ] WebSocket対応でストリーミング文字起こし
- [ ] 多言語対応（日本語音声→日本語テキスト）
- [ ] Redis/KVによる分散環境対応のレート制限
