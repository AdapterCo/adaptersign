# INSTRUÇÃO DO PROJETO — ADAPTER SIGN

## 1. OBJETIVO

Desenvolver uma plataforma SaaS profissional de assinatura eletrônica de documentos, inspirada funcionalmente em plataformas como Clicksign, DocuSign e similares, porém com implementação, identidade visual, arquitetura, código e experiência próprias.

Nome provisório do projeto:

**Adapter Sign**

O sistema deverá permitir que empresas enviem documentos PDF, cadastrem signatários, definam a ordem das assinaturas, enviem convites, autentiquem os participantes, registrem evidências do processo e produzam ao final um documento acompanhado de uma trilha de auditoria verificável.

O objetivo NÃO é simplesmente inserir uma imagem de assinatura em um PDF.

O objetivo é construir uma plataforma de assinatura eletrônica baseada em:

* identificação dos participantes;
* manifestação de vontade;
* autenticação;
* integridade documental;
* hash criptográfico;
* trilha de auditoria;
* registro temporal;
* evidências;
* rastreabilidade;
* verificabilidade posterior.

O projeto deverá nascer preparado para produção e para evolução comercial como SaaS.

---

# 2. PRINCÍPIOS OBRIGATÓRIOS

O desenvolvimento deverá obedecer aos seguintes princípios:

1. Não inventar APIs, bibliotecas, endpoints ou recursos inexistentes.
2. Não utilizar implementações fictícias em funcionalidades de produção.
3. Não deixar TODOs silenciosos em funções críticas.
4. Não utilizar mocks no fluxo de produção.
5. Toda integração externa deve utilizar documentação oficial atual.
6. Credenciais nunca poderão ficar hardcoded.
7. Nunca armazenar senha em texto puro.
8. Nunca registrar OTP, senha ou token secreto integralmente em logs.
9. Toda operação sensível deverá possuir tratamento de erro.
10. Toda operação crítica deverá produzir auditoria.
11. Documentos não poderão ser silenciosamente modificados depois do início do processo de assinatura.
12. Nunca considerar IP isoladamente como prova de identidade.
13. Nunca afirmar juridicamente que determinado mecanismo possui validade universal.
14. O sistema deverá distinguir assinatura eletrônica simples, avançada e, futuramente, qualificada.
15. Funcionalidades ainda não implementadas deverão aparecer explicitamente como indisponíveis, e não simuladas.

Antes de adicionar uma dependência, verificar:

* manutenção;
* documentação;
* licença;
* vulnerabilidades conhecidas;
* compatibilidade com o projeto.

---

# 3. ESCOPO DO MVP

A primeira versão deverá conter:

* SaaS multiempresa;
* autenticação;
* empresas/workspaces;
* usuários;
* membros;
* permissões;
* documentos PDF;
* envelopes;
* signatários;
* ordem de assinatura;
* autenticação por e-mail;
* OTP por e-mail;
* links individuais de assinatura;
* aceite eletrônico;
* assinatura visual;
* trilha de auditoria;
* hash SHA-256;
* certificado/relatório de evidências;
* validação pública;
* notificações;
* painel administrativo;
* webhooks;
* API REST;
* armazenamento S3-compatible;
* planos e limites;
* logs;
* Docker;
* backups;
* segurança básica de produção.

Não implementar ICP-Brasil na primeira versão.

A arquitetura, entretanto, deverá permitir sua inclusão posteriormente.

---

# 4. STACK PRINCIPAL

## Frontend

Utilizar:

* Next.js;
* TypeScript;
* React;
* Tailwind CSS.

Preferencialmente utilizar componentes acessíveis e reutilizáveis.

## Backend

Utilizar:

* Node.js;
* TypeScript;
* NestJS.

## Banco

PostgreSQL.

## ORM

Prisma.

## Filas

Redis + BullMQ.

## Armazenamento

API compatível com S3.

A implementação deverá funcionar com:

* Cloudflare R2;
* Amazon S3;
* MinIO para desenvolvimento.

O provedor deverá ser configurável por variáveis de ambiente.

## PDF

Utilizar bibliotecas consolidadas para:

* leitura;
* geração;
* manipulação;
* renderização.

Nunca reconstruir PDFs desnecessariamente.

## Infraestrutura

Docker + Docker Compose.

Produção deverá poder operar atrás de:

* Nginx;
* Traefik;
* outro reverse proxy compatível.

---

# 5. ARQUITETURA

Inicialmente utilizar **monólito modular**, evitando microserviços prematuros.

Estrutura conceitual:

```text
Frontend
    |
    v
API
    |
    +-- Auth Module
    +-- Organizations Module
    +-- Users Module
    +-- Documents Module
    +-- Envelopes Module
    +-- Signers Module
    +-- Signature Module
    +-- Evidence Module
    +-- Audit Module
    +-- Notifications Module
    +-- Webhooks Module
    +-- Billing Module
    +-- Admin Module
    |
    +-- PostgreSQL
    +-- Redis
    +-- Object Storage
```

Workers independentes deverão processar tarefas demoradas.

Exemplos:

* envio de e-mail;
* geração de PDFs;
* geração do relatório de evidências;
* webhooks;
* processamento documental;
* limpeza de arquivos temporários.

---

# 6. MULTITENANCY

O sistema será multiempresa.

Entidade principal:

```text
Organization
```

Uma organização poderá possuir vários usuários.

Um usuário poderá futuramente participar de mais de uma organização.

Todas as entidades empresariais deverão possuir associação explícita com:

```text
organization_id
```

Sempre validar tenant no backend.

Nunca confiar apenas no frontend.

É proibido permitir acesso cruzado entre organizações.

