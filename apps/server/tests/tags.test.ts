import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

/**
 * 标签治理三条不变量（对应需求：
 *   ① 重命名/合并要同步历史灵感与画册规则；
 *   ② 循环父子关系必须拒绝；
 *   ③ 并发批量打标不得产生重复关系）。
 */
let app: Express;
let token = '';
let tmpDir = '';

function call(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) {
  let req = request(app)[method](url);
  if (token) req = req.set('authorization', `Bearer ${token}`);
  if (body !== undefined) req = req.send(body as object);
  return req;
}

async function makeTag(domain: string, name: string, parentId?: string | null): Promise<string> {
  const res = await call('post', '/api/tags', { domain, name, parentId: parentId ?? null });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function makeInspiration(title: string): Promise<string> {
  const res = await call('post', '/api/inspirations', { title });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

interface TagNode {
  id: string;
  domain?: string;
  parentId?: string | null;
  usageCount?: number;
  children?: TagNode[];
}

/** /api/tags 返回的是按域排序的标签树根节点数组，递归展平（顶层标签本身就是 root） */
function flattenTags(roots: TagNode[]): TagNode[] {
  const out: TagNode[] = [];
  const walk = (nodes: TagNode[] | undefined): void => {
    for (const n of nodes ?? []) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(roots);
  return out;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-tag-test-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'off';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  const { migrate } = await import('../src/db.js');
  migrate();
  app = createApp();

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'tagowner@test.local', password: 'password123', displayName: '标签测试所有者' });
  expect(res.status).toBe(201);
  token = res.body.token;
});

