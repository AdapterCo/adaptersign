'use client';

import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/format';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/components/session';
import { Alert, Button, Card, ErrorMessage, Field, Input, PageHeader, Select, Spinner } from '@/components/ui';

type Tab = 'organization' | 'members' | 'apiKeys' | 'webhooks' | 'companySignature' | 'security';

interface CompanySignatureStatus {
  authorized: boolean;
  authorizedAt: string | null;
  authorizedBy: string | null;
  acceptedVersion: string | null;
  text: { version: string; content: string; sha256: string };
}

function CompanySignatureTab() {
  const { can } = useSession();
  const owner = can('org:settings');
  const { data, setData } = useApi<CompanySignatureStatus>('/organizations/current/company-signature');
  const [accepted, setAccepted] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const { busy, error, run } = useAction();
  if (!data) return <Spinner label={t.common.loading} />;
  return (
    <Card title={t.companySignature.title}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t.companySignature.intro}</p>
        {data.authorized ? (
          <Alert tone="ok">{t.companySignature.authorized(data.authorizedBy ?? '—', data.authorizedAt ? formatDateTime(data.authorizedAt) : '—')}</Alert>
        ) : (
          <Alert tone="warn">{t.companySignature.notAuthorized}</Alert>
        )}
        <blockquote className="rounded-lg border border-line bg-canvas p-4 text-sm leading-relaxed">
          {data.text.content}
          <span className="mt-2 block text-xs text-muted">{t.companySignature.version(data.text.version)}</span>
        </blockquote>
        {!owner && <p className="text-xs text-muted">{t.companySignature.ownerOnly}</p>}
        {owner && !data.authorized && (
          <>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              <span>{t.companySignature.accept}</span>
            </label>
            <div>
              <Button
                loading={busy}
                disabled={!accepted}
                onClick={() =>
                  void run(async () => {
                    setData(await api<CompanySignatureStatus>('/organizations/current/company-signature', { method: 'POST', body: { accept: true, version: data.text.version } }));
                    setAccepted(false);
                  })
                }
              >
                {t.companySignature.authorize}
              </Button>
            </div>
          </>
        )}
        {owner && data.authorized && !confirmRevoke && (
          <div>
            <Button variant="danger" onClick={() => setConfirmRevoke(true)}>
              {t.companySignature.revoke}
            </Button>
          </div>
        )}
        {owner && data.authorized && confirmRevoke && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">{t.companySignature.revokeConfirm}</p>
            <div className="flex gap-2">
              <Button
                variant="danger"
                loading={busy}
                onClick={() =>
                  void run(async () => {
                    setData(await api<CompanySignatureStatus>('/organizations/current/company-signature', { method: 'DELETE' }));
                    setConfirmRevoke(false);
                  })
                }
              >
                {t.common.confirm}
              </Button>
              <Button variant="secondary" onClick={() => setConfirmRevoke(false)}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        )}
        <ErrorMessage error={error} />
      </div>
    </Card>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function OrganizationTab() {
  const { can, reload: reloadMe } = useSession();
  const { data, reload } = useApi<{ name: string; plan: { name: string; limits: Record<string, unknown> } }>('/organizations/current');
  const [name, setName] = useState('');
  const { busy, error, run } = useAction();
  if (!data) return <Spinner label={t.common.loading} />;
  return (
    <Card title={t.settings.organization}>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/organizations/current', { method: 'PATCH', body: { name } });
            await Promise.all([reload(), reloadMe()]);
          });
        }}
      >
        <div className="flex-1">
          <Field label={t.settings.orgName}>{(id) => <Input id={id} defaultValue={data.name} onChange={(e) => setName(e.target.value)} disabled={!can('org:settings')} />}</Field>
        </div>
        {can('org:settings') && (
          <Button type="submit" loading={busy} disabled={!name}>
            {t.common.save}
          </Button>
        )}
      </form>
      <p className="mt-4 text-sm text-muted">
        {t.dashboard.plan}: <strong>{data.plan.name}</strong>
      </p>
      <div className="mt-3">
        <ErrorMessage error={error} />
      </div>
    </Card>
  );
}

