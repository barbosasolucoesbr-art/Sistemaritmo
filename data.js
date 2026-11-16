/* Ritmo data layer: local durability, account isolation, offline queue, revision checks. */
(function () {
  'use strict';
  const PROJECT_URL = 'https://yndqagqgbimmoymlatgi.supabase.co';
  const PUBLIC_KEY = 'sb_publishable_izs44BFTff3DEwtVVZheqg_8GhdsGxN';
  const clone = v => structuredClone(v);
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])) : v;
  const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  function merge(base, local, remote) {
    if (equal(local, remote)) return { value: local };
    if (equal(local, base)) return { value: remote };
    if (equal(remote, base)) return { value: local };
    if (object(local) && object(remote) && (object(base) || base == null)) {
      const value = {};
      for (const key of new Set([...Object.keys(base || {}), ...Object.keys(local), ...Object.keys(remote)])) {
        const part = merge(base?.[key], local[key], remote[key]);
        if (part.conflict) return { conflict: true };
        if (part.value !== undefined) value[key] = part.value;
      }
      return { value };
    }
    return { conflict: true };
  }
  let db, memory = { records: {}, meta: {} }, client, session = null, defaults;
  let status = 'local', error = '', lastSync = null, syncFlight = null, syncTimer, serial = Promise.resolve();
  const listeners = new Set();
  let recoveryPending = false;
  const owner = () => session?.user?.id || 'guest';
  const emit = type => {
    if (type === 'recovery' && !listeners.size) { recoveryPending = true; return; }
    listeners.forEach(fn => fn({ type, status, error, session, lastSync }));
  };
  const uid = () => crypto.randomUUID();
  const enqueue = fn => { const p = serial.then(fn); serial = p.catch(() => {}); return p; };
  function setStatus(value, detail = '') { status = value; error = detail; emit('status'); }
  function message(err) {
    const code = err?.code || '';
    if (!navigator.onLine) return 'Sem internet. Seus registros estão guardados neste aparelho.';
    if (code === 'email_not_confirmed') return 'Confirme seu e-mail antes de entrar.';
    if (code === 'invalid_credentials') return 'Confira o e-mail e a senha.';
    if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit') return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
    if (code === 'email_address_not_authorized') return 'O envio de e-mails deste projeto está restrito. Use o e-mail da conta responsável pelo Supabase.';
    if (code === 'weak_password') return 'Escolha uma senha mais forte, com pelo menos 8 caracteres.';
    if (code === 'signup_disabled') return 'O cadastro está desativado neste projeto.';
    if (code === 'PGRST301' || code === 'PGRST303' || code === 'bad_jwt' || err?.status === 401) return 'Entre novamente para sincronizar. Seus registros locais foram preservados.';
    if (/fetch|network|load failed/i.test(err?.message || '')) return 'Não foi possível conectar. Seus registros continuam guardados neste aparelho.';
    return 'Não foi possível concluir agora. Tente novamente; seus registros locais foram preservados.';
  }
  async function openDB() {
    try {
      db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('ritmo-cloud-v2', 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('records', { keyPath: 'id' });
          r.result.createObjectStore('meta', { keyPath: 'key' });
        };
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
        r.onblocked = () => reject(Error('Storage blocked'));
      });
    } catch {
      db = null;
      try { memory = JSON.parse(localStorage.getItem('ritmo-cloud-v2') || '{"records":{},"meta":{}}'); } catch {}
    }
  }
  async function all(store) {
    if (!db) return clone(Object.values(memory[store]));
    return new Promise((resolve, reject) => {
      const r = db.transaction(store).objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  }
  async function change(store, key, update) {
    if (!db) {
      const value = update(clone(memory[store][key]));
      const next = { ...memory, [store]: { ...memory[store] } };
      if (value !== undefined) next[store][key] = value;
      localStorage.setItem('ritmo-cloud-v2', JSON.stringify(next));
      memory = next;
      return clone(value);
    }
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, 'readwrite'), s = t.objectStore(store), r = s.get(key);
      let value;
      r.onsuccess = () => { try { value = update(r.result); if (value !== undefined) s.put(value); } catch (e) { t.abort(); reject(e); } };
      t.oncomplete = () => resolve(value); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error || Error('Storage transaction cancelled'));
    });
  }
  const records = async who => (await all('records')).filter(r => r.owner === who);
  const meta = async key => (await all('meta')).find(r => r.key === key)?.value;
  const setMeta = (key, value) => change('meta', key, () => ({ key, value }));
  async function write(who, key, data, deleted = false) {
    await change('records', `${who}|${key}`, previous => ({
      id: `${who}|${key}`, owner: who, key, data: deleted ? null : clone(data), deleted,
      revision: previous?.hidden ? 0 : previous?.revision || 0, baseData: previous?.hidden ? null : previous?.baseData ?? null, hidden: false,
      dirty: true, stamp: uid(), conflict: previous?.hidden ? null : previous?.conflict || null,
      updatedAt: new Date().toISOString()
    }));
  }
  async function migrateLegacy() {
    if (await meta('legacyImported')) return;
    let legacy = { days: {}, settings: null };
    try { legacy = JSON.parse(localStorage.getItem('ritmo-fallback') || 'null') || legacy; } catch {}
    try {
      const old = await new Promise((resolve, reject) => {
        const r = indexedDB.open('ritmo-saude-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      for (const name of ['days', 'config']) if (old.objectStoreNames.contains(name)) {
        const rows = await new Promise((resolve, reject) => {
          const r = old.transaction(name).objectStore(name).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
        });
        if (name === 'days') legacy.days = { ...legacy.days, ...Object.fromEntries(rows.map(r => [r.date, r])) };
        else legacy.settings = rows.find(r => r.key === 'settings')?.value || legacy.settings;
      }
      old.close();
    } catch {}
    for (const [key, value] of Object.entries(legacy.days || {})) if (/^\d{4}-\d{2}-\d{2}$/.test(key)) await write('guest', 'day:' + key, value);
    if (legacy.settings) await write('guest', 'settings', legacy.settings);
    await setMeta('legacyImported', true);
  }
  async function snapshot() {
    await serial;
    const who = owner();
    const rows = (await records(who)).filter(r=>!r.hidden);
    const days = {}, settings = rows.find(r => r.key === 'settings' && !r.deleted)?.data || clone(defaults);
    for (const r of rows) if (r.key.startsWith('day:') && !r.deleted) days[r.key.slice(4)] = clone(r.data);
    return { days, settings: clone(settings), pending: rows.filter(r => r.dirty).length, conflicts: rows.filter(r => r.conflict) };
  }
  function schedule() {
    clearTimeout(syncTimer);
    if (session) { setStatus(navigator.onLine ? 'pending' : 'offline'); syncTimer = setTimeout(() => sync(), 500); }
  }
  async function put(key, data, deleted = false) {
    const who = owner();
    await enqueue(() => write(who, key, data, deleted));
    if (who === owner()) schedule();
  }
  function remoteRecord(who, r) {
    return { id: `${who}|${r.record_key}`, owner: who, key: r.record_key, data: r.data,
      deleted: r.deleted, revision: r.revision, baseData: r.data, dirty: false,
      stamp: uid(), conflict: null, updatedAt: r.updated_at };
  }
  function sync() {
    if (!syncFlight) syncFlight = performSync().finally(() => { syncFlight = null; });
    return syncFlight;
  }
  async function performSync() {
    if (!client || !session) return;
    if (!navigator.onLine) { setStatus('offline'); return; }
    const who = owner(); setStatus('syncing');
    try {
      const queue = (await records(who)).filter(r => r.dirty && !r.conflict);
      for (const item of queue) {
        if (who !== owner()) return;
        const { data: result, error: fault } = await client.rpc('ritmo_save_record', {
          p_key: item.key, p_data: item.data, p_expected_revision: item.revision, p_deleted: item.deleted
        });
        if (fault) throw fault;
        await enqueue(() => change('records', item.id, current => {
          if (!current) return;
          if (result.ok) {
            if (current.stamp === item.stamp) return remoteRecord(who, result.record);
            return { ...current, revision: result.record.revision, baseData: result.record.data };
          }
          const remote = result.record;
          const merged = merge(current.baseData, current.deleted ? null : current.data, remote?.deleted ? null : remote?.data);
          if (!merged.conflict) return { ...current, data: merged.value ?? null, deleted: merged.value == null,
            revision: remote?.revision || 0, baseData: remote?.data ?? null, stamp: uid(), conflict: null };
          return { ...current, conflict: { remote, detectedAt: new Date().toISOString() } };
        }));
      }
      let offset = 0, more = true;
      while (more && who === owner()) {
        const { data, error: fault } = await client.from('ritmo_records').select('record_key,data,deleted,revision,updated_at')
          .eq('user_id', who).order('record_key').range(offset, offset + 499);
        if (fault) throw fault;
        for (const r of data) await enqueue(() => change('records', `${who}|${r.record_key}`, current => {
          if (current?.dirty) return current;
          return remoteRecord(who, r);
        }));
        more = data.length === 500; offset += 500;
      }
      if (who !== owner()) return;
      lastSync = new Date().toISOString(); await setMeta('lastSync:' + who, lastSync);
      const pending = (await records(who)).filter(r => r.dirty);
      setStatus(pending.some(r => r.conflict) ? 'conflict' : pending.length ? 'pending' : 'synced');
      emit('data');
      if (pending.some(r => !r.conflict)) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 700); }
    } catch (e) { if (who === owner()) setStatus(navigator.onLine ? 'error' : 'offline', message(e)); }
  }
  async function resolveConflict(key, useLocal) {
    const who = owner();
    await enqueue(() => change('records', `${who}|${key}`, current => {
      if (!current?.conflict) return current;
      const remote = current.conflict.remote;
      if (!useLocal && remote) return remoteRecord(who, remote);
      if (!useLocal) return { ...current, data: null, deleted: true, revision: 0, dirty: false, conflict: null };
      return { ...current, revision: remote?.revision || 0, baseData: remote?.data ?? null, conflict: null, stamp: uid(), dirty: true };
    }));
    emit('data'); schedule();
  }
  async function importAll(data) {
    const who = owner();
    if (session) {
      if (!navigator.onLine) throw Error('Conecte à internet antes de substituir os registros da conta.');
      await sync();
      if (who !== owner()) throw Error('A conta mudou. Abra o backup novamente na conta correta.');
      if (status !== 'synced') throw Error('Conclua a sincronização e resolva as diferenças antes de substituir os registros.');
    }
    await enqueue(async () => {
      for (const r of await records(who)) if (r.key.startsWith('day:') && !r.deleted && !data.days[r.key.slice(4)]) await write(who, r.key, null, true);
      for (const [day, value] of Object.entries(data.days)) await write(who, 'day:' + day, value);
      await write(who, 'settings', data.settings);
    });
    emit('data'); if (who === owner()) schedule();
  }
  async function hasGuestData() {
    const rows = (await records('guest')).filter(r => !r.deleted && !r.hidden);
    return rows.some(r => r.key.startsWith('day:') || !equal(r.data, defaults));
  }
  async function importGuest() {
    if (!session || !await hasGuestData()) return;
    const who = owner();
    await enqueue(async () => {
      const local = (await records('guest')).filter(r => !r.deleted && !r.hidden);
      const own = await records(who);
      for (const item of local) {
        const existing = own.find(r => r.key === item.key && !r.deleted);
        if (!existing) await write(who, item.key, item.data);
        else if (!equal(existing.data, item.data)) await change('records', `${who}|${item.key}`, current => ({
          ...current, data: item.data, dirty: true, stamp: uid(), conflict: { remote: {
            record_key: current.key, data: current.data, deleted: current.deleted,
            revision: current.revision, updated_at: current.updatedAt
          }, detectedAt: new Date().toISOString() }
        }));
      }
      for (const item of local) await change('records', item.id, current => current?.stamp === item.stamp ? {...current, hidden:true} : current);
    });
    await setMeta('guestClaimed', who); emit('data'); schedule();
  }
  async function init(initial) {
    defaults = clone(initial); await openDB(); await migrateLegacy();
    if (window.supabase) {
      client = window.supabase.createClient(PROJECT_URL, PUBLIC_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'ritmo-auth-v2' }
      });
      client.auth.onAuthStateChange((event, next) => {
        const before = owner(); session = next;
        const changed = before !== owner();
        if (changed || event === 'PASSWORD_RECOVERY') setTimeout(async () => {
          if (changed) {
            lastSync = session ? await meta('lastSync:' + owner()) : null;
            setStatus(session ? 'pending' : 'local'); emit('account'); if (session) sync();
          }
          if (event === 'PASSWORD_RECOVERY') emit('recovery');
        }, 0);
      });
      const { data } = await client.auth.getSession(); session = data.session;
    }
    if (session) { lastSync = await meta('lastSync:' + owner()); schedule(); }
    window.addEventListener('online', sync);
    window.addEventListener('offline', () => { if (session) setStatus('offline'); });
    window.addEventListener('focus', () => { emit('data'); sync(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
    setInterval(() => { if (!document.hidden) sync(); }, 60000);
    return snapshot();
  }
  async function auth(action, email, password) {
    if (!client) throw Error('O serviço de conta não carregou. Conecte à internet e abra o app novamente.');
    const options = { emailRedirectTo: 'https://barbosasolucoesbr-art.github.io/Sistemaritmo/' };
    let result;
    if (action === 'signup') result = await client.auth.signUp({ email, password, options });
    else if (action === 'reset') result = await client.auth.resetPasswordForEmail(email, { redirectTo: options.emailRedirectTo });
    else if (action === 'new-password') result = await client.auth.updateUser({ password });
    else result = await client.auth.signInWithPassword({ email, password });
    if (result.error) throw Object.assign(Error(message(result.error)), { cause: result.error });
    return result.data;
  }
  async function signOut() {
    if (client) {
      const { error: fault } = await client.auth.signOut({ scope: 'local' });
      if (fault) throw Error(message(fault));
    }
    session = null; setStatus('local'); emit('account');
  }
  window.RitmoStore = { init, snapshot, put, sync, auth, signOut, importAll, hasGuestData, importGuest, resolveConflict,
    subscribe(fn) { listeners.add(fn); if (recoveryPending) { recoveryPending = false; setTimeout(() => emit('recovery'), 0); } return () => listeners.delete(fn); },
    get state() { return { session, status, error, lastSync, owner: owner() }; }, merge };
})();
