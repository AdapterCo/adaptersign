import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, getConfig } from './config';
import { brandingFromConfig } from './branding';

export const BRANDING = Symbol('BRANDING');

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => getConfig() },
    { provide: BRANDING, useFactory: () => brandingFromConfig(getConfig()) },
  ],
  exports: [APP_CONFIG, BRANDING],
})
export class ConfigModule {}
