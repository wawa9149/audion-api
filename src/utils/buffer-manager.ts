// src/utils/buffer-manager.ts
export class BufferManager {
  private buffer: Buffer = Buffer.alloc(0);
  private baseChunk = 0;
  private readonly chunkSize = 1600; // 16kHz * 0.1s

  append(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  readRange(start: number, end: number): Buffer {
    const startByte = (start - this.baseChunk) * this.chunkSize * 2;
    const endByte = (end - this.baseChunk) * this.chunkSize * 2;
    return Buffer.from(this.buffer.slice(startByte, endByte));
  }

  truncateUntil(chunk: number) {
    const byteOffset = (chunk - this.baseChunk) * this.chunkSize * 2;
    this.buffer = this.buffer.slice(byteOffset);
    this.baseChunk = chunk;
  }

  reset() {
    this.buffer = Buffer.alloc(0);
    this.baseChunk = 0;
  }

  readAll(): Buffer {
    return this.buffer;
  }
}
