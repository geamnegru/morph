import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { DropZone } from './DropZone';
import type { VideoFormat, VideoBatchFile } from '../types';
import { FORMATS, EMPTY_BATCH_MESSAGE } from '../constants';
import { createBatchFileId, formatBytes, triggerDownload } from '../utils/fileUtils';
import { buildFFmpegCommand, convertVideoToWebmWithWebCodecs, getVideoMetadata } from '../video/conversion';

export const VideoConverter: React.FC = () => {
  const [isLoadingEngine, setIsLoadingEngine] = useState(true);
  const [isReady, setIsReady] = useState(false);

  const [inputType, setInputType] = useState<VideoFormat>('mp4');
  const [outputType, setOutputType] = useState<VideoFormat>('webm');

  const ffmpegRef = useRef<FFmpeg | null>(null);

  const videoFormats = useMemo(() => Object.keys(FORMATS) as VideoFormat[], []);

  useEffect(() => {
  let cancelled = false;

  const initFFmpeg = async () => {
    try {
      const ffmpeg = new FFmpeg();

      ffmpeg.on('log', ({ message }) => {
        console.log('[FFmpeg]', message);
      });

      const baseURL = '/ffmpeg';

      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        classWorkerURL: '/ffmpeg/worker.js',
      });

      if (!cancelled) {
        ffmpegRef.current = ffmpeg;
        setIsReady(true);
      }
    } catch (err) {
      console.error('[FFmpeg load failed]', err);
      if (!cancelled) {
        setIsReady(false);
      }
    } finally {
      if (!cancelled) {
        setIsLoadingEngine(false);
      }
    }
  };

  void initFFmpeg();

  return () => {
    cancelled = true;
  };
}, []);

  const handleInputTypeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextType = e.target.value as VideoFormat;
    setInputType(nextType);
    setOutputType(nextType);
  }, []);

  const handleOutputTypeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextType = e.target.value as VideoFormat;
    setOutputType(nextType);
  }, []);

  // ── Batch state ────────────────────────────────────────────────────────────
  const [batchFiles, setBatchFiles] = useState<VideoBatchFile[]>([]);
  const [batchConverting, setBatchConverting] = useState(false);

  const getErrorMessage = (error: unknown) => {
    return error instanceof Error ? error.message : 'Failed';
  };

  const updateBatchFile = useCallback((id: string, patch: Partial<VideoBatchFile>) => {
    setBatchFiles(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));
  }, []);

  // Conversie single pentru batch
  const convertBatchSingle = useCallback(async (bf: VideoBatchFile): Promise<void> => {
    updateBatchFile(bf.id, { status: 'converting', progress: 0 });

    const file = bf.file;
    const ext = (file.name.split('.').pop()?.toLowerCase() ?? 'mp4') as VideoFormat;
    const inFmt: VideoFormat = (Object.keys(FORMATS) as VideoFormat[]).includes(ext) ? ext : 'mp4';
    const onProgress = (p: number) => updateBatchFile(bf.id, { progress: p });

    try {
      let meta = { durationSec: 0, fps: null as number | null, frameCount: null as number | null };
      try { meta = await getVideoMetadata(file); } catch { /* metadata is optional */ }

      const fps = meta.fps != null ? Math.max(1, Math.round(meta.fps)) : 30;
      let blob: Blob | null = null;

      // ── WebCodecs path (*→WebM) ────────────────────────────────────────────
      // MP4 folosește pipeline-ul optimizat cu demux MP4 streaming.
      // Restul formatelor încearcă un pipeline browser-decoded + VideoEncoder.
      if (outputType === 'webm') {
        try {
          console.log('[Batch] WebCodecs start:', file.name, '| fps:', fps, '| durationSec:', meta.durationSec);
          const wcResult = await convertVideoToWebmWithWebCodecs({
            file,
            inputFormat: inFmt,
            codec: 'vp8',
            framerate: fps,
            durationSec: meta.durationSec,
            onProgress: p => onProgress(Math.round(p * 100)),
          });
          blob = wcResult.blob;
          console.log('[Batch] WebCodecs done:', formatBytes(blob.size));
        } catch (error: unknown) {
          console.warn('[Batch] WebCodecs failed, falling back to FFmpeg:', error);
        }
      }

      // ── FFmpeg path ────────────────────────────────────────────────────────
      if (!blob) {
        if (!ffmpegRef.current || !isReady) throw new Error('FFmpeg not ready.');
        const ffmpeg = ffmpegRef.current;
        ffmpeg.on('progress', ({ progress: p }) => onProgress(Math.max(0, Math.min(100, Math.round(p * 100)))));
        const { fetchFile } = await import('@ffmpeg/util');
        const inputName  = `b_in_${bf.id}.${inFmt}`;
        const outputName = `b_out_${bf.id}.${outputType}`;
        await ffmpeg.writeFile(inputName, await fetchFile(file));
        await ffmpeg.exec(buildFFmpegCommand(inputName, outputName, outputType));
        const data = await ffmpeg.readFile(outputName);
        if (typeof data === 'string') throw new Error('Unexpected FFmpeg output');
        const bytes = new Uint8Array(data.byteLength);
        bytes.set(data);
        blob = new Blob([bytes], { type: FORMATS[outputType].mimeType });
        try { await ffmpeg.deleteFile(inputName); } catch { /* ignore cleanup errors */ }
        try { await ffmpeg.deleteFile(outputName); } catch { /* ignore cleanup errors */ }
      }

      if (!blob || blob.size === 0) throw new Error('Output is empty.');
      const url = URL.createObjectURL(blob);
      updateBatchFile(bf.id, { status: 'done', progress: 100, resultUrl: url, resultSize: blob.size });
    } catch (error: unknown) {
      updateBatchFile(bf.id, { status: 'error', error: getErrorMessage(error) });
    }
  }, [outputType, isReady, updateBatchFile]);

  const batchFilesRef = useRef<VideoBatchFile[]>([]);
  // Sync ref cu state ca să avem acces în closure fără stale data
  useEffect(() => { batchFilesRef.current = batchFiles; }, [batchFiles]);

  const convertBatchAll = useCallback(async () => {
    const pending = batchFilesRef.current.filter(f => f.status === 'waiting' || f.status === 'error');
    if (!pending.length) return;
    setBatchConverting(true);

    // Procesăm secvențial — 2 instanțe WebCodecs simultane pe GPU cauzează DecodingError
    // Mai ales pentru fișiere 4K unde GPU-ul nu poate ține 2 decode+encode în paralel
    for (const f of pending) {
      await convertBatchSingle(f);
    }
    setBatchConverting(false);
  }, [convertBatchSingle]);

  const removeBatchFile = useCallback((id: string) => {
    setBatchFiles(prev => {
      const f = prev.find(x => x.id === id);
      if (f?.resultUrl) URL.revokeObjectURL(f.resultUrl);
      return prev.filter(x => x.id !== id);
    });
  }, []);

  const clearBatch = useCallback(() => {
    setBatchFiles(prev => { prev.forEach(f => { if (f.resultUrl) URL.revokeObjectURL(f.resultUrl); }); return []; });
  }, []);

  const downloadBatchAll = useCallback(() => {
    batchFiles.filter(f => f.resultUrl).forEach((f, i) => {
      setTimeout(() => {
        triggerDownload(
          f.resultUrl!,
          `${f.file.name.replace(/\.[^.]+$/, '')}.${outputType}`
        );
      }, i * 80);
    });
  }, [batchFiles, outputType]);

  const batchDoneCount = batchFiles.filter(f => f.status === 'done').length;
  const batchPendingCount = batchFiles.filter(f => f.status === 'waiting' || f.status === 'error').length;

  const batchStatusLabel: Record<string, string> = {
    waiting: 'waiting', converting: 'converting...', done: 'done', error: 'error',
  };

  return (
    <div className="card">
      <div className="status-row">
        <div className={`status-dot ${isReady ? 'status-dot--ready' : 'status-dot--loading'}`} />
        <span className="status-text">
          {isReady ? 'FFmpeg ready' : isLoadingEngine ? 'Loading FFmpeg...' : 'FFmpeg unavailable'}
        </span>
      </div>

      <div className="format-row">
        <div>
          <label className="label">From</label>
          <select className="select" value={inputType} onChange={handleInputTypeChange}
            disabled={isLoadingEngine || batchConverting}>
            {videoFormats.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
          </select>
        </div>
        <div className="format-arrow">{'->'}</div>
        <div>
          <label className="label">To</label>
          <select className="select" value={outputType} onChange={handleOutputTypeChange}
            disabled={isLoadingEngine || batchConverting}>
            {videoFormats.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="label">Add files</label>
        <DropZone
          accept={Object.values(FORMATS).map(f => f.accept).join(',')}
          multiple
          disabled={isLoadingEngine || batchConverting}
          hint="MP4, WebM, AVI, MOV, MKV"
          onFiles={files => {
            const newFiles: VideoBatchFile[] = files.map(f => {
              const ext = (f.name.split('.').pop()?.toLowerCase() ?? 'mp4') as VideoFormat;
              const inFmt = (Object.keys(FORMATS) as VideoFormat[]).includes(ext) ? ext : 'mp4';
              return {
                id: createBatchFileId(),
                file: f, inFmt, status: 'waiting', progress: 0,
                resultUrl: null, resultSize: null, error: null,
              };
            });
            setBatchFiles(prev => [...prev, ...newFiles]);
          }}
        />
      </div>

      {batchFiles.length > 0 && (
        <div className="batch-file-list">
          {batchFiles.map(f => (
            <div key={f.id} className={`batch-file-item batch-file-item--${f.status}`}>
              <div className="batch-file-name" title={f.file.name}>{f.file.name}</div>
              <div className="batch-file-size">{formatBytes(f.file.size)}</div>
              {f.status === 'converting' && (
                <div className="batch-file-progress">
                  <div className="batch-file-progress-fill" style={{ width: `${f.progress}%` }} />
                </div>
              )}
              {f.status === 'done' && f.resultSize !== null && (
                <div className="batch-file-size" style={{ color: '#16A34A' }}>
                  {'->'} {formatBytes(f.resultSize)}
                </div>
              )}
              <div className={`batch-file-status batch-file-status--${f.status}`}>
                {f.status === 'error' ? f.error?.slice(0, 20) ?? 'error' : batchStatusLabel[f.status]}
              </div>
              {f.resultUrl && (
                <button
                  className="batch-download-btn"
                  style={{ padding: '4px 10px', fontSize: '11px' }}
                  onClick={() => triggerDownload(f.resultUrl!, `${f.file.name.replace(/\.[^.]+$/, '')}.${outputType}`)}>
                  Save
                </button>
              )}
              {!batchConverting && (
                <button onClick={() => removeBatchFile(f.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#BBBBBB', fontSize: '14px', padding: '0 2px' }}>
                  x
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {batchFiles.length > 0 && (
        <div className="batch-actions">
          <button className="btn-primary batch-primary-action"
            onClick={convertBatchAll}
            disabled={batchConverting || (!isReady && outputType !== 'webm') || batchPendingCount === 0}>
            {batchConverting
              ? `Converting ${batchFilesRef.current.filter(f => f.status === 'done').length + 1} of ${batchFilesRef.current.length}...`
              : `Convert ${batchPendingCount} file${batchPendingCount !== 1 ? 's' : ''}`}
          </button>
          {batchDoneCount > 0 && (
            <button className="batch-download-btn" onClick={downloadBatchAll}>
              Save all ({batchDoneCount})
            </button>
          )}
          <button className="btn-ghost" onClick={clearBatch} disabled={batchConverting}>Clear</button>
        </div>
      )}

      {batchFiles.length === 0 && (
        <p className="batch-empty-state">
          {EMPTY_BATCH_MESSAGE}
        </p>
      )}
    </div>
  );
};
