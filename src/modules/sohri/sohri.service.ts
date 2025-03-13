import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import * as WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';

enum AudioStreamResponseStatus {
  PAUSE = 0,
  END = 1,
  SPEECH = 2,
  TIMEOUT = 8,
  ERROR = 9,
}

@Injectable()
export class SohriService {
  private readonly logger = new Logger(SohriService.name);
  private currentTurnId: string = '';
  private wsClient: WebSocket | null = null;
  // Temporary file path to store incoming audio data.
  private tempFile: string = '';
  // Subject to emit audio responses received via WebSocket.
  private audioResponseSubject: Subject<{ status: AudioStreamResponseStatus }> = new Subject();
  // (Optional) For delivery stream responses.
  private deliverySubject: Subject<any> = new Subject();

  // Process event requests.
  handleEvent(eventRequest: { event: number }): string {
    // TURN_START: generate a new turnId, create temp file and establish WebSocket connection.
    if (eventRequest.event === 10) { // TURN_START
      this.currentTurnId = uuidv4();
      this.logger.log(`Turn started: ${this.currentTurnId}`);
      // Create temporary file path using a configured temp directory (or default '/tmp').
      const tempDir = process.env.TEMP_DIR || '/tmp';
      this.tempFile = path.join(tempDir, uuidv4());
      // Ensure the directory exists.
      const dir = path.dirname(this.tempFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        this.logger.log(`Directory created: ${dir}`);
      }
      // Establish WebSocket connection.
      this.createWebSocketClient(this.currentTurnId); // dialogId removed.
      return this.currentTurnId;
    } else if (eventRequest.event === 13) { // TURN_END
      this.logger.log(`Turn ended: ${this.currentTurnId}`);
      this.processTurnEnd();
      return this.currentTurnId;
    } else if (eventRequest.event === 11) { // TURN_PAUSE
      this.logger.log('Turn paused');
      return this.currentTurnId;
    } else if (eventRequest.event === 12) { // TURN_RESUME
      this.logger.log('Turn resumed');
      return this.currentTurnId;
    }
    return '';
  }

  // Create and connect the WebSocket client. (dialogId parameter removed)
  createWebSocketClient(turnId: string): void {
    // Replace with the actual external WebSocket URL.
    const wsUrl = 'ws://epd.mago52.com:9707/speech2text/chunk';
    this.wsClient = new WebSocket(wsUrl);
    this.wsClient.on('open', () => {
      this.logger.log('WebSocket connected');
    });
    this.wsClient.on('message', (message: WebSocket.Data) => {
      const msg = message.toString();
      this.logger.log(`WebSocket message: ${msg}`);
      let status: AudioStreamResponseStatus;
      switch (msg) {
        case 'WAITING':
          // For WAITING, do not emit any response.
          return;
        case 'TIMEOUT':
          status = AudioStreamResponseStatus.TIMEOUT;
          break;
        case 'SPEECH':
          status = AudioStreamResponseStatus.SPEECH;
          break;
        case 'PAUSE':
          status = AudioStreamResponseStatus.PAUSE;
          break;
        case 'END':
          status = AudioStreamResponseStatus.END;
          break;
        case 'MAX_TIMEOUT':
          status = AudioStreamResponseStatus.END;
          break;
        default:
          status = AudioStreamResponseStatus.ERROR;
      }
      this.audioResponseSubject.next({ status });
    });
    this.wsClient.on('close', (code, reason) => {
      this.logger.log(`WebSocket closed: code: ${code}, reason: ${reason}`);
    });
    this.wsClient.on('error', (err) => {
      this.logger.error('WebSocket error:', err.message);
      this.audioResponseSubject.next({ status: AudioStreamResponseStatus.ERROR });
    });
  }

  // Process the audio buffer:
  // 1. Append the received audio chunk to a temporary file.
  // 2. Prepend the TTS status to the chunk and send it via WebSocket.
  async processAudioBuffer(data: { turnId: string, content: Buffer, ttsStatus: number }): Promise<void> {
    // Append audio content to temporary file.
    fs.appendFile(this.tempFile, data.content, (err) => {
      if (err) {
        this.logger.error('Error writing to temp file:', err);
      } else {
        this.logger.log('Appended audio chunk to temp file');
      }
    });

    // Create a new buffer: first byte is ttsStatus, followed by the audio content.
    const ttsBuffer = Buffer.from([data.ttsStatus]);
    const bufferToSend = Buffer.concat([ttsBuffer, data.content]);

    this.logger.log(`Received audio chunk with TTS status: ${data.ttsStatus}`);
    this.logger.log(`Buffer size: ${bufferToSend.length}`);
    // this.logger.log(`Buffer data (JSON): ${JSON.stringify(bufferToSend.toJSON())}`);

    if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
      this.wsClient.send(bufferToSend);
      this.logger.log('Sent audio chunk with TTS status via WebSocket');
    } else {
      this.logger.error('WebSocket client is not connected');
    }
  }

  // Close the WebSocket connection on TURN_END.
  async processTurnEnd(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
      this.logger.log('WebSocket connection closed on TURN_END');
    }
    // Optionally, add further processing for the temporary file (e.g., conversion, upload).
  }

  // Return an observable for audio responses to be sent as AudioStreamResponse.
  getAudioResponseStream(): Observable<{ status: AudioStreamResponseStatus }> {
    return this.audioResponseSubject.asObservable();
  }

  // (Optional) For delivery stream responses if needed.
  getDeliveryStream(): Observable<any> {
    return this.deliverySubject.asObservable();
  }
}
