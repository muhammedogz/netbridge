import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AppController } from './app.controller';

@Module({
  imports: [HttpModule],
  controllers: [AppController],
})
export class AppModule {}
