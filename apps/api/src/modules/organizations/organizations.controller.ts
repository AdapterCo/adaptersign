import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsString, Length, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { MemberRole } from '../../generated/prisma/client';
import { CurrentAuth, RequirePermission, UserOnly } from '../../common/auth/decorators';
import { Permission, type AuthContext } from '../../common/auth/auth-context';
import { clientInfo } from '../../common/http/client-info';
import { OrganizationsService } from './organizations.service';

class UpdateOrganizationDto {
  @ApiProperty()
  @IsString()
  @Length(2, 120)
  name: string;
}

class InviteMemberDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty()
  @IsString()
  @Length(2, 120)
  name: string;

  @ApiProperty({ enum: MemberRole })
  @IsEnum(MemberRole)
  role: MemberRole;
}

class ChangeRoleDto {
  @ApiProperty({ enum: MemberRole })
  @IsEnum(MemberRole)
  role: MemberRole;
}

@ApiTags('organizations')
@Controller('organizations/current')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Get()
  current(@CurrentAuth() auth: AuthContext) {
    return this.orgs.current(auth);
  }

  @UserOnly()
  @RequirePermission(Permission.ORG_SETTINGS)
  @Patch()
  update(@CurrentAuth() auth: AuthContext, @Body() dto: UpdateOrganizationDto, @Req() req: Request) {
    return this.orgs.update(auth, dto.name, clientInfo(req));
  }

  @RequirePermission(Permission.MEMBERS_READ)
  @Get('members')
  members(@CurrentAuth() auth: AuthContext) {
    return this.orgs.members(auth);
  }

  @UserOnly()
  @RequirePermission(Permission.MEMBERS_MANAGE)
  @Post('members')
  invite(@CurrentAuth() auth: AuthContext, @Body() dto: InviteMemberDto, @Req() req: Request) {
    return this.orgs.invite(auth, dto, clientInfo(req));
  }

  @UserOnly()
  @RequirePermission(Permission.MEMBERS_MANAGE)
  @HttpCode(200)
  @Patch('members/:id')
  async changeRole(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeRoleDto, @Req() req: Request) {
    await this.orgs.changeRole(auth, id, dto.role, clientInfo(req));
    return { ok: true };
  }

  @UserOnly()
  @RequirePermission(Permission.MEMBERS_MANAGE)
  @Delete('members/:id')
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    await this.orgs.remove(auth, id, clientInfo(req));
    return { ok: true };
  }
}
