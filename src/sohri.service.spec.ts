// src/sohri.service.spec.ts
const io = require('socket.io-client');
import * as fs from 'fs';
import * as path from 'path';
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || '/usr/bin/ffmpeg');

const SOCKET_URL = 'ws://localhost:3000';
const SOCKET_PATH = '/ws';
const chunkSize = 3200;
const clientsCount = 32;

describe(`동시 연결 테스트(${clientsCount} clients)`, () => {
  const audioFile = path.join(__dirname, 'fixtures', 'test-audio.flac');

  const results: any[] = []; // 모든 클라이언트 결과 모음

  it(`should handle ${clientsCount} concurrent clients`, async () => {
    // 1) 소켓 4개 생성
    const clientPromises = Array.from({ length: clientsCount }, (_, i) =>
      runSingleClientTest(i, audioFile)
    );

    // 2) 모두 완료될 때까지 대기
    const allClientResults = await Promise.all(clientPromises);

    // 3) 검증
    expect(allClientResults).toHaveLength(clientsCount);
    // 원하는 대로 검증 로직...
    console.log('✅ clients all finished', allClientResults);
  }, 120000); // 타임아웃을 넉넉히(예: 60초)

});


// ─────────────────────────────────────────────────────────────────────────────
// 각 클라이언트별 로직
// ─────────────────────────────────────────────────────────────────────────────
async function runSingleClientTest(clientIndex: number, audioPath: string): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    const socket = io(SOCKET_URL, {
      path: SOCKET_PATH,
      transports: ['websocket'],
    });

    let localTurnId = '';
    let allResponses: any[] = [];

    socket.on('connect', () => {
      console.log(`[Client#${clientIndex}] Socket connected!`);
      // turn 시작 요청
      socket.emit('eventRequest', { event: 10 });
    });

    socket.on('disconnect', () => {
      console.log(`[Client#${clientIndex}] Socket disconnected`);
    });

    socket.on('connect_error', (err: any) => {
      console.error(`[Client#${clientIndex}] connect_error:`, err);
      reject(err);
    });

    // turnReady, delivery 등 이벤트 등록
    socket.on('turnReady', async (data: { sessionId: string }) => {
      console.log('🎙️ TURN_READY:', data.sessionId);
      // 여기서 sessionId 받는 로직이 서버마다 다를 수 있음
      if (data?.sessionId) {
        localTurnId = data.sessionId;
        console.log(`[Client#${clientIndex}] TURN_START: ${localTurnId}`);

        // 오디오 파일을 PCM으로 추출 후 청크 전송
        try {
          const pcmBuffer = await extractAudioSamples(audioPath);
          await sendChunks(pcmBuffer, socket, localTurnId, clientIndex);
        } catch (err) {
          console.error(`[Client#${clientIndex}] Error during audio processing:`, err);
          reject(err);
        }
      }
    });

    // delivery 수신
    socket.on('delivery', (msg: any) => {
      console.log(`[Client#${clientIndex}] delivery:`, msg);
      if (!msg.result.speech.text) {
        console.error(`[Client#${clientIndex}] Invalid delivery message:`, msg);
      }

      allResponses.push(msg.result.speech.text);
    });

    socket.on('deliveryEnd', (msg: any) => {
      console.log(`[Client#${clientIndex}] deliveryEnd:`, msg);
      allResponses.push(msg);
      socket.disconnect();
      resolve({ clientIndex, sessionId: localTurnId, responses: allResponses });
      // 여기서도 resolve 처리 가능
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ffmpeg: FLAC -> PCM 변환 함수
// ─────────────────────────────────────────────────────────────────────────────
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
      .on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PCM 청크 전송 함수
// ─────────────────────────────────────────────────────────────────────────────
async function sendChunks(buffer: Buffer, socket: any, sessionId: string, clientIndex: number): Promise<void> {
  const totalChunks = Math.ceil(buffer.length / chunkSize);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min((i + 1) * chunkSize, buffer.length);
    const chunk = buffer.subarray(start, end);

    socket.emit('audioStream', {
      type: 'audioStream',
      sessionId,
      content: chunk.toString('base64'),
      ttsStatus: 0,
    });

    console.log(`[Client#${clientIndex}] 📤 청크 전송 ${i + 1}/${totalChunks}`);
    await delay(100);
  }

  // 전송 후 event=13(턴 종료) 요청
  console.log(`[Client#${clientIndex}] 🛑 모든 청크 전송 완료. TURN_END`);
  socket.emit('eventRequest', { event: 13, sessionId });
}

function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}
