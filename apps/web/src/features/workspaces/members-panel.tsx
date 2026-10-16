'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, UserPlus } from 'lucide-react';
import { api, queryKeys } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ErrorNotice, FormField } from '@/components/ui/form-field';

type Role = 'admin' | 'editor' | 'viewer';
const roles: { value: Role; label: string }[] = [{ value: 'editor', label: '编辑者' }, { value: 'viewer', label: '查看者' }, { value: 'admin', label: '管理员' }];

export function MembersPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const client = useQueryClient();
  const members = useQuery({ queryKey: queryKeys.members(workspaceId), queryFn: () => api.members(workspaceId) });
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.members(workspaceId) });
  const add = useMutation({
    mutationFn: () => api.addMember(workspaceId, { email, name, role, ...(password ? { password } : {}) }),
    onSuccess: async () => { setPassword(''); setEmail(''); setName(''); await refresh(); },
  });
  const update = useMutation({ mutationFn: ({ id, role }: { id: string; role: Role }) => api.updateMemberRole(workspaceId, id, role), onSuccess: refresh });
  return (
    <Dialog title="团队成员" onClose={onClose} wide>
      <p className="field-hint">编辑者可搭建、发布和运行；查看者只能阅读。管理员负责成员、插件和凭证。</p>
      {members.isPending && <div className="loading-row"><Loader2 className="animate-spin" size={15} />读取成员…</div>}
      {members.error && <ErrorNotice error={members.error} />}
      <div style={{ display: 'grid', gap: 12, margin: '20px 0' }}>
        {members.data?.items.map((member) => (
          <div key={member.id} style={{ display: 'flex', gap: 12, alignItems: 'center', borderBottom: '1px solid var(--border-soft)', paddingBottom: 12 }}>
            <div style={{ flex: 1 }}><strong>{member.name}</strong><p className="field-hint">{member.email}</p></div>
            {member.role === 'owner' ? <span className="badge">工作空间所有者</span> : (
              <select aria-label={`${member.name}的角色`} value={member.role} disabled={update.isPending} style={{ width: 130 }} onChange={(event) => update.mutate({ id: member.id, role: event.target.value as Role })}>
                {roles.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              </select>
            )}
          </div>
        ))}
      </div>
      {update.error && <ErrorNotice error={update.error} />}
      <form onSubmit={(event) => { event.preventDefault(); if (!add.isPending) add.mutate(); }} style={{ display: 'grid', gap: 12 }}>
        <h3 style={{ margin: '8px 0' }}>添加成员</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <FormField label="邮箱"><input type="email" required maxLength={200} autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} /></FormField>
          <FormField label="姓名"><input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></FormField>
        </div>
        <FormField label="初始密码" hint="新账号需要至少 12 位密码；已有账号请留空。此操作不发送邮件。"><input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></FormField>
        <FormField label="角色"><select value={role} onChange={(event) => setRole(event.target.value as Role)}>{roles.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select></FormField>
        {add.error && <ErrorNotice error={add.error} />}
        <Button disabled={add.isPending || !email || !name} type="submit">{add.isPending ? <Loader2 className="animate-spin" /> : <UserPlus />}添加到工作空间</Button>
      </form>
    </Dialog>
  );
}
