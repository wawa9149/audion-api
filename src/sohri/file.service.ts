// src/sohri/file.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  prepareTempFile(turnId: string): string {
    const tempDir = process.env.TEMP_DIR || '/tmp';
    const filePath = path.join(tempDir, `${turnId}.pcm`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.logger.log(`Prepared file: ${filePath}`);
    return filePath;
  }

  appendToFile(filePath: string, data: Buffer) {
    fs.appendFileSync(filePath, data);
    this.logger.log(`Appended ${data.length} bytes to ${filePath}`);
  }
}