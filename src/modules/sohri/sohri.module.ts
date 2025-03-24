import {Module} from '@nestjs/common';
import {SohriService} from './sohri.service';
import {SohriController} from './sohri.controller';

@Module({
  controllers: [SohriController],
  providers: [SohriService],
})
export class SohriModule {}