---

# 7. PAPÉIS

Inicialmente:

```text
OWNER
ADMIN
MEMBER
VIEWER
```

OWNER:

* controle completo;
* faturamento;
* usuários;
* configurações;
* API;
* webhooks.

ADMIN:

* documentos;
* envelopes;
* usuários;
* relatórios.

MEMBER:

* criar documentos;
* criar envelopes;
* acompanhar assinaturas.

VIEWER:

* somente consulta.

Preparar RBAC extensível.

---

# 8. AUTENTICAÇÃO

Implementar:

* cadastro;
* login;
* logout;
* recuperação de senha;
* redefinição de senha;
* verificação de e-mail;
* refresh token;
* encerramento de sessões.

Senhas:

* Argon2id preferencialmente;
* nunca armazenar senha original.

Refresh tokens deverão possuir proteção contra reutilização indevida.

Permitir encerramento de todas as sessões.

Preparar arquitetura para MFA administrativo.

---

# 9. DOCUMENTOS

Usuários autorizados poderão enviar PDFs.

No upload:

1. validar MIME real;
2. validar extensão;
3. validar tamanho;
4. validar se é PDF processável;
5. gerar identificador;
6. calcular SHA-256;
7. armazenar arquivo;
8. salvar metadados;
9. registrar evento.

Exemplo:

```text
document_id
organization_id
filename
original_filename
mime_type
size
storage_key
sha256
status
created_by
created_at
```

Nunca utilizar diretamente o nome original como chave de armazenamento.

Utilizar UUID/ULID.

---

# 10. IMUTABILIDADE

Quando um documento for incluído em um envelope enviado para assinatura:

**ele passa a ser imutável para aquele processo.**

Qualquer modificação deverá gerar:

* nova versão;
* novo hash;
* nova identificação.

Nunca substituir silenciosamente o arquivo anterior.

---

# 11. ENVELOPES

Envelope representa um processo de assinatura.

Um envelope poderá conter:

* um ou mais documentos;
* um ou mais signatários;
* regras;
* ordem;
* prazo;
* mensagens.

Estados sugeridos:

```text
DRAFT
ACTIVE
PARTIALLY_SIGNED
COMPLETED
EXPIRED
CANCELLED
DECLINED
```

Transições deverão ser validadas no backend.

Não permitir mudanças arbitrárias de status.

---

# 12. SIGNATÁRIOS

Cada signatário poderá possuir:

```text
id
envelope_id
name
email
phone
cpf
role
signing_order
status
authentication_method
created_at
```

CPF não deverá obrigatoriamente existir em todos os fluxos.

Quando armazenado, deverá receber tratamento adequado de dados pessoais.

Estados:

```text
PENDING
INVITED
VIEWED
AUTHENTICATED
SIGNED
DECLINED
EXPIRED
```

---

# 13. PAPÉIS DO SIGNATÁRIO

Permitir inicialmente:

```text
SIGNER
APPROVER
WITNESS
```

Posteriormente poderão ser adicionados outros papéis.

---

# 14. ORDEM DE ASSINATURA

Permitir:

## Paralela

Todos podem assinar simultaneamente.

## Sequencial

Exemplo:

```text
Daniel -> João -> Maria
```

João somente será convidado quando Daniel concluir.

Maria somente será convidada quando João concluir.

Também preparar arquitetura para grupos:

```text
Grupo 1:
Daniel
João

Grupo 2:
Maria
Pedro
```

Grupo 2 somente começa depois da conclusão do Grupo 1.

---

# 15. CONVITE

Cada signatário receberá um link individual.

Nunca compartilhar o mesmo token entre signatários.

Exemplo conceitual:

```text
/sign/{token}
```

O token deverá:

* possuir alta entropia;
* ser imprevisível;
* possuir validade;
* ser revogável;
* não revelar IDs internos;
* ser armazenado de maneira segura.

Preferencialmente armazenar hash do token no banco, e não o token utilizável em texto puro.

---

# 16. FLUXO DO SIGNATÁRIO

Fluxo:

```text
Recebe convite
      ↓
Abre link
      ↓
Sistema valida token
      ↓
Exibe identificação do processo
      ↓
Autenticação
      ↓
Visualização do documento
      ↓
Aceite dos termos
      ↓
Assinatura
      ↓
Confirmação
```

Nunca considerar apenas a abertura do link como assinatura.

---

# 17. OTP

MVP:

OTP por e-mail.

Fluxo:

```text
Solicitar OTP
      ↓
Gerar código criptograficamente seguro
      ↓
Salvar somente representação protegida
      ↓
Enviar
      ↓
Usuário informa código
      ↓
Validar
      ↓
Registrar autenticação
```

Requisitos:

* validade curta;
* limite de tentativas;
* rate limiting;
* cooldown;
* expiração;
* uso único.

Nunca registrar OTP integral em logs.

---

# 18. ASSINATURA VISUAL

Permitir:

* digitar nome;
* desenhar assinatura;
* futuramente upload controlado.

A assinatura visual é apenas parte da experiência.

Não deverá ser considerada isoladamente como evidência suficiente.

Registrar separadamente:

```text
signature_method
signature_asset
signed_at
```

---

# 19. ACEITE

Antes da assinatura deverá existir manifestação explícita.

Exemplo:

```text
Li o documento e concordo em assiná-lo eletronicamente.
```

Registrar:

* versão do texto;
* timestamp;
* signatário;
* envelope;
* documento(s);
* resultado.

O texto deverá ser versionado.

---

# 20. HASH

Utilizar SHA-256.

Calcular hash do documento original.

Exemplo:

