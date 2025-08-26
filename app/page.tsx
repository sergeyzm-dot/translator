'use client';

import { useState, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Upload, Download, Heart, Coffee } from 'lucide-react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';

interface TranslationProgress {
  stage: 'idle' | 'uploading' | 'extracting' | 'translating' | 'building' | 'completed' | 'error';
  currentChunk?: number;
  totalChunks?: number;
  message?: string;
}

interface TranslationResult {
  downloadUrl: string; // абсолютный URL из Vercel Blob
  pagesProcessed: number;
  model: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

const languages = [
  { code: 'en', name: 'English' },
  { code: 'ru', name: 'Russian' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
];

const models = [
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Fast & Cost-effective)' },
  { id: 'gpt-4o', name: 'GPT-4o (Balanced)' },
  { id: 'gpt-4', name: 'GPT-4 (Highest Quality)' },
  { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo (Budget)' },
];

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceLang, setSourceLang] = useState('en');
  const [targetLang, setTargetLang] = useState('ru');
  const [model, setModel] = useState('gpt-4o-mini');
  const [progress, setProgress] = useState<TranslationProgress>({ stage: 'idle' });
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);

  // безопасный доступ к переменной окружения
  const DONATE_LINK = process.env.NEXT_PUBLIC_DONATION_LINK ?? '';

  const handleFileSelect = useCallback((selectedFile: File) => {
    if (selectedFile.type !== 'application/pdf') {
      toast.error('Please select a PDF file');
      return;
    }
    if (selectedFile.size > 25 * 1024 * 1024) {
      toast.error('File size must be less than 25MB');
      return;
    }
    setFile(selectedFile);
    setResult(null);
    setProgress({ stage: 'idle' });
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) handleFileSelect(droppedFile);
  }, [handleFileSelect]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const uploadFile = async () => {
    if (!file) return null;
    setProgress({ stage: 'uploading', message: 'Uploading PDF...' });

    const formData = new FormData();
    formData.append('pdf', file);

    try {
      const response = await fetch('/api/upload', { method: 'POST', body: formData });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || 'Upload failed');
      }
      const data = await response.json();
      return data.uploadId as string;
    } catch (error) {
      console.error('Upload error:', error);
      setProgress({ stage: 'error', message: error instanceof Error ? error.message : 'Upload failed' });
      toast.error('Upload failed. Please try again.');
      return null;
    }
  };

  const translateFile = async () => {
    if (!uploadId) return;
    setProgress({ stage: 'translating', message: 'Starting translation...' });

    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId, sourceLang, targetLang, model }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || 'Translation failed');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = new TextDecoder().decode(value);
        const lines = chunk.split('\n').filter((line) => line.trim());

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'progress') {
              setProgress({
                stage: 'translating',
                currentChunk: data.currentChunk,
                totalChunks: data.totalChunks,
                message: `Translating chunk ${data.currentChunk}/${data.totalChunks}...`,
              });
            } else if (data.type === 'building') {
              setProgress({ stage: 'building', message: 'Building DOCX file...' });
            } else if (data.type === 'completed') {
              setProgress({ stage: 'completed', message: 'Translation completed!' });
              setResult(data.result as TranslationResult);
              toast.success('Translation completed successfully!');
            } else if (data.type === 'error') {
              throw new Error(data.message);
            }
          } catch (e) {
            console.error('Error parsing SSE data:', e);
          }
        }
      }
    } catch (error) {
      console.error('Translation error:', error);
      setProgress({ stage: 'error', message: error instanceof Error ? error.message : 'Translation failed' });
      toast.error('Translation failed. Please try again.');
    }
  };

  const handleTranslate = async () => {
    if (!file) return;
    const id = await uploadFile();
    if (!id) return;
    setUploadId(id);
    await translateFile();
  };

  const handlePayment = async (amount: number) => {
    try {
      const response = await fetch('/api/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      if (!response.ok) throw new Error('Payment failed');
      const { url } = await response.json();
      window.location.href = url;
    } catch {
      toast.error('Payment failed. Please try again.');
    }
  };

  const getProgressPercentage = () => {
    switch (progress.stage) {
      case 'idle': return 0;
      case 'uploading': return 10;
      case 'extracting': return 20;
      case 'translating':
        if (progress.currentChunk && progress.totalChunks)
          return 20 + (progress.currentChunk / progress.totalChunks) * 60;
        return 30;
      case 'building': return 85;
      case 'completed': return 100;
      case 'error': return 0;
      default: return 0;
    }
  };

  const isProcessing = ['uploading', 'extracting', 'translating', 'building'].includes(progress.stage);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto space-y-8">
          {/* Header */}
          <div className="text-center space-y-4">
            <h1 className="text-4xl font-bold text-gray-900">PDF Translator</h1>
            <p className="text-xl text-gray-600 max-w-2xl mx-auto">
              Professional translation for relational psychoanalysis documents using advanced AI
            </p>
          </div>

          {/* Main Translation Card */}
          <Card className="p-8 bg-white shadow-xl border-0">
            <div className="space-y-6">
              {/* File Upload */}
              <div>
                <h2 className="text-2xl font-semibold mb-4">Upload PDF Document</h2>
                <div
                  className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                    isDragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
                  }`}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                >
                  {file ? (
                    <div className="space-y-2">
                      <div className="text-green-600 font-medium">{file.name}</div>
                      <div className="text-sm text-gray-500">{(file.size / (1024 * 1024)).toFixed(2)} MB</div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <Upload className="mx-auto h-12 w-12 text-gray-400" />
                      <div>
                        <p className="text-lg font-medium text-gray-900">Drop your PDF here or click to browse</p>
                        <p className="text-sm text-gray-500 mt-1">Maximum file size: 25MB</p>
                      </div>
                      <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={isProcessing}>
                        Choose File
                      </Button>
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    className="hidden"
                    onChange={(e) => {
                      const selectedFile = e.target.files?.[0];
                      if (selectedFile) handleFileSelect(selectedFile);
                    }}
                  />
                </div>
              </div>

              {/* Language & Model Selection */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Source Language</label>
                  <Select value={sourceLang} onValueChange={setSourceLang} disabled={isProcessing}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {languages.map((lang) => (
                        <SelectItem key={lang.code} value={lang.code}>{lang.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Target Language</label>
                  <Select value={targetLang} onValueChange={setTargetLang} disabled={isProcessing}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {languages.map((lang) => (
                        <SelectItem key={lang.code} value={lang.code}>{lang.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">AI Model</label>
                  <Select value={model} onValueChange={setModel} disabled={isProcessing}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {models.map((m) => (
                        <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Translate Button */}
              <div className="text-center">
                <Button
                  onClick={handleTranslate}
                  disabled={!file || isProcessing}
                  size="lg"
                  className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-3"
                >
                  {isProcessing ? 'Processing...' : 'Translate Document'}
                </Button>
              </div>

              {/* Progress */}
              {progress.stage !== 'idle' && (
                <div className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{progress.message || 'Processing...'}</span>
                    <span className="text-gray-500">{Math.round(getProgressPercentage())}%</span>
                  </div>
                  <Progress value={getProgressPercentage()} className="h-2" />
                </div>
              )}

              {/* Error */}
              {progress.stage === 'error' && (
                <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-red-800">{progress.message}</p>
                </div>
              )}

              {/* Result */}
              {result && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-6">
                  <div className="flex items-start justify-between">
                    <div className="space-y-2">
                      <h3 className="font-semibold text-green-900">Translation Complete!</h3>
                      <div className="space-y-1 text-sm text-green-800">
                        <p>Pages processed: {result.pagesProcessed}</p>
                        <p>Model used: {result.model}</p>
                        {result.tokenUsage && (
                          <p>Tokens: {result.tokenUsage.inputTokens} input, {result.tokenUsage.outputTokens} output</p>
                        )}
                      </div>
                    </div>
                    <Button asChild className="bg-green-600 hover:bg-green-700 text-white">
                      {/* прямая ссылка из Vercel Blob; открываем в новой вкладке и помечаем как загрузку DOCX */}
                      <a href={result.downloadUrl} target="_blank" rel="noopener noreferrer" download>
                        <Download className="w-4 h-4 mr-2" />
                        Download DOCX
                      </a>
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* Support Section */}
          <Card className="p-6 bg-white shadow-lg border-0">
            <div className="text-center space-y-4">
              <h3 className="text-xl font-semibold flex items-center justify-center gap-2">
                <Heart className="w-5 h-5 text-red-500" />
                Support the Project
              </h3>
              <p className="text-gray-600">Help us maintain and improve this translation service</p>
              <div className="flex justify-center gap-3 flex-wrap">
                <Button onClick={() => handlePayment(3)} variant="outline" className="border-blue-200 hover:bg-blue-50">
                  $3 Thanks
                </Button>
                <Button onClick={() => handlePayment(5)} variant="outline" className="border-blue-200 hover:bg-blue-50">
                  $5 Thanks
                </Button>
                <Button onClick={() => handlePayment(10)} variant="outline" className="border-blue-200 hover:bg-blue-50">
                  $10 Thanks
                </Button>
              </div>
              {DONATE_LINK && (
                <div className="pt-4 border-t">
                  <Button asChild variant="ghost" className="text-orange-600 hover:text-orange-700">
                    <a href={encodeURI(DONATE_LINK)} target="_blank" rel="noopener noreferrer">
                      <Coffee className="w-4 h-4 mr-2" />
                      Buy me a coffee
                    </a>
                  </Button>
                </div>
              )}
            </div>
          </Card>

          {/* Footer */}
          <div className="text-center space-y-2 text-sm text-gray-500">
            <p>
              <strong>Privacy:</strong> All files are automatically deleted within 24 hours.
              We don&rsquo;t store your documents or translations.
            </p>
            <p>
              Questions? Contact us at{' '}
              <a href="mailto:support@pdftranslator.com" className="text-blue-600 hover:underline">
                support@pdftranslator.com
              </a>
            </p>
          </div>
        </div>
      </div>
      <Toaster />
    </div>
  );
}
