import { redirect } from 'next/navigation';

// A área autenticada valida a sessão no cliente e redireciona para /login quando necessário.
export default function Home() {
  redirect('/dashboard');
}
