import { Controller, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { GrpcMethod, GrpcStreamMethod } from '@nestjs/microservices';
import { SohriService } from './sohri.service';

interface EventRequest {
  event: number; // TURN_START, TURN_PAUSE, TURN_RESUME, TURN_END
}

interface EventResponse {
  turnId: string;
}

interface AudioStreamRequest {
  turnId: string;
  content: Buffer;
  ttsStatus: number;
}

enum AudioStreamResponseStatus {
  PAUSE = 0,
  END = 1,
  SPEECH = 2,
  TIMEOUT = 8,
  ERROR = 9,
}

interface AudioStreamResponse {
  status: AudioStreamResponseStatus;
}

interface DeliveryResponse {
  action: number; // SPEECH_TO_TEXT (0)
  turnId: string;
  speech: {
    text: string;
    audio: {
      duration: number;
      sampleRate: number;
      channels: number;
    };
  };
}

@Controller()
export class SohriController {
  private readonly logger = new Logger(SohriController.name);

  constructor(private readonly sohriService: SohriService) { }

  // Unary RPC: process event requests (TURN events)
  @GrpcMethod('CareCallEventService', 'eventRequest')
  eventRequest(data: EventRequest, metadata: any): EventResponse {
    const turnId = this.sohriService.handleEvent(data);
    return { turnId };
  }

  // Bidirectional streaming RPC: process incoming audio stream
  @GrpcStreamMethod('CareCallEventService', 'audioStream')
  audioStream(data$: Observable<AudioStreamRequest>, metadata: any): Observable<AudioStreamResponse> {
    data$.subscribe({
      next: async (data: AudioStreamRequest) => {
        await this.sohriService.processAudioBuffer(data);
      },
      error: (err) => {
        this.logger.error('audioStream error', err);
      },
      complete: () => {
        this.logger.log('audioStream complete');
      },
    });
    return this.sohriService.getAudioResponseStream();
  }

  // Server streaming RPC: deliver responses (if needed)
  @GrpcStreamMethod('CareCallEventService', 'deliveryStream')
  deliveryStream(data$: Observable<any>, metadata: any): Observable<DeliveryResponse> {
    return this.sohriService.getDeliveryStream();
  }
}