afterAll(async () => {
  const { closeDb } = await import('../src/db.js');
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('② 父子关系不允许成环', () => {
  it('新建时父标签不存在/跨域 → 拒绝', async () => {
    const missing = await call('post', '/api/tags', { domain: 'light', name: '孤儿光', parentId: 'nope-nope' });
    expect(missing.status).toBe(404);

    // 拿一个 scene 域标签做跨域尝试
    const tags = await call('get', '/api/tags');
    const sceneTag = flattenTags(tags.body.items as TagNode[]).find((t) => t.domain === 'scene')!;
    const cross = await call('post', '/api/tags', {
      domain: 'light',
      name: '想跨域挂父级',
      parentId: sceneTag.id,
    });
    expect(cross.status).toBe(400);
  });

  it('自引用与挂到后代下 → 400；合法移动成功', async () => {
    const a = await makeTag('light', '环测试-祖父');
    const b = await makeTag('light', '环测试-父亲', a);
    const c = await makeTag('light', '环测试-儿子', b);

    const self = await call('patch', `/api/tags/${a}`, { parentId: a });
    expect(self.status).toBe(400);
    expect(self.body.error.message).toContain('成环');

    // a 挂到自己的孙子 c 下：a→c→b→a 成环
    const grandchild = await call('patch', `/api/tags/${a}`, { parentId: c });
    expect(grandchild.status).toBe(400);
    expect(grandchild.body.error.message).toContain('成环');

    // b 挂到同域另一个顶层标签下合法（无环）
    const other = await makeTag('light', '环测试-别人家');
    const okMove = await call('patch', `/api/tags/${b}`, { parentId: other });
    expect(okMove.status).toBe(200);

    // 此时 c 的父亲是 b，b 的父亲是 other；把 c 挂回 a 仍然合法
    const back = await call('patch', `/api/tags/${c}`, { parentId: a });
    expect(back.status).toBe(200);
  });
});

describe('① 重命名同步历史灵感（FTS）', () => {
  it('改名后按新名字检索得到历史灵感，旧名字检索不到', async () => {
    const tag = await makeTag('scene', '旧名字晨雾');
    const card = await makeInspiration('重命名同步卡');
    const tagged = await call('post', '/api/inspirations/bulk-tag', { ids: [card], addTagIds: [tag] });
    expect(tagged.status).toBe(200);

    const before = await call('get', '/api/search?q=旧名字晨雾');
    expect(before.body.items.some((i: { id: string }) => i.id === card)).toBe(true);

    const renamed = await call('patch', `/api/tags/${tag}`, { name: '新名字晨雾' });
    expect(renamed.status).toBe(200);

    const afterNew = await call('get', '/api/search?q=新名字晨雾');
    expect(afterNew.body.items.some((i: { id: string }) => i.id === card)).toBe(true);

    const afterOld = await call('get', '/api/search?q=旧名字晨雾');
    expect(afterOld.body.items.some((i: { id: string }) => i.id === card)).toBe(false);
  });

  it('改成同域已存在的名字 → 400 而不是静默撞 slug', async () => {
    const a = await makeTag('color', '占位色甲');
    const b = await makeTag('color', '占位色乙');
    const clash = await call('patch', `/api/tags/${b}`, { name: '占位色甲' });
    expect(clash.status).toBe(400);
  });
});

describe('① 合并同步历史灵感 + 画册规则', () => {
  it('绑定迁移去重、子标签上提、FTS 与画册规则/缺口同步', async () => {
    const src = await makeTag('light', '将被合并的侧逆光');
    const tgt = await makeTag('light', '保留下来的侧逆光');
    const child = await makeTag('light', '源标签的子标签', src);
    const srcOnlyCard = await makeInspiration('只挂源标签');
    const bothCard = await makeInspiration('两个都挂了');
    await call('post', '/api/inspirations/bulk-tag', { ids: [srcOnlyCard, bothCard], addTagIds: [src] });
    await call('post', '/api/inspirations/bulk-tag', { ids: [bothCard], addTagIds: [tgt] });

    // 画册规则引用源标签（min=2, required），另有一个独立组（target min=1）
    const album = await call('post', '/api/albums', {
      title: '合并同步画册',
      rules: {
        requireTags: [
          { tagIds: [src], min: 2, required: true },
          { tagIds: [tgt], min: 1, required: false },
        ],
        requireAnchors: [],
        requireWeather: [],
        totalMin: 1,
        autoMatch: { enabled: false, minTagHits: 2 },
      },
    });
    expect(album.status).toBe(201);
    const albumId = album.body.id as string;

    // 把两张卡加入画册，缺口统计才会计入它们
    for (const cardId of [srcOnlyCard, bothCard]) {
      const add = await call('post', `/api/albums/${albumId}/items`, { inspirationId: cardId });
      expect(add.status).toBe(201);
    }

    const merge = await call('post', `/api/tags/${src}/merge`, { targetId: tgt });
    expect(merge.status).toBe(200);
    expect(merge.body.migrated).toBe(2);
    expect(merge.body.childrenMoved).toBe(1);
    expect(merge.body.albumsTouched).toBe(1);

    // 源标签已删除
    const tagsAfter = await call('get', '/api/tags?includeDisabled=true');
    const flat = flattenTags(tagsAfter.body.items as TagNode[]);
    expect(flat.some((t) => t.id === src)).toBe(false);
    expect(flat.some((t) => t.id === tgt)).toBe(true);

    // 两张卡都挂且只挂一次 target；usage_count 与实际一致
    for (const cardId of [srcOnlyCard, bothCard]) {
      const detail = await call('get', `/api/inspirations/${cardId}`);
      const tags = detail.body.item.tags as { id: string }[];
      expect(tags.filter((t) => t.id === tgt)).toHaveLength(1);
      expect(tags.some((t) => t.id === src)).toBe(false);
    }
    const tgtNode = flattenTags(
      (await call('get', '/api/tags?includeDisabled=true')).body.items as TagNode[],
    ).find((t) => t.id === tgt);
    expect(tgtNode?.usageCount).toBe(2);

    // 子标签上提到顶层（parent 置空），而不是挂到 target 下
    const childNode = flattenTags((await call('get', '/api/tags')).body.items as TagNode[]).find(
      (t) => t.id === child,
    );
    expect(childNode?.parentId ?? null).toBeNull();

    // 画册规则：两个组合并为一个 target 组（min 取 max=2, required 取或=true）
    const detail = await call('get', `/api/albums/${albumId}`);
    const requireTags = detail.body.rules.requireTags as {
      tagIds: string[];
      min: number;
      required: boolean;
    }[];
    expect(requireTags).toHaveLength(1);
    expect(requireTags[0].tagIds).toEqual([tgt]);
    expect(requireTags[0].min).toBe(2);
    expect(requireTags[0].required).toBe(true);

    // 缺口 requirement 也已迁到 target，且两张卡命中 → 该缺口闭合
    const gaps = detail.body.gaps as { kind: string; requirement: { tagIds?: string[] }; status: string }[];
    const tagGap = gaps.find((g) => g.kind === 'tag');
    expect(tagGap?.requirement.tagIds).toEqual([tgt]);
    expect(tagGap?.status).toBe('filled');

    // 合并后按保留标签的新名字能搜到两张历史卡
    const search = await call('get', '/api/search?q=保留下来的侧逆光');
    const ids = search.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(srcOnlyCard);
    expect(ids).toContain(bothCard);
  });

  it('非法合并（自身/跨域/越库）拒绝', async () => {
    const light = await makeTag('light', '合并用光');
    const color = await makeTag('color', '合并用色');
    expect((await call('post', `/api/tags/${light}/merge`, { targetId: light })).status).toBe(400);
    expect((await call('post', `/api/tags/${light}/merge`, { targetId: color })).status).toBe(400);
    expect((await call('post', `/api/tags/${light}/merge`, { targetId: 'missing-id' })).status).toBe(404);
  });
});

describe('③ 并发/重复批量打标不产生重复关系', () => {
  it('单请求内重复入参去重；重复打标计数为 0', async () => {
    const t = await makeTag('composition', '批量用构图');
    const card = await makeInspiration('重复参数卡');

    const first = await call('post', '/api/inspirations/bulk-tag', {
      ids: [card, card, card],
      addTagIds: [t, t, t],
    });
    expect(first.status).toBe(200);
    expect(first.body.added).toBe(1);

    const second = await call('post', '/api/inspirations/bulk-tag', { ids: [card], addTagIds: [t] });
    expect(second.body.added).toBe(0);

    const detail = await call('get', `/api/inspirations/${card}`);
    expect((detail.body.item.tags as { id: string }[]).filter((x) => x.id === t)).toHaveLength(1);
  });

  it('一批灵感 × 多标签，交叉重复不产生重复关系且计数正确', async () => {
    const t1 = await makeTag('composition', '交叉构图一');
    const t2 = await makeTag('composition', '交叉构图二');
    const c1 = await makeInspiration('交叉卡一');
    const c2 = await makeInspiration('交叉卡二');

    const res = await call('post', '/api/inspirations/bulk-tag', {
      ids: [c1, c2, c1],
      addTagIds: [t1, t2, t1],
    });
    expect(res.body.added).toBe(4);

    for (const c of [c1, c2]) {
      const detail = await call('get', `/api/inspirations/${c}`);
      const tags = detail.body.item.tags as { id: string }[];
      expect(tags.filter((x) => [t1, t2].includes(x.id))).toHaveLength(2);
    }
  });

  it('并发同时打同一标签：全部成功，关系仍只有一条', async () => {
    const t = await makeTag('scene', '并发场景标签');
    const cards = await Promise.all(
      ['并发卡1', '并发卡2', '并发卡3', '并发卡4', '并发卡5'].map((title) => makeInspiration(title)),
    );
    // 5 个请求同时给 5 张卡打同一标签（每个请求都带全部卡片，制造交叉竞争）
    const responses = await Promise.all(
      cards.map(() => call('post', '/api/inspirations/bulk-tag', { ids: cards, addTagIds: [t] })),
    );
    for (const r of responses) expect(r.status).toBe(200);
    const totalAdded = responses.reduce((sum, r) => sum + (r.body.added as number), 0);
    expect(totalAdded).toBe(cards.length);

    for (const c of cards) {
      const detail = await call('get', `/api/inspirations/${c}`);
      expect((detail.body.item.tags as { id: string }[]).filter((x) => x.id === t)).toHaveLength(1);
    }
  });

  it('不存在/越库的标签整体回滚，不留半成功状态', async () => {
    const good = await makeTag('color', '合法颜色标签');
    const cards = await Promise.all(['回滚卡1', '回滚卡2'].map((title) => makeInspiration(title)));
    const res = await call('post', '/api/inspirations/bulk-tag', {
      ids: cards,
      addTagIds: [good, '不存在的标签id'],
    });
    expect(res.status).toBe(400);
    for (const c of cards) {
      const detail = await call('get', `/api/inspirations/${c}`);
      expect((detail.body.item.tags as { id: string }[]).some((x) => x.id === good)).toBe(false);
    }
  });
});
