import { useState, useRef, useEffect, useCallback } from 'react';
import type { ChangeEvent } from 'react';
import type { TextBatchFile, TextFormat } from '../types';
import { EMPTY_BATCH_MESSAGE, textInputFormats, textOutputFormats } from '../constants';
import { createBatchFileId, formatBytes, triggerDownload } from '../utils/fileUtils';
import { DropZone } from './DropZone';

export const TextConverter = () => {
  const [inputType,  setInputType]  = useState<TextFormat>(textInputFormats[0]);
  const [outputType, setOutputType] = useState<TextFormat>(textOutputFormats[1]);
  const [converting, setConverting] = useState(false);
  const [files, setFiles] = useState<TextBatchFile[]>([]);
  const workerRef = useRef<Worker | null>(null);
  // Map id → { resolve, reject } pentru promise-uri în așteptare
  const pendingRef = useRef<Map<string, { resolve: (v: { buf: ArrayBuffer; outMime: string }) => void; reject: (e: Error) => void }>>(new Map());

  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/textWorker.ts', import.meta.url), { type: 'module' }
    );
    worker.onmessage = (e) => {
      const { id, buf, outMime, error } = e.data;
      const pending = pendingRef.current.get(id);
      if (!pending) return;
      pendingRef.current.delete(id);
      if (error) pending.reject(new Error(error));
      else pending.resolve({ buf, outMime });
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  const updateFile = useCallback((id: string, patch: Partial<TextBatchFile>) => {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));
  }, []);

  const getErrorMessage = (error: unknown) => {
    return error instanceof Error ? error.message : 'Failed';
  };

  const convertSingle = async (bf: TextBatchFile, inFmt: TextFormat, outFmt: TextFormat) => {
    if (!workerRef.current) return;
    updateFile(bf.id, { status: 'converting' });
    try {
      const text = await bf.file.text();
      const { buf, outMime } = await new Promise<{ buf: ArrayBuffer; outMime: string }>((resolve, reject) => {
        pendingRef.current.set(bf.id, { resolve, reject });
        workerRef.current!.postMessage({ id: bf.id, text, inFmt: inFmt.id, outFmt: outFmt.id, outMime: outFmt.mime });
      });
      const blob = new Blob([buf], { type: outMime });
      updateFile(bf.id, { status: 'done', resultUrl: URL.createObjectURL(blob), resultSize: blob.size });
    } catch (error: unknown) {
      updateFile(bf.id, { status: 'error', error: getErrorMessage(error) });
    }
  };

  const convertAll = async () => {
    const pending = files.filter(f => f.status === 'waiting' || f.status === 'error');
    if (!pending.length) return;
    setConverting(true);
    // Text e rapid — Promise.all e ok, worker serializează oricum
    await Promise.all(pending.map(f => convertSingle(f, inputType, outputType)));
    setConverting(false);
  };

  const downloadAll = () => {
    files.filter(f => f.resultUrl).forEach((f, i) => {
      setTimeout(() => triggerDownload(
        f.resultUrl!,
        `${f.file.name.replace(/\.[^.]+$/, '')}.${outputType.ext}`
      ), i * 80);
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
    const newFiles: TextBatchFile[] = incoming.map(f => ({
      id: createBatchFileId(),
      file: f, status: 'waiting', resultUrl: null, resultSize: null, error: null,
    }));
    setFiles(prev => [...prev, ...newFiles]);
  }, []);

  const doneCount    = files.filter(f => f.status === 'done').length;
  const pendingCount = files.filter(f => f.status === 'waiting' || f.status === 'error').length;

  return (
    <div className="card">
      <div className="format-row">
        <div>
          <label className="label">From</label>
          <select className="select" value={inputType.id}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              setInputType(textInputFormats.find(f => f.id === e.target.value)!)
            } disabled={converting}>
            {textInputFormats.map(f => <option key={f.id} value={f.id}>{f.name.toUpperCase()}</option>)}
          </select>
        </div>
        <div className="format-arrow">{'->'}</div>
        <div>
          <label className="label">To</label>
          <select className="select" value={outputType.id}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              setOutputType(textOutputFormats.find(f => f.id === e.target.value)!)
            } disabled={converting}>
            {textOutputFormats.map(f => <option key={f.id} value={f.id}>{f.name.toUpperCase()}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="label">Add files</label>
        <DropZone
          accept={inputType.accept}
          multiple disabled={converting}
          hint={`${inputType.name.toUpperCase()} files`}
          onFiles={addFiles}
        />
      </div>

      {files.length > 0 && (
        <div className="batch-file-list">
          {files.map(f => (
            <div key={f.id} className={`batch-file-item batch-file-item--${f.status}`}>
              <div className="batch-file-name" title={f.file.name}>{f.file.name}</div>
              <div className="batch-file-size">{formatBytes(f.file.size)}</div>
              {f.status === 'done' && f.resultSize !== null && (
                <div className="batch-file-size" style={{ color: '#16A34A' }}>
                  {'->'} {formatBytes(f.resultSize)}
                </div>
              )}
              <div className={`batch-file-status batch-file-status--${f.status}`}>
                {f.status === 'error' ? (f.error ?? 'error') : f.status}
              </div>
              {f.resultUrl && (
                <button className="batch-download-btn"
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
