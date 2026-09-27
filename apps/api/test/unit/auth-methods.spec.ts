import { AuthMethod } from '../../src/generated/prisma/client';
import { assertAuthMethodAvailable, assertSignersActivatable } from '../../src/modules/signing/auth-methods';

describe('assertSignersActivatable', () => {
  it('aceita o papel da empresa assinado pela integração junto de um cliente por código', () => {
    expect(() => assertSignersActivatable([{ authMethod: AuthMethod.INTEGRATION }, { authMethod: AuthMethod.EMAIL_OTP }])).not.toThrow();
  });

  it('continua barrando métodos sem implementação', () => {
    expect(() => assertSignersActivatable([{ authMethod: AuthMethod.INTEGRATION }, { authMethod: AuthMethod.SELFIE }])).toThrow(/indisponível/);
  });

  it('INTEGRATION segue indisponível para escolha manual', () => {
    expect(() => assertAuthMethodAvailable(AuthMethod.INTEGRATION)).toThrow(/indisponível/);
  });
});
