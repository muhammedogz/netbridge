import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT || 3210);
  await app.listen(port);
  console.log(`nestjs example listening on http://localhost:${port}`);
}
bootstrap();
