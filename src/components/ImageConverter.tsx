import { useState, useRef, useEffect, useCallback } from 'react';
import type { ChangeEvent } from 'react';
import type { ImageBatchFile, ImageFormat } from '../types';
import { EMPTY_BATCH_MESSAGE, IMAGE_DROPZONE_ACCEPT, IMAGE_DROPZONE_HINT, imageOutputFormats, MIME_MAP, QUALITY_MAP } from '../constants';
import { createBatchFileId, formatBytes, triggerDownload } from '../utils/fileUtils';
import { DropZone } from './DropZone';
import { WorkerPool } from '../workers/workerPool';

const WORKER_POOL_SIZE = 4;
export const ImageConverter = () => {
  const [outputType, setOutputType] = useState<ImageFormat>(imageOutputFormats[2]);
  const [converting, setConverting] = useState(false);
  const [files, setFiles] = useState<ImageBatchFile[]>([]);
  const poolRef = useRef<WorkerPool | null>(null);

  useEffect(() => {
    poolRef.current = new WorkerPool(
      WORKER_POOL_SIZE,
      () => new Worker(new URL('../workers/imageWorker.ts', import.meta.url), { type: 'module' })
    );
    return () => { poolRef.current?.terminate(); };
  }, []);

  const updateFile = useCallback((id: string, patch: Partial<ImageBatchFile>) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));
  }, []);

  const getErrorMessage = (error: unknown) => {
    return error instanceof Error ? error.message : 'Failed';
  };

  const convertSingle = async (bf: ImageBatchFile, outFmt: ImageFormat): Promise<void> => {
    if (!poolRef.current) return;
    updateFile(bf.id, { status: 'converting', progress: 10 });
    try {
      const { resultBlob, resultSize } = await poolRef.current.run(
        bf.file,
        bf.id,
        MIME_MAP[outFmt.id] ?? 'image/webp',
        QUALITY_MAP[outFmt.id] ?? 0.88,
        (progress) => updateFile(bf.id, { progress })
      );
      const url = URL.createObjectURL(resultBlob);
      updateFile(bf.id, { status: 'done', progress: 100, resultUrl: url, resultSize });
    } catch (error: unknown) {
      updateFile(bf.id, { status: 'error', progress: 0, error: getErrorMessage(error) });
    }
  };

  const convertAll = async () => {
    const pending = files.filter(f => f.status === 'waiting' || f.status === 'error');
    if (!pending.length) return;
    setConverting(true);
    await Promise.all(pending.map(f => convertSingle(f, outputType)));
    setConverting(false);
  };

  const downloadAll = () => {
    files.filter(f => f.resultUrl).forEach((f, i) => {
      setTimeout(() => {
        triggerDownload(
          f.resultUrl!,
          `${f.file.name.replace(/\.[^.]+$/, '')}.${outputType.ext}`
        );
      }, i * 80);
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

  const addFiles = useCallback((incoming: File[]) => {
    const newFiles: ImageBatchFile[] = incoming.map(f => ({
      id: createBatchFileId(),
      file: f, status: 'waiting', progress: 0,
      resultUrl: null, resultSize: null, error: null,
    }));
    setFiles(prev => [...prev, ...newFiles]);
  }, []);

  const doneCount = files.filter(f => f.status === 'done').length;
  const pendingCount = files.filter(f => f.status === 'waiting' || f.status === 'error').length;

  return (
    <div className="card">
      <div className="format-row">
        <div style={{ gridColumn: '1 / -1' }}>
          <label className="label">Output format</label>
          <select className="select" value={outputType.id}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              setOutputType(imageOutputFormats.find(f => f.id === e.target.value)!)
            } disabled={converting}>
            {imageOutputFormats.map(f => <option key={f.id} value={f.id}>{f.name.toUpperCase()}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="label">Add files</label>
        <DropZone
          accept={IMAGE_DROPZONE_ACCEPT}
          multiple disabled={converting}
          hint={IMAGE_DROPZONE_HINT}
          onFiles={addFiles}
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
                {f.status === 'error' ? (f.error ?? 'error') : f.status}
              </div>
              {f.resultUrl && (
                <button
                  className="batch-download-btn"
                  style={{ padding: '4px 10px', fontSize: '11px' }}
                  onClick={() => triggerDownload(f.resultUrl!, `${f.file.name.replace(/\.[^.]+$/, '')}.${outputType.ext}`)}>
                  Save
                </button>
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
            onClick={convertAll} disabled={converting || pendingCount === 0}>
            {converting
              ? `Converting... (${doneCount}/${doneCount + pendingCount})`
              : `Convert ${pendingCount} file${pendingCount !== 1 ? 's' : ''}`}
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
