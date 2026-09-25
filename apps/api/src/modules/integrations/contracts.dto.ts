import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsDateString,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ROLE_KEY_PATTERN, TEMPLATE_KEY_PATTERN } from '../templates/templates.dto';

const PRINTABLE = /^[\x21-\x7E][\x20-\x7E]*$/;

export class ContractSignerDto {
  @ApiProperty({ example: 'cliente', description: 'Papel do modelo' })
  @Matches(ROLE_KEY_PATTERN)
  role: string;

  @ApiProperty({ example: 'Maria da Silva', description: 'Cliente, ou o representante (vendedor) no papel da empresa' })
  @IsString()
  @Length(2, 120)
  name: string;

  @ApiProperty({ example: 'maria@exemplo.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiPropertyOptional({ example: '123.456.789-09' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  cpf?: string;

  @ApiPropertyOptional({ example: '+5524999999999' })
  @IsOptional()
  @Matches(/^\+?[0-9 ()-]{8,20}$/)
  phone?: string;

  @ApiPropertyOptional({ example: 'usuario-17', description: 'Papel da empresa: id do representante no sistema de origem' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  @Matches(PRINTABLE)
  externalId?: string;
}

/** Campo `data` (JSON) do multipart de POST /envelopes/from-template. */
export class ContractDataDto {
  @ApiProperty({ example: 'contrato-moto', description: 'Identificador do modelo' })
  @Matches(TEMPLATE_KEY_PATTERN)
  template: string;

  @ApiProperty({ example: 'venda-123', description: 'Referência única do contrato no sistema de origem' })
  @IsString()
  @Length(1, 120)
  @Matches(PRINTABLE, { message: 'externalRef aceita apenas caracteres ASCII imprimíveis.' })
  externalRef: string;

  @ApiProperty({ example: 'Contrato de venda #123 — Maria da Silva' })
  @IsString()
  @Length(2, 200)
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({ example: 'D-MAX Mobilidade Urbana', description: 'Empresa representada (padrão: nome da organização)' })
  @IsOptional()
  @IsString()
  @Length(2, 120)
  representing?: string;

  @ApiProperty({ type: [ContractSignerDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ContractSignerDto)
  signers: ContractSignerDto[];
}

export class AuthorizeCompanySignatureDto {
  @ApiProperty({ example: true })
  @Equals(true)
  accept: true;

  @ApiProperty({ example: '1.0', description: 'Versão do texto exibido' })
  @IsString()
  @MaxLength(20)
  version: string;
}
