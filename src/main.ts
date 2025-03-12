import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.GRPC,
    options: {
      package: 'stt',
      protoPath: join(__dirname, 'modules/stt/stt.proto'),
      url: '0.0.0.0:50051',
    },
  });

  await app.listen();
  console.log('gRPC Microservice is running on: 0.0.0.0:50051');
}
bootstrap();
