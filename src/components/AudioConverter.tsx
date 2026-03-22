import React, { useState, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import type { AudioFormat } from '../types';
import { audioInputFormats, audioOutputFormats } from '../constants';

export const AudioConverter = () => {
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [inputType, setInputType] = useState<AudioFormat>(audioInputFormats[0]);
  const [outputType, setOutputType] = useState<AudioFormat>(audioOutputFormats[0]);
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [fileInfo, setFileInfo] = useState('');

  const ffmpegRef = useRef<FFmpeg | null>(null);
  const inputFileRef = useRef<HTMLInputElement>(null);

  const loadFFmpeg = async () => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const ffmpeg = new FFmpeg();
    ffmpeg.on('progress', ({ progress }) => setProgress(progress * 100));
    await ffmpeg.load();
    ffmpegRef.current = ffmpeg;
    setReady(true);
  };

  const convertAudio = async () => {
    const file = inputFileRef.current?.files?.[0];
    if (!file || !ffmpegRef.current) return;
    setConverting(true);
    setProgress(0);
    setResult(null);
    try {
      const inputName = `input.${inputType.ext}`;
      const outputName = `output.ogg`;
      await ffmpegRef.current.writeFile(inputName, await fetchFile(file));
      await ffmpegRef.current.exec([
        '-i', inputName, '-vn', '-c:a', 'libopus',
        '-ar', '24000', '-b:a', '128k', '-ac', '2', '-f', 'ogg', '-y', outputName,
      ]);
      const data = await ffmpegRef.current.readFile(outputName);
      const blob = new Blob([new Uint8Array(data as unknown as ArrayBuffer)], {
        type: 'audio/ogg; codecs=opus',
      });
      setResult(URL.createObjectURL(blob));
      setFileInfo(`${Math.round(blob.size / 1024)} KB · Opus 128 kbps`);
    } catch (e) {
      console.error(e);
    } finally {
      setConverting(false);
      setProgress(0);
    }
  };

  const download = () => {
    if (!result) return;
    const a = document.createElement('a');
    a.href = result;
    a.download = `audio-${Date.now()}.${outputType.ext}`;
    a.click();
  };

  const clear = () => {
    setResult(null);
    setFileInfo('');
    if (inputFileRef.current) inputFileRef.current.value = '';
  };

  React.useEffect(() => { loadFFmpeg(); }, []);

  return (
    <div className="card">
      <div className="status-row">
        <div className={`status-dot ${ready ? 'status-dot--ready' : 'status-dot--loading'}`} />
        <span className="status-text">{ready ? 'FFmpeg ready' : 'Loading FFmpeg…'}</span>
      </div>

      <div className="format-row">
        <div>
          <label className="label">From</label>
          <select className="select" value={inputType.id}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              setInputType(audioInputFormats.find(f => f.id === e.target.value)!);
              setResult(null);
            }} disabled={converting}>
            {audioInputFormats.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div className="format-arrow">→</div>
        <div>
          <label className="label">To</label>
          <select className="select" value={outputType.id}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              setOutputType(audioOutputFormats.find(f => f.id === e.target.value)!);
              setResult(null);
            }} disabled={converting}>
            {audioOutputFormats.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="label">File</label>
        <input ref={inputFileRef} type="file" className="file-input"
          accept={audioInputFormats.map(f => `.${f.ext}`).join(',')}
          disabled={converting} />
      </div>

      <button className="btn-primary" onClick={convertAudio} disabled={converting || !ready}>
        {converting ? `Converting… ${Math.round(progress)}%` : 'Convert'}
      </button>

      {converting && (
        <div className="progress-wrap">
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
      )}

      {result && (
        <div className="result-section">
          <div className="badge badge--success">Done — {fileInfo}</div>
          <audio controls src={result} className="result-audio" />
          <div className="btn-row">
            <button onClick={download} className="btn-download">Download</button>
            <button onClick={clear} className="btn-ghost">Convert another</button>
          </div>
        </div>
      )}
    </div>
  );
};
