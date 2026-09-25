import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { CurrentAuth, RequirePermission, UserOnly } from '../../common/auth/decorators';
import { Permission, type AuthContext } from '../../common/auth/auth-context';
import { clientInfo } from '../../common/http/client-info';
import { RateLimit } from '../../common/rate-limit/rate-limit';
import type { UploadedPdf } from '../documents/documents.service';
import { ContractsService } from './contracts.service';
import { CompanySignatureService } from './company-signature.service';
import { AuthorizeCompanySignatureDto } from './contracts.dto';

// Limite também validado no serviço; aqui evita bufferizar arquivos acima do permitido.
const MAX_UPLOAD = Number(process.env.UPLOAD_MAX_BYTES ?? 20 * 1024 * 1024);
const contractUpload = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: MAX_UPLOAD, files: 1, fields: 2, fieldSize: 64 * 1024 },
});

@ApiTags('integrations')
@Controller()
export class IntegrationsController {
  constructor(
    private readonly contracts: ContractsService,
    private readonly companySignature: CompanySignatureService,
  ) {}

  @RequirePermission(Permission.ENVELOPE_WRITE)
  @RateLimit('upload')
  @Post('envelopes/from-template')
  @UseInterceptors(contractUpload)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'data'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'PDF do contrato com as âncoras [[AS:tipo:papel]]' },
        data: { type: 'string', description: 'JSON: { template, externalRef, title, message?, expiresAt?, representing?, signers: [{ role, name, email, cpf?, phone?, externalId? }] }' },
      },
    },
  })
  @ApiOperation({
    summary: 'Cria, envia e registra a assinatura da empresa de um contrato a partir de um modelo (idempotente por externalRef)',
  })
  fromTemplate(@CurrentAuth() auth: AuthContext, @UploadedFile() file: UploadedPdf | undefined, @Body('data') data: string, @Req() req: Request) {
    return this.contracts.create(auth, file, data, clientInfo(req));
  }

  @RequirePermission(Permission.ENVELOPE_WRITE)
  @HttpCode(200)
  @Post('envelopes/:id/signers/:signerId/link')
  @ApiOperation({ summary: 'Gera um novo link individual de assinatura (ex.: para envio por WhatsApp)' })
  signingLink(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('signerId', ParseUUIDPipe) signerId: string,
    @Req() req: Request,
  ) {
    return this.contracts.issueLink(auth, id, signerId, clientInfo(req));
  }

  @RequirePermission(Permission.ENVELOPE_READ)
  @Get('organizations/current/company-signature')
  @ApiOperation({ summary: 'Situação da autorização de assinatura da empresa pela integração' })
  companySignatureStatus(@CurrentAuth() auth: AuthContext) {
    return this.companySignature.status(auth);
  }

  @UserOnly()
  @RequirePermission(Permission.ORG_SETTINGS)
  @Post('organizations/current/company-signature')
  @ApiOperation({ summary: 'Autoriza a assinatura da empresa pela integração (aceite do texto vigente)' })
  authorizeCompanySignature(@CurrentAuth() auth: AuthContext, @Body() dto: AuthorizeCompanySignatureDto, @Req() req: Request) {
    return this.companySignature.authorize(auth, dto.version, clientInfo(req));
  }

  @UserOnly()
  @RequirePermission(Permission.ORG_SETTINGS)
  @Delete('organizations/current/company-signature')
  @ApiOperation({ summary: 'Revoga a autorização (novos contratos com papel da empresa passam a ser recusados)' })
  revokeCompanySignature(@CurrentAuth() auth: AuthContext, @Req() req: Request) {
    return this.companySignature.revoke(auth, clientInfo(req));
  }
}
