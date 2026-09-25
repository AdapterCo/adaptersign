import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, StreamableFile } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentAuth, RequirePermission } from '../../common/auth/decorators';
import { Permission, type AuthContext } from '../../common/auth/auth-context';
import { clientInfo } from '../../common/http/client-info';
import { contentDisposition } from '../../common/http/content-disposition';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { EnvelopesService } from './envelopes.service';
import { listAuthMethods } from '../signing/auth-methods';
import { ApplyTemplateDto } from '../templates/templates.dto';
import {
  ActivateEnvelopeDto,
  CancelEnvelopeDto,
  CreateEnvelopeDto,
  EnvelopeDocumentInputDto,
  ListEnvelopesQuery,
  RemindDto,
  SetFieldsDto,
  SignerInputDto,
  UpdateEnvelopeDto,
} from './envelopes.dto';

const IdempotencyHeader = ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Evita duplicação em retentativas' });

@ApiTags('envelopes')
@Controller('envelopes')
export class EnvelopesController {
  constructor(private readonly envelopes: EnvelopesService) {}

  @RequirePermission(Permission.ENVELOPE_WRITE)
  @Idempotent()
  @IdempotencyHeader
  @Post()
  @ApiOperation({ summary: 'Cria envelope em rascunho (opcionalmente com documentos e signatários)' })
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateEnvelopeDto, @Req() req: Request) {
    return this.envelopes.create(auth, dto, clientInfo(req));
  }

  @RequirePermission(Permission.ENVELOPE_READ)
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() q: ListEnvelopesQuery) {
    return this.envelopes.list(auth, q);
  }

  @RequirePermission(Permission.ENVELOPE_READ)
  @Get('auth-methods')
  @ApiOperation({ summary: 'Métodos de autenticação de signatário (indisponíveis vêm marcados)' })
  authMethods() {
    return listAuthMethods();
  }

  @RequirePermission(Permission.ENVELOPE_READ)
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.envelopes.get(auth, id);
  }

  @RequirePermission(Permission.ENVELOPE_WRITE)
  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEnvelopeDto, @Req() req: Request) {
    return this.envelopes.update(auth, id, dto, clientInfo(req));
  }

  @RequirePermission(Permission.ENVELOPE_WRITE)
  @Post(':id/documents')
  addDocument(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EnvelopeDocumentInputDto, @Req() req: Request) {
    return this.envelopes.addDocument(auth, id, dto, clientInfo(req));
  }

  @RequirePermission(Permission.ENVELOPE_WRITE)
  @Delete(':id/documents/:envelopeDocumentId')
  removeDocument(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('envelopeDocumentId', ParseUUIDPipe) edId: string,
    @Req() req: Request,
  ) {
    return this.envelopes.removeDocument(auth, id, edId, clientInfo(req));
  }

  @RequirePermission(Permission.ENVELOPE_WRITE)
  @Post(':id/signers')
  addSigner(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SignerInputDto, @Req() req: Request) {
    return this.envelopes.addSigner(auth, id, dto, clientInfo(req));
  }

  @RequirePermission(Permission.ENVELOPE_WRITE)
  @Delete(':id/signers/:signerId')
  removeSigner(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('signerId', ParseUUIDPipe) signerId: string,
    @Req() req: Request,
  ) {
    return this.envelopes.removeSigner(auth, id, signerId, clientInfo(req));
  }

  @RequirePermission(Permission.ENVELOPE_READ)
  @Get(':id/fields')
  @ApiOperation({ summary: 'Campos posicionados (coordenadas normalizadas 0..1, origem superior esquerda)' })
  fields(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.envelopes.listFields(auth, id);
  }

  @RequirePermission(Permission.ENVELOPE_WRITE)
  @Put(':id/fields')
  @ApiOperation({ summary: 'Substitui os campos posicionados do rascunho' })
  setFields(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetFieldsDto, @Req() req: Request) {
    return this.envelopes.setFields(auth, id, dto, clientInfo(req));
  }

  @RequirePermission(Permission.ENVELOPE_WRITE)
  @HttpCode(200)
  @Post(':id/fields/apply-template')
  @ApiOperation({ summary: 'Posiciona os campos a partir das âncoras [[AS:tipo:papel]] dos PDFs, conforme o modelo' })
  applyTemplate(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApplyTemplateDto, @Req() req: Request) {
    return this.envelopes.applyTemplate(auth, id, dto, clientInfo(req));
  }

  @RequirePermission(Permission.ENVELOPE_WRITE)
  @Idempotent()
  @IdempotencyHeader
  @HttpCode(200)
  @Post(':id/activate')
  @ApiOperation({ summary: 'Envia o envelope para assinatura (exige confirm=true)' })
  activate(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() _dto: ActivateEnvelopeDto, @Req() req: Request) {
    return this.envelopes.activate(auth, id, clientInfo(req));
  }

  @RequirePermission(Permission.ENVELOPE_CANCEL)
  @Idempotent()
  @IdempotencyHeader
  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelEnvelopeDto, @Req() req: Request) {
    return this.envelopes.cancel(auth, id, dto.reason, clientInfo(req));
  }

  @RequirePermission(Permission.ENVELOPE_WRITE)
  @HttpCode(202)
  @Post(':id/remind')
  remind(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RemindDto, @Req() req: Request) {
    return this.envelopes.remind(auth, id, dto.signerId, clientInfo(req));
  }

  @RequirePermission(Permission.ENVELOPE_READ)
  @Get(':id/timeline')
  timeline(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.envelopes.timeline(auth, id);
  }

  @RequirePermission(Permission.ENVELOPE_READ)
  @Get(':id/documents/:envelopeDocumentId/final')
  async finalDocument(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('envelopeDocumentId', ParseUUIDPipe) edId: string,
    @Req() req: Request,
  ) {
    const file = await this.envelopes.openFinalDocument(auth, id, edId, clientInfo(req));
    return new StreamableFile(file.stream, { type: 'application/pdf', disposition: contentDisposition('attachment', file.filename) });
  }

  @RequirePermission(Permission.ENVELOPE_READ)
  @Get(':id/evidence')
  async evidence(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const file = await this.envelopes.openEvidenceReport(auth, id, clientInfo(req));
    return new StreamableFile(file.stream, { type: 'application/pdf', disposition: contentDisposition('attachment', file.filename) });
  }
}
