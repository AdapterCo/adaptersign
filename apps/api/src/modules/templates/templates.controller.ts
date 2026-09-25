import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { CurrentAuth, RequirePermission } from '../../common/auth/decorators';
import { Permission, type AuthContext } from '../../common/auth/auth-context';
import { clientInfo } from '../../common/http/client-info';
import { RateLimit } from '../../common/rate-limit/rate-limit';
import type { UploadedPdf } from '../documents/documents.service';
import { TemplatesService } from './templates.service';
import { UpsertTemplateDto } from './templates.dto';

// Limite também validado no serviço; aqui evita bufferizar arquivos acima do permitido.
const MAX_UPLOAD = Number(process.env.UPLOAD_MAX_BYTES ?? 20 * 1024 * 1024);
const uploadInterceptor = FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 1, fields: 2 } });

@ApiTags('templates')
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @RequirePermission(Permission.TEMPLATE_READ)
  @Get()
  list(@CurrentAuth() auth: AuthContext) {
    return this.templates.list(auth);
  }

  @RequirePermission(Permission.TEMPLATE_WRITE)
  @Post()
  @ApiOperation({ summary: 'Cria modelo (papéis e regras de âncoras)' })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: UpsertTemplateDto, @Req() req: Request) {
    return this.templates.create(auth, dto, clientInfo(req));
  }

  @RequirePermission(Permission.TEMPLATE_READ)
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.get(auth, id);
  }

  @RequirePermission(Permission.TEMPLATE_WRITE)
  @Put(':id')
  @ApiOperation({ summary: 'Altera o modelo (os papéis são substituídos; envelopes existentes não mudam)' })
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpsertTemplateDto, @Req() req: Request) {
    return this.templates.update(auth, id, dto, clientInfo(req));
  }

  @RequirePermission(Permission.TEMPLATE_WRITE)
  @HttpCode(204)
  @Delete(':id')
  @ApiOperation({ summary: 'Arquiva o modelo' })
  async archive(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    await this.templates.archive(auth, id, clientInfo(req));
  }

  @RequirePermission(Permission.TEMPLATE_READ)
  @RateLimit('upload')
  @HttpCode(200)
  @Post(':id/test')
  @UseInterceptors(uploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({ summary: 'Testa um PDF de exemplo: âncoras encontradas e campos que seriam criados (nada é armazenado)' })
  test(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: UploadedPdf | undefined) {
    return this.templates.test(auth, id, file);
  }
}
