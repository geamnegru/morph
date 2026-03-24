export class WorkerPool {
  private workers: Worker[] = [];
  private queue: Array<() => void> = [];
  private busy: Set<number> = new Set();

  constructor(size: number, workerFactory: () => Worker) {
    for (let i = 0; i < size; i++) {
      this.workers.push(workerFactory());
    }
  }

  run(
    blob: Blob,
    id: string,
    mimeOut: string,
    quality: number,
    onProgress: (p: number) => void
  ): Promise<{ resultBlob: Blob; resultSize: number }> {
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const idx = this.workers.findIndex((_, i) => !this.busy.has(i));
        if (idx === -1) {
          this.queue.push(attempt);
          return;
        }
        this.busy.add(idx);
        const worker = this.workers[idx];

        const handler = (e: MessageEvent) => {
          const msg = e.data;
          if (msg.id !== id) return;
          if (msg.progress !== undefined && msg.resultBlob === undefined) {
            onProgress(msg.progress);
            return;
          }
          worker.removeEventListener('message', handler);
          this.busy.delete(idx);
          if (this.queue.length > 0) this.queue.shift()!();
          if (msg.error) reject(new Error(msg.error));
          else resolve({ resultBlob: msg.resultBlob, resultSize: msg.resultSize });
        };

        worker.addEventListener('message', handler);
        worker.postMessage({ id, blob, mimeOut, quality });
      };
      attempt();
    });
  }

  terminate() {
    this.workers.forEach(w => w.terminate());
    this.workers = [];
    this.queue = [];
    this.busy.clear();
  }
}