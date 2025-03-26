import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { config } from 'dotenv';

// .env 파일 로딩
config();

console.log(process.env.NODE_ENV);

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new IoAdapter(app));
  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`✅ WebSocket Server running on port ${port}`);
}

bootstrap();