import { Controller, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { STTService } from './stt.service';
import { GrpcStreamMethod } from '@nestjs/microservices';

// gRPC 요청/응답 인터페이스 타입 (프로토콜 정의에 맞게)
interface AudioRequest {
  audioChunk?: { audio: Buffer };
  pause?: { pause: boolean };
}

interface AudioResponse {
  text: string;
  confidence: number;
}

@Controller()
export class STTController {
  private readonly logger = new Logger(STTController.name);

  constructor(private readonly sttService: STTService) { }

  @GrpcStreamMethod('STTService', 'StreamAudio')
  streamAudio(data$: Observable<AudioRequest>, metadata: any): Observable<AudioResponse> {
    const responseSubject = new Subject<AudioResponse>();

    data$.subscribe({
      next: async (data) => {
        // 클라이언트가 오디오 청크를 보냈다면
        if (data.audioChunk) {
          // gRPC에서 전달받은 bytes는 Uint8Array 형태로 오므로 base64 인코딩하여 서비스로 전달
          const base64Audio = Buffer.from(data.audioChunk.audio).toString('base64');
          await this.sttService.processAudioBuffer({ audio: base64Audio });
        }
        // pause 이벤트가 왔다면, 누적된 오디오를 STT API로 처리 후 결과를 응답 스트림으로 전송
        else if (data.pause) {
          const result = await this.sttService.processPause();
          responseSubject.next(result);
        }
      },
      error: err => {
        this.logger.error('gRPC 스트림 에러', err);
        responseSubject.error(err);
      },
      complete: () => {
        responseSubject.complete();
      },
    });

    return responseSubject.asObservable();
  }
}
