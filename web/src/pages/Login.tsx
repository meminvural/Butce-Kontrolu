import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { ErrorText, Field } from '../components/ui';

export default function Login() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    const res = mode === 'in'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (res.error) return setError(res.error.message);
    if (mode === 'up' && !res.data.session) setInfo('Hesap oluşturuldu. E-postanıza gelen bağlantıyla doğrulayıp giriş yapın.');
  };

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand"><img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={32} height={32} /><span>Bütçe Defteri</span></div>
        <p className="muted">Tüm hesaplarınız, kartlarınız ve borçlarınız tek defterde.</p>
        <form className="form" onSubmit={submit}>
          <Field label="E-posta">
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Parola" hint={mode === 'up' ? 'En az 8 karakter.' : undefined}>
            <input type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} minLength={8}
              required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <ErrorText error={error} />
          {info && <p className="ok">{info}</p>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Bekleyin…' : mode === 'in' ? 'Giriş yap' : 'Hesap oluştur'}
          </button>
        </form>
        <button className="link-btn small" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
          {mode === 'in' ? 'Hesabınız yok mu? Kayıt olun' : 'Zaten hesabınız var mı? Giriş yapın'}
        </button>
      </div>
    </div>
  );
}
