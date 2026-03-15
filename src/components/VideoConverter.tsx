import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import type { VideoFormat, HTMLVideoElementWithCapture } from '../types';
import { FORMATS, WEBM_MIME_CANDIDATES, COPY_COMPATIBLE_FORMATS } from '../constants';

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const getFileExtension = (fileName: string): string => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  return ext || 'mp4';
};

const pickSupportedWebmMimeType = (): string | null => {
  if (typeof MediaRecorder === 'undefined') return null;

  for (const mime of WEBM_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }

  return null;
};

const buildFFmpegCommand = (inputName: string, outputName: string, outputType: VideoFormat): string[] => {
  if (COPY_COMPATIBLE_FORMATS.includes(outputType)) {
    return ['-i', inputName, '-c', 'copy', outputName];
  }

  if (outputType === 'webm') {
    return [
      '-i',
      inputName,
      '-c:v',
      'libvpx',
      '-b:v',
      '1M',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-row-mt',
      '1',
      '-threads',
      '4',
      '-c:a',
      'libvorbis',
      '-b:a',
      '128k',
      outputName,
    ];
  }

  return ['-i', inputName, outputName];
};

export const VideoConverter: React.FC = () => {
  const [isLoadingEngine, setIsLoadingEngine] = useState(true);
  const [isConverting, setIsConverting] = useState(false);
  const [isReady, setIsReady] = useState(false);

  const [inputType, setInputType] = useState<VideoFormat>('mp4');
  const [outputType, setOutputType] = useState<VideoFormat>('webm');

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('Inițializare FFmpeg...');
  const [error, setError] = useState<string | null>(null);

  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultSize, setResultSize] = useState<number | null>(null);
  const [engineUsed, setEngineUsed] = useState<'ffmpeg' | 'mediarecorder' | null>(null);

  const ffmpegRef = useRef<FFmpeg | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const inputPreviewUrlRef = useRef<string | null>(null);

  const videoFormats = useMemo(() => Object.keys(FORMATS) as VideoFormat[], []);
  const supportedWebmMimeType = useMemo(() => pickSupportedWebmMimeType(), []);

  const resetResult = useCallback(() => {
    setEngineUsed(null);

    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    setResultSize(null);
  }, []);

  const stopMediaRecorderResources = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {}
    }

    mediaRecorderRef.current = null;

    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }

    mediaChunksRef.current = [];
  }, []);

  useEffect(() => {
    const initFFmpeg = async () => {
      try {
        const ffmpeg = new FFmpeg();

        ffmpeg.on('log', ({ message }) => {
          console.log('[FFmpeg]', message);
        });

        ffmpeg.on('progress', ({ progress }) => {
          const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
          setProgress(percent);
          setStatusText(`Convertesc... ${percent}%`);
        });

        await ffmpeg.load();

        ffmpegRef.current = ffmpeg;
        setIsReady(true);
        setStatusText('FFmpeg este gata.');
      } catch (err) {
        console.error(err);
        setError('FFmpeg nu s-a putut încărca.');
        setStatusText('Eroare la inițializare.');
      } finally {
        setIsLoadingEngine(false);
      }
    };

    void initFFmpeg();

    return () => {
      resetResult();
      stopMediaRecorderResources();

      if (inputPreviewUrlRef.current) {
        URL.revokeObjectURL(inputPreviewUrlRef.current);
        inputPreviewUrlRef.current = null;
      }
    };
  }, [resetResult, stopMediaRecorderResources]);

  const handleInputTypeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextType = e.target.value as VideoFormat;
    setInputType(nextType);
    setOutputType(nextType);
    setError(null);
    resetResult();
  }, [resetResult]);

  const handleOutputTypeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextType = e.target.value as VideoFormat;
    setOutputType(nextType);
    setError(null);
    resetResult();
  }, [resetResult]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setError(null);
    setProgress(0);
    resetResult();

    stopMediaRecorderResources();

    if (inputPreviewUrlRef.current) {
      URL.revokeObjectURL(inputPreviewUrlRef.current);
      inputPreviewUrlRef.current = null;
    }

    if (!file) return;

    const ext = getFileExtension(file.name);
    const normalizedInputType = (videoFormats.includes(ext as VideoFormat) ? ext : 'mp4') as VideoFormat;
    setInputType(normalizedInputType);

    const previewUrl = URL.createObjectURL(file);
    inputPreviewUrlRef.current = previewUrl;
  }, [resetResult, stopMediaRecorderResources, videoFormats]);

  const clearAll = useCallback(() => {
    setSelectedFile(null);
    setError(null);
    setProgress(0);
    setStatusText(isReady ? 'Pregătit pentru conversie.' : 'Inițializare FFmpeg...');
    resetResult();
    stopMediaRecorderResources();

    if (inputPreviewUrlRef.current) {
      URL.revokeObjectURL(inputPreviewUrlRef.current);
      inputPreviewUrlRef.current = null;
    }

    if (previewVideoRef.current) {
      previewVideoRef.current.removeAttribute('src');
      previewVideoRef.current.load();
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [isReady, resetResult, stopMediaRecorderResources]);

  const convertWithMediaRecorder = useCallback(async (): Promise<boolean> => {
    if (!selectedFile) return false;
    if (inputType !== 'mp4' || outputType !== 'webm') return false;
    if (!supportedWebmMimeType) return false;

    const video = previewVideoRef.current;
    if (!video) return false;

    const inputUrl = inputPreviewUrlRef.current;
    if (!inputUrl) return false;

    setStatusText('Pregătesc conversia rapidă...');
    setProgress(0);

    stopMediaRecorderResources();

    video.pause();
    video.currentTime = 0;
    video.muted = false;
    video.playsInline = true;
    video.src = inputUrl;

    await new Promise<void>((resolve, reject) => {
      const onLoadedMetadata = () => {
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        reject(new Error('Nu am putut încărca video-ul pentru conversia rapidă.'));
      };

      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('loadedmetadata', onLoadedMetadata);
      video.addEventListener('error', onError);
      video.load();
    });

    const mediaVideo = video as HTMLVideoElementWithCapture;

    const captureStreamFn =
      mediaVideo.captureStream ?? mediaVideo.mozCaptureStream;
    if (!captureStreamFn) {
      throw new Error('captureStream() nu este disponibil în acest browser.');
    }

    const stream = captureStreamFn.call(video);
    mediaStreamRef.current = stream;
    mediaChunksRef.current = [];

    const recorder = new MediaRecorder(stream, {
      mimeType: supportedWebmMimeType,
      videoBitsPerSecond: 1_200_000,
    });

    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        mediaChunksRef.current.push(event.data);
      }
    };

    recorder.onerror = () => {
      setError('MediaRecorder a dat eroare în timpul conversiei rapide.');
      setStatusText('Eroare la conversia rapidă.');
    };

    const resultPromise = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => {
        try {
          const blob = new Blob(mediaChunksRef.current, { type: supportedWebmMimeType });
          const url = URL.createObjectURL(blob);

          setResultUrl(url);
          setResultSize(blob.size);
          setEngineUsed('mediarecorder');
          setProgress(100);
          setStatusText('Conversie rapidă finalizată.');
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          stopMediaRecorderResources();
        }
      };
    });

    const endedPromise = new Promise<void>((resolve, reject) => {
      const onEnded = () => {
        cleanup();
        resolve();
      };

      const onError = () => {
        cleanup();
        reject(new Error('Video playback a eșuat în timpul conversiei rapide.'));
      };

      const cleanup = () => {
        video.removeEventListener('ended', onEnded);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('ended', onEnded);
      video.addEventListener('error', onError);
    });

    recorder.start(1000);
    setEngineUsed('mediarecorder');
    setStatusText('Convertesc rapid MP4 → WebM...');
    setProgress(15);

    try {
      await video.play();
    } catch {
      throw new Error('Browserul a blocat redarea video necesară pentru conversia rapidă.');
    }

    const progressInterval = window.setInterval(() => {
      if (!video.duration || !Number.isFinite(video.duration)) return;
      const percent = Math.max(0, Math.min(99, Math.round((video.currentTime / video.duration) * 100)));
      setProgress(percent);
    }, 150);

    try {
      await endedPromise;

      if (recorder.state !== 'inactive') {
        recorder.stop();
      }

      await resultPromise;
      return true;
    } catch (err) {
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {}
      }
      throw err;
    } finally {
      window.clearInterval(progressInterval);
      video.pause();
      video.currentTime = 0;
    }
  }, [inputType, outputType, selectedFile, stopMediaRecorderResources, supportedWebmMimeType]);

  const convertWithFFmpeg = useCallback(async () => {
    if (!selectedFile) {
      setError('Selectează un fișier video.');
      return;
    }

    if (!ffmpegRef.current || !isReady || isLoadingEngine) {
      setError('FFmpeg nu este gata încă.');
      return;
    }

    const ffmpeg = ffmpegRef.current;
    const inputExt = getFileExtension(selectedFile.name);
    const inputName = `input.${inputExt}`;
    const outputName = `output.${outputType}`;

    try {
      const fileData = await fetchFile(selectedFile);

      setEngineUsed('ffmpeg');
      setStatusText('Scriu fișierul în memorie...');
      await ffmpeg.writeFile(inputName, fileData);

      const command = buildFFmpegCommand(inputName, outputName, outputType);

      setStatusText('Pornesc conversia...');
      await ffmpeg.exec(command);

      setStatusText('Citesc rezultatul...');
      const outputData = await ffmpeg.readFile(outputName);

      if (typeof outputData === 'string') {
        throw new Error('Expected binary output from FFmpeg, but received text.');
      }

      const safeBytes = new Uint8Array(outputData.byteLength);
      safeBytes.set(outputData);

      const blob = new Blob([safeBytes], {
        type: FORMATS[outputType].mimeType,
      });

      const url = URL.createObjectURL(blob);

      setResultUrl(url);
      setResultSize(blob.size);
      setProgress(100);
      setStatusText('Conversie finalizată.');
    } finally {
      try {
        await ffmpeg.deleteFile(inputName);
      } catch {}

      try {
        await ffmpeg.deleteFile(outputName);
      } catch {}
    }
  }, [selectedFile, isReady, isLoadingEngine, outputType]);

  const convertFile = useCallback(async () => {
    if (!selectedFile) {
      setError('Selectează un fișier video.');
      return;
    }

    setIsConverting(true);
    setError(null);
    setProgress(0);
    setStatusText('Pregătesc fișierul...');
    resetResult();

    try {
      const shouldUseFastPath = inputType === 'mp4' && outputType === 'webm';

      if (shouldUseFastPath) {
        try {
          const fastWorked = await convertWithMediaRecorder();
          if (fastWorked) return;
        } catch (fastError) {
          console.warn('Conversia rapidă a eșuat, fallback la FFmpeg:', fastError);
          setStatusText('Conversia rapidă a eșuat, încerc cu FFmpeg...');
          setProgress(5);
        }
      }

      await convertWithFFmpeg();
    } catch (err) {
      console.error(err);
      setError(
        err instanceof Error
          ? err.message
          : 'Conversia a eșuat. Unele combinații de formate/codecuri nu permit copy direct.'
      );
      setStatusText('Eroare la conversie.');
    } finally {
      setIsConverting(false);
    }
  }, [selectedFile, inputType, outputType, resetResult, convertWithMediaRecorder, convertWithFFmpeg]);

  return (
    <div
      style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: 24,
        fontFamily: 'Arial, sans-serif',
      }}
    >
      <div
        style={{
          display: 'grid',
          gap: 16,
          background: '#ffffff',
          border: '1px solid #e5e7eb',
          borderRadius: 16,
          padding: 20,
          boxShadow: '0 8px 24px rgba(0,0,0,0.06)',
        }}
      >
        <div>
          <label style={{ display: 'block', marginBottom: 8, fontWeight: 700 }}>Format input</label>
          <select
            value={inputType}
            onChange={handleInputTypeChange}
            disabled={isLoadingEngine || isConverting}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: 10,
              border: '1px solid #d1d5db',
              fontSize: 16,
            }}
          >
            {videoFormats.map((format) => (
              <option key={format} value={format}>
                {format.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: 8, fontWeight: 700 }}>Format output</label>
          <select
            value={outputType}
            onChange={handleOutputTypeChange}
            disabled={isLoadingEngine || isConverting}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: 10,
              border: '1px solid #d1d5db',
              fontSize: 16,
            }}
          >
            {videoFormats.map((format) => (
              <option key={format} value={format}>
                {format.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: 8, fontWeight: 700 }}>Fișier video</label>
          <input
            ref={fileInputRef}
            type="file"
            accept={FORMATS[inputType].accept}
            onChange={handleFileChange}
            disabled={isLoadingEngine || isConverting}
            style={{
              width: '100%',
              padding: 12,
              borderRadius: 10,
              border: '2px dashed #60a5fa',
              background: '#f8fbff',
              fontSize: 15,
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div style={{ display: 'none' }}>
          <video ref={previewVideoRef} preload="metadata" playsInline />
        </div>

        {selectedFile && (
          <div
            style={{
              padding: 14,
              borderRadius: 12,
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
            }}
          >
            <div><strong>Nume:</strong> {selectedFile.name}</div>
            <div><strong>Mărime:</strong> {formatBytes(selectedFile.size)}</div>
            <div><strong>Conversie:</strong> {inputType.toUpperCase()} → {outputType.toUpperCase()}</div>
          </div>
        )}

        <button
          onClick={convertFile}
          disabled={isConverting || !selectedFile || (inputType !== 'mp4' || outputType !== 'webm') ? !isReady && !supportedWebmMimeType : !supportedWebmMimeType && !isReady}
          style={{
            width: '100%',
            padding: '15px 18px',
            borderRadius: 12,
            border: 'none',
            fontSize: 17,
            fontWeight: 700,
            color: '#fff',
            background:
              isConverting || !selectedFile || ((inputType !== 'mp4' || outputType !== 'webm') ? !isReady : (!supportedWebmMimeType && !isReady))
                ? '#9ca3af'
                : '#2563eb',
            cursor:
              isConverting || !selectedFile || ((inputType !== 'mp4' || outputType !== 'webm') ? !isReady : (!supportedWebmMimeType && !isReady))
                ? 'not-allowed'
                : 'pointer',
          }}
        >
          {isConverting
            ? `🔄 Convertesc... ${progress}%`
            : inputType === 'mp4' && outputType === 'webm'
              ? '🚀 Convert video'
              : isLoadingEngine
                ? '⏳ Încarc FFmpeg...'
                : '🚀 Convertește video'}
        </button>

        <button
          onClick={clearAll}
          disabled={isConverting}
          style={{
            width: '100%',
            padding: '12px 18px',
            borderRadius: 12,
            border: '1px solid #d1d5db',
            fontSize: 15,
            fontWeight: 700,
            background: '#fff',
            cursor: isConverting ? 'not-allowed' : 'pointer',
          }}
        >
          Reset
        </button>
          <div
            style={{
              width: '100%',
              height: 16,
              background: '#e5e7eb',
              borderRadius: 999,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: '100%',
                background: 'linear-gradient(90deg, #22c55e, #14b8a6)',
                transition: 'width 0.25s ease',
              }}
            />
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: 14,
              borderRadius: 12,
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              fontWeight: 600,
            }}
          >
            ❌ {error}
          </div>
        )}

        {resultUrl && (
          <div
            style={{
              padding: 20,
              background: '#ecfdf5',
              borderRadius: 16,
              border: '1px solid #a7f3d0',
            }}
          >
            <h3 style={{ marginTop: 0 }}>✅ Conversie gata</h3>

            {resultSize !== null && (
              <p style={{ marginTop: 0 }}>
                <strong>Mărime rezultat:</strong> {formatBytes(resultSize)}
              </p>
            )}

            <video
              controls
              style={{
                width: '100%',
                maxHeight: 420,
                borderRadius: 12,
                background: '#000',
              }}
            >
              <source src={resultUrl} type={FORMATS[outputType].mimeType} />
              Browserul tău nu suportă redarea acestui fișier.
            </video>

            <div style={{ marginTop: 16, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <a
                href={resultUrl}
                download={`converted-${Date.now()}.${outputType}`}
                style={{
                  display: 'inline-block',
                  padding: '12px 18px',
                  borderRadius: 10,
                  background: '#16a34a',
                  color: '#fff',
                  textDecoration: 'none',
                  fontWeight: 700,
                }}
              >
                💾 Descarcă
              </a>

              <button
                onClick={clearAll}
                style={{
                  padding: '12px 18px',
                  borderRadius: 10,
                  background: '#475569',
                  color: '#fff',
                  border: 'none',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                🔄 Conversie nouă
              </button>
            </div>
          </div>
        )}
        </div>
  );
};