```text
SHA256(document_bytes)
```

Registrar o valor no banco.

Quando necessário, recalcular para verificar integridade.

Não utilizar MD5 ou SHA-1 para integridade criptográfica.

---

# 21. MOTOR DE EVIDÊNCIAS

Criar módulo específico:

```text
EvidenceService
```

Ele será responsável por consolidar evidências.

Exemplo conceitual:

```json
{
  "event": "SIGNATURE_COMPLETED",
  "signer_id": "...",
  "document_id": "...",
  "envelope_id": "...",
  "timestamp": "...",
  "authentication": {
    "method": "EMAIL_OTP"
  },
  "network": {
    "ip": "...",
    "user_agent": "..."
  },
  "document": {
    "sha256": "..."
  },
  "consent": {
    "accepted": true,
    "terms_version": "1.0"
  }
}
```

Não confiar exclusivamente em IP.

---

# 22. AUDITORIA

Criar tabela append-only:

```text
audit_events
```

Campos mínimos:

```text
id
organization_id
envelope_id
document_id
signer_id
actor_type
actor_id
event_type
timestamp
ip
user_agent
metadata
previous_hash
event_hash
```

Eventos relevantes:

```text
DOCUMENT_CREATED
DOCUMENT_UPLOADED
ENVELOPE_CREATED
SIGNER_ADDED
ENVELOPE_ACTIVATED
INVITATION_SENT
INVITATION_OPENED
DOCUMENT_VIEWED
OTP_REQUESTED
OTP_VALIDATED
CONSENT_ACCEPTED
SIGNATURE_STARTED
SIGNATURE_COMPLETED
SIGNER_DECLINED
ENVELOPE_COMPLETED
ENVELOPE_EXPIRED
ENVELOPE_CANCELLED
DOCUMENT_DOWNLOADED
VALIDATION_PERFORMED
```

---

# 23. ENCADEAMENTO DE EVENTOS

Implementar possibilidade de encadeamento criptográfico:

```text
event_hash =
SHA256(
 previous_hash +
 canonical_event_data
)
```

Isso cria uma sequência verificável.

A serialização utilizada no cálculo deverá ser determinística/canônica.

Nunca depender da ordem arbitrária das propriedades JSON.

---

# 24. DATA E HORA

Internamente utilizar UTC.

Exemplo:

```text
2026-09-23T22:35:18.123Z
```

Frontend converte para timezone do usuário.

Nunca utilizar horário fornecido pelo navegador como fonte oficial do evento.

O servidor deverá registrar o horário.

---

# 25. FINALIZAÇÃO DO ENVELOPE

Quando todos os signatários obrigatórios concluírem:

1. bloquear alterações;
2. validar documentos;
3. validar evidências;
4. recalcular hashes necessários;
5. finalizar envelope;
6. gerar relatório de evidências;
7. armazenar resultado;
8. registrar evento;
9. notificar participantes;
10. disparar webhook.

---

# 26. RELATÓRIO DE EVIDÊNCIAS

Gerar PDF contendo informações como:

```text
CERTIFICADO / RELATÓRIO DE ASSINATURAS

Envelope:
...

Criado em:
...

Finalizado em:
...

Documento:
Contrato.pdf

SHA-256:
...

SIGNATÁRIOS

Nome:
...

Autenticação:
OTP por e-mail

Assinado em:
...

TRILHA DE EVENTOS

Documento criado
Convite enviado
Documento acessado
Autenticação realizada
Termos aceitos
Assinatura realizada
Envelope finalizado
```

Não expor dados pessoais desnecessariamente.

CPF e e-mail poderão aparecer mascarados dependendo do contexto.

---

# 27. PDF FINAL

Não destruir o arquivo original.

Manter:

```text
original/
final/
evidence/
```

Exemplo:

```text
documents/{organization}/{document}/original.pdf

documents/{organization}/{document}/final.pdf

documents/{organization}/{document}/evidence.pdf
```

O arquivo original deverá continuar preservado.

---

# 28. VERIFICAÇÃO PÚBLICA

Criar:

```text
/verify
```

Permitir:

### ID

Usuário informa código de validação.

ou

### Upload

Usuário envia documento para validação.

Sistema:

1. calcula SHA-256;
2. procura correspondência;
3. verifica integridade;
4. exibe resultado.

Exemplo:

```text
Documento localizado

Integridade:
VERIFICADA

Envelope:
...

Finalizado:
...

Hash:
...

Signatários:
...
```

Não expor informações privadas indevidamente.

---

# 29. CÓDIGO DE VALIDAÇÃO

Cada envelope finalizado deverá possuir identificador público independente dos IDs internos.

Exemplo:

```text
ADP-8F7K-29QM-X82P
```

Não usar IDs incrementais previsíveis.

---

# 30. DASHBOARD

Dashboard principal deverá mostrar:

* envelopes recentes;
* aguardando assinatura;
* concluídos;
* expirados;
* cancelados;
* consumo do plano.

---

# 31. TELA DE DOCUMENTOS

Permitir:

* busca;
* filtros;
* paginação;
* status;
* data;
* criador;
* download;
* abrir envelope associado.

---

# 32. CRIAÇÃO DE ENVELOPE

Wizard:

```text
1. Documentos
2. Signatários
3. Ordem
4. Autenticação
5. Prazo
6. Mensagem
7. Revisão
8. Enviar
```

Nunca ativar envelope sem confirmação final.

---

# 33. PÁGINA DE ASSINATURA

Deverá funcionar muito bem em:

* desktop;
* tablet;
* celular.

Layout simples.

Prioridade:

**documento e ação necessária.**

Evitar distrações.

---

