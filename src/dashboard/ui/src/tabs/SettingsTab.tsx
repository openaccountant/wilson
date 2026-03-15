import { useState, useMemo, useEffect } from 'react';
import { useApi } from '@/hooks/useApi';
import { api } from '@/api';
import type { Memory, Entity } from '@/types';

const AUTH_KEY = 'wilson_auth_token';

const MEMORY_TYPES = ['context', 'insight', 'advice'] as const;

function typeColor(type: Memory['memory_type']): { bg: string; fg: string } {
  switch (type) {
    case 'context':
      return { bg: 'rgba(34,197,94,0.15)', fg: '#22c55e' };
    case 'insight':
      return { bg: 'rgba(59,130,246,0.15)', fg: '#3b82f6' };
    case 'advice':
      return { bg: 'rgba(168,85,247,0.15)', fg: '#a855f7' };
  }
}

// ── Profile Section ──────────────────────────────────────────────────────────

interface ProfilesResponse {
  profiles: string[];
  active: string;
}

function ProfileSection() {
  const { data, loading, refetch } = useApi<ProfilesResponse>('/api/profiles');
  const [switching, setSwitching] = useState(false);

  async function handleSwitch(name: string) {
    setSwitching(true);
    try {
      await api('/api/profiles/switch', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      refetch();
      // Reload to refresh all data
      setTimeout(() => window.location.reload(), 300);
    } catch {
      // silent
    } finally {
      setSwitching(false);
    }
  }

  if (loading) {
    return (
      <div>
        <h2 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Profile</h2>
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <div className="h-[40px] animate-pulse bg-border-muted rounded" />
        </div>
      </div>
    );
  }

  if (!data || data.profiles.length <= 1) return null;

  return (
    <div>
      <h2 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Profile</h2>
      <div className="bg-surface-raised border border-border rounded-lg p-4">
        <p className="text-xs text-text-muted mb-3">
          Switch between database profiles. Each profile has its own transactions, budgets, and settings.
        </p>
        <div className="flex items-center gap-3">
          <select
            value={data.active}
            onChange={(e) => handleSwitch(e.target.value)}
            disabled={switching}
            className="bg-surface border border-border rounded px-3 py-1.5 text-sm text-text"
          >
            {data.profiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          {switching && <span className="text-xs text-text-muted">Switching...</span>}
        </div>
      </div>
    </div>
  );
}

// ── Security Section ─────────────────────────────────────────────────────────

interface AuthStatus {
  authEnabled: boolean;
  user: { id: number; username: string; role: string } | null;
  userCount: number;
}

interface DashboardUser {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
  is_active: number;
  created_at: string;
}

function SecuritySection() {
  const { data: authStatus, loading, refetch } = useApi<AuthStatus>('/api/auth/status');
  const [users, setUsers] = useState<DashboardUser[]>([]);
  const [showAddUser, setShowAddUser] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'viewer'>('viewer');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isAdmin = authStatus?.user?.role === 'admin';
  const authEnabled = authStatus?.authEnabled ?? false;

  useEffect(() => {
    if (authEnabled && isAdmin) {
      api<DashboardUser[]>('/api/auth/users')
        .then(setUsers)
        .catch(() => {});
    }
  }, [authEnabled, isAdmin]);

  async function handleToggleAuth() {
    try {
      await api('/api/auth/config', {
        method: 'PATCH',
        body: JSON.stringify({ auth_enabled: !authEnabled }),
      });
      refetch();
    } catch {
      // silent
    }
  }

  async function handleAddUser() {
    if (!newUsername.trim() || !newPassword.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api('/api/auth/users', {
        method: 'POST',
        body: JSON.stringify({ username: newUsername.trim(), password: newPassword, role: newRole }),
      });
      setNewUsername('');
      setNewPassword('');
      setShowAddUser(false);
      const updated = await api<DashboardUser[]>('/api/auth/users');
      setUsers(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteUser(id: number) {
    try {
      await api(`/api/auth/users/${id}`, { method: 'DELETE' });
      const updated = await api<DashboardUser[]>('/api/auth/users');
      setUsers(updated);
    } catch {
      // silent
    }
  }

  async function handleLogout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // silent
    }
    localStorage.removeItem(AUTH_KEY);
    window.location.reload();
  }

  if (loading) {
    return (
      <div>
        <h2 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Security</h2>
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <div className="h-[60px] animate-pulse bg-border-muted rounded" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Security</h2>
      <div className="bg-surface-raised border border-border rounded-lg p-4 space-y-4">
        {/* Auth toggle + current user */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-text font-medium">Authentication</div>
            <div className="text-xs text-text-muted mt-0.5">
              {authEnabled ? 'Enabled — login required to access dashboard' : 'Disabled — dashboard is open'}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {authStatus?.user && (
              <button
                onClick={handleLogout}
                className="text-xs text-text-muted hover:text-red bg-transparent border border-border rounded px-2 py-1 cursor-pointer"
              >
                Logout ({authStatus.user.username})
              </button>
            )}
            {(!authEnabled || isAdmin) && (
              <button
                onClick={handleToggleAuth}
                className={`px-3 py-1 rounded text-xs font-medium cursor-pointer border-none ${
                  authEnabled
                    ? 'bg-red/20 text-red hover:bg-red/30'
                    : 'bg-green/20 text-green hover:bg-green/30'
                }`}
              >
                {authEnabled ? 'Disable' : 'Enable'}
              </button>
            )}
          </div>
        </div>

        {/* User list (admin only, when auth enabled) */}
        {authEnabled && isAdmin && users.length > 0 && (
          <div>
            <div className="text-xs text-text-muted uppercase tracking-wide mb-2">Users</div>
            <div className="space-y-1.5">
              {users.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center justify-between bg-surface border border-border rounded px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-text">{u.username}</span>
                    <span
                      className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded"
                      style={{
                        backgroundColor: u.role === 'admin' ? 'rgba(234,179,8,0.15)' : 'rgba(113,113,122,0.15)',
                        color: u.role === 'admin' ? '#eab308' : '#71717a',
                      }}
                    >
                      {u.role}
                    </span>
                  </div>
                  {u.id !== authStatus?.user?.id && (
                    <button
                      onClick={() => handleDeleteUser(u.id)}
                      className="text-text-muted hover:text-red bg-transparent border-none cursor-pointer text-sm p-1"
                      title="Remove user"
                    >
                      &times;
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add user form */}
        {authEnabled && isAdmin && (
          <div>
            {showAddUser ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="Username"
                    className="bg-surface border border-border rounded px-2 py-1.5 text-sm text-text flex-1"
                  />
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Password"
                    className="bg-surface border border-border rounded px-2 py-1.5 text-sm text-text flex-1"
                  />
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as 'admin' | 'viewer')}
                    className="bg-surface border border-border rounded px-2 py-1.5 text-sm text-text"
                  >
                    <option value="viewer">Viewer</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleAddUser}
                    disabled={saving || !newUsername.trim() || !newPassword.trim()}
                    className="bg-green text-black px-3 py-1 rounded text-xs font-medium cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? 'Creating...' : 'Create User'}
                  </button>
                  <button
                    onClick={() => { setShowAddUser(false); setError(''); }}
                    className="bg-transparent text-text-muted border border-border px-3 py-1 rounded text-xs cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
                {error && <div className="text-xs text-red">{error}</div>}
              </div>
            ) : (
              <button
                onClick={() => setShowAddUser(true)}
                className="text-xs text-green bg-transparent border border-border rounded px-3 py-1.5 cursor-pointer hover:border-green"
              >
                + Add User
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Memory Section ───────────────────────────────────────────────────────────

function MemoryCard({
  memory,
  onDelete,
}: {
  memory: Memory;
  onDelete: (id: number) => void;
}) {
  const colors = typeColor(memory.memory_type);
  return (
    <div className="bg-surface-raised border border-border rounded-lg p-3 flex items-start justify-between gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span
            className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded"
            style={{ backgroundColor: colors.bg, color: colors.fg }}
          >
            {memory.memory_type}
          </span>
          {memory.category && (
            <span className="text-[10px] text-text-muted">{memory.category}</span>
          )}
        </div>
        <div className="text-sm text-text">{memory.content}</div>
        <div className="text-xs text-text-muted mt-1">
          {new Date(memory.created_at).toLocaleDateString()}
        </div>
      </div>
      <button
        onClick={() => onDelete(memory.id)}
        className="text-text-muted hover:text-red bg-transparent border-none cursor-pointer text-sm p-1 shrink-0"
        title="Delete memory"
      >
        &times;
      </button>
    </div>
  );
}

function MemoriesSection() {
  const { data: memories, loading, refetch } = useApi<Memory[]>('/api/memories');
  const [newType, setNewType] = useState<Memory['memory_type']>('context');
  const [newContent, setNewContent] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [saving, setSaving] = useState(false);

  const grouped = useMemo(() => {
    if (!memories) return {};
    const groups: Record<string, Memory[]> = {};
    for (const type of MEMORY_TYPES) {
      const items = memories.filter((m) => m.memory_type === type);
      if (items.length > 0) groups[type] = items;
    }
    return groups;
  }, [memories]);

  async function handleAdd() {
    if (!newContent.trim()) return;
    setSaving(true);
    try {
      await api('/api/memories', {
        method: 'POST',
        body: JSON.stringify({
          memoryType: newType,
          content: newContent.trim(),
          category: newCategory.trim() || undefined,
        }),
      });
      setNewContent('');
      setNewCategory('');
      refetch();
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await api(`/api/memories/${id}`, { method: 'DELETE' });
      refetch();
    } catch {
      // silent
    }
  }

  return (
    <div>
      <h2 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Memories</h2>

      {/* Add form */}
      <div className="bg-surface-raised border border-border rounded-lg p-4 mb-4 space-y-3">
        <div className="flex gap-3">
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as Memory['memory_type'])}
            className="bg-surface border border-border rounded px-2 py-1.5 text-sm text-text"
          >
            {MEMORY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="Category (optional)"
            className="bg-surface border border-border rounded px-2 py-1.5 text-sm text-text w-40"
          />
        </div>
        <textarea
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder="Memory content..."
          rows={2}
          className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm text-text resize-y"
        />
        <button
          onClick={handleAdd}
          disabled={saving || !newContent.trim()}
          className="bg-green text-black px-4 py-1.5 rounded text-sm font-medium cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Adding...' : 'Add Memory'}
        </button>
      </div>

      {/* Memory list */}
      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-surface-raised border border-border rounded-lg p-3">
              <div className="h-[40px] animate-pulse bg-border-muted rounded" />
            </div>
          ))}
        </div>
      ) : Object.keys(grouped).length > 0 ? (
        Object.entries(grouped).map(([type, items]) => (
          <div key={type} className="mb-3">
            <h3 className="text-xs text-text-muted uppercase tracking-wide mb-1.5">{type}</h3>
            <div className="space-y-2">
              {items.map((m) => (
                <MemoryCard key={m.id} memory={m} onDelete={handleDelete} />
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="bg-surface-raised border border-border rounded-lg p-4">
          <p className="text-sm text-text-muted">No active memories.</p>
        </div>
      )}
    </div>
  );
}

// ── Custom Prompt Section ────────────────────────────────────────────────────

function CustomPromptSection() {
  const { data, loading } = useApi<{ prompt: string }>('/api/settings/custom-prompt');
  const [prompt, setPrompt] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Sync fetched data into local state once
  if (data && !initialized) {
    setPrompt(data.prompt);
    setInitialized(true);
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await api('/api/settings/custom-prompt', {
        method: 'PUT',
        body: JSON.stringify({ prompt }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h2 className="text-xs text-text-secondary uppercase tracking-wide mb-3">
        Custom Prompt
      </h2>
      <div className="bg-surface-raised border border-border rounded-lg p-4 space-y-3">
        <p className="text-xs text-text-muted">
          Custom instructions appended to the agent's system prompt. Use this to set preferences
          like currency, profession, or analysis style.
        </p>
        {loading ? (
          <div className="h-[80px] animate-pulse bg-border-muted rounded" />
        ) : (
          <>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g., Always use GBP for currency formatting. I'm a freelance designer."
              rows={4}
              className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm text-text resize-y font-mono"
            />
            <div className="flex items-center gap-3">
              <button
                onClick={handleSave}
                disabled={saving}
                className="bg-green text-black px-4 py-1.5 rounded text-sm font-medium cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              {saved && (
                <span className="text-xs text-green">Saved! Restart agent to apply.</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Entity Section ───────────────────────────────────────────────────────────

function EntitySection() {
  const { data: entities, loading, refetch } = useApi<Entity[]>('/api/entities');
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#22c55e');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function resetForm() {
    setName('');
    setDescription('');
    setColor('#22c55e');
    setShowAdd(false);
    setEditingId(null);
    setError('');
  }

  function startEdit(entity: Entity) {
    setEditingId(entity.id);
    setName(entity.name);
    setDescription(entity.description ?? '');
    setColor(entity.color);
    setShowAdd(false);
    setError('');
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await api(`/api/entities/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined, color }),
        });
      } else {
        await api('/api/entities', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined, color }),
        });
      }
      resetForm();
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save entity');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await api(`/api/entities/${id}`, { method: 'DELETE' });
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  const showForm = showAdd || editingId !== null;

  return (
    <div>
      <h2 className="text-xs text-text-secondary uppercase tracking-wide mb-3">Entities</h2>
      <div className="bg-surface-raised border border-border rounded-lg p-4 space-y-4">
        <p className="text-xs text-text-muted">
          Separate finances by business entity (personal, side hustle, LLC). Assign entities to transactions in the Transactions tab.
        </p>

        {/* Entity list */}
        {loading ? (
          <div className="h-[60px] animate-pulse bg-border-muted rounded" />
        ) : entities && entities.length > 0 ? (
          <div className="space-y-1.5">
            {entities.map((e) => (
              <div
                key={e.id}
                className="flex items-center justify-between bg-surface border border-border rounded px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: e.color }}
                  />
                  <span className="text-sm text-text">{e.name}</span>
                  {e.description && (
                    <span className="text-xs text-text-muted">— {e.description}</span>
                  )}
                  {!!e.is_default && (
                    <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded bg-green/15 text-green">
                      default
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => startEdit(e)}
                    className="text-text-muted hover:text-text bg-transparent border-none cursor-pointer text-xs px-1.5 py-0.5"
                    title="Edit entity"
                  >
                    edit
                  </button>
                  {!e.is_default && (
                    <button
                      onClick={() => handleDelete(e.id)}
                      className="text-text-muted hover:text-red bg-transparent border-none cursor-pointer text-sm p-1"
                      title="Delete entity"
                    >
                      &times;
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-muted">No entities found.</p>
        )}

        {/* Add/Edit form */}
        {showForm ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Entity name"
                className="bg-surface border border-border rounded px-2 py-1.5 text-sm text-text flex-1"
              />
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description (optional)"
                className="bg-surface border border-border rounded px-2 py-1.5 text-sm text-text flex-1"
              />
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-9 h-9 bg-surface border border-border rounded cursor-pointer p-0.5"
                title="Entity color"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving || !name.trim()}
                className="bg-green text-black px-3 py-1 rounded text-xs font-medium cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving...' : editingId ? 'Update Entity' : 'Create Entity'}
              </button>
              <button
                onClick={resetForm}
                className="bg-transparent text-text-muted border border-border px-3 py-1 rounded text-xs cursor-pointer"
              >
                Cancel
              </button>
            </div>
            {error && <div className="text-xs text-red">{error}</div>}
          </div>
        ) : (
          <button
            onClick={() => { setShowAdd(true); setEditingId(null); setError(''); }}
            className="text-xs text-green bg-transparent border border-border rounded px-3 py-1.5 cursor-pointer hover:border-green"
          >
            + Add Entity
          </button>
        )}
      </div>
    </div>
  );
}

// ── Settings Tab ─────────────────────────────────────────────────────────────

export function SettingsTab() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <ProfileSection />
      <EntitySection />
      <SecuritySection />
      <MemoriesSection />
      <CustomPromptSection />
    </div>
  );
}
