import { useRef, useState, useCallback } from 'react';
import type { DragEvent, ChangeEvent, ReactNode } from 'react';

interface DropZoneProps {
  onFiles: (files: File[]) => void;
  accept?: string;       // e.g. ".mp4,.webm"
  multiple?: boolean;
  disabled?: boolean;
  hint?: string;         // text sub "Drop files here"
  children?: ReactNode;  // override complet al conținutului
}

export const DropZone = ({
  onFiles, accept, multiple = true, disabled = false, hint, children,
}: DropZoneProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.items.length > 0) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;
    if (disabled) return;
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length) onFiles(multiple ? dropped : [dropped[0]!]);
  }, [disabled, multiple, onFiles]);

  const handleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    if (selected.length) onFiles(selected);
    // reset input value so same file can be re-added
    e.target.value = '';
  }, [onFiles]);

  return (
    <div
      className={[
        'drop-zone',
        isDragging ? 'drop-zone--active' : '',
        disabled ? 'drop-zone--disabled' : '',
      ].join(' ')}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={handleChange}
      />
      {children ?? (
        <>
          <span className="drop-zone-icon">{isDragging ? '📂' : '⊕'}</span>
          <span className="drop-zone-text">
            {isDragging ? 'Drop to add' : 'Click or drag files here'}
          </span>
          {hint && <span className="drop-zone-hint">{hint}</span>}
        </>
      )}
    </div>
  );
};
