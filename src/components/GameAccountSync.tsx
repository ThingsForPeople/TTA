'use client';

import { useCallback, useEffect, useState } from 'react';
import { emptyMeta, normalizeArchetype, type Hand, type PlayerMetaStore } from '../lib/playerMeta';
import { fetchReplayTalents, mergeTalentsIntoStore } from '../lib/talentDetect';

interface Account {
  id: string;
  label: string;
  lastSyncedAt?: string | null;
}

interface SyncUpdate {
  playerUuid: string;
  sim: { con: number; pow: number; spd: number; fld: number; arm: number; pit: number; sta: number };
  bats: Hand | null;
  throws: Hand | null;
  archetype: string | null;
  age: number | null;
}

interface Props {
  teamUuid: string;
  metaStore: PlayerMetaStore;
  onChange: (next: PlayerMetaStore) => void;
}

// Pulls exact sim stats/age/handedness for the loaded team straight from the
// user's Tiny Teams game account (private API), so they no longer hand-enter
// them. Credentials are exchanged for a stored refresh token server-side; the
// password is never persisted.
export function GameAccountSync({ teamUuid, metaStore, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [canStore, setCanStore] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/game-account');
      if (!res.ok) return;
      const json = await res.json();
      setEnabled(json.enabled ?? false);
      setAccounts(json.accounts ?? []);
      setCanStore(json.canStore ?? true);
    } catch {
      /* ignore — panel just shows no accounts */
    }
  }, []);

  // Check access (and load accounts) on mount so the whole feature is hidden
  // for users not on the allowlist, not just gated at the API.
  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const connect = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch('/api/game-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      setEmail('');
      setPassword('');
      setMsg(`Connected ${json.account?.label ?? 'account'}.`);
      await loadAccounts();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Connect failed.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (id: string) => {
    await fetch(`/api/game-account?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadAccounts();
  };

  const sync = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch('/api/game-account/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamUuid }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      const updates = (json.updates ?? []) as SyncUpdate[];
      // Merge synced attributes into the client store, preserving each player's
      // talents/injuries (only the game-authoritative fields change).
      let next: PlayerMetaStore = { ...metaStore };
      for (const u of updates) {
        const cur = next[u.playerUuid] ?? emptyMeta();
        next[u.playerUuid] = {
          ...cur,
          sim: u.sim,
          bats: u.bats ?? cur.bats,
          throws: u.throws ?? cur.throws,
          archetype: normalizeArchetype(u.archetype) ?? cur.archetype,
          age: u.age ?? cur.age,
        };
      }
      // Best-effort: also fold in talents from the latest replay, so one click
      // refreshes the whole roster. A missing/rate-limited replay doesn't fail
      // the attribute sync — we just note talents were skipped. Merged into the
      // SAME store and committed once, so the two can't race each other.
      let talentNote = '';
      try {
        const detected = await fetchReplayTalents(teamUuid);
        const merged = mergeTalentsIntoStore(next, detected);
        next = merged.next;
        talentNote = merged.changed > 0 ? ` + ${merged.changed} talent set${merged.changed === 1 ? '' : 's'}` : '';
      } catch {
        talentNote = ' (talent detect skipped)';
      }
      onChange(next);
      setMsg(`Synced ${json.synced} players from ${json.account} (${json.teamName})${talentNote}.`);
      await loadAccounts();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sync failed.');
    } finally {
      setBusy(false);
    }
  };

  // Hidden entirely for users not on the allowlist (and until the check resolves).
  if (!enabled) return null;

  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={sync}
        disabled={busy || accounts.length === 0}
        title={accounts.length === 0 ? 'Connect a game account first' : 'Pull exact sim stats/age/handedness from your game account, and fold in talents from the latest replay'}
        className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 transition-colors hover:border-emerald-500 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Syncing…' : 'Sync attributes'}
      </button>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Manage connected game accounts"
        className="rounded border border-slate-700 px-1.5 py-0.5 text-[11px] text-slate-400 hover:border-slate-500 hover:text-slate-200"
      >
        {accounts.length ? `${accounts.length} acct${accounts.length === 1 ? '' : 's'}` : 'Connect'}
      </button>

      {open && (
        <div className="absolute right-4 z-20 mt-40 w-80 rounded-lg border border-slate-700 bg-slate-900 p-3 shadow-xl">
          <p className="mb-2 text-xs font-semibold text-slate-200">Game accounts</p>
          {!canStore && (
            <p className="mb-2 rounded border border-amber-600/40 bg-amber-600/10 px-2 py-1 text-[11px] text-amber-300">
              Set <code>GAME_TOKEN_KEY</code> in the environment to store logins.
            </p>
          )}
          <ul className="mb-2 space-y-1">
            {accounts.map((a) => (
              <li key={a.id} className="flex items-center justify-between text-[11px] text-slate-300">
                <span className="truncate">{a.label}</span>
                <button type="button" onClick={() => disconnect(a.id)} className="text-slate-500 hover:text-red-400">
                  remove
                </button>
              </li>
            ))}
            {accounts.length === 0 && <li className="text-[11px] text-slate-500">No accounts connected.</li>}
          </ul>
          <div className="space-y-1.5">
            <input
              type="email"
              placeholder="Tiny Teams email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
              className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-500"
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-500"
            />
            <button
              type="button"
              onClick={connect}
              disabled={busy || !email || !password || !canStore}
              className="w-full rounded bg-emerald-600/80 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Connecting…' : 'Connect account'}
            </button>
          </div>
          <p className="mt-2 text-[10px] leading-snug text-slate-500">
            Your password isn’t stored — it’s exchanged for a refresh token used only to read your own teams.
          </p>
        </div>
      )}

      {msg && <span className="text-[11px] text-emerald-300/90">{msg}</span>}
      {err && <span className="text-[11px] text-red-300/90">{err}</span>}
    </div>
  );
}
