import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { CurrentAuth, RequirePermission } from '../../common/auth/decorators';
import { Permission, type AuthContext } from '../../common/auth/auth-context';
import { clientInfo } from '../../common/http/client-info';
import { RateLimit } from '../../common/rate-limit/rate-limit';
import { PaginationQueryDto } from '../../common/util/pagination';
import { contentDisposition } from '../../common/http/content-disposition';
import { DocumentsService, type UploadedPdf } from './documents.service';

// Limite também validado no serviço; aqui evita bufferizar arquivos acima do permitido.
const MAX_UPLOAD = Number(process.env.UPLOAD_MAX_BYTES ?? 20 * 1024 * 1024);
const uploadInterceptor = FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 1, fields: 5 } });

class UploadDocumentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;
}

class ListDocumentsQuery extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: ['ACTIVE', 'LOCKED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'LOCKED'])
  status?: 'ACTIVE' | 'LOCKED';

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  createdById?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

class ContentQuery {
  @ApiPropertyOptional({ enum: ['view', 'download'] })
  @IsOptional()
  @IsIn(['view', 'download'])
  mode?: 'view' | 'download';
}

const fileBody = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: { file: { type: 'string', format: 'binary' }, title: { type: 'string' } },
  },
};

@ApiTags('documents')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @RequirePermission(Permission.DOCUMENT_WRITE)
  @RateLimit('upload')
  @Post()
  @UseInterceptors(uploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileBody)
  upload(@CurrentAuth() auth: AuthContext, @UploadedFile() file: UploadedPdf | undefined, @Body() dto: UploadDocumentDto, @Req() req: Request) {
    return this.documents.upload(auth, file, dto.title, clientInfo(req));
  }

  @RequirePermission(Permission.DOCUMENT_READ)
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() q: ListDocumentsQuery) {
    return this.documents.list(auth, q);
  }

  @RequirePermission(Permission.DOCUMENT_READ)
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.get(auth, id);
  }

  @RequirePermission(Permission.DOCUMENT_WRITE)
  @RateLimit('upload')
  @Post(':id/versions')
  @UseInterceptors(uploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileBody)
  addVersion(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: UploadedPdf | undefined, @Req() req: Request) {
    return this.documents.addVersion(auth, id, file, clientInfo(req));
  }

  @RequirePermission(Permission.DOCUMENT_READ)
  @Get(':id/versions/:versionId/content')
  async content(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Query() q: ContentQuery,
    @Req() req: Request,
  ) {
    const mode = q.mode ?? 'view';
    const file = await this.documents.openVersion(auth, id, versionId, mode, clientInfo(req));
    return new StreamableFile(file.stream, {
      type: 'application/pdf',
      disposition: contentDisposition(mode === 'download' ? 'attachment' : 'inline', file.filename),
      length: Number(file.size),
    });
  }

  @RequirePermission(Permission.DOCUMENT_WRITE)
  @Delete(':id')
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.documents.softDelete(auth, id);
    return { ok: true };
  }
}
