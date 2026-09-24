'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

export interface Me {
  user: { id: string; name: string; email: string; emailVerified: boolean; isPlatformAdmin: boolean };
  organization: { id: string; name: string; slug: string } | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  permissions: string[];
  organizations: Array<{ id: string; name: string; slug: string; role: string }>;
}

interface SessionCtx {
  me: Me | null;
  reload: () => Promise<void>;
  can: (permission: string) => boolean;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  const reload = useCallback(async () => {
    try {
      setMe(await api<Me>('/auth/me'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) router.replace('/login');
      else throw err;
    }
  }, [router]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const can = useCallback((p: string) => !!me?.permissions.includes(p), [me]);
  return <Ctx.Provider value={{ me, reload, can }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession fora do SessionProvider');
  return ctx;
}
