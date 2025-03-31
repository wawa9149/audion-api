// src/sohri.service.spec.ts
const io = require('socket.io-client');
import * as fs from 'fs';
import * as path from 'path';
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || '/usr/bin/ffmpeg');

const SOCKET_URL = 'ws://localhost:3000';
const SOCKET_PATH = '/ws';
const chunkSize = 3200;
let turnId = '';
const allResponses: any[] = [];

describe('Socket.IO 음성 인식 테스트', () => {
  const audioFile = path.join(__dirname, 'fixtures', 'test-audio.flac');

  it('should send audio chunks and receive delivery', async () => {
    const socket = io('ws://localhost:3000', {
      path: '/ws',
      transports: ['websocket'],
    });

    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => {
        console.log('✅ Socket.IO 연결됨');
        socket.emit('eventRequest', { event: 10 });
      });

      socket.on('eventResponse', async (msg) => {
        turnId = msg.turnId;
        console.log('🎙️ TURN 시작:', turnId);
        const pcmBuffer = await extractAudioSamples(audioFile);
        await sendChunks(pcmBuffer, socket);

        console.log('🛑 TURN_END 전송');
        socket.emit('eventRequest', { event: 13 });

        // 여기서 delivery 응답을 기다림
      });

      socket.on('delivery', (msg) => {
        console.log(`📝 인식 결과: ${JSON.stringify(msg, null, 2)}`);
        allResponses.push(msg);
        resolve(); // 🔑 delivery가 오면 테스트 종료
      });

      socket.on('connect_error', (err) => {
        console.error('❌ 연결 오류:', err);
        reject(err);
      });

      socket.on('disconnect', () => {
        console.log('🔌 연결 종료');
      });
    });

    expect(allResponses.length).toBeGreaterThan(0);
  }, 20000);
  afterAll(() => {
    // 소켓 연결 종료
    console.log('🛑 테스트 완료. 소켓 연결 종료');
  });
});


function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractAudioSamples(filePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    ffmpeg(filePath)
      .format('s16le')
      .audioChannels(1)
      .audioFrequency(16000)
      .on('error', (err: any) => reject(err))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .pipe()
      .on('data', (chunk: Buffer) => chunks.push(chunk));
  });
}

function sendChunks(buffer: Buffer, socket: any): Promise<void> {
  return new Promise(async (resolve) => {
    const totalChunks = Math.ceil(buffer.length / chunkSize);
    let currentChunk = 0;

    while (currentChunk < totalChunks) {
      const start = currentChunk * chunkSize;
      const end = Math.min((currentChunk + 1) * chunkSize, buffer.length);
      const chunk = buffer.subarray(start, end);

      socket.emit('audioStream', {
        type: 'audioStream',
        turnId,
        content: chunk.toString('base64'),
        ttsStatus: 0,
      });

      console.log(`📤 청크 전송 ${currentChunk + 1}/${totalChunks}`);
      currentChunk++;
      await delay(250);
    }

    // ✅ 전송 완료 후 TURN_END 전송
    console.log('🛑 모든 청크 전송 완료. TURN_END 전송');
    socket.emit('eventRequest', { event: 13 });

    resolve(); // ✅ 완료 알림
  });
}
