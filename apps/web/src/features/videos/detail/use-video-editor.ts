import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import { saveVideoSchema, type Video, type VideoStatus } from '@dramaflow/contracts';
import { ApiError } from '@/lib/http';
import { useLeaveGuard } from '@/lib/navigation/use-leave-guard';
import { useProjectNavigationGuard } from '@/features/projects/workspace/workspace-context';
import { videoApi, videoKeys } from '../api/video-api';

export function useVideoEditor(video: Video) {
  const router = useRouter();
  const cache = useQueryClient();
  const { modal, message } = App.useApp();
  const [name, setName] = useState(video.name);
  const [status, setStatus] = useState<VideoStatus>(video.status);
  const [saved, setSaved] = useState(video);
  const [operation, setOperation] = useState<'idle' | 'saving' | 'reloading' | 'removing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dirty = name !== saved.name || status !== saved.status;
  const { requestLeave } = useLeaveGuard(dirty || operation !== 'idle', '确认离开视频作品？');
  useProjectNavigationGuard(requestLeave);

  async function save() {
    if (lock.current || !dirty || conflict) return;
    const submittedName = name;
    const parsed = saveVideoSchema.safeParse({ name, status, revision: saved.revision });
    if (!parsed.success) {
      setError('请填写 1 到 80 个字符的视频名称');
      return;
    }
    lock.current = true;
    setOperation('saving');
    setError(null);
    try {
      const result = await videoApi.save(video.projectId, video.id, parsed.data);
      const confirmed = { ...saved, name: parsed.data.name, status: parsed.data.status, ...result };
      setSaved(confirmed);
      setName((current) => (current === submittedName ? confirmed.name : current));
      cache.setQueryData(videoKeys.detail(video.projectId, video.id), confirmed);
      void cache.invalidateQueries({ queryKey: videoKeys.list(video.projectId) });
      void message.success('视频作品已保存');
    } catch (cause) {
      setConflict(cause instanceof ApiError && cause.status === 409);
      setError(cause instanceof Error ? cause.message : '视频保存未确认');
    } finally {
      lock.current = false;
      setOperation('idle');
    }
  }

  function reload() {
    const read = async () => {
      if (lock.current) return;
      lock.current = true;
      setOperation('reloading');
      try {
        const latest = await cache.fetchQuery({
          queryKey: videoKeys.detail(video.projectId, video.id),
          queryFn: () => videoApi.get(video.projectId, video.id),
          staleTime: 0,
          retry: false,
        });
        setName(latest.name);
        setStatus(latest.status);
        setSaved(latest);
        setConflict(false);
        setError(null);
        cache.setQueryData(videoKeys.detail(video.projectId, video.id), latest);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '视频读取失败');
      } finally {
        lock.current = false;
        setOperation('idle');
      }
    };
    if (!dirty) {
      void read();
      return;
    }
    modal.confirm({
      title: '重新读取会放弃当前视频信息修改',
      okText: '读取服务器视频信息',
      cancelText: '继续编辑',
      onOk: read,
    });
  }

  function remove() {
    if (lock.current) return;
    modal.confirm({
      title: `删除「${saved.name}」？`,
      content: '将永久删除此视频作品身份，未保存的修改也会丢失。此操作不能撤销。',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        if (lock.current) return;
        lock.current = true;
        setOperation('removing');
        setError(null);
        try {
          await videoApi.remove(video.projectId, video.id);
          void cache.invalidateQueries({ queryKey: videoKeys.list(video.projectId) });
          if (mounted.current) router.replace(`/projects/${video.projectId}/videos`);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : '视频删除未确认');
        } finally {
          lock.current = false;
          setOperation('idle');
        }
      },
    });
  }

  return {
    name,
    setName,
    status,
    setStatus,
    saved,
    dirty,
    operation,
    error,
    conflict,
    save,
    reload,
    remove,
  };
}
