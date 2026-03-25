import React, { useState, useRef, useCallback } from 'react';
import type { ChangeEvent } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import type { AudioBatchFile, AudioFormat } from '../types';
import { AUDIO_DROPZONE_ACCEPT, AUDIO_DROPZONE_HINT, EMPTY_BATCH_MESSAGE, audioOutputFormats, FFMPEG_FORMAT, AUDIO_MIME } from '../constants';
import { createBatchFileId, formatBytes } from '../utils/fileUtils';
import { DropZone } from './DropZone';

const getOpusMimeType = (): string | null => {
  for (const mime of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
};

export const AudioConverter = () => {
  const [ready, setReady] = useState(false);
  const [outputType, setOutputType] = useState<AudioFormat>(audioOutputFormats[0]);
  const [converting, setConverting] = useState(false);
  const [files, setFiles] = useState<AudioBatchFile[]>([]);

  const ffmpegRef = useRef<FFmpeg | null>(null);

  const loadFFmpeg = async () => {
    const ffmpeg = new FFmpeg();
    const baseURL = '/ffmpeg';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      classWorkerURL: '/ffmpeg/worker.js',
    });
    ffmpegRef.current = ffmpeg;
    setReady(true);
  };

  React.useEffect(() => { loadFFmpeg(); }, []);

  const updateFile = useCallback((id: string, patch: Partial<AudioBatchFile>) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));
  }, []);

  const getErrorMessage = (error: unknown) => {
    return error instanceof Error ? error.message : 'Failed';
  };

  const convertWithMediaRecorder = async (
    file: File,
    onProgress: (p: number) => void
  ): Promise<Blob> => {
    const opusMime = getOpusMimeType();
    if (!opusMime) throw new Error('MediaRecorder Opus not supported.');
    const ab = await file.arrayBuffer();
    const audioCtx = new AudioContext();
    const audioBuffer = await audioCtx.decodeAudioData(ab);
    const offCtx = new OfflineAudioContext(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
    const src = offCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(offCtx.destination);
    src.start();
    const rendered = await offCtx.startRendering();
    await audioCtx.close();

    const streamCtx = new AudioContext({ sampleRate: 48000 });
    const dest = streamCtx.createMediaStreamDestination();
    const streamSrc = streamCtx.createBufferSource();
    const targetBuf = streamCtx.createBuffer(
      rendered.numberOfChannels,
      Math.ceil(rendered.length * 48000 / rendered.sampleRate),
      48000,
    );
    for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
      const s = rendered.getChannelData(ch);
      const d = targetBuf.getChannelData(ch);
      const ratio = rendered.sampleRate / 48000;
      for (let i = 0; i < d.length; i++) {
        const si = i * ratio;
        const lo = Math.floor(si), hi = Math.min(lo + 1, s.length - 1);
        d[i] = s[lo]! * (1 - (si - lo)) + s[hi]! * (si - lo);
      }
    }
    streamSrc.buffer = targetBuf;
    streamSrc.connect(dest);
    const recorder = new MediaRecorder(dest.stream, { mimeType: opusMime, audioBitsPerSecond: 128000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    return new Promise((resolve, reject) => {
      recorder.onstop = () => {
        streamCtx.close();
        const blob = new Blob(chunks, { type: opusMime });
        if (blob.size === 0) {
          reject(new Error('Empty output'));
          return;
        }

        resolve(blob);
      };
      recorder.onerror = e => { streamCtx.close(); reject(new Error(`${e}`)); };
      recorder.start(100);
      streamSrc.start();
      const dur = targetBuf.duration * 1000;
      const t0 = Date.now();
      const iv = setInterval(() => onProgress(Math.min(99, Math.round((Date.now() - t0) / dur * 100))), 200);
      streamSrc.onended = () => { clearInterval(iv); setTimeout(() => recorder.stop(), 100); };
    });
  };

  const convertWithFFmpeg = async (
    file: File,
    inExt: string,
    outFmt: AudioFormat,
    id: string
  ): Promise<Blob> => {
    if (!ffmpegRef.current) throw new Error('FFmpeg not ready.');
    const inputName = `in_${id}.${inExt}`;
    const outputName = `out_${id}.${outFmt.ext}`;
    try {
      ffmpegRef.current.on('progress', ({ progress }) => {
        updateFile(id, { progress: Math.round(progress * 100) });
      });
      await ffmpegRef.current.writeFile(inputName, await fetchFile(file));
      const args = ['-i', inputName, '-vn', '-map_metadata', '-1', '-c:a', outFmt.ffmpegCodec];
      if (outFmt.sampleRate) args.push('-ar', String(outFmt.sampleRate));
      if (outFmt.id === 'amr') {
        args.push('-ac', '1', '-b:a', '12.2k');
      } else {
        if (outFmt.id !== 'wav' && outFmt.id !== 'alac' && outFmt.id !== 'aifc') args.push('-b:a', '128k');
        args.push('-ac', '2');
      }
      const fmt = FFMPEG_FORMAT[outFmt.id];
      if (fmt) args.push('-f', fmt);
      args.push('-y', outputName);
      await ffmpegRef.current.exec(args);
      const data = await ffmpegRef.current.readFile(outputName);
      const blob = new Blob([new Uint8Array(data as unknown as ArrayBuffer)], {
        type: AUDIO_MIME[outFmt.id] ?? 'audio/mpeg',
      });
      if (blob.size === 0) throw new Error('Output is empty.');
      return blob;
    } finally {
      try { await ffmpegRef.current?.deleteFile(inputName); } catch { /* ignore cleanup errors */ }
      try { await ffmpegRef.current?.deleteFile(outputName); } catch { /* ignore cleanup errors */ }
    }
  };

  const convertSingle = async (bf: AudioBatchFile, outFmt: AudioFormat) => {
    updateFile(bf.id, { status: 'converting', progress: 0 });
    try {
      const inExt = bf.file.name.split('.').pop()?.toLowerCase() ?? 'mp3';
      let blob: Blob;
      if (outFmt.id === 'opus') {
        blob = await convertWithMediaRecorder(bf.file, p => updateFile(bf.id, { progress: p }));
      } else {
        blob = await convertWithFFmpeg(bf.file, inExt, outFmt, bf.id);
      }
      const url = URL.createObjectURL(blob);
      updateFile(bf.id, { status: 'done', progress: 100, resultUrl: url, resultSize: blob.size });
    } catch (error: unknown) {
      updateFile(bf.id, { status: 'error', error: getErrorMessage(error) });
    }
  };
  const convertAll = async () => {
    const pending = files.filter(f => f.status === 'waiting' || f.status === 'error');
    if (!pending.length) return;
    setConverting(true);
    // Audio: toate simultan
    await Promise.all(pending.map(f => convertSingle(f, outputType)));
    setConverting(false);
  };

  const downloadAll = () => {
    files.filter(f => f.resultUrl).forEach((f, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = f.resultUrl!;
        const base = f.file.name.replace(/\.[^.]+$/, '');
        a.download = `${base}.${outputType.ext}`;
        a.click();
      }, i * 200);
    });
  };

  const clearAll = () => {
    files.forEach(f => { if (f.resultUrl) URL.revokeObjectURL(f.resultUrl); });
    setFiles([]);
  };

  const removeFile = (id: string) => {
    setFiles(prev => {
      const f = prev.find(x => x.id === id);
      if (f?.resultUrl) URL.revokeObjectURL(f.resultUrl);
      return prev.filter(x => x.id !== id);
    });
  };

  const doneCount = files.filter(f => f.status === 'done').length;
  const pendingCount = files.filter(f => f.status === 'waiting' || f.status === 'error').length;

  const statusLabel: Record<AudioBatchFile['status'], string> = {
    waiting: 'waiting', converting: 'converting...', done: 'done', error: 'error',
  };

  return (
    <div className="card">
      <div className="status-row">
        <div className={`status-dot ${ready ? 'status-dot--ready' : 'status-dot--loading'}`} />
        <span className="status-text">{ready ? 'FFmpeg ready' : 'Loading FFmpeg...'}</span>
      </div>

      <div className="format-row">
        <div style={{ gridColumn: '1 / -1' }}>
          <label className="label">Output format</label>
          <select className="select" value={outputType.id}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              setOutputType(audioOutputFormats.find(f => f.id === e.target.value)!);
            }} disabled={converting}>
            {audioOutputFormats.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="label">Add files</label>
        <DropZone
          accept={AUDIO_DROPZONE_ACCEPT}
          multiple disabled={converting}
          hint={AUDIO_DROPZONE_HINT}
          onFiles={files => {
            const newFiles: AudioBatchFile[] = files.map(f => ({
              id: createBatchFileId(),
              file: f, status: 'waiting', progress: 0,
              resultUrl: null, resultSize: null, error: null, outputExt: outputType.ext,
            }));
            setFiles(prev => [...prev, ...newFiles]);
          }}
        />
      </div>

      {files.length > 0 && (
        <div className="batch-file-list">
          {files.map(f => (
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
                {f.status === 'error' ? f.error?.slice(0, 20) ?? 'error' : statusLabel[f.status]}
              </div>
              {f.resultUrl && (
                <a href={f.resultUrl}
                  download={`${f.file.name.replace(/\.[^.]+$/, '')}.${outputType.ext}`}
                  className="batch-download-btn" style={{ padding: '4px 10px', fontSize: '11px' }}>
                  Save
                </a>
              )}
              {!converting && (
                <button onClick={() => removeFile(f.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#BBBBBB', fontSize: '14px', padding: '0 2px' }}>
                  x
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button className="btn-primary" style={{ flex: 1 }}
            onClick={convertAll} disabled={converting || !ready || pendingCount === 0}>
            {converting ? 'Converting...' : `Convert ${pendingCount} file${pendingCount !== 1 ? 's' : ''}`}
          </button>
          {doneCount > 0 && (
            <button className="batch-download-btn" onClick={downloadAll}>
              Save all ({doneCount})
            </button>
          )}
          <button className="btn-ghost" onClick={clearAll} disabled={converting}>Clear</button>
        </div>
      )}

      {files.length === 0 && (
        <p style={{ margin: 0, fontSize: '13px', color: '#BBBBBB', textAlign: 'center', padding: '8px 0' }}>
          {EMPTY_BATCH_MESSAGE}
        </p>
      )}
    </div>
  );
};