# 34. NOTIFICAÇÕES

Criar sistema de templates.

Eventos:

* convite;
* lembrete;
* próximo signatário;
* conclusão;
* expiração;
* cancelamento.

Templates não deverão ficar espalhados pelo código.

---

# 35. LEMBRETES

Permitir lembretes automáticos configuráveis.

Exemplo:

```text
24 horas
48 horas
72 horas
```

Worker deverá verificar envelopes pendentes.

Evitar spam.

---

# 36. EXPIRAÇÃO

Envelope poderá possuir:

```text
expires_at
```

Depois da expiração:

* tokens deixam de funcionar;
* novas assinaturas são bloqueadas;
* evento é registrado.

---

# 37. CANCELAMENTO

Usuário autorizado poderá cancelar envelope ativo.

Registrar:

* quem cancelou;
* horário;
* motivo opcional.

Nunca apagar histórico.

---

# 38. RECUSA

Signatário poderá recusar assinatura.

Registrar:

```text
declined_at
reason
```

O comportamento do envelope dependerá das regras definidas.

Inicialmente, recusa de signatário obrigatório deverá impedir conclusão normal.

---

# 39. API

Criar API REST versionada:

```text
/api/v1/
```

Principais recursos:

```text
/auth
/organizations
/users
/documents
/envelopes
/signers
/webhooks
/api-keys
/verify
```

---

# 40. API KEYS

Empresas poderão gerar chaves para integrações.

Nunca armazenar chave completa em texto puro.

Exibir a chave completa apenas no momento da criação.

Guardar:

```text
prefix
hash
created_at
last_used_at
revoked_at
```

Permitir revogação.

---

# 41. API DE ENVELOPES

Exemplos conceituais:

```text
POST /api/v1/envelopes

GET /api/v1/envelopes/:id

POST /api/v1/envelopes/:id/documents

POST /api/v1/envelopes/:id/signers

POST /api/v1/envelopes/:id/activate

POST /api/v1/envelopes/:id/cancel
```

Não implementar exatamente esses endpoints se houver razão arquitetural documentada para uma estrutura melhor.

---

# 42. WEBHOOKS

Permitir que clientes cadastrem endpoints.

Eventos:

```text
envelope.created
envelope.activated
document.viewed
signer.authenticated
signer.signed
signer.declined
envelope.completed
envelope.expired
envelope.cancelled
```

---

# 43. SEGURANÇA DOS WEBHOOKS

Assinar payload com HMAC.

Exemplo conceitual:

```text
X-Adapter-Signature
X-Adapter-Timestamp
X-Adapter-Event-ID
```

Cliente deverá conseguir validar:

```text
HMAC-SHA256
```

Adicionar proteção contra replay.

---

# 44. ENTREGA DE WEBHOOK

Não disparar webhook diretamente dentro da requisição principal.

Utilizar fila.

Tentativas com backoff.

Exemplo:

```text
imediato
1 min
5 min
30 min
2 h
```

Configuração poderá evoluir.

Registrar:

```text
attempt
status_code
response_time
error
created_at
```

Nunca armazenar indiscriminadamente respostas contendo segredos.

---

# 45. IDEMPOTÊNCIA

Endpoints críticos deverão aceitar:

```text
Idempotency-Key
```

Principalmente:

* criação de envelope;
* ativação;
* operações API;
* ações financeiras futuras.

Evitar duplicações provocadas por retry.

---

# 46. RATE LIMITING

Aplicar limites diferentes para:

* login;
* OTP;
* assinatura;
* validação;
* API;
* webhooks;
* upload.

Redis poderá ser utilizado.

---

# 47. STORAGE

Nunca tornar bucket inteiro público.

Downloads deverão utilizar:

* endpoint autenticado;

ou

* signed URLs de curta duração.

Arquivos privados permanecem privados.

---

# 48. UPLOADS

Validar:

* MIME;
* assinatura/magic bytes;
* tamanho;
* extensão;
* estrutura.

Preparar integração futura com antivírus.

Nunca confiar apenas no `Content-Type` enviado pelo navegador.

---

# 49. LGPD

O projeto deverá considerar desde a arquitetura:

* minimização de dados;
* finalidade;
* segurança;
* retenção;
* acesso;
* correção;
* exclusão quando juridicamente aplicável;
* anonimização quando adequada;
* rastreabilidade.

Não coletar informação simplesmente porque "pode ser útil".

---

# 50. RETENÇÃO

Criar política configurável.

Não apagar evidências críticas automaticamente sem política explícita.

Preparar sistema para retenção por plano e requisitos contratuais.

---

# 51. LOGS

Utilizar logs estruturados.

Exemplo:

```json
{
  "level": "info",
  "event": "envelope_completed",
  "envelope_id": "...",
  "request_id": "..."
}
```

Nunca registrar:

* senha;
* OTP;
* token completo;
* API key;
* Authorization header;
* conteúdo integral de documentos.

---

# 52. REQUEST ID

Cada requisição deverá possuir identificador.

Exemplo:

```text
X-Request-ID
```

Permitir correlação entre:

* API;
* worker;
* webhook;
* logs.

---

# 53. BANCO DE DADOS

Entidades mínimas:

```text
users
organizations
organization_members
sessions

documents
document_versions

envelopes
envelope_documents

signers
signature_sessions
signatures

authentication_challenges

consents

audit_events

evidence_reports

notifications

webhook_endpoints
webhook_deliveries

api_keys

plans
subscriptions
usage_records
```

---

# 54. SOFT DELETE

Não apagar diretamente entidades críticas.

Utilizar quando apropriado:

```text
deleted_at
```

