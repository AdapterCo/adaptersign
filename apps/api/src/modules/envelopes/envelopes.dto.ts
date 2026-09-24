import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { AuthMethod, EnvelopeStatus, SignerRole, SigningMode } from '../../generated/prisma/client';
import { PaginationQueryDto } from '../../common/util/pagination';

export class SignerInputDto {
  @ApiProperty({ example: 'João Exemplo' })
  @IsString()
  @Length(2, 120)
  name: string;

  @ApiProperty({ example: 'joao@exemplo.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiPropertyOptional({ example: '+5511999999999' })
  @IsOptional()
  @Matches(/^\+?[0-9 ()-]{8,20}$/)
  phone?: string;

  @ApiPropertyOptional({ description: 'Opcional. Armazenado cifrado; exibido mascarado.' })
  @IsOptional()
  @IsString()
  @MaxLength(14)
  cpf?: string;

  @ApiPropertyOptional({ enum: SignerRole, default: SignerRole.SIGNER })
  @IsOptional()
  @IsEnum(SignerRole)
  role?: SignerRole;

  @ApiPropertyOptional({ description: 'Grupo de assinatura (sequencial). Ignorado em modo paralelo.', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  signingGroup?: number;

  @ApiPropertyOptional({ enum: AuthMethod, default: AuthMethod.EMAIL_OTP })
  @IsOptional()
  @IsEnum(AuthMethod)
  authMethod?: AuthMethod;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  required?: boolean;
}

export class EnvelopeDocumentInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  documentId: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Versão específica; padrão: versão mais recente' })
  @IsOptional()
  @IsUUID()
  versionId?: string;
}

export class CreateEnvelopeDto {
  @ApiProperty({ example: 'Contrato de prestação de serviços' })
  @IsString()
  @Length(2, 200)
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;

  @ApiPropertyOptional({ enum: SigningMode, default: SigningMode.PARALLEL })
  @IsOptional()
  @IsEnum(SigningMode)
  signingMode?: SigningMode;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({ enum: [24, 48, 72], description: 'Lembrete automático a cada N horas' })
  @IsOptional()
  @Type(() => Number)
  @IsIn([24, 48, 72])
  reminderIntervalHours?: number;

  @ApiPropertyOptional({ type: [EnvelopeDocumentInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => EnvelopeDocumentInputDto)
  documents?: EnvelopeDocumentInputDto[];

  @ApiPropertyOptional({ type: [SignerInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SignerInputDto)
  signers?: SignerInputDto[];
}

export class UpdateEnvelopeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;

  @ApiPropertyOptional({ enum: SigningMode })
  @IsOptional()
  @IsEnum(SigningMode)
  signingMode?: SigningMode;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @ApiPropertyOptional({ enum: [24, 48, 72], nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsIn([24, 48, 72])
  reminderIntervalHours?: number | null;
}

export class ActivateEnvelopeDto {
  @ApiProperty({ description: 'Confirmação explícita do envio (obrigatória).', example: true })
  @IsBoolean()
  @Equals(true)
  confirm: boolean;
}

export class CancelEnvelopeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RemindDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  signerId?: string;
}

export class ListEnvelopesQuery extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: EnvelopeStatus })
  @IsOptional()
  @IsEnum(EnvelopeStatus)
  status?: EnvelopeStatus;

  @ApiPropertyOptional({ description: 'Busca por título, código de validação, signatário ou documento' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
