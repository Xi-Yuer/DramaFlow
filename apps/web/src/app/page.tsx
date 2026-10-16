'use client';

import { Result } from 'antd';

export default function Home() {
  return (
    <main className="foundation-page">
      <Result
        status="info"
        title="DramaFlow"
        subTitle="基础工程已保留，业务功能将按你的指导逐步实现。"
      />
    </main>
  );
}