Entretanto, soft delete não deverá substituir políticas reais de retenção e exclusão LGPD.

---

# 55. TRANSAÇÕES

Operações críticas deverão utilizar transações PostgreSQL.

Exemplo:

```text
registrar assinatura
+
alterar signatário
+
registrar consentimento
+
criar evento
+
avaliar conclusão
```

Não permitir estado parcialmente atualizado.

---

# 56. CONCORRÊNCIA

Prevenir:

* assinatura duplicada;
* conclusão duplicada;
* convite duplicado;
* corrida entre workers;
* webhook duplicado sem identificação.

Utilizar:

* constraints;
* transactions;
* locks quando necessários;
* idempotência.

---

# 57. PAINEL ADMINISTRATIVO DA PLATAFORMA

Criar área separada para administração Adapter.

Funções:

* organizações;
* usuários;
* planos;
* consumo;
* envelopes;
* falhas;
* webhooks;
* workers;
* armazenamento;
* métricas.

Administrador da plataforma não deverá acessar documentos privados indiscriminadamente.

Acesso excepcional deverá ser controlado e auditado.

---

# 58. PLANOS

Preparar:

```text
FREE
STARTER
PRO
BUSINESS
ENTERPRISE
```

Não definir preços permanentemente no código.

Planos deverão possuir configuração.

Exemplo:

```text
monthly_envelopes
monthly_documents
storage_limit
users_limit
api_access
webhooks
branding
```

---

# 59. USAGE

Criar controle de consumo.

Exemplo:

```text
organization
metric
quantity
period
```

Métricas:

```text
envelopes_created
documents_uploaded
signatures_completed
storage_bytes
api_requests
```

---

# 60. BILLING

Inicialmente deixar camada de billing desacoplada.

Preparar interface:

```text
BillingProvider
```

Permitindo posteriormente integrar:

* Mercado Pago;
* Stripe;
* outro provedor.

Não acoplar regras de negócio diretamente ao SDK de pagamento.

---

# 61. EMAIL

Criar interface:

```text
EmailProvider
```

Permitindo trocar provedor.

Exemplos futuros:

* Amazon SES;
* Resend.

Templates separados da regra de negócio.

---

# 62. DESIGN

Interface profissional, moderna e limpa.

Evitar aparência de template genérico.

Priorizar:

* legibilidade;
* confiança;
* simplicidade;
* responsividade;
* acessibilidade.

---

# 63. IDENTIDADE

Utilizar provisoriamente:

```text
Adapter Sign
```

Não espalhar nome pelo código.

Configurar branding centralizado para permitir mudança futura.

---

# 64. WHITE LABEL FUTURO

Preparar arquitetura para:

```text
logo
nome
cor
domínio
e-mail
```

por organização/cliente enterprise.

Não implementar toda funcionalidade agora, mas evitar decisões que impeçam isso.

---

# 65. DOMÍNIOS

Preparar estrutura conceitual:

```text
app.dominio.com
api.dominio.com
```

Validação pública:

```text
app.dominio.com/verify
```

Não codificar domínio diretamente.

---

# 66. DOCKER

Criar:

```text
docker-compose.yml
```

Serviços:

```text
frontend
backend
worker
postgres
redis
minio
```

MinIO somente quando necessário para desenvolvimento/local.

Produção poderá utilizar storage externo.

---

# 67. HEALTH CHECKS

Criar:

```text
/health
/ready
```

Verificar adequadamente:

* aplicação;
* banco;
* Redis;
* dependências essenciais.

Não expor segredos.

---

# 68. MIGRATIONS

Todas as alterações do banco deverão usar migrations.

Nunca editar banco de produção manualmente como fluxo normal.

---

# 69. SEEDS

Criar seeds apenas para:

* desenvolvimento;
* testes.

Nunca criar usuário administrativo com senha padrão em produção.

---

# 70. TESTES

Implementar:

## Unitários

Serviços críticos.

## Integração

Banco + API.

## E2E

Fluxos principais.

Fluxo E2E obrigatório:

```text
empresa
↓
usuário
↓
upload
↓
envelope
↓
signatário
↓
convite
↓
OTP
↓
aceite
↓
assinatura
↓
conclusão
↓
relatório
↓
validação
```

---

# 71. TESTES DE SEGURANÇA

Testar:

* IDOR;
* acesso entre tenants;
* token expirado;
* token reutilizado;
* OTP brute force;
* rate limit;
* upload inválido;
* sessão revogada;
* API key revogada;
* webhook replay;
* manipulação de envelope;
* assinatura duplicada.

Multi-tenancy deverá receber atenção especial.

---

# 72. CI/CD

Pipeline deverá executar:

```text
lint
typecheck
tests
build
dependency/security checks
```

Deploy somente depois de validações obrigatórias.

---

# 73. BACKUP

Produção deverá possuir:

* backup PostgreSQL;
* retenção;
* criptografia;
* teste de restauração;
* proteção dos objetos/documentos.

Backup sem teste de restauração não deve ser considerado estratégia completa de recuperação.

---

# 74. OBSERVABILIDADE

Preparar:

* logs estruturados;
* métricas;
* erros;
* health checks;
* filas;
* falhas de webhook.

Posteriormente poderá integrar ferramentas especializadas.

---

# 75. ESTADOS DEVEM SER EXPLÍCITOS

Evitar dezenas de booleanos como:

```text
signed=true
sent=true
expired=false
```

quando uma state machine representar melhor o processo.

Estados e transições devem estar centralizados.

---

# 76. MOTOR DE ASSINATURA

Criar módulo isolado:

```text
SignatureEngine
```

Responsabilidades:

