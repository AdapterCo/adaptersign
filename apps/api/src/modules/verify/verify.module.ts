import { Controller, Get, Module, Param, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { Public } from '../../common/auth/decorators';
import { clientInfo } from '../../common/http/client-info';
import { RateLimit } from '../../common/rate-limit/rate-limit';
import { VerifyService } from './verify.service';

const MAX_UPLOAD = Number(process.env.UPLOAD_MAX_BYTES ?? 20 * 1024 * 1024);

@ApiTags('verify')
@Public()
@RateLimit('verify')
@Controller('verify')
export class VerifyController {
  constructor(private readonly verify: VerifyService) {}

  @Get(':code')
  @ApiOperation({ summary: 'Valida pelo código público (ex.: ADP-8F7K-29QM-X82P)' })
  byCode(@Param('code') code: string, @Req() req: Request) {
    return this.verify.byCode(code, clientInfo(req));
  }

  @Post('file')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: 'Valida um arquivo: calcula SHA-256 e procura correspondência' })
  byFile(@UploadedFile() file: { buffer: Buffer } | undefined, @Req() req: Request) {
    return this.verify.byFile(file?.buffer, clientInfo(req));
  }
}

@Module({ controllers: [VerifyController], providers: [VerifyService] })
export class VerifyModule {}
