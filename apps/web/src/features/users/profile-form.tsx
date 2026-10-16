'use client';
import { App, Button, Form, Input, Select } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { profileInputSchema, type CurrentUser, type ProfileInput } from '@dramaflow/contracts';
import { identityApi, identityKey } from '@/features/auth/identity-api';

const timeZones = Intl.supportedValuesOf('timeZone').map((value) => ({
  value,
  label: value.replaceAll('_', ' '),
}));
export function ProfileForm({ user }: { user: CurrentUser }) {
  const [form] = Form.useForm<ProfileInput>();
  const cache = useQueryClient();
  const { message } = App.useApp();
  const update = useMutation({
    mutationFn: identityApi.update,
    onSuccess: (next) => {
      cache.setQueryData(identityKey, next);
      void message.success('个人资料已保存');
    },
    onError: (error) => void message.error(error.message),
  });
  return (
    <Form
      form={form}
      layout="vertical"
      requiredMark={false}
      initialValues={{ name: user.name, bio: user.profile.bio, timeZone: user.profile.timeZone }}
      onFinish={(values) => {
        const result = profileInputSchema.safeParse(values);
        if (!result.success) {
          void message.error(result.error.issues[0]?.message ?? '请检查填写内容');
          return;
        }
        update.mutate(result.data);
      }}
    >
      <Form.Item
        name="name"
        label="怎么称呼你"
        rules={[
          { required: true, whitespace: true, message: '请输入称呼' },
          { max: 80, message: '称呼最多 80 个字符' },
        ]}
      >
        <Input maxLength={80} autoComplete="nickname" />
      </Form.Item>
      <Form.Item label="登录邮箱" extra="当前暂不支持修改登录邮箱。">
        <Input value={user.email} disabled />
      </Form.Item>
      <Form.Item name="bio" label="关于你">
        <Input.TextArea
          rows={3}
          maxLength={280}
          showCount
          placeholder="简单介绍一下自己的创作方向…"
        />
      </Form.Item>
      <Form.Item name="timeZone" label="所在时区">
        <Select options={timeZones} showSearch optionFilterProp="label" />
      </Form.Item>
      <Button htmlType="submit" type="primary" loading={update.isPending}>
        保存资料
      </Button>
    </Form>
  );
}