* verificar elegibilidade;
* verificar autenticação;
* verificar consentimento;
* validar documento;
* registrar assinatura;
* produzir evidência;
* atualizar estado;
* registrar auditoria.

Esse módulo não deverá depender diretamente da interface web.

Assim poderá futuramente ser utilizado por:

* frontend;
* API;
* mobile;
* integrações.

---

# 77. AUTENTICAÇÕES FUTURAS

Arquitetura deverá permitir adicionar:

```text
EMAIL
EMAIL_OTP
SMS_OTP
WHATSAPP_OTP
DOCUMENT
SELFIE
BIOMETRICS
CERTIFICATE
ICP_BRASIL
```

Não implementar métodos fictícios.

Somente habilitar um método quando integração real estiver concluída.

---

# 78. ICP-BRASIL

Será fase posterior.

Preparar arquitetura para:

* certificados;
* PAdES;
* cadeia de certificados;
* validação;
* carimbo do tempo;
* LTV quando aplicável.

Não implementar criptografia proprietária fingindo ser ICP-Brasil.

Integração futura deverá seguir padrões e documentação oficial vigentes no momento da implementação.

---

# 79. NÍVEIS DE ASSINATURA

O sistema deverá permitir futuramente classificar os mecanismos utilizados.

Não utilizar marketing enganoso.

A aplicação deverá registrar exatamente:

```text
qual método foi utilizado
qual autenticação ocorreu
quais evidências existem
```

Não transformar automaticamente isso em conclusão jurídica absoluta.

---

# 80. DOCUMENTAÇÃO

Criar:

```text
README.md
docs/
```

Documentar:

* arquitetura;
* instalação;
* desenvolvimento;
* produção;
* variáveis;
* API;
* webhooks;
* storage;
* segurança;
* backup;
* migrations.

---

# 81. OPENAPI

Gerar documentação OpenAPI/Swagger da API.

Documentar:

* parâmetros;
* autenticação;
* respostas;
* erros;
* exemplos.

---

# 82. PADRÃO DE ERROS

Criar estrutura consistente:

```json
{
  "error": {
    "code": "ENVELOPE_NOT_FOUND",
    "message": "Envelope não encontrado.",
    "request_id": "..."
  }
}
```

Não retornar stack trace ao cliente em produção.

---

# 83. INTERNACIONALIZAÇÃO

MVP:

```text
pt-BR
```

Entretanto, textos de interface não deverão ficar espalhados pelos componentes.

Preparar i18n.

---

# 84. ACESSIBILIDADE

Implementar:

* navegação por teclado;
* labels;
* foco visível;
* contraste adequado;
* componentes semanticamente corretos.

A página de assinatura deverá ser especialmente acessível.

---

# 85. MOBILE

A experiência de assinatura deverá ser mobile-first.

Grande parte dos signatários poderá abrir o link diretamente pelo celular.

Evitar exigir aplicativo.

---

# 86. SEGURANÇA HTTP

Configurar adequadamente:

* HTTPS;
* HSTS em produção;
* CSP;
* CORS;
* cookies Secure;
* HttpOnly;
* SameSite;
* proteção CSRF quando aplicável;
* headers de segurança.

---

# 87. SEGREDOS

Utilizar variáveis de ambiente ou secret manager.

Nunca versionar:

```text
.env
private keys
API keys
SMTP passwords
storage secrets
JWT secrets
```

Fornecer:

```text
.env.example
```

somente com nomes e valores fictícios.

---

# 88. CRIPTOGRAFIA

Não inventar algoritmos.

Utilizar bibliotecas consolidadas.

Utilizar primitivas modernas apropriadas.

Nunca implementar manualmente algoritmos criptográficos.

---

# 89. IDs

Preferir UUID ou ULID.

Nunca depender de IDs incrementais públicos para recursos sensíveis.

---

# 90. AUDITORIA ADMINISTRATIVA

Ações administrativas também deverão gerar eventos.

Exemplos:

```text
USER_INVITED
ROLE_CHANGED
API_KEY_CREATED
API_KEY_REVOKED
WEBHOOK_CREATED
ORGANIZATION_SETTINGS_CHANGED
```

---

# 91. DOWNLOADS

Registrar downloads relevantes.

Não necessariamente registrar cada renderização interna do visualizador como download.

Distinguir:

```text
VIEW
DOWNLOAD
```

---

# 92. VISUALIZADOR

Utilizar visualização segura de PDF no navegador.

Não disponibilizar URL permanente pública do arquivo.

---

# 93. ASSINATURA POSICIONADA

Preparar funcionalidade para campos posicionados.

Tipos futuros:

```text
signature
initial
name
cpf
date
text
checkbox
```

Coordenadas deverão considerar:

```text
page
x
y
width
height
```

Não misturar coordenadas CSS diretamente com coordenadas PDF sem transformação definida.

---

# 94. EVENTOS DE DOMÍNIO

Utilizar eventos internos.

Exemplo:

```text
EnvelopeActivated
SignerAuthenticated
SignerSigned
EnvelopeCompleted
```

Notificação e webhook deverão reagir aos eventos.

Evitar acoplamento excessivo.

---

# 95. FINALIZAÇÃO ATÔMICA

Somente marcar:

```text
COMPLETED
```

quando todas as condições forem satisfeitas.

Nunca marcar concluído antes da persistência das evidências essenciais.

---

# 96. FILAS

Jobs deverão ser:

* idempotentes quando possível;
* observáveis;
* retentáveis;
* rastreáveis.

Implementar dead-letter/falhas permanentes de forma administrável.

---

# 97. IDEMPOTÊNCIA DO SIGN

