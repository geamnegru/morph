import { useCallback, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, ReactNode } from 'react';

interface DropZoneProps {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  hint?: string;
  children?: ReactNode;
}

export const DropZone = ({
  onFiles,
  accept,
  multiple = true,
  disabled = false,
  hint,
  children,
}: DropZoneProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounter.current += 1;

    if (event.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounter.current -= 1;

    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleDrop = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;

    if (disabled) {
      return;
    }

    const droppedFiles = Array.from(event.dataTransfer.files);
    if (droppedFiles.length > 0) {
      onFiles(multiple ? droppedFiles : [droppedFiles[0]!]);
    }
  }, [disabled, multiple, onFiles]);

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    if (selectedFiles.length > 0) {
      onFiles(selectedFiles);
    }

    event.target.value = '';
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
          <span className="drop-zone-icon">{isDragging ? '\u2193' : '+'}</span>
          <span className="drop-zone-text">
            {isDragging ? 'Drop to add' : 'Click or drag files here'}
          </span>
          {hint && <span className="drop-zone-hint">{hint}</span>}
        </>
      )}
    </div>
  );
};
