import { describe, expect, it } from 'vitest';
import {
  anchorUsable,
  type DrillAnchor,
  type DrillTransition,
  completeDrill,
  decideDrill,
  drillPose,
} from '../src/features/workflow/editor/graph-drill-transition';

const anchor: DrillAnchor = {
  rect: { x: 120, y: 80, width: 180, height: 72 },
  stageWidth: 1000,
  stageHeight: 600,
};

function request(overrides: Partial<Parameters<typeof decideDrill>[0]> = {}) {
  return {
    busy: false,
    reducedMotion: false,
    anchor,
    stageWidth: 1000,
    stageHeight: 600,
    direction: 'enter' as const,
    fromKey: 'root',
    toKey: 'body',
    ...overrides,
  };
}

describe('嵌套图空间过渡', () => {
  it('进入时立即导航并保留放大过渡', () => {
    const decision = decideDrill(request());
    expect(decision.navigate).toBe(true);
    expect(decision.transition).toMatchObject({
      direction: 'enter',
      fromKey: 'root',
      toKey: 'body',
    });
    expect(completeDrill(decision.transition)).toBe(false);
  });

  it('返回时先收缩，结束后才导航', () => {
    const decision = decideDrill(request({ direction: 'exit', fromKey: 'body', toKey: 'root' }));
    expect(decision.navigate).toBe(false);
    expect(decision.transition?.direction).toBe('exit');
    expect(completeDrill(decision.transition)).toBe(true);
  });

  it('breadcrumb 跨层返回使用同一次退出过渡', () => {
    const decision = decideDrill(request({ direction: 'exit', fromKey: 'c', toKey: 'a', anchor }));
    expect(decision.transition).toMatchObject({ direction: 'exit', fromKey: 'c', toKey: 'a' });
    expect(completeDrill(decision.transition)).toBe(true);
  });

  it('锚点不在视口、尺寸丢失或舞台变化时直接导航', () => {
    expect(decideDrill(request({ anchor: null })).transition).toBeNull();
    expect(decideDrill(request({ anchor: null })).navigate).toBe(true);
    const offscreen = {
      ...anchor,
      rect: { x: -400, y: 80, width: 180, height: 72 },
    };
    expect(anchorUsable(offscreen, 1000, 600)).toBe(false);
    expect(decideDrill(request({ anchor: offscreen, direction: 'exit' }))).toEqual({
      navigate: true,
      transition: null,
    });
    expect(anchorUsable(anchor, 1200, 600)).toBe(false);
    expect(drillPose({ ...anchor, rect: { x: 0, y: 0, width: 0, height: 0 } })).toBeNull();
  });

  it('reduced motion 不创建过渡', () => {
    expect(decideDrill(request({ reducedMotion: true, direction: 'exit' }))).toEqual({
      navigate: true,
      transition: null,
    });
  });

  it('过渡进行中忽略重复进入和返回', () => {
    expect(decideDrill(request({ busy: true }))).toEqual({ navigate: false, transition: null });
    expect(decideDrill(request({ busy: true, direction: 'exit' }))).toEqual({
      navigate: false,
      transition: null,
    });
    expect(decideDrill(request({ fromKey: 'body', toKey: 'body' }))).toEqual({
      navigate: false,
      transition: null,
    });
  });

  it('姿态从节点中心缩放到画布中心', () => {
    const pose = drillPose(anchor);
    expect(pose).toEqual({ x: 120 + 90 - 500, y: 80 + 36 - 300, scale: 72 / 600 });
  });

  it('结束后只对退出方向提交导航', () => {
    const exit: DrillTransition = {
      direction: 'exit',
      fromKey: 'c',
      toKey: 'a',
      anchor,
      phase: 'running',
    };
    expect(completeDrill(exit)).toBe(true);
    expect(completeDrill({ ...exit, direction: 'enter' })).toBe(false);
    expect(completeDrill(null)).toBe(false);
  });
});
