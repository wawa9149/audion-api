import { Module } from '@nestjs/common';
import { AudioEncoderService } from './audio-encoder.service';

@Module({
  providers: [AudioEncoderService],
  exports: [AudioEncoderService], // 다른 모듈에서 사용 가능
})
export class AudioEncoderModule { }