Se o navegador repetir a requisição por problema de rede, não criar duas assinaturas.

Criar chave lógica/constraint para garantir uma única conclusão válida por signatário no mesmo contexto.

---

# 98. PRIVACIDADE DOS LINKS

Nunca colocar dados pessoais no URL.

Errado:

```text
/sign/daniel@email.com/12345678900
```

Correto:

```text
/sign/{opaque_token}
```

---

# 99. SESSÃO DO SIGNATÁRIO

Após validar convite/autenticação, criar sessão limitada ao processo.

Essa sessão não deverá conceder acesso ao dashboard.

---

# 100. VALIDAÇÃO DE DOCUMENTOS

Quando arquivo final for consultado:

```text
recalcular hash
↓
comparar
↓
validar trilha
↓
mostrar resultado
```

Caso não corresponda:

```text
INTEGRIDADE NÃO CONFIRMADA
```

Nunca ocultar falha de validação.

---

# 101. STATUS PÚBLICO

Página pública poderá mostrar somente informações necessárias.

Nunca expor:

* IP completo;
* telefone completo;
* e-mail completo;
* CPF completo;
* dados internos.

Aplicar mascaramento.

---

# 102. TERMOS E POLÍTICAS

Preparar:

```text
TermsVersion
PrivacyPolicyVersion
ConsentVersion
```

Aceites deverão referenciar versão específica.

---

# 103. HISTÓRICO

Usuário deverá conseguir visualizar timeline:

```text
23/09 14:20
Envelope criado

23/09 14:22
Convite enviado

23/09 14:28
Daniel visualizou

23/09 14:30
Daniel autenticado

23/09 14:32
Daniel assinou

23/09 15:05
Envelope concluído
```

---

# 104. BUSCA

Permitir pesquisar por:

* envelope;
* documento;
* signatário;
* código de validação.

Respeitar tenant e permissões.

---

# 105. PAGINAÇÃO

Listagens grandes deverão usar paginação.

Evitar carregar todos os registros.

---

# 106. BANCO — ÍNDICES

Criar índices para campos utilizados frequentemente:

```text
organization_id
status
created_at
email
envelope_id
document_id
public_validation_code
```

Analisar queries antes de criar índices excessivos.

---

# 107. INTEGRIDADE DO BANCO

Utilizar:

* foreign keys;
* unique constraints;
* check constraints quando adequadas.

Não depender exclusivamente da aplicação.

---

# 108. PRIMEIRA ENTREGA

A primeira entrega funcional deverá permitir:

```text
Cadastrar empresa
        ↓
Criar usuário
        ↓
Login
        ↓
Enviar PDF
        ↓
Criar envelope
        ↓
Adicionar signatário
        ↓
Enviar convite
        ↓
Abrir link
        ↓
Receber OTP
        ↓
Validar OTP
        ↓
Visualizar PDF
        ↓
Aceitar termos
        ↓
Assinar
        ↓
Finalizar envelope
        ↓
Gerar evidências
        ↓
Baixar resultado
        ↓
Validar publicamente
```

Esse fluxo deverá funcionar integralmente antes de funcionalidades secundárias.

---

# 109. FASES DO DESENVOLVIMENTO

## FASE 0 — Fundação

* monorepo;
* Docker;
* PostgreSQL;
* Redis;
* storage;
* migrations;
* configuração;
* logging;
* testes;
* CI.

## FASE 1 — SaaS

* auth;
* usuários;
* organizações;
* membros;
* RBAC;
* dashboard.

## FASE 2 — Documentos

* upload;
* storage;
* SHA-256;
* visualização;
* versões.

## FASE 3 — Envelopes

* criação;
* documentos;
* signatários;
* ordem;
* ativação;
* tokens.

## FASE 4 — Assinatura

* página pública;
* OTP;
* consentimento;
* assinatura;
* SignatureEngine.

## FASE 5 — Evidências

* audit events;
* encadeamento;
* relatório;
* finalização.

## FASE 6 — Validação

* código público;
* upload;
* hash;
* página pública.

## FASE 7 — Integrações

* API keys;
* API pública;
* webhooks;
* documentação.

## FASE 8 — Comercial

* planos;
* limites;
* usage;
* billing provider;
* painel Adapter.

## FASE 9 — Hardening

* segurança;
* testes E2E;
* concorrência;
* backups;
* observabilidade;
* performance.

## FASE 10 — Recursos avançados

Somente depois do MVP estável:

* SMS;
* WhatsApp;
* biometria;
* prova de vida;
* assinatura avançada adicional;
* ICP-Brasil;
* PAdES;
* timestamping;
* white label;
* campos posicionáveis;
* templates;
* assinatura em lote.

---

# 110. REGRA DE DESENVOLVIMENTO

O agente responsável pelo desenvolvimento deverá trabalhar fase por fase.

Antes de iniciar uma fase:

1. analisar arquitetura existente;
2. verificar dependências;
3. verificar migrations;
4. verificar impactos;
5. elaborar implementação.

Depois:

1. implementar;
2. executar lint;
3. executar typecheck;
4. executar testes;
5. executar build;
6. corrigir erros;
7. documentar mudanças.

Não iniciar a próxima fase enquanto a anterior estiver quebrada.

---

# 111. NÃO REESCREVER FUNCIONALIDADE FUNCIONANDO

Ao trabalhar em projeto existente:

* inspecionar antes de alterar;
* preservar comportamento válido;
* realizar alterações mínimas necessárias;
* não substituir módulos completos sem justificativa;
* não apagar funcionalidades silenciosamente.

---

# 112. NÃO INVENTAR RESULTADOS

É expressamente proibido afirmar:

