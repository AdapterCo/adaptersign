# Segurança e LGPD

## Controles implementados

| Área | Controle |
| --- | --- |
| Senhas | Argon2id (m=19 MiB, t=2, p=1), rehash automático, tempo constante para usuário inexistente |
| Sessões | Access JWT HS256 (15 min) + refresh opaco rotativo; reuso de refresh revoga a sessão; logout-all; sessão revalidada a cada requisição |
| Cookies | HttpOnly, Secure (obrigatório em produção), SameSite=Lax; refresh restrito ao path `/api/v1/auth`; sessão do signatário restrita a `/api/v1/sign` |
| CSRF | SameSite + verificação de `Origin`/`Referer` em métodos que alteram estado com cookie |
| Tenant | `organization_id` derivado da sessão ou API key; todas as consultas filtram por tenant; recursos de outro tenant retornam 404 |
| RBAC | Papéis → permissões (`common/auth/auth-context.ts`), aplicados por guard global |
| Tokens | 256 bits de CSPRNG; somente HMAC-SHA256 (com pepper) persistido: links, sessões, refresh, reset, API keys, OTP |
| OTP | 6 dígitos (CSPRNG), 10 min, 5 tentativas, cooldown 60 s, rate limit por IP e por signatário, uso único, nunca logado; viaja ao worker cifrado |
| Rate limiting | Redis (janela fixa atômica): login, cadastro, reset, OTP, assinatura, validação, upload, API key, usuário |
| Upload | extensão + Content-Type + magic bytes + estrutura (pdf-lib) + tamanho; PDFs cifrados recusados; ponto de integração para antivírus |
| Assinatura da empresa pela integração | só com autorização vigente do OWNER (texto versionado, revogável); só para papéis da empresa criados pela integração (`authMethod INTEGRATION`, nunca selecionável manualmente); evidência registra empresa, representante, chave de API e autorização; esses signatários nunca recebem convite nem link |
| WhatsApp | número central via Evolution API (chave só no servidor, nunca logada); telefones normalizados em E.164 e mascarados em telas/auditoria; o código vai pelo canal do link e o método efetivo (e-mail ou WhatsApp) é o registrado na evidência; código de WhatsApp nunca atende a um signatário configurado para "código por WhatsApp" via e-mail |
| Links pela API | o link individual só aparece na resposta (nunca armazenado em claro; apenas o hash do token); cada emissão é auditada |
| Leitura de texto (âncoras) | pdf.js com `isEvalSupported: false`, sem fontes do sistema/FontFace, limite de 300 páginas; PDF tratado como conteúdo não confiável |
| Integridade | SHA-256 do original; objetos imutáveis (`If-None-Match`); versões imutáveis (trigger); recálculo na finalização e na validação |
| Auditoria | append-only (trigger), encadeamento SHA-256 com serialização canônica, horário do servidor (UTC) |
| Busca por CPF | índice cego: HMAC-SHA256 (pepper `TOKEN_HASH_SECRET`) do CPF normalizado em `signers.cpf_hash`; a busca nunca decifra CPFs nem os devolve completos; CPF sem correspondência retorna lista vazia |
| Dados pessoais | CPF cifrado (AES-256-GCM) + últimos 2 dígitos; e-mail, CPF, IP e nome mascarados em páginas públicas e relatórios |
| Webhooks | HMAC-SHA256 com timestamp e event id; segredo cifrado; SSRF bloqueado; sem armazenar respostas |
| HTTP | Helmet (CSP `default-src 'none'` na API, HSTS em produção, no-referrer), CORS restrito, `trust proxy` explícito |
| Logs | JSON estruturado; redação de Authorization, cookies, senhas, OTP, tokens, chaves e imagens de assinatura; URL sem query |
| Erros | sem stack trace para o cliente; `request_id` para correlação |
| Configuração | validação na inicialização; valores de exemplo, HTTP e cookies inseguros são recusados em produção |
| Admin | painel da plataforma só com metadados (sem acesso a documentos); ações auditadas |

## Limitações conhecidas (tratar antes de escalar)

- **DNS rebinding em webhooks**: o IP é validado na resolução, mas a conexão resolve de novo. Mitigue com política de egress (firewall) no host.
- **Rate limit de janela fixa**: permite rajadas na virada da janela. Suficiente para o MVP.
- **MFA administrativo**: o modelo está preparado (`users.mfa_enabled`), mas não está implementado.
- **Antivírus**: não integrado; o ponto de extensão está em `DocumentsService.validate`.
- **PDF em memória**: uploads de até `UPLOAD_MAX_BYTES` (padrão 20 MB) são processados em memória, porque o pdf-lib exige o buffer inteiro.

## Níveis de assinatura

O sistema registra exatamente o método (nome digitado ou desenhado), a autenticação (link por e-mail ou OTP por
e-mail), o aceite versionado e as evidências. Não converte isso em conclusão jurídica. Os mecanismos atuais
correspondem a **assinatura eletrônica simples**, com evidências adicionais. Métodos avançados e ICP-Brasil
(PAdES, carimbo do tempo, LTV) estão previstos para fases futuras, seguindo a documentação oficial vigente, e
aparecem como **indisponíveis** na interface.

## LGPD

- **Minimização**: CPF e telefone são opcionais; o webhook só envia dados que a própria organização já possui;
  a validação pública mostra apenas dados mascarados.
- **Finalidade e transparência**: o texto de aceite (versionado) informa o que é registrado.
- **Segurança**: cifra de dados sensíveis, controle de acesso e trilhas de auditoria.
- **Retenção**: campos `retention_days` em planos e organizações preparam a política. **Nenhuma evidência é
  apagada automaticamente**; uma rotina de expurgo deve ser definida por política explícita (jurídico e contrato)
  antes de ser implementada.
- **Direitos do titular**: acesso e correção são feitos pela organização controladora. A exclusão deve
  considerar as obrigações legais de guarda das evidências; soft delete (`deleted_at`) não substitui a política
  de exclusão ou anonimização.
- **Textos legais**: termos de uso e política de privacidade devem ser redigidos pelo jurídico e cadastrados
  como novas versões em `modules/legal/legal-texts.ts`. Nenhum texto genérico foi inventado.
