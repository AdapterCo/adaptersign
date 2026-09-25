import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
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
import { PageCorner, SigningMode } from '../../generated/prisma/client';

export const TEMPLATE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,59}$/;
export const ROLE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export class TemplateRoleDto {
  @ApiProperty({ example: 'cliente', description: 'Nome do papel nas âncoras: [[AS:assinatura:cliente]]' })
  @Matches(ROLE_KEY_PATTERN, { message: 'Use letras minúsculas, números, "_" ou "-" (até 40).' })
  key: string;

  @ApiProperty({ example: 'Cliente' })
  @IsString()
  @Length(1, 60)
  label: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, default: 1, description: 'Ordem de assinatura (modo sequencial)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  signingGroup?: number;

  @ApiPropertyOptional({ description: 'Papel que representa a própria empresa (ex.: a loja)' })
  @IsOptional()
  @IsBoolean()
  isCompany?: boolean;

  @ApiPropertyOptional({ description: 'Rubrica automática em todas as páginas' })
  @IsOptional()
  @IsBoolean()
  initialsAllPages?: boolean;

  @ApiPropertyOptional({ enum: PageCorner, default: PageCorner.BOTTOM_RIGHT })
  @IsOptional()
  @IsEnum(PageCorner)
  initialsCorner?: PageCorner;
}

export class UpsertTemplateDto {
  @ApiProperty({ example: 'contrato-moto', description: 'Identificador estável usado por integrações' })
  @Matches(TEMPLATE_KEY_PATTERN, { message: 'Use letras minúsculas, números, "_" ou "-" (até 60).' })
  key: string;

  @ApiProperty({ example: 'Contrato de venda de moto' })
  @IsString()
  @Length(2, 120)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: SigningMode, default: SigningMode.SEQUENTIAL })
  @IsOptional()
  @IsEnum(SigningMode)
  signingMode?: SigningMode;

  @ApiProperty({ type: [TemplateRoleDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => TemplateRoleDto)
  roles: TemplateRoleDto[];
}

export class RoleAssignmentDto {
  @ApiProperty({ example: 'cliente' })
  @Matches(ROLE_KEY_PATTERN)
  roleKey: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  signerId: string;
}

export class ApplyTemplateDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  templateId: string;

  @ApiProperty({ type: [RoleAssignmentDto], description: 'Signatário do envelope para cada papel do modelo' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => RoleAssignmentDto)
  roles: RoleAssignmentDto[];
}