```text
teste passou
build passou
endpoint funciona
integração funciona
```

sem realmente executar a verificação correspondente quando o ambiente permitir.

Se não for possível testar, informar claramente.

---

# 113. DEPENDÊNCIAS EXTERNAS

Antes de implementar integração externa:

1. consultar documentação oficial atual;
2. confirmar endpoint;
3. confirmar autenticação;
4. confirmar versão;
5. confirmar ambiente;
6. implementar;
7. tratar erros;
8. testar.

Nunca inventar API baseado apenas em conhecimento presumido.

---

# 114. MIGRATIONS EM PRODUÇÃO

Nunca utilizar comandos destrutivos automaticamente.

Antes de migration destrutiva:

* identificar impacto;
* preservar dados;
* planejar rollback;
* solicitar confirmação quando necessário.

---

# 115. DADOS REAIS

Nunca utilizar documentos reais ou dados pessoais reais como seed padrão.

Testes deverão utilizar dados fictícios.

---

# 116. AMBIENTES

Separar:

```text
development
test
production
```

Cada ambiente deverá possuir configuração independente.

---

# 117. FEATURE FLAGS

Funcionalidades experimentais poderão utilizar feature flags.

Exemplo:

```text
SMS_AUTH
WHATSAPP_AUTH
ICP_BRASIL
BIOMETRICS
WHITE_LABEL
```

Não mostrar recurso incompleto ao usuário de produção.

---

# 118. PERFORMANCE

Evitar processamento pesado dentro da request HTTP.

Utilizar worker para:

* PDFs;
* relatórios;
* notificações;
* webhooks;
* processamento secundário.

---

# 119. DOCUMENTOS GRANDES

Upload deverá possuir limite configurável.

Não carregar PDFs grandes inteiros na memória sem necessidade.

Utilizar streams quando adequado.

---

# 120. SEGURANÇA MULTITENANT

Toda query empresarial deverá considerar:

```text
organization_id
```

Nunca implementar:

```text
findUnique(id)
```

seguido de confiança implícita de que o registro pertence ao usuário.

Validar explicitamente escopo e autorização.

---

# 121. REGISTRO DE AUTORIA

O sistema deverá conseguir demonstrar tecnicamente:

```text
qual documento
qual hash
qual envelope
qual signatário
qual autenticação
qual consentimento
qual horário
qual sequência de eventos
```

sem transformar automaticamente isso em alegação jurídica absoluta.

---

# 122. ASSINATURA NÃO É IMAGEM

Princípio central do projeto:

> A representação visual da assinatura não constitui, sozinha, o mecanismo de confiança.

O valor técnico está no conjunto:

```text
identificação
+
autenticação
+
consentimento
+
integridade
+
eventos
+
hash
+
evidências
```

---

# 123. PROIBIÇÕES ARQUITETURAIS

Não utilizar:

* localStorage para segredos;
* senhas reversíveis;
* token eterno;
* bucket público;
* IDs previsíveis como autenticação;
* OTP sem limite;
* segredo dentro do repositório;
* logs contendo documentos;
* validação exclusivamente frontend;
* trust no organization_id enviado pelo cliente;
* criptografia caseira.

---

# 124. CRITÉRIO DE MVP CONCLUÍDO

O MVP somente poderá ser considerado concluído quando:

* dois usuários/tenants não conseguirem acessar dados um do outro;
* upload funcionar;
* hash funcionar;
* envelope funcionar;
* convite funcionar;
* OTP funcionar;
* assinatura funcionar;
* auditoria funcionar;
* relatório funcionar;
* download funcionar;
* validação funcionar;
* expiração funcionar;
* cancelamento funcionar;
* rate limiting funcionar;
* API possuir documentação;
* backup estiver definido;
* testes principais passarem;
* deploy Docker funcionar.

---

# 125. ROADMAP POSTERIOR

Após estabilização:

### Adapter Sign Advanced

* autenticação reforçada;
* documento;
* selfie;
* biometria;
* prova de vida.

### Adapter Sign Certificate

* certificado digital;
* ICP-Brasil;
* PAdES;
* carimbo do tempo;
* validação avançada.

### Adapter Sign API

* assinatura embutida;
* API completa;
* SDK;
* webhooks;
* integração empresarial.

### Adapter Sign Enterprise

* white label;
* domínio próprio;
* SSO;
* políticas;
* múltiplos departamentos;
* auditoria avançada.

---

# 126. PRIORIDADE ABSOLUTA

A prioridade é:

```text
SEGURANÇA
    ↓
INTEGRIDADE
    ↓
RASTREABILIDADE
    ↓
CONFIABILIDADE
    ↓
EXPERIÊNCIA
    ↓
FUNCIONALIDADES EXTRAS
```

Não sacrificar integridade do processo para acelerar implementação.

---

# 127. ORIENTAÇÃO FINAL AO AGENTE

Antes de escrever código, leia este documento integralmente.

Analise o repositório existente.

Não assuma que algo existe.

Não invente APIs.

Não invente respostas.

Não implemente simulações como produção.

Não remova funcionalidades existentes sem necessidade.

Quando encontrar ambiguidade que afete:

* segurança;
* arquitetura;
* banco;
* assinatura;
* integridade;
* cobrança;
* dados pessoais;

não tome decisão irreversível silenciosamente.

Escolha soluções consolidadas, simples e auditáveis.

O sistema deverá ser construído como um produto comercial real e não como demonstração.

A primeira meta é entregar um fluxo completo e confiável:

**documento → envelope → autenticação → consentimento → assinatura → evidências → conclusão → validação.**

Somente depois expandir funcionalidades.