function MembersTab() {
  const { me, can } = useSession();
  const { data, reload } = useApi<Array<{ id: string; role: string; user: { id: string; name: string; email: string } }>>('/organizations/current/members');
  const [form, setForm] = useState({ name: '', email: '', role: 'MEMBER' });
  const { busy, error, run } = useAction();
  const manage = can('members:manage');
  return (
    <Card title={t.settings.members}>
      <ErrorMessage error={error} />
      <ul className="my-3 divide-y divide-line">
        {data?.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div>
              <p className="font-medium">{m.user.name}</p>
              <p className="text-sm text-muted">{m.user.email}</p>
            </div>
            <div className="flex items-center gap-2">
              {manage && m.user.id !== me?.user.id ? (
                <>
                  <label className="sr-only" htmlFor={`role-${m.id}`}>
                    {t.settings.role}
                  </label>
                  <Select
                    id={`role-${m.id}`}
                    value={m.role}
                    className="w-40"
                    onChange={(e) => void run(async () => {
                      await api(`/organizations/current/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } });
                      await reload();
                    })}
                  >
                    {Object.entries(t.memberRoles).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                  <Button variant="ghost" onClick={() => void run(async () => {
                    await api(`/organizations/current/members/${m.id}`, { method: 'DELETE' });
                    await reload();
                  })}>
                    {t.settings.removeMember}
                  </Button>
                </>
              ) : (
                <span className="text-sm">{t.memberRoles[m.role]}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {manage && (
        <form
          className="grid gap-3 border-t border-line pt-4 sm:grid-cols-4 sm:items-end"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run(async () => {
              await api('/organizations/current/members', { method: 'POST', body: form });
              setForm({ name: '', email: '', role: 'MEMBER' });
              await reload();
            });
          }}
        >
          <Field label={t.auth.name}>{(id) => <Input id={id} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          <Field label={t.auth.email}>{(id) => <Input id={id} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
          <Field label={t.settings.role}>
            {(id) => (
              <Select id={id} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {Object.entries(t.memberRoles).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" loading={busy}>
            {t.settings.invite}
          </Button>
        </form>
      )}
    </Card>
  );
}

function ApiKeysTab() {
  const { data, reload } = useApi<Array<{ id: string; name: string; prefix: string; role: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }>>('/api-keys');
  const [name, setName] = useState('');
  const [role, setRole] = useState('MEMBER');
  const [created, setCreated] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  return (
    <Card title={t.settings.apiKeys}>
      <ErrorMessage error={error} />
      {created && (
        <Alert tone="warn">
          <p className="font-semibold">{t.settings.keyShownOnce}</p>
          <code className="mt-2 block font-mono text-xs break-all">{created}</code>
        </Alert>
      )}
      <form
        className="my-4 grid gap-3 sm:grid-cols-3 sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await api<{ key: string }>('/api-keys', { method: 'POST', body: { name, role } });
            setCreated(r.key);
            setName('');
            await reload();
          });
        }}
      >
        <Field label={t.settings.keyName}>{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={t.settings.role}>
          {(id) => (
            <Select id={id} value={role} onChange={(e) => setRole(e.target.value)}>
              {['ADMIN', 'MEMBER', 'VIEWER'].map((r) => (
                <option key={r} value={r}>
                  {t.memberRoles[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" loading={busy}>
          {t.settings.newKey}
        </Button>
      </form>
      <ul className="divide-y divide-line">
        {data?.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
            <div>
              <p className="font-medium">{k.name}</p>
              <p className="font-mono text-xs text-muted">
                {k.prefix}_… · {t.memberRoles[k.role]} · {t.settings.lastUsed}: {formatDateTime(k.lastUsedAt)}
              </p>
            </div>
            {k.revokedAt ? (
              <span className="text-muted">{t.settings.revoked}</span>
            ) : (
              <Button variant="ghost" onClick={() => void run(async () => {
                await api(`/api-keys/${k.id}`, { method: 'DELETE' });
                await reload();
              })}>
                {t.settings.revoke}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function WebhooksTab() {
  const { data: events } = useApi<string[]>('/webhooks/events');
  const { data, reload } = useApi<Array<{ id: string; url: string; events: string[]; active: boolean; secretPrefix: string }>>('/webhooks');
  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  return (
    <Card title={t.settings.webhooks}>
      <ErrorMessage error={error} />
      {secret && (
        <Alert tone="warn">
          <p className="font-semibold">{t.settings.secretShownOnce}</p>
          <code className="mt-2 block font-mono text-xs break-all">{secret}</code>
        </Alert>
      )}
      <form
        className="my-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await api<{ secret: string }>('/webhooks', { method: 'POST', body: { url, events: selected } });
            setSecret(r.secret);
            setUrl('');
            setSelected([]);
            await reload();
          });
        }}
      >
        <Field label={t.settings.webhookUrl}>{(id) => <Input id={id} type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />}</Field>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">{t.settings.webhookEvents}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {events?.map((ev) => (
              <label key={ev} className="flex items-center gap-2 font-mono text-xs">
                <input type="checkbox" className="h-4 w-4" checked={selected.includes(ev)} onChange={(e) => setSelected(e.target.checked ? [...selected, ev] : selected.filter((x) => x !== ev))} />
                {ev}
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" loading={busy} disabled={selected.length === 0} className="self-start">
          {t.settings.newWebhook}
        </Button>
      </form>
      <ul className="divide-y divide-line">
        {data?.map((w) => (
          <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
            <div className="min-w-0">
              <p className="font-medium break-all">{w.url}</p>
              <p className="font-mono text-xs text-muted">
                {w.secretPrefix}… · {w.events.join(', ')}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => void run(async () => {
                const r = await api<{ secret: string }>(`/webhooks/${w.id}/rotate-secret`, { method: 'POST' });
                setSecret(r.secret);
              })}>
                {t.settings.rotateSecret}
              </Button>
              <Button variant="ghost" onClick={() => void run(async () => {
                await api(`/webhooks/${w.id}`, { method: 'DELETE' });
                await reload();
              })}>
                {t.common.remove}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SecurityTab() {
  const { data, reload } = useApi<Array<{ id: string; ip: string | null; userAgent: string | null; lastUsedAt: string; current: boolean }>>('/auth/sessions');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <div className="flex flex-col gap-6">
      <ErrorMessage error={error} />
      <Card
        title={t.settings.sessions}
        actions={
          <Button variant="danger" onClick={() => void run(async () => {
            await api('/auth/logout-all', { method: 'POST' });
            window.location.href = '/login';
          })}>
            {t.settings.endAll}
          </Button>
        }
      >
        <ul className="divide-y divide-line text-sm">
          {data?.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate">{s.userAgent ?? '—'}</p>
                <p className="text-xs text-muted">
                  {s.ip} · {formatDateTime(s.lastUsedAt)} {s.current && `· ${t.settings.currentSession}`}
                </p>
              </div>
              {!s.current && (
                <Button variant="ghost" onClick={() => void run(async () => {
                  await api(`/auth/sessions/${s.id}`, { method: 'DELETE' });
                  await reload();
                })}>
                  {t.settings.endSession}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card title={t.settings.changePassword}>
        {done && <Alert tone="ok">{t.auth.resetDone}</Alert>}
        <form
          className="mt-3 grid gap-3 sm:grid-cols-3 sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/auth/password/change', { method: 'POST', body: pw });
              setPw({ currentPassword: '', newPassword: '' });
              setDone(true);
            });
          }}
        >
          <Field label={t.settings.currentPassword}>
            {(id) => <Input id={id} type="password" autoComplete="current-password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />}
          </Field>
          <Field label={t.auth.newPassword}>
            {(id) => <Input id={id} type="password" autoComplete="new-password" minLength={10} required value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />}
          </Field>
          <Button type="submit" loading={busy}>
            {t.common.save}
          </Button>
        </form>
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  const { can } = useSession();
  const tabs: Array<{ id: Tab; label: string; show: boolean }> = [
    { id: 'organization', label: t.settings.organization, show: true },
    { id: 'members', label: t.settings.members, show: can('members:read') },
    { id: 'apiKeys', label: t.settings.apiKeys, show: can('api_keys:manage') },
    { id: 'webhooks', label: t.settings.webhooks, show: can('webhooks:manage') },
    { id: 'companySignature', label: t.companySignature.tab, show: can('envelope:read') },
    { id: 'security', label: t.settings.security, show: true },
  ];
  const [tab, setTab] = useState<Tab>('organization');
  return (
    <>
      <PageHeader title={t.settings.title} />
      <div role="tablist" aria-label={t.settings.title} className="mb-6 flex flex-wrap gap-2">
        {tabs
          .filter((x) => x.show)
          .map((x) => (
            <button
              key={x.id}
              role="tab"
              aria-selected={tab === x.id}
              onClick={() => setTab(x.id)}
              className={`min-h-11 rounded-lg px-4 text-sm font-semibold ${tab === x.id ? 'bg-brand text-white' : 'bg-white text-ink hover:bg-brand-soft'}`}
            >
              {x.label}
            </button>
          ))}
      </div>
      {tab === 'organization' && <OrganizationTab />}
      {tab === 'members' && <MembersTab />}
      {tab === 'apiKeys' && <ApiKeysTab />}
      {tab === 'webhooks' && <WebhooksTab />}
      {tab === 'companySignature' && <CompanySignatureTab />}
      {tab === 'security' && <SecurityTab />}
    </>
  );
}
